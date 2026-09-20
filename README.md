# github-desktop-zh-cn

GitHub Desktop 中文汉化补丁工具（字典驱动，开源）。

## 项目定位

GitHub Desktop（Electron 应用）官方未提供简体中文界面——其界面文本硬编码在打包产物中，依赖清单无 react-intl 等 i18n 库，官方未开放应用层翻译通道。

本仓库提供**开源**的汉化方案：以 JSON 语言字典为唯一翻译资产，用 Node.js 脚本对官方安装目录内的 `main.js` / `renderer.js` 执行字符串替换，实现界面中文化。

技术路线与社区同类项目一致（如 [robotze/GithubDesktopZhTool](https://github.com/robotze/GithubDesktopZhTool)：同样按「版本对应 + 替换产物 + 字典驱动」工作）。区别在于本仓库**源码与字典全部开源**：字典可贡献、可自定义、可随官方版本重建，不依赖闭源二进制工具。

## 工作原理

1. GitHub Desktop 是 Electron 应用，界面文本硬编码在官方安装目录 `resources/app/` 下的 `main.js`（主进程）与 `renderer.js`（渲染进程）中——官方产物为**免打包裸目录**（无 `app.asar`，3.6.4 / 3.6.5 已实测）；
2. `dictionaries/<版本>/zh-CN.json` 维护「原文 → 中文」映射——**formatVersion 2 五段结构**：`common` / `windows` / `macos` / `linux` 分段放条目（跨平台共有与平台专有分开），`groups` 放组名（分类参考，不影响替换）。字典与 GitHub Desktop 版本**强对应**（错配可能导致应用无法启动）；本地没有对应版本的字典时，工具会**自动从本仓库拉取**（外部字典优先、打包内嵌兜底）；
3. 脚本工具链完成：定位安装目录 → 备份原文件 → 按字典替换 → 校验结果 → 重启应用。

## 目录结构

```
github-desktop-zh-cn/
├── README.md               # 本项目
├── LICENSE                 # GPL-3.0
├── CHANGELOG.md            # 各版本变更（发版时新增条目，Release 正文取自这里）
├── package.json            # 脚本入口（locate / patch / restore / verify / scan / tool / build / gui / dist）
├── AGENTS.md / CLAUDE.md   # agent 指引（唯一权威源为 AGENTS.md）
├── .claude/skills/         # 翻译维护技能（补译与纠错的流程、判定标准与探针模板）
├── .github/workflows/      # CI：矩阵构建各平台产物；推 tag 自动发 Release
├── dictionaries/           # 语言字典（核心资产）：按版本目录组织，formatVersion 2 五段结构；
│                           #   改字典一律走 scripts/dict/dict-edit.js（唯一写入口，先校验再原子替换）
│   ├── 3.6.0/zh-CN.json    # 首个版本字典
│   ├── 3.6.4/zh-CN.json
│   ├── 3.6.5/zh-CN.json
│   ├── 3.6.6/zh-CN.json    # 当前版本字典
│   └── README.md           # 字典格式与贡献约定
├── scripts/                # 运行时工具链（Node.js，零依赖；进 SEA bundle 与 Electron 应用包）
│   ├── common.js           # 共享：定位 / 版本 / 字典 / 备份 / 扫描匹配器 / 逆向还原（SSOT）
│   ├── net.js              # 零依赖 HTTPS 请求（下载字典 / 查更新 / 拉产物）
│   ├── cli.js              # 交互式中文菜单入口（SEA 产物的双击形态）
│   ├── update.js           # 工具自更新（查 latest release → 下载 → 替换自身 → 重启）
│   ├── cmd/                # 面向 GitHub Desktop 安装目录的操作（npm run 的对应项）
│   │   ├── locate.js       # 定位安装目录并备份
│   │   ├── patch.js        # 按字典替换并写回
│   │   ├── restore.js      # 还原官方原版（有备份用备份，没有则按字典逆向还原）
│   │   ├── verify.js       # 校验版本、命中率与语法
│   │   ├── scan.js         # 未翻译文案自查（读官方 sourcemap，输出待补清单）
│   │   ├── restart.js      # 汉化 / 还原后重启 GitHub Desktop
│   │   └── install-version.js  # 下载官方产物并铺成一份可用的安装（只支持 Windows）
│   ├── dict/               # 字典资产工具链
│   │   ├── dict-edit.js    # 字典的唯一写入口（增删改 / 分组 / 迁移，先校验再原子替换）
│   │   ├── dict-groups.js  # 组名自动推断（按条目在 sourcemap 里的出处）
│   │   ├── dict-auto.js    # 按官方新版本产物自动产出字典（AI 翻译 + 干跑校验）
│   │   ├── dict-prompt.js  # 发给翻译模型的系统提示词（唯一来源，GUI 的「翻译提示词」标签页展示它）
│   │   ├── dict-sync.js    # 字典在线同步（缺失时下载、强制更新最新）
│   │   └── release-assets.js  # 官方产物按需提取（HTTP Range，不下载整包）
│   └── inject/             # 往官方产物注入代码的补丁组（改逻辑不改文案）
│       ├── context-menu.js    # 右键菜单汉化（按 role 重打标签，随 patch 生效）
│       └── update-control.js  # 更新管控（禁止自动更新 / 没有字典就拦截）
├── gui/                    # 图形界面（Electron 原生窗口；业务逻辑仍来自 scripts/，无第二份实现）
│   ├── main.js             # 主进程：窗口 + IPC（直接 require ../scripts 的模块）
│   ├── preload.js          # contextBridge 暴露 window.api（渲染进程无 Node 能力）
│   ├── index.html          # 界面结构
│   ├── renderer.js         # 渲染逻辑：状态 / 两个标签页 / 只读字典表格 / 搜索 / 版本切换 / 关于
│   └── style.css           # 样式
├── electron-builder.yml    # GUI 打包配置（npm run dist → dist/gui/）
├── build/                  # 构建期资源（electron-builder 的 buildResources）
│   └── after-pack.js       # 打包钩子（electron-builder.yml 引用）：打包后删运行时组件
├── tools/                  # 构建与发布工具（不进产物）
│   ├── build.js            # 打包成单文件可执行（Node SEA）
│   ├── bundle.js           # 零依赖 CJS 单文件打包器
│   ├── changelog.js        # 从 CHANGELOG.md 提取指定版本段落（发版用）
│   ├── check-gui-dist.js   # GUI 产物静态自检（包结构 / 内置字典 / Windows 子系统），CI 与本地共用
│   └── ops/                # CI / Release 运维探针（匿名只读、参数化、自包含）
├── .npmrc                  # 构建期镜像（Electron 与 electron-builder 二进制走 npmmirror）
├── test/                   # 单元测试（npm test）：目录镜像 scripts/
│   ├── common/             # 匹配引擎与逆向还原
│   ├── dict/               # 字典工具链
│   ├── inject/             # 注入块
│   ├── fixtures/           # 夹具约定与清理助手
│   └── update.test.js      # 自更新（镜像 scripts/ 顶层）
└── docs/                   # 文档
    ├── 打包与分发.md        # 分发给普通用户：用法、构建、跨平台、常见问题
    ├── design/             # 设计过程记录：gui/ 与 dict-v2/ 的方案 / 设计 / 任务清单
    └── README.md           # 文档索引
```

## 下载 GitHub Desktop

本工具是**汉化补丁**，不含 GitHub Desktop 本身——请先到官网下载并安装官方客户端：

- **官网下载（推荐）**：<https://desktop.github.com> —— 页面会自动识别你的系统，点对应按钮下载 Windows / macOS / Linux 版；
- 装好后记下**版本号**（应用内 `Help` → `About GitHub Desktop`，或本工具菜单的 `3) 详细信息`）——汉化字典与版本**强对应**，错配可能导致应用无法启动。

本工具自身的下载：优先 **GitHub Releases**（<https://github.com/lldwb/github-desktop-zh-cn/releases>），国内访问不畅时用 **Gitee 镜像**（<https://gitee.com/lldwb/github-desktop-zh-cn/releases>）——发行版正文两边由 CI 自动同步，但**产物附件只在 GitHub**（Gitee 附件有单文件 100 MB、单仓库合计 1 GB 的限制，装不下这些安装包），Gitee 页面里的下载指引会带你回 GitHub。工具内的「检查更新」也是**先问 GitHub、取不到再退回 Gitee**（Gitee 兜底只够告知版本号，下载仍须走 GitHub）。

## 使用方式

### 方式一：图形界面（GUI 操作面板）

不想碰命令行的话，用 **Electron 图形界面**：汉化 / 还原 / 选择安装位置 / 切换版本 / 更新管控都是按钮，下方列出当前字典的全部条目（只读、可按中英文搜索），底部显示安装位置与进度——控制台菜单的每一步「看提示 → 敲数字」都变成点一下。工具自身的信息与「检查更新」「同步字典」收在工具栏最右的「关于」里。

界面：工具栏（汉化 / 还原 / 选择 / **更新管控** / **切换版本** / 刷新 / 关于）+ 两个标签页（**汉化字典**：英文 / 中文 / 组名 / 类型，只读可搜；**翻译提示词**：自动产出字典时交给翻译模型的那段提示词）+ 底部路径与状态栏；操作前有确认框（提示会先自动备份），完成后窗口内提示命中处数与重启结果，运行期间显示进度阶段。启动后还会**自动检查工具自身有无新版本**——有才提示一句，没有不打扰；点「关于」里的「检查更新」可以下载新安装包并启动安装向导（安装包先按 Release 里的 `SHA256SUMS` 核对，对不上不会启动）。

**切换版本**（工具栏「更新管控」右边）在**本机已安装的 GitHub Desktop** 之间切换——官方升级后旧的 `app-<版本>` 目录会留着，同一台机器上可能并存多个。点开是一份分两组的版本列表：

- **本机已安装**：**默认只列有汉化字典的版本**，勾上「显示没汉化的版本」才连没字典的一起列；每项带版本号、状态标签（当前 / 无字典 / 自定义目录）与所在目录，点一项即切换。
- **可下载**：官方 Release 里有产物、本机却没装的版本，点一项即**下载并安装**（约 300 MB，装到与官方安装相同的位置，**与现有版本并存**、不会替换它们），装完自动切过去。

选中的版本就是此后汉化 / 还原 / 更新管控 / 字典表格的对象；切换时会**默认勾选「同时禁止该版本自动更新」**，把选定的版本钉住、免得被官方更新悄悄换走（不想上锁就取消勾选）。

> 下载走**系统代理**：工具自己读环境变量（`HTTPS_PROXY` 等）与系统代理设置（Windows 注册表 / macOS `scutil`），代理不可用时回退直连。国内直连 GitHub 实测只有 15 KB/s（下 300 MB 要五个多小时），挂上代理是几十分钟量级。慢到不成时还有一条路：自己下好 `GitHubDesktop-<版本>-<架构>-full.nupkg`，用 `install` 子命令的 `--from <文件>` 从本地包装（`node scripts/cli.js install <版本> --from <文件>`）。

**更新管控**（工具栏那个按钮，命令行对应 `patch --update-control` / `patch --block-update` / `restore --group updateControl`）决定 GitHub Desktop 能不能自动更新，三选一：

- **没有对应字典就不更新**（推荐）：工具已经备好更高版本的字典时才放行——这样更新过去还是中文界面；
- **完全禁止自动更新**：不看字典，一律不放行；
- **恢复自动更新**：撤掉这道闸，回到官方行为（汉化保留）。

它往 GitHub Desktop 的 `main.js` 里注入一段代码，**改动的是逻辑不是文案**；和汉化一样可以单独撤掉，备份始终只有一份（官方原文）。注入的代码读不到工具的字典目录时**一律放行**——宁可让你更新，也不会因为工具自己的问题把你锁死在旧版本上。

GUI 产物**随 Release 分发**（三平台）：Windows 用 `github-desktop-zh-cn-gui-v<版本>-win32-x64-setup.exe`（安装包，可选安装目录）或 `…-gui-v<版本>-win32-x64.7z`（免安装，Windows 11 可直接解压），macOS 用 `…-gui-v<版本>-darwin-arm64.dmg`（Intel 机是 `…-gui-v<版本>-darwin-x64.dmg`），Linux 用 `…-gui-v<版本>-linux-x86_64.AppImage` / `…-gui-v<版本>-linux-amd64.deb`。也可以自行构建：

```bash
npm install       # 首次：安装 Electron 与 electron-builder（仅构建期依赖，不进产物逻辑）
npm run gui       # 开发态：直接打开窗口，用仓库里的字典与备份
npm run dist      # 按当前平台打包到 dist/gui/（Windows：NSIS + 7z；macOS：dmg；Linux：AppImage + deb）
```

首次构建会下载 Electron 二进制与打包工具（国内直连 GitHub 较慢）。仓库已把镜像固化在 `.npmrc` 与 `electron-builder.yml` 里，**无需手动设环境变量**。

GUI 与命令行是**同一套脚本**的两种界面——定位 / 替换 / 备份 / 还原规则完全一致，没有第二份实现。GUI 产物把数据目录定在**可执行文件所在目录**（与单文件产物相同），备份与 `config.json` 就地存放，两种界面可以随时换用；**macOS 是例外**——`.app` 包内写入会让签名失效（下次启动被 Gatekeeper 判为「已损坏」），故数据根恒为用户数据目录（`~/Library/Application Support/github-desktop-zh-cn`）。

> 免安装包请用 **7z**（解压即用，Windows 11 文件资源管理器原生支持）。electron-builder 的 portable 目标会把自身解压到临时目录再运行，备份与配置会跟着写进临时目录、退出后可能被清理，本仓库不提供该目标。

> GUI 产物放在**可写目录**使用（如 `D:\工具\`）。装进 `C:\Program Files` 时数据目录会按既有规则回退到用户数据目录，状态栏会如实显示当前数据根。

> 字典随包内置在应用内（`resources/dictionaries`），**首次运行时自动播种**到数据根——macOS 与 Linux 的 AppImage 取不到「可执行文件旁」，正是靠这一步拿到字典；已存在的版本不会被覆盖，自己替换过或在线更新过的字典保持不动。

### 方式二：单文件可执行（普通用户，无需 Node.js）

到 Releases 下载对应平台的单文件产物（Windows 是 `github-desktop-zh-cn-cli-v<版本>-win32-x64.exe`，macOS / Linux 是 `…-cli-v<版本>-<平台>-<架构>.bin`，后两者需 `chmod +x` 后运行），双击即用。

#### 1. 运行

双击产物，出现中文菜单：

```
 GitHub Desktop 汉化工具 v1.0.0
────────────────────────────────────────────────────────────────
 安装位置：C:\Users\<用户名>\AppData\Local\GitHubDesktop\app-3.6.6\resources\app
 应用版本：3.6.6
 字典版本：3.6.6（1885 条）
 当前状态：未汉化（官方原版）
 备份目录：（无——首次汉化时自动生成）
────────────────────────────────────────────────────────────────
 1) 汉化 GitHub Desktop       2) 还原官方原版
 3) 详细信息                  4) 安装位置 / 切换版本
 5) 检查更新（工具）            6) 更新管控
 7) 同步字典                  8) 关于
 0) 退出
 请选择：
