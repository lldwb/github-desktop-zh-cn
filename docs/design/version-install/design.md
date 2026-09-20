# 版本下载安装 · 设计

## 方案对比（第 0 项先评估"不做 / 复用既有"）

| 方案 | 思路 | 可行性 | 代价 | 结论 |
|------|------|--------|------|------|
| 0：不做，引导用户自己装 | 只给官网链接 | — | 没解决需求（官方下载页只有最新版，历史版本要自己翻 Releases） | 不成立：需求明确要求"通过下载来切换" |
| **A：下载官方 nupkg，解压 `lib/net45/*` 到 `app-<版本>/`** | 复用 `release-assets.js` 的官方产物访问能力 | **已实测**：包内结构与本机安装目录逐项一致 | 需实现"全量解压"（现有能力只按需取单条目） | **采用** |
| B：下载并运行官方 `GitHubDesktopSetup-<arch>.exe` | 走官方安装流程 | 可行（仓库已有 spawn 安装包的先例：`installGuiUpdate`） | 走 Squirrel 升级语义——**会替换掉现有版本**，破坏"多版本并存、随时切换"；还需 spawn 第三方安装程序并处理权限 | 不采用：与现有切换模型冲突 |
| C：只做"从本地 nupkg 安装" | 用户自己弄到包，工具负责铺开 | 可行 | 没解决"下载"这一半 | 作为**降级路径**保留（在线下载失败时给手动指引） |

## 可行性核证（均为实测，非推断）

| 待确认点 | 核证方法 | 结论 | 对方案的影响 |
| --- | --- | --- | --- |
| 官方是否提供历史版本产物 | `api.github.com/repos/desktop/desktop/releases` | 提供；tag 形如 `release-3.6.5`，每个正式版含 `GitHubDesktop-<版本>-<arch>-full.nupkg`（x64 293.1 MB） | 版本列表从官方 Release 取 |
| nupkg 能否当安装目录用 | `release-assets.listEntries()` 读中央目录 | 共 1301 条：`lib/net45/` 1291 条（应用本体）+ NuGet 元数据；`lib/net45/resources/app/{main,renderer,package}.js(on)` 齐全 | 剥掉 `lib/net45/` 前缀铺开即得安装目录 |
| 与官方安装目录是否同形 | 对照本机 `app-3.6.6/` 的直接子项 | **逐项一致**：`GitHubDesktop.exe` / `resources/` / 同名 dll / `locales/` / `squirrel.exe`…（仅多一个 `GitHubDesktop_ExecutionStub.exe`） | 解压方案成立，`locateApp()` 直接识别 |
| 完整性能否校验 | 取 `GitHub.Desktop-<版本>-checksums.txt` | 官方提供全部资产的 sha256（含 nupkg） | 下载后比对，不符即拒绝 |
| **直连下载速度** | `curl -r 0-5242879` | **15 KB/s** → 293 MB 需 **5.5 小时** | 直连不可作为默认通道 |
| **代理下载速度** | `curl -x 127.0.0.1:7890 -r 0-20971519` | **593 KB/s** → 293 MB 约 **8 分钟** | 代理是本机可用性的前提 |
| `net.js` 是否支持代理 | 读代码 | 不支持（零依赖，直接用 `node:https`） | 需新增代理支持 |

## 选定方案

### 1. 版本列表的来源与过滤

官方 Release 列表（`/releases?per_page=100`）→ 逐条过滤：

- 跳过 `draft` / `prerelease`（beta 默认不列，用「显示没汉化的版本」展开时也不列——beta 的资产名与正式版同形，但没人保证稳定，故一律排除）；
- 跳过没有本平台资产的（官方**不发 Linux 产物**，近 30 个 release 实测一个都没有）；
- 版本号从 tag 解析（`release-<版本>`），tag 命名变了**直接报错**而不是猜（沿用 `latestVersion()` 的既有做法）。

**默认只列有字典的版本**：与 `common.listDictVersions()`（外部字典 + 内嵌资源）取交集。判据是"装完就能直接汉化"——这也是本工具的定位。

### 2. 产物与安装方式

| 平台 | 资产 | 包内应用目录 |
|---|---|---|
| Windows | `GitHubDesktop-<版本>-<arch>-full.nupkg` | `lib/net45/` |
| macOS | `GitHub.Desktop-<arch>.zip` | `GitHub Desktop.app/Contents/Resources/` |
| Linux | —（官方不发，直接提示不支持） | — |

三者都是 zip 格式，`release-assets.js` 的 `PLATFORM_SPECS` 已定义好（本次只补一个"剥前缀"的映射）。

**安装 = 解压到 `<安装根>/app-<版本>/`**：

- 安装根 = `%LOCALAPPDATA%\GitHubDesktop`（Windows）/ `/Applications`（macOS），即 `common.candidateRoots()` 里含 `app-<版本>` 子目录的那一层；
- 只铺包内应用目录下的条目，NuGet 元数据（`[Content_Types].xml` / `_rels/` / `*.nuspec` / `package/services/`）全部跳过；
- **先铺到 `app-<版本>.part` 再改名**——中途失败不会留下一个"看着像装好了、实际缺文件"的目录；
- 完成后 `common.locateApp()` 自然认得出（`resources/app/` 下三个必需文件都在）。

### 3. 下载与校验

