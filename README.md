# github-desktop-zh-cn

GitHub Desktop 中文汉化补丁工具（字典驱动，开源）。

## 项目定位

GitHub Desktop（Electron 应用）官方未提供简体中文界面——其界面文本硬编码在打包产物中，依赖清单无 react-intl 等 i18n 库，官方未开放应用层翻译通道。

本仓库提供**开源**的汉化方案：以 JSON 语言字典为唯一翻译资产，用 Node.js 脚本对官方安装目录内的 `main.js` / `renderer.js` 执行字符串替换，实现界面中文化。

技术路线与社区同类项目一致（如 [robotze/GithubDesktopZhTool](https://github.com/robotze/GithubDesktopZhTool)：同样按「版本对应 + 替换产物 + 字典驱动」工作）。区别在于本仓库**源码与字典全部开源**：字典可贡献、可自定义、可随官方版本重建，不依赖闭源二进制工具。

## 工作原理

1. GitHub Desktop 是 Electron 应用，界面文本硬编码在官方安装目录 `resources/app/` 下的 `main.js`（主进程）与 `renderer.js`（渲染进程）中——官方产物为**免打包裸目录**（无 `app.asar`，3.6.4 / 3.6.5 已实测）；
2. `dictionaries/<版本>/zh-CN.json` 维护「原文 → 中文」映射，字典与 GitHub Desktop 版本**强对应**（错配可能导致应用无法启动）；本地没有对应版本的字典时，工具会**自动从本仓库拉取**（外部字典优先、打包内嵌兜底）；
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
├── dictionaries/           # 语言字典（核心资产），按版本目录组织
│   ├── 3.6.5/zh-CN.json    # 首个版本字典
│   ├── 3.6.6/zh-CN.json    # 当前版本字典
│   └── README.md           # 字典格式与贡献约定
├── scripts/                # 补丁工具链（Node.js，零依赖）
│   ├── common.js           # 共享：定位 / 版本 / 字典 / 备份 / 扫描匹配器 / 逆向还原（SSOT）
│   ├── locate.js           # 定位安装目录并备份
│   ├── patch.js            # 按字典替换并写回
│   ├── restore.js          # 还原官方原版（有备份用备份，没有则按字典逆向还原）
│   ├── verify.js           # 校验版本、命中率与语法
│   ├── scan.js             # 未翻译文案自查（读官方 sourcemap，输出待补清单）
│   ├── net.js              # 零依赖 HTTPS 请求（下载字典 / 查更新 / 拉产物）
│   ├── dict-sync.js        # 字典在线同步（缺失时下载、强制更新最新）
│   ├── update.js           # 工具自更新（查 latest release → 下载 → 替换自身 → 重启）
│   ├── restart.js          # 汉化 / 还原后重启 GitHub Desktop
│   ├── cli.js              # 交互式中文菜单入口（SEA 产物的双击形态）
│   ├── bundle.js           # 零依赖 CJS 单文件打包器
│   ├── build.js            # 打包成单文件可执行（Node SEA）
│   └── changelog.js        # 从 CHANGELOG.md 提取指定版本段落（发版用）
├── gui/                    # 图形界面（Electron 原生窗口；业务逻辑仍来自 scripts/，无第二份实现）
│   ├── main.js             # 主进程：窗口 + IPC（直接 require ../scripts 的模块）
│   ├── preload.js          # contextBridge 暴露 window.api（渲染进程无 Node 能力）
│   ├── index.html          # 界面结构
│   ├── renderer.js         # 渲染逻辑：状态 / 只读字典表格 / 搜索 / 按钮
│   └── style.css           # 样式
├── electron-builder.yml    # GUI 打包配置（npm run dist → dist/gui/）
├── build/                  # 构建期资源（electron-builder 的 buildResources）
│   └── check-gui-dist.js   # GUI 产物静态自检（包结构 / 内置字典 / Windows 子系统），CI 与本地共用
├── .npmrc                  # 构建期镜像（Electron 与 electron-builder 二进制走 npmmirror）
├── test/                   # 匹配器单元测试（npm test）
└── docs/                   # 文档
    ├── 打包与分发.md        # 分发给普通用户：用法、构建、跨平台、常见问题
    ├── gui/                # GUI 形态的方案 / 设计 / 任务清单
    └── README.md           # 文档索引
```

## 下载 GitHub Desktop

本工具是**汉化补丁**，不含 GitHub Desktop 本身——请先到官网下载并安装官方客户端：

- **官网下载（推荐）**：<https://desktop.github.com> —— 页面会自动识别你的系统，点对应按钮下载 Windows / macOS / Linux 版；
- 装好后记下**版本号**（应用内 `Help` → `About GitHub Desktop`，或本工具菜单的 `3) 详细信息`）——汉化字典与版本**强对应**，错配可能导致应用无法启动。

## 使用方式

### 方式一：图形界面（GUI 操作面板）

不想碰命令行的话，用 **Electron 图形界面**：汉化 / 还原 / 选择安装位置 / 检查更新都是按钮，下方列出当前字典的全部条目（只读、可按中英文搜索），底部显示安装位置与进度——控制台菜单的每一步「看提示 → 敲数字」都变成点一下。

界面：工具栏（汉化 / 还原 / 选择 / 检查更新 / 刷新）+ 字典表格（英文 / 中文 / 类型）+ 底部路径与状态栏；操作前有确认框（提示会先自动备份），完成后窗口内提示命中处数与重启结果，运行期间显示进度阶段。

GUI 产物**随 Release 分发**（三平台）：Windows 用 `github-desktop-zh-cn-gui-v0.2.0-win32-x64-setup.exe`（安装包，可选安装目录）或 `…-gui-v0.2.0-win32-x64.zip`（免安装），macOS 用 `…-gui-v0.2.0-darwin-arm64.dmg`（Intel 机是 `…-gui-v0.2.0-darwin-x64.dmg`），Linux 用 `…-gui-v0.2.0-linux-x86_64.AppImage` / `…-gui-v0.2.0-linux-amd64.deb`。也可以自行构建：

```bash
npm install       # 首次：安装 Electron 与 electron-builder（仅构建期依赖，不进产物逻辑）
npm run gui       # 开发态：直接打开窗口，用仓库里的字典与备份
npm run dist      # 按当前平台打包到 dist/gui/（Windows：NSIS + zip；macOS：dmg + zip；Linux：AppImage + deb）
```

首次构建会下载 Electron 二进制与打包工具（国内直连 GitHub 较慢）。仓库已把镜像固化在 `.npmrc` 与 `electron-builder.yml` 里，**无需手动设环境变量**。

GUI 与命令行是**同一套脚本**的两种界面——定位 / 替换 / 备份 / 还原规则完全一致，没有第二份实现。GUI 产物把数据目录定在**可执行文件所在目录**（与单文件产物相同），备份与 `config.json` 就地存放，两种界面可以随时换用；**macOS 是例外**——`.app` 包内写入会让签名失效（下次启动被 Gatekeeper 判为「已损坏」），故数据根恒为用户数据目录（`~/Library/Application Support/github-desktop-zh-cn`）。

> 免安装包请用 **zip**（解压即用）。electron-builder 的 portable 目标会把自身解压到临时目录再运行，备份与配置会跟着写进临时目录、退出后可能被清理，本仓库不提供该目标。

> GUI 产物放在**可写目录**使用（如 `D:\工具\`）。装进 `C:\Program Files` 时数据目录会按既有规则回退到用户数据目录，状态栏会如实显示当前数据根。

> 字典随包内置在应用内（`resources/dictionaries`），**首次运行时自动播种**到数据根——macOS 与 Linux 的 AppImage 取不到「可执行文件旁」，正是靠这一步拿到字典；已存在的版本不会被覆盖，自己替换过或在线更新过的字典保持不动。

### 方式二：单文件可执行（普通用户，无需 Node.js）

到 Releases 下载对应平台的单文件产物（Windows 是 `github-desktop-zh-cn-cli-v<版本>-win32-x64.exe`，macOS / Linux 是 `…-cli-v<版本>-<平台>-<架构>.bin`，后两者需 `chmod +x` 后运行），双击即用。

#### 1. 运行

双击产物，出现中文菜单：

```
 GitHub Desktop 汉化工具 v0.2.0
