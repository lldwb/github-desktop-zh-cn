# 字典 2.0（结构化 / 跨平台 / 自动化） · 设计

## 方案对比

### 一、字典结构化的三种改法

三个方案都满足"把平台归属与分组变成数据"，差别在**改动面**与**体积**。取证见下方「可行性依据」。

| 方案 | 思路 | 可行性 | 代价 | 结论 |
|------|------|--------|------|------|
| **A 单文件分段** | 顶层分 `common` / `windows` / `macos` / `linux` / `groups` 五段，条目仍是 `"原文": "译文"`，运行时合并 `common` ∪ 当前平台段 | 已核证：所有消费方都经 `loadDict()` → `buildEntries()` 一个咽喉，改这一个函数即可 | 改 2 处（`buildEntries` + GUI 一列）；体积 133.8 KB → **124.7 KB（0.93×）**；老格式靠 `formatVersion` 回退 | **采用** |
| B 每条内联元数据 | 每条变成 `{ "zh": ..., "os": [...], "group": ... }` 对象 | 可行但**作用域键机制要重做**：`renderer.js\|en-US` 的 `\|` 前缀是键名里的隐式约定，要"真结构化"就得拆成字段，于是 `SCOPED_KEY` / `splitScopedKey` / `scopedEntries` / `reverseEntries` 全改，影响面从咽喉扩散到 5 个上游脚本 | 改 5 上游 + 咽喉；体积 133.8 KB → **233.3 KB（1.74×）**，且这份体积要进单文件产物的内嵌资源、并每次在线拉取 | 不采用：代价与收益不成比例 |
| C 每平台一文件 | 拆成 `common.json` / `windows.json` / `macos.json` / `linux.json` / `groups.json` | 可行但影响面最大：`dictFile` / `dictAssetKey` / `readDictSource` / `embeddedAsset` / `embeddedDictVersions` / `listDictVersions` / `remoteDictUrls` / `dict-sync` 八个函数 + `build.js` / `build/check-gui-dist.js` / `gui/main.js` 三个构建播种点全改 | 在线汉化一次要下 5 个文件，**原子性需新设计**（读到第 3 个失败怎么办？部分生效比整体失败更糟）；破坏 `build.js` 已写明的"只内嵌最新版一个文件、产物保持单文件"取舍 | 不采用：619 条三平台共有条目要么复制 3 份、要么再加一层——后者正是方案 A 的分段搬到文件系统上，多付了文件系统与原子性的代价却什么都没多得到 |

### 选型理由（为什么是 A）

1. **改动面与收益的比值最高**。`patch` / `restore` / `verify` / `scan` / `cli` / `dict-sync` 六个脚本**一行都不用改**——它们的入口是 `loadDict()` 返回的 `Map<键, 译文>`，而新格式的解析差异被 `buildEntries` 完全吸收。B 与 C 都要把这层封装捅穿。
2. **A 是唯一让体积下降的方案**。133.8 KB → 124.7 KB（0.93×），因为 `_meta.notes` 里那段描述格式的自然语言长句被结构化的 `formatVersion` 取代。这份字典要内嵌进单文件产物（分发体积直接影响下载）并每次在线拉取，体积不是小事。B 的 1.74× 是实打实的成本。
3. **向后兼容是硬需求**。本仓库有"外部字典优先"的设计（`common.js:30`），用户可能自己替换或自定义字典。A 靠 `_meta.formatVersion` 一处分派就能让旧的扁平字典继续工作；B 与 C 是破坏性的，用户手里的自定义字典会直接失效。
4. **作用域键不动**。`renderer.js|en-US` 这类键（3.6.6 里 106 条）解决的是"同一字面量在两个文件中语义不同"的真实问题（`en-US` 在 renderer 是相对时间语言、在 main.js 是拼写检查逻辑）。A 完整保留它，B 则要把它一起重做——这是为结构化而结构化的代价。
5. **方案 A 的唯一短板由新增的维护脚本来补**。A 的弱点是 `groups` 段与条目段分处两地、靠键名关联，键改名忘了同步就会漂移。需求方追加的约束"加脚本来维护字典、改后一致性校验、失败即回滚"正好是这道题的答案：**同一个写入口负责同步校验两段的一致性**。B/C 并不因为"更结构化"就免掉这个问题。

