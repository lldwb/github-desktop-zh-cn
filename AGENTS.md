# AGENTS.md

本文件是 Claude Code 及其他 agent 在本仓库工作时的指引；**本文件为唯一权威源**。项目介绍见 `README.md`。

## 仓库定位

GitHub Desktop 中文汉化补丁工具仓库（字典驱动、开源）。GitHub Desktop（Electron 应用）官方未提供简体中文界面，本仓库以 **JSON 语言字典为唯一翻译资产**，用 Node.js 脚本对官方安装目录内 `resources/app/main.js`（主进程）与 `renderer.js`（渲染进程）执行字符串替换实现汉化。由此推出硬性约束：

- **字典是核心资产**（`dictionaries/<版本>/zh-CN.json`），脚本只做机械替换、**不内置翻译**；字典与脚本分离维护。
- **版本强对应**：字典必须与 GitHub Desktop 版本一一对应，错配可能导致应用无法启动；字典条目只针对用户可见的 UI 文本（界面元素 / 读屏 / 命令行 / 报错），不含用户不可见的日志文本。**例外（用户明确授权时）**：发给模型的输入文本（Copilot 提示词 / 冲突输入文档 / 仓库约束说明）可收录——前提是保留全部输出契约（JSON 键、`"keep"` / `"delete"` 等取值、解析器依赖的字段），并经行为验证（见「翻译维护」节）。
- **不内置翻译**：脚本内不得硬编码任何「原文 → 中文」映射。

## 常用命令

```bash
npm run locate         # 定位安装目录，校验结构，备份原文件到 tmp/backup/<版本>/
npm run patch          # 按字典替换 main.js / renderer.js 并写回（--dry-run 预览不写盘；缺字典时联网取）
npm run restore        # 还原官方原版（有备份用备份；没有则按字典逆向还原成英文）
npm run verify         # 校验版本一致性、字典命中率、补丁后 JS 语法
npm run scan           # 未翻译文案自查（读 sourcemap 里的官方源码，输出待补清单）
npm run tool           # 交互式中文菜单（SEA 产物双击即此模式；带子命令时透传给对应脚本）
npm run gui            # 图形界面操作面板（Electron 开发态；首次需 npm install）
npm run dist           # 打包图形界面产物（electron-builder → dist/gui/，按当前平台：Windows NSIS+zip / macOS dmg+zip / Linux AppImage+deb；产物自检见 node build/check-gui-dist.js）
npm run build          # 打包成单文件可执行（dist/ 下，双击即用，无需 Node）
npm test               # 匹配器单元测试（node --test）
```

CI / Release 运维探针（`build/tools/`，匿名只读、零依赖、仓库地址取 `common.js` 的 `GH_OWNER/GH_REPO`，详见该目录 README）：

```bash
node build/tools/ci-status.cjs                 # 最近 CI 运行概览
node build/tools/job-timing.cjs <runId> [名字] # 某 job 步骤耗时（定位失败步）
node build/tools/wait-run.cjs <runId>          # 轮询运行直到结束
node build/tools/release-detail.cjs <tag>      # Release 署名 / 附件上传者 / 时间戳
node build/tools/rel-check.cjs [tag...]        # 核对附件名是否符合 cli / gui 规范
node build/tools/wf-lint.cjs [workflow]        # workflow 体检（run 块 bash -n + YAML 禁忌）
node build/tools/check-naming.cjs              # pickAsset 只挑 cli 产物（回归）
```

各脚本支持 `--help`；`patch`/`verify` 支持 `--version <版本>` 指定字典版本、`--path <resources目录>` 显式指定安装目录（跨平台 / 自动探测失败时用）。脚本改动后至少跑一次 `node --check` 与 `--dry-run` 做验证。

## 架构

