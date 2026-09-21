# GUI 操作面板 · 设计

## 方案对比：GUI 技术路线

第 0 项先评估「不做 / 复用既有」：控制台菜单的痛点是真实的（必须开黑窗口、逐级敲数字），**不做不成立**；但「最大化复用既有实现」成立——`scripts/` 已含全部业务逻辑（定位 / 替换 / 备份 / 还原 / 字典同步 / 重启），GUI **只做表现层**，不重写任何一条替换规则。这是本设计的第一原则。

| 方案 | 思路 | 可行性 | 代价 | 结论 |
|------|------|--------|------|------|
| A：Node 内置 http + 系统浏览器 | `node:http` 起本地服务，浏览器打开页面 | 高（零依赖、单文件产物不变、三平台 CI 不动） | 窗口是浏览器形态（地址栏 / 标签页），非原生窗口 | 不采用：用户明确选择原生窗口 |
| B：**Electron 原生窗口** | 引入 electron，自绘窗口 + 主进程复用 `scripts/` | 高（**已实测**：Electron 44.4.1 在本机 `--version` 正常，exit 0） | 打破仓库三条硬约束：引入 npm 依赖、产物不再是单文件（约 200MB 目录）、CI 需另加打包步骤 | **采用** |
| C：C# / WPF（与参考工具同栈） | 照 `GithubDesktopZhTool.exe` 的技术栈 | Windows 专属 | 跨平台破坏（仓库支持 Win/macOS/Linux）、需新工具链、业务逻辑须重写一份 | 不采用 |
| D：**系统 WebView 形态**（Tauri / Wails） | 不自带 Chromium，用系统 WebView2 / WKWebView / WebKitGTK 渲染，主进程仍复用 `scripts/` | 未评估 | GUI 层须重写（渲染进程与主进程的通信、打包链路、CI 全部换一套）；三平台 WebView 版本不一，行为差异要各自验证 | **留待下次重构时评估**——本次不采用的理由不是「不好」，而是它与「压缩」是两回事：产物能从 81 MB 降到 10 MB 级，但那是换运行时基底，不是把现有产物压小（详见「体积」一节） |

**代价的处置（把影响面压到最小）**：新增形态，**不动**现有 CLI、SEA 产物与 CI 矩阵；Electron 仅作 `devDependencies`，`scripts/bundle.js` 的静态 `require` 收集不扫描 `gui/`（其入口是 `gui/main.js`，不经 bundler），故 SEA 打包链完全不受影响。

## 方案对比：GUI 打包方式

| 方案 | 思路 | 代价 | 结论 |
|------|------|------|------|
| 手工打包 | 复制 electron 运行时目录 + 把 `gui/` `scripts/` 放进 `resources/app/`，exe 改名 | 无额外依赖；与既有 `build.js` 同风格 | 不采用：**用户选定 electron-builder**（要安装包） |
| **electron-builder** | 官方打包器，产出 NSIS 安装包 + 7z 免安装包 | 引入 devDependencies（含 electron-builder 及其依赖）；构建期需下载 `winCodeSign` / `nsis` 等二进制（国内须配镜像，见下）；后续 CI 需配套 | **采用** |
| electron-packager | 比 builder 轻 | 仍是额外依赖，且无安装包能力 | 不采用 |

**构建期网络**（本机实测的坑，非代码问题）：Electron 的二进制与 electron-builder 的 `winCodeSign` / `nsis` 由构建工具自己下载，**不走系统代理**（`ProxyEnable=1`、`127.0.0.1:7890` 的环境下 `fetch` 直连超时）。解法是配镜像直连——两个镜像都已**固化进仓库**，使用者无须在命令行设环境变量：

- `.npmrc` 的 `electron_mirror` 与 `electron_builder_binaries_mirror`：npm 会把它们导出为 `npm_config_*` 环境变量，electron 与 electron-builder 都读得到（已实测 `npm run env` 中两项均存在）；
- `electron-builder.yml` 的 `electronDownload.mirror`：Electron 二进制专用（electron-builder 用 `resolveAssetURL` 绕过了 `ELECTRON_MIRROR`，故不能用环境变量配这一项）。

