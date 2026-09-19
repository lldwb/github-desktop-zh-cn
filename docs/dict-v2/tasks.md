# 字典 2.0（结构化 / 跨平台 / 自动化） · 任务清单

> 完成一项**立即**改为 `- [x]`；收尾前核对无未勾选项。方案与取舍见 `design.md`，验收口径见 `proposal.md`。

## 1. 字典格式与写入口（自底向上第一层）

- [x] `scripts/common.js`：新增 `PLATFORM_SEGMENTS` / `SEGMENT_NAMES` 与 `currentPlatform()`（`process.platform` → 段名），作为段名的 SSOT
- [x] `scripts/common.js`：`buildEntries(raw, version, platform)` 支持 `formatVersion === 2`（合并 `common` ∪ 平台段），旧扁平格式按原逻辑回退；键在段间重复时报错而非静默覆盖
- [x] `scripts/common.js`：`loadDict(version, platform)` 透传平台参数
- [x] `test/dict-scope.test.js`：补新格式用例（分段合并、未知平台只取 common、旧格式回退、段间重复键报错、段落缺失、作用域前缀的整模板键校验），`npm test` **21/21 全绿**
- [x] `scripts/dict-edit.js`（新增）：`read` / `query` 两个只读方法，`read` 返回五段结构
- [x] `scripts/dict-edit.js`：`validate(version)` 实现 `design.md` 的 8 条 error + 2 条 warning，返回 `{ errors, warnings }`，`Problem` 结构为 `{ level, code, key?, detail }`
- [x] `scripts/dict-edit.js`：事务写入（读原文 → 内存变更 → 校验 → 写 `.tmp` → 读回重校验 → `renameSync` → 写后复核），任一步失败删 `.tmp` 且原文件字节不变、抛出带 `problems` 的 Error
- [x] `scripts/dict-edit.js`：`apply(version, ops, { dryRun })` 与便捷方法 `add` / `update` / `remove` / `setGroup` / `moveTo` / `mergeIn` / `exportFlat` / `migrate`
- [x] `test/dict-edit.test.js`（新增）：覆盖正常写入、validate 各类 error、**破坏校验的批量修改后原文件逐字节不变**、错误含具体原因，`npm test` **45/45 全绿**
- [x] `scripts/cli.js`：`RUNNERS` 加 `dict` 子命令并在 `printHelp` 列出

## 2. 迁移 3.6.6 字典 + 行为对拍

- [x] 迁移前记录基线：对当前 Windows 安装目录跑 `npm run patch --dry-run`，保存命中数与键集合
      ——安装目录当时已是汉化态，改用备份里的官方原文做纯内存对拍（`tmp/dict-migrate-diff.cjs`），证据更强且不扰动环境
- [x] `dict-edit migrate` 把 `dictionaries/3.6.6/zh-CN.json` 转成 formatVersion 2（作用域键原样保留、条目进 `common` 段——见 design.md 的迁移归属说明）
- [x] 对拍：迁移后重跑 `patch --dry-run`，命中数与键集合与基线**完全一致**；**替换后的完整内容 sha256 逐字节一致**（main.js 121 处 / renderer.js 2141 处）
- [x] `npm run verify` 通过（1851 条生效键，残留 1 条 "GitHub Copilot" 为已知专有名词）；GUI 表格数据源逐行完全相同（1867 行、类型列分布一致）

## 3. 组名自动推断

- [x] `scripts/dict-groups.js`（新增）：从安装目录 sourcemap 建"键 → 来源文件"索引（沿用 `scan.js` 的折叠空白 + 忽略大小写口径）
      ——产物侧索引直接用字典键本身建（安装目录此刻已是汉化态，从它提英文字面量提不到东西）；780 个自有源文件（main 59 + renderer 721）的 `sourcesContent` 无缺失
- [x] `scripts/dict-groups.js`：按 `design.md` 的三级规则推断组名（菜单项 → 按源文件路径归类 → `待分组`），产出 `groups` 段
      ——写入 45 组；**按目录定位 1398 条，落「待分组」363 条**（含 137 条整模板键——插值变量名在构建时被重命名，源码对不上，`scan.js` 同样跳过）；守恒校验：1867 条全覆盖、0 重复、0 漏掉
- [x] 接入 `dict-edit setGroup` / 单独的 `regroup` 操作，写入后过 `validate`（groups 引用完整性为 error）
      ——`dict-groups.js` 经 `dictEdit.regroup()` 单一路径写入，写入后 `dict validate 3.6.6` → 0 错误 1 提示（提示为已知专有名词 "GitHub Copilot"）
- [x] 抽样核对 ≥ 10 条菜单条目的组名为 `菜单-<父菜单>` 形式（验收标准 4）
      ——**逐条核对 73 条菜单条目全部正确**：菜单-文件 7（`&File`/`E&xit`/`New &repository…`）、菜单-编辑 12（`&Undo`/`Cu&t`/`&Find`）、菜单-视图 17（`&Reload`/`Expand active resizable`——该菜单确有此两项）、菜单-仓库 16（`&Fetch`/`New work&tree…`）、菜单-分支 15（`&Merge into current branch…`/`&Rename…`）、菜单-帮助 6（`&About GitHub Desktop`——已核实源码行 604 在 Help 菜单内，行 75 无 `&` 的那条才属 macOS 应用菜单）；另有 37 条未定位到父菜单的菜单项落泛「菜单」组
- [x] `test/dict-groups.test.js`（新增）：钉住 `parseMenuLabels` 的每条解析路径（三级传播、别名 push、`__DARWIN__` 三元、声明后置不按位置归属、写法不认识时退化为空表）与 `groupOfFile` 的最长前缀规则，`npm test` **51/51 全绿**
- [x] 回归对拍：`tmp/dict-migrate-diff.cjs --compare tmp/dict-baseline.json` 通过——加入 `groups` 段后 main.js 121 处 / renderer.js 2141 处命中，**键集合与替换结果 sha256 与扁平版逐字节一致**，证明分组是纯附加数据、不影响替换；`npm run verify` 通过

## 4. macOS 平台段

- [x] 写产物提取模块：Range 取 zip 尾部窗口 → 解析中央目录 → 定位目标条目 → Range 取条目 → `inflateRaw` 解压
      ——落为 `scripts/release-assets.js`（`list` / `fetch` / `latest`），零依赖。**不处理 zip64**——官方产物最大 330 MB，够不着 4 GB 边界，真遇到说明打包方式变了，应当报错而非猜
- [x] 用官方 `GitHub.Desktop-x64.zip` 实测提取出 `main.js` / `renderer.js`，与本地已有的 Windows 版做同源校验
      ——提取成功（`tmp/release/3.6.6-beta2/macos-x64/app/`，main.js 240065 B / renderer.js 3180504 B）。**同源校验：webpack 模块标记数完全一致**（main.js 41/41、renderer.js 178/178），字面量 Jaccard 0.846 / 0.909，版本字面量各 22 处（Windows `3.6.6` / macOS `3.6.6-beta2`）。差异量（renderer.js 的 macOS 侧多 190 条字面量）与 Title Case 变体的预期吻合，是平台分叉而非来源不同