- **替换对象**：官方 Windows 3.6.x 安装目录 `%LOCALAPPDATA%\GitHubDesktop\app-<版本>\resources\app\` 下的 `main.js` 与 `renderer.js`——官方产物为**免打包裸目录**（无 `app.asar`，3.6.4 / 3.6.5 已实测；robotze/GithubDesktopZhTool 的 Mac/Linux 方案同样直接替换 `Resources/app` 下文件）。
- **工具链**（`scripts/`，Node.js 零依赖，仅内置模块）：
  - `locate.js`：定位安装目录（Windows 自动探测取最新版本；macOS/Linux 走 `--path`）→ 校验 `main.js`/`renderer.js`/`package.json` 存在 → 备份原文件到 `tmp/backup/<版本>/`（已备份则跳过）。
  - `patch.js`：版本一致性校验（字典目录名 ≠ 安装版本即拒绝，错配可能导致应用无法启动）→ 本地无该版本字典时联网取（`dict-sync.ensureDict`）→ 逐条整串替换（只在字符串字面量区间内、内容与键完全相等才替换；整模板键整段替换模板源码）→ 统计命中 → 写回前自动备份 → 完成后重启 GitHub Desktop。
  - `restore.js`：优先把 `tmp/backup/<版本>/` 下的官方原版复制回安装目录；**备份不存在时按字典逆向还原**（`common.reverseEntries` 生成「译文 → 原文」再走同一套替换逻辑）→ 完成后重启 GitHub Desktop。**字典条目被删除或修改后必须先 `restore` 再 `patch`**——`patch` 只替换命中的字面量，不会把已删条目的旧译文从产物里退出。
  - `verify.js`：版本一致性、字典条目在两个文件中的命中率（0 命中 = 两个文件均未出现）、补丁后 `node --check` 语法校验。
  - `scan.js`：**未翻译文案自查**——读安装目录 `renderer.js.map` 中的官方自有源码（`app/src/**`），提取界面文案候选（JSX 文本 + 字面量），与产物、字典对照后输出待补清单（产物侧忽略大小写与空白差异，因产物文案经 `sentenceCase` 处理）。字典迭代时先用它自查，别只依赖截图。
  - `net.js`：零依赖 HTTP(S) GET（文本 / JSON / 二进制），带超时、重定向与进度回调；非 2xx 抛可读错误。在线能力都走它，不引三方库。
  - `dict-sync.js`：字典在线同步——`ensureDict()` 仅在本地（外部 + 内嵌）都没有该版本字典时下载，`syncLatest()` 供「检查更新」强制拉最新并覆盖；远程源按 `common.remoteDictUrls()` 顺序（raw → jsDelivr）尝试，落盘前先 `JSON.parse` 校验、写 `.part` 再改名。
  - `update.js`：工具自更新——查 latest release → 按 `<平台>-<架构>` 后缀选资产 → 下载并校验文件头（MZ / Mach-O / ELF）→ 改名替换自身 → 重启新版本；启动时 `cleanup()` 清理上次的 `.old` 残留。
  - `restart.js`：关闭并重启 GitHub Desktop（原本未运行则不动，避免替用户多开窗口）——界面文本在应用启动时载入内存，不重启看不到效果。
- **界面层**（`gui/`，Electron 原生窗口，可选形态）：`main.js` 主进程（窗口生命周期 + IPC 处理器，直接 `require('../scripts/…')` 调业务）、`preload.js`（`contextBridge` 暴露 `window.api`）、`index.html` / `renderer.js` / `style.css` 渲染层。**GUI 只做表现层**——替换 / 备份 / 还原规则没有第二份实现；渲染进程无 Node 能力（`contextIsolation` + `sandbox`），字典表格只读，**不存在字典写盘通道**。打包配置见 `electron-builder.yml`（`npm run dist`），构建期下载走 `.npmrc` 与 yml 里固化的镜像。
- **字典组织**：`dictionaries/<版本>/zh-CN.json`，**formatVersion 2 的五段结构**——`common` / `windows` / `macos` / `linux` 四段放条目，`groups` 段放组归属，`_meta` 放元信息（`version` / `updated` / `notes` / `formatVersion`）。条目按「跨平台共有」与「平台专有」分段：`common` 对所有平台生效，平台段只对该平台生效（`linux` 段保持为空，官方无 Linux 产物；判定与理由见 `design.md` 第 4 节）。**字典的唯一写入口是 `scripts/dict-edit.js`**——增删改、分组、迁移一律走它（先校验再原子替换，校验不过原文件不动），别手工编辑 JSON、也别在别的脚本里直接 `writeFileSync`；组名由 `scripts/dict-groups.js` 从 sourcemap 推断。三种键形态（普通键 / 整模板键 / 作用域键）与替换规则见 `dictionaries/README.md`。
- **打包与分发**（`cli.js` / `bundle.js` / `build.js`，面向使用者的说明见 `docs/打包与分发.md`）：
  - `cli.js`：交互式中文菜单入口（无参数进菜单；带子命令则透传给对应脚本），`package.json` 的 `tool` 入口。菜单只输出**结果**（命中多少处、是否重启），中间过程不出现在菜单里——子命令走 `quiet` 参数控制（命令行入口仍输出明细）。
  - `bundle.js`：零依赖 CJS 单文件打包器，把 `scripts/` 合成一个自包含 `.js`。**依赖靠静态 `require('...')` 字面量扫描收集**——新增依赖必须写成字面量（模板字符串 / 变量拼接收集不到）；JSON 模块转成 `module.exports = <JSON>`。
  - `build.js`：Node SEA 打包（`node --experimental-sea-config` 生成 blob → postject 注入 node 可执行文件副本），把**最新版本**的字典（`dictionaries/<最新>/zh-CN.json`）作为内嵌资源打进产物——更早版本用到时由 `dict-sync` 联网拉取；产出 `dist/` 下单文件；构建后自动跑一次 `--help` 自检。
  - **运行形态与数据根目录**：`common.dataRoot()` 是唯一来源，判据两条——`isPackaged()`（bundle / SEA 产物）与 `isElectronPackaged()`（Electron 打包产物，即 `isElectron() && !process.defaultApp`）。**源码态与 Electron 开发态**（`npm run gui`）= 仓库根；**SEA 产物与 Electron 打包产物** = 可执行文件所在目录（不可写时回退用户数据目录）。备份、`config.json`、`dictionaries/`、`tmp/` 全在数据根下。一个例外：**macOS 上的 Electron 产物**恒取用户数据目录——exe 在 `.app` 包的 `Contents/MacOS` 里，往包内写一个字节就会让签名失效、下次启动被 Gatekeeper 拒开。
  - **字典「外部优先、内嵌兜底」**：`<数据根>/dictionaries/<版本>/zh-CN.json` 存在则用它，否则取打包时内嵌的同名资源；都没有才联网下载（见下）。用户把字典目录放进数据根即可覆盖内嵌版本。Electron 产物没有内嵌资源（`node:sea` 不可用），字典随包放在应用的 `resources/dictionaries`，由 `gui/main.js` 的 `seedBundledDicts()` 首次运行时把数据根里缺的版本播种过去（只补缺失，不覆盖用户替换或在线更新过的字典）——macOS 与 Linux 的 AppImage 取不到「exe 旁」，靠的就是这一步。
  - **构建与发布（CI）**：`.github/workflows/build.yml` 用矩阵在各平台原生 runner 上构建（`windows-latest` / `macos-latest`(arm64) / `macos-15-intel` / `ubuntu-latest`），**两个 job 并行出两类产物**——`build`（单文件可执行）与 `gui`（Electron 图形界面，配置见 `electron-builder.yml`），`release` 等两者都完成再发。手动触发只构建，推 `v*` tag 则构建后自动发 Release 并附 `SHA256SUMS`。发布前先校验 tag 与 `package.json` 版本一致，不一致直接失败，**改版本号时两者必须同步**。GUI job 在每平台构建后跑 `node build/check-gui-dist.js` 静态自检（应用包结构 / 内置字典 / Windows 产物子系统），**运行态实测只能在本地做**（runner 没有桌面会话，起不了窗口）。
  - **产物去处：Artifacts 是构建中转，Release 才是成品**——手动触发构建后产物留在该次运行的 **Artifacts** 里（单文件产物 `dist-<os>`、GUI 产物 `gui-<os>`），下载得到的是 **zip 压缩包**（GitHub 强制打包），解压后 macOS / Linux 产物可能**丢可执行位**，它只用来自己验证构建，别当成品发给使用者。推 tag 后 CI 建的 Release，附件是**原始文件**（不套 zip），附件名分 **cli / gui 两套**（规范见「发版」一节的「产物命名」），另附 `SHA256SUMS`——给使用者的下载链接一律指向 Release 附件。GUI 产物体积高一个量级（Windows 实测 zip 146 MB、NSIS 安装包 106 MB），四平台全上时 Release 附件合计近 GB 级，属预期。
- **跨平台**：`--path` 可指向任意平台的 resources 目录；自动探测仅实现 Windows。打包产物只能在构建平台运行（Windows 构建 .exe、macOS 构建 Mach-O、Linux 构建 ELF）——基底是构建机的 node 可执行文件，macOS 还必须在 macOS 上注入与签名，**因此没有交叉构建这条路**。跨平台发布走 CI 矩阵（每个平台一个原生 runner），或在各平台各跑一次 `npm run build`。

### 在线能力（改这些代码前先读）

产物分发的现实是「旧产物遇到新版本 GitHub Desktop」，所以字典不能只靠内嵌。约定：

- **远程地址只有一处定义**：`common.js` 的 `GH_OWNER` / `GH_REPO` / `GH_BRANCH` 及其派生 `GH_RAW` / `GH_CDN` / `GH_API`——换仓库、换分支只改这里；字典地址由 `common.remoteDictUrls(version)` 拼，其余脚本不得自行拼 URL。
- **只在缺的时候联网**：`ensureDict()` 的顺序是「外部文件 → 内嵌资源 → 联网下载」，前两者命中就完全不碰网络（已有字典时离线完全可用）；只有用户主动点菜单 `5) 检查更新` 才走 `syncLatest()` 强制覆盖。**联网失败不能静默降级**——报可读错误（列出尝试过的源）并拒绝汉化，绝不拿别的版本字典凑合。
- **零依赖**：HTTP(S) 只用 `node:https` / `node:http`（`net.js`）。不引三方库——产物是零依赖单文件，引入依赖会同时影响 `bundle.js` 的静态 `require` 收集与产物体积。
- **下载内容先校验再落盘**：字典落盘前先 `JSON.parse`（避免把错误页 / 半截内容写成坏字典），并写 `.part` 再改名（原子落盘）；自更新下载的产物校验**文件头**（MZ / Mach-O / ELF）后才替换自身。
- **自更新替换策略**：Windows 不允许删除或覆盖**正在运行**的可执行文件，但允许改名——自身改名 `.old`、新文件改名到原位，任一步失败把旧文件改回来；新进程启动时 `update.cleanup()` 清 `.old`。源码态不支持自更新（提示用 `git pull`）。
- **重启而非静默**：汉化 / 还原后由 `restart.js` 重启 GitHub Desktop（原本未运行则只提示）——不重启看不到效果，这是使用者最容易误判「没生效」的点。

### 跨模块共用约定（改代码时别破坏）

- 版本号概念在 `dictionaries/` 目录名、`scripts/` 版本一致性校验、`docs/` 版本对应表三处出现，改版本组织方式时三处同步。
- 字典文件仅含「原文 → 中文」映射数据，不含任何脚本逻辑；脚本不得在字典外硬编码翻译。
- 「运行形态」判据只有 `common.js` 的两处：`isPackaged()`（bundle / SEA 产物）与 `isElectronPackaged()`（Electron 打包产物）——别在调用方另立一套判断。数据根目录只有 `common.dataRoot()` 一个来源——脚本不得自行拼 `__dirname` 或假定当前工作目录。面向用户的提示文案在打包态与源码态不同（打包态用户没有 npm），用 `isPackaged()` 分支——这类分支只出现在各脚本的 `main()`（命令行入口）里，GUI 走的是 `run()`（结果文案由 `gui/main.js` 自备），所以 Electron 打包态下 `isPackaged()` 为假也不会让 GUI 用户看到 npm 提示。
- 远程仓库地址只有 `common.js` 的 `GH_*` 一处定义，联网统一走 `net.js`（见「在线能力」一节）；逆向还原的判据只有 `common.isReversible()` 一处定义，别在调用方各写一份。

## 翻译维护（字典迭代）

本仓库的日常工作有三类：**更新翻译**（GitHub Desktop 官方版本更新后，为新版本更新汉化包）、**补充翻译**（找出并补译尚未汉化的界面文案）、**纠正翻译问题**（错译、译文破坏功能、失效/冗余条目）。操作手册在 `.claude/skills/translation-maintain/`（`SKILL.md` 三类任务流程 + `references/版本升级.md` 版本适配详程 + `references/收录判定.md` 判定标准 + `references/probe.cjs` 探针模板 + `references/copilot-behavior-test.cjs` 行为验证模板 + `README.md` 人向简介）；本节是仓库级规则，**两处内容需同步修改**。

**三类任务的共同主干**：取证（`npm run scan` / 截图）→ 判定可否译 → 干跑预演 → 写入字典 → `restore` + `patch` + `verify` → 落地复查 → 提交。

**铁律**：

- **干跑在备份上，复查在产物上**——口径反过来必然得到假结论。收录前的命中验证跑 `tmp/backup/<版本>/` 的官方原文（拿 patched 产物干跑，英文早被替换掉，**必然 0 命中**）；打包后的落地复查跑**安装目录的 patched 产物**（在备份上数「原文还剩几处」，量的是原文原本有几处）。
- **零命中 = 删键**：干跑 0 命中的候选，要么键写错（首尾空格 / 大小写 / 引号），要么已被整模板键覆盖——一律剔除，否则冗余条目会让 `patch` 的「0 命中待核对」告警失去意义。
- **改字典必须先 `restore` 再 `patch`**：`patch` 是原地替换，不会把已删条目的旧译文从产物里退出。
- **探针写成 `tmp/*.cjs` 文件再执行**，不用 `node -e`（bash 会吃掉 `${}`、反斜杠 Windows 路径与中文引号）；不在 shell 里拼中文 grep / 正则；**探针输出必须截断**（一次数百 KB 的输出会撑爆上下文，后续取证全部走样）。**`tmp/` 默认不固化**（gitignored，清掉即失）——但有复用价值的中间过程脚本要**视情况固化**：CI / Release 运维类探针与命名回归迁到 `build/tools/`（匿名只读、参数化、自包含，见「常用命令」），别让下次会话重写一遍。
- **一个桶一个提交**：按主题分批（错误提示 / 跨元素片段 / 菜单 / 表单标签…），每批走完 打包 → 验证 → 落地复查 → 提交 全链再开下一批。
- **提交前核对两个数**：字典条目数（`node -e "console.log(Object.keys(require('./dictionaries/3.6.5/zh-CN.json')).length)"`）写进提交信息；`npm run patch` 的合计命中数应与干跑预期**完全一致**（这是最有说服力的一致性证据）。
- **备份必须确为官方原版**：`locate` 的备份是「已存在则跳过」，被污染的备份会静默通过、让后续所有「以原文为准」的取证失真。核验口径：官方原版两个文件的汉字字符数为 **0**（3.6.5 实测备份 0 / 0，汉化产物 599 / 15706）；非 0 就删掉 `tmp/backup/<版本>/` 重新备份。

**判定能否收录**：唯一可靠的方法是在产物里枚举该字面量的**全部**出现位置逐处定性——别按「这段英文像不像界面文案」下结论。简表（完整版与已实证清单见技能目录的 `references/收录判定.md`）：

| 情形 | 处置 |
| --- | --- |
| 只用于显示（JSX 文本，或 `label` / `title` / `ariaLabel` / `placeholder` / `okButtonText` 等属性值） | 可译（普通键） |
| 参与比较或查表，且赋值处与比较处**同源**（同一批字面量整组一起变） | 可译 |
| 参与比较或查表，比的是运行时数据 / git 输出 / API 返回值 | **不可译** |
| 被拼接成标识符或查表键（`e[t+"Error"]`、`"is"+X+"Enabled"`、`n[e+"Done"]`） | 不可译；仅单文件有此用法时改**作用域键** |
| 与外部系统对齐（HTTP 头名、环境变量名、git 输出匹配串、CSS 属性值、库内部常量表） | **不可译** |
| 显示与逻辑复用同一字面量（`"file"` / `"files"` / `" at "` / `"Commit"`） | 改**整模板键**覆盖外层模板；覆盖不了时——满足**整体替换**条件（全部出现位置在同一文件、无跨进程 / 持久化 / 上报、比较两侧同源、配套插值模板收尾正确，实证 `"Rebase"` 34 处同值同改 → 「变基」）可整体替换；否则保持英文，并写进汇报的「有意保留」清单 |

**汇报必须包含**：本次新增 / 删除 / 改写的条目、判定为不可译的项及原因、需**重启 GitHub Desktop** 才能看到新译文（磁盘产物已更新，运行中实例仍是旧内存代码）。

## 已知坑

- **替换后失去官方签名**：汉化产物在 Windows 下可能触发 SmartScreen 提示，属预期行为，文档需提前说明。
- **升级即失效**：GitHub Desktop 官方更新会覆盖汉化文件，需用对应新版本的字典重新打补丁。升级后不是改个目录名就行——整模板键含构建产物里的局部变量名，新版本重新构建后几乎全部失效，必须按「翻译维护」一节的**更新翻译**流程（详程见技能目录 `references/版本升级.md`）重建。
- **版本错配打不开应用**：字典与目标版本不一致时替换结果不可控，`patch` 前必须先校验版本。
- **原地替换不回调**：`patch` 不会把已删条目的旧译文从产物里退出。字典条目有删除或修改时，必须 `npm run restore` + `npm run patch` 重打，否则产物里残留的失效译文继续生效（实例：HTTP 头名 `Link` 被译成中文后 `headers.get` 抛 `non ISO-8859-1 code point`，Issues / PR 拉取全挂）。
- **字典范围与匹配**：收录界面文本（含读屏 / 命令行 / 报错，不含不可见日志）；整串匹配——普通键对应字符串字面量或模板文本段，整模板键对应完整模板源码；大小写敏感。**共用字面量**（英文词同时被非界面逻辑复用，如 `"Commit"` 兼作议题关闭关键词与拖拽枚举值）不能整串替换，只能整模板覆盖外层模板或保持英文。
- **`scan` 的候选有长度盲区（默认阈值 8，且按 `trim` 后长度算）**：`scan` 提取候选后执行 `if (!c || c.length < args.minLength) return;`（`c` 为「空白折叠 + `trim`」后的文本），**被滤掉的候选不出现在输出里、也不报告过滤了多少条**，极易误判成「该文案不在产物中 / 不可译」。实例（3.6.6 补译）：用户截图指认的 `Pulling origin` 对应字面量 `"Pulling "` 带尾随空格，`trim` 后仅 7 字符直接被丢弃，而同批的 `"Pushing to "` 10 字符正常出现——两者在扫描结果里有与没有的差别只来自阈值。**指认的短文案扫不出来时，先放宽阈值再下结论**：`npm run scan -- --out tmp/scan.txt --min-length 4`（npm 会吞掉 `--out`，必须用 `--` 分隔）。
- **译文破坏功能的真实事故（3.6.5 实测，别再犯）**：
  - **git 进度标题被译**：`steps=[{title:"Checking out files",weight:…}]` 的 `title` 参与 `n.title===t.title` 匹配 git 的原始输出，译了进度条百分比不再更新。同批的 `"Receiving objects"` / `"Resolving deltas"` / `"Compressing objects"` / `"Writing objects"` 同理，全部保持英文。
  - **数组元素被译**：`-1===["Syntax","Type","Range"].indexOf(t)` 里的 `"Type"` 译成中文后 `indexOf` 恒为 -1，条件与方法原文左右反转（re2js 库内部，错误类型表全乱）。因整串替换分不开该字面量的另一处表单 label，`"Type"` 只能整体保持英文。
  - **查表键只译一半**：Dexie 错误名表 `e[t+"Error"]=qM[t]`——使用点用英文名查表，只译 `"Unknown"` / `"Abort"` 会让查表永远失败。凡「拼接成标识符」的常量，要么整组一起译、要么整组不动。
  - 教训：**收录前必做「是否参与比较/查表/拼接」判定**，判定方法见「翻译维护」一节。
- **逆向还原（没有备份时的 `restore`）**：
  - **逆向键就是译文原样，不做任何加工**：正向替换是把「区间内容」整体换成译文——落在字符串字面量里就是引号之间的内容，落在整模板键上就是含两侧反引号的整段源码；两种情况下产物里该区间的 `content` 都恰好等于译文本体，故按 `content` 直查即可命中。剥引号、去反引号之类的「加工」会让整模板条目全部失配。
  - **`stringLiterals` 对模板整段区间一律收集（含插值与否）**：只收集含插值的，会让「译文变成无插值模板」的条目在还原时失配——含反引号的原文塞回文本段会提前闭合反引号，产生语法错误（实测 `Unexpected token ','`，整段收下后消失）。
  - **无辨识度译文必须排除**：译文本身就是原版里到处都有的文本（`" "`、`" / "`、`"…"`）当键逆替换会**误伤没被汉化过的位置**——实测 `"that " → " "` 会让原版所有空格字面量变成 `"that "`；`"automatically…" → "…"` 让官方 11 处省略号全被改写。判据是 `common.isReversible()`：含字母数字（`zh-CN`、`` `${t} ${n}` ``），或含非 ASCII 且不属于 `SHARED_PUNCT`（英文排版同样会用到的 Unicode 标点：弯引号 / 破折号 / 省略号 / 项目符号…）。新增 `SHARED_PUNCT` 成员前先想清代价。
  - **代价（刻意付的）**：官方原文是 `The "` 的位置会保留中文弯引号（3.6.6 实测 1 处）——若让 `“` 参与还原，它落到双引号字符串里会提前闭合引号，语法校验不过、还原被整体拒绝，比留一个弯引号严重得多。
  - **歧义按确定性规则取舍**：同一译文对应多个不同原文（3.6.6 实测 main.js 70 组 / renderer.js 72 组）时字典无从判断，取候选的规则是「作用域键优先 → 更短原文优先 → 字典书写顺序先入者」，保证「汉化 → 还原 → 再汉化」往返稳定、不漂移（词形可能与官方略有差异，如 `Parameters` / ` arguments` 同译「参数」）。
  - **验收口径**：往返一致——官方原版 → 汉化 → 逆向还原 → 再汉化，两次汉化**逐字节哈希相同**；判据由 `test/reverse-entries.test.js` 覆盖，改 `reverseEntries` / `isReversible` / `stringLiterals` 后必须重跑（`npm test`）。
- **机制细节（写探针前必读）**：`applyDictInStrings(content, entries)` 期望**已剥离作用域前缀**的键（传 `scopedEntries(entries,'renderer.js')` 的结果），直接塞 `renderer.js|Enabled` 会 0 命中；`stringLiterals` 返回的 `start` / `end` 指向**引号内内容**（不含引号），做「字面量后面紧跟什么」的判断时 post 串以**闭合引号**开头；字典条目**译文不得为空串**（`buildEntries` 抛错），需要消掉某段英文时用单空格 `" "`。
- **打包态的进程环境与源码态不同（改脚本时注意）**：
  - `process.execPath` 指向产物自身（SEA / bundle 产物是单文件 exe，Electron 产物是应用 exe），**不能**再当 node 用——`verify` 的语法校验已从 `node --check` 子进程改为 `vm.Script` 解析（只解析不执行，两者在官方产物上结果一致）；
  - bundle 产物里 `require.main` 由打包器复刻（指向入口 `cli.js`），子脚本的 `if (require.main === module) main()` 在打包态**不成立**，`cli.js` 透传子命令时显式调用脚本导出的 `main()`（`patch.js` / `restore.js` 已导出；`locate` / `verify` / `scan` 是加载即执行）；
  - 打包态下 `__dirname` 被设为可执行文件所在目录，`path.resolve(__dirname, '..')` 不再指向仓库根；产物旁没有 `dictionaries/`，字典走内嵌资源；
  - 打包态用管道一次性喂入多行 stdin 会丢行（readline 预读），测菜单交互要分次输入。
  - **Electron 打包态是另一套**（`npm run dist` 的产物）：`__dirname` 落在 `resources/app.asar` 内（asar 内 `require` 正常），`process.execPath` 是改名后的应用 exe；字典走 `extraResources` 进应用的 `resources/dictionaries`（不是内嵌资源——`node:sea` 在 Electron 里不可用；**也不能放 exe 同级**，macOS 的数据根在用户数据目录、Linux 的 AppImage 挂在只读临时目录，两处都取不到），由 `gui/main.js` 的 `seedBundledDicts()` 在 `registerIpc()` **之前**播种到数据根——状态与字典表格读的就是数据根里的字典；数据根在 macOS 上恒为用户数据目录（见上）。上面关于打包器复刻 `require.main`、stdin 预读的两条只适用于 bundle / SEA 产物。
- **改 Release 正文的中文编码坑（实测发生过）**：用脚本改已发布 Release 的正文时，HTTP 响应**不要按数据块 `toString('utf8')` 解码**——多字节字符会在块边界被截断，正文出现 `还��` 这类替换符，而接口照样返回成功；要**按 `Buffer` 拼接后整体解码**。正文以本地 `CHANGELOG.md` 对应段落为准整体写回，写回后逐字复核（与 CHANGELOG 逐字一致、无替换符），别只看状态码。
- **electron-builder 在 CI 上会隐式发 Release（v0.2.0 首次发 GUI 产物时踩到）**：electron-builder 26 只要 `publish` 未显式指定就自行判定——检出 tag 时（`GITHUB_REF_TYPE=tag`）按 `onTag`、仅检测到 CI 时按 `onTagOrDraft`，随后**在四个平台各自构建全部跑完之后**才去找 `GH_TOKEN`，找不到就报 `GitHub Personal Access Token is not set` 并 exit 1。表现是「每个平台的 GUI job 都失败、且都失败在最后一步」，本地却怎么跑都成功（本地无 CI 与 tag，这条分支不触发），极易误判成打包配置坏了。本仓库的 Release 由 `gh release create` 创建、不走 electron-builder，故 `package.json` 的 `dist` 脚本固定带 `--publish never`——**别去掉**；`electron-builder.yml` 里也不要加 `publish` 配置。要复现本地只需 `CI=true GITHUB_REF_TYPE=tag GITHUB_REF_NAME=v0.2.0 npm run dist`。
- **本机系统代理只有浏览器走**（v0.2.0 多次推送失败才定位）：本机装了系统代理（`127.0.0.1:7890`，Windows 注册表 `ProxyEnable=1`），浏览器走它、`git` / `curl` / Node 的 fetch **都不读系统代理**——直连 `github.com:443` 被掐，表现为 `git push` 反复 `connection reset` / 26 秒超时，而 `api.github.com` 却通（不同出口），极易误判成网络整体故障。解法：推送 / 拉取时临时走代理，**不改全局 git 配置**——`git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 push origin main`，或设 `HTTPS_PROXY` / `HTTP_PROXY` 环境变量（`curl -x` 同理）；Node 的 fetch 超时不能靠这个解法，大文件下载（Electron 二进制等）改走 npmmirror 镜像（见 `docs/打包与分发.md` 构建期网络一节）。

## 提交规范

- 中文约定式提交：`<type>(<scope>): <一句话中文标题>`，type 取 feat / fix / chore / docs / refactor 等常规类别。
- 提交信息不带任何 `Co-Authored-By` 类署名。
- 只做本地提交，不自动 push / merge / 建 PR；显式 `git add <文件>`，禁止 `-A` / `.`。
- 仓库为开源仓库：文件内容不写绝对路径、机器名、凭据等敏感信息。

## 发版

版本号遵循语义化版本，按改动幅度分级取号：**大版本 `vX`** = 整体重构（结构性 / 破坏性改造）；**中版本 `vX.Y`** = 大改（工具链或字典组织方式的变更，如新增脚本、字典格式调整）；**小版本 `vX.Y.Z`** = 小修小改（译文修正、文档同步、缺陷修复）。

**三处对齐**（发版即三者同指一个版本，缺一不可）：

1. `CHANGELOG.md` **顶部最新条目**的 `## [x.y.z]` 标题（校验只认顶部一条，历史条目同为该形式但不参与对齐）；
2. `package.json` 的 `version`；
3. git **注解 tag** `vX.Y.Z`（把版本钉到具体提交，可用 `git tag --contains <sha>` 反查某提交属于哪个版本）。

**发版顺序**：

1. **版本号改动只在发版提交中落**——功能提交（`feat` / `fix` / `docs` 等）**不得**夹带 `CHANGELOG.md` 顶部新条目与 `package.json` 的 `version`（这两处只在发版提交里改）；
2. 版本内容**独立成一个提交**（`chore(release): 发布 vX.Y.Z`，只允许动 `CHANGELOG.md` / `package.json` / README 与 docs 的呈现层同步），tag 打在它上面，让「这一版到此为止、版本号定案」在历史上有一个干净锚点；
3. 发版提交必须位于**该版本最后一个功能提交之后**；发版条目**一次写全**（覆盖该版本全部改动），**一经创建不得在后续提交中修改**——发版后发现的补充只能记入下一个版本的条目；
4. 打注解 tag：`git tag -a vX.Y.Z -m "vX.Y.Z: <一句话说明>"`；
5. tag 与 main 一并推送：`git push origin main --follow-tags`（`--follow-tags` 只带注解 tag，与上面的 `-a` 配套）。发版推送是**用户明确要求的动作**，与「提交规范」里「不自动 push」不冲突——日常提交仍只落本地；
6. CI（`.github/workflows/build.yml`）随即构建各平台产物并发 Release——单文件产物与 GUI 产物**两类都发**（四个平台、共十余个附件，见上「产物去处」），**正文取自 `CHANGELOG.md` 对应段落**（`scripts/changelog.js` 提取，不是自动生成的变更列表）；GUI 产物随 Release 分发是既定行为，改 `gui/` 或 `electron-builder.yml` 后发版即自动带上。

**产物命名**（v0.2.0 起分 **cli / gui 两套**，通道词紧跟项目名、置于版本号之前）：

| 形态 | 模板 | 例 |
|---|---|---|
| 单文件可执行（SEA） | `github-desktop-zh-cn-cli-v<版本>-<平台>-<架构>[.exe\|.bin]` | `…-cli-v0.2.0-win32-x64.exe` |
| 图形界面（Electron） | `github-desktop-zh-cn-gui-v<版本>-<平台>-<架构>[-setup].<扩展名>` | `…-gui-v0.2.0-win32-x64-setup.exe` |

- **为什么是 `cli` / `gui` 紧跟项目名**：附件在 Release 页面里按名字排序，同类相邻、一眼分得出哪个是给命令行的、哪个是给图形界面的；旧命名（`github-desktop-zh-cn-v0.2.0-win32-x64.exe` 与 `…-v0.2.0-win32-x64.zip` 混在一起）看不出通道。
- **v0.2.0 之前发布的版本用 `rename-assets` 统一命名**（v0.1.0 / v0.1.1）：它们当初叫 `github-desktop-zh-cn-v<版本>-<平台>-<架构>[.exe|无后缀]`，缺 `cli` 通道词、macOS / Linux 还缺 `.bin` 后缀。该任务**只动名字、不动字节**（下载下来改名再传上去），`SHA256SUMS` 随之重算，旧名字的下载链接失效——见下「要改已发布的 Release」。
- **后缀**：Windows 单文件产物用 `.exe`；macOS / Linux 用 `.bin`（**v0.2.0 起新加**）——此前没有后缀，下载页里看不出是什么文件，浏览器也可能不给存成可执行文件。`.bin` 只是命名，产物本身还是 Mach-O / ELF。
- **平台词**用 `darwin` / `win32` / `linux`（SEA 侧是 Node 的 `process.platform`，GUI 侧靠 `electron-builder.yml` 里用 `${platform}` 而非 `${os}` 对齐）。**架构词随产物走**：SEA 侧是 `process.arch`（`x64` / `arm64`），GUI 的 Linux 目标由 electron-builder 按各自规范给名（AppImage 是 `x86_64`、deb 是 `amd64`），故 `linux` 侧两类的架构词不完全一致，属预期。
- **改名前先看这两处依赖**：`scripts/update.js` 的自更新按「`-<平台>-<架构>` + 平台后缀」匹配附件（`pickAsset`，无后缀的老产物也认），`build/check-gui-dist.js` 会校验 GUI 产物名是否走 `…-gui-v<版本>-…`。三处（`scripts/build.js` / `electron-builder.yml` / `update.js`）要一起改，改完各平台跑一次构建看实际文件名。

**tag 推送与 Release 创建是同一个发版动作的两半，须配套完成、一次做完**：只推 tag 不建 Release 时首页 Releases 区块收不到该版本，只建 Release 不推 tag 时远端没有对应 ref（`/tree/<tag>` 是 404）——任一中间态都算发版未完成。**不留只存在于本地的 tag**；tag 还须指向已在远程 `main` 上的提交，避免「tag 打得开、`main` 上却看不到」的错位。

**Release 由作者的 PAT 创建**（`secrets.RELEASE_TOKEN`），不用内置 `GITHUB_TOKEN`——内置 token 建出来的 Release 署名是 `github-actions[bot]`，而**作者一经创建无法修改**，要换署名只能删了重建，故必须在创建前就定好。首次配置：GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained token**，`Repository access` 只勾本仓库、权限只给 **Contents: Read and write**；再到仓库 Settings → Secrets and variables → Actions 建 repository secret，名字必须是 `RELEASE_TOKEN`。secret 缺失时 release job 会在创建**之前**失败并打印可读原因（构建产物不受影响，仍在 Artifacts 里）；令牌过期后同样会失败，换新令牌重配即可。

**Gitee 镜像的发行版由 CI 补发**（`secrets.GITEE_TOKEN`，**可选**）：Gitee 的仓库镜像只同步 commit / 分支 / tag，**发行版不在同步范围内**——所以 tag 推上去后 Gitee 上仍是空的，`release` job 末尾的「发布到 Gitee」步骤负责补上：按 tag 探测 → 没有就创建，正文取 CHANGELOG 段落并**追加一段指向 GitHub Release 的下载指引**。**只发正文、不传附件**：Gitee 的配额根本放不下这些产物——附件**单文件上限 100 MB**（13 个产物里 10 个是 106～146 MB），**单仓库附件总容量 1 GB**（产物合计 1.38 GB）；这两项在 SaaS 各档位都一样（社区版 100 MB / 1 GB，企业版单文件同样 100 MB），只有私有化部署才提供定制配额。所以 Gitee 侧没有产物，**正文里那段链接就是唯一的下载入口**，少写它使用者只会看到一个空壳。两个 Gitee 特有的坑：按 tag 查发行版时**用 `200 + 字面量 null` 表示不存在，不是 404**（照搬 GitHub 的判据会把「不存在」读成「查询失败」）；创建后返回的对象**没有 `html_url`**，要按 tag 自己拼。**缺 `GITEE_TOKEN` 不阻断发布**——`check-version` 里打一条 `::warning::` 说明本次不同步、`release` job 里那一步直接跳过，Gitee 是镜像渠道，不该让它挡住权威源；而 `release` 里 Gitee 步骤失败**只让 job 标红，已发布的 GitHub Release 原样保留**。配置：Gitee → 设置 → 私人令牌（`https://gitee.com/profile/personal_access_tokens`），勾 `projects` 权限，再到 GitHub 仓库的 Actions secrets 建 `GITEE_TOKEN`。使用者侧对应的是 `scripts/update.js` 的「检查更新」：GitHub 取不到时退回 Gitee 的 `/releases/latest` 兜底——**它只够告知版本号，产物仍须从 GitHub 取**（Gitee 侧不放附件，且它的资产对象只有 `browser_download_url` 与 `name`，没有 sha256 / size 可比）。

**别指望把构建搬到 Gitee 上绕开配额**：Gitee Go 的构建插件（Maven / Gradle / Ant / Golang / Node.js / PHP / Python / GCC）**基础镜像全是 CentOS 7.6 / 8.3 与 Ubuntu 20.04，没有 Windows、没有 macOS runner**；而本仓库 13 个产物里 **10 个必须在各自平台原生构建**（Node SEA 单文件产物绑定构建平台上的 node 可执行文件，Electron 的 dmg 只能在 macOS 上做）。何况 Gitee Go 免费额度只有 500 分钟/月（单仓库另有一次性 200 分钟），而 GitHub Actions 对公开仓库免费无限——构建与发版留在 GitHub，Gitee 只做镜像。

**控制面走 PAT、数据面走内置 token**（v0.2.0 首次带 GUI 产物、传附件时实测）：建 / 改 Release 用 `RELEASE_TOKEN`（署名才是作者本人），**附件传输用内置 `GITHUB_TOKEN`**——`release` job 因此需要 job 级 `permissions: contents: write`。依据是附件上传者字段（`GET /repos/{o}/{r}/releases` 里每个附件的 `.uploader.login`）：v0.1.0 / v0.1.1 的附件共 420 MB 都是内置 token 传的，分别只用 97 秒、915 秒；换成 PAT 后三次尝试跑了 606s / 1657s / 939s **全部失败**，注解还点名卡在同一类 107 MB 的单文件产物上——而同一个文件当年用内置 token 传上去过两次。故看到「构建 job 全绿、只有发布 job 失败、一跑就是十几到二十几分钟」时，先怀疑是不是把附件传输也交给了 PAT。改回内置 token 后，v0.2.0 的 13 个附件（1.38 GB）**71 秒**传完。

**发版提交必须就是 tag 指向的那个提交**（v0.2.0 踩到反例）：CI 按 tag 检出并构建，**tag 指向哪份提交，发布的产物就是哪份**；而 `chore(release): 发布 vX.Y.Z` 这个提交的意义是「这一版到此为止」——它若落在中间、后面还接着落修复提交，历史里就出现「版本定案的锚点」与「实际发布的产物」对不上的错位，`git show <发版提交>` 看到的内容与使用者下载到的东西不是一回事。v0.2.0 正是如此：发版提交之后又落了十余个 CI / 文档修复提交（其中也含 `gui/main.js`、`scripts/common.js`、`electron-builder.yml`、`build/check-gui-dist.js` 等产品代码改动），tag 最终打在最后一个提交上。**修法是重建发版提交**：等该版本的修复全部落完，**在最后再补一个 `chore(release): 发布 vX.Y.Z` 提交**（同样只动那几处、内容与前一个发版提交一致），再把 tag 强推到这个新提交上，让「发版提交」重新等于「tag 指向的提交」。**别指望「发了 tag 之后再落修复提交、重跑 CI 把修复带进产物」**：release 步骤对已发布的 Release 直接跳过（见下），这么做只会把上面的错位坐实。同理，发版提交本身若需要重做（如发布策略变更），也是**再补一个发版提交**而不是把 tag 挪回旧提交——tag 只能往前指。

**已发布的 Release 不再改动**：CI 只**创建**缺失的 Release——该 tag 的 Release 已**发布**时，发布步骤直接跳过、正文也不动。因此**改已发布版本的正文不能靠重跑 CI**，只能直接改 Release（`gh release edit <tag> --notes-file <文件>`，只换正文、不碰附件）。历史改写等场景**强推 tag 会再触发一次 CI**（tag 推送即触发），发布步骤同样按设计跳过，产物与正文都不被覆盖。

**要改已发布的 Release，用 `repair-release.yml`**（`.github/workflows/repair-release.yml`，`workflow_dispatch`，输入 `task` / `tag` / `confirm`——`confirm` 必须与 `tag` 逐字相同，防手滑；三个任务都**只动 Release、不动 tag、不动产物字节**）：

| `task` | 做什么 | 用途 |
|---|---|---|
| `delete-release` | 删掉该 tag 的 Release（**不带 `--cleanup-tag`，tag 保留**），不碰其它 | 让 `gh release create` 能重跑一遍——强推 tag 触发 CI、或用新命名 / 新正文重发，修的是**产物与正文** |
| `restore-release` | 把附件与标题取下来（正文另说，见下）→ 删 Release → 用 `RELEASE_TOKEN` 以**同一 tag** 重建（先 `gh release create --draft` 建草稿，传完附件再 `gh release edit --draft=false --notes-file` 转正）→ 用内置 token 逐个回传同样字节的附件（与发版同一套：逐个、每个 3 次重试、失败写 `::error::`）→ 核对署名与附件名单 | 修**署名**——作者一经创建无法修改（见上），v0.1.0 / v0.1.1 的 Release 是早期用内置 token 建的、署名 `github-actions[bot]`，只能这么重建 |
| `rename-assets` | **不删 Release**：全部产物下载下来 → 按下面的规则改名 → 传新名（旧名先留着）→ 重算 `SHA256SUMS` → 删旧名 → 核对 | 把老版本统一到 cli / gui 命名——v0.1.0 / v0.1.1 的附件缺通道词、macOS / Linux 还缺后缀 |

**改附件名只有「传新名 + 删旧名」一条路**（GitHub 没有重命名附件的接口），所以 `rename-assets` 的顺序是**先传后删**：新名字的产物全部就位、`SHA256SUMS` 也覆盖成指向新名字之后，才删旧名字——于是任何时刻页面上的清单都只列**真实存在且哈希对得上**的文件，中途失败也只是多留了一组旧名字（重跑按 digest 跳过已传的，已改好的不再动）。规则只认「含 `-<本版本号>-` 且既非 `-cli-` 也非 `-gui-`」的名字：老产物一律当 cli（那时候只发单文件产物），macOS / Linux 补 `.bin`（Windows 早就有 `.exe`）；认不出的名字（`SHA256SUMS`、预发布 tag）一概不动——**认不出就不改，比改错强**。定位上它和另两个任务不同：**不重建 Release**，署名 / 正文 / `published_at` / 下载计数都不动，代价只是白传一趟字节。幂等：已经全是新命名时跑它会直接报「无需改动」退出。

**同 tag 名下多出一个草稿，「按 tag 寻址」就不确定了**（v0.1.0 / v0.1.1 的页面上出现过这种重复项）：`gh` 的下载 / 上传 / 删附件都靠 tag 找 Release，而同 tag 若还留着一个草稿——`restore-release` 跑到一半失败就会留下（它那条路是「先建草稿、传完附件再转正」，断在中途就是个半成品）——页面上的「发行版列表」于是有两条一模一样的（草稿排在前面、带「草案」标记），寻址也就有了两个候选。实测 `/releases/tags/<tag>` 这时返回的是**已发布**那个，但那是服务端当下行为、不是承诺。`rename-assets` 因此显式要求「恰好一个、且已发布」（先用 `/releases/tags/<tag>` 的 `.draft`，再数一遍 `/releases?per_page=100` 里同 tag 的条数），不满足就停下来并写明怎么清理：**在页面上点进那个草稿、右上角垃圾桶删掉**，再跑本流程。流程不自动删草稿——删错了就是丢一条发布记录，值不值得删由人判断。

三个任务都只在**手动**触发时跑（`workflow_dispatch` 不会自己跑），所以留在仓库里不碍事；`tag` 填错时最坏结果是删掉一个 Release（附件在删之前已备份到 runner 的临时目录、`restore-release` 会原样传回，正文按下面那条规则重建），**但 `delete-release` 之后若 CI 没能重发成功，那个版本会暂时没有 Release**——真要紧的版本，先用 `restore-release` 走一遍比直接删稳。`rename-assets` 不删 Release，填错 tag 的代价只是给另一个版本多传一组新名字的附件（旧名字与旧清单都不动，页面照旧可用，倒回去把新名字删掉即可）。

**重建出来的正文取自 CHANGELOG.md**（`restore-release` 与发版同一来源）：用 `scripts/changelog.js` 提出该 tag 的条目当正文，条目提不到（老版本、条目被删）才沿用现网 Release 那份快照。于是「改 `CHANGELOG.md` → 再修复一次」就能把正文的改动带进已发布的 Release——v0.1.0 / v0.1.1 开头补引用块就是这么补的（两个条目自发布起逐字未变，重建只带进那一个 `>`）。与现网那份不同时运行日志里有一条 `::notice::` 说明，不闷声改。**复用草稿那条路也会把正文对齐一次**（它不重建草稿，里面那份可能还是旧的），所以正文的准头始终在 `CHANGELOG.md`：别在 Release 页面上手改，下次修复会被盖掉。

**修复跑砸了怎么接着修**（`restore-release` 的续传入口）：备份在删之前先传成 Artifacts（`release-backup-<tag>`，保留 30 天），所以「删掉了但没建回来」不是灾难。重跑时**可以**带 `backup_run_id=<那次运行的 id>`；**不给也行**——该 tag 眼下没有 Release 时，备份步骤会自己去 `/repos/{o}/{r}/actions/artifacts?name=release-backup-<tag>` 找最近一份**没过期**的，再从它的 `workflow_run.id` 取回那次运行（走 job 的 `actions: read` 权限，`permissions` 里显式列了——显式写 `permissions` 会把没列出的权限**清零**，少了这条 `gh run download` 必 403，而那正是这条兜底路要走的接口）。此时若该 tag 眼下**没有 Release**（上一次删了没建回来），流程会直接新建——正文照例由 `CHANGELOG.md` 现生成（见上）、标题退回 tag 名。**只停在草稿**（发布那步失败就会留下这个状态：附件已传齐、只是没转正）时连 `backup_run_id` 都不用给：草稿是自己建的、附件已齐，重跑会复用草稿、按 digest 跳过上传、只补「对齐正文 + 发布」那两下。判断眼下是哪种状态看 `gh api "repos/{o}/{r}/releases/tags/<tag>"`：草稿用写权限令牌可见，匿名只看得见已发布的。查这个 Release **也走 `RELEASE_TOKEN`**（草稿的可见性有边界，内置 token 查漏了会让流程误判成「没有 Release」而去新建，撞 `already_exists` 白跑一趟）；附件字节的下载仍走内置 token——控制面 PAT、数据面内置，与发版同一套纪律。

**改 Release 的接口只认数字 id**（v0.1.0 / v0.1.1 两次修复栽在这条上）：`PATCH /repos/{o}/{r}/releases/{release_id}` 的参数文档就一句「The unique identifier of the release.」——传 tag 名是 **404**（实测：`GET /releases/<tag>` 同样 404，只有 `/releases/tags/<tag>` 这个独立端点收 tag，且**只支持 GET**；改、删都得先查 id）。于是 `gh api -X PATCH ".../releases/tags/$TAG" -f draft=false` 会**静默**失败：那条命令没包错误输出，bash 直接 `exit 1`，注解里只剩 runner 的 `Process completed with exit code 1.`，既看不出栽在哪一行、又白白让该版本下线（删在前、发布在后，中间那步一挂就停在没有 Release 的状态）。现在控制面一律用 build.yml 里跑通过的那几条 `gh release` 命令（`create` / `edit` / `delete`——它们内部自己按 tag 查 id），并在**每条**控制面命令外头包一层错误输出（失败时把 gh 的原文写进 `::error::` 注解）；确需直接调 API 时用数字 id。另注意 `make_latest` **默认 `true`（「Defaults to true for newly published releases」）**：草稿转正会把 Latest 抢过来，重建旧版本时必须把该在的那个放回去——做法见下条。

**Latest 归属按版本号现算，不记忆「原来是谁」**（v0.1.0 / v0.1.1 重建完 Latest 停在 v0.1.1 就是栽在这条上）：两次修复可以**并发**跑（`concurrency` 按 tag 分组，v0.1.0 与 v0.1.1 实测相隔 11 秒同时发布），先记下的「原来是哪个」会被另一次运行改掉；重建又会把 `published_at` 重置成当下（API 没有回填字段），按时间也排不出先后。于是取**版本号最大**的那个正式 Release（非草稿、非预发布、tag 形如 `vX.Y.Z`）——这本来就是 GitHub 上「Latest」一词的含义。用 `gh release edit <tag> --latest`（它内部自己按 tag 查数字 id，避开上一条那个坑）。**每次 `restore-release` 跑完都会重算一次**，所以「Latest 被抢走」这件事会自愈，不必手工纠正。

**别在 checkout 之前往工作区落盘**（v0.1.0 / v0.1.1 两次修复「发布成功了却报失败」的根因）：runner 的工作区目录本来就在（而里面还没有 `.git`），于是 `actions/checkout` 走的是 `prepareExistingDirectory` 的 remove 分支——步骤日志里那句 `Deleting the contents of '<工作区>'`——把整个目录**清空重建**。上一版在「校验输入」（checkout 之前）那步 `| tee prev-latest.txt`，几步之后 `sed` 读不到这个文件、退出码 **2**、`bash -e` 闷声退出且一条注解都没有；两个版本的 Release 明明都建好发布了，两次运行却都是红的，查起来极费劲。要跨步骤传文件就放在 checkout 之后；能用现算解决的（Latest 的归属就是一例）就别传文件。另外**三个 run 块都装了 ERR trap**（`trap '… $LINENO …' ERR`），意外失败会留下一条**带行号**的 `::error::` 注解——被 `if` / `||` 明确接住的失败不触发它（本地实测过）；排查时先看注解，别只看那句 `Process completed with exit code N`。找根因的经验：**注解是匿名可读的，job 日志要仓库权限**，所以「失败但没有任何注解」本身就把范围缩到了「没有包错误输出的那一行」。

**改正文要连 `CHANGELOG.md` 一起改**：发版条目原则上「一经创建不得修改」（见上），但**重建某个版本是例外**——正文取自 CHANGELOG，只改线上 Release 会让两者对不上。重建时三者一起动：**CHANGELOG 对应条目 → 补一个该版本的发版提交 → 强推 tag 让 CI 重发**（走 `delete-release` 那条路），别只改一头。

**草稿要复用、不要删**（实测踩过）：`gh release create` 是**先建草稿、传完附件才发布**，中途被取消（或上传失败）就留下一个附件不全、还可能是旧提交产物的草稿。草稿对匿名接口不可见（`/releases` 列不出、`/releases/tags/<tag>` 返 404），但 `gh release view` 用写权限令牌**看得见**。早先的写法是发现草稿就 `gh release delete <tag> --yes`（不带 `--cleanup-tag`，tag 保留）后重建——看着干净，代价是**已传上去的附件全部作废重传**，而 1.4 GB 的附件本就难一次传完，重跑等于从头再来。现在改为**复用草稿**：内容一致的附件跳过（本地 `sha256sum` 比远端附件的 `.digest` 字段——那就是上传内容的 sha256；`digest` 为空的老式上传判不等、重传，偏向安全的那一侧），缺什么补什么，发布前再把不属于本次构建的遗留附件 `gh release delete-asset --yes` 清掉——末端状态与「删掉重建」等价。**但只复用自己的草稿**：署名在建 Release 的那一刻就定了，update 接口没有 author 字段、事后改不了——复用一个内置 token 建出来的草稿，最后发布的 Release 仍署名 `github-actions[bot]`，等于白拆一遍令牌（run #6 的创建步骤用的是 `${{ github.token }}`，就建出过这么一个草稿，后被 run #10/#11 的「删掉重建」清掉）。故续传前先比草稿作者与发布令牌身份（`gh api user` 的 `.login` 比 `releases/tags/<tag>` 的 `.author.login`），对不上就 `gh release delete --yes`（不带 `--cleanup-tag`，tag 保留）后重建。另外，发布步骤只对**已发布**的跳过；跳过时 `创建 Release` 这一步耗时接近 0 秒，**「这一步 0 秒过、Releases 列表里却没有这个版本」就是被旧草稿骗过的信号**。

**上传失败要能查、要能续**（v0.2.0 首次带 GUI 产物时踩到）：一次性 `gh release create <tag> dist/*` 是串行传完所有附件、**任一附件失败整条命令作废**，已传的部分只能重来；而「第一个附件失败就 `exit 1`」一样糟——后面的附件连试都没试过（实测就是如此：10 个附件卡在第一个 107 MB 的文件上，其余根本没轮到）。现在的写法是逐个 `gh release upload --clobber`、**每个最多 3 次、单次 `timeout 1200`**，失败**不中断**、全部试完再 `exit 1`，于是失败附件的名字与 gh 的错误原文会同时出现在两处：步骤日志，以及 `::error::` **注解**（`GET /repos/{o}/{r}/check-runs/{job_id}/annotations` **匿名可读**，job 日志则要有仓库权限才能读——排查时先看注解）。跑一次只补缺失的那些，所以**失败后重跑即可续传，不必从头再来**。

CI 在发版前校验三处是否一致（tag ≠ `package.json` 版本、或 CHANGELOG 缺该版本条目时直接失败），但**不定级**——该升哪一位由人按上述规则判断。

**CHANGELOG 条目格式**（`scripts/changelog.js` 按此格式提取，改动格式须同步它）：

```markdown
## [0.1.0] - 2026-09-17

<一段话概述这一版做了什么>

### 新增

- **标题**：说明

### 变更 / 修复

- 同「新增」，按改动性质取用；没有该类改动则省略该节。小节标题用中文（新增 / 变更 / 修复 / 说明），不用 Added / Changed / Fixed。

### 说明

- 分级理由。
- `package.json` 版本号 0.0.0 → 0.1.0
```

条目末须列出 `package.json` 的版本号变更行（A → B）；历史条目不改写（记录当时事实）。
