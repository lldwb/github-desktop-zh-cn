# Changelog

## [0.2.0] - 2026-09-18

> 给不碰命令行的使用者一条路：新增 **Electron 图形界面**——汉化 / 还原 / 选择安装位置 / 检查更新都变成按钮，字典条目在窗口里只读可搜索。界面与命令行是**同一套脚本**的两种皮：定位 / 替换 / 备份 / 还原没有第二份实现。

### 新增

- **图形界面（操作面板）**（`gui/`，Electron 原生窗口）：工具栏（汉化 / 还原 / 选择 / 检查更新 / 刷新）+ 只读字典表格（英文 / 中文 / 类型，中英双向、大小写不敏感搜索）+ 底部路径与进度 + 状态栏。操作前有确认框（提示原文件会先自动备份，还原区分「从备份精确还原」与「按字典还原」），完成后窗口内显示命中处数与重启结果，运行期间显示进度阶段；出错时错误与提示在窗口内可见，不弹原始栈。渲染进程无 Node 能力（`contextIsolation: true` + `nodeIntegration: false` + `sandbox: true`），**表格只读，不存在字典写盘通道**。
- **GUI 打包**（`electron-builder.yml` + `npm run dist`）：产出 Windows（NSIS 安装包，`oneClick: false` 可选安装目录，另有 **zip 免安装包**）、macOS（dmg + zip）与 Linux（AppImage + deb）产物到 `dist/gui/`。`gui/` + `scripts/` + `package.json` 进 `app.asar`，`dictionaries/` 经 `extraResources` 进应用的 `resources/`（`node:sea` 在 Electron 里不可用，字典不能像单文件产物那样内嵌），GUI 首次运行时把数据根里缺的版本播种过去——macOS 的 `.app` 包内与 Linux 的 AppImage 运行目录都取不到 exe 旁那份；`dataRoot()/dictionaries` 的「外部字典优先」逻辑因此零改动命中。
- **CI 构建 GUI 产物**（`.github/workflows/build.yml`）：新增 `gui` job，与单文件产物并行跑同一套四平台矩阵（Windows x64 / macOS arm64 / macOS x64 / Linux x64，`release` job 等两类产物齐了再建 Release）。每平台构建后先跑静态自检（`build/check-gui-dist.js`：应用包结构、内置字典、Windows 产物是否 GUI 子系统），结构不对就不上传。
- **构建期镜像固化**（`.npmrc` + `electron-builder.yml`）：Electron 二进制与 electron-builder 的 `winCodeSign` / `nsis` 工具包走 npmmirror，国内构建不必手动设环境变量（electron-builder 取 Electron 走 `resolveAssetURL`、**不读** `ELECTRON_MIRROR`，故 yml 里另配一处 `electronDownload.mirror`）。

### 变更

- **产物改 cli / gui 两套命名**（`scripts/build.js` + `electron-builder.yml`）：通道词紧跟项目名、置于版本号之前，附件列表里同类相邻、一眼分得出谁是谁——单文件可执行是 `github-desktop-zh-cn-cli-v<版本>-<平台>-<架构>[.exe|.bin]`，图形界面是 `github-desktop-zh-cn-gui-v<版本>-<平台>-<架构>[-setup].<扩展名>`（旧名 `github-desktop-zh-cn-v0.2.0-win32-x64.exe` 与 `…-v0.2.0-win32-x64.zip` 混在一起，看不出通道）。**macOS / Linux 的单文件产物补上 `.bin` 后缀**——此前没有后缀，在下载页里看不出是什么文件。`scripts/update.js` 的自更新随之改为按「`-<平台>-<架构>` + 平台后缀」匹配附件（无后缀的老产物也认），`build/check-gui-dist.js` 增加一条产物名自检把命名钉住。
- **运行形态判据扩为两条**（`scripts/common.js`）：新增 `isElectron()` / `isElectronPackaged()`，与既有 `isPackaged()` 互斥地描述「数据根是否落在可执行文件旁」。**源码态与 Electron 开发态**（`npm run gui`）数据根仍是仓库根，**Electron 打包产物**与单文件产物一样取可执行文件所在目录。既有子命令、字典格式与单文件产物行为均未变。
- **文档**：`README.md` 的「使用方式」新增图形界面一节（排在**方式一**，原「下载现成产物」顺延为方式二、「源码运行」为方式三），目录结构与已知限制同步；`AGENTS.md` 补「界面层」与运行形态两态、打包态进程环境差异（asar 内 `__dirname`、`extraResources` 字典与首次运行播种、macOS 数据根例外、`node:sea` 不可用）；`docs/打包与分发.md` 增加「图形界面（GUI）产物」小节、发布前检查项与常见问题；`docs/gui/` 收录方案 / 设计 / 任务清单（含开发态往返一致性取证）。

