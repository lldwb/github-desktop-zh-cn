# dictionaries/ — 语言字典（核心资产）

本目录是仓库的核心资产：**「原文 → 中文」翻译字典**，按 GitHub Desktop 版本目录组织。

## 目录约定

```
dictionaries/
├── 3.6.5/          # 按 GitHub Desktop 版本号分目录
│   └── zh-CN.json   # 该版本的字典
├── 3.6.6/
│   └── zh-CN.json
└── README.md
```

- **版本强对应**：字典必须与 GitHub Desktop 版本一一对应（错配可能导致应用无法启动）；`patch` / `verify` 会校验字典版本与安装版本一致。
- **来源**：`main.js`（主进程）与 `renderer.js`（渲染进程）中硬编码的界面文本（含界面元素、读屏文本、命令行文本、报错文本；不含用户不可见的日志文本）。
- **自定义**：用户可按需在字典中覆盖 / 增补条目——但**改完仍要过 `dict-edit` 的校验**（见下），手工改会绕过它。

## 字典格式（formatVersion 2）

**五段结构**：`common` / `windows` / `macos` / `linux` 四段放条目，`groups` 段放组归属，`_meta` 放元信息。

```json
{
  "_meta": { "version": "3.6.6", "updated": "2026-09-19", "formatVersion": 2, "notes": "……" },
  "common": { "Sign in": "登录", "Discard changes": "放弃更改" },
  "windows": {},
  "macos": { "About GitHub Desktop": "关于 GitHub Desktop" },
  "linux": {},
  "groups": { "通用": ["Sign in"], "菜单-帮助": ["About GitHub Desktop"] }
}
```

- **分段判据**：`common` 段对**所有平台**生效；平台段只对该平台生效。同名键同时在 `common` 与平台段时**平台段优先**（同一文案在不同平台语境不同的场合）。
- **`linux` 段为空是预期**：官方从未发布 Linux 产物（近 30 个 release 的资产全为 Windows nupkg/exe/msi 与 macOS zip）。
- **`groups` 只是分类参考**，不影响替换行为；由 `dict-groups.js` 读产物 sourcemap 推断源文件归属，未定位到的落「待分组」。
- **唯一写入口是 `scripts/dict-edit.js`**（`add` / `update` / `remove` / `set-group` / `move` / `merge` / `regroup` / `migrate` / `apply`）：先校验再原子替换，校验不过时原文件保持不动。**别手工编辑这个 JSON**——手工改绕过校验，坏数据要等 `patch` 时才暴露。要重跑一个已有字典的版本，用 `dict-auto.js --on-exist=diff|overwrite`（`diff` 全程不写盘）。

## 键形态与替换规则

**大小写敏感、精确匹配**。以下规则对每一段内的条目都成立：

- **键 = 官方产物中的完整原文**（必须逐字符一致，含大小写与标点），值 = 中文译文。
- **整串匹配**：仅当字符串字面量内容（或模板字符串的文本段）与键完全相等时才替换，不做子串替换——子串会误伤标识符、协议串与拼接片段。
- **两种键**：
  - **普通键**：对应字符串字面量或模板文本段。模板字面量按文本段收录，如 `` `Fetch ${t}` `` 收录键 `"Fetch "`（含尾随空格）；
  - **整模板键**：以反引号开头结尾、含 `${}` 插值的**完整模板源码**，整段替换。用于运行时拼接的文案（复数是运行时函数拼出来的 `s`、动词由函数返回等），替换值是等价的 JS 模板字面量。例如 3.6.5 中变更列表的复数标签：

    ```json
    {
      "`${GE(e.length)} changed file${xU(e.length)}`": "`${GE(e.length)} 个更改的文件`"
    }
    ```
