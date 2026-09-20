// gui/main.js — Electron 主进程：窗口生命周期 + IPC 处理器
// 业务逻辑一行不重写：全部 require scripts/ 下的既有模块（零依赖 CJS，可与 Electron 主进程共用）。
// 本文件只做两件事——开窗口、把 scripts 的返回值整理成渲染进程能直接渲染的结构。
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');

const common = require('../scripts/common.js');
const patch = require('../scripts/cmd/patch.js');
const restore = require('../scripts/cmd/restore.js');
const dictSync = require('../scripts/dict/dict-sync.js');
const update = require('../scripts/update.js');
const net = require('../scripts/net.js');
const PKG = require('../package.json');

const APP_TITLE = 'GitHub Desktop - 汉化工具';

// —— 冒烟自检（--smoke-test）：产物「到底能不能起来」的机器判据，CI 与本地共用同一条命令。
// 窗口与界面就绪后，在渲染进程里走一遍**真实的 IPC 往返**（window.api.state()，即 preload →
// ipcMain → scripts 的完整链路）并核对界面骨架，结果打成一行 SMOKE_OK 输出后 exit 0；任一步
// 失败或超时打 SMOKE_FAIL 并 exit 1。判据刻意不含「字典表格有多少行」——CI 上没有 GitHub
// Desktop，行数必为 0，那是环境差异不是产物缺陷（行数照打，供本地对照）。
// CI 的四个 runner 都没有 GPU，正好打在「删掉软渲染组件后还有没有回退路径」这条风险链上，
// 所以输出里带上 GPU 合成 / WebGL / Vulkan 状态，供裁剪前后对照（见 .github/workflows/build.yml
// 的冒烟步骤与 build/after-pack.js 的裁剪清单）。
const SMOKE = process.argv.includes('--smoke-test');
const SMOKE_TIMEOUT_MS = 30000;

// 直写 fd 1：stdout 走管道时是异步的，console.log 之后紧接 app.exit() 会把输出丢掉
function smokeOut(line) {
  try {
    fs.writeSync(1, `${line}\n`);
  } catch {
    /* 没有 stdout 时（双击启动）忽略 */
  }
}

// 失败路径要能在 app ready 之前调用——单实例锁那段就在 ready 之前（见文件末尾）
function smokeFail(reason) {
  smokeOut(`SMOKE_FAIL platform=${process.platform} reason=${reason}`);
  if (app.isReady()) app.exit(1);
  else process.exit(1);
}

