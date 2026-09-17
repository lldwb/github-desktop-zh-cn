# GUI 操作面板 · 设计

## 方案对比：GUI 技术路线

第 0 项先评估「不做 / 复用既有」：控制台菜单的痛点是真实的（必须开黑窗口、逐级敲数字），**不做不成立**；但「最大化复用既有实现」成立——`scripts/` 已含全部业务逻辑（定位 / 替换 / 备份 / 还原 / 字典同步 / 重启），GUI **只做表现层**，不重写任何一条替换规则。这是本设计的第一原则。

| 方案 | 思路 | 可行性 | 代价 | 结论 |
|------|------|--------|------|------|
| A：Node 内置 http + 系统浏览器 | `node:http` 起本地服务，浏览器打开页面 | 高（零依赖、单文件产物不变、三平台 CI 不动） | 窗口是浏览器形态（地址栏 / 标签页），非原生窗口 | 不采用：用户明确选择原生窗口 |
| B：**Electron 原生窗口** | 引入 electron，自绘窗口 + 主进程复用 `scripts/` | 高（**已实测**：Electron 44.4.1 在本机 `--version` 正常，exit 0） | 打破仓库三条硬约束：引入 npm 依赖、产物不再是单文件（约 200MB 目录）、CI 需另加打包步骤 | **采用** |
| C：C# / WPF（与参考工具同栈） | 照 `GithubDesktopZhTool.exe` 的技术栈 | Windows 专属 | 跨平台破坏（仓库支持 Win/macOS/Linux）、需新工具链、业务逻辑须重写一份 | 不采用 |

**代价的处置（把影响面压到最小）**：新增形态，**不动**现有 CLI、SEA 产物与 CI 矩阵；Electron 仅作 `devDependencies`，`scripts/bundle.js` 的静态 `require` 收集不扫描 `gui/`（其入口是 `gui/main.js`，不经 bundler），故 SEA 打包链完全不受影响。

## 方案对比：GUI 打包方式

| 方案 | 思路 | 代价 | 结论 |
|------|------|------|------|
| 手工打包 | 复制 electron 运行时目录 + 把 `gui/` `scripts/` 放进 `resources/app/`，exe 改名 | 无额外依赖；与既有 `build.js` 同风格 | 不采用：**用户选定 electron-builder**（要安装包） |
| **electron-builder** | 官方打包器，产出 NSIS 安装包 + zip 免安装包 | 引入 devDependencies（含 electron-builder 及其依赖）；构建期需下载 `winCodeSign` / `nsis` 等二进制（国内须配镜像，见下）；后续 CI 需配套 | **采用** |
| electron-packager | 比 builder 轻 | 仍是额外依赖，且无安装包能力 | 不采用 |

**构建期网络**（本机实测的坑，非代码问题）：Electron 的二进制与 electron-builder 的 `winCodeSign` / `nsis` 由构建工具自己下载，**不走系统代理**（`ProxyEnable=1`、`127.0.0.1:7890` 的环境下 `fetch` 直连超时）。解法是配镜像直连——两个镜像都已**固化进仓库**，使用者无须在命令行设环境变量：

- `.npmrc` 的 `electron_mirror` 与 `electron_builder_binaries_mirror`：npm 会把它们导出为 `npm_config_*` 环境变量，electron 与 electron-builder 都读得到（已实测 `npm run env` 中两项均存在）；
- `electron-builder.yml` 的 `electronDownload.mirror`：Electron 二进制专用（electron-builder 用 `resolveAssetURL` 绕过了 `ELECTRON_MIRROR`，故不能用环境变量配这一项）。

对应关系（等价于直接设这两个环境变量）：

```
ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/
ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/
```

**免安装包为什么用 zip 而不是 electron-builder 的 portable 目标**：portable 版运行时会把自身解压到临时目录再启动，`process.execPath` 指向那个临时位置，于是 `dataRoot()` 会把备份与 `config.json` 写进临时目录（退出后可能被清理）。zip 目标是普通压缩包，解压后 `process.execPath` 就在解压目录里，与 NSIS 安装版语义一致。

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

