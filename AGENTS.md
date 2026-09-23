# AGENTS.md

本文件是 Claude Code 及其他 agent 在本仓库工作时的指引；**本文件为唯一权威源**。项目介绍见 `README.md`。

## 按需加载索引

本文件只放**每次都要遵守**的规则；下面这些「特定时机才用」的内容拆成了分册，在做对应工作前先读：

| 何时读 | 分册 |
|---|---|
| 发版、改产物命名、动 CI 发布流程前 | `docs/agents/发版.md` |
| 排查故障、遇到似曾相识的现象、改动像是会踩坑时 | `docs/agents/已知坑.md` |
| 增删改译文字典条目、跑自动产出字典前 | `docs/agents/翻译维护.md` |

## 仓库定位

GitHub Desktop 中文汉化补丁工具仓库（字典驱动、开源）。GitHub Desktop（Electron 应用）官方未提供简体中文界面，本仓库以 **JSON 语言字典为唯一翻译资产**，用 Node.js 脚本对官方安装目录内 `resources/app/main.js`（主进程）与 `renderer.js`（渲染进程）执行字符串替换实现汉化。由此推出硬性约束：

- **字典是核心资产**（`dictionaries/<版本>/zh-CN.json`），脚本只做机械替换、**不内置翻译**；字典与脚本分离维护。
- **版本强对应**：字典必须与 GitHub Desktop 版本一一对应，错配可能导致应用无法启动；字典条目只针对用户可见的 UI 文本（界面元素 / 读屏 / 命令行 / 报错），不含用户不可见的日志文本。**例外（用户明确授权时）**：发给模型的输入文本（Copilot 提示词 / 冲突输入文档 / 仓库约束说明）可收录——前提是保留全部输出契约（JSON 键、`"keep"` / `"delete"` 等取值、解析器依赖的字段），并经行为验证（见`docs/agents/翻译维护.md`）。
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
npm run dist           # 打包图形界面产物（electron-builder → dist/gui/，按当前平台：Windows NSIS+7z / macOS dmg / Linux AppImage+deb；产物自检见 node tools/check-gui-dist.js）
npm run build          # 打包成单文件可执行（dist/ 下，双击即用，无需 Node）
npm test               # 匹配器单元测试 + 产物命名回归（node --test）
```

CI / Release 运维探针（`tools/ops/`，匿名只读、零依赖、仓库地址取 `common.js` 的 `GH_OWNER/GH_REPO`，详见该目录 README；`update-e2e.cjs` 例外——不发 API，本地 spawn 产物驱动真更新）：

```bash
node tools/ops/ci-status.cjs                 # 最近 CI 运行概览
node tools/ops/job-timing.cjs <runId> [名字] # 某 job 步骤耗时（定位失败步）
node tools/ops/wait-run.cjs <runId>          # 轮询运行直到结束
node tools/ops/release-detail.cjs <tag>      # Release 署名 / 附件上传者 / 时间戳
node tools/ops/rel-check.cjs [tag...]        # 核对附件名是否符合 cli / gui 命名规范（两套后缀口径，见发版.md「产物命名」）
node tools/ops/update-e2e.cjs <产物exe> <bundle.cjs> [分钟] # 发版第 7 步驱动器：spawn 产物实跑「检查更新→下载→替换→重启」，按输出喂 stdin
node tools/ops/wf-lint.cjs [workflow]        # workflow 体检（run 块 bash -n + YAML 禁忌）
```

界面图生成器（`tools/make-gui-fig.cjs`，等宽图按**显示宽度**对齐、幂等；改 `docs/design/gui/design.md` 里的模态窗口示意走它，别手写空格）：

```bash
node tools/make-gui-fig.cjs               # 刷新 docs/design/gui/design.md 的界面示意
node tools/make-gui-fig.cjs --dry-run     # 只打印将写入的块，不落盘
```

各脚本支持 `--help`；`patch`/`verify` 支持 `--version <版本>` 指定字典版本、`--path <resources目录>` 显式指定安装目录（跨平台 / 自动探测失败时用）。脚本改动后至少跑一次 `node --check` 与 `--dry-run` 做验证。

## 架构

- **替换对象**：官方 Windows 3.6.x 安装目录 `%LOCALAPPDATA%\GitHubDesktop\app-<版本>\resources\app\` 下的 `main.js` 与 `renderer.js`——官方产物为**免打包裸目录**（无 `app.asar`，3.6.4 / 3.6.5 已实测；robotze/GithubDesktopZhTool 的 Mac/Linux 方案同样直接替换 `Resources/app` 下文件）。
- **工具链**（`scripts/`，Node.js 零依赖，仅内置模块）：
  - **顶层**（共享模块与入口）：
    - `common.js`：全部共享逻辑的 **SSOT**——安装目录定位与已安装版本枚举（`locateApp()` / `listInstalledVersions()` / `setTargetVersion()`）、「当前目标」解析（`resolveTarget()`：config 里指定的目录优先，否则自动探测；GUI 与 CLI 共用同一份，不各写一套）、版本读取、字典读取、备份与还原、字符串匹配器与逆向还原、替换对象清单（`TARGETS`：`main.js` / `renderer.js`，patch / restore / verify / scan / dict-auto 共用同一份，不各写一份字面量）、文案归一（`normalize()`：产物侧折叠转义与空白 + 忽略大小写，`scan` 与 `dict-groups` 同一口径）与生效键并集（`effectiveKeys()`）、数据根目录判定（`dataRoot()`）、补丁组记账（`setPatchGroups()` / `getPatchGroups()`，组名常量表 `PATCH_GROUPS`）、项目地址（`repoUrls()`，Gitee 网页地址 `GITEE_WEB`）。**位置固定、不可下移**：`REPO_ROOT = path.resolve(__dirname,'..')` 决定源码态的数据根，下沉一层会让字典与备份全部找错。
    - `net.js`：零依赖 HTTP(S) GET（文本 / JSON / 二进制），带超时、重定向与进度回调；非 2xx 抛可读错误。**自动走代理**（环境变量 → Windows 注册表 → macOS `scutil`；CONNECT 隧道自己实现，不引依赖），代理不可用时**回退直连**并记住。在线能力都走它，不引三方库。
    - `cli.js`：交互式中文菜单入口（`npm run tool`），职责与实现见下方「打包与分发」。
    - `update.js`：工具自更新——查 latest release → 按 `<平台>-<架构>` 后缀选资产 → 下载 → 校验文件头（MZ / Mach-O / ELF）与 `SHA256SUMS` 里的 sha256 → 改名替换自身 → 重启新版本；启动时 `cleanup()` 清理上次的 `.old` 残留。CLI 侧是替换自身；**GUI 侧是下载安装包交给用户装**（`pickGuiAsset()` 只认 `-gui-` 名字，Windows `-setup.exe` 直接 spawn、macOS `.dmg` 与 Linux `.deb` 交 `open` / `xdg-open`），两者命名与行为都不同、别混。
  - **`cmd/`**（面向安装目录的操作）：
    - `locate.js`：定位安装目录（三平台自动探测，Windows 取最新版本；探测失败时走 `--path`）→ 校验 `main.js`/`renderer.js`/`package.json` 存在 → 备份原文件到 `tmp/backup/<版本>/`（已备份则跳过）。
    - `patch.js`：版本一致性校验（字典目录名 ≠ 安装版本即拒绝，错配可能导致应用无法启动）→ 本地无该版本字典时联网取（`dict-sync.ensureDict`）→ 逐条整串替换（只在字符串字面量区间内、内容与键完全相等才替换；整模板键整段替换模板源码）→ 统计命中 → 写回前自动备份 → 完成后重启 GitHub Desktop。
    - `restore.js`：优先把 `tmp/backup/<版本>/` 下的官方原版复制回安装目录；**备份不存在时按字典逆向还原**（`common.reverseEntries` 生成「译文 → 原文」再走同一套替换逻辑）→ 完成后重启 GitHub Desktop。**字典条目被删除或修改后必须先 `restore` 再 `patch`**——`patch` 只替换命中的字面量，不会把已删条目的旧译文从产物里退出。
    - `verify.js`：版本一致性、字典条目在两个文件中的命中率（0 命中 = 两个文件均未出现）、补丁后 `node --check` 语法校验。
    - `scan.js`：**未翻译文案自查**——读安装目录 `renderer.js.map` 中的官方自有源码（`app/src/**`），提取界面文案候选（JSX 文本 + 字面量），与产物、字典对照后输出待补清单（产物侧忽略大小写与空白差异，因产物文案经 `sentenceCase` 处理）。字典迭代时先用它自查，别只依赖截图。
    - `restart.js`：关闭并重启 GitHub Desktop（原本未运行则不动，避免替用户多开窗口）——界面文本在应用启动时载入内存，不重启看不到效果。
    - `install-version.js`：**下载并铺开一个 GitHub Desktop 版本**（「切换版本」里本机没有的那些）。取官方 nupkg → 校验 sha256 → 解压 `lib/net45/*` 到 `<安装根>/app-<版本>/`。**不跑官方 Setup.exe**——那是 Squirrel 升级语义、会替换现有版本，与本工具「多版本并存」的模型冲突；解压出来的目录与官方安装逐项同形（实测对照 `app-3.6.6`）。**只支持 Windows**（官方不发 Linux 产物；macOS 的 `.app` 覆盖是另一套）。失败不留半个目录：先铺 `app-<版本>.part`、必需文件齐了才改名。`--from <本地包>` 是下载不通时的降级路径。
  - **`dict/`**（字典资产）：
    - `dict-sync.js`：字典在线同步——`ensureDict()` 仅在本地（外部 + 内嵌）都没有该版本字典时下载，`syncLatest()` 供菜单 `7) 同步字典` / GUI「关于」里的「同步字典」强制拉最新并覆盖；远程源按 `common.remoteDictUrls()` 顺序（raw → jsDelivr → Gitee raw）尝试，落盘前先 `JSON.parse` 校验、写 `.part` 再改名。
    - `release-assets.js`：官方产物按需提取——从 GitHub Release 资产用 HTTP Range 分段取 zip 中央目录与目标条目（`node:zlib` 解压，不下载整包，单个 zip 250~330 MB 只取需要的 app 目录），产出与真实安装目录同形（`<out>/app/…`），`scan` / `verify` / `dict-groups` 可 `--path <out>` 直接跑；CI 定时字典与人肉回填都靠它取官方原文。CLI：`list|fetch|latest`。它同时是「下载并安装某个版本」的底座：`listVersions()` 列官方**有产物的**正式版，`extractLocal()` 把下到本地的整包按前缀铺开（zip 解析仍是同一套，不另写一份）。
    - `dict-auto.js`：按官方新版本产物自动产出字典（CI 定时任务 `dict-auto.yml` 与人肉回填共用同一条链路）——以历史字典键为锚核对新产物形态（继承，零风险）→ JSX 侧新增候选走 AI 翻译（OpenAI 兼容协议）→ `dict-edit` 事务写入 → 组名推断 → 干跑校验（语法 + 命中率阈值）→ 出报告。候选口径（字面量侧噪声多、只收 JSX）、AI 翻译三点约定（思考强度与超时联动 / 原样返回不算未译 / 不覆盖已有译文）、`--on-exist=skip|diff|overwrite` 的取舍见 `docs/design/dict-v2/design.md` 第 5 节与 `docs/design/dict-v2/tasks.md` 第 6 组——**改动它之前先读**。
    - `dict-ai.js`：**AI 协议适配层**（OpenAI 兼容的 `chat/completions`）——把待译条目分批交给模型 → 逐条校验（占位符一致 / 非空 / 含汉字）→ 「原样返回」分流为无需翻译 → 批次整体失败时降级逐条重试，并把失败原因归并成可读文案。与字典领域零耦合（不认识字典、产物与分组），**只由 `dict-auto.js` 以字面量 require 引入**（`bundle.js` 靠静态扫描收集依赖）。
    - `dict-prompt.js`：发给翻译模型的**系统提示词**（`SYSTEM_PROMPT`）。它是**唯一来源**——`dict-auto.js` 调模型用它，GUI 的「翻译提示词」标签页经 IPC 原样展示同一份，两边不得各写一份副本（展示的必须是实际生效的那段）。内容是行为约束（输出契约 / 占位符规则 / 助记符位置），改一个字都可能让模型不再返回合法 JSON，**改动前先读 `docs/design/dict-v2/design.md` 第 5 节**。
  - **`inject/`**（注入块：改逻辑不改文案）：
    - `update-control.js`：更新管控补丁组——往 GitHub Desktop 的 main.js 注入两件事：禁止自动更新（`checkForUpdates` 直接返回）与没有对应字典就拦截更新（工具支持的上限低于当前版本不放行），可选注入「更新后自动汉化」（只有打包态有意义）。`mode=guard|off` 两种模式共用同一套注入块、切换等价于重新注入；注入点选在产物 IIFE 之外（那里 `require` 是原生的）。cli / GUI 两处开关，机制与取证见 `docs/design/dict-v2/tasks.md` 第 8 组。
    - `context-menu.js`：右键菜单汉化——文本输入框右键菜单的标签由 **Electron 运行时按 role 生成**（`build-context-menu.ts` 的 `getEditMenuItems()` 用 `Menu.buildFromTemplate([{ role: 'editMenu' }])` 取展开项），产物里只有 role 名、没有标签字面量，字典按字面量整串匹配、够不着。做法是往 main.js 注入一段**包装 `Menu.buildFromTemplate`** 的代码（锚点与 `update-control.js` 同一处，模板里出现 `role: 'editMenu'` 就按 role 把展开项 label 重打成英文标签），再由 `patch` 的**同一次字典替换**译成中文。本模块**只带英文原文、不带中文**——翻译资产仍只有字典一份；标签取 `build-default-menu.ts` 菜单栏 Edit 子菜单那一批（非 darwin 带 `&` 助记符、darwin 不带），字典未覆盖的（如 3.6.5 的 macos 段）保持英文原文，与原生标签同形。属 i18n 组、随 `patch` 自动生效，无独立开关。
- **界面层**（`gui/`，Electron 原生窗口，可选形态）：`main.js` 主进程（窗口生命周期 + IPC **注册清单**与各处理器共用的骨架——确认框 / 忙碌推送 / 当前目标解析 / 四处理器共用的「确认框 + notifyBusy + run」）、`ipc/<域>.js`（IPC 处理器按域分组：汉化还原 `patching.js` / 版本切换 `versions.js` / 更新 `updates.js` / 杂项 `misc.js`，各域直接 `require('../../scripts/…')` 调业务）、`preload.js`（`contextBridge` 暴露 `window.api`）、`index.html` / `renderer.js` / `style.css` 渲染层。**GUI 只做表现层**——替换 / 备份 / 还原规则没有第二份实现；渲染进程无 Node 能力（`contextIsolation` + `sandbox`），字典表格只读，**不存在字典写盘通道**。界面分四块：**工具栏**（汉化 / 还原 / 选择 / 更新管控 / 切换版本 / 刷新 / 关于）、**两个标签页**（「汉化字典」只读表格；「翻译提示词」原样展示 `dict-prompt.js` 那份）、**关于窗口**（工具版本 / 项目地址 / 国内镜像 / 许可证 / 数据目录 + 「检查更新」「同步字典」两个动作）、**切换版本窗口**（本机已安装版本列表，点一项即切换）。与 CLI 的分工与共用点：**检查更新只管工具自身**，字典同步独立成 `syncDict`（两处语义一致）；「切换版本」窗口与 CLI 的 `4) 安装位置 / 切换版本` 共用 `common.setTargetVersion()`，切换后默认注入「完全禁止自动更新」；`openUrl` 只收白名单键（`repo` / `mirror`），渲染进程给不出任意 URL。打包配置见 `electron-builder.yml`（`npm run dist`），构建期下载走 `.npmrc` 与 yml 里固化的镜像；产物体积有两道裁剪——`electronLanguages`（语言包只留中英）与 `afterPack` 钩子 `build/after-pack.js`（打包后删运行时组件），改动取舍见 docs/打包与分发.md。
- **字典组织**：`dictionaries/<版本>/zh-CN.json`，**formatVersion 2 的五段结构**——`common` / `windows` / `macos` / `linux` 四段放条目，`groups` 段放组归属，`_meta` 放元信息（`version` / `updated` / `notes` / `formatVersion`）。条目按「跨平台共有」与「平台专有」分段：`common` 对所有平台生效，平台段只对该平台生效（`linux` 段保持为空，官方无 Linux 产物；判定与理由见 `docs/design/dict-v2/design.md` 第 4 节）。**字典的唯一写入口是 `scripts/dict/dict-edit.js`**——增删改、分组、迁移一律走它（先校验再原子替换，校验不过原文件不动），别手工编辑 JSON、也别在别的脚本里直接 `writeFileSync`；组名由 `scripts/dict/dict-groups.js` 从 sourcemap 推断。三种键形态（普通键 / 整模板键 / 作用域键）与替换规则见 `dictionaries/README.md`。**条数有三个口径**：`loadDict(版本)` 只并 `common + 本平台段`（Windows 实测 1885），macOS 再加 `macos` 段的 233 条 = 2118，字典文件总条目同样是 2118——引用条数前先说清是哪个口径。
- **打包与分发**（`cli.js` / `tools/bundle.js` / `tools/build.js`，面向使用者的说明见 `docs/打包与分发.md`）：
  - `cli.js`：交互式中文菜单入口（无参数进菜单；带子命令则透传给对应脚本），`package.json` 的 `tool` 入口。菜单八项：汉化 / 还原 / 详细信息 / **安装位置与切换版本** / 检查更新（工具）/ 更新管控 / 同步字典 / 关于；**只输出结果**（命中多少处、是否重启），中间过程不出现在菜单里——子命令走 `quiet` 参数控制（命令行入口仍输出明细）。
  - `bundle.js`：零依赖 CJS 单文件打包器，把 `scripts/` 合成一个自包含 `.js`。**依赖靠静态 `require('...')` 字面量扫描收集**——新增依赖必须写成字面量（模板字符串 / 变量拼接收集不到）；JSON 模块转成 `module.exports = <JSON>`。
  - `build.js`：Node SEA 打包（`node --experimental-sea-config` 生成 blob → postject 注入 node 可执行文件副本），把**最新版本**的字典（`dictionaries/<最新>/zh-CN.json`）作为内嵌资源打进产物——更早版本用到时由 `dict-sync` 联网拉取；产出 `dist/` 下单文件；构建后自动跑一次 `--help` 自检。
  - **运行形态与数据根目录**：`common.dataRoot()` 是唯一来源，判据两条——`isPackaged()`（bundle / SEA 产物）与 `isElectronPackaged()`（Electron 打包产物，即 `isElectron() && !process.defaultApp`）。**源码态与 Electron 开发态**（`npm run gui`）= 仓库根；**SEA 产物与 Electron 打包产物** = 可执行文件所在目录（不可写时回退用户数据目录）。备份、`config.json`、`dictionaries/`、`tmp/` 全在数据根下。一个例外：**macOS 上的 Electron 产物**恒取用户数据目录——exe 在 `.app` 包的 `Contents/MacOS` 里，往包内写一个字节就会让签名失效、下次启动被 Gatekeeper 拒开。
  - **字典「外部优先、内嵌兜底」**：`<数据根>/dictionaries/<版本>/zh-CN.json` 存在则用它，否则取打包时内嵌的同名资源；都没有才联网下载（见下）。用户把字典目录放进数据根即可覆盖内嵌版本。Electron 产物没有内嵌资源（`node:sea` 不可用），字典随包放在应用的 `resources/dictionaries`，由 `gui/main.js` 的 `seedBundledDicts()` 首次运行时把数据根里缺的版本播种过去（只补缺失，不覆盖用户替换或在线更新过的字典）——macOS 与 Linux 的 AppImage 取不到「exe 旁」，靠的就是这一步。
  - **构建与发布（CI）**：`.github/workflows/build.yml` 用矩阵构建（`windows-latest` / `macos-latest`(arm64，原生出 arm64 产物、交叉条目 `macos-x64-cross` 出 x64 产物) / `ubuntu-latest`），**两个 job 并行出两类产物**——`build`（单文件可执行）与 `gui`（Electron 图形界面，配置见 `electron-builder.yml`），`release` 等两者都完成再发。手动触发只构建，推 `v*` tag 则构建后自动发 Release 并附 `SHA256SUMS`。发布前先校验 tag 与 `package.json` 版本一致，不一致直接失败，**改版本号时两者必须同步**。GUI job 在每平台构建后跑两道验证：`node tools/check-gui-dist.js` 静态自检（应用包结构 / 内置字典 / Windows 产物子系统 / 语言包裁剪是否生效 / 各产物体积打进日志，超 100 MB 打 `::warning::`），再跑**产物启动冒烟**——产物带 `--smoke-test` 真起一次，核对窗口尺寸 / 工具栏按钮数 / 标签页数 / 「翻译提示词」取到文本 / 「关于」能开 / 真实 IPC 往返——无参通道 + 带参通道的实参形态（判据与输出见 `gui/main.js`），**不带这个开关的行为与以前完全一致**。两道都过了才上传产物。**四个 runner 都没有 GPU**，正好打在「软渲染组件删掉后还有没有回退路径」这条风险链上。功能级实测（汉化 / 还原 / 字典同步）仍只能在本地做。**冒烟判据里依赖网络的那几项要把等待窗口留够**——官方版本列表在系统代理下实测约 6.4 秒，窗口给短了会渲染成 0 条、看着像功能坏了（取不到不判失败是另一条，等待时长必须够）。
  - **产物去处：Artifacts 是构建中转，Release 才是成品**——手动触发构建后产物留在该次运行的 **Artifacts** 里（单文件产物 `dist-<os>`、GUI 产物 `gui-<os>`），下载得到的是 **zip 压缩包**（GitHub 强制打包），解压后 macOS / Linux 产物可能**丢可执行位**，它只用来自己验证构建，别当成品发给使用者。推 tag 后 CI 建的 Release，附件是**原始文件**（不套 zip），附件名分 **cli / gui 两套**（规范见`docs/agents/发版.md`的「产物命名」），另附 `SHA256SUMS`——给使用者的下载链接一律指向 Release 附件。**v1.1.3 起产物全面瘦身、平台词 mac 侧改 `macos`**：单文件产物 mac / Linux 换 small-icu 自编译 node 基底（CI 从源码编译，`actions/cache` 缓存；官方 node 的 ICU 数据约 28 MB 是超限主因，本仓库零 Intl 使用），GUI 的 dmg 转 ULMO（LZMA）——产物全部进 Gitee 的 100 MB 附件上限（2026-09-23 CI 实测：cli 81.4～93.8 MB、gui 79.7～91.7 MB，无一超限）。GUI 产物体积（v1.1.3 实测：Windows 7z 81.2 MB / NSIS 安装包 90.8 MB、macOS dmg 79.7（arm64）/ 90.8（x64）MB、Linux AppImage 91.7 MB / deb 91.2 MB；裁剪见 `electron-builder.yml` 的 `electronLanguages` / `compression` 与 `build/after-pack.js`，数据与理由见 docs/打包与分发.md），四平台全上时 Release 附件合计 GB 级，属预期。
- **跨平台**：`--path` 可指向任意平台的 resources 目录；自动探测三平台都有候选根（`candidateRoots()`：Windows 为 `%LOCALAPPDATA%\GitHubDesktop` 下的版本目录，macOS 为 `/Applications` 与 `~/Applications` 下的 GitHub Desktop.app——另经 Spotlight（`mdfind` 按官方 bundle id）动态发现放在任意位置的 GitHub Desktop.app，Spotlight 不可用时静默退回标准位置，Linux 为 `/usr/lib/github-desktop` 等标准位置），多版本枚举与在线安装仅 Windows。手动指定同样做形态下探：`locateApp({ explicitPath })` 对显式路径依次尝试本体与其 `resources` 子层，GUI 选择对话框对 macOS 再补 `Contents/Resources` 一层——访达里 `.app` 就是一个图标，**选中 `GitHub Desktop.app` 本体即命中**是 mac 用户最自然的操作（v1.1.2 之前下探只有 Windows 形态、选中必报「无效的目录」，真实用户实测踩过）。打包产物只能在构建平台运行（Windows 构建 .exe、macOS 构建 Mach-O、Linux 构建 ELF）——基底是构建机上的 node 可执行文件（CI 上 mac / Linux 用 small-icu 自编译基底，本机默认官方 node，`tools/build.js --node` 可指定），macOS 还必须在 macOS 上注入与签名，**因此原则上没有交叉构建这条路**（受迫例外仅一处：mac x64 的自编译基底挪 arm64 机器交叉编译，见 docs/打包与分发.md「跨平台构建」的「受迫例外」段）。跨平台发布走 CI 矩阵（每个平台一个原生 runner），或在各平台各跑一次 `npm run build`。

### 在线能力（改这些代码前先读）

产物分发的现实是「旧产物遇到新版本 GitHub Desktop」，所以字典不能只靠内嵌。约定：

- **远程地址只有一处定义**：`common.js` 的 `GH_OWNER` / `GH_REPO` / `GH_BRANCH` 及其派生 `GH_RAW` / `GH_CDN` / `GH_API`——换仓库、换分支只改这里；字典地址由 `common.remoteDictUrls(version)` 拼，其余脚本不得自行拼 URL。
- **只在缺的时候联网**：`ensureDict()` 的顺序是「外部文件 → 内嵌资源 → 联网下载」，前两者命中就完全不碰网络（已有字典时离线完全可用）；只有用户主动点菜单 `7) 同步字典`（GUI 在「关于」里）才走 `syncLatest()` 强制覆盖。**联网失败不能静默降级**——报可读错误（列出尝试过的源）并拒绝汉化，绝不拿别的版本字典凑合。
- **零依赖**：HTTP(S) 只用 `node:https` / `node:http`（`net.js`）。不引三方库——产物是零依赖单文件，引入依赖会同时影响 `bundle.js` 的静态 `require` 收集与产物体积。
- **代理自动读系统配置**：`net.js` 的 `openStream()` 是全仓唯一的发请求入口，代理只在那处实现——环境变量（`HTTPS_PROXY` 等，`NO_PROXY` 排除）优先，其次 Windows 注册表 / macOS `scutil`；https 走自实现的 CONNECT 隧道（`tunnelAgent`）。**代理不可用时回退直连并记住**（记一次、在 stderr 说一次），一个配坏的代理不该让工具彻底断网。这不是锦上添花：本机实测直连 15 KB/s（下 293 MB 要 5 个多小时），同一份走代理 593 KB/s。**排查「代理没生效」时先看系统代理是否真的启用**——代理软件在监听 ≠ 系统代理已打开（注册表 `ProxyEnable=0` 时 `openStream()` 返回直连就是正确行为，实测踩过）。
- **下载内容先校验再落盘**：字典落盘前先 `JSON.parse`（避免把错误页 / 半截内容写成坏字典），并写 `.part` 再改名（原子落盘）；自更新下载的产物先校验**文件头**（MZ / Mach-O / ELF），再比对 Release 里 `SHA256SUMS` 的 sha256（`update.js` 的 `verifySha256()`，CLI 替换自身与 GUI 启动安装包共用），两道都过才继续。清单取不到就**跳过而不是拒绝更新**（清单是单独的附件，取不到的情形始终存在——第三方镜像、API 异常都可能是原因），文件头校验仍在。
- **资产下载地址一律取 `browser_download_url`**：GitHub 的资产对象里 `url` 是 **API 端点**（`api.github.com/…/releases/assets/<id>`），少了 `Accept: application/octet-stream` 只会回一份元数据 JSON（实测 HTTP 200 + `application/json`，正文以 `{"url":` 开头）——拿它当下载地址，下到的是几十 KB 的 JSON。`update.js` 的 `downloadUrl()` 是唯一归一入口，两个 pick 函数都过它；`pickSums()` 同样。这个坑让 **v0.1.1～v0.4.0 的自更新从来没装成过**（被文件头校验拦下，工具没被写坏，但也永远更新不了），修于 2026-09-20。
- **自更新替换策略**：Windows 不允许删除或覆盖**正在运行**的可执行文件，但允许改名——自身改名 `.old`、新文件改名到原位，任一步失败把旧文件改回来；新进程启动时 `update.cleanup()` 清 `.old`。源码态不支持自更新（提示用 `git pull`）。
- **重启而非静默**：汉化 / 还原后由 `restart.js` 重启 GitHub Desktop（原本未运行则只提示）——不重启看不到效果，这是使用者最容易误判「没生效」的点。

### 跨模块共用约定（改代码时别破坏）

- 版本号概念在 `dictionaries/` 目录名、`scripts/` 版本一致性校验、`docs/` 版本对应表三处出现，改版本组织方式时三处同步。
- 字典文件仅含「原文 → 中文」映射数据，不含任何脚本逻辑；脚本不得在字典外硬编码翻译。
- 「运行形态」判据只有 `common.js` 的两处：`isPackaged()`（bundle / SEA 产物）与 `isElectronPackaged()`（Electron 打包产物）——别在调用方另立一套判断。数据根目录只有 `common.dataRoot()` 一个来源——脚本不得自行拼 `__dirname` 或假定当前工作目录。面向用户的提示文案在打包态与源码态不同（打包态用户没有 npm），用 `isPackaged()` 分支——这类**文案**分支只出现在 CLI 侧（各脚本的 `main()`，以及 `update.apply()` 那条「源码态不支持自更新」；`cleanup()` / `applyUpdateControl()` 等处的 `isPackaged()` 只用于取值、不产出文案），GUI 走的是 `run()`（结果文案由 GUI 侧自备——`gui/ipc/<域>.js` 给 `notes`，`gui/renderer.js` 拼成文），所以 Electron 打包态下 `isPackaged()` 为假也不会让 GUI 用户看到 npm 提示。
- 远程仓库地址只有 `common.js` 的 `GH_*` 一处定义，联网统一走 `net.js`（见「在线能力」一节）；逆向还原的判据只有 `common.isReversible()` 一处定义，别在调用方各写一份。

## 提交规范

- 中文约定式提交：`<type>(<scope>): <一句话中文标题>`，type 取 feat / fix / chore / docs / refactor 等常规类别。
- 提交信息不带任何 `Co-Authored-By` 类署名。
- 只做本地提交，不自动 push / merge / 建 PR；显式 `git add <文件>`，禁止 `-A` / `.`。
- **仓库存在多条并行工作线**（i18n / update / gui 等各有会话在推进）：提交前先 `git log --oneline` 核当前 HEAD 与字典条目数，只 add 自己动过的文件，另一条线的改动一概不碰；发现 HEAD 被推进时按新 HEAD 口径重新量数（3.6.6 实测：他线加 `main.js\|Delete` 使条目数 +1）。
- **合回保持线性历史**：本仓库历史为纯线性（无合并提交），worktree 分支完成合回 main 用 `git rebase main` + `git merge --ff-only <分支>` 快进，不造合并提交。
- 仓库为开源仓库：文件内容不写绝对路径、机器名、凭据等敏感信息。
- **分支命名规范**：新建的本地开发分支按 `<type>/<内容>-<修改者>-<MMDD>` 命名，如 `fix/dictionaries-lldwb-0919`——`type` 限定与提交类型一致的词表（feat / fix / chore / docs / refactor 等），`内容` 用小写连字符短语概括改动主题，`修改者` 用 git 用户名，`时间` 用两位月两位日（MMDD）。`main` 分支与 `backup/` 类历史 / 备份分支不受此约束。