async function runSmokeTest(win) {
  const timer = setTimeout(() => smokeFail(`超时 ${SMOKE_TIMEOUT_MS} ms`), SMOKE_TIMEOUT_MS);
  try {
    // 页面可能已经 load 完（isLoading 为假），那时再挂 once 会永远等不到
    if (win.webContents.isLoading()) {
      await new Promise((resolve, reject) => {
        win.webContents.once('did-finish-load', resolve);
        win.webContents.once('did-fail-load', (_e, code, desc) =>
          reject(new Error(`页面加载失败 ${code} ${desc}`))
        );
      });
    }

    // 界面初始化是异步的（渲染脚本启动时先取一次状态）：轮询到状态栏有字再取样
    const r = await win.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 15000;
      const hasApi = () => window.api && typeof window.api.state === 'function';
      const bar = () => document.querySelector('#statusbar');
      while (Date.now() < deadline) {
        if (hasApi() && bar() && bar().textContent.trim()) break;
        await new Promise((res) => setTimeout(res, 200));
      }
      if (!hasApi()) return { error: 'preload 未生效（window.api 缺失）' };
      if (!bar() || !bar().textContent.trim()) return { error: '状态栏 15 秒内没有内容' };
      let state;
      try {
        state = await window.api.state();
      } catch (e) {
        return { error: 'IPC 调用失败：' + e.message };
      }
      if (!state || typeof state !== 'object') return { error: 'IPC 返回值不是对象' };
      if (typeof state.dataRoot !== 'string' || !state.dataRoot) return { error: 'IPC 未返回 dataRoot' };
      return {
        buttons: document.querySelectorAll('button').length,
        rows: document.querySelectorAll('#dict-body tr').length,
        status: bar().textContent.trim().replace(/\\s+/g, ' ').slice(0, 60),
        toolVersion: state.toolVersion,
        dataRoot: state.dataRoot,
      };
    })()`);

    if (r.error) throw new Error(r.error);

    // 尺寸只判「没崩成异常尺寸」：请求的是 1200×800，但 CI runner 的虚拟屏幕更小，窗口会被
    // 限制到屏幕内（实测 mac arm64 1024×642、Windows 1008×681），按请求尺寸判会随环境误报。
    const [w, h] = win.getContentSize();
    if (w < 640 || h < 480) throw new Error(`窗口内容区异常 ${w}x${h}`);
    if (r.buttons !== 6) throw new Error(`按钮数 ${r.buttons}（期望 6）`);

    const gpu = app.getGPUFeatureStatus() || {};
    smokeOut(
      `SMOKE_OK platform=${process.platform} arch=${process.arch} window=${w}x${h} buttons=${r.buttons}` +
        ` rows=${r.rows} ipc=true toolVersion=${r.toolVersion}` +
        ` gpu_compositing=${gpu.gpu_compositing || '?'} webgl=${gpu.webgl || '?'} vulkan=${gpu.vulkan || '?'}` +
        ` dataRoot="${r.dataRoot}" status="${r.status}"`
    );
    clearTimeout(timer);
    app.exit(0);
  } catch (e) {
    clearTimeout(timer);
    smokeFail(e.message);
  }
}

let mainWindow = null;

// —— 目标定位（与 cli.js 的 resolveTarget 同源：手动指定的路径优先，否则自动探测）
function resolveTarget() {
  const cfg = common.readConfig();
  const explicitPath = cfg.resourcesPath || null;
  try {
    return { app: common.locateApp({ explicitPath }), explicitPath };
  } catch (e) {
    return { error: e.message, explicitPath };
  }
}

// 界面上显示的「安装根」：Windows 是 …\GitHubDesktop（app-<版本> 的上一级），macOS 是 .app 包，
// Linux 是安装目录本身。仅用于展示，不参与任何写盘路径计算（写盘一律走 common 的 dataRoot()）。
function installRoot(resourcesDir) {
  if (process.platform === 'darwin') return path.resolve(resourcesDir, '..', '..');
  const parent = path.dirname(resourcesDir);
  return /^app-/.test(path.basename(parent)) ? path.dirname(parent) : parent;
}

// 窗口状态：安装位置、版本、字典、是否已汉化、备份。字段全部取自既有 common API，不新增业务判定。
function collectState() {
  const target = resolveTarget();
  const versions = common.listDictVersions();
  const base = {
    ok: !target.error,
    error: target.error || null,
    toolVersion: PKG.version,
    platform: process.platform,
    dataRoot: common.dataRoot(),
    dictVersions: versions,
  };
  if (target.error) return base;

  const { app: found } = target;
  const version = found.version;
  const matched = versions.includes(version);
  const dict = { version, matched, count: null, source: null, error: null };
  if (matched) {
    try {
      dict.count = common.loadDict(version).size;
      dict.source = common.dictLabel(version);
    } catch (e) {
      dict.error = e.message;
    }
  }
  return {
    ...base,
    resourcesDir: found.resourcesDir,
    appDir: found.appDir,
    rootDir: installRoot(found.resourcesDir),
    version,
    dict,
    patched: common.isPatched(found.appDir, version),
    hasBackup: common.backupExists(version),
    backupPath: common.backupDir(version),
  };
}

// 字典表格的数据源。「类型」列只从键推导（design.md 的规则），不扫描产物：
//   全局键 → main.js / renderer.js（两个文件都生效）；作用域键 → 该文件名；整模板键额外加「模板 · 」前缀
// 「组名」列取自字典的 groups 段（dict-groups.js 推断，仅作核对参考、不参与替换），
// 段里没有的条目落「待分组」。
function collectDictEntries() {
  const target = resolveTarget();
  if (target.error) return { ok: false, error: target.error, rows: [] };

  const version = target.app.version;
  if (!common.listDictVersions().includes(version)) {
    return { ok: false, version, error: `本地无 ${version} 对应字典`, rows: [] };
  }
  let entries;
  let groupOf;
  try {
    entries = common.loadDict(version);
    groupOf = common.loadGroups(version);
  } catch (e) {
    return { ok: false, version, error: e.message, rows: [] };
  }
  const rows = [];
  for (const [k, v] of entries) {
    const { file, key } = common.splitScopedKey(k);
    const scope = file || 'main.js / renderer.js';
    rows.push({
      en: key,
      zh: v,
      // 用原样键 k 反查：groups 段存的就是字典键本身，剥掉作用域前缀反而查不到
      group: groupOf.get(k) || common.UNGROUPED,
      type: key.startsWith('`') ? `模板 · ${scope}` : scope,
    });
  }
  return { ok: true, version, count: rows.length, rows };
}

