# tools/ops 探针与核对工具

CI / Release 运维探针：**匿名 API 只读、零依赖、自包含**，仓库地址统一取 `scripts/common.js` 的 `GH_OWNER` / `GH_REPO`（一处定义）；**联网只有 `lib.js` 一处**（`get()` / `getJson()`，底层走 `scripts/net.js`，因此自带代理支持、超时与重定向兜底）——探针不自己抄 `https.get`；传给它的 `path` 是 API 全路径（如 `/repos/<owner>/<repo>/releases`，仓库前缀仍由各探针用 `GH_OWNER` / `GH_REPO` 拼）。均从 `tmp/` 固化而来——有复用价值的中间过程脚本视情况固化到这里，**`tmp/` 默认不固化、清掉即失**。例外：`update-e2e.cjs` 不发任何 API——它是发版第 7 步的驱动器，本地 spawn 产物实跑一遍自更新链路。

## 用法

| 工具 | 用途 | 跑法 |
|------|------|------|
| `ci-status.cjs` | 最近 CI 运行概览（触发方式 / 结论 / 耗时 / 各 job 结论） | `node tools/ops/ci-status.cjs` |
| `run-detail.cjs` | 按 run id 直查运行详情与 job 结论 | `node tools/ops/run-detail.cjs <runId>` |
| `job-steps.cjs` | 某次运行各 job 的步骤明细（结论与耗时） | `node tools/ops/job-steps.cjs <runId>` |
| `job-timing.cjs` | 只看名字含某字串的 job 的步骤耗时（定位失败步） | `node tools/ops/job-timing.cjs <runId> [名字字串]` |
| `wait-run.cjs` | 轮询某次运行直到结束（默认最长 55 分钟） | `node tools/ops/wait-run.cjs <runId> [最长分钟数]` |
| `release-detail.cjs` | 已发布 Release 的正文摘要、附件上传者与时间戳 | `node tools/ops/release-detail.cjs <tag>` |
| `rel-check.cjs` | 核对各 tag Release 附件名是否符合 cli / gui 命名规范 | `node tools/ops/rel-check.cjs [tag...]`（缺省取最新 Release 的 tag） |
| `update-e2e.cjs` | 发版第 7 步「真机验证更新链路」的驱动器：spawn 产物实跑「检查更新 → 下载 → 替换 → 重启」，按输出喂 stdin、超时兜底、按提示是否收全判成败 | `node tools/ops/update-e2e.cjs <产物exe> <bundle.cjs> [最长分钟数]`（沙箱与伪装旧版步骤见 `docs/agents/发版.md`） |
| `wf-lint.cjs` | workflow 体检：`run:` 块逐个 `bash -n` + YAML 禁忌（制表符 / 缩进非 2 的倍数）+ 步骤结构 | `node tools/ops/wf-lint.cjs [workflow 文件名]`（缺省 repair-release.yml） |
| `check-replaceable.cjs` | 判定某处文案可否替换：打出每处出现的上下文（前 80 / 后 40 字符），并标出查表 / 比较 / 模块导出名 / switch 分支等高危上下文 | `node tools/ops/check-replaceable.cjs <文案> [--path tmp/backup/<版本>]` |

## 约定

- 新增探针同样写**匿名可读**（公开仓库无需认证）；需写权限的查询写 `::error::` 或 README 里注明。
- 改 `scripts/update.js` 后跑 `test/tools/check-naming.test.js`（产物命名回归已从本目录迁入测试，随 `npm test` 一并跑）；改 `.github/workflows/` 后跑 `wf-lint.cjs`；判定某处文案能不能翻译时用 `check-replaceable.cjs`（查英文原文要指向 `tmp/backup/<版本>/`——产物可能已汉化，那里才是原文）。
- **路径一律参数化**（`--path` / `--version`），别把本机的备份目录或产物目录写死——写死的话换台机器就跑不起来，而「能不能跑起来」正是探针有没有价值的全部。
