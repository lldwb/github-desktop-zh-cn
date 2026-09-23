# Changelog

## [1.1.3] - 2026-09-23

> 产物全面瘦身：10 个产物（cli 4 + gui 6）全部压进 Gitee 单文件附件上限 100 MB，mac 侧平台词从内核词 darwin 改成使用者一眼可读的 macos（本次发版双名字过渡一版），Gitee 镜像开始随发行版传附件。构建侧把 mac x64 基底挪到 arm64 机器交叉编译，绕开 intel runner 的整机停摆。

### 新增

- **产物全面瘦身进 100 MB**：单文件产物 mac / Linux 换 small-icu 自编译 node 基底（CI 从源码编译、`actions/cache` 缓存；官方 node 的 ICU 数据约 28 MB，本仓库零 Intl 使用），GUI 根级 `compression: maximum`（AppImage 走 xz、dmg 转 ULMO/LZMA）、Windows 免安装包 zip 换 7z、语言包裁到中英两个、软渲染与 WebGPU 编译器按平台裁剪。CI 实测：cli 81.4～93.8 MB（Windows 83.6 / mac arm64 81.4 / mac x64 84.8 / Linux 93.8），gui 79.7～91.7 MB（Windows 7z 81.2 / setup 90.8、dmg 79.7 arm64 / 90.8 x64、AppImage 91.7 / deb 91.2）——v1.1.2 唯一超限的 macOS x64 dmg（102.5 MB）就此达标；体积随构建打进 CI 日志（`check-gui-dist`），超 100 MB 打 `::warning::`，不必下载附件。
- **平台词 mac 侧 darwin → macos**（v1.1.3 起）：SEA 产物名由 `tools/build.js` 的 `PLATFORM_WORD` 映射，GUI 靠 `electron-builder.yml` 的 `mac.artifactName` 固定；自更新 `scripts/update.js` 按「macos 优先、darwin 兜底」双词匹配，新版工具对两代名字的 Release 都更新得动。本次 Release 同时挂 macos 与 darwin 两份名字（release job 的 `TRANSITION_DARWIN_ALIASES`，SHA256SUMS 双名字各一行），v1.1.2 及更早的老工具也能更新；只过渡一版，下一版发版前关掉开关并删复制步骤。
- **Gitee 镜像开始传附件**：此前产物超 100 MB 只发正文，压缩后全部达标——CI 给最新版传全套产物 + SHA256SUMS，发新版时删旧版附件、旧版正文补上 GitHub 下载链接（1 GB 附件配额让给最新版）；darwin 过渡附件不进 Gitee。
- **mac x64 基底挪 arm64 机器交叉编译**（受迫例外：intel runner 随机整机静默停摆，上游 actions/runner-images#13882，看门狗救不了）：`CC/CXX` 钉 `-arch x86_64`——node 的 make 构建在 mac 上从不传 `-arch`，缺了编译器按 host 的 arm64 出码、编出 arm64 码冒名 x64 的废品；链接用经典链接器 `-ld_classic` 绕 nodejs/node#59553（新式链接器产物经 SEA 注入后 dyld 报 thread-local 超 4GB 起不来，Rosetta 下同样复现、产物自检判定有效）；缓存 key 按 matrix.name + 链接器区分；自编译基底加 `process.arch == x64` 硬校验，产物按基底架构取名不会错标。

### 变更

- `tools/build.js` 新增 `--node <可执行文件>` 指定产物基底（默认当前 node）；交叉构建不另做特殊命名，产物名架构词一律按基底查询。
- 文档口径同步：AGENTS.md（矩阵现状 / 体积实测 / 交叉构建受迫例外）、docs/打包与分发.md（Gitee 新口径、体积数字、检查清单、产物计数 13→10）、docs/agents/发版.md（产物命名、Gitee 段、产物计数）。

### 说明

- 构建与分发侧的工具链调整（自编译基底、压缩体系、产物命名、Gitee 附件策略、交叉编译），对使用者零行为变化——汉化 / 还原 / 字典逻辑未动，产物命名变更由自更新双词匹配兜底、历史字典与备份完全不受影响；按语义化分级规则取**小版本** 1.1.3。
- `package.json` 版本号 1.1.2 → 1.1.3

## [1.1.2] - 2026-09-21

> 接着 v1.1.1 把 macOS 安装目录识别修到底：GitHub Desktop.app 放在任意位置（桌面 / 下载 / 自定义目录）也能自动识别，不再要求先挪进「应用程序」。

### 修复

