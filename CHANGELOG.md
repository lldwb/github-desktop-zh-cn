# Changelog

## [0.3.0] - 2026-09-19

> 让汉化跟得上 GitHub Desktop 的更新：给它装一道**更新管控**闸——字典没跟上就不放行，字典备好了还能**自动补打汉化**；字典本身改成**分段结构 + 唯一写入口**并接上**定时自动产出**，3.6.6 一次补译 292 条（1861 → 2153）；Gitee 镜像也能看到发行版了。

### 新增

- **更新管控补丁组**（`scripts/update-control.js`）：往 GitHub Desktop 的 `main.js` 注入一道闸——`checkForUpdates` 一进来先问「放不放行」。两种模式共用同一份注入块（切换模式 = 重新注入，产物里永远只有一套）：`patch --update-control` 是**没有对应字典就不更新**（工具支持的上限高于当前版本才放行，即新版本字典已就位），`patch --block-update` 是**完全禁止自动更新**（一律不放行，连查都不查）；`restore --group updateControl` 恢复自动更新（**汉化保留**）。放行判据是「字典目录里带 `zh-CN.json` 的最大版本号」；**判断不了（目录读不到 / 无字典）就放行**——宁可让用户更新，也不要因为工具自己的问题把人锁死在旧版本上。注入点在产物 IIFE **之外**（那里 `require` 是原生的，不受 webpack 运行时拦截），用首尾标记包住、重复注入安全；锚点不唯一时**宁可不动**（插错地方会让应用起不来）。图形界面同步加了「更新管控」按钮（三选一，与命令行同一套语义，两边不各写一份判定）。
- **更新后自动汉化**（`scripts/update-control.js` + `scripts/patch.js`）：打包态注入时一并写死工具路径，GitHub Desktop 启动时若「字典已备好当前版本、产物却还是英文」就自动补打一次补丁。判据是补丁组记账里没有 `i18n`——它既是「打过没有」的权威记录，也免得每次启动都白跑一次；`spawn` 失败一律吞掉，这是锦上添花的一步，不能因为它让应用起不来。源码态不注入：那里工具就是仓库本身，用户自己跑 `npm run patch` 即可，写死一个 node 路径换台机器反而会指向不存在的东西。
- **补丁组记账**（`scripts/common.js`）：`tmp/patch-state.json` 记「对哪个版本应用了哪几组」——`patch` 写入时**并入已有**，整份 `restore` **销账**，`restore --group X` **从官方原文重放保留组**（而不是逐组撤销）。
- **字典改分段结构 + 唯一写入口**（`dictionaries/*/zh-CN.json` + `scripts/dict-edit.js`）：formatVersion 2 顶层分 `common` / `windows` / `macos` / `linux` / `groups` 五段，运行时合并「`common` ∪ 当前平台段」；**键跨段重复判为非法并报错**，而不是静默覆盖——那是分段格式特有的失效模式，会让人以为改对了、实际生效的是另一段。旧扁平格式按 `_meta.formatVersion` 回退，用户手里的自定义字典继续可用；解析差异全部由 `buildEntries` 一处吸收，`patch` / `restore` / `verify` / `scan` / `dict-sync` 一行未改。新增的 `dict-edit.js` 是**字典的唯一写入口**（`add` / `update` / `remove` / `set-group` / `move` / `merge` / `regroup` / `migrate` / `apply`），事务写入：读原文 → 内存中变更 → 校验 → 写 `.tmp` → 读回重校验 → `renameSync` → 写后复核，任一步失败即删 `.tmp`、**原文件从未被改动**。组名由 `dict-groups.js` 读产物 sourcemap 推断。
- **CI 定时自动产出字典**（`scripts/dict-auto.js` + `.github/workflows/dict-auto.yml`）：取两平台官方产物 → 以历史字典的键为锚逐条核对新产物里的形态（继承）→ 官方新增的 JSX 文案走 AI 翻译 → `dict-edit` 事务写入 → 推断组名 → 干跑校验。**已有字典的版本直接跳过**（幂等），传多个版本按升序逐个产出，可**回填历史版本**。候选口径只收 JSX 侧：实测 3.6.6 macOS 产物，字面量侧 1714 条候选里 1138 条是枚举值（`Canceled`）、事件名（`PageDown`）、注册表配置（`VSCodium`）、URL 片段这类噪声，JSX 文本节点侧 150 条里 130 条命中既有字典。已有字典另支持 `--on-exist=diff|overwrite` 两种重跑模式（`diff` 全程不写盘）。
- **官方产物按需提取**（`scripts/release-assets.js`）：不下载整包，用 HTTP Range 先取尾部窗口解析 zip 中央目录拿到条目偏移与压缩方式，再对目标条目发起 Range 请求 + `inflateRaw` 解压，零依赖。平台产物路径在 `PLATFORM_SPECS` 里定死，**Linux 置 `null` 而不是留个错的占位**——官方近 30 个 release 的资产全为 Windows nupkg / exe / msi 与 macOS zip，真遇到该报错而不是猜。
- **图形界面两处**：字典面板加**「组名」列**（三列变四列：英文 / 中文 / 组名 / 类型），组名取自字典的 `groups` 段；面板**只消费不解析**（`common.loadGroups()` 返回「键 → 组名」反查表），外部字典优先与内嵌资源回退那套逻辑仍只有一份。**工具自更新也进了界面**：启动后延迟检查工具自身版本，**有新版才提示**（检查失败静默），确认后下载安装包并启动安装——Windows `.exe` 与 Linux `.AppImage` 直接运行，macOS `.dmg` 与 Linux `.deb` 交给系统打开。
- **Gitee 镜像发版**（`.github/workflows/build.yml`）：Gitee 的仓库镜像只同步 commit / 分支 / tag，**发行版不在同步范围内**——`release` job 末尾新增「发布到 Gitee」步骤：按 tag 探测 → 没有就创建 → 逐个上传附件（**幂等按文件名**，Gitee 的资产对象实测只有 `browser_download_url` 与 `name`，没有 sha256 / size 可比）。两个 Gitee 特有的坑都已在代码里绕开：按 tag 查发行版时**用 `200` + 字面量 `null` 表示不存在**（不是 404，照搬 GitHub 的判据会把「不存在」读成「查询失败」）、创建后返回的对象**没有 `html_url`**（按 tag 自己拼）。**缺 `GITEE_TOKEN` 不阻断发布**——`check-version` 打一条 `::warning::`、那一步直接跳过，Gitee 是镜像渠道，不该让它挡住权威源；该步骤失败**只让 job 标红，已发布的 GitHub Release 原样保留**。
- **检查更新加 Gitee 兜底**（`scripts/update.js`）：GitHub 取不到时退回 Gitee 的 `/releases/latest`；两条来源的资产对象形状不同（Gitee 只有 `browser_download_url`，没有 `url`），取用时归一化补齐。GUI 产物匹配同时认 electron-builder 的 Linux 架构写法（`x86_64` / `amd64` / `aarch64`，与 Node 的 `x64` / `arm64` 不同），否则 Linux 使用者永远找不到自己的安装包。
- **运维探针固化**（`build/tools/`）：把 CI / Release 的中间过程脚本固化成**匿名只读、零依赖、路径参数化**的探针——CI 运行概览与 job 步骤明细、按 run id 直查、轮询等待、已发布 Release 的附件与上传者核对、产物命名回归（`pickAsset` 只挑 cli、`pickGuiAsset` 只挑 gui，含反向用例）、workflow 体检（`run:` 块逐个 `bash -n` + YAML 禁忌）、**替换判定**（打出某处文案的前后上下文，并标出查表 / 比较 / 模块导出名 / switch 分支等高危上下文，判断仍由人做）。路径一律参数化——写死的话换台机器就跑不起来，而「能不能跑起来」正是探针有没有价值的全部。