```

| 选项 | 作用 |
| --- | --- |
| `1) 汉化` | 按当前版本字典汉化；**原文件会先自动备份**，可随时还原 |
| `2) 还原` | 还原官方原版（有备份时逐字节还原；没有备份则按字典反向还原成英文） |
| `3) 详细信息` | 显示数据目录、配置文件、字典来源、备份位置 |
| `4) 安装位置 / 切换版本` | 自动探测失败或装在非默认位置时手动指定（可直接把文件夹拖进窗口）；本机装了多个版本时先列出**有汉化的版本**让你挑 |
| `4)` 里的 `d)` | 下载并安装本机没有的版本：列出官方 Release 里有产物、且有汉化字典的版本，选中即下载安装（约 300 MB）并切过去 |
| `5) 检查更新` | 检查本工具自身有无新版本（打包态可直接在线更新并重启）——字典**不在这里**，见 `7)` |
| `6) 更新管控` | 决定 GitHub Desktop 能不能自动更新（三选一，见上文「更新管控」） |
| `7) 同步字典` | 拉取当前版本的最新字典并覆盖本地 |
| `8) 关于` | 工具版本、项目地址、许可证、数据目录，并问一次要不要检查更新 |

汉化 / 还原完成后工具会**自动重启 GitHub Desktop**（原本没在运行时则只提示，不替你多开窗口）——界面文本在应用启动时载入内存，不重启看不到效果。

菜单只输出**结果**（命中多少处、是否重启），中间过程不出现在菜单里；要看明细用命令行子命令（见 [docs/打包与分发.md](docs/打包与分发.md)）。

#### 2. 会自动找到 GitHub Desktop 吗

Windows 下会自动探测 `%LOCALAPPDATA%\GitHubDesktop` 下的**最新版本**目录。装了多个版本时（官方升级后旧的 `app-<版本>` 目录通常还留着），用菜单 `4)` 或 GUI 的「切换版本」切过去（CLI 的列表默认只列有字典的版本，其余版本用 `0)` 手动粘路径）。

macOS / Linux 或自定义安装位置：选 `4) 安装位置 / 切换版本`，把 `resources` 目录路径粘进去（也可直接拖拽文件夹）。指定过一次会被记住。

- macOS 例：`/Applications/GitHub Desktop.app/Contents/Resources`
- Linux 例：`/usr/lib/github-desktop/resources`

#### 3. 版本必须对应

字典与 GitHub Desktop 版本**强对应**，错配可能导致应用无法启动。工具已内置保护：

- 本地没有对应版本的字典时**自动到远程仓库拉取**（`dictionaries/<版本>/zh-CN.json`），拉不到就报错并拒绝汉化——不会拿别的版本的字典凑合；
- GitHub Desktop 更新到新版本后，若远程也还没有该版本的字典，需等字典发布后再重新运行本工具。

#### 4. 文件放在哪里

产物把「数据目录」定在**可执行文件所在目录**（放在 `D:\工具\` 里，数据就在 `D:\工具\`）：

```
D:\工具\
├── github-desktop-zh-cn-cli-v0.2.0-win32-x64.exe  # 产物本体（自带字典）
├── config.json                                  # 记住的安装位置（用过「安装位置 / 切换版本」才生成）
├── dictionaries\<版本>\zh-CN.json               # 在线拉取的字典（首次用到该版本时生成）
└── tmp\backup\<版本>\                           # 官方原版备份（首次汉化时生成）
```

放在**不可写**的位置（如 `C:\Program Files`）时，数据目录自动回退到用户数据目录：

- Windows：`%APPDATA%\github-desktop-zh-cn`
- macOS：`~/Library/Application Support/github-desktop-zh-cn`
- Linux：`$XDG_DATA_HOME`（默认 `~/.local/share/github-desktop-zh-cn`）

#### 5. 换成自己的字典

产物已内嵌发布时的字典，**外部字典优先于内嵌字典**。想改译文：在数据目录下建 `dictionaries\<版本>\zh-CN.json`（格式见 `dictionaries/README.md`），重新运行工具即可生效——不必重新打包。

#### 6. 系统提示怎么处理

- **Windows SmartScreen**：首次运行可能出现「Windows 已保护你的电脑」。产物未做代码签名（开源项目通常不做），点「更多信息」→「仍要运行」即可。
- **杀毒软件误报**：Node.js 打包的单文件程序（SEA）偶被启发式引擎误报，属已知误报类型；可加白名单，或改用源码方式运行。
- **macOS**：产物未签名时右键 →「打开」，或执行 `xattr -dr com.apple.quarantine <产物>`；用 `npm run build` 在 macOS 上构建会自动做 ad-hoc 签名（`codesign --sign -`），GUI 产物则**明确不做签名**（`mac.identity: null`，仓库无证书），首次打开一律走右键「打开」或去掉隔离属性。
- **汉化后 GitHub Desktop 本体**：替换的是官方安装目录内的 `main.js` / `renderer.js`，Windows 下可能触发 SmartScreen 提示，不影响功能。

#### 7. 卸载 / 还原

选 `2) 还原官方原版` 还原，然后删掉产物与数据目录即可——不写注册表、不装服务、不改系统设置。

自己构建单文件产物：`npm run build`（产物在 `dist/` 下，双击即用；跨平台构建方式见 [docs/打包与分发.md](docs/打包与分发.md)）。图形界面版见上面的「方式一」。

### 方式三：源码运行（开发者）

前置要求：本机已安装 Node.js 与对应版本的 GitHub Desktop（Windows 安装目录 `%LOCALAPPDATA%\GitHubDesktop`）。

```bash
npm run tool           # 交互式中文菜单（等价于单文件产物的双击运行）
npm run gui            # 图形界面操作面板（Electron 开发态，见「方式一」）
npm run locate         # 定位安装目录，校验结构，备份原文件到 tmp/backup/<版本>/
npm run patch          # 按字典替换 main.js / renderer.js 并写回
npm run verify         # 校验版本一致性、字典命中率、补丁后 JS 语法
npm run restore        # 还原官方原版（字典有删改时先还原再重打）
npm run scan           # 自查还有哪些界面文案没翻译（输出待补清单）
```

- `patch` 前建议先 `patch --dry-run` 预览命中统计（不写盘）；
- 替换前已自动备份：恢复官方版 = `npm run restore`（等价于把 `tmp/backup/<版本>/` 下的 `main.js` / `renderer.js` 复制回 `resources/app/`）；
- `patch` 是**原地替换**：删掉或改掉字典条目后不会自动从产物里退出，必须先 `npm run restore` 再 `npm run patch` 重打；
- 自动探测仅支持 Windows；macOS / Linux 或其他位置用 `--path <resources目录>` 显式指定（`node scripts/cmd/locate.js --path /path/to/resources`）；
- 官方更新覆盖汉化后，用对应新版本的字典重新执行 `locate` + `patch` 即可。

## 与上游的关系与版权

- 本工具仅替换官方安装包内的界面文本，不修改官方功能；
- GitHub Desktop 遵循 MIT License，汉化后产物保留其版权声明；
- 本仓库代码与字典遵循 GPL-3.0 许可证（Copyright (C) 2026 lldwb，见 `LICENSE`）。

## 已知限制

- 汉化后的 `main.js` / `renderer.js` 与官方文件不同，Windows 下可能触发 SmartScreen 提示（应用本体签名不受影响）；
- 打包产物（单文件可执行与 GUI 安装包）均未做代码签名，首次运行可能触发 SmartScreen / 杀软提示——处理方式见上文「系统提示怎么处理」；**macOS 上未签名产物无法直接双击**，需右键「打开」确认一次，或执行 `xattr -dr com.apple.quarantine "/Applications/GitHub Desktop 汉化工具.app"`；产物只能在构建平台运行，跨平台发布需各平台分别构建；
- 字典与版本强对应：错配可能导致应用无法启动，`patch` 前务必确认版本一致；
- **没有备份时的还原**：工具按字典把中文反向替换回英文，个别词形可能与官方略有差异（同义、单复数、大小写），少数译文本身就是空格 / 标点等通用文本的位置保持原样——追求与官方逐字节一致时，请到 <https://desktop.github.com> 重装该版本；
- **在线能力需要网络**：本地（或打包内嵌）没有对应版本字典时才会联网拉取；离线状态下首次使用某个新版本会失败，已有字典则完全离线可用；
- 字典（首个版本 3.6.0，当前 3.6.6）覆盖主界面、菜单、常用对话框与错误提示；少数由运行时拼接、或英文原文同时被非界面逻辑复用的文案保持英文（见 `dictionaries/README.md`「已知限制」）。

## 开发说明

本仓库使用 [lldwb-claude-skills](https://github.com/lldwb/lldwb-claude-skills.git)（Claude Code 技能集仓库）完成开发：从需求分析、缺陷修复到字典与工具链迭代，全程在 Claude Code 规范工作流（feature-dev / bug-fix 等技能）下实现。

## 贡献

字典条目贡献与脚本改进方式见 `docs/`（贡献指南，规划中）。

## 许可证

GPL-3.0

本仓库以 GNU General Public License v3.0 开源：允许使用、修改与分发，但衍生作品必须以相同协议（GPL-3.0）开源（copyleft）。完整条款见根目录 `LICENSE`。

Copyright (C) 2026 lldwb