- [x] 对 macOS 产物跑 `scan`，得出 macOS 独有键集合，写进 `macos` 段（译文由继承 + AI 补齐，见第 6 组）
      ——**未走 `scan` 正式入口**：`scan.js` 有 `version !== app.version` 硬校验，beta 产物过不去（处置见「未完成项」）。改用等价做法：在 macOS 产物上跑一次替换，把仍未汉化的 label 按「归一化后 Windows 产物里有没有同文案」分类，得 56 条大小写变体 + macOS 专有文案。`macos` 段现 **96 条**（30 条 Windows 助记符键的 macOS 变体 + 18 条 macOS 专有文案 + 48 条 Title Case 菜单项），全部经 `dict-edit` 事务写入，译文一律继承 `common` 段同键、不新造。实测 macOS 产物 main.js 菜单 label 汉化 93/98、renderer.js label 汉化 164/175，Windows 侧条目数不变；三类差异与不可替换键清单见 `design.md` 第 4 节
- [x] `linux` 段保持为空并在文档写明原因（官方无 Linux 产物）
      ——`design.md` 第 4 节与「可行性依据」均已写明：近 30 个 release 的资产全为 Windows nupkg/exe/msi 与 macOS zip，**无任何 Linux 产物**；`release-assets.js` 的 `PLATFORM_SPECS.linux` 相应置为 `null`
- [x] 配套修复：`dict-groups.js` 的 `infer` 改为遍历**所有平台段**的键（原先只遍历 `loadDict()` 的本机平台合并结果，导致新增的 `macos` 段 96 条永远落「待分组」）
      ——`buildFileIndex` 改收键数组，`infer` 直接读字典 JSON 取五段键的并集。**common 段 1867 条组归属零变化**（改动只增加 macos 键的匹配机会，不影响既有键 first-wins 的结果，已用 `--json` 对比逐键核验）；macos 段 96 条里 **88 条**归入具体组（`About GitHub Desktop` → 菜单-帮助 等，来源是 sourcemap 里 `__DARWIN__` 三元的两侧分支），groups 覆盖 **1963/1963**，`validate` 的「未归入任何组」提示消失

## 5. GUI 组名列

- [x] `gui/main.js`：`collectDictEntries()` 读 `groups`，建"键 → 组名"反查表，行数据加 `group` 字段（查不到落 `待分组`）
      ——反查表的构建落在 `common.loadGroups()` / `common.reverseGroups()`（GUI 只消费，不自己解析 JSON：外部字典优先与内嵌资源回退那套逻辑只在 `readDictSource` 里有一份）；兜底组名提为 `common.UNGROUPED`，原先 `dict-groups.js` 与 `dict-edit.js` 各写一份字面量，已统一。查表用字典的**原样键**（含作用域前缀），剥了前缀反而查不到
- [x] `gui/index.html`：表头加「组名」列；`gui/style.css` 补列宽
      ——列序按参考截图：英文 45% / 中文 25% / 组名 15% / 类型 15%
- [x] `gui/renderer.js`：`renderRows` 增加组名单元格
      ——同时把组名纳入 `applyFilter` 的匹配范围：组名列的用途就是按界面区域定位，搜「菜单-帮助」应当能筛出整组
- [x] 实测：窗口内出现组名列，搜索过滤不受影响，条目总数与迁移前一致
      ——`npx electron` 起真实 GUI 读 DOM 取证：表头为「英文（程序文件中的英文） | 中文 | 组名 | 类型」，表格 **1867 行**（与迁移前一致），状态栏「字典 1867 条」；按组名搜「菜单-帮助」命中 6 行（与该组行数一致）、按译文搜「撤销」命中 13 行（既有行为不变）、搜不存在的词落空态；`npm test` **53/53 全绿**（新增 `reverseGroups` 两个用例：反查与作用域前缀保留、缺段/非对象/组值非数组的宽容降级与同键取首见）

## 6. CI 定时字典（`dict-auto.yml`）

- [x] 新增 `.github/workflows/dict-auto.yml`：`schedule`（每日）+ `workflow_dispatch`（可传单版本或版本列表用于回填）
      ——每日 `17 3 * * *`（UTC，避开整点排队），`workflow_dispatch` 两个输入：`versions`（逗号分隔，留空取官方最新）与 `dry_run`。`concurrency: dict-auto` 限单实例——两个 run 同时改 `dictionaries/` 再 push 会互相打架
- [x] 目标版本解析：取官方最新非 beta tag；已存在 `dictionaries/<版本>/` 则跳过（幂等）
      ——`resolveVersions()`：无 `--version` 时走 `release-assets.js` 的 `latestVersion()`（只认 `release-` 前缀的正式 tag），给了列表则按 `common.compareVersions` 升序依次产出；`buildOne()` 开头先查 `common.dictFile(version)` 是否存在，在则 `{skipped:true}` 直接跳过
- [x] 产物提取接入工作流（复用第 4 组的模块）
      ——`release-assets.js` 的 `fetchApp()`，走 HTTP Range 只取 `app/` 下几个文件（不下载整包），落成 `<work>/<版本>/<平台>-<arch>/app/`；`--reuse` 复用已有目录，便于反复调试同一版本
- [x] 继承逻辑：同键直接复用上一版译文；统计继承数与新增数并打印
      ——`inheritTable()` 版本降序合并、同键先见者胜（新版本译文优先），坏字典跳过不报错；再逐条核对新产物：`resolveIn()` 先试精确形态、再退到「只差大小写」的形态（官方把 `Copy file path` 改成 `Copy File Path` 这类微调不该让译文丢掉）。实测 3.6.7 上 **1963 条历史键零丢失**，其中 277 条官方改了大小写
- [x] AI 翻译：OpenAI 兼容协议，`AI_BASE_URL` / `AI_API_KEY` 走 Secrets、`AI_MODEL` 走仓库变量（判据见 design.md 第 5 节）；失败时按条目重试并记录未译条目
      ——`translateBatch()` 每批 20 条、失败重试 2 次、单次超时默认 120 s（`AI_TIMEOUT_SEC` / `--ai-timeout` 覆盖）；思考强度默认 **low**（`AI_REASONING_EFFORT` / `--ai-effort` 覆盖，给 `none` 表示不带该字段、退回接口自己的默认档），原样透传成请求体的 `reasoning_effort`、不校验取值（各网关认的档位不同，服务端不认识的值会被忽略或报错）。默认取最低档的理由与验证方式见 6.2 节。译文过 `rejectReason()`（占位符集合一致 + 必须含 CJK 字符），不合格的计未译并记原因。**已用真实服务实测**（全流程跑通），取证明细见 6.2 节
- [x] 准入门槛：`dict-edit validate` 通过 + 产物干跑（语法校验 + 命中率阈值）通过，才允许提交；不通过则开 issue 并保留产物
      ——门槛实现在 `dict-auto.js` 内（`--report` 出 JSON，workflow 只负责看退出码），比放在 workflow 里更早失败、也便于本地复现。**「开 issue」未做**：schedule 失败 GitHub 默认就给仓库所有者发通知，开 issue 是重复；改为 job 失败 + `::error::` 注解。**「保留产物」与本组「失败即删字典」不冲突**——删的是**产出的字典**（否则下次重跑会因「已有字典」跳过、把失败产出永久固化），官方产物本就在 `tmp/` 下、不在删除范围
