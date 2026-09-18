# 字典 2.0（结构化 / 跨平台 / 自动化） · 提案

## 背景

本仓库的核心资产是 `dictionaries/<版本>/zh-CN.json`——一份**扁平**的 `{"原文": "中文"}` 映射，当前 3.6.6 版有 1867 条。它支撑汉化 / 还原 / 校验 / 自查四条链路，但形态与覆盖面已经跟不上使用：

- **只有 Windows 形态**。字典 1867 条里有 65 个键含 `&` 加速键（如 `"&File"`），是 Windows 菜单的字面量；macOS 产物的菜单标签没有 `&`（`label:"File"`），这些键在 macOS 上**一条都命中不了**。参考工具 `GithubDesktopZhTool` 的数据印证了差异的量级：三平台共有 619 条，Windows 独有 36 条、macOS 独有 185 条、Linux 独有 6 条——差异**不在译文，在键的集合**。
- **没有分组信息**。参考工具的字典面板有「组名」列（菜单 / 菜单-帮助 / 开始页 / 待分组 …），本工具的表只有英文 / 中文 / 类型三列，1867 条平铺，核对译文时无从按界面区域定位。
- **格式语义靠约定**。作用域（`renderer.js|en-US`）靠键里有没有 `|` 隐式表达，格式说明写在 `_meta.notes` 的自然语言长句里；`groups` 这类新维度无处安放。
- **维护与发版全靠手工**。官方发新版 → 人工提取产物、人工 diff、人工补译、人工改 `_meta`、人工发版、人工把新字典内嵌进产物。官方更新后用户装的汉化**直接丢失**，且没有任何机制在"字典还没跟上"时拦住这次更新。
- **分发依赖单一渠道**。仓库已配 Gitee 镜像（自动同步 commit / 分支 / tag），但 Gitee 的 Releases 是空的——镜像不同步发行版，国内用户下载产物仍要翻 GitHub。

需求方（仓库维护者）提出 7 项诉求：①字典面板加「组名」列；②解决三平台翻译逻辑差异；③字典从扁平改结构化便于管理；④Gitee 镜像发版（检查更新优先 GitHub、再 Gitee）；⑤GitHub Actions 定时任务在官方更新时自动产出字典，并支持回填历史版本；⑥禁止 / 恢复 GitHub Desktop 自动更新，且更新后自动汉化（**没有对应字典就不更新**）；⑦工具自更新（启动时检查并提示）。

## 目标

- **G1 结构化**：字典从扁平改为**单文件分段**（`common` + `windows` / `macos` / `linux` + `groups`），平台归属与分组成为数据结构的一部分，不再是键名里的隐式约定。
- **G2 唯一写入口**：字典的**一切修改**经由新增的维护脚本完成；脚本对 AI 与工具暴露**函数方法**，不暴露"直接改 JSON"的路径。每次修改做一致性校验，**校验失败即回滚并返回结构化原因**。
- **G3 跨平台**：一份字典同时服务 Windows / macOS / Linux，各平台只应用属于自己的条目；macOS 与 Linux 的汉化不再是空白。
- **G4 组名可读**：字典面板新增「组名」列，组名由脚本从官方产物 sourcemap **自动推断**（仅作核对参考，不参与替换）。
- **G5 自动产出**：CI 定时任务检测到官方发新版时，自动提取产物、**继承上一版仍有效的译文**、对新增文案调 AI 翻译，产出并提交新字典；支持 `workflow_dispatch` 回填历史版本。
- **G6 双渠道发版**：GitHub Release 发布后由流水线**同步发布到 Gitee**；工具与字典的检查更新顺序为 GitHub → Gitee。
- **G7 更新管控**：向 GitHub Desktop 产物注入检查逻辑——官方有新版时先看**目标版本有没有字典**，没有就拦截这次更新；有则放行，并在更新后自动重新汉化。
- **G8 工具自更新**：GUI 启动时检查工具自身更新并提示（CLI 菜单已有，本次补齐 GUI）。

## 范围