- **macOS 任意位置的 GitHub Desktop 自动识别**：`candidateRoots()` 的 darwin 分支此前只认 `/Applications` 与 `~/Applications` 两个标准位置——app 放在别处就没有候选根，自动探测枚举为空，只能手动 `--path`。现在 darwin 分支经 Spotlight（`mdfind` 按官方 bundle id `com.github.GitHubClient`）动态发现任意位置的 GitHub Desktop.app，拼 `Contents/Resources` 并入候选根，与标准位置去重（标准位置排前，多份并存时优先用「应用程序」里的正式安装）。`mdfind` 缺失、Spotlight 被禁用或超时（5 秒）一律静默跳过，退回标准位置候选与现有引导文案兜底；不缓存结果，GUI 每次刷新都能发现新装的应用。零依赖实现（`execFileSync`），按 bundle id 过滤不会把本工具自己误认成 GitHub Desktop。文档口径同步（AGENTS.md 与 README 旧表述仍是「macOS/Linux 走 `--path`」）。

### 说明

- 缺陷修复，按语义化分级规则取**小版本** 1.1.2。
- `package.json` 版本号 1.1.1 → 1.1.2

## [1.1.1] - 2026-09-21

> 修好 macOS 上识别不到安装目录的一类问题：未识别时的引导文案此前三个平台都给 Windows 形态的例子，GUI「选择」对话框里选中 GitHub Desktop.app 本体也报无效目录——mac 用户照着提示找不到、也选不中正确位置（使用者实测：把 GitHub Desktop 放入「应用程序」即可自动识别）。另把发版运维的两件工具固化进仓库并同步文档口径。

### 修复

- **macOS 识别不到安装目录的引导与选择下探按 .app 形态补齐**：官方 macOS 产物是免打包裸目录（`Contents/Resources/app/main.js`），校验逻辑本身没错——错在两处引导。其一，`locateApp` 的「未找到安装目录」文案不分平台，现在按平台给对应引导：macOS 提示「先放入『应用程序』文件夹（会自动识别）」并给 `/Applications/GitHub Desktop.app/Contents/Resources` 例子，Windows / Linux 维持原例；macOS 的自动探测只认「应用程序」与「~/应用程序」里的 GitHub Desktop，app 放在桌面等位置识别不到属预期。其二，GUI「选择」对话框的候选下探只有 `<选中>/resources`（Windows 形态），mac 用户最自然的「选中 GitHub Desktop.app 本体」必然落空——补上 `<选中>/Contents/Resources` 一层，选中 .app 即命中。文档口径同步修正：自动探测三平台标准位置都覆盖（AGENTS.md 与 README 原写的「仅支持 Windows」与实现不符——macOS / Linux 候选根自首个提交就实现了）。
- **`rel-check` 补 gui 产物后缀口径**：非 `.exe` 的 gui 附件（dmg / AppImage / deb）不再被误标 ✗。

### 新增

- **固化发版第 7 步驱动器 `tools/ops/update-e2e.cjs`**：spawn 产物实跑「检查更新 → 下载 → 替换 → 重启」，轮询 stdout 按输出喂 stdin（解决 printf 喂输入撞「readline was closed」的问题），退出码判成败；发版分册同步指向它。

### 变更

- 发版分册补呈现层版本号扫描与伪装旧版验证的步骤说明；README 与 AGENTS 的跨平台口径按实证修正。

### 说明

- 缺陷修复与文档 / 运维工具同步，按语义化分级规则取**小版本** 1.1.1。
- `package.json` 版本号 1.1.0 → 1.1.1

## [1.1.0] - 2026-09-21

> 这一版给工具加了「下载并安装本机没有的 GitHub Desktop 版本」的能力（CLI 菜单与 GUI「切换版本」窗口共用入口），网络层改为自动读系统代理（环境变量 → Windows 注册表 → macOS scutil，代理不可用回退直连），GUI 新增「关于」窗口、把「切换版本」改成按钮 + 弹窗列表，并让「检查更新」只管工具自身、字典同步独立成项。另修好按组还原时更新管控模式被静默降级、GUI IPC 三个带参通道把事件对象当业务参数用（K1）两个问题。内部做了几处收敛（cmd 公共逻辑上收 common、拆出 `dict-ai.js`、GUI IPC 处理器按域拆出、CI 探针联网收敛到 `lib.js`），测试补了 verify / patch / restore 编排层契约测试与冒烟带参通道判据。

### 新增