- [x] 提交到仓库（`GITEE_TOKEN` 之外的提交凭据用既有 `RELEASE_TOKEN`），提交信息含继承数 / 新增数 / 未译数
      ——checkout 与 push 都用 `RELEASE_TOKEN`（PAT 权限确定，也避开内置 token 在分支保护下的推送限制），提交身份取该 token 持有者的 `login` 与 `id`（`{id}+{login}@users.noreply.github.com`），不硬编码名字。提交信息按仓库约定式生成，正文逐版本列「继承 N 条（其中 M 条官方改了大小写）/ 新增 N 条、译出 N 条 / 未译 N 条 / 官方已删除 N 条 / 分段 common N / macos N」。**推 main 不会触发 build.yml**（它只认 `v*` tag 与手动触发），不存在回环
- [ ] `workflow_dispatch` 回填实测：指定一个此前无字典的官方版本，产出并校验通过
      ——**只能在真实 CI 上做**（本地无法触发 Actions）。脚本侧的多版本路径已就绪：`--version` 收逗号分隔列表并按版本升序依次产出，逐版本独立成败（一个版本失败不影响后续，job 最终状态为失败）；提交步骤用 `if: always()`，把成功的部分照样提交上去

### 6.1 本组的两处口径取舍（实测取证）

**候选口径**：产物里的字符串字面量「是不是界面文案」在静态层面无从判断。实测 3.6.6 macOS 产物，字面量侧 1714 条候选里 1138 条是枚举值（`Canceled`）、事件名（`PageDown`）、注册表配置（`VSCodium`）、URL 片段（`/graphql`）、第三方包标识符；JSX 文本节点侧 150 条里 130 条命中既有字典，口径准得多。**最终定为**：① 继承 = 以历史字典的键为锚逐条核对新产物；② 新增 = 只取 JSX 文本节点候选；③ 字面量侧新增一律不自动收录（交给 `scan` 报告人工判断）。`scan.collectCandidates` 相应加了 `jsx` 标记，两处共用同一套过滤规则。

**平台分段**：只有「macOS 产物独有形态」进 `macos` 段，其余（含 Windows 独有）进 `common`。判据是**「该形态在 Windows 产物字面量里存不存在」**，而不是「`perPlatform.windows` 里有没有这条键」——同一条历史键在两平台可能解析出不同形态（Windows 精确命中 `Options`、macOS 只找得到 `options`），后者若在 Windows 产物里同样存在就该归 `common`，否则会凭空造出一条只在 macOS 生效的键。放 `common` 的 Windows 专有键只是多一条永不命中的键（无害），放 `windows` 段则会让 Linux 用户漏覆盖（有害）。

**修掉的两个真缺陷**（都由上面的口径在真实产物上暴露）：

1. **大小写兜底把代码标识符当成了文案**。`Cut` → `cut`、`Install` → `install`、`Options` → `options` 兜底命中后写进了字典，而它们在产物里分别是 Electron 菜单的 role 值（`role:"cut"`）、Git LFS 子命令参数（`["lfs","install"]`）、属性描述符键名（`{key:"options"}`）——替换进去会直接破坏功能。**修法**：`resolveIn` 对「无空格且不足 8 字符」的单形态短键不做兜底（真正的形态漂移都是多词文案，`Copy file path` → `Copy File Path`），含空格的键一律照旧。
2. **平台专用译文被通用译文挤掉**。`common` 段的 `Open with…`（打开方式…）只能兜底命中 macOS 产物里的 `Open With…`，而 `macos` 段的 `Open With…`（用其他应用打开…）是精确命中——遍历顺序让前者先落位、后者被 `put` 的「先见者胜」丢掉，`Contract/Expand Active Resizable` 两条同病。**修法**：`put` 加精确标记，精确命中压过兜底命中。

**双平台端到端实测**（真实产物，`--version 3.6.7 --reuse --no-ai`）：历史字典 3.6.5 / 3.6.6 共 1963 条 → 续用 1963 条**零丢失**，官方已删除 0 条；分段 `common` 1868 / `macos` 231；干跑 Windows 命中 2262 处、生效 1820/1851（**98.3%**），macOS 命中 2199 处、生效 1738/1763（**98.6%**），两侧都过 95% 阈值。**与既有 3.6.6 字典逐键对比**：`common` 新增 1 / 删除 0 / 译文变化 0，`macos` 新增 135 / 删除 0 / 译文变化 0，`windows` 与 `linux` 保持为空，`groups` 46 → 46——**零回归**，且补上了 135 条此前遗漏的 macOS Title Case 文案（`Add Repository`、`Delete Branch`、`Confirm Discard Changes` 等，第 4 组的 96 条只覆盖菜单 label 口径）。

### 6.2 AI 翻译链路的实测取证

**服务与参数**：目标网关 `GET /v1/models` 列有 `deepseek-v4-flash`。思考强度的参数名逐个试过——请求体的 `reasoning_effort` 有效且单调（同一个简单问题：`low` 1847 / `high` 6526 / `max` 11979 思考 tokens），`xhigh` 与 `reasoning={"effort":"max"}` 不生效，`thinking` / `enable_thinking` 无定论。不传该字段时基线 508 tokens / 10 秒，`max` 档 11979 / 97 秒（约 23 倍）——**超时必须跟着放大**，否则每批超时后退化成逐条重试，更慢且请求数翻倍。故超时做成可配（`AI_TIMEOUT_SEC`，默认 120 s）。

**一个由实测暴露、已修的问题**：判据与提示词打架。提示词第 7 条要求专有名词原样返回，`rejectReason` 的「必须含 CJK」判据却把它判成「没翻译」——首次实测 22 条候选里 10 条是 `github.com` / `GitHub Desktop` / `anthropic` / `hubot/cool-repo` / `.gitignore` 这类，未译比例 45% 直接越过 30% 门槛，**整个版本产不出来**（顺带验证了「失败即删字典」确实生效）。修法是加 `isEcho()` 把这类分流为「无需翻译」。

**最终产出**（`--version 3.6.7 --reuse`，超时 900 s）：20 条新增候选 → **译出 10 条、无需翻译 10 条、未译 0 条**；分段 `common` 1876 / `macos` 233；干跑 Windows 命中 2319 处、生效 1827/1858（**98.3%**），macOS 命中 2259 处、生效 1747/1772（**98.6%**）；与 3.6.6 逐键对比**新增 146 / 删除 0 / 译文变化 0**。

新增的 146 条里，145 条剥掉作用域前缀、统一小写后能对上历史键——都是同一文案的另一种书写形态（`Description` → `description`、`Default branch` → `Default Branch`），整串匹配下两种形态必须各自成键，并不是重复；其中 `Archived`（已归档）与 `archived`（已存档）的译文本就不同。全新文案只有 `GitHub's Logos` 一条。AI 译出的 10 条为 `description` / `difference` / `formatting` / `notifications` / `accessibility` / `archived` / `Default Branch` / `Open Repository` / `Fake account` / `GitHub's Logos`，译文逐一抽查正确、风格一致。