### 说明

- 本次新增一整套界面形态与打包流程（工具链能力扩展），既有行为未破坏，故取**中版本** 0.2.0。
- **GUI 产物随 Release 分发**：CI 在四个 runner 上分别构建，与单文件产物一并作为 Release 附件（`…-gui-v0.2.0-win32-x64-setup.exe` / `…-gui-v0.2.0-win32-x64.zip` / `…-gui-v0.2.0-darwin-arm64.dmg` / `…-gui-v0.2.0-linux-x86_64.AppImage` 等），附 `SHA256SUMS`。也可自行 `npm run dist` 构建（见 `README.md`「方式一」）。
- **还留在 v0.1.x 的 macOS / Linux 使用者**：本版给单文件产物补了 `.bin` 后缀，而**旧产物内置的更新逻辑只认无后缀的附件名**，故在旧版上点「检查更新」会提示「发现新版本 v0.2.0，但没有本平台产物」——到 Release 页面手动下载一次即可，之后的自更新不再受影响（Windows 侧旧产物按 `.exe` 匹配，不受影响）。
- 分发 GUI 请用 **zip 免安装包**：electron-builder 的 portable 目标会把自身解压到临时目录再运行，`process.execPath` 指向临时位置，备份与 `config.json` 会跟着写进临时目录、退出后可能被清理，本仓库不配置该目标。
- 实测：开发态往返一致性（逆向还原 → 再汉化、GUI 汉化与 CLI 汉化）产物两文件逐字节一致（sha256 取证见 `docs/gui/tasks.md`）；**zip 免安装包解压后实机走完整界面链路**——首次运行播种字典（表格 1861 条、字典取自数据根）、汉化命中 2242 处、按字典还原 2242 处、再汉化回到同一指纹，数据根与状态栏均落在解压目录。NSIS 安装包未实机安装（会写入系统）。
- `package.json` 版本号 0.1.1 → 0.2.0

## [0.1.1] - 2026-09-17

> 让产物不再「一次打包锁死」：字典可在运行时从仓库获取，工具自身也能在线更新；汉化 / 还原后自动重启 GitHub Desktop，没有备份时也能按字典还原成英文。

### 新增

- **字典在线获取**：本地（外部目录 + 内嵌资源）没有对应版本字典时，自动从仓库拉取 `dictionaries/<版本>/zh-CN.json`（GitHub raw 主源 + jsDelivr 兜底，落盘前校验 JSON、写 `.part` 再改名）；打包只内嵌**最新版本**字典，更早版本用到时才下载，产物不再随历史字典增长。
- **菜单第 5 项「检查更新（工具 + 字典）」**：拉取当前版本的最新字典；打包态还会检查工具自身版本，发现新版本时下载、校验文件头（MZ / Mach-O / ELF）、替换自身并重启（源码态提示改用 `git pull`）。
- **汉化 / 还原后自动重启 GitHub Desktop**：界面文本在应用启动时载入内存，不重启看不到效果；原本未运行时只提示，不替用户多开窗口。
- **没有备份时的还原**：按字典把中文逆向替换回英文（有备份仍走逐字节精确还原）——官方安装包被清理掉也能还原，不必重装。

### 变更

