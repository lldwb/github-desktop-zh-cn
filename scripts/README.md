# scripts/ — 补丁工具链（Node.js，零依赖）

字典驱动的汉化补丁工具链，入口见 `package.json` 的 `npm run locate / patch / restore / verify / scan / tool / build`，共享逻辑在 `common.js`（SSOT：安装目录定位、版本读取、字典读取、备份、字符串匹配器与逆向还原）。

## 脚本清单

### `scripts/`（顶层：共享模块与入口）

| 脚本 | 职责 | 状态 |
|------|------|------|
| `common.js` | 共享逻辑 **SSOT**：安装目录定位与已安装版本枚举（`locateApp()` / `listInstalledVersions()` / `setTargetVersion()`）、「当前目标」解析（`resolveTarget()`：config 里指定的目录优先，否则自动探测）、版本读取、字典读取、备份与还原、字符串匹配器与逆向还原、替换对象清单（`TARGETS`，patch / restore / verify / scan / dict-auto 共用一份）、文案归一（`normalize()`）与生效键并集（`effectiveKeys()`）、数据根目录判定（`dataRoot()`）、补丁组记账（`setPatchGroups()` / `getPatchGroups()`，组名常量表 `PATCH_GROUPS`）、项目地址（`repoUrls()`，Gitee 网页地址 `GITEE_WEB`）。脚本取路径只走它，别自行拼 `__dirname` | 已实现 |
| `net.js` | 零依赖 HTTP(S) GET（文本 / JSON / 二进制）：超时、重定向、进度回调；非 2xx 抛可读错误。**自动读系统代理**（环境变量 → Windows 注册表 → macOS `scutil`，自实现 CONNECT 隧道），代理不可用时回退直连并记住 | 已实现 |
| `cli.js` | 交互式中文菜单入口（SEA 产物的双击形态）：无参数进菜单（汉化 / 还原 / 详细信息 / 安装位置与切换版本 / 检查更新 / 更新管控 / 同步字典 / 关于），带子命令时透传给对应脚本 | 已实现 |
| `update.js` | 工具自更新：查 latest release → 按平台 / 架构选资产 → 下载 → 校验文件头与 `SHA256SUMS` → 改名替换自身 → 重启；启动时清理 `.old` 残留 | 已实现 |

### `scripts/cmd/`（面向 GitHub Desktop 安装目录的操作）

| 脚本 | 职责 | 状态 |
|------|------|------|
| `locate.js` | 定位安装目录（Windows 自动探测取最新版本；`--path` 手动指定跨平台），校验 `app/` 结构，备份原文件到 `tmp/backup/<版本>/` | 已实现 |
| `patch.js` | 校验字典版本与安装版本一致 → 本地无该版本字典时联网获取 → 按字典替换 `main.js` / `renderer.js` → 命中统计 → 写回（写回前自动备份）→ 重启 GitHub Desktop | 已实现 |
| `restore.js` | 有备份：把 `tmp/backup/<版本>/` 下的官方原版复制回安装目录；**没有备份：按字典逆向还原**（中文 → 英文）→ 重启 GitHub Desktop（字典有删改时先还原再重打） | 已实现 |
| `verify.js` | 校验版本一致性、字典条目命中率（两个文件均 0 命中才算缺失）、补丁后 JS 语法校验（`vm.Script` 只解析不执行） | 已实现 |
| `scan.js` | 未翻译文案自查：读安装目录 `renderer.js.map` 里的官方自有源码（`app/src/**`），提取界面文案候选并与产物、字典对照，输出待补清单 | 已实现 |
| `restart.js` | 关闭并重启 GitHub Desktop（原本未运行则不动）；汉化 / 还原后由它收尾 | 已实现 |
| `install-version.js` | 下载官方产物铺成一份可用的安装：取 nupkg → 校验 sha256 → 解压 `lib/net45/*` 到 `<安装根>/app-<版本>/`（**不跑官方 Setup.exe**——那是升级语义、会替换现有版本）。只支持 Windows；`--from <本地包>` 是下载不通时的降级路径 | 已实现 |

### `scripts/dict/`（字典资产工具链）

