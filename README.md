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
├── package.json            # 脚本入口（locate / patch / restore / verify / scan）
├── AGENTS.md / CLAUDE.md   # agent 指引（唯一权威源为 AGENTS.md）
├── .claude/skills/         # 翻译维护技能（补译与纠错的流程、判定标准与探针模板）
├── dictionaries/           # 语言字典（核心资产），按版本目录组织
│   ├── 3.6.5/zh-CN.json    # 首个版本字典
│   └── README.md           # 字典格式与贡献约定
├── scripts/                # 补丁工具链（Node.js，零依赖）
│   ├── common.js           # 共享：定位 / 版本 / 字典 / 备份 / 扫描匹配器
│   ├── locate.js           # 定位安装目录并备份
│   ├── patch.js            # 按字典替换并写回
│   ├── restore.js          # 从备份还原官方原版（字典删改后重打用）
│   ├── verify.js           # 校验版本、命中率与语法
│   └── scan.js             # 未翻译文案自查（读官方 sourcemap，输出待补清单）
├── test/                   # 匹配器单元测试（npm test）
└── docs/                   # 文档：使用说明 / 贡献指南（规划中）
```

## 使用方式

前置要求：本机已安装对应版本的 GitHub Desktop（Windows 安装目录 `%LOCALAPPDATA%\GitHubDesktop`）。

```bash
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
- 字典与版本强对应：错配可能导致应用无法启动，`patch` 前务必确认版本一致；
- 首个字典（3.6.5）覆盖主界面、菜单、常用对话框与错误提示；少数由运行时拼接、或英文原文同时被非界面逻辑复用的文案保持英文（见 `dictionaries/README.md`「已知限制」）。

## 开发说明

本仓库使用 [lldwb-claude-skills](https://github.com/lldwb/lldwb-claude-skills.git)（Claude Code 技能集仓库）完成开发：从需求分析、缺陷修复到字典与工具链迭代，全程在 Claude Code 规范工作流（feature-dev / bug-fix 等技能）下实现。

## 贡献

字典条目贡献与脚本改进方式见 `docs/`（贡献指南，规划中）。
