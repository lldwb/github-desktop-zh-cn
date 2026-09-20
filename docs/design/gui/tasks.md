# GUI 操作面板 · 任务清单

> 状态：**第一～八组完成**（GUI 已实现、打包已实测、文档已同步、改动已本地提交）；**第九组「随 Release 分发」进行中**——Windows 产物已实机实测，macOS / Linux 产物待 CI 出包后验证；**第十组「产物体积裁剪」已完成**——四平台 CI 实测通过（语言包裁剪 + 三平台各自的运行时组件删除），配置与文档已同步，并补了四平台通用的**产物启动冒烟护栏**。完成一项即改 `- [x]`；第六 / 七 / 八组因会话中断为事后补勾，逐项证据见条目本身。

## 一、前置：运行形态判据（`common.js`）

- [x] `common.js` 新增 `isElectron()` / `isElectronPackaged()`（判据见 `design.md`），并导出
- [x] `dataRoot()` 改为「非 SEA 且非 Electron 打包态 → 仓库根」；其余仍取 `process.execPath` 所在目录
- [x] 用探针验证四形态映射：源码态 / Electron 开发态 → 仓库根；SEA 产物 / Electron 打包态 → exe 同级（`tmp/probe-dataroot.cjs`，四行输出全部符合预期）

## 二、Electron 骨架

- [x] `gui/main.js`：创建窗口（1200×800，`minWidth` 900 / `minHeight` 600，标题「GitHub Desktop - 汉化工具」）
- [x] 安全基线：`contextIsolation: true` + `nodeIntegration: false` + `sandbox: true`
- [x] 打包态隐藏菜单栏（`Menu.setApplicationMenu(null)`），开发态保留（便于 DevTools）
- [x] `gui/preload.js`：`contextBridge` 暴露 `window.api`（`state` / `dictEntries` / `pickPath` / `patch` / `restore` / `update` / `onBusy`）
- [x] `package.json` 增加 `main`、`gui` 脚本；`npm run gui` 能打开窗口（实测 `capturePage` 取窗口内容区 1186×738，即 1200×800 去边框；开发态菜单栏 File/Edit/View/Window 保留）

## 三、界面：状态 + 只读字典表格

- [x] `gui/index.html` + `gui/style.css`：工具栏 / 标签页 / 表格 / 底部路径与进度 / 状态栏（布局见 `design.md`）
- [x] `state` 通道打通，渲染安装位置、应用版本、字典版本与条目数、是否已汉化、备份情况（实测状态栏：`已识别：…\GitHubDesktop · 版本 3.6.6 · 字典 1861 条 · 未汉化 · 无备份`）
- [x] `dictEntries` 通道：读字典 → 按「主 js / 渲染 js」类型列规则生成行数据
- [x] 表格渲染 **1861** 条（3.6.6 实测条数，非 1862）+ 搜索框过滤（实测「仓库」命中 155 条、`REPOSITORY` 命中 136 条，中英双向且大小写不敏感；无结果时表格给出「没有匹配…的条目」）
- [x] 未识别到安装位置时：状态栏给出「请点击「选择」指定安装位置」提示（对齐 CLI 文案；实测路径栏显示 `—`、状态栏转警示色）
- [x] 界面文字全部中文；窗口内**无**编辑控件（表格只读）

## 四、操作：汉化 / 还原 / 选择 / 检查更新

- [x] 「汉化」：确认框（含版本与「原文件会先自动备份」提示）→ `patch.run({ explicitPath, version })` → 显示命中处数与重启结果（打包态实测：确认框 → toast「汉化完成：命中 **2242** 处」，状态栏转「已汉化 · 有备份」）
- [x] 「还原」：确认框（区分「从备份精确还原」/「按字典还原」）→ `restore.run(...)` → 显示结果与歧义说明（两条路径都实测：有备份 → 「已从备份精确还原」；**无备份** → 按字典逆向还原，产物汉字数 242192/3166101 字节、main.js 与 renderer.js 汉字 **0 / 0**）
- [x] 「选择」：`dialog.showOpenDialog` 选目录 → `writeConfig({ resourcesPath })` → 重读状态（与 CLI 共用同一份 `config.json`）；实测取消路径：不报错、**不写** `config.json`、状态栏保持正常
- [x] 「检查更新」：`dict-sync.syncLatest(version)` 同步字典；GUI 态不做工具自更新，返回说明文字（实测：字典同步成功「字典已更新：3.6.6」；工具版本检查因直连 GitHub API 超时给出**可读错误**并按 `hasError` 显示为错误样式——联网失败不静默降级）
- [x] 「刷新」：重读状态与字典（实测状态栏按当前磁盘状态重绘）
- [x] 操作期间：不确定进度条 + 阶段文字；完成 / 失败后回到「空闲」并刷新状态（实测 busy 态与「正在同步 3.6.6 字典 …」，结束后 `progress` class 去掉、按钮全部解禁）
- [x] 错误处理：`patch` / `restore` 的错误与 `hint` 在窗口内可见（不静默、不弹原始栈）

## 五、打包（electron-builder）