### 二、其余环节的备选（均已定案）

| 环节 | 备选 | 结论 |
|------|------|------|
| 组名来源 | ①自动推断 ②导入参考工具 ③自动 + 人工覆盖位 | 采用①。需求方明确"只做自动推断，分组只是作为参考"。参考工具的键是含源码上下文的片段（`label:(h?"Hide":"Show")+" Toggle Chan&ges Filter"`），与"键即产物字面量"不同构，导入需要额外映射且覆盖不全 |
| CI 产出边界 | ①只产待译清单 ②继承 + AI 全自动 ③继承 + 开 PR 待人工 | 采用②。需求方明确"自动继承 + 全自动含机器翻译"，AI 走 OpenAI 兼容协议（Secrets：base url / key / model）。质量护栏放在**准入门槛**上而非人工环节：AI 译文必须通过 `dict-edit validate` 与产物干跑（语法 + 命中率阈值）才允许提交 |
| 更新管控形态 | ①注入 GitHub Desktop 内联检查 ②常驻后台守护 ③系统计划任务 | 采用①。需求方明确"通过注入 GitHub Desktop，更新时检查是否有更新 → 判断是否有字典 → 没有字典就拦截"。②③需要常驻进程 / 管理员权限，而注入方案复用既有的补丁与还原机制，零额外常驻开销 |
| 平台分段依据 | ①按「哪些平台命中」分（common + 独有段）②按平台完整列出（各存全量） | 采用①。参考工具的数据天然是这个形状（619 共有 + 36/185/6 独有）；②要让 619 条共有条目复制 3 份，体积约 2.2× |

## 选定方案

### 1. 字典格式 formatVersion 2

```json
{
  "_meta": { "version": "3.6.6", "formatVersion": 2, "updated": "2026-09-18", "notes": "…" },
  "common":  { "&File": "文件", "renderer.js|en-US": "zh-CN" },
  "windows": { "label:\"Open &with…\"": "label:\"打开方式…\"" },
  "macos":   { "label:\"File\"": "label:\"文件\"" },
  "linux":   { "Show in your File Manager": "在文件管理器中打开" },
  "groups":  { "菜单-文件": ["&File", "label:\"Open &with…\""], "待分组": ["renderer.js|en-US"] }
}
```

**解析规则**（`buildEntries`）：

- `_meta.formatVersion === 2` → 合并 `common` ∪ `<平台段>`；平台名由 `process.platform` 映射：`win32`→`windows`、`darwin`→`macos`、`linux`→`linux`，**未知平台只取 `common`**（宽容降级，不抛错）。
- `formatVersion` 缺失或为 1 → 按现有扁平逻辑遍历顶层（跳过 `_` 开头的键）。
- 键在段间重复视为**非法**（由 `dict-edit validate` 与 `buildEntries` 双重拦截）——若放任，合并时后写入者静默覆盖前者，是分段格式特有的新失效模式。
- `_meta` 与 `groups` 段的键以 `_` / 段名白名单识别，不参与替换（`buildEntries` 只遍历白名单内的条目段，不再依赖"`_` 开头"这一条约定）。

**迁移时的条目归属**：扁平字典整体进 `common`，**不按提取来源塞进平台段**。现有 1867 条虽是从 Windows 产物提取的，但其中绝大多数是三平台共有的文案；在拿到 macOS 产物、能算出真实键集合差集之前就按来源归属，等于让 macOS / Linux 用户拿到一份 `common` 为空、平台段又对不上的字典。分平台只在有跨平台对比证据时做（见「跨平台字典产出」）——"有证据再分流"比"先分摊再纠正"代价小得多，而且不必冒迁移期破坏跨平台可用性的风险。