| 脚本 | 职责 | 状态 |
|------|------|------|
| `dict-edit.js` | 字典的**唯一写入口**——增删改、分组、迁移一律走它，子命令 `read` / `validate` / `query` / `apply` / `add` / `update` / `remove` / `set-group` / `move` / `merge` / `regroup` / `export-flat` / `migrate`；写入是事务式的（读原文 → 内存变更 → 校验 → 写 `.tmp` → 读回重校验 → 原子替换 → 写后复核），任一步失败原文件从未被改动 | 已实现 |
| `dict-groups.js` | 组名自动推断：读安装目录里官方产物自带 sourcemap 的 `app/src/**` sourcesContent 定位每段原文的出处，按三级规则定组（主菜单构建文件 → 「菜单-<父菜单>」；其余按源文件目录查 `DIR_GROUPS`；都落不上 → 「待分组」），产出写进字典 `groups` 段，写入经 `dict-edit` 事务入口 | 已实现 |
| `dict-auto.js` | 按官方新版本产物自动产出字典——以历史字典键为锚核对每条键在新产物里的形态（继承）→ 官方新增的界面文案走 AI 翻译（OpenAI 兼容协议）→ `dict-edit` 事务写入 → 组名推断 → 干跑校验（替换 + 语法 + 生效比例）→ 出报告；CI 定时任务与人肉回填共用同一条链路 | 已实现 |
| `dict-ai.js` | **AI 协议适配层**（OpenAI 兼容的 `chat/completions`）：待译条目分批交给模型 → 逐条校验（占位符一致 / 非空 / 含汉字）→ 「原样返回」判为无需翻译 → 批次整体失败时降级逐条重试并归并失败原因。与字典领域零耦合，**只由 `dict-auto.js` 以字面量 require 引入** | 已实现 |
| `dict-prompt.js` | 发给翻译模型的系统提示词（`SYSTEM_PROMPT`）——**唯一来源**：`dict-auto.js` 调模型用它，GUI 的「翻译提示词」标签页经 IPC 原样展示同一份（展示的必须是实际生效的那段） | 已实现 |
| `dict-sync.js` | 字典在线同步：`ensureDict()` 本地（外部 + 内嵌）都没有才下载；`syncLatest()` 强制拉最新并覆盖（菜单 `7) 同步字典` / GUI「关于」里的「同步字典」用） | 已实现 |
| `release-assets.js` | 从官方 Release 产物里按需取文件（HTTP Range 分段取 zip 中央目录与目标条目，`node:zlib` 解压，单个 zip 250~330 MB 不下载整包），产出与真实安装目录同形（`<out>/app/…`），`scan` / `verify` / `dict-groups` 可 `--path <out>` 直接跑；CLI：`list` / `fetch` / `latest` | 已实现 |

### `scripts/inject/`（注入块：改逻辑不改文案）

| 脚本 | 职责 | 状态 |
|------|------|------|
| `context-menu.js` | 右键菜单汉化——注入包装 `Menu.buildFromTemplate` 的代码，模板里出现 `role: 'editMenu'` 时按 role 把展开项 label 重打成**英文标签**（产物里于是有了字面量），再由**同一次字典替换**译成中文；**只带英文原文、不带中文**（翻译资产仍只有字典一份），随 `patch` 自动生效，无独立 CLI | 已实现 |
| `update-control.js` | 更新管控补丁组——往 main.js 注入「禁止自动更新」（`checkForUpdates` 直接返回）与「没有对应字典就拦截更新」，可选注入「更新后自动汉化」（只有打包态有意义）；`mode=guard\|off` 共用同一套注入块、切换等价于重新注入，注入点在产物 IIFE 之外，无独立 CLI | 已实现 |

### 已迁出 `scripts/`

| 脚本 | 现位置 | 职责 | 状态 |
|------|--------|------|------|
| `bundle.js` | `tools/bundle.js` | 零依赖 CJS 单文件打包器：把 `scripts/` 合成一个自包含 `.js`，供 `build.js` 打成单文件可执行 | 已实现 |
| `build.js` | `tools/build.js` | 打包成单文件可执行（Node SEA：bundle → blob → postject 注入，内嵌**最新版本**字典），产出 `dist/` 下产物并自动 `--help` 自检 | 已实现 |
| `changelog.js` | `tools/changelog.js` | 从 `CHANGELOG.md` 提取指定版本的段落（发版时作 Release 正文；本地可预览该版本的 Release 长什么样，提不到该版本时非 0 退出） | 已实现 |

## 用法