**默认档位定为 `low`、超时定为 120 s**（本次定案）：候选是界面短句，用不上深度推理——最低档的思考量约为最高档的 1/6（1847 vs 11979 思考 tokens），而耗时涨得更快（同一问题：不传该字段 10 秒，max 档 97 秒），默认走最低档才不至于把 CI 的 180 分钟预算耗在思考上。要高思考强度就**同时**调 `AI_REASONING_EFFORT` 与 `AI_TIMEOUT_SEC`，两者必须联动（理由见上）。取值原样透传、不校验，另留 `none` 作逃生口：网关对不认识的档位直接报错时，用它退回接口自己的默认档。

**默认值的验证方式**：本机 Node 直连 GitHub 时 TLS 握手异常（带 SNI 6.3 s、不带 0.17 s，脚本的 20 s 超时内拿不到响应），取不到产物、无法本地端到端复跑——这与 `net.js` 已写明的「不支持 HTTP 代理」限制叠加，CI 上不存在（runner 网络直通）。故默认值改由**本地假服务器单测**锁定：`translateBatch` 的请求体里确实带上了 `reasoning_effort: "low"`（`none` 时整个字段不出现），且 `cfg.timeout` 真的落在请求上（600 ms 的用例 621 ms 返回，没退化成 20 s 兜底）。端到端仍以 CI 的 `workflow_dispatch` 回填实测为准（第 6 组未勾选项）。

**一处版本号存疑**（2026-09-19 经本机 7890 代理直连 GitHub API 复核；当日二次复核**推翻了其中一半**）：当时标注的 `3.6.7` 并非正式版——该 tag 只有 `release-3.6.7-beta1`（2026-09-16）与 `release-3.6.7-beta2`（2026-09-18）两个 prerelease，`releases/tags/release-3.6.7` 返回 404，这一条成立。

但「最新正式版是 3.6.5」只对了一半。**官方发布说明页（`desktop.github.com/release-notes/`）显示 3.6.6 是 2026-09-16 发布的正式版**，`release-3.6.6` 这个 **tag 也确实存在**；缺的是它的 **GitHub Release 对象与产物**——实测 `releases/tags/release-3.6.6` → 404、产物 URL `…/download/release-3.6.6/GitHubDesktop-3.6.6-x64-full.nupkg` → 404，而同名 beta2 的同一路径 → 200。

**release-notes 与 GitHub Releases 是两条不同步的线**：前者面向用户公布版本，后者才挂产物，正式版的 Release 对象比 notes 晚若干天（3.6.5：notes 09-03 / Release 09-04；3.6.4：notes 08-12 / Release 08-13，各约 1 天；3.6.6 至 09-19 已滞后 3 天以上）。

**CI 不受影响，且 `latestVersion()` 的写法不该改**：它走 `/releases/latest`，语义是「**有产物可下的**最新正式版」——这正是需要的语义。若改成按 tag 取名，会拿到 `release-3.6.6`（无产物）、`release-3.6.7-test2`、`tmp-e2e-screenshots-21745` 这类取不到产物的 tag 而直接失败。故 CI 当前每次跑都停在「3.6.5 已有字典 → 跳过」，直到 3.6.6 的 Release 对象出现——届时目录已存在，仍是跳过，不会覆盖这份已有字典（其真实产出源见 6.4）。

**`dictionaries/3.6.6/` 的产出源是正式版产物，不是 beta2**（2026-09-19 用官方安装包复核后修正，详见 6.4）。此前「正式版产物取不到、字典只能从 beta2 产出」的推断是错的——字典 `_meta` 记的「重建整模板键」用的是**本机安装的 3.6.6**，而本机那份与官方正式版产物**字节完全一致**。

另注：产物版本号**会**被校验，只是校验得晚——`dict-groups.infer` 有「字典版本 ≠ 安装版本」硬校验，而它在第 7 步才被调用；`--reuse` 本身只查文件是否存在。手工往 `tmp/release/<版本>/` 放产物时（如本次实测把 `3.6.6-beta2` 的产物放进 `tmp/release/3.6.6/`），必须同步改写产物内 `package.json` 的 `version`，否则要到第 7 步才报错。

### 6.3 已有字典的处置模式（`--on-exist`，默认 `skip`）

定时任务靠「已有字典即跳过」保持幂等——每日跑一次不会重跑已产出的版本、白烧 tokens。但**回填与重跑**是真实需求（需求 5 的「补齐之前版本的字典」），脚本原先只有跳过一条路，想重跑一个已有字典的版本无从下手。故加 `--on-exist=skip|diff|overwrite`（`workflow_dispatch` 的 `on_exist` 下拉同款三值）：

- **`skip`（默认）**——跳过，幂等不变。
- **`diff`**——照常产出但**全程不写盘**，产出与磁盘上那份逐键比一遍后报差异。**照常调 AI**：跳过 AI 的话新增候选会全变成「未译」而被剔除，对比结果里将尽是并不存在的「删除」。
- **`overwrite`**——产出后整体覆盖；**任一步失败则恢复原内容**（不是删掉——「覆盖」把原有的那份一起弄丢是最坏的结果）。`dict-edit create` 默认拒绝覆盖（那道闸拦的是「本该用 apply 逐条改、却整体重建」的误用），这里给它开了显式的 `overwrite` 口子。

**diff 为什么完全不写盘，而不是「先写再恢复」**：进程中途崩溃（CI 超时、被取消）会留下新字典，而「只读」这个承诺一旦破了，diff 就再也不能在正式仓库上随手跑。纯内存对比零风险。

**对比按「键」对齐而不是「段 + 键」**：同键换段（`common` ↔ `macos`）若按段对齐会表现成一删一增，看着像两条无关的变化；单列成 `moved` 才看得出「这条只是换了归属」。组归属只对两边都在的键比——新增/删除的键各自的归属没有「变化」可言。明细每类截到 500 条（`DIFF_LIMIT`）但**总数照实报**，截断了多少要看得出来，否则「报告里只有 500 条」会被读成「一共就 500 条」。

**实测取证**（2026-09-19，本机走 7890 代理直连 GitHub 取真实产物，两平台都带 sourcemap）：

1. **diff 端到端**（`--version 3.6.6 --on-exist diff --reuse`，接真实 AI 服务）：1/7→7/7 全通，继承 1963 条、译文变化 0、新增 146 条（当时报的「删除 17 条」实为 beta2 的压缩变量名与字典形态不同所致，**不是官方删了文案**，详见 6.4）；**跑完 `sha256` 与跑前逐字节一致**（`758a2357…`），`git status dictionaries/` 为空——「全程不写盘」有了硬证据。
2. **overwrite**：写入成功（`common` 1859 / `macos` 233、46 个组），原有译文逐条保住（`Repository` → 仓库、`Add Local Repository…` → 添加本地仓库…），`validate` 通过（仅 1 条「译文与原文相同」提示，非 error）。验完即用 `git checkout` 还原。
3. **旧格式字典被提前拦下**：`--version 3.6.5 --on-exist diff` 在 **0.381 秒**内失败（此前要跑完下载 + 一轮 AI 才报，几分钟与 tokens 白烧），报告里也有完整的失败条目。