### 2. 维护脚本 `scripts/dict-edit.js`（字典的唯一写入口）

**约束**：字典的一切修改经由本模块暴露的函数完成。AI 与其它工具**只调用这些方法**，不直接读写 JSON 文件。这条约束要写进 `AGENTS.md` 与 `dictionaries/README.md`。

**事务模型**（这是"校验失败即回滚"的实现）：

```
读原文 → 内存中变更 → validate(内存) → 序列化 → 写 <file>.tmp
   → 读回 .tmp 重新 parse + validate → renameSync(.tmp, file) → 写后读回复核
```

任一步失败：删除 `.tmp`、**原文件从未被改动**、抛出携带 `problems` 的错误。这样"回滚"不需要恢复动作——最可靠的回滚是不制造需要回滚的状态。`renameSync` 在同一分区上原子，写后读回复核覆盖"rename 成功但内容意外"的残余风险。

**一致性校验清单**（`validate(version)` → `{ errors, warnings }`）：

| 级别 | 检查项 |
|------|--------|
| error | `_meta.version` 存在、为字符串、与所在目录名一致 |
| error | `_meta.formatVersion === 2` |
| error | `common` / `windows` / `macos` / `linux` / `groups` 五段齐全且皆为对象 |
| error | 每条译文为非空字符串 |
| error | 整模板键（以反引号开头）的译文首尾同为引号或反引号（沿用现规则） |
| error | **键在段间不重复** |
| error | 作用域键的文件名只能是 `main.js` / `renderer.js` |
| error | 平台段名只能是 `windows` / `macos` / `linux` |
| error | `groups` 段引用的每个键都能在某个条目段找到 |
| warning | 存在未被任何组覆盖的条目（提示，不阻断——分组只是参考） |
| warning | 存在译文与原文完全相同的条目（可能是漏译） |

### 3. 组名自动推断 `scripts/dict-groups.js`

输入：安装目录的 `renderer.js.map` / `main.js.map`（官方产物自带，`scan.js` 已在用同一来源）。输出：`groups` 段。

推断顺序：

1. 键（去掉作用域前缀）在 `main-process/menu/build-default-menu.ts` 的源码里命中 → `菜单-<父菜单>`（父菜单取该菜单块 label 的译名：文件 / 编辑 / 视图 / 仓库 / 分支 / 帮助 / 应用）；能确定是菜单项但定不了父菜单 → `菜单`。
2. 否则按命中所在源文件的路径**最长前缀**归类：`ui/welcome/` → 开始页、`ui/preferences/` → 设置、`ui/changes/` → 更改、`ui/history/` → 历史、`ui/branches/` → 分支、`ui/clone-repository/` → 克隆、`ui/about/` → 关于、`lib/` 与 `ui/lib/` 与 `models/` → 通用、`ui/` 下其余（复用件与基础件）→ 通用、`main-process/`（非菜单）→ 主进程，等等——完整表见脚本的 `DIR_GROUPS`。未列入的目录落 `待分组`——**不猜**，猜出来的组名比「待分组」更误导。唯一的兜底例外是 `ui` / `main-process` 两个前缀：新增的 ui 子界面会被归入「通用」而非「待分组」，取舍见下方修正第 4 条。
3. 都未命中 → `待分组`。

匹配方式沿用 `scan.js` 的口径（折叠空白 + 忽略大小写），因为产物文案经 `sentenceCase` 处理，与源码的 Title Case 不同。

**实现期的四处修正**（原设计未预见，都是实测逼出来的）：