- **做**：
  - `dictionaries/<版本>/zh-CN.json` 改为 formatVersion 2 的分段结构；`common.js` 的 `buildEntries` / `loadDict` 支持新格式，**旧扁平格式继续可读**（按 `_meta.formatVersion` 回退）。
  - 新增 `scripts/dict-edit.js`：字典的**唯一写入口**，暴露 `read` / `validate` / `apply` / `add` / `update` / `remove` / `setGroup` / `moveTo` / `mergeIn` / `exportFlat`，事务式写入 + 校验 + 回滚。接入 `cli.js` 子命令与 `RUNNERS`。
  - 新增 `scripts/dict-groups.js`：从产物 sourcemap 自动推断组名，写入 `groups` 段。
  - 现有 3.6.6 字典经迁移脚本从扁平转成分段（迁移本身也走 `dict-edit`），并从官方 macOS 产物补齐 macOS 平台段。
  - `gui/` 字典表格加「组名」列；`gui/main.js` 的 `collectDictEntries` 读 `groups`。
  - 新增 `.github/workflows/dict-auto.yml`：`schedule` + `workflow_dispatch`，取官方产物（HTTP Range 只取 main.js / renderer.js，不下整包）→ 以历史字典的键为锚核对新产物形态（继承）→ 官方新增的 JSX 文案走 AI 翻译 → `dict-edit` 写入校验 → 提交。
  - `build.yml` 的 `release` job 后新增 Gitee 发版步骤（Gitee OpenAPI v5，`access_token` 走 Secrets）。
  - `common.remoteDictUrls()` 增加 Gitee raw 兜底；工具自更新检查增加 Gitee 兜底。
  - 更新管控：新增注入补丁（禁止自动更新 / 更新前查字典 / 放行后自动汉化），并入 `patch.js` 的补丁链，可独立开关与还原。
  - `gui/` 接线工具自更新（启动检查 + 提示 + `update.apply`）。
  - 文档同步：`AGENTS.md`、`README.md`、`docs/打包与分发.md`、`dictionaries/README.md`。
- **不做**：
  - **不做 GUI 内的字典编辑**（增删改行）。字典的唯一写入口是 `scripts/dict-edit.js`，GUI 表格保持只读——这是刻意保留的约束，不是待办。
  - **不做 Linux 官方产物的自动提取**。实测官方近 30 个 release **只发 Windows 与 macOS，没有任何 Linux 产物**；Linux 版由社区维护，其字典条目在有人提供产物前保持为空段，不猜、不从第三方抄。
  - **不从参考工具 `GithubDesktopZhTool` 导入译文**。它的键是含源码上下文的片段（如 `label:(h?"Hide":"Show")+" Toggle Chan&ges Filter"`），与本仓库"键即产物字面量"的模型不同构；将它的数据当参考，不当作数据源。
  - **不做字典的人工分组覆盖**。组名只做自动推断，`groups` 段由脚本重建，不保留人工改写的位子。
  - **不改动**现有 CLI 子命令与 SEA 单文件产物的既有行为。
  - **不做历史版本的批量重译**。回填只针对"能取到官方产物"的版本，且只做继承 + AI 补译，不重译已有译文。

## 验收标准

1. **结构化**：`dictionaries/3.6.6/zh-CN.json` 含 `_meta.formatVersion === 2` 与 `common` / `windows` / `macos` / `linux` / `groups` 五段；`npm test` 全绿；**迁移前后**在 Windows 产物上的 `npm run patch --dry-run` 命中数与全部键集合**完全一致**（迁移不改变行为）。
2. **唯一写入口**：`npm run dict -- add --key "X" --zh "Y"` 成功写入；手工把字典改成重复键（同一键同时出现在 `common` 与 `windows`）后 `npm run dict -- validate` 报 error 并以非零码退出；对同一文件发起一个会破坏校验的批量修改，脚本报错、**文件内容与修改前逐字节相同**、错误信息含具体原因与条数。
3. **跨平台**：`common.js` 在 `win32` / `darwin` / `linux` 下解析 3.6.6 得到的三份条目集合互不相同且符合分段定义（三份个数可复现）；`npm run verify -- --path <macOS resources>` 在拿到 macOS 产物时命中率 > 0。
4. **组名**：GUI 字典表格出现「组名」列；抽样核对 ≥ 10 条菜单条目的组名为 `菜单-<父菜单>` 形式；未归类的条目落在 `待分组`。
5. **自动产出**：`workflow_dispatch` 手动触发，指定一个尚未有字典的官方版本 → 产出 `dictionaries/<版本>/zh-CN.json` 并通过 `dict-edit validate`；同一个版本重复触发不产生重复提交（幂等）。
6. **Gitee 发版**：发一个 tag → GitHub Release 有产物 → Gitee 仓库的 Releases 页出现同名发行版且附件数量与 GitHub 一致（对照 `GET /repos/lldwb/github-desktop-zh-cn/releases`）。
7. **更新管控**：开启「禁止自动更新」并汉化 → GitHub Desktop 的更新检查不再触发（开关状态与产物字节差异均可复现）；「还原」后回到官方原版行为；字典未覆盖的版本被拦截、已覆盖的版本放行。
8. **工具自更新**：GUI 启动时在存在新版本的情况下弹出提示；确认后下载并替换为新产品，重启后版本号变化；无新版本时不打扰。