- **作用域键**：`<文件名>.js|原文`（如 `renderer.js|en-US`）只对该文件生效，用于同一字面量在两个文件中语义不同的情况——`en-US` 在 renderer.js 是相对时间格式化的语言（改成 `zh-CN` 后「4 hours ago」变「4小时前」），在 main.js 是拼写检查的语言判断（必须保留）。应用时去掉前缀，统计按去前缀后的键合并。
- **`_` 开头的键为元信息**（`_meta`），脚本读取时跳过，不影响替换。
- **0 命中告警**：`patch` / `verify` 会列出两个文件中均未出现的条目——可能是条目失效或版本错配，需人工核对（已汉化状态不告警）。

### 已知限制

- **共用字面量的文案**：若某个英文词同时被界面文案与非界面逻辑复用（如 `"Commit"` 既是提交按钮动词、又是 Markdown 议题关闭关键词表与拖拽枚举的取值），整串替换会误伤逻辑——这类文案只能通过**整模板键**替换其外层模板，或保持英文。`"file"` / `"files"` 同属此类（兼作 DOM 类型判断 `"file"===i.type` 与文件计数文案），故历史视图里的 `2 changed files` 保持英文。
- **运行时拼接片段**：由运行时函数拼出的后缀（复数 `s` 等）无法用普通键去掉，必须用整模板键；无法整段覆盖的拼接文案（字面量被多处以不同上下文复用）保持英文。
- **片段拼句子里的代码常量**：个别句子由多个字面量片段拼成，其中某些片段同时是代码里的取值——如提交身份弹层的 `local` / `global` 既是配置范围文案、又是 SVG 属性白名单与调度器常量，只能保留英文，用「」引起来当值读（`你可以更新「local」的 Git 配置…`）。
- **协议常量与库内部标识符**：产物里除界面文案外，还混着 HTTP 头名、存储键、枚举值、第三方库（如 IndexedDB 封装 dexie）的错误名表等**标识符常量**——它们看起来同样是「没翻译的英文」，但一旦翻译就会破坏查表与比较。收录前按下列标准判定：

  | 情形 | 判定 | 例 |
  | --- | --- | --- |
  | 与运行时数据比较/查表，且赋值处与比较处**不同源** | **禁止翻译**（必然故障） | `headers.get("Link")`：译成 `get("链接")` 后 Chromium 抛 `TypeError: … non ISO-8859-1 code point`，分页请求全废 |
  | 只用于显示，或赋值与比较**同源**（两侧同时被替换） | 可翻译 | `"Other"`：分组名兜底、比较、显示是同一批字面量，整组一起变成 `"其他"`，逻辑自洽 |
  | 第三方库内部的常量表，界面用不到 | 不应入字典（无界面价值，只污染） | dexie 的 `["Unknown","Constraint","Data",…]`、`["Modify","Bulk","Schema",…]`；`.gitignore` 之外还有 `localStorage` 键如 `"shell"`、`"zoom-factor"` |

  判定用脚本比人眼可靠：`patch` 后 52 处 `.get(` / `.set(` / `.getItem(` / `process.env[` 类调用的实参应全为 ASCII（含中日韩字符即高危）。
- **仅针对该版本构建产物**：整模板键含构建产物中的局部变量名（如 `GE`、`xU`），仅对该版本该次构建有效——这正是字典与版本强对应的原因之一。

## 术语对照（翻译基准）

对齐 GitHub 官方中文界面术语：Repository→仓库、Branch→分支、Commit→提交、Push→推送、Pull→拉取、Fetch→获取、Merge→合并、Rebase→变基、Cherry-pick→摘取、Clone→克隆、Publish→发布、Discard→放弃、Stash→暂存、Undo→撤销、Revert→还原、Squash→压缩、Pull request→拉取请求、Changes→更改、History→历史、Worktree→工作树、Sign in→登录、Sign out→退出登录、Account→账户、Organization→组织。

品牌名与产品名保留原文：GitHub、GitHub Desktop、GitHub Enterprise、GitHub Copilot、Copilot、Git、Git LFS、SSH、Shell、各编辑器 / 终端名（Visual Studio Code、Sublime Text、Windows Terminal 等）。