- **产物侧索引不用产物文件建**。设计初稿是「从安装目录提英文字面量建索引」，但取组名时安装目录已处于汉化态，提出来全是中文。改为**直接用字典键本身**建产物侧索引——键即产物原文，等价且无此问题。
- **JSX 文本节点要跨行取，且边界是 `>`/`}` 与 `<`/`{`**。初版按「单行内 `>` 到 `<`」提取，只覆盖 830 条；漏掉的是多行 JSX 文本（`\n  A force push will rewrite…` 在产物里折叠成一句）与插值两侧的半句（`Do you want to … at {url}?` 的 `" Do you want to … at "`）。按 JSX 编译规则整体取出再折叠空白后，定位数 830 → 1398。只对 `.tsx`/`.jsx` 做——`.ts` 里的 `>` `<` 是泛型与比较运算符。
- **菜单归属必须按引用关系传播，不能按源码位置就近归属**。`build-default-menu.ts` 不是一个大字面量，而是「定义菜单项变量 → 收进数组变量 → `template.push({label, submenu})` 组装」，还有 `const fileItems = fileMenu.submenu` 这类别名在块外继续 push。按位置归属会把定义在分支菜单之后、却属于帮助菜单的项误判。解析器做三级传播（顶层菜单 → submenu（内联数组或数组变量）→ 元素（内联对象或变量））+ 别名追踪。**官方若改了该文件的写法，解析会失效——此时降级为 `菜单` 组，不报错**（分组只是参考，不值得让整条链路失败）。
- **归一化与归类边界的四处细节**：① 助记符 `&`——源码 label 带它（`&File`），产物里被剥掉，两侧都要 `replace(/&/g, '')` 才比得上（初版只去了字典侧的开头 `&`，等于永远匹配不上，白白丢 30 条）；② 顶层菜单自身的 label 也要进表，否则 `&File` 这类菜单标题自己反而没有具体归属；③ `main-process/menu/build-test-menu.ts` **按文件级映射摘出「菜单」组**——它把各对话框与横幅的标题做成一键打开的按钮，其"菜单项"实为标题文案，归「菜单」会误导（`build-spell-check-menu.ts` 是用户可见的右键菜单，留在「菜单」组）；④ `ui` / `main-process` 作兜底前缀的取舍：`ui` 根下的文件与未收录的子目录（`dialog`、`editor`、`shell`、`octicons`…）都是跨界面复用件，归「通用」比归「待分组」贴切，代价是未来新增的 ui 子界面会被静默吞进「通用」——接受这个代价，因为分组只是参考，而让 40 多个基础件目录落「待分组」会让这个信号失真。要单独成组在 `DIR_GROUPS` 加一行即可。

**覆盖率的诚实边界**：1867 条中 1398 条定位到来源，363 条落 `待分组`。其中 137 条是整模板键（见下），其余 226 条**确认不在 `app/src/**` 的 sourcesContent 里**——相对时间词条（`1 day`、`{{count}} days`、`about 1 hour`）来自 i18n 语言包，`Cancel`/`Close` 一类基础词与 `Checking mergeability…` 在 780 个自有源文件中均无对应字面量（sourcemap 的 `sourcesContent` 无缺失，是文本本身来自打包进产物的第三方依赖或运行时拼装）。这不是提取缺陷，是数据边界。

> 整模板键（反引号开头）一律落 `待分组`：其插值变量名在构建时被重命名，源码与产物对不上。`scan.js` 出于同一原因也跳过它们。

### 4. 跨平台字典产出

macOS 平台段的来源是**官方 macOS 产物**（`GitHub.Desktop-x64.zip` / `-arm64.zip`），不是参考工具的数据。CI 与本地都按同一链路取：

- Windows：`GitHubDesktop-<版本>-x64-full.nupkg` → `lib/net45/resources/app/{main.js,renderer.js}`
- macOS：`GitHub.Desktop-<arch>.zip` → `GitHub Desktop.app/Contents/Resources/app/{main.js,renderer.js}`
- Linux：**官方不发产物**，段保持为空，直到有可靠的社区产物来源