对应关系（等价于直接设这两个环境变量）：

```bash
ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/
ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/
```

**免安装包为什么用压缩包而不是 electron-builder 的 portable 目标**：portable 版运行时会把自身解压到临时目录再启动，`process.execPath` 指向那个临时位置，于是 `dataRoot()` 会把备份与 `config.json` 写进临时目录（退出后可能被清理）。压缩包（Windows 是 7z）解压后 `process.execPath` 就在解压目录里，与 NSIS 安装版语义一致。压缩格式选 7z 而不是 zip 是体积使然——zip 的 deflate 压不进 Gitee 的 100 MB 附件上限，同一份内容 7z 81.2 MB / zip 123.6 MB，见 [docs/打包与分发.md](../打包与分发.md)「常见问题」。

### 体积：Electron 这条路的内容侧已经到底

压缩算法与产物形态换完之后（根级 `compression: maximum`、Windows 改 7z、mac 只发 dmg），体积落点由**内容**决定，而内容侧实测已无空间。逐项压测（每项单独 `7z -mx=9 -m0=lzma2`，看各自对最终包的贡献）：

- **主程序 `GitHubDesktopZhTool.exe` 单独压 = 67.4 MB，占整包 81.2 MB 的 83%**；`resources.pak` 12.3 MB 占 15%，**且几乎压不动**（12435 KB → 12319 KB）。两者合计 98%。
- 其余全是配菜：`icudtl.dat` 3.4、`d3dcompiler_47.dll` 1.6、`ffmpeg.dll` 0.9、`dxil.dll` 0.5、`vulkan-1.dll` 0.3（单位 MB，均指压缩后）。全删也只省 2.4 MB。
- `LICENSES.chromium.html` 未压缩 20.5 MB 看着最扎眼，**xz 后只剩 0.19 MB**——删它省不下 0.2 MB，还要担合规风险（Chromium 许可要求分发时附带），**不删**。
- `d3dcompiler_47.dll` **删不得**：本机（有 GPU）实测删掉后冒烟仍 `SMOKE_OK`、退出码 0，但 `gpu_compositing` / `webgl` 从 `enabled` 掉到 `disabled_software` / `disabled_off`——硬件加速失效。**CI 四平台冒烟测不出这类退化**（runner 本来就没 GPU，`disabled_software` 是常态），涉及硬件能力的组件必须在**有该硬件的机器**上对照这两项状态才算验过。

**要再降一个量级只能换运行时基底**（上表方案 D：Tauri / Wails 这类用系统 WebView 的形态，产物可到 10 MB 级）——那是重写 GUI 层，不是把现有产物压小，**留待下次重构时评估**。本次的取舍是：在 Electron 形态内把压缩做到零取舍的极限（六个产物五个已进 Gitee 的 100 MB 上限），不为最后 2.5 MB 牺牲硬件加速或合规性。

## 选定方案

### 运行形态与数据根（关键决策点 1）

**问题**：`common.dataRoot()` 现有判据是 `isPackaged()`（SEA / bundle 产物）。Electron 打包产物两个判据都不满足 → 会走「源码态」分支返回 `REPO_ROOT`，而该路径在打包后指向 `resources/app.asar` 内部或 `resources/app/`，**备份与 `config.json` 会写到不可写或用户找不到的位置**。

**方案**：在 `common.js` 增加 Electron 运行形态判据（`process.versions.electron` 由运行时注入；开发态 `electron .` 启动时 `process.defaultApp` 为 `true`，打包态为 `undefined`）：

```js
// Electron 运行态
function isElectron() { return !!process.versions.electron; }
// Electron 打包产物（改名后的 exe）；开发态 `electron .` 时为 false
function isElectronPackaged() { return isElectron() && !process.defaultApp; }
```

`dataRoot()` 改为：

