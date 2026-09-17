# github-desktop-zh-cn

GitHub Desktop 中文汉化补丁工具（字典驱动，开源）。

## 项目定位

GitHub Desktop（Electron 应用）官方未提供简体中文界面——其界面文本硬编码在打包产物中，依赖清单无 react-intl 等 i18n 库，官方未开放应用层翻译通道。

本仓库提供**开源**的汉化方案：以 JSON 语言字典为唯一翻译资产，用 Node.js 脚本对官方安装目录内的 `main.js` / `renderer.js` 执行字符串替换，实现界面中文化。

技术路线与社区同类项目一致（如 [robotze/GithubDesktopZhTool](https://github.com/robotze/GithubDesktopZhTool)：同样按「版本对应 + 替换产物 + 字典驱动」工作）。区别在于本仓库**源码与字典全部开源**：字典可贡献、可自定义、可随官方版本重建，不依赖闭源二进制工具。

## 工作原理

1. GitHub Desktop 是 Electron 应用，界面文本硬编码在官方安装目录 `resources/app/` 下的 `main.js`（主进程）与 `renderer.js`（渲染进程）中——官方产物为**免打包裸目录**（无 `app.asar`，3.6.4 / 3.6.5 已实测）；
2. `dictionaries/<版本>/zh-CN.json` 维护「原文 → 中文」映射，字典与 GitHub Desktop 版本**强对应**（错配可能导致应用无法启动）；
3. 脚本工具链完成：定位安装目录 → 备份原文件 → 按字典替换 → 校验结果。

## 目录结构

```
github-desktop-zh-cn/
├── README.md               # 本项目
├── LICENSE                 # GPL-3.0
├── CHANGELOG.md            # 各版本变更（发版时新增条目，Release 正文取自这里）
├── package.json            # 脚本入口（locate / patch / restore / verify / scan / tool / build）
├── AGENTS.md / CLAUDE.md   # agent 指引（唯一权威源为 AGENTS.md）
├── .claude/skills/         # 翻译维护技能（补译与纠错的流程、判定标准与探针模板）
├── .github/workflows/      # CI：矩阵构建各平台产物；推 tag 自动发 Release
├── dictionaries/           # 语言字典（核心资产），按版本目录组织
│   ├── 3.6.5/zh-CN.json    # 首个版本字典
│   ├── 3.6.6/zh-CN.json    # 当前版本字典
│   └── README.md           # 字典格式与贡献约定
├── scripts/                # 补丁工具链（Node.js，零依赖）
│   ├── common.js           # 共享：定位 / 版本 / 字典 / 备份 / 扫描匹配器（SSOT）
│   ├── locate.js           # 定位安装目录并备份
│   ├── patch.js            # 按字典替换并写回
│   ├── restore.js          # 从备份还原官方原版（字典删改后重打用）
│   ├── verify.js           # 校验版本、命中率与语法
│   ├── scan.js             # 未翻译文案自查（读官方 sourcemap，输出待补清单）
│   ├── cli.js              # 交互式中文菜单入口（打包产物的双击形态）
│   ├── bundle.js           # 零依赖 CJS 单文件打包器
│   ├── build.js            # 打包成单文件可执行（Node SEA）
│   └── changelog.js        # 从 CHANGELOG.md 提取指定版本段落（发版用）
├── test/                   # 匹配器单元测试（npm test）
└── docs/                   # 文档
    ├── 打包与分发.md        # 分发给普通用户：用法、构建、跨平台、常见问题
    └── README.md           # 文档索引
```

## 使用方式

### 方式一：下载现成产物（普通用户，无需 Node.js）

到 Releases 下载对应平台的单文件产物，双击运行，按中文菜单操作即可（汉化 / 还原 / 指定安装位置）。详见 **[docs/打包与分发.md](docs/打包与分发.md)**。

自己构建产物：`npm run build`（产物在 `dist/` 下，双击即用；跨平台构建方式见该文档）。

### 方式二：源码运行（开发者）

前置要求：本机已安装 Node.js 与对应版本的 GitHub Desktop（Windows 安装目录 `%LOCALAPPDATA%\GitHubDesktop`）。

```bash
npm run tool           # 交互式中文菜单（等价于打包产物的双击运行）
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
- 打包产物（单文件可执行）未做代码签名，首次运行可能触发 SmartScreen / 杀软提示——处理方式见 `docs/打包与分发.md`「系统提示怎么处理」；产物只能在构建平台运行，跨平台发布需各平台分别构建；
- 字典与版本强对应：错配可能导致应用无法启动，`patch` 前务必确认版本一致；
- 字典（首个版本 3.6.5，当前 3.6.6）覆盖主界面、菜单、常用对话框与错误提示；少数由运行时拼接、或英文原文同时被非界面逻辑复用的文案保持英文（见 `dictionaries/README.md`「已知限制」）。

## 开发说明

本仓库使用 [lldwb-claude-skills](https://github.com/lldwb/lldwb-claude-skills.git)（Claude Code 技能集仓库）完成开发：从需求分析、缺陷修复到字典与工具链迭代，全程在 Claude Code 规范工作流（feature-dev / bug-fix 等技能）下实现。

## 贡献

字典条目贡献与脚本改进方式见 `docs/`（贡献指南，规划中）。

## 许可证

GPL-3.0

本仓库以 GNU General Public License v3.0 开源：允许使用、修改与分发，但衍生作品必须以相同协议（GPL-3.0）开源（copyleft）。完整条款见根目录 `LICENSE`。

Copyright (C) 2026 lldwb