取法用 HTTP Range：先取尾部窗口解析 zip 中央目录拿到条目偏移与压缩方式，再对目标条目发起 Range 请求 + `inflateRaw` 解压。实测 nupkg 尾部窗口可解析出 1301 条、macOS zip 2340 条，两个目标条目均已定位到（nupkg 的 `main.js` 77 KB 压缩 / `renderer.js` 797 KB 压缩）。

**实测得到的平台差异（三类）**——拿 macOS 产物 3.6.6-beta2 与 Windows 产物 3.6.6 逐字面量对比：

| 差异 | Windows 侧 | macOS 侧 | 对字典的影响 |
|---|---|---|---|
| 助记符 `&` | `&File` / `Cu&t` | `File` / `Cut` | 字典里 65 条含 `&` 的键在 macOS 上**全部失效**，须补剥掉 `&` 的变体 |
| 大小写惯例 | sentence case（`Amend commit…`） | Title Case（`Amend Commit…`） | renderer.js 的 label 里 56 条属此类，逐条补写；Electron role 的默认 label 在 macOS 上另为小写（`cut`/`copy`/`push`） |
| 平台专有文案 | `Show in Explorer` | `Show in Finder` | 两平台各写各的，**不可互相继承** |

> **同类对比必须用同一版本的两平台产物**。上表三项差异是**结构性**的、与版本无关，故这个参照仍成立；但据此判定「某键是否平台专有」就不行了——版本差异会混进来（3.6.6 新增的 `AI credits used`、`Completeness indicator` 会被误判成 Windows 专有），还叠加了整模板键的插值变量重命名差异与子串误报（`Explorer` 命中 `S&how logs in Explorer` 内部）。按此口径做的一次性核对得出的 36 条清单因此**未用于调整段归属**，留给第 6 组用同版本产物自动判定（见 `tasks.md` 未完成项）。

根因是 webpack DefinePlugin 按 `__DARWIN__` 折叠死代码（源码写 `__DARWIN__ ? 'Copy' : '&Copy'`），两个平台的产物各只留下一个分支。所以**每一处平台分叉的 UI 文案，在字典里都需要两条键**——这是分段格式存在的根本理由，不是可以靠"多收点词"绕开的。

`macos` 段当前 **96 条**（30 条 Windows 助记符键的 macOS 变体 + 18 条 macOS 专有文案 + 48 条 Title Case 菜单项），全部经 `dict-edit` 事务写入。实测效果：macOS 产物 main.js 菜单 label 汉化 93/98、renderer.js label 汉化 164/175；未汉化的 11 处为技术标识（`URL`/`Type`/`bearer`/`Copilot`）或高风险项（`Rebase`/`Arguments`），均为有意保留；**Windows 侧条目数不受影响**（平台隔离成立）。剩余缺口（renderer.js 里非 label 的 Title Case 文案）交由第 6 组的产物驱动流程自动发现，不靠人工枚举。

**不能替换的键：`stringLiterals` 扫出的英文文案 ≠ 可替换**。已确认会改坏代码的形态（有逐处上下文证据）：

| 形态 | 举例 | 替换后果 |
|---|---|---|
| 模块导出名 | `Object.defineProperty(t,"File",…)` | `require` 取不到该导出 |
| TS 枚举反向映射 | `e[e.Push=1]="Push"` | 枚举名被改，反向查找错乱 |
| 类型判定的字符串比较 | `"Arguments"===n` | 比较恒为假，`Object.prototype.toString` 分支失效 |
| Electron role 值 | `role:"cut"` | 菜单 role 失效 |
| Node 事件名 | `process.on("exit")` | 监听器永不触发 |
| SVG 属性名白名单 | `"view"` | 属性被校验拒绝 |
| 命令行参数名 | `getArg(e,"file",null)` | 参数解析失配 |

判据是**看出现位置的上下文**（前 80 / 后 16 字符），而不是看文案长相——同一个 `File` 既可能是菜单项也可能是模块导出名。上表是逐处人工核对（一次性探针，未入库）的结论；复核时按上述判据取每处出现的上下文重走一遍即可。

