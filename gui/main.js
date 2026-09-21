// gui/main.js — Electron 主进程：窗口生命周期 + IPC 处理器
// 业务逻辑一行不重写：全部 require scripts/ 下的既有模块（零依赖 CJS，可与 Electron 主进程共用）。
// 本文件只做两件事——开窗口、把 scripts 的返回值整理成渲染进程能直接渲染的结构；
// 处理器按域分组落在 gui/ipc/<域>.js，本文件保留注册清单与它们共用的骨架。
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');

const common = require('../scripts/common.js');
const update = require('../scripts/update.js');

// IPC 处理器按域分组：汉化还原组 / 版本切换组 / 更新组 / 杂项组（归属见各文件头）。
// 四份都以**字面量 require** 引入——依赖靠静态扫描收集，动态写法收不到。
const createPatchingHandlers = require('./ipc/patching.js');
const createVersionHandlers = require('./ipc/versions.js');
const createUpdateHandlers = require('./ipc/updates.js');
const createMiscHandlers = require('./ipc/misc.js');

const APP_TITLE = 'GitHub Desktop - 汉化工具';

// —— 冒烟自检（--smoke-test）：产物「到底能不能起来」的机器判据，CI 与本地共用同一条命令。
// 窗口与界面就绪后，在渲染进程里走一遍**真实的 IPC 往返**（window.api.state()，即 preload →
// ipcMain → scripts 的完整链路）并核对界面骨架，结果打成一行 SMOKE_OK 输出后 exit 0；任一步
// 失败或超时打 SMOKE_FAIL 并 exit 1。判据刻意不含「字典表格有多少行」——CI 上没有 GitHub
// Desktop，行数必为 0，那是环境差异不是产物缺陷（行数照打，供本地对照）。
// 判据里另有一条**带参通道的实参形态**（`openUrl`）：ipcMain.handle 的 listener 签名是
// (event, ...args)，包装层漏剥 event 时，带参处理器收到的第一个业务参数就是那个事件对象——
// 这是那次缺陷（K1）的回归护栏，机制见下面 handle() 的注释。
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

      // 带参通道的实参形态（K1 回归判据）：走一次真实带参往返——openUrl 的白名单外键会把
      // 「收到的那个值」原样回填进 error 文案，故哨兵串进去、必须哨兵串回来；包装层若漏剥
      // event，回显就成了那个对象的字符串形式，断言随即失败。只认回显里有没有哨兵、不认整句
      // 措辞：将来改这句报错文案不会让护栏误报（回显里没哨兵才是真回归）。
      let argShape = false;
      let argEcho = null;
      try {
        const probe = await window.api.openUrl('__smoke-arg-probe__');
        argEcho = probe && probe.error;
        argShape = typeof argEcho === 'string' && argEcho.includes('__smoke-arg-probe__');
      } catch (e) {
        return { error: '带参 IPC 调用失败：' + e.message };
      }

      // 两条界面链路各走一遍。都不依赖「本机装没装 GitHub Desktop」，CI 上同样成立：
      // ① 切到「翻译提示词」标签页要能经 IPC 拿到文本（展示的就是 dict-prompt.js 那份）；
      // ② 「关于」点了要开。
      document.querySelector('#tab-prompt').click();
      const pre = () => document.querySelector('#prompt-text');
      const promptDeadline = Date.now() + 5000;
      while (Date.now() < promptDeadline && /正在读取/.test(pre().textContent)) {
        await new Promise((res) => setTimeout(res, 100));
      }
      const promptOk = pre().textContent.includes('GitHub Desktop 中文汉化字典的译者');
      document.querySelector('#btn-about').click();
      const aboutOk = !document.querySelector('#about').hidden;
      // ③ 「切换版本」点了要弹出列表窗口。本机没装 GitHub Desktop 时这个按钮是禁用态、
      //    点了不触发事件，故先解除禁用——这里验的是「点击 → 开窗」这条链路本身。
      const switchBtn = document.querySelector('#btn-switch-version');
      switchBtn.disabled = false;
      switchBtn.click();
      const switchOk = !document.querySelector('#switch-version').hidden;
      // ④ 「可下载」那组是异步联网取的：官方 Release 列表在代理下实测约 6 秒，故给 12 秒窗口。
      //    取不到**不判失败**——CI 不保证出网，那是环境差异不是产物缺陷（与 rows 同一条纪律）；
      //    取不到时把空态文字打出来，本地排查用得上。
      const dl = () => document.querySelector('#download-list');
      const dlDeadline = Date.now() + 12000;
      while (Date.now() < dlDeadline && !dl().children.length) {
        await new Promise((res) => setTimeout(res, 200));
      }
      const dlHint = dl().children.length
        ? ''
        : document.querySelector('#download-empty').textContent.trim().slice(0, 90);

      return {
        // 只数**工具栏**的按钮：两个模态窗口里还有几个（带 hidden），数全体会把它们一并算进来，
        // 判据就不再是「界面骨架渲染齐了」而是「HTML 里写了几个 button」。
        buttons: document.querySelectorAll('header.toolbar button').length,
        tabs: document.querySelectorAll('.tab').length,
        versionItems: document.querySelectorAll('#version-list button').length,
        downloadItems: dl().children.length,
        downloadHint: dlHint,
        promptOk,
        aboutOk,
        switchOk,
        argShape,
        argEcho,
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
    if (r.buttons !== 7) throw new Error(`工具栏按钮数 ${r.buttons}（期望 7）`);
    if (r.tabs !== 2) throw new Error(`标签页数 ${r.tabs}（期望 2）`);
    if (!r.promptOk) throw new Error('「翻译提示词」标签页没有取到提示词');
    if (!r.aboutOk) throw new Error('「关于」窗口没能打开');
    if (!r.switchOk) throw new Error('「切换版本」窗口没能打开');
    if (!r.argShape) throw new Error(`带参通道把事件对象当业务参数传给了处理器：openUrl 回显 ${JSON.stringify(r.argEcho)}`);

    const gpu = app.getGPUFeatureStatus() || {};
    smokeOut(
      `SMOKE_OK platform=${process.platform} arch=${process.arch} window=${w}x${h} buttons=${r.buttons} tabs=${r.tabs}` +
        ` prompt=true about=true switch=true versionItems=${r.versionItems} downloadItems=${r.downloadItems}` +
        (r.downloadHint ? ` downloadHint="${r.downloadHint}"` : '') +
        ` rows=${r.rows} ipc=true argShape=${r.argShape} toolVersion=${r.toolVersion}` +
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
// 而不会弹出 Node 的原始调用栈（e.hint 是 patch/restore 给用户的下一步建议）。
// ipcMain.handle 的 listener 签名是 **(event, ...args)**——第一个参数是 IpcMainInvokeEvent 而不是
// 业务参数，必须在这里剥掉：原样透传会让带参通道的处理器把 event 对象当版本号 / 地址键用
// （实测报成「本机没有 [object Object] 的安装目录」「未知的地址：[object Object]」）。event 目前
// 无人使用（处理器拿不到也无需拿到来源窗口），故只丢不传。
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      return { ok: false, error: e.message || String(e), hint: e.hint || null };
    }
  });
}

