# build/tools 探针与核对工具

CI / Release 运维探针：**匿名 API 只读、零依赖、自包含**，仓库地址统一取 `scripts/common.js` 的 `GH_OWNER` / `GH_REPO`（一处定义）。均从 `tmp/` 固化而来——有复用价值的中间过程脚本视情况固化到这里，**`tmp/` 默认不固化、清掉即失**。

## 用法

| 工具 | 用途 | 跑法 |
|------|------|------|
| `ci-status.cjs` | 最近 CI 运行概览（触发方式 / 结论 / 耗时 / 各 job 结论） | `node build/tools/ci-status.cjs` |
| `run-detail.cjs` | 按 run id 直查运行详情与 job 结论 | `node build/tools/run-detail.cjs <runId>` |
| `job-steps.cjs` | 某次运行各 job 的步骤明细（结论与耗时） | `node build/tools/job-steps.cjs <runId>` |
| `job-timing.cjs` | 只看名字含某字串的 job 的步骤耗时（定位失败步） | `node build/tools/job-timing.cjs <runId> [名字字串]` |
| `wait-run.cjs` | 轮询某次运行直到结束（默认最长 55 分钟） | `node build/tools/wait-run.cjs <runId> [最长分钟数]` |
| `release-detail.cjs` | 已发布 Release 的正文摘要、附件上传者与时间戳 | `node build/tools/release-detail.cjs <tag>` |
| `rel-check.cjs` | 核对各 tag Release 附件名是否符合 cli / gui 命名规范 | `node build/tools/rel-check.cjs [tag...]`（缺省 v0.1.0 v0.1.1 v0.2.0） |
| `wf-lint.cjs` | workflow 体检：`run:` 块逐个 `bash -n` + YAML 禁忌（制表符 / 缩进非 2 的倍数）+ 步骤结构 | `node build/tools/wf-lint.cjs [workflow 文件名]`（缺省 repair-release.yml） |
| `check-naming.cjs` | 产物命名回归：`update.js` 的 `pickAsset` 只挑 cli 产物（含 GUI 在前 / 平台无产物的反向用例） | `node build/tools/check-naming.cjs` |

## 约定

- 新增探针同样写**匿名可读**（公开仓库无需认证）；需写权限的查询写 `::error::` 或 README 里注明。
- 改 `scripts/update.js` 后跑 `check-naming.cjs`；改 `.github/workflows/` 后跑 `wf-lint.cjs`。