// 内置字典的播种：字典随包放在应用的 resources/dictionaries（electron-builder 的 extraResources），
// 而数据根与它未必同处一地——Windows 的 zip 解压后就在旁边、NSIS 装到用户目录也可写，但 macOS 的数据根
// 恒在用户数据目录（.app 包内不可写，见 common.dataRoot），Linux 的 AppImage 又挂在只读临时目录，
// 两者都取不到旁边那份。首次运行时把数据根里缺的版本复制过去即可，此后一切照旧（外部字典优先）。
// 只补缺失的版本：用户自己替换过、或在线更新过的字典不会被覆盖。
function seedBundledDicts() {
  if (!common.isElectronPackaged()) return;
  const src = path.join(process.resourcesPath, 'dictionaries');
  if (!fs.existsSync(src)) return;
  const dest = path.join(common.dataRoot(), 'dictionaries');
  for (const version of fs.readdirSync(src)) {
    const from = path.join(src, version, 'zh-CN.json');
    const to = path.join(dest, version, 'zh-CN.json');
    if (fs.existsSync(to) || !fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

// 主进程 → 渲染进程的进度推送（「正在汉化 …」）；task 为 null 表示回到空闲
function notifyBusy(task, phase) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('busy', { task, phase });
}

// 统一包装：异常一律转成 { ok:false, error, hint } 回渲染进程——界面里能看到可读原因，
// 而不会弹出 Node 的原始调用栈（e.hint 是 patch/restore 给用户的下一步建议）
function handle(channel, fn) {
  ipcMain.handle(channel, async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      return { ok: false, error: e.message || String(e), hint: e.hint || null };
    }
  });
}

