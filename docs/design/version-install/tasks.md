# 版本下载安装 · 任务清单

> 完成一项**立即**改为 `- [x]`；收尾前核对无未勾选项。

## 1. 网络层：代理支持（`scripts/net.js`）

- [x] 新增代理解析：环境变量（含 `NO_PROXY`）→ Windows 注册表 → macOS `scutil`，首次解析后缓存；导出 `getProxy()` 供探针与错误提示用 —— 实测：设 `HTTPS_PROXY` 时返回 `{"host":"127.0.0.1","port":7890,"source":"环境变量 HTTPS_PROXY"}`；本机注册表 `ProxyEnable=0x0`（系统代理关着）故不设环境变量时返回 null，符合预期。
- [x] `openStream()` 接入 CONNECT 隧道（https 专用），CONNECT 失败时回退直连并记住该代理不可用 —— 实测：设 `HTTPS_PROXY=http://127.0.0.1:1` 时打印「代理 127.0.0.1:1 不可用（连接被拒绝），已回退直连」且请求成功。**过程中修掉一个真 bug**：给 ClientRequest 传 `createConnection` 会不等 TLS 握手就写数据，请求以明文发到 443、GitHub 回 301 重定向到自己 → 死循环；改为 `https.Agent` 的 `createConnection(options, cb)` 契约（`secureConnect` 后才放行）。
- [x] 回归：`npm test` 全绿（112 通过）；代理生效实测 8 MB 下载 280 KB/s（直连 15 KB/s）。

## 2. 官方产物层（`scripts/dict/release-assets.js`）

- [x] 新增 `listVersions()`：取官方 Release 列表，过滤 draft / prerelease / 无本平台资产，解析 tag 得版本号 —— 实测列出 35 个可下载版本（3.6.5 起往回），每项带资产名与体积。**注意 3.6.6 不在其中**：官方正式版的 Release 对象比发布说明晚若干天建（既有注释已记载这条），工具只能下载 Release 里已有产物的版本。
- [x] `PLATFORM_SPECS` 补「铺开时的前缀」（windows: `lib/net45/`）—— 与 `appDir` 分开：一个指向包内 app 目录（取 main.js 用），一个是要剥掉的层数（整包铺开用）。macOS 不设，本次在线安装只支持 Windows。

## 3. 安装模块（新增 `scripts/cmd/install-version.js`）

- [x] `listDownloadable()`：官方版本 × 本机已装 × 本机字典，合并出带 `hasDict` / `installed` 标记的列表 —— 实测 `--list` 输出 3.6.5（已安装）/ 3.6.4 / 3.6.0，3.6.6 因官方未发 Release 产物不在列、3.6.3 等因无字典被过滤，均符合预期。
- [x] `install(version)`：校验和比对 → 下载到 `tmp/downloads/*.part` → 解压到 `app-<版本>.part` → 校验必需文件 → 改名成 `app-<版本>` —— 用自造的小 nupkg 走通全链路（`LOCALAPPDATA` 指向临时目录，不碰真实安装根）：铺出 6 个文件、NuGet 元数据被跳过、`locateApp` 认得出来。
- [x] 下载前磁盘空间检查（`fs.statfsSync`），不足即拒绝并说明所需空间 —— 代码就位；未实测触发（需要造一个空间不足的分区）。
- [x] CLI 入口（`<版本>` / `--list` / `--from <本地包>`），带百分比进度 —— `--list` 与 `--from` 已实测。
- [x] 顺带补了 `--from <本地包>`：既是 design.md 里方案 C 的降级路径（下载通道不通时用自备包），也让整条链路能在不下载 293 MB 的前提下验证。

## 4. 端到端实测（真链路，需用户确认后执行）

- [x] 实测下载 + 解压一个**本机没有的**版本（3.6.4）—— 用户确认后真跑：下载 293.1 MB（走系统代理）、校验和一致、解压铺出 **1134 个文件**、退出码 0。产出与官方 `app-3.6.6` 做 `diff`：**只差两项**（nupkg 自带的 `GitHubDesktop_ExecutionStub.exe`、安装器写的 `Squirrel-UpdateSelf.log`），其余逐项一致。`listInstalledVersions()` 与 `locateApp()` 都认得出来；无残留 `.part` 目录，下载的安装包已自动清理。
- [x] 真启动一次该版本 —— 用独立 `--user-data-dir` 隔离启动 `app-3.6.4/GitHubDesktop.exe`，**进程存活**（未在 15 秒内退出），已关闭该测试实例。design.md 里那条「缺 Squirrel 更新器写的额外文件会不会起不来」的风险由此排除。
- [ ] 在该版本上跑一次 `patch` —— **未做**：3.6.4 有对应字典，这条链路是既有的 `patch` 能力（与本次「下载安装」无关），而它会**重启使用者正在用的 GitHub Desktop**，代价大于收益。要验的话在 GUI 里切到 3.6.4 点「汉化」即可。

## 5. CLI 接入（`scripts/cli.js`）

- [x] 菜单 `4)` 列出可下载版本，选中后确认 → 下载 → 切换 —— 菜单里新增 `d) 下载并安装其他版本`（联网列表只在选 d 时才取，避免一进菜单就等网络）；另加了 `install` 子命令。

## 6. GUI 接入（`gui/` 五个文件）

- [x] 「切换版本」窗口分两组（本机已安装 / 可下载），可下载项显示体积 —— 实测冒烟 `versionItems=2 downloadItems=2`（本机可下载的是 3.6.4 / 3.6.0）。
- [x] `installVersion` IPC + 下载进度（走 `busy` 通道）—— 通道与进度回调已接上；**完整下载未实测**（见第 4 组）。
- [x] 完成后自动 `setVersion` 切过去 —— 主进程在 `install` 成功后调 `common.setTargetVersion()`；**未实测**（同上）。
- [x] 冒烟自检补充判据（两组列表都在、可下载项能渲染）—— 输出新增 `downloadItems`；取不到时不判失败（CI 不保证出网），但把空态文字打出来供排查。
  定位过程中的一个**假警报**值得记：首轮 `downloadItems=0` 看着像 bug，实为等待窗口（6 秒）短于真实耗时——官方 Release 列表在代理下约 **6.4 秒**，调到 12 秒即正常。同时那次也暴露出 `console.error` 在 Electron 主进程里不总是进管道，诊断改用 `fs.writeSync(1, …)`。

## 7. 文档与提交

- [x] 同步 `README.md` / `AGENTS.md` / `scripts/README.md` / `docs/打包与分发.md` / `docs/design/gui/design.md`（含界面图重绘与 IPC 契约表两行新增）。
- [x] `npm test`（115 通过 / 0 失败，含本次新增的 3 个 `extractLocal` 用例）+ 冒烟自检（`SMOKE_OK … downloadItems=2`）+ 端到端实测三项全过 → 按规范提交。

## 未完成项

（收尾时填写：无法完成的项保持未勾选，写明原因与处置。）