- **下载并安装本机没有的 GitHub Desktop 版本**（`scripts/cmd/install-version.js`，CLI 菜单「安装位置 / 切换版本」下新增 `d)` 入口，GUI「切换版本」窗口共用同一入口）：取官方 nupkg → 校验 sha256 → 解压 `lib/net45/*` → 铺到 `<安装根>/app-<版本>/`，装完即切过去。列表只列「有汉化字典、本机未装」的版本，且只在用户明确选 `d)` 时才联网取——进菜单这个动作本身不该等一次网络往返。**不跑官方 Setup.exe**——那是 Squirrel 升级语义、会替换现有版本，与本工具「多版本并存」的模型冲突；解压出来的目录与官方安装逐项同形（实测对照 `app-3.6.6`）。**只支持 Windows**（官方不发 Linux 产物；macOS 的 `.app` 覆盖是另一套）。失败不留半个目录：先铺 `app-<版本>.part`、必需文件齐了才改名。`--from <本地包>` 是下载不通时的降级路径。底座是 `release-assets.js` 扩展出的 `listVersions()`（列官方有产物的正式版）与 `extractLocal()`（把下到本地的整包按前缀铺开），zip 解析仍是同一套、不另写一份。
- **自动读系统代理**（`scripts/net.js`）：`openStream()` 是全仓唯一的发请求入口，现在按「环境变量（`HTTPS_PROXY` 等，`NO_PROXY` 排除）→ Windows 注册表 → macOS `scutil`」的顺序读系统代理，https 走自实现的 CONNECT 隧道（`tunnelAgent`），**代理不可用时回退直连并记住**（记一次、在 stderr 说一次）——一个配坏的代理不该让工具彻底断网。这是「直连 15 KB/s vs 走代理 593 KB/s」的本机实测差距背后的自动化解法：之前要手动设环境变量，现在装了系统代理的机器开箱即用。
- **GUI「关于」窗口与「切换版本」弹窗**：工具栏新增「关于」（工具版本 / 项目地址 / 国内镜像 / 许可证 / 数据目录 + 「检查更新」「同步字典」两个动作）；「切换版本」改成按钮 + 弹窗列表选择本机已安装版本。与 CLI 共用 `common.setTargetVersion()`，切换后默认注入「完全禁止自动更新」；「检查更新」只管工具自身、字典同步独立成 `syncDict`（CLI / GUI 两处语义一致）；`openUrl` 只收白名单键（`repo` / `mirror`）。「翻译提示词」标签页展示的 `dict-prompt.js` 独立成模块、成为唯一来源——GUI 展示与 `dict-auto` 调模型共用同一份。

### 变更

- **按组还原更新管控按记账模式重放**：`restore --group` 只撤其他组时，`updateControl` 组此前被固定按 `guard` 模式重放——以「完全禁止自动更新」（`--block-update`）打的补丁，撤一组无关的组后「完全禁止」会静默变回「没有字典就不更新」。现在 `setPatchGroups` 把实际注入模式随组记账（`updateControlMode`），重放改读 `getUpdateControlMode`，老账（无模式字段）按 `guard` 兜底、与原行为一致。记账往返 7 场景实测，`npm test` 142 用例全绿。
- **重构收敛**：cmd 公共逻辑上收 `common.js`、拆开 `patch` / `verify` 的长函数；`dict-ai.js` 独立成 AI 协议适配层、`dict-auto.js` 只留字典领域逻辑；GUI IPC 处理器按域拆到 `gui/ipc/`（`patching` / `versions` / `updates` / `misc`）；CI 探针联网收敛到 `tools/ops/lib.js`，产物命名回归并入 `npm test`；收口对抗性审查发现的死代码与规范问题。
- **文档重组**：`AGENTS.md` 拆出三份按需加载分册（`docs/agents/`：发版 / 翻译维护 / 已知坑），主文件只留每次都要遵守的规则；README 补充技术栈说明、优化目录与贡献指引、菜单示例去掉会随平台变动的字典条数；`docs/design/gui/design.md` 补「切换版本」弹窗示意（界面图生成脚本 `tools/make-gui-fig.cjs` 固化为仓库工具，按显示宽度对齐、幂等）；已知坑补条目（字典条数口径 / 冒烟等待窗口 / spawn 双通道 / CRLF 纪律等）。

### 修复

