# GUI 操作面板 · 任务清单

> 状态：**第一～八组完成**（GUI 已实现、打包已实测、文档已同步、改动已本地提交）；**第九组「随 Release 分发」进行中**——Windows 产物已实机实测，macOS / Linux 产物待 CI 出包后验证。完成一项即改 `- [x]`；第六 / 七 / 八组因会话中断为事后补勾，逐项证据见条目本身。

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
- [ ] **macOS / Linux 产物实机验证**：本机是 Windows，这两个平台的**构建与运行都没验证过**——CI 只做静态自检（runner 无桌面会话），窗口行为与播种链路要等产物出来后实机跑
- [ ] **重发 v0.2.0**：删远端 tag → 提交本轮改动 → 重打注解 tag 推送 → CI 出四平台两类产物 → Release 一次成型含 GUI 附件

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
