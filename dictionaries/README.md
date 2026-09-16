# dictionaries/ — 语言字典（核心资产）

本目录是仓库的核心资产：**「原文 → 中文」翻译字典**，按 GitHub Desktop 版本目录组织。

## 目录约定

```
dictionaries/
├── 3.6.5/          # 按 GitHub Desktop 版本号分目录
│   └── zh-CN.json   # 该版本的字典
└── README.md
```

- **版本强对应**：字典必须与 GitHub Desktop 版本一一对应（错配可能导致应用无法启动）；`patch` / `verify` 会校验字典版本与安装版本一致。
- **来源**：`main.js`（主进程）与 `renderer.js`（渲染进程）中硬编码的界面文本（含界面元素、读屏文本、命令行文本、报错文本；不含用户不可见的日志文本）。
- **自定义**：用户可按需在字典中覆盖 / 增补条目。

## 字典格式（已定稿）

扁平 JSON：`{"原文": "中文"}`，**大小写敏感、精确匹配**。

```json
{
  "_meta": {
    "version": "3.6.5",
    "updated": "2026-09-16",
    "notes": "……"
  },
  "Sign in": "登录",
  "Discard changes": "放弃更改"
}
```

格式与替换规则：

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
- **`_` 开头的键为元信息**（`_meta`），脚本读取时跳过，不影响替换。
- **0 命中告警**：`patch` / `verify` 会列出两个文件中均未出现的条目——可能是条目失效或版本错配，需人工核对（已汉化状态不告警）。

### 已知限制

- **共用字面量的文案**：若某个英文词同时被界面文案与非界面逻辑复用（如 `"Commit"` 既是提交按钮动词、又是 Markdown 议题关闭关键词表与拖拽枚举的取值），整串替换会误伤逻辑——这类文案只能通过**整模板键**替换其外层模板，或保持英文。
- **运行时拼接片段**：由运行时函数拼出的后缀（复数 `s` 等）无法用普通键去掉，必须用整模板键；无法整段覆盖的拼接文案（字面量被多处以不同上下文复用）保持英文。
- **仅针对该版本构建产物**：整模板键含构建产物中的局部变量名（如 `GE`、`xU`），仅对该版本该次构建有效——这正是字典与版本强对应的原因之一。

## 术语对照（翻译基准）

对齐 GitHub 官方中文界面术语：Repository→仓库、Branch→分支、Commit→提交、Push→推送、Pull→拉取、Fetch→获取、Merge→合并、Rebase→变基、Cherry-pick→摘取、Clone→克隆、Publish→发布、Discard→放弃、Stash→暂存、Undo→撤销、Revert→还原、Squash→压缩、Pull request→拉取请求、Changes→更改、History→历史、Worktree→工作树、Sign in→登录、Sign out→退出登录、Account→账户、Organization→组织。

品牌名与产品名保留原文：GitHub、GitHub Desktop、GitHub Enterprise、GitHub Copilot、Copilot、Git、Git LFS、SSH、Shell、各编辑器 / 终端名（Visual Studio Code、Sublime Text、Windows Terminal 等）。