- **GUI IPC 包装剥离 invoke 事件对象，修复三个带参通道**（`gui/main.js`）：`ipcMain.handle` 的 listener 签名是 `(event, ...args)`，包装层未剥首参时带参处理器会把事件对象当业务参数用（实测 `openUrl` 回显「未知的地址：[object Object]」），而无参通道完全看不出来。现在包装层剥掉事件对象；`--smoke-test` 补「哨兵进去、哨兵回来」的带参通道实参形态判据作回归护栏（只认回显里有没有那个哨兵串，改报错文案不会误报）。
- **自更新 / 重启接住 spawn 的同步抛**：Windows 上「文件在、内容却不是有效可执行体」时 `spawn` 在调用处**同步**抛（`spawn UNKNOWN` / `EFTYPE`），此前只在异步 `error` 事件上兜——起不来时 GUI 把「安装包已下到哪、请手动打开」这条唯一能照做的补救信息抹掉、报成「检查工具版本失败」。三处调用点按「`try { spawn } catch {}` + `child.on('error', …)`」两件套补上。
- **`install-version` 未知参数改为报错**，与其他 cmd 脚本一致；`rel-check` 缺省 tag 改取最新 Release；`ci-status` 对限流等非数组响应恢复静默跳过；界面图生成脚本的仓库地址改取 `common.js` SSOT；删除 `restart.launch` 的无调用方导出。

### 说明

- 本次是**工具链与界面的中幅扩展**（新增脚本 + GUI 新窗口 + 在线能力增强），按语义化分级规则取**中版本** 1.1.0。
- `package.json` 版本号 1.0.0 → 1.1.0

## [1.0.0] - 2026-09-20

> 把整个仓库的文件结构按职责重排了一遍：`scripts/` 分 `cmd` / `dict` / `inject` 三层，构建与发布工具收进新的 `tools/`，`test/` 按被测模块归目录——**对外行为一处未变**（npm 命令、CLI 参数、模块导出面、GUI 的 IPC 契约逐项冻结后核对无意外）。字典侧清掉 36 条「不是界面文案」的条目（2154 → 2118）：被当成文案收进来的 CSS 类名会打掉 `renderer.css` 的规则、机器标识译掉会改行为，另清了 29 条早被整模板键接管的死键、恢复 `patch` 告警的信号价值。还修好一个**从 v0.1.1 起就没装成过**的缺陷——自更新下的是 GitHub 的 API 元数据 JSON 而不是产物（CLI 侧被文件头护栏拦下，GUI 侧会把 JSON 当安装包启动），并给下载物补了一道 `SHA256SUMS` 校验。

### 新增

- **自更新加 SHA256SUMS 校验**（`scripts/update.js` 的 `verifySha256()`）：CLI 替换自身与 GUI 启动安装包**共用同一条口径**，下载物按 Release 里的 `SHA256SUMS` 核对 sha256。它是**完整性**校验而非防篡改——清单与产物同源，能证明「下到的就是发布的那份」（半成品、错版本、被中间层改写都挡得住）；能改产物的对手也能改清单，那要靠签名，不在本工具的能力范围内。清单**取不到时跳过而不是拒绝更新**（Gitee 的发行版只发正文、不带附件），文件头校验仍在；清单在手却没有这个名字、或对不上，都中止。GUI 侧尤其需要它：CLI 有文件头护栏（MZ / Mach-O / ELF），而安装包形态不齐——dmg 的 `koly` 在文件末尾那 512 字节 trailer 里、deb 是 ar 归档、AppImage 是追加了 squashfs 的 ELF——魔数表既难写又不强，而校验和证明的是「同一份字节」，强一个量级。
- **GUI 不再假报更新成功**（`gui/main.js` 的 `installGuiUpdate`）：`child.on('error', () => {})` 把 spawn 失败吞掉后，紧接着无条件返回「已下载安装包并启动安装向导」——JSON 被当安装包启动时，用户看到的是「已启动安装向导」而屏幕上什么都没发生。现在**等 spawn 的结果出来再回话**：起不来就说清「文件在哪、请手动打开」，下载 / 校验失败同样如实说明（返回 `{ notes, hasError }`，两个调用点都按 `hasError` 走错误通道）。
- **测试夹具模块与约定**（`test/fixtures/scratch.js`）：收敛临时字典目录的隔离与清理。清理走 `disposableDir()` 门禁——算出的删除目标必须是 `dictionaries/` 的直接子目录、且名字**不是真实版本形态**（判据复用生产侧 `common.DICT_VERSION_RE`，不另写正则），挡住误传即毁数据的杀伤半径：`cleanup('3.6.6')`（指向真实字典）、`cleanup('')`（指向整个 `dictionaries/`）、`cleanup('..')`（指向仓库根）三者都被拒。本模块无顶层副作用。

### 变更