**由这次实测修掉的三个真缺陷**：

1. **重跑已有版本时没把自己算作继承来源**。`inheritTable([version])` 排除了目标版本，这对「产新版本」是对的，但 `diff` / `overwrite` 是「重跑」——排除自己等于放弃原有译文。实测重跑 3.6.6 时继承 **0 条**、产出只剩 140 条，`overwrite` 会把原有 1963 条的好字典换成这份残缺品，`diff` 也会把「继承不到」误报成「删除 1833 条」。**修法**：`previous !== null` 时不排除自己（官方删掉的键仍会被正确剔除——核对的锚是键集）。修后继承 1963 条、译文变化 0。
2. **diff 读不了旧格式字典时失败得太晚**（见上第 3 条实测）。**修法**：在 `buildOne` 开头就 `dictEdit.read()` 试读，读不了立刻返回失败——这件事一开始就知道，没道理等产物下载完、AI 也调完才报。
3. **单版本异常会拖垮整轮**。异常从 `buildOne` 冒泡到 `main` 的 catch，该版本结果丢失（报告里 `reports` 为空）、后续版本全不跑——而 CI 的提交步骤正是靠「已成功的那些」产出内容的。**修法**：`main` 的循环里给 `buildOne` 包 try/catch，转成失败条目继续下一个。

**已解决**：`dictionaries/3.6.5/` 原是 formatVersion 1 的扁平格式（1853 条顶层键），而 `inheritTable` 只遍历 `SEGMENT_NAMES` 各段——遇到它得 0 条。当时实际无害（3.6.6 是 2.0 且更新，版本降序合并时先命中，表已填满），但哪天它成为唯一可继承来源就会静默退化成「从零翻译」。**已走 `dict-edit migrate 3.6.5` 这条路**：1853 条全部进 `common` 段，组名由 `dict-groups` 推断（45 组，「待分组」414 条，与 3.6.6 的 400 条同构），`_meta.notes` 原样保留，`validate` 0 错误。迁移后 `inheritTable` 遍历四段得 **1853 条**（迁移前为 0）。未选另一条路（让 `inheritTable` 兼容扁平格式）——那要在两处各写一份格式判定，而迁移是一次性的。

### 6.4 正式版产物复核：与 beta2 差在哪，以及字典为什么不用重做

**起因**：发布说明页显示 3.6.6 是 09-16 的正式版，但 GitHub Releases 上没有它的产物（6.2）。用户提供了本机安装包的副本，据此核实「现有字典是否需要基于正式版重做」。

**本机安装的就是正式版**。从 Squirrel `Setup.exe` 与 macOS `GitHubDesktop-x64.zip` 提取出产物（`Setup.exe` 是双层 zip：外层自解压容器里套真正的 nupkg，且 EOCD 之后还跟着 157 KB 的 PE overlay，超出 zip 注释上限，尾部窗口搜不到 EOCD，须全文件扫 `PK\x05\x06`），与本机安装的 3.6.6 逐文件比 sha256（前 16 位）：

| windows-x64 | 本机安装 | 官方正式版 | beta2 |
|---|---|---|---|
| `renderer.js` | `e05f7f3b…` 3166339 B | 同左 | `e41a09bd…` 3200974 B |
| `main.js` | `ff9db9cb…` 242192 B | 同左 | `99f5104f…` 242278 B |

正式版与 beta2 字节级都不同（renderer.js 差 ~34.6 KB），但**正式版这条线一直是通的**——此前「只能拿到 beta2」说的是 GitHub Releases 那条线，本机安装那条线从来没断过。

**字典的整模板键形态与正式版一致、与 beta2 不同**：

| 来源 | `changed file` 模板里的变量名 |
|---|---|
| 3.6.5 字典 | `GE` / `xU` |
| **`dictionaries/3.6.6/`** | **`YE` / `OU`** |
| beta2 产物 | `Sk` / `lW` |
| 正式版产物 | `YE` / `OU` |

3.6.5 是 `GE`/`xU`，说明 3.6.6 的整模板键不是继承来的，而是在某个产物上「重建」的（`_meta` 语）；重建出的形态与正式版一致，那个产物就是正式版。**这是「字典配正式版」的直接证据**，也修正了 6.2 原先「字典从 beta2 产出」的推断。

**用正式版产物重跑 `--on-exist=diff`（真实 AI 调用）**：

    新增 146 / 删除 0 / 译文变化 0 / 换段 0 / 组归属变化 0
    续用旧译文 1963 条零丢失；官方已删除 0 条
    干跑 windows：命中 2319 处，生效 1827/1858（98.3%），coveredByTemplate 31，missed 空
    干跑 macos：命中 2261 处，生效 1750/1775（98.6%），coveredByTemplate 25，missed 空

与 beta2 产物的同一跑相比，**唯一差异是「删除」17 → 0**：那 17 条全是整模板键，beta2 的压缩变量名与正式版不同，字典里存的形态在 beta2 产物里找不到，于是被判为「已删除」——**不是 beta2 少了文案**。若当时走了 `overwrite` 而非 `diff`，反而会把 17 条整模板键改写成 beta2 的变量名，破坏与正式版的匹配（`diff` 全程不写盘的价值正在此，见 6.3）。

**结论：`dictionaries/3.6.6/` 无需基于正式版重做**——它本来就是从正式版产出的，与正式版产物零冲突、双平台零遗漏（`missed` 为空）。

**顺带查明的独立缺口，已补齐**：那 146 条「新增」**不是版本差异**（beta2 与正式版跑出来都是 146），而是字典自身的缺口——145 条是同一文案的另一种书写形态（`description` vs 已有的 `Description`、`renderer.js|Not Now` vs 已有的 `Not Now`、` Alias` vs 已有的 ` alias`），1 条是真新文案 `GitHub's Logos`（译作「GitHub 的徽标」）。整串匹配下两种形态必须各自成键，不收录则该位置替换不了。**已用正式版产物跑 `--on-exist=overwrite` 补齐**：`1963 → 2109` 条（`common` 1876 / `macos` 233），逐键比对为**新增 146 / 删除 0 / 译文变化 0**，`validate` 0 错误、1 项提示（`GitHub Copilot` 译文与原文相同，HEAD 版本里就有，属既有的品牌名条目）。

**反向印证产物来源搞错的后果**：上一轮用 beta2 产物跑 overwrite 时 `common` 只有 **1859** 条，比这次少 **17** 条——那 17 条整模板键在 beta2 产物里找不到对应形态，继承核对时被剔除。当时验完即用 `git checkout` 还原、没有落盘，所以字典没被弄坏。**换句话说：产物来源搞错时 `overwrite` 会真丢条目，而 `diff` 不会**——这正是 `diff` 全程不写盘（6.3）的价值所在。

## 7. Gitee 发版与检查更新优先级

