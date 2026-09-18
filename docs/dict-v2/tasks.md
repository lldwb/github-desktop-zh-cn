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
      ——提取成功（`tmp/release/3.6.6-beta2/macos-x64/app/`，main.js 239790 B / renderer.js 3179938 B）。**同源校验：webpack 模块标记数完全一致**（main.js 41/41、renderer.js 178/178），字面量 Jaccard 0.846 / 0.909，版本字面量各 22 处（Windows `3.6.6` / macOS `3.6.6-beta2`）。差异量（renderer.js 的 macOS 侧多 190 条字面量）与 Title Case 变体的预期吻合，是平台分叉而非来源不同
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
- [x] AI 翻译：OpenAI 兼容协议，Secrets 为 `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`；失败时按条目重试并记录未译条目
      ——`callAI()` 每批 20 条、失败重试 2 次、单次超时 120 s；译文过 `rejectReason()`（占位符集合一致 + 必须含 CJK 字符），不合格的计未译并记原因。**未用真实服务实测**（本地无密钥），接口形态按 OpenAI 兼容协议写，CI 首次跑通的标志是「未译比例门槛不触发」
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

## 7. Gitee 发版与检查更新优先级

- [ ] `build.yml` 的 `release` job 后新增 Gitee 步骤：`GET /releases/tags/{tag}` 探测 → `POST /releases` → 逐附件 `POST /releases/{id}/attach_files`（幂等、单个附件失败不回滚 GitHub Release、失败日志含文件名）
- [ ] Secrets 增加 `GITEE_TOKEN`，并在 `check-version` job 里校验其存在性（缺失时给出可读提示而非静默跳过）
- [ ] `common.js` 的 `remoteDictUrls(version)` 增加 Gitee raw 兜底（顺序：GitHub raw → jsDelivr → Gitee raw）
- [ ] `scripts/update.js` 的 `check()` 增加 Gitee Releases API 兜底
- [ ] 实测：发一个 tag → Gitee Releases 页出现同名发行版且附件数与 GitHub 一致

## 8. 更新管控注入

- [ ] **先取证**：确认产物 main.js 里注入代码可用的运行时能力（`require('fs')` / 全局 `fetch` / `__dirname`），据结果定版本上限用"外部清单 + 内联常量"双级还是只用内联常量
- [ ] `patch.js` 补丁组记账：记录当前应用了哪几组（汉化 / 更新管控），还原按组执行，备份始终是官方原文那一份
- [ ] 注入实现「禁止自动更新」：替换 `setFeedURL + checkForUpdates` 调用对为空操作，IPC 契约不变
- [ ] 注入实现「没有字典就拦截」：放行前比对当前版本与已支持版本上限
- [ ] 注入实现「更新后自动汉化」：放行后由工具在新版本目录落地时补打补丁
- [ ] `cli.js` / GUI 增加「禁止自动更新」与「恢复自动更新」两个开关
- [ ] 实测：开启后 GitHub Desktop 不再触发更新检查（开关状态 + 产物字节差异双重取证）；还原后回到官方行为

## 9. 工具自更新接 GUI

- [ ] `gui/main.js`：启动后延迟调用 `update.check()`，有新版则提示（无新版不打扰）；启动时 `cleanup()` 清理 `.old`
- [ ] `gui/main.js`：确认后调用 `update.apply()`，并在失败时给出可读原因
- [ ] 核对 `update.js` 的 `pickAsset()` 与 electron-builder 的 GUI 产物命名是否匹配，不匹配则补齐
- [ ] 实测：存在新版本时 GUI 弹提示；确认后替换成功、重启版本号变化

## 10. 文档同步与提交

- [ ] `AGENTS.md`：字典格式（formatVersion 2）、**字典唯一写入口 `scripts/dict-edit.js`** 的约束、平台分段、在线能力、已知坑
- [ ] `dictionaries/README.md`：格式规范改写为新结构 + 写入口约束
- [ ] `README.md`：组名列、跨平台支持与 Linux 现状、更新管控开关、Gitee 下载渠道
- [ ] `docs/打包与分发.md`：CI 定时字典、Gitee 发版、Secrets 清单
- [ ] 残留检查：旧格式描述、旧术语、`_meta.notes` 里的过期格式说明
- [ ] 固化替换判定探针到 `build/tools/`（判定某处文案可否替换的那些 `tmp/` 临时脚本，清掉即失；`design.md` 已改为只引用判据不引用文件）。**前置**：把 Windows 备份目录与 macOS 产物目录参数化，否则换台机器跑不起来
- [ ] 按 `commit-create` 规范拆分提交（建议按组拆：字典层 / GUI / CI / 注入 / 文档）

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