function registerIpc() {
  handle('state', async () => collectState());
  handle('dictEntries', async () => collectDictEntries());

  handle('patch', async () => {
    const target = resolveTarget();
    if (target.error) return { ok: false, error: '未找到 GitHub Desktop：请先点「选择」指定安装位置。' };

    const version = target.app.version;
    // 本地（含内嵌）没有对应字典时不中止：交给 patch 联网取，取不到再报错（与 CLI 一致）
    const local = common.listDictVersions().includes(version);
    const tip = local ? '' : `（本地无 ${version} 字典，将联网获取）`;
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['开始汉化', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: APP_TITLE,
      message: `即将汉化 GitHub Desktop ${version}${tip}`,
      detail: '原文件会先自动备份，之后随时可以还原。汉化完成会重启 GitHub Desktop。',
    });
    if (choice.response !== 0) return { ok: false, canceled: true };

    notifyBusy('patch', `正在汉化 ${version} …`);
    try {
      const r = await patch.run({ explicitPath: target.explicitPath, version, quiet: true });
      return { ok: true, version, total: r.total, restarted: r.restarted };
    } finally {
      notifyBusy(null, null);
    }
  });

  handle('restore', async () => {
    const target = resolveTarget();
    if (target.error) return { ok: false, error: '未找到 GitHub Desktop：请先点「选择」指定安装位置。' };

    const version = target.app.version;
    // 没有备份也能还原：按字典逆向替换（中文 → 英文），只是少数词形可能与官方略有差异
    const tip = common.backupExists(version) ? '（从备份精确还原）' : '（没有备份，将按字典还原为英文）';
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['开始还原', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: APP_TITLE,
      message: `即将把 GitHub Desktop ${version} 还原为官方原版${tip}`,
      detail: '还原完成会重启 GitHub Desktop。',
    });
    if (choice.response !== 0) return { ok: false, canceled: true };

    notifyBusy('restore', `正在还原 ${version} …`);
    try {
      const r = await restore.run({ explicitPath: target.explicitPath, version, quiet: true });
      return {
        ok: true,
        version,
        source: r.source,
        total: r.total,
        ambiguous: r.ambiguous,
        skipped: r.skipped,
        restarted: r.restarted,
      };
    } finally {
      notifyBusy(null, null);
    }
  });

  // 更新管控：三选一（与 CLI 菜单同一套语义，两边不各写一份判定）。
  // 确认框在主进程内弹——渲染进程无法伪造，这是 preload 只暴露「动作」不暴露参数的原因。
  handle('updateControl', async () => {
    const target = resolveTarget();
    if (target.error) return { ok: false, error: '未找到 GitHub Desktop：请先点「选择」指定安装位置。' };

    const version = target.app.version;
    const on = common.getPatchGroups(version).includes('updateControl');
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['没有字典就不更新', '完全禁止更新', '恢复自动更新', '取消'],
      defaultId: 0,
      cancelId: 3,
      noLink: true,
      title: APP_TITLE,
      message: `更新管控（当前：${on ? '已开启' : '未开启'}）`,
      detail: '往 GitHub Desktop 注入一道闸，决定它能不能自动更新。\n\n'
        + '· 没有对应字典就不更新：工具的字典跟上新版本了才放行（推荐）\n'
        + '· 完全禁止更新：不看字典，一律不放行\n'
        + '· 恢复自动更新：撤掉这道闸，回到官方行为（汉化保留）',
    });
    if (choice.response === 3) return { ok: false, canceled: true };

    notifyBusy('updateControl', '正在设置更新管控 …');
    try {
      if (choice.response === 2) {
        const r = await restore.run({
          explicitPath: target.explicitPath, version, groups: ['updateControl'], quiet: true,
        });
        const kept = r.kept.includes('i18n') ? '，汉化保留' : '（已回到官方原版）';
        return { ok: true, notes: [`已恢复自动更新：撤掉了更新管控${kept}。`], restarted: r.restarted };
      }
      const mode = choice.response === 1 ? 'off' : 'guard';
      const r = await patch.run({
        explicitPath: target.explicitPath, version, quiet: true, updateControl: mode,
      });
      const what = mode === 'off' ? '完全禁止自动更新' : '没有对应字典就不更新';
      return { ok: true, notes: [`已开启更新管控（${what}）。`], restarted: r.restarted };
    } finally {
      notifyBusy(null, null);
    }
  });

  // 工具自更新：GUI 产物是**安装包**，不能像 CLI 那样替换自身（见 installGuiUpdate 的注释）。
  // 这个处理器给启动时那条自动提示用——用户点「下载并安装」时进来，不再重复问一遍。
  handle('toolUpdateInstall', async () => {
    const info = await update.check();
    if (!info.hasUpdate) return { ok: false, error: `当前已是最新版本（v${info.current}）。` };
    if (!info.guiAsset) {
      return {
        ok: false,
        error: `发现新版本 v${info.latest}，但没有本平台（${process.platform}-${process.arch}）的安装包。`,
        hint: `可到 ${info.releaseUrl} 手动下载。`,
      };
    }
    const r = await installGuiUpdate(info);
    // 起不来 / 校验没过都不算装上了：如实回 error，别让界面弹一句「已启动安装向导」
    return r.hasError ? { ok: false, error: r.notes.join(' ') } : { ok: true, notes: r.notes };
  });

  handle('pickPath', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择 GitHub Desktop 的 resources 目录',
      buttonLabel: '选择此目录',
      properties: ['openDirectory'],
      message:
        process.platform === 'win32'
          ? '例：C:\\Users\\<用户名>\\AppData\\Local\\GitHubDesktop\\app-3.6.6\\resources'
          : '例：/Applications/GitHub Desktop.app/Contents/Resources',
    });
    if (r.canceled || !r.filePaths.length) return collectState();

    // 多选到上一层是常事（选中 app-<版本> 或安装根），再往下试一层 resources 即可命中
    const picked = r.filePaths[0];
    let found = null;
    let lastError = null;
    for (const candidate of [picked, path.join(picked, 'resources')]) {
      try {
        found = common.locateApp({ explicitPath: candidate });
        break;
      } catch (e) {
        lastError = e;
      }
    }
    if (!found) return { ...collectState(), ok: false, error: `无效的目录——${lastError.message}` };

    common.writeConfig({ resourcesPath: found.resourcesDir });
    return collectState();
  });

  handle('update', async () => {
    const notes = [];
    let hasError = false;
    const target = resolveTarget();
    if (target.error) {
      notes.push('未找到 GitHub Desktop：请先点「选择」指定安装位置，再同步字典。');
      hasError = true;
    } else {
      const version = target.app.version;
      notifyBusy('update', `正在同步 ${version} 字典 …`);
      try {
        const r = await dictSync.syncLatest(version);
        notes.push(r.changed ? `字典已更新：${version}` : `字典已是最新（${version}）。`);
      } catch (e) {
        notes.push(`更新字典失败：${e.message}`);
        hasError = true;
      } finally {
        notifyBusy(null, null);
      }
    }

    // 工具自更新：GUI 产物是安装包，走「下载 + 启动安装向导」，不替换自身（见 installGuiUpdate）。
    // 这里是**用户主动**点的检查更新，弹确认框不唐突；启动时那条自动检查只推提示、不打断。
    try {
      const info = await update.check();
      if (!info.hasUpdate) {
        notes.push(`本工具已是最新版本（v${info.current}）。`);
      } else if (info.guiAsset) {
        const choice = await dialog.showMessageBox(mainWindow, {
          type: 'question',
          buttons: ['下载并安装', '稍后', '打开下载页'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
          title: APP_TITLE,
          message: `发现新版本 v${info.latest}（当前 v${info.current}）`,
          detail: '将下载安装包并启动安装向导。装完后请重新打开本工具。',
        });
        if (choice.response === 0) {
          const r = await installGuiUpdate(info);
          notes.push(...r.notes);
          if (r.hasError) hasError = true; // 没装成就是没装成，别混在「已完成」里
        } else if (choice.response === 2) {
          shell.openExternal(info.releaseUrl);
          notes.push(`已打开下载页：${info.releaseUrl}`);
        } else {
          notes.push(`发现新版本 v${info.latest}，已跳过。`);
        }
      } else {
        notes.push(`发现新版本 v${info.latest}（当前 v${info.current}）：请到 ${info.releaseUrl} 下载安装包。`);
      }
    } catch (e) {
      notes.push(`检查工具版本失败：${e.message}`);
      hasError = true;
    }
    return { ok: true, notes, hasError };
  });
}