- [x] `build.yml` 的 `release` job 后新增 Gitee 步骤：`GET /releases/tags/{tag}` 探测 → `POST /releases` → 逐附件 `POST /releases/{id}/attach_files`（幂等、单个附件失败不回滚 GitHub Release、失败日志含文件名）
      ——落为 `release` job 末尾的「发布到 Gitee」步骤（排在 GitHub Release 发布**之后**）。**实测确定的两个 Gitee 特有行为**：按 tag 查发行版时 **`200 + 字面量 null` 表示不存在，不是 404**（照搬 GitHub 的判据会把「不存在」读成「查询失败」）；资产对象**只有 `browser_download_url` 与 `name`，没有 sha256 / size 可比**，故幂等只能按文件名判——上限是「上次传到一半的残缺附件」会被当成已传，Gitee 没有可用的完整性凭据。创建时正文用 `jq --rawfile` 从 `notes.md` 读，与 GitHub 侧同一份。失败分两层：单个附件重试 3 次后记 `::error::`（含文件名）并让 job 标红，而 GitHub Release 已在前面发布完毕、不受影响；未配令牌则打 `::warning::` 后跳过
- [x] Secrets 增加 `GITEE_TOKEN`，并在 `check-version` job 里校验其存在性（缺失时给出可读提示而非静默跳过）
      ——`check-version` 新增「校验 Gitee 令牌」步骤：缺失时打 `::warning::` 明说本次不会同步到 Gitee（**不阻断**——Gitee 是镜像渠道，不该挡住权威源），已配则打印字符数。`AGENTS.md`「发版」一节补了配置方法（Gitee 私人令牌勾 `projects` 权限）
- [x] `common.js` 的 `remoteDictUrls(version)` 增加 Gitee raw 兜底（顺序：GitHub raw → jsDelivr → Gitee raw）
      ——**此前已完成**（`common.js` 第 386-389 行的返回顺序即为此），连同 `GITEE_RAW` / `GITEE_API` 两个常量一并核过
- [x] `scripts/update.js` 的 `check()` 增加 Gitee Releases API 兜底
      ——GitHub 取不到时退回 `${GITEE_API}/releases/latest`；返回值多一个 `source` 字段标明来源（两个调用方只用 `hasUpdate`/`latest`/`current`/`asset`/`releaseUrl`，不受影响）。**顺带修掉一处会直接崩的缺陷**：Gitee 的资产对象没有 `url` 字段，而 `apply()` 只认 `asset.url`——`pickAsset` 现在把 `browser_download_url` 补进 `url`。`releaseUrl` 在 Gitee 侧按 tag 拼（那边没有 `html_url`）。**实测**：把 GitHub 指向不存在的仓库、Gitee 指向 `mindspore/mindspore`，`check()` 返回 `source=gitee` / `latest=2.7.2` / `releaseUrl` 指向 gitee.com ✓
- [ ] 实测：发一个 tag → Gitee Releases 页出现同名发行版且附件数与 GitHub 一致
      ——**只能由真实 CI 触发**：需先在仓库 Actions secrets 配好 `GITEE_TOKEN` 再推 tag。本地既无令牌、也没有脚本依赖的 `jq`（runner 自带）；Gitee API 的端点行为、认证方式与返回结构已在本地用 curl 逐条实测（见上四项）

## 8. 更新管控注入

- [x] **先取证**：确认产物 main.js 里注入代码可用的运行时能力（`require('fs')` / 全局 `fetch` / `__dirname`），据结果定版本上限用"外部清单 + 内联常量"双级还是只用内联常量
      ——**取证结论**（3.6.6 正式版 main.js，241919 字符）：产物结构是「行 0 版权注释 + 行 1 单个 IIFE（241824 字符）+ 行 2 sourceMappingURL」，**全部代码在一个 IIFE 里**。
      - **`require` 可用**：产物里 `require("fs")` / `require("http")` / `require("https")` / `require("electron")` 各出现 1 次——这些是 webpack 的 externals，被保留成 Node 原生 require。注入点选在 **IIFE 之外**（行 0 与行 1 之间）：那里是 CommonJS 模块顶层，`require` 是原生的，不受 webpack 运行时的 `__webpack_require__` 拦截
      - **路径能力可用**：`__dirname` 6 次、`app.getPath(` 5 次、`app.getAppPath` 2 次；`process.resourcesPath` **未出现**（0 次），别用它
      - **`fetch` 产物未用**（0 次）——注入代码要联网得走 `require('https')` 或 `require('electron').net`
      **据此定版**：**只用内联常量 + 运行时扫字典目录**，不引入外部清单——「哪些版本有字典」这件事字典目录本身就是权威（SSOT），再加一份清单只是多一处要对齐的地方。注入时把字典目录的绝对路径写死进代码，运行时扫它取最大版本号当「已支持版本上限」
      **注入点定位**：`setFeedURL` 在 main.js 里只出现 **1 次**，就在 `async checkForUpdates(e){try{r.autoUpdater.setFeedURL({url:await me(e)}),r.autoUpdater.checkForUpdates()}catch(e){return e}}` 里；IPC 契约是 `ae("check-for-updates",async(e,t)=>qt?.checkForUpdates(t))` 与 `se("quit-and-install-updates",()=>qt?.quitAndInstallUpdate())`。**方法名 `checkForUpdates` 未被压缩**（它是被 IPC 调用的类方法），可作稳定锚点
- [x] `patch.js` 补丁组记账：记录当前应用了哪几组（汉化 / 更新管控），还原按组执行，备份始终是官方原文那一份
      ——记账落在 `<数据目录>/tmp/patch-state.json`（`common.js` 的 `PATCH_GROUPS` / `setPatchGroups` / `getPatchGroups`），记的是**全集**不是增量。`patch` 写账时**并入已有**而不是覆盖（不带 `--update-control` 再跑一次，不该把上次打的更新管控从账上抹掉）；整份 `restore` 则**销账**（回到官方原文，账上不该留着任何组）。按组还原走 `restore --group <组名>`：**从官方原文备份重放剩下的组**，而不是逐组撤销——产物是若干补丁叠加的结果，逆运算既难写又易错（注入块要精确摘除、文案替换要逐条逆推），重放的结果与「一开始就只打这几组」逐字节相同。**备份因此始终只有一份（官方原文）**。`patch.run` 为此加了 `noRestart`，避免「还原→重启→重放→再重启」两次拉起应用
- [x] 注入实现「禁止自动更新」：替换 `setFeedURL + checkForUpdates` 调用对为空操作，IPC 契约不变
      ——落为 `scripts/update-control.js` 的 `mode: 'off'`：`__gdzcAllowUpdate` 恒返回 false，`checkForUpdates` 一进门就 `return`，`setFeedURL` / `autoUpdater.checkForUpdates()` 都不会被调到。**没有整段替换方法体**，而是在方法体开头插一道闸（`async checkForUpdates(e){if(!globalThis.__gdzcAllowUpdate())return;try{…}`）——整段替换要精确匹配方法体结尾，插闸只要锚点唯一即可。**IPC 契约不变**：`check-for-updates` / `quit-and-install-updates` 两个事件名与处理器签名原样保留，renderer 侧无感。入口是 `patch --block-update`