- [x] `electron-builder.yml`：`files`（`gui/` + `scripts/` + `package.json`）、`extraResources`（`dictionaries/` → 应用的 `resources/`；**初版用的是 `extraFiles`（exe 同级），加入 macOS / Linux 后改为 `extraResources` + 首次运行播种**，理由见 `design.md`「运行形态与数据根」）、NSIS 选项（`oneClick: false`、可选安装目录）、产物命名、`directories.output: dist/gui`
- [x] `package.json` 增加 `dist` 脚本
- [x] 构建期网络打通：先用镜像取到 `winCodeSign` / `nsis` 二进制（`ELECTRON_BUILDER_BINARIES_MIRROR`），确认构建不再因下载失败中断（镜像固化进 `.npmrc` + `electron-builder.yml`，`npm run dist` 全程走 npmmirror，exit 0）
- [x] 产物自检：**zip 免安装包**启动不出现控制台（exe PE 头 `Subsystem=2` `WINDOWS_GUI`）、窗口正常（截图核对：5 个按钮 / 三列表格 / 底部路径栏 / 状态栏齐全，无错乱与截断；布局量得 47+32+625+30+30 = 764 正好填满视口）、状态正确。**NSIS 安装包未实机安装**（会写入系统，超出实测授权范围，留待发版前确认）
- [x] 校验打包产物的 `dataRoot` 落在安装目录（备份写在该目录的 `tmp/backup/`）；字典由首次运行**播种**到数据根（zip 产物实测：`state.dataRoot` = 解压目录，`dict.source` = `<解压目录>\dictionaries\3.6.6\zh-CN.json`，备份落在 `<数据根>\tmp\backup\3.6.6\`；播种前该目录无 `dictionaries/`）

## 六、文档同步

- [x] `AGENTS.md`：常用命令加 `gui` / `dist`（原计划名 `build:gui`，实现取 `dist`）；「运行形态」判据更新为含 Electron 两态；架构节补「界面层」；「打包态的进程环境」补 Electron 打包态一条
- [x] `README.md`：使用方式增加 GUI 形态（新增时排在「方式二」，后按用户要求提到「方式一」，原单文件产物顺延为「方式二」；含 electron 依赖安装的镜像说明、zip 免安装包提醒、可写目录提醒）；目录结构、已知限制同步
- [x] `docs/打包与分发.md`：增加「图形界面（GUI）产物」小节（构建命令 / 打包配置 / 构建期网络镜像 / portable 目标为何不提供）；发布前检查清单与常见问题同步
- [x] 残留检查：全仓搜 `isPackaged` / `唯一判据` / `双击` / `控制台` 等旧表述，已改；`scripts/README.md` 第 54 行旧判据为真实残留（已修正）；`docs/README.md` 索引补 `gui/`

## 七、验证

- [x] `npm test` 全绿（15 项 pass / 0 fail，现有单测不受影响）
- [x] `npm run verify` 正常输出（版本一致性 ✓、补丁后语法校验 ✓、「校验通过」）
- [x] 开发态实测：`npm run gui` → 状态正确 → 汉化 → 与 `npm run patch` 产物**逐字节比对一致**（见下表）
- [x] 开发态实测：还原 → 回到基准态（汉字 0/0）
- [x] 打包态实测：见第四 / 五组（zip 免安装包无控制台、汉化可用、备份落在解压目录）
- [x] 前端语法校验：`tmp/check-gui-syntax.cjs` 解析 index.html 引用的脚本（外链 1 个 / 内联 0 个）与 `preload.js` / `main.js`，全部语法 OK
- [x] 回归：`npm run build`（SEA 产物）行为与改动前一致（5 步全过、注入成功、`--help` 自检通过、产物 83.3 MB）
- [x] 端到端取证按 `references/e2e-verify.md` 口径记录（口径文件在全局 `feature-dev` 技能目录）：证据取**原始产物哈希**与**真实按钮点击后的 toast / 状态栏**，不采信界面自述

### 开发态往返一致性取证

口径：安装目录 `%LOCALAPPDATA%\GitHubDesktop\app-3.6.6\resources\app` 下两个文件的 sha256 前 12 位。

| 环节 | main.js | renderer.js | 汉字数 |
| --- | --- | --- | --- |
| 实测前（用户当前状态，已快照 `tmp/state-before`） | `95dddacf7716` | `48788ecc8e22` | 607 / 15715 |
| `npm run restore`（无备份 → 逆向还原 2242 处；快照 `tmp/state-base`） | `f786b08a817c` | `045f09c47e9a` | 0 / 0 |
| `npm run patch`（CLI 汉化，合计命中 2242 处） | `95dddacf7716` | `48788ecc8e22` | 607 / 15715 |
| GUI 开发态点「汉化」（toast「命中 2242 处」） | `95dddacf7716` | `48788ecc8e22` | 607 / 15715 |
| GUI 开发态点「还原」（toast「已从备份精确还原」） | `f786b08a817c` | `045f09c47e9a` | 0 / 0 |

三行 `95dddacf7716 / 48788ecc8e22` 说明：**逆向还原 → 再汉化的往返一致**成立，且 **GUI 与 CLI 的汉化结果逐字节相同**。

- 收尾：安装目录已用 `tmp/state-before` 写回用户原状态（`95dddacf7716 / 48788ecc8e22`）；实测中 CLI `patch` 自动生成的 `tmp/backup/3.6.6/`（内容是逆向还原产物，**不是官方原版**）已删除，避免污染后续「以原文为准」的取证。
- 环境备注：首次 `npx electron` 启动失败（`node_modules/electron/dist/electron.exe` 当时正在补齐，spawn 报 ENOENT）；二进制就位后 `npm run gui -- --remote-debugging-port=9223` 正常开窗。

## 八、提交

- [x] 确认无临时配置残留（代码与配置：`gui/` 无调试端口 / 本机路径 / console 残留；实测在 `tmp/` 下生成的快照与探针均被 `.gitignore` 覆盖，不入库。实测中 CLI `patch` 自动生成的 `tmp/backup/3.6.6/` 已删除）
- [x] 按单一职责拆分提交（GUI 主体 / 打包脚本 / 文档同步分开），显式 `git add <文件>`——`d9a743e` / `dfb2dac` / `8c3f517`
- [x] 只做本地提交，不 push / 不建 PR

## 九、随 Release 分发（v0.2.0 重发）

初版把 GUI 产物定位为「自行构建」：CI 不动、Release 只含 SEA 单文件产物。用户要求 v0.2.0 的 Release 带上 GUI 产物后，改为**随 Release 分发、三平台全上**。

- [x] `scripts/common.js`：`dataRoot()` 增加 **macOS 例外**——Electron 打包态在 darwin 上恒取用户数据目录（`.app` 包内写入会让签名失效、下次启动被 Gatekeeper 拒开）
- [x] `gui/main.js`：`seedBundledDicts()` 把应用内 `resources/dictionaries` 里数据根缺失的版本复制过去（只补缺失，不覆盖用户替换或在线更新过的）；调用点在 `registerIpc()` **之前**——状态与字典表格读的就是数据根里的字典
- [x] `electron-builder.yml` 重写：字典改 `extraResources`；目标扩为三平台（win `nsis`+`zip` / mac `dmg`+`zip` / linux `AppImage`+`deb`）；`artifactName` 用 `${platform}`（darwin / win32 / linux）与单文件产物同一套词序；`mac.identity: null` 明确不签名
- [x] `build/check-gui-dist.js`：产物静态自检——`app.asar` 大小与 11 个必备文件（解析 asar 头）、内置字典至少一个版本、Windows 产物 PE `Subsystem=2`、至少一个可分发产物；有失败项时 exit 1
- [x] `.github/workflows/build.yml`：新增 `gui` job（四平台矩阵；删 `.npmrc` 走官方源；`--config.electronDownload.mirror=` 覆盖回官方源；构建 → 自检 → 只上传最终产物），`release` 改为 `needs: [build, gui]`
- [x] `.github/workflows/build.yml`：Release 改用 `secrets.RELEASE_TOKEN`（作者本人的 PAT）创建，不用内置 `GITHUB_TOKEN`——后者建出来的 Release 署名是 `github-actions[bot]`，而**作者事后无法修改**（只能删了重建），故须在创建前定好；另加「检查发布令牌」步骤，secret 缺失时在创建前打印可读原因
- [x] 本地构建与自检：`npm run dist` exit 0，产出 `…-win32-x64.zip`（146 MB）与 `…-win32-x64-setup.exe`（106 MB）；`node build/check-gui-dist.js` 全绿（Subsystem=2、app.asar 141 KB、内置字典 3.6.5 / 3.6.6、asar 内 21 个文件齐全）
- [x] **zip 产物运行态实测**（解压到 `tmp/gui-test/`，CDP 点界面里的真实按钮，见下表）
- [x] 文档同步：`CHANGELOG.md`（0.2.0 条目按实际情形改写）、`README.md`（方式一改为随 Release 分发、目录结构补 `build/`、已知限制补 macOS 未签名打开方式）、`docs/打包与分发.md`（产物矩阵表、`extraResources` 理由、CI 构建小节、检查清单与常见问题）、`AGENTS.md`（CI 两类产物、Electron 打包态与 mac 例外）
- [x] 首次重发（run #8）四个平台的 GUI job 全挂在最后一步：electron-builder 26 在 CI 上**隐式开发布**——检出 tag 按 `onTag`、仅检测到 CI 按 `onTagOrDraft`，构建全部跑完才去找 `GH_TOKEN`，没有就 `GitHub Personal Access Token is not set` 退出（本机复现一致：`CI=true GITHUB_REF_TYPE=tag GITHUB_REF_NAME=v0.2.0 npm run dist`）。`package.json` 的 `dist` 脚本改为 `electron-builder --publish never` 后本地模拟复跑 exit 0
- [x] 第二次重发（run #9）9 个 job 全绿，Release 仍未出现：run #6 的创建步骤跑了 606 秒后被取消，而 `gh release create` 是**先建草稿、传完附件才发布**，于是留下一个**草稿版 v0.2.0**（附件还是 fa8463f 那次的 5 个 SEA 产物、署名 `github-actions[bot]`）。草稿对匿名接口不可见（`/releases/tags/v0.2.0` → 404），但发布步骤用写权限 PAT 的 `gh release view` 看得见 → 走「已存在，跳过」→ `创建 Release → success (0s)` 表面成功、实际什么都没发。workflow 改为只对**已发布**的跳过，草稿一律 `gh release delete --yes`（不带 `--cleanup-tag`）后重建（该策略在 run #11 改为**复用草稿续传**，见下）
- [x] 第三次重发（run #10）八个构建 job **全绿**（`--publish never` 生效），卡在发布 job 的 `创建 Release`：一次性 `gh release create dist/*` 串行传 10 个附件约 1.5 GB，跑 **1657 秒后失败**（对照 v0.1.1 的 5 个附件约 420 MB 只用 8 秒——不是带宽上限，是某条传输卡死/失败，而任一附件失败整条命令作废）。发布步骤改为三步：`gh release create --draft` → 逐个 `gh release upload --clobber`（每个最多 3 次、单次 `timeout 900`）→ 全部成功才 `gh release edit --draft=false`，失败附件名直接落进日志（该版仍是「第一个附件失败即中断、后面 9 个不试」，见 run #11）
- [x] 第四次重发（run #11）八个构建 job 仍全绿，发布 job 的 `创建 Release` 跑 **939 秒后失败**。关键信息从**匿名可读的注解**拿到（`/check-runs/<id>/annotations`，job 日志要仓库权限才读得到）：`附件 …-v0.2.0-darwin-arm64 连续 3 次上传失败`——而脚本是「第一个附件失败就 `exit 1`」，后面 9 个**连试都没试过**。对照附件上传者字段定位根因：v0.1.0 / v0.1.1 的附件（420 MB）都是**内置 token** 传的、分别只用 97s / 915s；换成 PAT 后三次尝试 606s / 1657s / 939s **全部失败**，且都卡在同一类 107 MB 的单文件产物上。故把两件事拆开——**建 / 改 Release 走 `RELEASE_TOKEN`（署名不变）**，**附件传输走内置 `GITHUB_TOKEN`**（job 加 `permissions: contents: write`）；同时把「第一个失败就中断」改成**全部试完再 `exit 1`**、单次 `timeout 1200`、失败附件名与 gh 错误原文一并写进 `::error::` 注解
- [x] 发布步骤改为**复用草稿续传**（run #10 的「草稿删掉重建」意味着已传附件全部作废重传，而 10 个附件约 1.4 GB 本就难一次传完）：**内容一致**的附件跳过（本地 `sha256sum` 比远端附件的 `.digest`——上传内容的 sha256；`digest` 为空的老式上传判不等、重传，偏向安全的那一侧）、缺什么补什么，发布前把不属于本次构建的遗留附件 `gh release delete-asset --yes` 清掉——末端状态与「删掉重建」等价。另把 `gh release edit` 补上 `--notes-file`（复用草稿时不走 create，正文得在这里写入）
- [x] **只复用自己的草稿**：署名在建 Release 那刻就定了（update 接口没有 author 字段，事后改不了），复用内置 token 建的草稿等于让最终 Release 署名 `github-actions[bot]`。续传前先比 `gh api user` 的 `.login` 与 `releases/tags/<tag>` 的 `.author.login`，对不上就 `gh release delete --yes` 后重建。远端确实出现过这种草稿——run #6 的创建步骤用的是 `${{ github.token }}`，建出来的就是 bot 草稿（后来被 run #10/#11 的「删掉重建」清掉，run #12 续传的已是 PAT 建的草稿，故最终署名 `lldwb`）
- [x] 发布步骤控制流的离线验证：从 YAML 导出该步骤脚本（`tmp/step-test/release-step.sh`），用假 `gh`（记录 upload 内容的 sha256 当 digest、记草稿作者）跑六种情形——① 无 Release → 建草稿、传 3 个、发布，退出码 0；② 草稿是自己的、附件与本地内容一致 → `草稿里已有且内容一致，跳过：SHA256SUMS`、补传其余、发布，退出码 0；③ 草稿里同名同大小但内容是旧产物的 → 不跳过、`--clobber` 重传，退出码 0；④ 草稿作者是 `github-actions[bot]` → 删掉重建、附件（哪怕 digest 相同）全部重传，退出码 0；⑤ 一个附件三次都传不上去 → 第 1/2 次失败各重试一次、第 3 次不再白等、`::error::` 点名该附件、**其余附件照传**、退出码 1、未发布（草稿留存供续传）；⑥ 已发布 → `Release v0.2.0 已发布，跳过`，退出码 0
- [ ] **macOS / Linux 产物实机验证**：本机是 Windows，这两个平台的**构建与运行都没验证过**——CI 只做静态自检（runner 无桌面会话），窗口行为与播种链路要等产物出来后实机跑
- [x] **重发 v0.2.0（run #12）成功**：9 个 job 全绿，`v0.2.0` 已发布，**署名 `lldwb`**（= 建 Release 那步的令牌身份），13 个附件——4 个 SEA 单文件 + 8 个 GUI 产物（macOS dmg/zip ×2 架构、Linux AppImage/deb、Windows 安装包/zip）+ `SHA256SUMS`，合计 1381.2 MB，正文为 `CHANGELOG.md` 的 0.2.0 段落。附件**全部由内置 token 上传**，`00:26:39 → 00:27:50` **71 秒**传完 1.38 GB（对照 PAT 三次 606s / 1657s / 939s 全败、v0.1.0 的 420 MB 内置 token 用 97s）——控制面 / 数据面拆分的直接证据；13 个附件的 `updated_at` 全落在发布前一分钟内，没有一个是跳过续传的旧产物
- [x] **发布产物实测**（下载自 Release，非本机构建）：`github-desktop-zh-cn-v0.2.0-win32-x64.exe` 的 sha256 与已发布的 `SHA256SUMS` 逐字一致（`18a397d3…`），运行后自报「GitHub Desktop 汉化工具 v0.2.0」并正确识别本机安装（app-3.6.6、字典 3.6.6 / 1861 条）；下载链接 `/releases/download/v0.2.0/<附件名>` 返回 200。**注**：这条记的是当时那次构建的产物——v0.2.0 后来按 cli / gui 命名重建过，文件名与字节都已变（现名 `…-cli-v0.2.0-win32-x64.exe`），附件名不再逐字对应上面写的那个
- [ ] **统一 v0.1.0 / v0.1.1 的附件命名**：页面上若还留着带「草案」标记的重复项，先点进去删掉（它与正式 Release 同 tag，`rename-assets` 一开跑就会被守卫拦下）——2026-09-18 核实：v0.1.1、v0.1.0 各有一条，创建于当天 02:09 那批 `restore-release`，同一批把正式 Release 发布了出去（`published_at` 02:10:30 / 02:10:41）却报了 failure（即 `fa96730` 修掉的「发布成功却报失败」）——建草稿 / 传附件 / 转正三步各自按 tag 找 Release，同 tag 下有两个候选时找到的可能不是同一个，草稿就是这么留下的；当天 05:33 又跑了一批 `restore-release`（两个 tag 各一次、都成功）把两个 Release 重建（新 `id`、附件 05:33 重新上传、下载计数清零、署名仍是 lldwb，**名字一个没改**——这个流程只恢复附件），草稿多半随之清掉，刷新页面对一下。再跑 `repair-release.yml` 的 `rename-assets` 任务（tag 分别填 `v0.1.0`、`v0.1.1`）——这两个版本的附件缺 `cli` 通道词、macOS / Linux 还缺 `.bin` 后缀（规范见 AGENTS.md「产物命名」）。该任务只改名不动字节，`SHA256SUMS` 随之重算，旧名字的下载链接会失效；同 tag 还有草稿时它会直接停下并说明怎么清理（按 tag 寻址会有两个候选，见 AGENTS.md）

### 打包产物（zip 免安装包）实测取证

环境：解压到 `tmp/gui-test/`（解压后**无** `dictionaries/`），启动 `GitHubDesktopZhTool.exe --remote-debugging-port=9224`，用 CDP 点界面里的真实按钮。

| 环节 | 界面自述 | 安装目录指纹（main.js / renderer.js） |
| --- | --- | --- |
| 启动 | 已识别 … 版本 3.6.6 · 字典 **1861** 条 · 未汉化 · 无备份 | `95dddacf7716` / `48788ecc8e22`（用户原状态，已汉化） |
| 点「还原」（数据根无备份 → 按字典逆向还原） | 已按字典还原 **2242** 处 | `f786b08a817c` / `045f09c47e9a` |
| 点「汉化」 | 命中 **2242** 处 | `95dddacf7716` / `48788ecc8e22` |

两次 2242 处与开发态、CLI 完全一致，指纹回到实测前——**zip 产物与源码态行为一致**；播种链路成立（启动前无 `dictionaries/`，启动后 `dict.source` 指向数据根下的副本）。

- 一次误判记录：首次点「汉化」时目标**已经是汉化态**，只命中 **2** 处，且探针在状态刷新前读到旧快照（显示「未汉化 · 无备份」）。等界面刷新后重读为「已汉化 · 有备份」，与磁盘一致——**是探针时序，不是产物缺陷**；`tmp/read-status.cjs` 即为此写的对照探针（同时读 DOM 状态栏与 `window.api.state()`）。
- 收尾：`taskkill` 关闭产物进程、删除 `tmp/gui-test/`，安装目录回到 `95dddacf7716 / 48788ecc8e22`。

## 十、产物体积裁剪（v0.3.0 之后）

目标：把 GUI 产物压进 Gitee 附件的单文件上限（100 MB）——Gitee 侧只发正文，附件上不去就少一个下载入口。**「压缩包 + 在线下载补齐内容」这个方向不成立**：应用自有内容合计 776 KB（app.asar 300 KB + 字典 476 KB），产物体积 100% 是 Electron 运行时，能拆的都是小件、大件（Chromium 内核、ICU 数据、渲染库）拆了应用起不来；唯一能让 zip 也进 100 MB 的是「引导器 + 首次运行下载」形态，跨平台各写一套、用户下载总量反而更大，评估后否决。

- [x] **基线实测**（Windows x64 / Electron 44.4.1）：win-unpacked **368 MB**、zip **147 MB**、NSIS 安装包 **107 MB**。运行时大头：electron.exe 235 MB、locales 49 MB（55 个语言包）、dxcompiler.dll 25 MB、LICENSES.chromium.html 20 MB。
- [x] **两项裁剪**：① `electronLanguages: [en-US, zh-CN]`（官方配置，三平台通用）——语言包 49 → 1.2 MB，界面是自绘 HTML，缺语言包时 Chromium 回退 en-US；② `afterPack` 钩子 `build/after-pack.js` 删 `vk_swiftshader.dll` / `vk_swiftshader_icd.json` / `dxcompiler.dll`（Vulkan 软渲染与 WebGPU 编译器，约 31 MB 未压缩）——清单是**逐项实测后收敛**出来的，更激进的大件（dxil.dll / ffmpeg.dll / LICENSES.chromium.html）收益递减且带兼容与合规风险，不做。
- [x] **裁剪后实测**：win-unpacked **292 MB**、NSIS **90.7 MB ✓**（进 100 MB）、zip **123.6 MB ✗**。zip 受 deflate 硬限制——主程序 electron.exe 单文件压缩后仍占 zip 的 83%，压不到 100 MB（NSIS 用 LZMA，压缩率更高，同内容多压出 32 MB）。
- [x] **裁剪态启动验证**（win-unpacked 解压目录）：窗口正常创建（标题「GitHub Desktop 汉化工具」）、进程稳定运行 30 分钟以上、无错误日志（仅无害的 WSALookupServiceBegin 警告）。**两个排查陷阱记下来**：连续 spawn 多个实例全部 exit 0 **不是**启动失败——是单实例锁（`gui/main.js` 的 `requestSingleInstanceLock`）把后来者正常劝退，验证前先杀光残留进程；中文 Windows 的 `tasklist` 输出是 GBK，按 utf16le 解码会把活着的进程判成「已退出」。
- [x] **自检增强**：`build/check-gui-dist.js` 增加语言包裁剪核验与产物体积报告（超 100 MB 打 `::warning::`）——四平台体积直接看 CI 日志，不必下载附件。
- [x] **四平台 CI 实测**（两次 `workflow_dispatch`，run #16 / #17）：裁剪前 → 后，Windows setup 106.4 → **90.7 ✓**、zip 146.3 → 123.6；macOS arm64 dmg/zip 122.1/122.2 → **110.3/110.2**、x64 125.6/125.8 → **113.8/113.7**；Linux deb 94.4 → **92.4 ✓**、AppImage 119.4 → **116.9**。四平台自检全绿。用户决策：zip 接受 123.6 MB、macOS / Linux 本轮只上 locales 裁剪。
- [x] **macOS 语言包被误删的修复**（第二次实测发现）：首次实测两个 mac 产物的语言目录都只剩 `en.lproj`。根因在 electron-builder 的匹配规则（`app-builder-lib/out/electron/ElectronFramework.js`）：语言名相等、或前缀 + 分隔符（`-` / `_`）、比较前都转小写——`zh-CN` 匹配不到 mac 的 `zh_CN.lproj`（下划线），而 Windows / Linux 的 `zh-CN.pak` 是连字符，同一份配置在两处认的不是一套写法。`electronLanguages` 补上 `zh_CN` 后复测：两个 mac 产物的语言目录都是 `en.lproj / zh_CN.lproj`，体积各 +0.2 MB（多留的正是中文那一份）。自检的 mac 分支也一并改对——语言目录分布在**应用级 `Contents/Resources` 与 Electron Framework 的 `Resources` 两处**（electron-builder 两处都裁），原先只查前者（那里只有 1 个 `en.lproj`，看不到主体）；改为两处合并去重后核对，并加判定：缺中文报错（提示配置要同时列 `zh-CN` 与 `zh_CN`）、出现第三种语言报错。本机无 macOS，用假 `.app` 目录树把 `platform` 顶成 `darwin` 跑通三种情形（en + zh_CN 通过 / 只有 en 报错 / 混入 fr 报错）。
- [x] **Linux 只瘦 2 MB 的疑点查清**：不是打包器排除了 locales（CI 日志确认 linux-unpacked 已裁到 `en-US.pak / zh-CN.pak`），而是 **Linux 版 Electron 的语言包天生就小**。用 HTTP Range 取官方发行包（`electron-v44.4.1-*.zip`，只下载末尾的中央目录几十 KB）实测：语言资源未压缩 Windows 48.3 MB（55 个 `.pak`）/ macOS 48.0 MB（495 个 `.lproj` 文件 = 55 语言 × 9）/ **Linux 8.6 MB**，zip 包内压缩后依次 12.3 / 12.4 / 2.6 MB。裁剪收益与这三个数一一对应——Windows zip 瘦的 22.7 MB ≈ 语言包 12.3 + 删掉的三个 dll 约 11.8；mac zip 瘦的 12 MB ≈ 语言包；Linux deb 瘦 2.0 / AppImage 瘦 2.5 MB ≈ 语言包 2.6。（探针：`tmp/probe-electron-zip.cjs`，只取 zip 尾部中央目录，不下载整包。）
- [x] **平台特定组件的删除（macOS / Linux）**——`after-pack.js` 改为按 `context.electronPlatformName`（目标平台）分支：macOS 删 `Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/` 下的 `libvk_swiftshader.dylib` 与 `vk_swiftshader_icd.json`，Linux 删根目录的 `libvk_swiftshader.so` 与 `vk_swiftshader_icd.json`；ffmpeg（三平台都有，音视频解码）与 Linux 的 `libvulkan.so.1`（Vulkan loader，删它影响面比删实现大）刻意保留。macOS 的 `.app` 名是**扫出来的**而不是拼 `productName`——本仓库设了 `executableName`，产物叫 `GitHubDesktopZhTool.app`，拼中文 productName 会找不到目录。**run#18 四平台实测**（裁剪前 → 后）：mac arm64 dmg/zip 110.3/110.2 → **104.0/103.9**（−6.3）、mac x64 113.8/113.7 → **112.1/112.0**（−1.7）、Linux deb 92.4 → **91.1**、AppImage 116.9 → **115.2**（−1.7）；Windows 清单本轮没动，仍是 90.7/123.6。两个 mac 架构差 3.6 倍是**官方发行包本身的差异**（探针实测：darwin-arm64 的 dylib 15.8 MB 未压缩 / 压缩后 6.3，darwin-x64 的只有 4.4 / 1.7），不是配置漏了哪个架构——各平台减掉的体积与文件体积逐项对得上。
- [x] **产物启动冒烟护栏（`--smoke-test`）**：`gui/main.js` 加开关——窗口与界面就绪后在渲染进程里走一遍**真实 IPC 往返**（`window.api.state()` = preload → ipcMain → scripts）并核对界面骨架，打印 `SMOKE_OK …` 后 exit 0；失败或 30 秒超时打 `SMOKE_FAIL` 并 exit 1。三个设计点都有实测依据：判据**不含字典表格行数**（CI 上没有 GitHub Desktop，行数必为 0——四平台实测 `rows=0`）；单实例锁拿不到时报 `SMOKE_FAIL` 而不是静默 exit 0（本机实测踩过：连续起多个实例全 exit 0，看着像启动成功）；输出直写 fd 1（stdout 走管道时是异步的，`console.log` 后紧接 `app.exit()` 会丢输出）。`build.yml` 的 gui job 在自检与上传之间加三平台冒烟步骤，Windows 用 `Start-Process -Wait -RedirectStandardOutput`（GUI 子系统程序从 PowerShell 的 `&` 调用既不等待也不捕获输出）、macOS 直接执行 `.app/Contents/MacOS/` 里的可执行文件（绕开 LaunchServices）、Linux 用 `xvfb-run` + `--no-sandbox --disable-dev-shm-usage`（runner 无显示，容器里沙箱与 `/dev/shm` 都不合用）。**run#18 四平台冒烟全绿**——这是「删掉软渲染组件后还能不能起」的直接证据（四个 runner **都没有 GPU**）：win32 `gpu_compositing=disabled_software` / `webgl=unavailable_software`、darwin-x64 `disabled_software` / `disabled_off`、linux `disabled_software` / `disabled_off`（另带 `vulkan=disabled_off`）、darwin-arm64 `enabled` / `enabled`——软件回退路径成立，界面照常加载。窗口内容区随 runner 虚拟屏变化（1008×681 / 1024×642 / 1200×772 / 1200×800），故判据取「没崩成异常尺寸」（≥640×480）而不是请求尺寸 1200×800。本地同一条命令即可自查：`dist/gui/win-unpacked/GitHubDesktopZhTool.exe --smoke-test`（开发态 `npx electron . --smoke-test` 亦可），本机两种形态都跑过。

## 十一、压缩算法与产物形态（v0.3.0 之后，续第十组）

第十组的两项裁剪把体积压到了「Windows 达标、其余还差一口气」的位置。这一轮不动内容、只换**压缩算法与产物形态**——同一份内容换一种压法就能再挤出一大截，收益比继续删文件大得多，且零取舍。

- [x] **压缩方法实测**（本机，同一份 win-unpacked 内容）：主程序 `electron.exe` 单文件 234.9 MB → xz 后 70.3 MB；整包 `7z -mx=9` **84.3 MB**、`tar.xz -9` 90.5 MB，对照 zip 123.6 MB。另实测 `LICENSES.chromium.html` 20 MB xz 后仅 0.18 MB（高度可压缩，删它收益趋近于零，**不建议删**）；macOS / Linux 的官方发行包里没有 d3dcompiler / dxil / libEGL / libGLESv2，无额外可删项。
- [x] **AppImage 为什么胖的根因查清**：`app-builder-lib/out/targets/appimage/AppImageTarget.js` 的压缩选择分支在根级 `compression` 未设时传给 `mksquashfs` 的是 `undefined`，而 `mksquashfs` 的默认是 gzip——同一份内容比 deb（xz）胖 24 MB，纯粹是算法差异，不是内容差异。修法是根级设 `compression: maximum`（AppImage → xz、dmg → UDBZ、deb 本来就是 xz、NSIS 不受影响），**零取舍**。
- [x] **三项改动落地**：① 根级 `compression: maximum`；② `win.target` 的 `zip` 换成 `7z`（zip 受 deflate 硬限制，主程序单文件就占压缩后体积的 83%，压不进 100 MB；7z 是 electron-builder 的一等 target，Windows 11 文件资源管理器原生支持解压）；③ `mac.target` 去掉 `zip` 只留 `dmg`（两者装的是同一份 `.app`，zip 那份纯属重复附件）。
- [x] **`pickGuiAsset` 同步**（`scripts/update.js`）：它只挑「能被 `installGuiUpdate` 直接跑起来的那种」，不是「产物里最小的那种」——Windows 侧是直接 spawn 下载下来的文件，所以只认 `-setup.exe`，7z 挑中只会让更新失败；macOS 的 `.zip` 一并从扩展名表去掉（已废弃的形态）。探针 `build/tools/check-naming.cjs` 同步：win32 用例把 7z 排在 `setup.exe` 前面（验证它不会被挑中）、darwin 用例去掉 zip、并补一条反向用例（只有 mac zip 时必须返回 null）。
- [x] **本机实测**：`npm run dist` 产出 7z **81.2 MB**（比手工 `7z -mx=9` 压的 84.3 MB 还小 3 MB）、NSIS **90.8 MB**；`node build/check-gui-dist.js` 全绿；打包态冒烟通过。**7z 产物解压验证**：用 electron-winstaller 自带的 `7z-x64.exe x` 解出 22 个文件（`Everything is Ok`），解压目录跑 `--smoke-test` 得 `SMOKE_OK … dataRoot="…\tmp\7z-test"`——**数据根落在解压目录**，正是免安装包「解压即用、数据跟着包走」的设计行为。
- [x] **run#20 四平台 CI 实测**（`compression: maximum` + 7z + mac 只发 dmg 一起上）：Windows **7z 81.2 ✓** / setup 90.8 ✓、macOS arm64 dmg **95.9 ✓** / x64 dmg 102.5 ✗、Linux AppImage **91.6 ✓** / deb 91.1 ✓。**超 100 MB 的产物从 6 个降到 1 个**（只剩 macOS Intel 的 dmg，超出 2.5 MB）。四个平台自检与冒烟全绿（`gpu_compositing` 状态与 run#18 一致，说明冒烟判据在换压缩算法后仍稳）。
- [x] **文档同步**：`README.md`（产物形态与免安装包说明）、`AGENTS.md`（`npm run dist` 注释、产物去处段落、Gitee 配额段落的三处体积数字）、`docs/打包与分发.md`（产物矩阵表、portable 段落、打包配置小节补 `compression` 与两个 target 的理由、Gitee 段落、检查清单、常见问题第一条的体积与算法说明）。

### 内容侧还能压多少（实测后结论：到底了）

算法与形态换完之后，问题变成「再删文件还能挤出多少」。逐项实测（本机 win-unpacked，每项单独 `7z -mx=9 -m0=lzma2` 压一遍，看**各自对最终包的贡献**——未压缩大 ≠ 压缩后占得多）：

| 文件 | 未压缩 | 7z 后 | 占整包 |
| --- | --- | --- | --- |
| `GitHubDesktopZhTool.exe` | 246.3 MB | **67.4 MB** | **83%** |
| `resources.pak` | 12.4 MB | **12.3 MB** | 15% |
| `icudtl.dat` | 10.9 MB | 3.4 MB | 4.2% |
| `d3dcompiler_47.dll` | 4.7 MB | 1.6 MB | 1.9% |
| `ffmpeg.dll` | 3.1 MB | 0.9 MB | 1.2% |
| `dxil.dll` | 1.5 MB | 0.5 MB | 0.6% |
| `vulkan-1.dll` | 0.9 MB | 0.3 MB | 0.3% |
| `LICENSES.chromium.html` | 20.5 MB | **0.19 MB** | 0.2% |

- [x] **主程序占 83%、`resources.pak` 占 15%（且几乎压不动：12435 KB → 12319 KB）——两者合计 98%**，其余全是配菜：把 `dxil.dll` + `vulkan-1.dll` + `d3dcompiler_47.dll` 全删也只省 2.4 MB（压缩后）。
- [x] **`LICENSES.chromium.html` 是反直觉的坑**：未压缩 20.5 MB 看着最扎眼，xz 后只剩 0.19 MB（高度重复的文本，算法已吃掉 99%）——删它省不下 0.2 MB，还要担合规风险（Chromium 许可要求分发时附带）。**结论：不删**。
- [x] **`d3dcompiler_47.dll` 删不得，本机实测拿到反证**：删掉后冒烟**仍打印 `SMOKE_OK`、退出码 0**，但 GPU 状态从 `gpu_compositing=enabled` / `webgl=enabled` **掉到 `disabled_software` / `disabled_off`**——有 GPU 的机器上硬件加速直接失效。**这正是 CI 四平台冒烟测不出来的那类退化**：runner 本来就没 GPU，`disabled_software` 是它的常态，删与不删输出一模一样。教训记下来——**冒烟护栏能证明「删了能启动」，证明不了「删了不掉性能」**，涉及硬件能力的组件要在**有该硬件的机器**上对照 `gpu_compositing` / `webgl` 两项状态才算验过（本次删 d3dcompiler 的对照就靠这两项状态前后对比抓出来）。
- [x] **结论：Electron 这条路的内容侧已经到底**。要再降一个量级只能换运行时基底（不自带 Chromium，改用系统 WebView 的 Tauri / Wails 形态，产物可到 10 MB 级）——那是重写 GUI 层、不是压缩，**留待下次重构时评估**（已记入 `design.md` 的方案对比表与 `docs/打包与分发.md`「常见问题」）。
- [x] 实测用的临时目录（`tmp/cut-test` / `tmp/pack-probe`）已清理。