- **全项目文件结构按职责重排**（57 个文件）：`scripts/` 分三层——`cmd/`（6 个入口：locate / patch / restore / verify / scan / restart）、`dict/`（5 个：dict-edit / dict-groups / dict-auto / dict-sync / release-assets）、`inject/`（2 个补丁组）；新增 `tools/` 收拢构建与发布工具（`build.js` / `bundle.js` / `changelog.js` / `check-gui-dist.js`），CI 探针归 `tools/ops/`，`build/` 只留 electron-builder 钩子；`test/` 按被测模块归 `common/` / `dict/` / `inject/`；历史设计文档归 `docs/design/`。**对外行为一处未变**——npm 命令与 CLI 参数全部保留，13 个入口的 `--help` 归一化后逐字节一致；模块导出面、GUI 的 IPC 契约（handle 8 / push 2 / preload 10 / invoke 8 / on 2）、四版字典、`electron-builder.yml` 的 10 个配置键、零依赖，逐项冻结后核对**无意外差异**。路径引用残留检查**意外 0**（终版 65 处命中全部是已登记的白名单项，如历史设计文档正文里的说明性引用）。验收：`npm test` 112 / 0、`node --check` 46 文件 0 失败、相对 require 87 条零悬空、移动配对「旧文件消失 0」。

### 修复

- **字典删掉 36 条「不是界面文案」的条目**（2154 → 2118，`dictionaries/3.6.6/zh-CN.json`）：这批条目是分批查出来的，每批都先做命中上下文分类，再用「大写版是否已在字典里承担可见文案」交叉验证。① **CSS 类名**——`"description"` 在 renderer.js 的 22 处里 21 处是 `className:"description"`（含历史列表条目里承载头像与作者行的那层），替换后类名成 `className:"描述"`，`renderer.css` 的 `.description` 规则不再命中、flex 布局与行距全部失效，**这就是「历史的样式被修改」的来源**；`"archived"` 同理（可见文案另有 `"Archived"` → 「已归档」，这条属重复且译法不一致）。查法是把 `renderer.css` 的 1028 个类名与字典键求交，只有这两条命中。② **属性值与库内部 token**——`"difference"`（仅 1 处，`mixBlendMode:"difference"`，替换后取值非法、混合模式失效）、`"formatting"`（30 处里 29 处是 date-fns / CLDR 的 `context:"formatting"` 选项，只在库内部流转）。③ **操作名插值的空格与硬译**——整模板键 `Begin ${…}` / `Confirm abort ${…}` / `Resolving conflicts for ${…}` 的译文保留了插值两侧的空格，而操作名已是中文，于是标题渲染成「开始 变基」；分支下拉的状态行 `'Rebasing branch'` 硬译成「正在变基分支」；变基文案的两处尾随空格（`"Rebasing "`）与冲突横幅前缀（`"rebasing"` → 「变基到」）一并修正，让变基与同族的压缩 / 重排 / 摘取四条流程的文案一致。④ **死键**——清掉 29 条**被整模板键接管的片段键**（早期按片段收词如 `"Fetch the latest changes from "`，后来改用整模板键覆盖外层模板；匹配是逐字面量整串相等、同起点长的优先，片段键从此不再参与替换），它们让 `npm run patch` 每次都报「0 命中的条目」且逐批累积，**真正失效的条目就被淹没**；清理前后 `main.js` / `renderer.js` 的 md5 完全一致，证明这 29 条确实从未参与替换。另回退 `"renderer.js|Abort"`——它命中 Dexie 的 errnames 数组（经 `t+"Error"` 拼接后既当错误类名又当查表键 `$M[e.name]`，译掉会让错误对象的 `name` 变中文），代价是 `cancelButtonText:"Abort"` 那个取消按钮回到英文，遵循仓库既有规则「机器标识不译，宁可留英文」。
- **自更新下的是 API 元数据 JSON——从 v0.1.1 起就没装成过**（`scripts/update.js`）：`pickAsset` / `pickGuiAsset` 挑中附件后，`url` 字段一直是 GitHub 的 **API 端点**（`api.github.com/repos/<owner>/<repo>/releases/assets/<id>`），那个端点少了 `Accept: application/octet-stream` 只回一份**资产元数据 JSON**（实测 HTTP 200 + `application/json`）。于是自更新把几十 KB 的 JSON 当产物下了下来——CLI 侧被 `verifyExecutable` 的文件头校验拦下（护栏有效、工具没被写坏，但更新**从来没装成过**），GUI 侧没有那道校验，会把 JSON 当安装包启动。现在两个 pick 函数统一把 `url` 归一成 **`browser_download_url`**（发布页上那条直链；Gitee 的资产对象只有它、本来就走的这条路），取不到直链的极端形态仍退回 API 端点并补上那个 accept 头兜底。真机取证：伪装成 v0.3.0 使用者整条跑通「检查更新 → 下载 → 文件头校验 → 改名替换自身 → 重启」，替换后的文件与官方 v0.4.0 的 win32-x64 附件**逐字节相同**，新进程启动时把 `.old` 残留清掉了。
- **字典版本目录按三段数字形态过滤**（`scripts/common.js` 的 `DICT_VERSION_RE`）：`listDictVersions()` 与 `build.js` 的 `collectAssets()` 原先只判「是目录且有 `zh-CN.json`」，测试夹具 `0.0.0-test`、下载残留 `3.6.6-beta`、临时解包目录都会被当成真实字典版本。后果不是理论的——`compareVersions` 把非数字段按 0 处理，首段数字更高的残留（如 `9.9.9-x`）会排到真实版本之后，而 `build.js` 取排序后**最后一个**当内嵌字典，就会把错版本打进产物。现在由生产侧导出 `/^\d+\.\d+\.\d+$/` 作为 SSOT，两处复用同一判据（测试侧引用而非另写）。
- **产物自检清单漏了 `scripts/net.js`**（`tools/check-gui-dist.js`）：`net.js` 与同级的 `common.js` 一样是被多个脚本依赖的共享模块（`patch` 联网取字典、`update` 下载自更新都经过它），原先未列进 `need` 数组，asar 内容检查漏了这一条。该缺口在重构前即存在、非某次改动引入，作为独立修复单列以便单独回滚。
- **字典与新生成器文案里的旧路径**（`scripts/dict/dict-auto.js` + 3 版字典的 `_meta.notes`）：目录重排后 `scripts/dict-auto.js` 已不存在，而生成器会把这句来源标注写进**此后每一版新字典**——不改则每新增一版就多一处陈旧路径引用。既有 3.6.0 / 3.6.4 / 3.6.6 三版一并回写（3.6.5 的 notes 是手写的「首个版本字典：…」、本就不含路径，不动），走**唯一写入口** `dict-edit apply <版本> --ops <文件>`（ops 为 `[{"op":"setMeta","notes":…}]`）而非手工编辑 JSON；`_meta.updated` 有意不动把 diff 压到最小，改前改后 `validate` 逐条一致、条目数与组数不变。