```text
① 取 checksums.txt（小文件）→ 记下目标资产的 sha256
② 下载 nupkg 到 <数据根>/tmp/downloads/<资产名>.part（带进度回调）
③ sha256 比对；不符 → 删临时文件、报错，不碰安装目录
④ 改名/解压到 app-<版本>.part → 改名成 app-<版本>
```

**为什么先下整包再解压**：`release-assets.js` 的按需取法是"每个条目一次 Range 请求"，1291 个文件就是 1291 次往返——为字典取 3 个文件时正合适，铺满整个应用则不可用。整包 293 MB 一次下完、本地解压，是这里唯一合理的做法。

**磁盘空间**：下载 + 解压峰值约 1 GB，开始前用 `fs.statfsSync()` 检查可用空间，不足即给可读提示（不猜、不硬上）。

### 4. 代理支持（`net.js`，零依赖）

`net.js` 的 `openStream()` 是**全仓库唯一的发请求入口**（`get` / `getRaw` / `head` / `getJson` / `postJson` / `download` 都经它；`release-assets.js` 的 Range 读法也走它），所以代理只在这一处实现。

**解析顺序**（首次调用时解析一次并缓存）：

1. 环境变量 `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy` / `ALL_PROXY`（`NO_PROXY` 命中则不走代理）；
2. 系统代理（无环境变量时）：
   - Windows：`reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"` 的 `ProxyEnable` / `ProxyServer`；
   - macOS：`scutil --proxy`；
   - Linux：无系统级标准，只用环境变量。

**隧道实现**：https 请求走 `CONNECT`（`http.request` 建隧道 → 拿裸 socket → 用它作 `https.request` 的 `createConnection`）。约 40 行，不引依赖。

**代理不可用时回退直连**：CONNECT 失败（代理软件没开、端口不通）→ 本次改直连，并**记住"该代理不可用"**，后续请求不再尝试。这是刻意选择——不支持代理时直连是能通的（只是慢），不能因为代理配置坏了让整个工具失去联网能力。回退时在日志/状态里留一句说明，不静默。

### 5. 两个形态的接入

**GUI**：「切换版本」窗口从"一组列表"变成"两组"——`本机已安装` / `可下载`。可下载项标注体积（来自 API 的 `asset.size`）与「需下载」。选中可下载项 → 确认框（写明体积与目标目录）→ 下载（`busy` 通道推进度）→ 完成后自动调 `setVersion` 切过去。

**CLI**：菜单 `4)` 列表末尾附可下载版本；选中后同样确认 → 下载（打印百分比）→ 切过去。

## 接口与数据结构

**新增 `scripts/cmd/install-version.js`**：

| 导出 | 入参 | 返回 |
|---|---|---|
| `listDownloadable()` | — | `{ ok, versions: [{ version, assetName, size, hasDict, platform }], error? }` |
| `install(version, opts)` | `{ onProgress, log, force }` | `{ version, appDir, bytes, verified }`，失败抛错 |

CLI：`node scripts/cmd/install-version.js <版本>`（`--list` 列可下载版本）。

**`net.js` 新增**：`setProxy(url | null)`（显式指定，测试用）、`getProxy()`（返回当前生效的代理或 null）。

**GUI IPC 新增**：

| 通道 | 入参 | 返回 |
|---|---|---|
| `downloadable` | — | `{ ok, versions }`（合并进 `state.installed` 的 `downloadable: true` 标记更省一次往返） |
| `installVersion` | `version` | `{ ok, version, notes, restarted, error? }` |

## 影响面

| 文件 | 改动 |
|---|---|
| `scripts/cmd/install-version.js` | **新增**：版本列表、下载、校验、解压 |
| `scripts/net.js` | 新增代理解析与 CONNECT 隧道（唯一入口 `openStream`） |
| `scripts/dict/release-assets.js` | 导出 `listVersions()`；补"包内应用目录 → 铺开时的前缀剥离"映射（`PLATFORM_SPECS` 加一个字段） |
| `scripts/gui/*`（5 个文件） | 窗口两组列表、下载进度、IPC 通道 |
| `scripts/cli.js` | 菜单 `4)` 加可下载版本与下载入口 |
| `README.md` / `AGENTS.md` / `docs/打包与分发.md` / `docs/design/gui/design.md` | 同步 |

**不动**：补丁链路（`patch` / `restore` / `inject`）、字典工具链的既有行为、CI 产物命名。

## 风险与对策

| 风险 | 触发条件 | 对策 |
|---|---|---|
| 下载慢或超时 | 国内直连 | 代理支持（本机实测快 39 倍）；失败给可读错误 + 手动下载指引（方案 C 的降级路径） |
| 代理配了但不可用 | 代理软件没开、端口不通 | CONNECT 失败即回退直连并记住，不让工具失去联网能力 |
| 磁盘空间不足 | 下载 293 MB + 解压约 700 MB | 开始前 `statfsSync` 检查，不足即拒绝并说明需要多少 |
| 官方改了包结构 | 未来版本改了打包方式 | 解压后校验 `resources/app/` 三个必需文件；缺即失败并清理，绝不铺半个目录 |
| 解压中途失败 | 断电、磁盘满 | 先铺 `.part` 目录，成功才改名；失败时清理 `.part` |
| 装出来的版本起不来 | 缺 Squirrel 更新器写的额外文件 | **实测环节必须真启动一次该版本**（不是只看文件在不在），起不来则如实报告并把这条路径降级为"仅供 patch 使用" |