// 下载并启动 GUI 安装包。抽出来是因为两处要用：用户主动点「检查更新」时问过之后装，
// 以及启动时自动检查到新版、用户点提示里的「下载并安装」。
// GUI 产物是**安装包**（不是 CLI 那种单文件可执行体），所以不能像 scripts/update.js 的
// apply 那样替换自身——那是 SEA 产物的方式，在 Electron 打包态会直接抛错。
// 返回 `{ notes, hasError }`：起不来 / 校验没过都不算成功，由调用方如实告诉用户（见下面的注释）。
async function installGuiUpdate(info) {
  const dest = path.join(app.getPath('temp'), info.guiAsset.name);
  notifyBusy('toolUpdate', `正在下载 v${info.latest} …`);
  try {
    // accept 头与 scripts/update.js 的 apply 同一条兜底口径（见那里的 downloadUrl 注释）：
    // 直链不看这个头，带上无害；万一拿到的是 API 端点，少了它只会回一份元数据 JSON——
    // 那东西会被当成安装包启动，这里没有 CLI 那边的文件头护栏，只能靠这条头挡住。
    await net.download(info.guiAsset.url, dest, {
      headers: { accept: 'application/octet-stream' },
      onProgress: (got, total) => {
        const pct = total ? `${Math.round((got / total) * 100)}%` : `${(got / 1048576).toFixed(0)} MB`;
        notifyBusy('toolUpdate', `正在下载 v${info.latest} … ${pct}`);
      },
    });
    // 校验和比对（Release 里那份 SHA256SUMS）：GUI 侧没有 CLI 那道文件头护栏——安装包形态不齐
    //（dmg 的 koly 在文件末尾那 512 字节 trailer 里、deb 是 ar 归档、AppImage 是追加了 squashfs
    // 的 ELF），魔数表既难写又不强。校验和正好补上这一环，而且更强：它证明的是「同一份字节」，
    // 不止「文件头像某种格式」。没随附件发清单的来源（Gitee）自动跳过。
    await update.verifySha256(dest, info.guiAsset.name, info.sumsUrl, (msg) => notifyBusy('toolUpdate', msg));
  } catch (e) {
    // 下载失败与校验失败都收敛成一句可读的说明：**没有启动任何东西**，也就不该报成功
    return { notes: [`没能准备好安装包：${e.message}`, `（下载位置：${dest}）`], hasError: true };
  } finally {
    notifyBusy(null, null);
  }

  // macOS 的 .dmg 与 Linux 的 .deb 不能直接当可执行文件起，交给系统打开；
  // Windows 的 -setup.exe 与 Linux 的 .AppImage 直接 spawn。
  const direct = process.platform === 'win32' || dest.endsWith('.AppImage');
  const cmd = direct ? dest : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(cmd, direct ? [] : [dest], { detached: true, stdio: 'ignore' });
  // spawn 的失败是**异步**的（ENOENT、不是有效的可执行文件都走 error 事件）：不接住会冒到进程级
  // 把 GUI 带崩，接住却不回报就成了「提示已启动安装向导、屏幕上什么都没发生」——用户只会以为
  // 装上了。故等这一步的结果出来再回话：起不来就说清「文件在哪、请手动打开」。
  const spawnError = await new Promise((resolve) => {
    child.on('error', resolve); // 常驻：起不来时如实回报，也不会冒到进程级
    child.once('spawn', () => resolve(null));
  });
  child.unref();
  if (spawnError) {
    return {
      notes: [`安装包已下载到 ${dest}，但没能启动它：${spawnError.message}`, '请手动打开上面这个文件完成安装。'],
      hasError: true,
    };
  }

  return {
    notes: [`已下载 v${info.latest} 的安装包并启动安装向导。`, '按向导装完后请重新打开本工具。'],
    hasError: false,
  };
}