### 说明

- 本次是**结构性改造**（57 个文件按职责重排，文档与 CI 里的脚本引用整体改写），按语义化分级规则取**大版本** 1.0.0。
- 目录重排后**仓库里所有脚本路径都变了**（如 `scripts/patch.js` → `scripts/cmd/patch.js`、`scripts/build.js` → `tools/build.js`）。npm 命令与 CLI 参数不受影响、照旧可用；仓库外的引用请按新路径更新，新旧对照表见 `docs/README.md`。
- 一次踩到的坑记在这里：`dict-edit` 的 `serialize()` **一律写 LF**，而 `dictionaries/3.6.0`、`3.6.4` 的工作区检出形态是 CRLF。写入后已手工转回 CRLF 恢复原形态，**转回前后两次 `git diff --stat` 完全相同**——行尾形态不参与 blob 比对（`core.autocrlf=true` 且无 `.gitattributes`，blob 层面全部为 LF）。
- `package.json` 版本号 0.4.0 → 1.0.0

## [0.4.0] - 2026-09-20

> 把界面最后一处常年英文的地方——**文本框的右键菜单**——也汉化了：那批标签由 Electron 按 `role` 在运行时生成，字典的字面量匹配够不着，于是往产物里**注入**一段代码先把英文原文造进产物，再由**同一次字典替换**译掉。GUI 产物这边接着瘦身（运行时裁剪 + 压缩拉满 + 免安装包改 7z + mac 只发 dmg），**六个产物里五个已进 Gitee 的 100 MB 附件上限**，并给产物加了启动冒烟护栏；自动更新挑错产物（挑中 zip / 7z 这类非可执行文件）的毛病修掉。

### 新增

