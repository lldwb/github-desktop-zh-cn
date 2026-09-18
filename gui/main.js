// gui/main.js — Electron 主进程：窗口生命周期 + IPC 处理器
// 业务逻辑一行不重写：全部 require scripts/ 下的既有模块（零依赖 CJS，可与 Electron 主进程共用）。
// 本文件只做两件事——开窗口、把 scripts 的返回值整理成渲染进程能直接渲染的结构。
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');

const common = require('../scripts/common.js');
const patch = require('../scripts/patch.js');
const restore = require('../scripts/restore.js');
const dictSync = require('../scripts/dict-sync.js');
const update = require('../scripts/update.js');
const PKG = require('../package.json');

const APP_TITLE = 'GitHub Desktop - 汉化工具';

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

    // 工具自更新在 GUI 态不适用：安装包形态的更新是「下载新安装包再安装」，
    // 而 scripts/update.js 的 apply 是替换自身 exe 并重启（那是 SEA 单文件产物的方式）
    try {
      const info = await update.check();
      notes.push(
        info.hasUpdate
          ? `发现新版本 v${info.latest}（当前 v${info.current}）：请到 ${info.releaseUrl} 下载安装包。`
          : `本工具已是最新版本（v${info.current}）。`
      );
    } catch (e) {
      notes.push(`检查工具版本失败：${e.message}`);
      hasError = true;
    }
    return { ok: true, notes, hasError };
  });
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
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    seedBundledDicts();      // 必须在 registerIpc 之前：状态与字典表格读的就是数据根里的字典
    registerIpc();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