```js
if (!isPackaged() && !isElectronPackaged()) { _dataRoot = REPO_ROOT; return _dataRoot; }  // 源码态 + Electron 开发态
// 其余（SEA 产物 / Electron 打包产物）：可执行文件所在目录，不可写时回退用户数据目录
const beside = path.dirname(process.execPath);
```

对照表：

| 运行形态 | `isPackaged()` | `isElectronPackaged()` | 数据根 |
|---|---|---|---|
| 源码 CLI（`npm run patch`） | false | false | 仓库根（不变） |
| SEA 单文件产物 | true | false | exe 所在目录（不变） |
| **Electron 开发态**（`npm run gui`） | false | false | 仓库根（字典、备份与源码态一致） |
| **Electron 打包产物** | false | true | **exe 所在目录**（与 SEA 产物语义一致）；**macOS 例外**：恒取用户数据目录（见下） |

Electron 里 `process.execPath` 是**应用可执行文件**（改名后的 exe，非 `electron.exe`），故取 `dirname` 即产物目录。macOS 是唯一的例外：exe 在 `.app` 包的 `Contents/MacOS` 里，往包内写一个字节就会让签名失效、下次启动被 Gatekeeper 拒开，故 `dataRoot()` 在 macOS 的 Electron 打包态直接返回用户数据目录（`~/Library/Application Support/github-desktop-zh-cn`）。

**打包后的目录布局**（Windows 实例，NSIS 单用户安装 → `%LOCALAPPDATA%\Programs\<productName>\`，**可写**）：

```text
%LOCALAPPDATA%\Programs\<productName>\
  <name>.exe                        ← 应用 exe（Electron 里 process.execPath 即此）
  resources/app.asar                ← 应用代码（gui/ + scripts/）
  resources/dictionaries/3.6.6/zh-CN.json ← 内置字典（extraResources）
  …（Electron 运行时文件）
  dictionaries/、tmp/backup/<版本>/、config.json ← 首次运行后按 dataRoot() 生成，与 exe 同级
```

- 字典走 `extraResources`（进应用的 `resources/`）而**不是** `extraFiles`（exe 同级）。**设计初期选的是 `extraFiles`**——当时只考虑 Windows，让 `dataRoot()/dictionaries/` 的「外部字典优先」零改动命中最省事。加入 macOS 与 Linux 后这条不成立：macOS 的数据根恒在用户数据目录（理由见上），Linux 的 AppImage 运行时挂在只读临时目录，**两者都取不到 exe 旁那份**。改由 `gui/main.js` 的 `seedBundledDicts()` 首次运行时把数据根里缺的版本复制过去——数据根的字典查找逻辑仍然零改动，三平台一条路径。
  - 播种**只补缺失的版本**：数据根里已有该版本（用户自己替换过、或在线更新过）时不覆盖，保持「外部字典优先」的语义。
  - 播种必须发生在 `registerIpc()` **之前**：状态与字典表格读的就是数据根里的字典。
- asar 内 `require('../scripts/common.js')` 正常（Electron 支持 asar 内 require）；`common.REPO_ROOT` 在 asar 内会指向 `app.asar`，但 Electron 打包态下 `dataRoot()` 不走该分支。
- NSIS 配置 `oneClick: false`（允许改安装目录）、`perMachine: false`（装用户目录，省掉 UAC）——即使用户装进 `C:\Program Files`，数据根按现有逻辑回退用户数据目录，内置字典照常播种过去，`dict-sync` 联网兜底因此不再是必需品（初期设计里它曾是这条路径的唯一解法）。

### 进程结构（关键决策点 2）

```text
┌─ 渲染进程（gui/index.html + renderer.js）─┐
│  纯界面：DOM 渲染、按钮、搜索框、状态显示   │
│  只能通过 window.api.* 与主进程通信        │
└──────────────┬───────────────────────────┘
               │ contextBridge（preload.js）
               │ ipcRenderer.invoke / on
┌──────────────▼───────────────────────────┐
│  主进程（gui/main.js）                     │
│  窗口生命周期 + IPC 处理器                 │
│  直接 require('../scripts/…') 调业务       │
└──────────────┬───────────────────────────┘
               │ Node CJS require（零依赖，同一个进程内）