- [x] 注入实现「没有字典就拦截」：放行前比对当前版本与已支持版本上限
      ——`mode: 'guard'`（`patch --update-control`）。**已支持版本上限 = 字典目录里带 `zh-CN.json` 的最大版本号**，运行时扫出来（不引入外部清单，字典目录本身就是权威）。**放行条件是「上限 > 当前版本」**：说明新版本的字典已经就位、更新过去还能是中文；相等或更低时拦截，因为工具还没跟上，更新过去就只剩英文界面。**判断不了就放行**——字典目录读不到（被移走 / 权限不足）时返回 true，宁可让用户更新，也不要因为工具自己的问题把人锁死在旧版本上。注入块用首尾标记 `/*__GDZC_UPDATE_CONTROL_BEGIN__*/` … `END` 包住，重复注入是幂等的
- [x] 注入实现「更新后自动汉化」：放行后由工具在新版本目录落地时补打补丁
      ——注入块里带一段 `autoPatch()`：GitHub Desktop 每次启动时，若**当前版本有字典、账上却没有 i18n 组**，就 spawn 工具 `patch --version <当前版本>` 补打一次。判据用记账文件（`<字典目录>/../tmp/patch-state.json`）而不是「产物里有没有中文」——记账既是「打过没有」的权威记录，也避免了每次启动都白跑一次 patch。**工具路径在注入时写死**（`process.execPath`），且**只在打包态注入**：源码态下工具就是仓库本身（用户自己 `npm run patch`），往产物里写死一个 node 路径换台机器就指向不存在的东西了。spawn 失败一律吞掉——这是锦上添花的一步，不能因为它让 GitHub Desktop 起不来
- [x] `cli.js` / GUI 增加「禁止自动更新」与「恢复自动更新」两个开关
      ——两边都做成**三选一**而不是两个独立开关：「没有字典就不更新」与「完全禁止」是同一处注入的两种模式，两个开关会让人以为能同时开，而它们改的是同一行代码。CLI 菜单加 `6) 更新管控`（`doUpdateControl`），GUI 加「更新管控」按钮（`btn-update-control` → IPC `updateControl` → 主进程对话框选模式）。命令行侧的等价入口写进了 `--help`：`patch --update-control` / `patch --block-update` / `restore --group updateControl`。GUI 的模式选择在主进程对话框里做，preload 依旧只暴露「动作」不暴露参数——渲染进程无法伪造确认
- [x] 实测：开启后 GitHub Desktop 不再触发更新检查（开关状态 + 产物字节差异双重取证）；还原后回到官方行为
      ——**在本机真实安装上做了**（`C:\Users\32471\AppData\Local\GitHubDesktop\app-3.6.6`，3.6.6 正式版，此前已汉化）。取证：
      - **开关状态**：记账 `{"3.6.6":{"groups":["i18n","updateControl"]}}` ✓
      - **产物字节差异**：main.js `240657 → 242241`（+1584），md5 前 12 位 `9e840388a8b5 → 2c4f8a8917d1` ✓
      - **注入块与闸门就位**：`/*__GDZC_UPDATE_CONTROL_BEGIN__*/` 与 `if(!globalThis.__gdzcAllowUpdate())return;` 都在，且闸门恰好插在 `async checkForUpdates(e){` 之后 ✓；`renderer.js` 未被注入（只动 main.js）✓
      - **语法合法**：注入后的 main.js / renderer.js 都能被 `vm.Script` 解析（69 ms）✓
      - **`DICT_DIR` 正确内联**：`var DICT_DIR="E:\\github-desktop-zh-cn\\dictionaries";` ✓；**`TOOL` 未注入**（源码态，符合设计）✓
      - **闸门逻辑**：用 vm 沙箱跑注入块，四种场景全对（等于上限→拦截、低于上限→放行、高于上限→拦截、目录不存在→放行）
      **未做的一步**：没有主动启动 GitHub Desktop 去观察「更新检查确实没触发」——那是运行时行为，要动用户的应用，留给用户自己开一次确认。**副作用留档**：打补丁前的产物已复制到 `tmp/patch-test/before-real/`，官方原文在 `tmp/backup/3.6.6/`，随时可回滚
      **本轮实测暴露并修掉的三个真实缺陷**（都已提交）：`restart.js` 的 `launch` 不接 `error` 事件导致 `ENOENT` 冒到进程级带崩调用方；`restartApp` 只按进程名判断「在不在跑」，把用户开着的应用关掉却起不来还回去；`restore --group` 在账为空但产物已汉化时（记账功能上线前的老用户）会把汉化一并还原掉

## 9. 工具自更新接 GUI

- [x] `gui/main.js`：启动后延迟调用 `update.check()`，有新版则提示（无新版不打扰）；启动时 `cleanup()` 清理 `.old`
      ——`scheduleToolUpdateCheck()` 在 `whenReady` 里挂一个 4 秒延迟：界面稳定后再查，**有新版本才推**一条 `toolUpdate` 给渲染进程（toast 提示，不弹模态框、不打断手上操作）；**检查失败静默**——启动时的自动检查不该因为网络问题给用户报错，用户主动点「检查更新」时才把失败原因说出来。`update.cleanup()` 加在 `whenReady` 开头（替换策略是「改名而不是删除」，`.old` 只能等新进程启动时清）
- [x] `gui/main.js`：确认后调用 `update.apply()`，并在失败时给出可读原因
      ——**改成了「下载安装包 + 启动安装向导」，不调 `apply`**：`apply` 是替换自身 exe（SEA 单文件产物的方式），在 Electron 打包态 `isPackaged()` 为假、会直接抛错。抽出 `installGuiUpdate()` 供两处复用：用户主动点「检查更新」时弹确认框（下载并安装 / 稍后 / 打开下载页），以及启动时自动检查到新版后用户点提示进来。下载走 `net.download` 并推进度；装完启动：Windows 的 `-setup.exe` 与 Linux 的 `.AppImage` 直接 spawn，macOS 的 `.dmg` 与 Linux 的 `.deb` 交给 `open` / `xdg-open`。spawn 同样接了 `error` 事件——不接会冒到进程级把 GUI 带崩
- [x] 核对 `update.js` 的 `pickAsset()` 与 electron-builder 的 GUI 产物命名是否匹配，不匹配则补齐
      ——**核对结果：不匹配**。GUI 产物是 `github-desktop-zh-cn-gui-v<版本>-<平台>-<架构>[-setup].<扩展名>`（AGENTS.md「产物命名」），Windows 以 `-setup.exe` 结尾，`pickAsset` 的 `-win32-x64.exe` 匹配不到；macOS / Linux 是 `.dmg` / `.AppImage` / `.deb`，更在它的扩展名表之外。**补齐为独立的 `pickGuiAsset()`**——不塞进 `pickAsset`：那个服务 CLI 自更新（下载单文件可执行体替换自身），这个服务 GUI（下载安装包交给用户装），命名与扩展名都不一样，混在一起只会让两边都判不准。`pickGuiAsset` 只认带 `-gui-` 的名字（别把 cli 产物当安装包），同样做 Gitee 的 `url` 归一化。`check()` 现在同时返回 `asset` 与 `guiAsset`。**实测**：用 AGENTS.md 那套命名构造资产列表，三个平台（win32-x64 / darwin-arm64 / linux-x64）的 CLI 与 GUI 匹配全对；列表里只有 cli 产物时 `pickGuiAsset` 返回 null ✓