### 5. CI 定时字典（`.github/workflows/dict-auto.yml`）

`on: schedule`（每日）+ `workflow_dispatch`（可指定单个版本或版本列表，用于回填）。

流程：解析目标版本 → 已有字典则跳过（幂等）→ 取两平台产物提取 → `scan` 出各平台候选键 → **继承**上一版字典中仍存在的原文的译文 → 新增键走 AI 翻译（OpenAI 兼容协议，`fetch` 到 `${AI_BASE_URL}/chat/completions`）→ `dict-edit` 写入并校验 → 产物干跑（`patch --dry-run` + 语法校验 + 命中率阈值）→ 通过则提交，不通过则开 issue 并保留产物供人工处理。

护栏：AI 译文在**提交前**必须过 `dict-edit validate` 与干跑阈值。不达标不提交——自动化不能成为降低字典质量的理由。

### 6. Gitee 发版与检查更新优先级

`build.yml` 的 `release` job 之后新增步骤，用 Gitee OpenAPI v5：`GET /repos/{owner}/{repo}/releases/tags/{tag}` 探测是否已存在（幂等）→ `POST /releases` 创建 → 逐附件 `POST /releases/{id}/attach_files`。凭据走 Secrets 的 `GITEE_TOKEN`（Gitee 私人令牌）。

检查更新顺序：字典走 `GH_RAW` → `GH_CDN` → **Gitee raw**；工具自更新走 GitHub Releases API → Gitee Releases API。Gitee 的 tag 由镜像自动同步（实测 `/tags` 已有 v0.1.0 / v0.1.1），**但 Releases 不同步**（实测 `/releases` 返回 `[]`，与需求方截图一致），所以发行版必须由流水线显式创建。

### 7. 更新管控（注入）

注入点在 main 进程的更新链路，实测产物中的锚点：

```
async checkForUpdates(e){try{r.autoUpdater.setFeedURL({url:await me(e)}),r.autoUpdater.checkForUpdates()}catch(e){return e}}
quitAndInstallUpdate(){r.autoUpdater.quitAndInstall()}
```

`setFeedURL` 在整份 main.js 里**唯一命中**，是理想的锚点。

- **禁止 / 恢复自动更新**：把上面 checkForUpdates 函数体里的 `setFeedURL + checkForUpdates` 调用对替换为空操作（`void 0`）。IPC 通道契约不变、不报错，只是什么都不做。恢复走既有备份 / 还原机制。
- **没有字典就拦截**：注入的检查需要在放行前知道"目标版本"。产物里 `update-available` 回调**忽略了版本参数**，注入代码拿不到；因此改为**在调用 `checkForUpdates` 之前先比对版本上限**：当前版本 vs 工具已知的"已支持版本上限"，超过则不放行。
- 版本上限的传递方式按可靠性分两级：优先读工具写入的外部清单文件（若产物里 `fs` 可用），读不到则用**内联常量**（工具每次打补丁时把当时的已支持版本写进注入代码）。内联常量方案零运行时依赖，是这个场景下最稳的形态。
- **补丁可独立开关**：汉化与更新管控是两组独立替换，却共用同一份官方原文备份。`patch.js` 需要按补丁组记账（记录"当前应用了哪几组"），否则"只禁更新不汉化"与"只汉化不禁更新"无法分别还原。

> **待验证项**：注入代码在产物 main.js 里的运行时可依赖能力（能否 `require('fs')` / 用全局 `fetch`）尚未取证。这一条决定版本上限用"外部清单 + 内联常量"双级还是只用内联常量，实现期第一步验证。

### 8. 工具自更新接 GUI

`scripts/update.js` 的 `check` / `apply` / `pickAsset` / `cleanup` 已完整，CLI 菜单已用。GUI 侧补：启动后延迟检查 → 有更新则弹提示 → 确认后 `apply`（成功后进程退出、新版本接管）→ 启动时 `cleanup` 清理 `.old` 残留。`pickAsset` 目前只认 `.exe`（win32）与 `.bin`/无扩展名，与 electron-builder 的 GUI 产物命名不同，需一并核对。

