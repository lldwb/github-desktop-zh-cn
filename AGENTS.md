# AGENTS.md

本文件是 Claude Code 及其他 agent 在本仓库工作时的指引；根目录 `CLAUDE.md` 指向本文件，**本文件为唯一权威源**。

## 仓库定位

GitHub Desktop 中文汉化补丁工具仓库（字典驱动、开源）。GitHub Desktop（Electron 应用）官方未提供简体中文界面，本仓库以 **JSON 语言字典为唯一翻译资产**，用 Node.js 脚本对官方安装包内的 `main.js` / `renderer.js` 执行字符串替换实现汉化。由此推出硬性约束：

- **字典是核心资产**（`dictionaries/<版本>/zh-CN.json`），脚本只做机械替换、**不内置翻译**；字典与脚本分离维护。
- **版本强对应**：字典必须与 GitHub Desktop 版本一一对应，错配可能导致应用无法启动；字典条目只针对用户可见的 UI 文本（界面元素 / 读屏 / 命令行 / 报错），不含用户不可见的日志文本。

## 常用命令

仓库当前为骨架初始化：补丁脚本（`unpack` / `patch` / `verify`）尚未实现，无构建与自动化测试。实现后的验证方式以手工运行为主：

```bash
npm run unpack          # 定位安装目录并解包 app.asar
npm run patch           # 按字典替换 main.js / renderer.js 并写回
npm run verify          # 校验替换结果与版本一致性
```

脚本改动后至少跑一次 `node <脚本> --help` / `--dry-run` 做语法与行为验证（沿用 `--dry-run` 预览不写盘的约定）。

## 架构

- **替换对象固定**：`app.asar` 解包后的 `main.js`（主进程）与 `renderer.js`（渲染进程）——官方 `app/package.json` 的 `"main": "./main.js"` 与社区同类项目（robotze/GithubDesktopZhTool 的 Mac/Linux 替换方案）互为佐证。
- **工具链三段式**：`unpack`（解包）→ `patch`（按字典替换 + 重打包 / 写回）→ `verify`（替换计数、残留检查、版本一致性），见 `scripts/README.md`。
- **字典组织**：按版本目录分置，格式（精确匹配优先、正则兜底、占位符处理）随工具链实现定稿。

### 跨模块共用约定（改代码时别破坏）

- 版本号概念在 `dictionaries/` 目录名、`scripts/` 版本一致性校验、`docs/` 版本对应表三处出现，改版本组织方式时三处同步。
- 字典文件仅含「原文 → 中文」映射数据，不含任何脚本逻辑；脚本不得在字典外硬编码翻译。

## 已知坑

- **替换后失去官方签名**：汉化产物（修改后的 `app.asar` / js 文件）在 Windows 下会触发 SmartScreen 提示，属预期行为，文档需提前说明。
- **升级即失效**：GitHub Desktop 官方更新会覆盖汉化文件，需对应对应版本的字典重新打补丁。
- **版本错配打不开应用**：字典与目标版本不一致时替换结果不可控，`patch` 前必须先校验版本。
- 仓库当前 `scripts/*.js` 为占位骨架，`package.json` 的 scripts 入口指向未实现文件——实现完成前 `npm run *` 会报"找不到文件"，属预期状态。

## 提交规范

- 中文约定式提交：`<type>(<scope>): <一句话中文标题>`，type 取 feat / fix / chore / docs / refactor 等常规类别。
- 提交信息不带任何 `Co-Authored-By` 类署名。
- 只做本地提交，不自动 push / merge / 建 PR；显式 `git add <文件>`，禁止 `-A` / `.`。
- 仓库为开源仓库：文件内容不写绝对路径、机器名、凭据等敏感信息。