// 启动后延迟检查工具自身有无新版本。**不阻塞界面、无新版不打扰**：等几秒让界面稳定下来
// 再看，有新版才推一条提示；检查失败静默——启动时的自动检查不该因为网络问题给用户报错，
// 用户主动点「检查更新」时才把失败原因说出来。
function scheduleToolUpdateCheck() {
  setTimeout(async () => {
    try {
      const info = await update.check();
      if (!info.hasUpdate) return;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('toolUpdate', {
          current: info.current,
          latest: info.latest,
          releaseUrl: info.releaseUrl,
          canInstall: !!info.guiAsset,
        });
      }
    } catch {
      /* 静默：理由见上 */
    }
  }, 4000);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: APP_TITLE,
    backgroundColor: '#f6f8fa',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 打包态隐藏菜单栏（界面已提供全部操作）；开发态保留，便于从菜单开 DevTools
  if (common.isElectronPackaged()) Menu.setApplicationMenu(null);

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

// 单实例：面板是「一个窗口控制一个目标」，多开只会让状态互相打架
if (!app.requestSingleInstanceLock()) {
  // 冒烟自检必须把这条区分出来：已有实例时新进程会静默 exit 0，那是「没拿到锁」而不是「起来了」，
  // 不区分的话 CI 上留着残留进程就会把冒烟判成通过（实测踩过：连续起多个实例全 exit 0）。
  if (SMOKE) smokeFail('未拿到单实例锁（本机已有实例在跑）');
  else app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    // 上次自更新留下的 .old 在这里清掉——替换策略是「改名而不是删除」（Windows 不允许
    // 删除正在运行的 exe），残留只能等新进程启动时清，见 AGENTS.md「在线能力」。
    update.cleanup();
    seedBundledDicts();      // 必须在 registerIpc 之前：状态与字典表格读的就是数据根里的字典
    registerIpc();
    createWindow();
    if (SMOKE) {
      // 冒烟自检：测完自己 exit，不挂后台检查（那条 4 秒后才发请求，纯属浪费）
      runSmokeTest(mainWindow);
      return;
    }
    scheduleToolUpdateCheck(); // 延迟检查工具版本：不阻塞界面，无新版不打扰
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