- **右键菜单汉化**（`scripts/context-menu.js`，属 `i18n` 组）：文本框（分支筛选、提交摘要那些输入框）右键弹出的 `Undo / Redo / Cut / Copy / Paste / Delete / Select All` 一直是英文。**不是字典漏收，是字典机制够不着**——`build-context-menu.ts` 的 `getEditMenuItems()` 用 `Menu.buildFromTemplate([{ role: 'editMenu' }])` 取展开项，标签由 Electron 在运行时按 role 硬编码生成，官方 `main.js` 里 `Delete` 这个字面量 **0 处**（`scan` 也扫不出来）。做法是注入一段包装 `Menu.buildFromTemplate` 的代码（锚点与 `update-control.js` 同一处，落在产物 IIFE **之外**）：模板里出现 `role: 'editMenu'` 就把展开项 label 按 role 重打成英文原文，再由 `patch` 的**同一次字典替换**译成中文——注入块**只带英文、不带中文**，翻译资产仍只有字典那唯一一份。标签取 `build-default-menu.ts` 菜单栏「编辑」子菜单那一批（非 darwin 带 `&` 助记符、darwin 不带），字典没覆盖的保持英文原样；`patch` 把这类命中单独计数（`其中右键菜单标签 N 处`），`verify` 报注入块与字典覆盖状态。10 条单测，含「`vm` 里用假 Electron 真跑注入块展开菜单」与「块内除标签外的字面量不与任何版本字典的键相撞」。
- **产物启动冒烟护栏**（`gui/main.js` 的 `--smoke-test`，CI 四平台各跑一次）：静态自检看不出「删掉的运行时组件是不是启动必需」，于是让产物自己起一次——核对窗口内容区尺寸、界面按钮数与一次**真实 IPC 往返**，打印 `SMOKE_OK` 且退出码 0 才算过，冒烟不过就不上传产物。**四个 runner 都没有 GPU**，这轮冒烟同时是「软渲染组件删掉后还有没有回退路径」的验证（输出里带 GPU 合成 / WebGL / Vulkan 状态，裁剪前后可直接对照）。不带这个开关时行为与从前完全一致。

### 变更

- **GUI 产物体积：运行时裁剪 + 压缩拉满 + 换打包形态**（`electron-builder.yml` + `build/after-pack.js`）：三平台各删各的软渲染与 WebGPU 编译器（Windows 的 `vk_swiftshader.dll` / `dxcompiler.dll`、macOS 的 `libvk_swiftshader.dylib`、Linux 的 `libvk_swiftshader.so`），语言包只留中英两个；`compression` 显式拉满（不设时 AppImage 落在 mksquashfs 的默认 gzip、比同内容的 deb 胖 24 MB，dmg 落在 UDZO/zlib 上）；Windows 免安装包由 zip 改 **7z**（zip 受 deflate 硬限制，同一份内容 7z 81.2 MB、zip 123.6 MB），macOS **只发 dmg、不再出 zip**（两者装的是同一份 `.app`，zip 那份纯属重复附件）。四平台实测（裁剪后）：Windows 7z **81.2 MB** / NSIS 安装包 **90.8 MB**、macOS dmg **95.9**（arm64）/ **102.5**（x64）MB、Linux AppImage **91.6 MB** / deb **91.1 MB**——**六个产物里五个已在 Gitee 附件上限内**，只剩 macOS x64 的 dmg 超 2.5 MB。逐项压测的结论是「**Electron 这条路已经到底**」：主程序一个文件占整包 83%、`resources.pak` 占 15% 且几乎压不动，两者合计 98%；两条反直觉的实测——`LICENSES.chromium.html` 未压缩 20.5 MB 但 xz 后只剩 0.19 MB（删了不合规、还省不下 0.2 MB），`d3dcompiler_47.dll` **删不得**（删掉后本机冒烟仍 `SMOKE_OK`，但 GPU 合成从 `enabled` 掉到 `disabled_software`、硬件加速失效，而这类退化 CI 测不出来）。再降一个量级只能换运行时基底（Tauri / Wails 那类系统 WebView 形态），留待下次重构评估。
- **字典自动产出回填历史版本**：`dict-auto` 链路此前只在 3.6.5 / 3.6.6 上跑过，这次把 **3.6.0 / 3.6.4** 也各跑一遍（CI 定时任务与人肉回填共用同一条链路），四个版本齐了。
- **Gitee 发版只发正文、不传附件**（`.github/workflows/build.yml`）：Gitee 的附件配额（单文件 100 MB、单仓库合计 1 GB）放不下这些产物，正文里那段指向 GitHub Release 的下载指引就是唯一的下载入口；缺 `GITEE_TOKEN` 打 `::warning::` 后跳过，不阻断发布。
- **文档**：`AGENTS.md` 补分支命名规范（`<type>/<内容>-<修改者>-<MMDD>`）与 CI 首跑失败的教训、合并约定；`docs/打包与分发.md` 同步裁剪与冒烟的四平台实测数字与「还能再压吗」的结论；`dictionaries/README.md` 与 `.claude/skills/translation-maintain/` 补「产物里到底有没有这个字面量」这道零步检查与右键菜单一类的收录判据。

### 修复