- [ ] 实测：存在新版本时 GUI 弹提示；确认后替换成功、重启版本号变化
      ——**做不了，缺前置条件**：当前工具版本就是最新（v0.2.0），`update.check()` 永远返回 `hasUpdate: false`，没有「存在新版本」这个场景可测。要等下一次发版（或把 `check()` 临时指向一个构造的 release）才能验。**另外判据本身要改**：GUI 态是「下载安装包交给用户装」，不是 CLI 那种「替换自身 exe」，所以「重启后版本号变化」应改为「装完后版本号变化」。
      **本地能验的部分已验**：`pickGuiAsset` 对三个平台的命名匹配全对（含「只有 cli 产物时返回 null」的边界）；preload 的 `invoke` / `ipcRenderer.on` 与主进程的 `handle` / `webContents.send` 两两对齐（无暴露未注册、无监听未推送）；启动检查的「无新版不打扰」在当前版本下天然成立

## 10. 文档同步与提交

- [ ] `AGENTS.md`：字典格式（formatVersion 2）、**字典唯一写入口 `scripts/dict-edit.js`** 的约束、平台分段、在线能力、已知坑
- [ ] `dictionaries/README.md`：格式规范改写为新结构 + 写入口约束
- [ ] `README.md`：组名列、跨平台支持与 Linux 现状、更新管控开关、Gitee 下载渠道
- [ ] `docs/打包与分发.md`：CI 定时字典、Gitee 发版、Secrets 清单
- [x] 残留检查：旧格式描述、旧术语、`_meta.notes` 里的过期格式说明
      ——扫出并修掉一处真残留：`docs/gui/design.md` 的「有意差异」表还写着「『组名』列**去掉**，改『类型』列」、理由是「本仓库字典是扁平 `{"原文":"译文"}`，无组名概念」——那是字典还是扁平结构时的判定，后来字典迁到 2.0 并有了 `groups` 段，组名列已经补上（`gui/index.html` 的表头就是「英文 / 中文 / 组名 / 类型」），两列并存。同表的「底部平台下拉」那行理由也一并更新（不是「无平台维度」，而是表格显示的是当前平台的合并结果、无需切换）。其余命中项（`design.md` 的 `migrate` 注释、`proposal.md` 与 `tasks.md` 里的历史记录）都是在讲迁移本身，属正常表述。两个版本字典的 `_meta.notes` 都已无过期格式说明，`formatVersion` 均为 2
- [x] 固化替换判定探针到 `build/tools/`（判定某处文案可否替换的那些 `tmp/` 临时脚本，清掉即失；`design.md` 已改为只引用判据不引用文件）。**前置**：把 Windows 备份目录与 macOS 产物目录参数化，否则换台机器跑不起来
      ——落为 `build/tools/check-replaceable.cjs`：打出某处文案在产物里每处出现的前 80 / 后 40 字符，并标出高危上下文（作为查表实参 / 与某值比较 / 模块导出名 / switch 分支值 / 环境变量名）。**判断仍由人做**——判据是「赋值处与比较处是否同源」，探针只负责把证据摆齐。**路径全部参数化**（`--version` 走 `tmp/release/<版本>/<平台>-<架构>/app`，`--path` 可指向任意目录），且 `--path` 同时接受 resources 目录与 app 目录本身——查英文原文要指向 `tmp/backup/<版本>/`，产物可能已汉化、那里才是原文。**实测**：查 `Sign in` 得 3 处（2 处是 `renderSignIn` / `renderSignInTab` 里的 switch 分支值、1 处是显示用），查 `File` 得 1 处（`Object.defineProperty(t,"File",…)` 模块导出名）——判定与 `design.md` 的人工结论一致。同时把 `check-naming.cjs` 扩到覆盖 `pickGuiAsset`，并修掉它暴露的 Linux 架构别名缺陷
- [x] 按 `commit-create` 规范拆分提交（建议按组拆：字典层 / GUI / CI / 注入 / 文档）
      ——本次工作按单一职责拆成 11 个提交：字典层 2 个（3.6.5 迁移到 2.0、3.6.6 补齐 146 条形态缺口）、CI 与检查更新 1 个（Gitee 发版 + 兜底）、注入层 4 个（更新管控补丁组、自动汉化 + 开关、按组还原的拦截修复、真机实测取证）、GUI 1 个（工具自更新接 GUI）、文档与探针 2 个（文档同步 + 探针覆盖 GUI、探针固化）、错误结论修正 1 个。每个提交都显式 `git add <文件>`、中文约定式信息、不带任何署名

## 未完成项

### 已决：`scan.js` 的版本硬校验挡住 beta 产物 → **不放宽**

第 4 组第 3 项未走 `scan` 正式入口——`scan.js` 里有 `if (version !== app.version) throw`，而当时能取到的 macOS 产物是 `3.6.6-beta2`，字典目录名是 `3.6.6`，两者对不上。当次的替代做法是用探针直接做替换后归类，结论已并入 `macos` 段。

**定案：不加宽容开关**。CI 的第一步就是「取官方最新**非 beta** tag」，beta 本就不在自动流程的输入范围内；手工补 beta 是一次性操作，不值得为它放宽正式入口的校验。

**且第 6 组不受这条校验影响**：CI 的候选提取调用的是 `scan.collectCandidates()`（纯函数，收 `appDir` 参数），版本一致性校验在 `scan.js` 的 `main()` 里、只约束命令行入口。本地复现时把产物副本的 `package.json` 版本改成目标版本即可——`dict-groups.js` 的 `version !== app.version` 硬校验同理。

### 已决：平台专有键的段归属 → **Windows 专有键留在 `common`，只有 macOS 独有形态进 `macos` 段**

原先设想把 `common` 段里实际只在 Windows 产物出现的键（`Show in Explorer`、`&Options…` 等）移到 `windows` 段。第 6 组做完后**否掉了这个方向**。

**理由**：放 `common` 只是多一条永不命中的键（无害），放 `windows` 段则会让 **Linux 用户漏覆盖**（`buildEntries` 是 `common ∪ 当前平台段`，Linux 产物走非 darwin 分支、形态与 Windows 一致，但没有官方 Linux 产物、`linux` 段永远是空的）。收益（语义整洁）远小于风险（漏翻译）。

**判据也一并改了**：原先按「`perPlatform.windows` 里有没有这条键」分段，会漏掉「同一条历史键在两平台解析出不同形态」的情况（Windows 精确命中 `Options`、macOS 只找得到 `options`）。现按**「该形态在 Windows 产物字面量里存不存在」**判——与写入时的判据同源，`toSegments(perPlatform, winExact)` 的第二个参数就为此而设。

**第 4 组担心的「版本差异混入」已不复存在**：CI 按平台产出时两平台用**同一版本**的产物，差异清单里不再混入版本新增文案，归属判定是准的。这条也解释了为什么第 4 组的 `macos` 段只有 96 条而第 6 组算出 231 条——不是 bug，是第 4 组只覆盖了菜单 label 口径，另有 135 条 Title Case 文案（`Add Repository`、`Delete Branch` 等）此前从未收录。