## 接口与数据结构

### `scripts/dict-edit.js`

```js
// 只读
read(version)                          → { meta, common, windows, macos, linux, groups }
validate(version)                      → { errors: Problem[], warnings: Problem[] }
query(version, { platform, group, keyword }) → Entry[]

// 事务写：ops 一次性应用，全部成功或全部不落盘
apply(version, ops, { dryRun })        → { ok: true, changes: Change[], warnings: Problem[] }

// 便捷单操作（内部都走 apply）
add(version,    { key, zh, platform = 'common', group })
update(version, { key, zh, platform })
remove(version, { key, platform })
setGroup(version, { key, group })
moveTo(version, { key, from, to })     // 平台段间搬迁

// 迁移 / 互通
mergeIn(version, flatObject, { platform, group })  // 批量导入（继承旧字典、迁移用）
exportFlat(version, { platform })                  // 导出扁平（对照参考工具 / 兼容旧消费方）
migrate(version)                                   // 扁平 → formatVersion 2
```

`Problem`：`{ level: 'error'|'warning', code: string, key?: string, detail: string }`
失败时抛出的 `Error` 带 `problems: Problem[]`，调用方能打印具体原因。

`platform` 取值：`'common' | 'windows' | 'macos' | 'linux'`。

### `common.js` 变化

- `buildEntries(raw, version, platform)` 增加 `platform` 参数（默认取 `process.platform` 映射），按 `formatVersion` 分派。
- `loadDict(version, platform)` 透传。
- 新增 `PLATFORM_NAME`（`process.platform` → 段名）与 `PLATFORM_SEGMENTS` 常量，作为 SSOT。
- `remoteDictUrls(version)` 增加 Gitee raw。
- **`dictFile` / `dictAssetKey` / `readDictSource` / `embeddedAsset` / `embeddedDictVersions` / `listDictVersions` 全部不变**——文件名仍是 `zh-CN.json`。

### GUI

- `gui/index.html` 表头加 `<th class="col-group">组名</th>`。
- `gui/main.js` 的 `collectDictEntries()` 从 `common.read()` 拿 `groups`，建"键 → 组名"反查表，行数据加 `group` 字段（查不到则 `待分组`）。
- `gui/renderer.js` 的 `renderRows` 增加一列。

## 影响面

**必须改**：

| 文件 | 改动 |
|------|------|
| `scripts/common.js` | `buildEntries` / `loadDict` 加平台参数与格式分派；新增平台常量；`remoteDictUrls` 加 Gitee |
| `scripts/dict-edit.js` | **新增**（字典唯一写入口） |
| `scripts/dict-groups.js` | **新增**（组名推断） |
| `scripts/cli.js` | `RUNNERS` 加 `dict` / `groups` 子命令 |
| `gui/main.js` / `gui/index.html` / `gui/renderer.js` | 组名列 + 自更新接线 |
| `dictionaries/3.6.6/zh-CN.json` | 迁移为 formatVersion 2 |
| `.github/workflows/dict-auto.yml` | **新增** |
| `.github/workflows/build.yml` | release 后加 Gitee 发版步骤 |

**不用改**（新格式对它们是透明的）：`patch.js` / `restore.js` / `verify.js` / `scan.js` / `dict-sync.js` / `build.js` / `build/check-gui-dist.js` / `package.json`。

**测试**：`test/dict-scope.test.js` 补新格式用例；新增 `test/dict-edit.test.js`（校验与回滚）、`test/dict-groups.test.js`（菜单解析与目录归类）。依赖安装目录的集成用例在本机无 GitHub Desktop 时自动跳过。

**文档**：`AGENTS.md`（字典格式、写入口约束、在线能力、已知坑）、`README.md`、`docs/打包与分发.md`、`dictionaries/README.md`。