// —— IPC 公共件：目标解析 / 确认框 / 进度推送的收尾 / 四处理器共用的骨架 ——
// 下面几个供 gui/ipc/<域>.js 的处理器经 ctx 复用（依赖在主进程这一侧注入，
// 分组文件只 require 自己那摊业务与 electron API），实现与拆分前逐字一致。

// 取「当前目标」：解析失败时给出那句统一的提示（GUI 里唯一的出路是「选择」按钮手动指定）。
// 返回 { target, version } 或 { error }——调用方 `if (t.error) return t.error;` 早退。
function requireTarget() {
  const target = common.resolveTarget();
  if (target.error) return { error: { ok: false, error: '未找到 GitHub Desktop：请先点「选择」指定安装位置。' } };
  return { target, version: target.app.version };
}

// 确认框：弹框的公共部分（父窗口 / 问号图标 / 不显示「了解更多」链接 / 标题）只写这一处，
// 各处理器只给差异部分（按钮、文案、checkbox）。返回整份响应（response / checkboxChecked）——
// 取消判定各处理器不同（多数是 response !== 0，更新管控是第 4 个按钮），故不在这里判。
function ask(options) {
  return dialog.showMessageBox(mainWindow, { type: 'question', noLink: true, title: APP_TITLE, ...options });
}