```bash
node scripts/cmd/locate.js   [--path <resources目录>] [--version <版本>]
node scripts/cmd/patch.js    [--dry-run] [--version <版本>] [--path <resources目录>]
node scripts/cmd/restore.js  [--version <版本>] [--path <resources目录>]
node scripts/cmd/verify.js   [--version <版本>] [--path <resources目录>]
node scripts/cmd/scan.js     [--out <文件>] [--min-length <n>] [--version <版本>] [--path <resources目录>]
node scripts/cli.js          # 交互式菜单（= npm run tool）
node tools/build.js          [--out <目录>] [--name <文件名>]   # 打包单文件可执行（= npm run build）
node tools/bundle.js         [--out <文件>]                    # 只生成单文件 JS（调试打包器用）
```

`net.js` / `dict-sync.js` / `update.js` / `restart.js` 是内部模块（无独立 CLI）：`patch` / `restore` 用前两者取字典与收尾重启，`cli.js` 的菜单 `7) 同步字典` 调 `dict-sync`、`5) 检查更新` 调 `update`。

## 实现要点

- **零依赖**：官方 3.6.x 产物为 `resources/app/` 裸目录（无 `app.asar`，3.6.4 / 3.6.5 实测），无需 `@electron/asar` 解包 / 重打包，仅用 Node 内置模块。
- **替换策略（整串匹配）**：替换只发生在字符串字面量区间内，且仅当区间内容与字典键**完全相等**时替换。既保护标识符 / 属性名 / 正则 / 注释（如 `new Error()` 的 `Error` 是标识符，整串匹配不会命中），也避免子串误伤（如协议串 `sessions.setAdditionalPlugins` 含 `Add`）。
- **两种键**：
  - **普通键**：匹配字符串字面量内容，或模板字符串的文本段（如 `` `Fetch ${t}` `` 的 `"Fetch "`）；
  - **整模板键**：以反引号开头结尾、含 `${}` 插值的完整模板源码，**整段替换**——用于运行时拼接的文案（复数后缀 `${xU(n)}`、由函数拼出的动词等）。值与键同为 JS 模板/字符串字面量，外层模板优先、其内部文本段不再单独替换。