- **菜单只展示结果**：汉化 / 还原 / 更新过程不再刷屏，只留「命中多少处、是否已重启」这类最终结果；要看逐条明细仍可用命令行子命令（`patch --dry-run` 等）。
- **文档重组**：完整使用教程（运行 / 指定位置 / 版本对应 / 文件放哪 / 换自己的字典 / 系统提示 / 卸载还原）与 GitHub Desktop 官网下载指引收录进 `README.md`；`docs/打包与分发.md` 收敛为分发者视角（构建、跨平台、常见问题）。

### 修复

- **逆向还原的三处正确性问题**（没有备份时的还原路径）：无插值模板的整段区间此前未被收集，含反引号的原文塞回文本段会提前闭合反引号、还原后语法错误；译文本身就是空格 / 标点等通用文本（`" "`、`" / "`）的条目参与逆替换会误伤原版同名文本（实测 `"that " → " "` 会让原版所有空格字面量变成 `"that "`）；英文排版同样会用的 Unicode 标点（省略号 `…` 等）参与逆替换会误伤官方原版（实测 11 处省略号被改写）。现按 `isReversible()` 判据排除不可辨识的译文，并保证「汉化 → 还原 → 再汉化」往返逐字节一致。
- **`verify.js` 备份路径**：改用 `common.backupDir()`，此前自行拼路径与数据根目录约定不一致。

### 说明

- 本次按指定的 **0.1.1** 发布：新增在线能力与使用体验优化，既有子命令接口与字典格式未变。
- `package.json` 版本号 0.1.0 → 0.1.1

## [0.1.0] - 2026-09-17

> 首个版本：把「clone 仓库 + 装 Node + 敲命令」的汉化流程做成可直接分发的单文件产物——Windows / macOS / Linux 使用者无需任何环境，双击进中文菜单即可汉化或还原。

### 新增

- **字典驱动的汉化工具链**（`scripts/`，Node.js 零依赖，仅内置模块）：定位安装目录并备份官方原版 → 按字典替换 `main.js` / `renderer.js` → 校验版本一致性、字典命中率与补丁后语法；另有未翻译文案自查（读官方 sourcemap 输出待补清单）与一键还原。
- **语言字典**：`dictionaries/3.6.5`（首个版本，1853 条）与 `dictionaries/3.6.6`（当前版本，1861 条），扁平「原文 → 中文」映射，含整模板键与作用域键两种特殊形态；字典与 GitHub Desktop 版本强对应，错配可能导致应用无法启动。
- **交互式中文菜单与单文件产物**：`cli.js` 菜单入口（汉化 / 还原 / 详细信息 / 指定安装位置）、`bundle.js` 零依赖单文件打包器、`build.js` 以 Node SEA 产出单文件可执行（内嵌全部字典，双击即用、无需安装 Node）。
- **跨平台支持**：`--path` 可指向任意平台的 resources 目录（自动探测仅实现 Windows）；产物只能在构建平台运行，故跨平台发布走 CI 矩阵，`docs/打包与分发.md` 覆盖使用、构建、跨平台与常见问题。
- **构建与发布（CI）**：`.github/workflows/build.yml` 用矩阵在各平台原生 runner 上构建（Windows x64 / macOS arm64 / macOS Intel / Linux x64），推注解 tag 时自动发 Release 并附全部产物与 `SHA256SUMS`；发版前校验 CHANGELOG 条目 / `package.json` 版本 / tag 三处对齐。
- **翻译维护技能与单元测试**：`.claude/skills/translation-maintain/`（三类任务流程、收录判定标准、探针模板）；`test/` 覆盖字符串匹配器。

### 说明

- 首次发版，取 **0.1.0** 起步：0.x 表示字典组织与工具链接口仍可能调整；此后按「大版本 = 整体重构 / 中版本 = 工具链或字典组织方式大改 / 小版本 = 小修小改」分级取号（见 `AGENTS.md` 的「发版」一节）。
- `package.json` 版本号 **0.1.0**（首次发版，沿用仓库初始版本号，本次未改动）
