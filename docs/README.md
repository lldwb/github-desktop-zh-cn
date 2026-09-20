# docs/ — 文档

面向使用者的文档在 **[根目录 README.md](../README.md)**（下载产物、菜单操作、系统提示、自定义字典、卸载还原、已知限制）。本目录放分发者视角的文档：

- **[打包与分发.md](打包与分发.md)**：把工具分发给普通用户——单文件产物（中文菜单）与 GUI 产物（Electron 操作面板）的构建流程、跨平台构建、发布前检查清单、常见问题。

## agents/

`AGENTS.md` 的**按需加载分册**——从它拆出的三节各成一份，正文逐字不变；用到哪份读哪份，不必全量翻 `AGENTS.md`（它的顶部索引表给出触发条件）：

- **[发版.md](agents/发版.md)**：版本号分级与三处对齐、发版顺序、产物命名表、tag 与 Release、Gitee 镜像与 repair-release、CHANGELOG 条目格式——发版、改产物命名或动 CI 发布流程前读；
- **[已知坑.md](agents/已知坑.md)**：本仓库踩过的坑逐条留档，均为「现象 / 根因 / 处置」形式的粗体条目——排查故障、遇到似曾相识的现象时读；
- **[翻译维护.md](agents/翻译维护.md)**：三类翻译任务、共同主干、铁律、能否收录的判定表与汇报要求——增删改译文字典条目、跑自动产出字典前读（操作手册在 `.claude/skills/translation-maintain/`，与本分册是同一套规则的两种粒度）。

## design/

设计过程文档（方案 / 设计 / 任务清单），实现完成后保留备查。

### gui/

GUI 形态的过程文档：

- **[proposal.md](design/gui/proposal.md)**：需求与方案选型——为什么是 Electron、界面做到什么程度、怎么打包；
- **[design.md](design/gui/design.md)**：详细设计——运行形态判据的改动、窗口与 IPC 结构、打包配置与实测口径；
- **[tasks.md](design/gui/tasks.md)**：任务清单，完成项附实测证据。

### dict-v2/

字典 2.0（结构化 / 跨平台 / 自动化）的过程文档：

- **[proposal.md](design/dict-v2/proposal.md)**：需求与方案选型——字典为什么要有平台分段与组名、自动化产出怎么落地；
- **[design.md](design/dict-v2/design.md)**：详细设计——字典结构与唯一写入口（`dict-edit`）、组名推断、方案取舍；
- **[tasks.md](design/dict-v2/tasks.md)**：任务清单，完成项附实测证据。

## 新旧路径对照

`design/` 下的正文是**历史设计过程记录**——记录的是当时的路径与决策，故正文里的脚本 / 测试 / 文档路径**保持原文，不随目录调整改写**；同理，`CHANGELOG.md` 与 `docs/design/**` 里指向 `AGENTS.md` 章节的引用也保持原文——章节若已迁到 `docs/agents/`，按下表换算。读这些文档时按下表对照：

| 正文里的路径 / 章节（当时） | 现在的位置 |
|---|---|
| `scripts/dict-edit.js` | `scripts/dict/dict-edit.js` |
| `scripts/dict-groups.js` | `scripts/dict/dict-groups.js` |
| `scripts/release-assets.js` | `scripts/dict/release-assets.js` |
| `scripts/update-control.js` | `scripts/inject/update-control.js` |
| `scripts/bundle.js` | `tools/bundle.js` |
| `build/check-gui-dist.js` | `tools/check-gui-dist.js` |
| `build/tools/*.cjs`（CI / Release 运维探针） | `tools/ops/*.cjs` |
| `test/dict-scope.test.js` | `test/common/dict-scope.test.js` |
| `test/dict-edit.test.js` | `test/dict/dict-edit.test.js` |
| `test/dict-groups.test.js` | `test/dict/dict-groups.test.js` |
| `docs/gui/*.md` | `docs/design/gui/*.md` |
| `docs/dict-v2/*.md` | `docs/design/dict-v2/*.md` |
| `scripts/common.js` / `scripts/update.js` / `scripts/cli.js` / `build/after-pack.js` | 位置不变 |
| `AGENTS.md` 的 **发版** 节 | `docs/agents/发版.md` |
| `AGENTS.md` 的 **产物命名** 子块（发版节内） | `docs/agents/发版.md` |
| `AGENTS.md` 的 **已知坑** 节 | `docs/agents/已知坑.md` |
| `AGENTS.md` 的 **翻译维护（字典迭代）** 节 | `docs/agents/翻译维护.md` |

规划中：

- **贡献指南**：字典条目贡献流程、格式规范、审校约定（随字典格式定稿后编写）；
- **版本对应表**：GitHub Desktop 版本 ↔ 字典版本 ↔ 工具链兼容性。