- **作用域键**：`<文件名>.js|原文`（如 `renderer.js|en-US`）只对该文件生效——同一字面量在两个文件中语义不同时使用（`en-US` 在 renderer 是 `Intl.RelativeTimeFormat` 语言、在 main.js 是拼写检查语言判断）。键在应用前去掉前缀，统计与报告按去掉前缀后的键合并。
- **版本一致性**：字典目录名必须等于安装版本（`app/package.json` 的 `version` 字段），不一致直接拒绝，避免错配导致应用无法启动。
- **幂等**：对已汉化文件重复 `patch` 不会重复替换（英文原文已不存在），0 命中条目不告警。
- **安全边界**：写回前自动备份原文件到 `tmp/backup/<版本>/`，恢复官方版用 `restore.js`（`npm run restore`）；补丁后必须 `verify`（JS 语法校验 + 残留英文清单）。
- **没有备份时的还原（逆向还原）**：`common.reverseEntries()` 把字典翻成「译文 → 原文」再走同一套替换逻辑。三条判据：逆向键**就是译文原样**（产物里该区间的 `content` 恰等于译文本体，整模板条目含两侧反引号）；模板**整段区间**一律收集（否则含反引号的原文塞回文本段会提前闭合反引号、还原后语法错误）；译文必须**有辨识度**（`common.isReversible()`——含字母数字，或含非 ASCII 且不属于 `SHARED_PUNCT`，即英文排版同样会用的弯引号 / 破折号 / 省略号等），否则当键逆替换会误伤原版同名文本（实测 `"that " → " "` 让原版所有空格字面量变成 `"that "`）。同一译文对应多个原文时按「作用域键优先 → 更短原文优先 → 字典书写顺序」取候选，保证往返不漂移。
- **在线能力**：远程地址只有 `common.js` 的 `GH_*` 一处定义（raw 主源 + jsDelivr 兜底）；字典**只在本地（外部 + 内嵌）都没有时**才下载，用户主动「同步字典」才强制覆盖——已有字典时完全离线可用。下载内容先校验再落盘（字典 `JSON.parse`、产物校验文件头 MZ / Mach-O / ELF 并比对 Release 里 `SHA256SUMS` 的 sha256），字典写 `.part` 再改名。**取资产的下载地址一律用 `browser_download_url`**——GitHub 的 `url` 是 API 端点，不带 `Accept: application/octet-stream` 只回元数据 JSON（见 `update.js` 的 `downloadUrl()`）。
- **自更新替换策略**：Windows 不允许删除或覆盖**正在运行**的可执行文件，但允许改名——自身改名 `.old`、新文件改名到原位，任一步失败把旧文件改回来；新进程启动时 `update.cleanup()` 清残留。源码态不支持自更新（提示用 `git pull`）。
- **重启收尾**：汉化 / 还原后由 `restart.js` 重启 GitHub Desktop——界面文本在应用启动时载入内存，不重启看不到效果；原本未运行时只提示，不替用户多开窗口。
- **原地追加式——删改条目必须重打**：`patch` 只替换命中的字面量，**不会**把已删条目的旧译文从产物里退出。字典条目被删除或修改后，必须 `npm run restore` 还原官方原版、再 `npm run patch` 重打，否则产物里残留的失效译文会继续生效（曾出现：HTTP 头名 `Link` 被译成中文后，请求头校验抛 `non ISO-8859-1 code point`，Issues / PR 拉取全挂）。
- **预览**：`patch --dry-run` 输出命中统计与 0 命中条目，不写盘。
- **验证**：`verify` 对补丁后文件做 JS 语法校验（`vm.Script` 按脚本模式解析，只解析不执行；打包态下 `process.execPath` 是产物自身，不能再用 `node --check` 子进程）；已汉化状态下列出仍残留英文的条目，人工核对。
- **自查（scan）**：官方产物的 sourcemap 里含 GitHub Desktop 自有源码，`scan` 从中提取界面文案候选（JSX 文本节点 + 字符串字面量），再回到产物核对是否存在，排除字典已收录项后输出待补清单。产物侧按「忽略大小写 + 折叠空白」匹配——产物文案经 `sentenceCase` 处理（`Confirm discard changes`）、源码是 Title Case（`Confirm Discard Changes`），且 JSX 多行文本在产物里带转义换行与缩进。清单里仍会有专有名词、代码键名、句子片段等噪声，需人工判断。
- **运行形态与数据根目录**：判据只有 `common.js` 两处——`isPackaged()`（bundle 产物与 SEA 产物）与 `isElectronPackaged()`（Electron 打包产物）；`common.dataRoot()` 是唯一来源——**源码态与 Electron 开发态**（`npm run gui`）= 仓库根，**SEA 产物与 Electron 打包产物** = 可执行文件所在目录（不可写时回退用户数据目录）。备份、`config.json`、`tmp/` 全在数据根下，脚本不自行拼 `__dirname`、不假定当前工作目录。面向用户的提示文案按 `isPackaged()` 分支（打包态用户没有 npm）——这类分支只出现在各脚本的 `main()` 里，GUI 走 `run()`，Electron 打包态下不会弹出 npm 提示。
- **字典「外部优先、内嵌兜底」**：`<数据根>/dictionaries/<版本>/zh-CN.json` 存在则用它，否则取打包时内嵌的同名资源——单文件分发不丢字典，用户也能在数据根下放自定义字典覆盖内嵌版本。
- **打包态的环境差异（改脚本时注意）**：`process.execPath` 指向产物自身（不能当 node 用）；`tools/bundle.js` 复刻了 `require.main` 并指向入口 `cli.js`，因此子脚本的 `if (require.main === module) main()` 在打包态**不成立**——`cli.js` 透传子命令时显式调用脚本导出的 `main()`。打包器只收集静态 `require('...')` 字面量（模板字符串 / 变量拼接收集不到），JSON 模块会被转成 `module.exports = <JSON>`。**Electron 打包态（`npm run dist`）是另一套**：`__dirname` 落在 `resources/app.asar` 内（asar 内 `require` 正常），字典**不进 asar**——走 `electron-builder.yml` 的 `extraResources` 落到应用的 `resources/dictionaries`，再由 `gui/main.js` 的 `seedBundledDicts()` 首次运行时播种到数据根。**不能放 exe 同级**（`extraFiles`）：macOS 的数据根恒在用户数据目录、Linux 的 AppImage 挂在只读临时目录，两处都取不到旁边那份；`node:sea` 在 Electron 里也不可用。上面关于 `require.main` 复刻的说明只适用于 bundle / SEA 产物。