┌──────────────▼───────────────────────────┐
│  scripts/common.js · patch.js · restore.js │
│  · locate.js · dict-sync.js · update.js    │
│  · restart.js                              │
└──────────────────────────────────────────┘
```

安全基线：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；渲染进程**不得**直接碰 `fs` / `path` / `child_process`。

### IPC 契约

| 通道 | 方向 | 入参 | 返回 |
|---|---|---|---|
| `state` | invoke | — | `{ ok, error?, appDir, resourcesDir, rootDir, version, dict: { version, matched, count, source, error? }, patched, hasBackup, backupPath, toolVersion, platform, dataRoot, license, repoUrl, mirrorUrl, dictVersions, installed: [{ version, resourcesDir, hasDict, current, custom }] }` |
| `dictEntries` | invoke | — | `{ ok, version, count, rows: [{ en, zh, group, type }], error? }` |
| `prompt` | invoke | — | `{ ok, text }`——`scripts/dict/dict-prompt.js` 里那份系统提示词，原样展示 |
| `pickPath` | invoke | — | 同 `state`（弹系统目录选择框 → `writeConfig` → 重新解析）；选中无效目录时返回 `{ ...state, ok: false, error }`，界面据此提示 |
| `setVersion` | invoke | `version` | `{ ok, version, notes, hasError, restarted, error? }`；版本不在本机已安装列表里 → `{ ok: false, error }`；选中的就是当前目标、或确认框被取消 → `{ ok: false, canceled: true }`。确认框里带「同时禁止该版本自动更新」勾选（默认勾上） |
| `downloadable` | invoke | — | `{ ok, platform, installable, versions: [{ version, assetName, size, hasDict }] }`——官方 Release 里**有产物、本机未装**的版本（已装的在 `state.installed` 里）。只在窗口打开时取一次 |
| `installVersion` | invoke | `version` | `{ ok, version, notes, restarted, error? }`——下载官方产物并铺到 `<安装根>/app-<版本>/`（约 300 MB，与现有版本并存），装完自动切过去；确认框在主进程弹，取消 → `{ ok: false, canceled: true }` |
| `patch` | invoke | — | `{ ok, version, total, restarted, error?, hint? }`；用户在确认框点取消时返回 `{ ok: false, canceled: true }` |
| `restore` | invoke | — | `{ ok, version, source, total, ambiguous, skipped, restarted, error?, hint? }`（取消同上） |
| `updateControl` | invoke | — | `{ ok, notes: string[], restarted, error? }`——三选一的确认框在主进程弹（没有字典就不更新 / 完全禁止更新 / 恢复自动更新）；取消 → `{ ok: false, canceled: true }` |
| `checkToolUpdate` | invoke | — | `{ ok, notes: string[], hasError }`——**只查工具自身**；有新版且拿得到本平台安装包时**下载并启动安装向导**（安装包先按 Release 的 `SHA256SUMS` 核对、起不来都算 `hasError`，见 `installGuiUpdate`），拿不到安装包才退回「到 Releases 下载」的指引 |
| `syncDict` | invoke | — | `{ ok, notes: string[], error? }`——拉当前版本的最新字典覆盖本地（`dictSync.syncLatest`） |
| `openUrl` | invoke | `which`（`repo` / `mirror`） | `{ ok, url }` 或 `{ ok: false, error }`——入参是**白名单键**而不是 URL，渲染进程给不出任意链接 |
| `toolUpdateInstall` | invoke | — | `{ ok, notes, error?, hint? }`——启动时那条自动提示里「下载并安装」的入口 |
| `busy` | send（主 → 渲染） | `{ task, phase }` | 无（用于显示「正在汉化…」；`task` 为 `null` 表示回到空闲） |

`state` 的字段全部来自现有函数：`locateApp` / `listInstalledVersions` / `listDictVersions` / `loadDict` / `dictLabel` / `isPatched` / `backupExists` / `backupDir` / `readConfig` / `dataRoot` / `repoUrls`，外加 `package.json` 的 `license`。唯一在主进程里做整理的是 `installedForPicker()`——把已安装版本列表补上 `hasDict` / `current` / `custom` 三个标记并按版本排序，供「切换版本」窗口直接用。`rootDir` 是界面上展示的「安装根」（Windows 取 `app-<版本>` 的上一级，即截图里的 `…\AppData\Local\GitHubDesktop`），仅用于展示，不参与任何写盘路径计算。

### 界面（复刻截图，去掉编辑与平台下拉）

```text
┌───────────────────────────────────────────────────────────────┐
│ GitHub Desktop - 汉化工具                              — □ ×  │ ← 原生标题栏
├───────────────────────────────────────────────────────────────┤
│  [汉化] [还原] [选择] [更新管控] [切换版本] [刷新] [关于]       │ ← 工具栏
├───────────────────────────────────────────────────────────────┤
│  汉化字典         │  翻译提示词                                │ ← 两个标签页
│  ┌───────────────────────────────────────────────────────┐   │
│  │ 搜索：[________________]                               │   │ ← 过滤（条目上千，需要可检索）
│  ├───────────────────────────────────────────────────────┤   │
│  │ 英文                    │ 中文        │ 组名     │ 类型      │   │
│  │ "Contract active resi…" │ "收起选中"  │ 菜单-分支 │ main.js  │   │ ← 只读表格
│  │ …                                                      │   │
│  └───────────────────────────────────────────────────────┘   │
├───────────────────────────────────────────────────────────────┤
│ 路径 C:\Users\…\AppData\Local\GitHubDesktop      ▓▓▓▓ 空闲    │ ← 路径 + 进度
├───────────────────────────────────────────────────────────────┤
│ 已识别：C:\Users\Administrator\AppData\Local\GitHubDesktop     │ ← 状态栏
└───────────────────────────────────────────────────────────────┘