```
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

```
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
| `state` | invoke | — | `{ ok, error?, appDir, resourcesDir, rootDir, version, dict: { version, matched, count, source, error? }, patched, hasBackup, backupPath, toolVersion, platform, dataRoot, dictVersions }` |
| `dictEntries` | invoke | — | `{ ok, version, count, rows: [{ en, zh, type }], error? }` |
| `pickPath` | invoke | — | 同 `state`（弹系统目录选择框 → `writeConfig` → 重新解析）；选中无效目录时返回 `{ ...state, ok: false, error }`，界面据此提示 |
| `patch` | invoke | — | `{ ok, version, total, restarted, error?, hint? }`；用户在确认框点取消时返回 `{ ok: false, canceled: true }` |
| `restore` | invoke | — | `{ ok, version, source, total, ambiguous, skipped, restarted, error?, hint? }`（取消同上） |
| `update` | invoke | — | `{ ok, notes: string[], hasError }`（同步当前版本字典 + 查工具新版本；GUI 态不做自更新，只给「到 Releases 下载」的指引） |
| `busy` | send（主 → 渲染） | `{ task, phase }` | 无（用于显示「正在汉化…」；`task` 为 `null` 表示回到空闲） |

`state` 的字段全部来自现有函数：`locateApp` / `listDictVersions` / `loadDict` / `dictLabel` / `isPatched` / `backupExists` / `backupDir` / `readConfig` / `dataRoot`，**不新增业务逻辑**。`rootDir` 是界面上展示的「安装根」（Windows 取 `app-<版本>` 的上一级，即截图里的 `…\AppData\Local\GitHubDesktop`），仅用于展示，不参与任何写盘路径计算。

### 界面（复刻截图，去掉编辑与平台下拉）

```
┌───────────────────────────────────────────────────────────────┐
│ GitHub Desktop - 汉化工具                              — □ ×  │ ← 原生标题栏
├───────────────────────────────────────────────────────────────┤
│  [汉化]  [还原]  [选择]  [检查更新]  [刷新]                    │ ← 工具栏（图标+文字）
├───────────────────────────────────────────────────────────────┤
│  汉化字典 (1862)                                              │ ← 单标签页
│  ┌───────────────────────────────────────────────────────┐   │
│  │ 搜索：[________________]                               │   │ ← 过滤（1862 条需要）
│  ├───────────────────────────────────────────────────────┤   │
│  │ 英文                    │ 中文        │ 类型            │   │
│  │ "Contract active resi…" │ "收起选中"  │ main.js         │   │ ← 只读表格
│  │ …                                                      │   │
│  └───────────────────────────────────────────────────────┘   │
├───────────────────────────────────────────────────────────────┤
│ 路径 C:\Users\…\AppData\Local\GitHubDesktop      ▓▓▓▓ 空闲    │ ← 路径 + 进度
├───────────────────────────────────────────────────────────────┤
│ 已识别：C:\Users\Administrator\AppData\Local\GitHubDesktop     │ ← 状态栏
└───────────────────────────────────────────────────────────────┘
```

与截图的**有意差异**（均为本仓库语义所限，非缺失）：

| 截图元素 | 本仓库处置 | 原因 |
|---|---|---|
| 添加 / 删除 / 保存 / 重载 | **不做** | 本次范围仅操作面板，字典编辑不在范围内 |
| 「提交提示词」标签页 | **不做** | 对应参考工具的 `Temp/UserPrompt.txt`，本仓库无对应物 |
| 底部平台下拉（Windows / Mac / Linux） | 换成**应用版本**文字 | 本仓库字典按版本组织，无平台维度 |
| 「组名」列（菜单-分支 / 菜单-视图…） | **去掉**，改「类型」列显示生效文件 | 本仓库字典是扁平 `{"原文":"译文"}`，无组名概念 |

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
| `gui/renderer.js` | 新增 | 渲染逻辑：状态渲染、表格、搜索、按钮 |
| `gui/style.css` | 新增 | 样式（贴合截图配色：浅色工具栏、斑马纹表格、灰底状态栏） |
| `electron-builder.yml` | 新增 | 打包配置：`files`（`gui/` + `scripts/`）、`extraResources`（字典 → 应用的 `resources/`）、`electronDownload.mirror`、NSIS 选项、三平台目标、产物命名 |
| `build/check-gui-dist.js` | 新增 | GUI 产物静态自检（应用包结构 / 内置字典 / Windows 产物子系统），CI 与本地共用 |
| `.github/workflows/build.yml` | 修改 | 新增 `gui` job（四平台矩阵构建 GUI 产物 → 自检 → 上传），`release` 改为等两类产物都完成 |
| `.npmrc` | 新增 | 构建期镜像（`electron_mirror` / `electron_builder_binaries_mirror`）；不设 `registry`，npm 包仍走各人自己的源 |
| `scripts/common.js` | 修改 | `dataRoot()` 增加 Electron 判据（新增 `isElectron` / `isElectronPackaged` 导出）与 **macOS 例外**；新增 `splitScopedKey`（字典键解析的 SSOT，供 GUI 的「类型」列复用） |
| `package.json` | 修改 | `main`、`gui` / `dist` 脚本、`devDependencies`（electron + electron-builder） |
| `AGENTS.md` | 修改 | 「运行形态」判据、常用命令、架构节同步 |
| `README.md` | 修改 | 使用方式增加 GUI 形态 |
| `docs/打包与分发.md` | 修改 | 增加 GUI 构建与分发说明 |

