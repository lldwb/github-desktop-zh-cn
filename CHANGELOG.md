# Changelog

## [0.1.0] - 2026-09-17

首个版本：把「clone 仓库 + 装 Node + 敲命令」的汉化流程做成可直接分发的单文件产物——Windows / macOS / Linux 使用者无需任何环境，双击进中文菜单即可汉化或还原。

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