- **自动更新会挑中 zip / 7z 这类非可执行产物**（`scripts/update.js`）：挑附件只看平台与架构词，于是发布页里同一套命名规则下的压缩包可能被选中，下载下来替换自身只会把工具弄坏。现在**按平台后缀收口**——Windows 只认 `.exe`、macOS / Linux 认 `.bin`（无后缀的老产物仍认，免得还留在旧版本上的使用者更新时找不到附件）；GUI 侧另有一套只认名字里带 `-gui-` 的，且 Windows 只认 `-setup.exe`、macOS 只认 `.dmg`、Linux 认 `.AppImage` / `.deb`（免安装包 7z 不是可执行文件，挑中它只会让更新失败；它仍随 Release 分发，手动解压即可）。
- **AI 配置错在发请求前就拦下**（`scripts/dict-auto.js`）：配错 `AI_BASE_URL` 的失败形态是「未译 11/11 条（100%）超过上限 30%」整版被门槛拦下，结论离原因很远。现在发请求前按 URL 语法再校验一次，并拦下**看不见的字符**——不换行空格、零宽空格、串内空格（语法上过得去，只是请求会打到别的路径上 404，报错里给出码点）；失败原因随结论一并外露（注解 / step summary / 提交信息三处），脱敏 needle **补上主机名**（网络层报错只带 host，漏了它脱敏就落空）。
- **右键菜单单测会被并行跑的夹具撞红**（`test/context-menu.test.js`）：`dictVersions()` 把 `dictionaries/` 下任何带 `zh-CN.json` 的目录都当成一个版本，而 `dict-edit` 的临时夹具 `0.0.0-test` 正落在同一目录里；`node --test` 并行跑各测试文件，夹具存在的那几百毫秒里被读到——夹具加载得到、只是没有右键菜单标签，断言必然红。谁挂谁绿全看 runner 的并行调度：同一个提交在 windows-latest / macos-latest 上绿、ubuntu-latest / macos-15-intel 上红。现在按目录名形态过滤，只认 `x.y.z`。
- **CI 测试日志里的假 `::warning::`**（`test/dict-auto.test.js`）：单测里 `console.warn` 打出的行只要以 `::warning::` 开头，就会被 Actions 认成一条真注解收进日志，读日志的人以为 Secret 配错了。现在截获并断言，不直接打。

### 说明

- 本次新增脚本（`context-menu.js`）并调整 GUI 打包形态（压缩级别、7z、语言包裁剪），属工具链变更，故取**中版本** 0.4.0。
- 注入块里的 **role 名不得写成字面量**：写成带引号的 JSON 键就落进字典的匹配范围，哪天字典收了 `copy` / `delete` 这样的键就会被译掉、查表静默落空。故把角色名整体塞进一个字符串再 `JSON.parse`，单测有断言钉住。
- 四个版本的字典各加一条作用域键 `main.js|Delete`（3.6.6 总键 2153 → 2154）：官方 `main.js` 里 `Delete` 字面量 0 处，它只匹配注入块里的标签；`renderer.js` 那 9 处（键盘映射表）靠作用域隔离，不受影响。
- 真机取证：干跑合计 **2406** 处（`main.js` 128，其中右键菜单标签 7 处 + `renderer.js` 2278）与实际 `patch` 命中完全一致；落地复查用**真实 Electron 44.4.1** 跑安装目录里已打补丁产物的注入块，展开项标签为 `["&撤销","&重做","","剪&切","&复制","&粘贴","删除","","全&选"]`，应用菜单栏自带 label 未被动。
- `package.json` 版本号 0.3.0 → 0.4.0

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
- **Gitee 镜像发版**（`.github/workflows/build.yml`）：Gitee 的仓库镜像只同步 commit / 分支 / tag，**发行版不在同步范围内**——`release` job 末尾新增「发布到 Gitee」步骤：按 tag 探测 → 没有就创建，正文取 CHANGELOG 段落并**追加一段指向 GitHub Release 的下载指引**。**只发正文、不传附件**：Gitee 的配额放不下这些产物——附件**单文件上限 100 MB**（13 个产物里 10 个是 106～146 MB，实测传 125 MB 的被拒「文件大小已超出限制：100 MB」）、**单仓库附件总容量 1 GB**（产物合计 1.38 GB），两项在 SaaS 各档位都一样（企业版单文件同样是 100 MB），只有私有化部署才提供定制配额；所以 Gitee 侧没有产物，**正文里那段链接就是唯一的下载入口**。两个 Gitee 特有的坑都已在代码里绕开：按 tag 查发行版时**用 `200` + 字面量 `null` 表示不存在**（不是 404，照搬 GitHub 的判据会把「不存在」读成「查询失败」）、创建后返回的对象**没有 `html_url`**（按 tag 自己拼）。**缺 `GITEE_TOKEN` 不阻断发布**——`check-version` 打一条 `::warning::`、那一步直接跳过，Gitee 是镜像渠道，不该让它挡住权威源；该步骤失败**只让 job 标红，已发布的 GitHub Release 原样保留**。
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