`scripts/cli.js`、`locate.js`、`patch.js`、`restore.js`、`verify.js`、`scan.js`、`dict-sync.js`、`update.js`、`restart.js`、`bundle.js`、`build.js` **一律不改**。

## 影响面

- **现有 CLI 与 SEA 产物**：行为不变（`cli.js` 未改；`common.dataRoot()` 在非 Electron 形态下分支与原来完全一致）。
- **单元测试**：`test/` 覆盖的是 `reverseEntries` / `stringLiterals` 等纯函数，`dataRoot()` 改动不影响；`npm test` 应保持全绿（收尾须实测确认）。
- **仓库体积/依赖**：新增 `devDependencies.electron` 与 `package-lock.json`（`node_modules/` 已被 `.gitignore` 忽略）。Electron 二进制约 158MB（zip），构建产物目录约 200MB。
- **`.gitignore`**：已含 `node_modules/`、`dist/`、`out/`，GUI 产物落在 `dist/gui/`，无需改动。
- **CI**：新增 `gui` job（四平台矩阵：构建 → `node build/check-gui-dist.js` 自检 → 上传），`release` 改为等 `build` 与 `gui` 都完成；`build` job 与矩阵项不变。
- **安全**：GUI 不新增网络行为；联网仅经现有 `net.js`（字典同步 / 检查更新），远程地址仍只有 `common.js` 的 `GH_*` 一处定义。

## 风险与对策

| 风险 | 对策 |
|---|---|
| 产物不可写（放 `C:\Program Files`）时数据根回退用户数据目录，内置字典与它不在一处 | 内置字典由 `seedBundledDicts()` 播种到**实际数据根**（初期设计只考虑 Windows、靠 `dict-sync` 联网取，加入 macOS / Linux 后改为播种兜底）；文档明确「GUI 产物放在可写目录使用」，状态栏提示当前数据根 |
| Electron 二进制 / electron-builder 构建工具下载失败（国内网络，且构建工具自身**不走系统代理**） | 镜像**固化在文件里**（`.npmrc` 的 `electron_mirror` / `electron_builder_binaries_mirror`，加 `electron-builder.yml` 的 `electronDownload.mirror`——后者不可省，electron-builder 取 Electron 走 `resolveAssetURL`、**不读** `ELECTRON_MIRROR`），无需手动设环境变量；CI 在境外，workflow 删掉 `.npmrc` 并把下载地址覆盖回官方源 |
| 实测汉化会改动本机 GitHub Desktop | 汉化前备份（现有逻辑，写 `tmp/backup/<版本>/`），实测后按需 `restore`；实测前向用户确认 |
| 渲染进程误加编辑能力导致字典被改坏 | 表格 `readonly` + 无写盘 IPC 通道；字典写盘通道在 GUI 中**不存在**（`writeDict` 仅由 `dict-sync` 调用） |
| 窗口在 macOS / Linux 未验证 | 打包脚本按当前平台工作（复制对应平台 Electron 运行时，与 `build.js` 的「不能交叉构建」一致）；CI 的 `gui` job 会出三平台产物并做静态结构自检，但**窗口行为、数据根与播种链路仍待对应平台实机实测**（runner 没有桌面会话） |