两个模态窗口（点工具栏按钮弹出；点遮罩、按 Esc 或点「关闭」关掉）——参考截图里没有，是本仓库新增的：

┌── 切换版本 ───────────────────────────────────────────────────┐
│ 切换 GitHub Desktop 版本                                      │
│                                                               │
│ 本机装了多个时（官方升级后旧目录会留着）在这里换一个；        │
│ 之后汉化 / 还原 / 更新管控与字典表格都作用于选中的版本。      │
│                                                               │
│ 本机已安装                                                    │
│   3.6.6  [当前]                                               │
│     C:\Users\…\GitHubDesktop\app-3.6.6\resources              │
│   3.6.5                                                       │
│     C:\Users\…\GitHubDesktop\app-3.6.5\resources              │
│ 可下载（官方 Release）                                        │
│   3.6.4  293 MB                                               │
│   3.6.0  218 MB                                               │
│                                                               │
│ [ ] 显示没汉化的版本                                    [关闭]│
└───────────────────────────────────────────────────────────────┘

┌── 关于 ───────────────────────────────────────────────────────┐
│ GitHub Desktop 汉化工具                                       │
│                                                               │
│ 版本      v1.1.2                                              │
│ 项目地址  https://github.com/lldwb/github-desktop-zh-cn       │
│ 国内镜像  https://gitee.com/lldwb/github-desktop-zh-cn        │
│ 许可证    GPL-3.0                                             │
│ 数据目录  D:\工具                                             │
│                                                               │
│                                   [检查更新] [同步字典] [关闭]│
└───────────────────────────────────────────────────────────────┘
```

与截图的**有意差异**（均为本仓库语义所限，非缺失）：

| 截图元素 | 本仓库处置 | 原因 |
|---|---|---|
| 添加 / 删除 / 保存 / 重载 | **不做** | 本次范围仅操作面板，字典编辑不在范围内 |
| 「提交提示词」标签页 | **不做**，另做了「翻译提示词」 | 参考工具那个对应 `Temp/UserPrompt.txt`（用户填的提示词），本仓库无对应物；本仓库做的是另一件事——把 `scripts/dict/dict-prompt.js` 里**发给翻译模型的系统提示词**只读展示出来，让人看清字典里新增的条目是按什么规则译的 |
| 底部平台下拉（Windows / Mac / Linux） | 换成**应用版本**文字 | 表格显示的是**当前平台**的合并结果（`common` ∪ 平台段），无需切换；要看跨平台全貌直接读 `dictionaries/<版本>/zh-CN.json`。工具栏的「切换版本」选的是**安装目标**（本机并存的多个 `app-<版本>`），与平台无关 |
| 「组名」列（菜单-分支 / 菜单-视图…） | **保留**，并在其后另加「类型」列 | 起初判定「去掉」是因为当时的字典还是扁平结构、没有组名概念；后来字典迁到 formatVersion 2 并有了 `groups` 段，组名列就补上了（见 `docs/dict-v2/tasks.md` 第 5 组）。两列并存——组名管「按界面区域定位」，类型管「这条会替换哪个文件」 |

「类型」列取值规则（**只读，O(1) 从键推导，不扫描产物**）：

| 键形态 | 显示 |
|---|---|
| 无前缀（全局键） | `main.js / renderer.js` |
| `renderer.js\|原文` | `renderer.js` |
| 以反引号开头（整模板键） | 前缀加 `模板 · `，如 `模板 · renderer.js` |

### 进度指示

`patch.run()` / `restore.run()` 现有粒度是「按文件循环」（两个文件），无法给出有意义的百分比。本次**不改这两个脚本**，GUI 用**不确定进度条** + 阶段文字（「正在汉化…」/「正在还原…」），任务结束回到「空闲」。若后续需要真实百分比，再给 `run()` 加可选 `onProgress` 回调（届时也只在 `run()` 内部加，不改调用契约）。

### 文件清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `gui/main.js` | 新增 | 主进程：窗口创建、IPC 处理器、调用 `scripts/`；`seedBundledDicts()` 首次运行播种内置字典（打包态才生效） |
| `gui/preload.js` | 新增 | `contextBridge` 暴露 `window.api` |
| `gui/index.html` | 新增 | 界面结构 |
| `gui/renderer.js` | 新增 | 渲染逻辑：状态渲染、表格、搜索、按钮（后续加了标签页切换、切换版本窗口与「关于」窗口） |
| `gui/style.css` | 新增 | 样式（贴合截图配色：浅色工具栏、斑马纹表格、灰底状态栏） |
| `electron-builder.yml` | 新增 | 打包配置：`files`（`gui/` + `scripts/`）、`extraResources`（字典 → 应用的 `resources/`）、`electronDownload.mirror`、NSIS 选项、三平台目标、产物命名 |
| `tools/check-gui-dist.js` | 新增 | GUI 产物静态自检（应用包结构 / 内置字典 / Windows 产物子系统），CI 与本地共用（脚本后迁到 `tools/`，路径以 workflow 与 `AGENTS.md` 为准） |
| `.github/workflows/build.yml` | 修改 | 新增 `gui` job（四平台矩阵构建 GUI 产物 → 自检 → 上传），`release` 改为等两类产物都完成 |
| `.npmrc` | 新增 | 构建期镜像（`electron_mirror` / `electron_builder_binaries_mirror`）；不设 `registry`，npm 包仍走各人自己的源 |
| `scripts/common.js` | 修改 | `dataRoot()` 增加 Electron 判据（新增 `isElectron` / `isElectronPackaged` 导出）与 **macOS 例外**；新增 `splitScopedKey`（字典键解析的 SSOT，供 GUI 的「类型」列复用） |
| `package.json` | 修改 | `main`、`gui` / `dist` 脚本、`devDependencies`（electron + electron-builder） |
| `AGENTS.md` | 修改 | 「运行形态」判据、常用命令、架构节同步 |
| `README.md` | 修改 | 使用方式增加 GUI 形态 |
| `docs/打包与分发.md` | 修改 | 增加 GUI 构建与分发说明 |

`scripts/cli.js`、`locate.js`、`patch.js`、`restore.js`、`verify.js`、`scan.js`、`dict-sync.js`、`update.js`、`restart.js`、`bundle.js`、`build.js` **一律不改**——这是 GUI 那一轮的范围声明；后续的「关于 / 切换版本 / 同步字典」把 `cli.js` 也纳入了改动（两个形态保持同一套语义，见上文「界面」与「IPC 契约」两节）。

## 影响面

- **现有 CLI 与 SEA 产物**：**GUI 那一轮**行为不变（`cli.js` 当时未改，`common.dataRoot()` 在非 Electron 形态下分支与原来完全一致）；后续的「关于 / 切换版本 / 同步字典」动了 `cli.js` 的菜单与 `common.js` 的安装目录枚举，见文末文件清单末尾的说明。
- **单元测试**：`test/` 覆盖的是 `reverseEntries` / `stringLiterals` 等纯函数，`dataRoot()` 改动不影响；`npm test` 应保持全绿（收尾须实测确认）。
- **仓库体积/依赖**：新增 `devDependencies.electron` 与 `package-lock.json`（`node_modules/` 已被 `.gitignore` 忽略）。Electron 二进制约 158MB（zip），构建产物目录约 200MB。
- **`.gitignore`**：已含 `node_modules/`、`dist/`、`out/`，GUI 产物落在 `dist/gui/`，无需改动。
- **CI**：新增 `gui` job（四平台矩阵：构建 → `node tools/check-gui-dist.js` 自检 → 上传），`release` 改为等 `build` 与 `gui` 都完成；`build` job 与矩阵项不变。
- **安全**：GUI 不新增网络行为；联网仅经现有 `net.js`（字典同步 / 检查更新），远程地址仍只有 `common.js` 的 `GH_*` 一处定义。

## 风险与对策

| 风险 | 对策 |
|---|---|
| 产物不可写（放 `C:\Program Files`）时数据根回退用户数据目录，内置字典与它不在一处 | 内置字典由 `seedBundledDicts()` 播种到**实际数据根**（初期设计只考虑 Windows、靠 `dict-sync` 联网取，加入 macOS / Linux 后改为播种兜底）；文档明确「GUI 产物放在可写目录使用」，状态栏提示当前数据根 |
| Electron 二进制 / electron-builder 构建工具下载失败（国内网络，且构建工具自身**不走系统代理**） | 镜像**固化在文件里**（`.npmrc` 的 `electron_mirror` / `electron_builder_binaries_mirror`，加 `electron-builder.yml` 的 `electronDownload.mirror`——后者不可省，electron-builder 取 Electron 走 `resolveAssetURL`、**不读** `ELECTRON_MIRROR`），无需手动设环境变量；CI 在境外，workflow 删掉 `.npmrc` 并把下载地址覆盖回官方源 |
| 实测汉化会改动本机 GitHub Desktop | 汉化前备份（现有逻辑，写 `tmp/backup/<版本>/`），实测后按需 `restore`；实测前向用户确认 |
| 渲染进程误加编辑能力导致字典被改坏 | 表格 `readonly` + 无写盘 IPC 通道；字典写盘通道在 GUI 中**不存在**（`writeDict` 仅由 `dict-sync` 调用） |
| 窗口在 macOS / Linux 未验证 | 打包脚本按当前平台工作（复制对应平台 Electron 运行时，与 `build.js` 的「不能交叉构建」一致）；CI 的 `gui` job 出四平台产物，每平台跑静态结构自检 + **产物启动冒烟**（`--smoke-test` 真起一次窗口，核对窗口内容区尺寸 / 工具栏按钮数 / 标签页数 / 「翻译提示词」取到文本 / 「关于」能开 / 真实 IPC 往返，四平台均已通过；runner 都没有 GPU，这一轮同时验证了删掉软渲染组件后的**软件回退路径**）。**数据根与播种链路**仍待对应平台实机实测——冒烟只证「起得来」，不证「写得进」 |