// notifyBusy 的进入与收尾：忙碌消息发出后，无论成功、失败还是提前返回都必须回到空闲——
// 收尾写在 finally 里，别让某个分支漏掉（漏了界面就一直停在「正在汉化 …」）。
async function withBusy(task, phase, fn) {
  notifyBusy(task, phase);
  try {
    return await fn();
  } finally {
    notifyBusy(null, null);
  }
}

// 「确认框 + notifyBusy + run + 结果整理」的公共骨架：patch / restore / updateControl / setVersion
// 四个处理器是同一套顺序，差异只经四个入参注入——
//   askOptions  确认框参数（文案 / 按钮 / checkbox）
//   isCancel    取消判定（默认 response !== 0）
//   task/phase  忙碌消息；task 为 null 表示本步不发忙碌消息（setVersion 只在真要注入时才发），
//               这时骨架完全不碰 notifyBusy
//   run(choice) 用户继续后要做的事，返回值即 IPC 的返回值（各处理器的返回结构在各自的 run 里整理）
async function confirmed({ askOptions, isCancel = (choice) => choice.response !== 0, task, phase, run }) {
  const choice = await ask(askOptions);
  if (isCancel(choice)) return { ok: false, canceled: true };
  return task === null ? run(choice) : withBusy(task, phase, () => run(choice));
}

// 处理器的依赖：骨架与进度推送在主进程这一侧注入（分组文件拿不到窗口状态，也不该自己拿）。
function ipcContext() {
  return {
    // 调用时的主窗口（可能为 null——窗口关掉后确认框退化成无父窗口），故给取值函数而不是快照
    getWindow: () => mainWindow,
    notifyBusy,
    ask,
    withBusy,
    confirmed,
    requireTarget,
  };
}

// IPC 处理器注册清单：处理器按域分组实现在 gui/ipc/<域>.js，这里只按**通道名 + 注册顺序**列出来。
// 顺序与拆分前逐字一致——通道名是渲染进程的调用面，顺序是「既没漏也没重」的机械核对面。
// 处理器主体的注释随代码一起留在各自的域文件里。
function registerIpc() {
  const ctx = ipcContext();
  const patching = createPatchingHandlers(ctx); // 汉化还原组：汉化 / 还原 / 同步字典
  const versions = createVersionHandlers(ctx); // 版本切换组：切换 / 可下载列表 / 下载并安装
  const updates = createUpdateHandlers(ctx); // 更新组：更新管控 / 工具自更新两条
  const misc = createMiscHandlers(ctx); // 杂项组：状态 / 字典表格 / 提示词 / 选择目录 / 打开链接

  handle('state', misc.state);
  handle('dictEntries', misc.dictEntries);
  handle('prompt', misc.prompt);

  handle('patch', patching.patch);
  handle('restore', patching.restore);

  handle('updateControl', updates.updateControl);

  handle('setVersion', versions.setVersion);
  handle('downloadable', versions.downloadable);
  handle('installVersion', versions.installVersion);

  handle('toolUpdateInstall', updates.toolUpdateInstall);

  handle('pickPath', misc.pickPath);

  handle('syncDict', patching.syncDict);

  handle('checkToolUpdate', updates.checkToolUpdate);

  handle('openUrl', misc.openUrl);
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