### 变更

- **3.6.6 字典补译 292 条**（1861 → 2153）：补齐与官方正式版产物的形态缺口、内置 Copilot 提示词与冲突输入文档中文化、多提交操作流程与合并对话框的漏译、`Rebase` 等变基操作标签。其中「显示与逻辑复用同一字面量」的一类（`Rebase`）按新定的**整体替换**出口处理——全部出现位置在同一文件、无跨进程 / 持久化 / 上报、比较两侧同源、配套插值模板收尾正确时**整组同值同改**（34 处一起变「变基」，比较两侧仍同源），判据与实证见 `dictionaries/README.md` 与 `.claude/skills/translation-maintain/references/收录判定.md`。
- **3.6.5 字典迁移到 formatVersion 2**：条目数不变（1853 条），只改组织形式。
- **AI 翻译链路接入思考强度与超时配置**（`scripts/dict-auto.js`）：默认 `low` / 120 秒；`AI_MODEL` 迁到仓库变量，配置按可见性分两处（可公开的进 Variables、密钥进 Secrets）。
- **文档**：`README.md` 补更新管控按钮与三种模式、Gitee 下载渠道；`AGENTS.md` 补 Gitee 发版与字典组织（formatVersion 2 五段结构 + 唯一写入口约束）；`dictionaries/README.md` 重写「字典格式」一节；`docs/打包与分发.md` 增「定时字典」「Gitee 镜像发版」「Secrets 与 Variables 清单」三节；`docs/dict-v2/` 收录字典 2.0 的方案 / 设计与任务清单。