────────────────────────────────────────────────────────────────
 安装位置：C:\Users\<用户名>\AppData\Local\GitHubDesktop\app-3.6.6\resources\app
 应用版本：3.6.6
 字典版本：3.6.6（1861 条）
 当前状态：未汉化（官方原版）
 备份目录：（无——首次汉化时自动生成）
────────────────────────────────────────────────────────────────
 1) 汉化 GitHub Desktop       2) 还原官方原版
 3) 详细信息                  4) 指定安装位置
 5) 检查更新（工具 + 字典）
 0) 退出
 请选择：
```

| 选项 | 作用 |
| --- | --- |
| `1) 汉化` | 按当前版本字典汉化；**原文件会先自动备份**，可随时还原 |
| `2) 还原` | 还原官方原版（有备份时逐字节还原；没有备份则按字典反向还原成英文） |
| `3) 详细信息` | 显示数据目录、配置文件、字典来源、备份位置 |
| `4) 指定安装位置` | 自动探测失败或装在非默认位置时手动指定（可直接把文件夹拖进窗口） |
| `5) 检查更新` | 拉取当前版本的最新字典，并检查本工具自身有无新版本（打包态可直接在线更新并重启） |

汉化 / 还原完成后工具会**自动重启 GitHub Desktop**（原本没在运行时则只提示，不替你多开窗口）——界面文本在应用启动时载入内存，不重启看不到效果。

菜单只输出**结果**（命中多少处、是否重启），中间过程不出现在菜单里；要看明细用命令行子命令（见 [docs/打包与分发.md](docs/打包与分发.md)）。

#### 2. 会自动找到 GitHub Desktop 吗

Windows 下会自动探测 `%LOCALAPPDATA%\GitHubDesktop` 下的**最新版本**目录。

macOS / Linux 或自定义安装位置：选 `4) 指定安装位置`，把 `resources` 目录路径粘进去（也可直接拖拽文件夹）。指定过一次会被记住。

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
├── config.json                                  # 记住的安装位置（用过「指定安装位置」才生成）
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
- 自动探测仅支持 Windows；macOS / Linux 或其他位置用 `--path <resources目录>` 显式指定（`node scripts/locate.js --path /path/to/resources`）；
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
- 字典（首个版本 3.6.5，当前 3.6.6）覆盖主界面、菜单、常用对话框与错误提示；少数由运行时拼接、或英文原文同时被非界面逻辑复用的文案保持英文（见 `dictionaries/README.md`「已知限制」）。

## 开发说明

本仓库使用 [lldwb-claude-skills](https://github.com/lldwb/lldwb-claude-skills.git)（Claude Code 技能集仓库）完成开发：从需求分析、缺陷修复到字典与工具链迭代，全程在 Claude Code 规范工作流（feature-dev / bug-fix 等技能）下实现。

## 贡献

字典条目贡献与脚本改进方式见 `docs/`（贡献指南，规划中）。

## 许可证

GPL-3.0

本仓库以 GNU General Public License v3.0 开源：允许使用、修改与分发，但衍生作品必须以相同协议（GPL-3.0）开源（copyleft）。完整条款见根目录 `LICENSE`。

Copyright (C) 2026 lldwb