## 风险与对策

| 风险 | 触发条件 | 对策 |
|------|---------|------|
| 分段后同键在多段重复，合并时静默覆盖 | 人工或 AI 迁移时把同一条同时留在 `common` 与平台段 | `validate` 列为 error；`buildEntries` 也拦截并报错，不静默取后写入者 |
| 迁移改变既有行为 | 迁移脚本把某条放错段、或漏掉作用域键前缀 | 迁移后强制对拍：旧扁平字典与新分段字典在同一产物上的 `patch --dry-run` 命中数与键集合必须完全一致，不一致即失败 |
| AI 译文质量不可控 | CI 自动翻译新增文案 | 提交前必须过 `validate` + 产物干跑（语法 + 命中率阈值）；不达标不提交，转 issue 留人工 |
| 注入代码在产物里跑不起来 | 产物 bundle 的运行时与预期不符 | 实现期第一步先取证可用能力；版本上限默认用内联常量（零依赖），外部清单作为增强 |
| 汉化与禁更新补丁互相覆盖 | 两组替换共用一份备份，却有独立的开关需求 | 补丁组记账（记录已应用哪几组），还原按组执行；备份始终是官方原文那一份 |
| Gitee 附件上传失败 / 超限 | 产物体积大或令牌权限不足 | 发版步骤幂等且逐附件独立，单个失败不回滚 GitHub Release；失败在日志中明确到文件名 |
| 官方产物结构变化 | 官方换打包方式或路径 | 提取失败时 CI 报错退出并开 issue，不产出半成品字典 |
| macOS 段长期为空被误认为"支持了 macOS" | Linux 无官方产物是事实，macOS 有但不一定有字典 | `verify` 在目标平台段为空时明确提示"该平台暂无字典条目"，不静默通过 |

## 可行性依据

- 字典消费咽喉：`scripts/common.js:275 buildEntries` 是唯一遍历顶层对象的位置；`patch.js:78,93` / `restore.js:57,65` / `verify.js:65,76` / `scan.js:84,87` / `gui/main.js:91` 全部经 `loadDict` + `scopedEntries`/`reverseEntries`，不碰 JSON 结构。
- 体积实测：当前 133.8 KB（gzip 45.4 KB）；方案 A 分段 124.7 KB（0.93×）；方案 B 同内容 233.3 KB（1.74×）。
- 跨平台差异实测：参考工具 `Windows.zh` 888 / `Mac.zh` 846 / `Linux.zh` 846；三平台共有 619；Windows 独有 36、macOS 独有 185、Linux 独有 6；同键异译 Windows↔macOS 仅 1 条（玩笑式）、macOS↔Linux 0 条。本仓库 3.6.6 字典 1867 条中 65 条含 `&`。
- 产物内路径与取法实测：Windows nupkg 内 `lib/net45/resources/app/{main,renderer}.js`（压缩 72 / 797 KB，本地头偏移 296684471 / 297639279）；macOS zip 内 `GitHub Desktop.app/Contents/Resources/app/{main,renderer}.js`；Release 资产支持 Range（HTTP 206，`accept-ranges: bytes`）。
- 官方平台覆盖实测：近 30 个 release 的资产全为 Windows nupkg / exe / msi 与 macOS zip，**无任何 Linux 产物**。
- 自动更新锚点实测：`main.js` 中 `setFeedURL` 唯一命中一次，所在函数为 `checkForUpdates`；`renderer.js` 中更新源为完整字面量 `https://central.github.com/api/deployments/desktop/desktop/latest?version=3.6.6&env=production`，检查间隔 4 小时，启动时与定时各触发一次。
- Gitee 能力实测：`POST /repos/lldwb/github-desktop-zh-cn/releases` 存在（无 token → 401「登录失效，无权限访问该资源」）；`GET /releases/tags/v0.1.1` → 200 `null`；`GET /tags` 已含 v0.1.0 / v0.1.1；`GET /releases` → `[]`。