### 修复

- **`restore --group` 在记账为空时会把汉化一并还原**（`scripts/restore.js`）：补丁组记账是后加的功能，此前的汉化没有记录，按组还原会把它当成「没打过补丁」而恢复官方原文。现在**抛错拦截**，并给出两条出路（整份还原、或直接重新汉化）。
- **`restart.js` 两处缺陷**：`spawn` 的失败是**异步**的（走 `error` 事件，不抛在调用处），未接事件会让整个进程崩掉——产物其实已经写好，用户看到的却是报错；`restartApp` 只按进程名判断在不在运行，目标不存在时会「**把用户开着的应用关掉、却起不来还回去**」——现在 kill 之前先确认目标存在。
- **CI 发布流程**：发布改走数字 id，并支持「Release 已不在」时续建；Release 正文以 `CHANGELOG.md` 为准（并给 v0.1.0 / v0.1.1 开头补上引用块）；修复流程认得出上次中断留下的草稿、续传不再必然 403；`checkout` 会清空工作区，落盘要排在它之后；新增 `rename-assets` 任务把 v0.1.0 / v0.1.1 的附件名统一到 cli / gui 命名（**只动名字、不动字节**，`SHA256SUMS` 随之重算），并挡住「同 tag 还有草稿」时按 tag 寻址的二义。
- **单元测试写死「本机是 win32」，非 Windows runner 必然失败**（`test/dict-edit.test.js`）：字典扁平导出的用例把「省略平台」的期望钉在 windows 段上，而 macOS / Linux 上当前平台段不是 windows，这条断言必然不成立。现按 `common.currentPlatform()` 取期望，并给三个平台段各放一条独有键——否则非 Windows 上「省略平台」与「只取 common」完全同形，断言测不到任何东西。产物本身不受影响。

### 说明

- 本次新增脚本（`update-control.js` / `dict-edit.js` / `dict-groups.js` / `dict-auto.js` / `release-assets.js`）、字典组织方式变更（分段结构 + 唯一写入口）、新增运维探针，属工具链与字典组织的大改，故取**中版本** 0.3.0。
- 更新管控的两种模式互斥，切换方式是「先还原成官方原文、再按新模式打一遍」，产物里永远只有一份注入块，不会出现两套放行函数抢着赋值。
- 真机实测：在本机安装的 `app-3.6.6` 上打过补丁并取证（记账落盘、产物字节差异、注入块位置与闸门、注入后整文件语法、`DICT_DIR` 内联、源码态不注入 `TOOL` 符合设计）；注入逻辑另用 `vm` 沙箱 mock `require` 验过四种放行场景。
- `package.json` 版本号 0.2.0 → 0.3.0

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
