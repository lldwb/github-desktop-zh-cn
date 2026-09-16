# github-desktop-zh-cn

GitHub Desktop 中文汉化补丁工具（字典驱动，开源）。

## 项目定位

GitHub Desktop（Electron 应用）官方未提供简体中文界面——其界面文本硬编码在 Electron 打包产物中，依赖清单无 react-intl 等 i18n 库，官方未开放应用层翻译通道。

本仓库提供**开源**的汉化方案：以 JSON 语言字典为唯一翻译资产，用 Node.js 脚本对官方安装包内的 `main.js` / `renderer.js` 执行字符串替换，实现界面中文化。

技术路线与社区同类项目一致（如 [robotze/GithubDesktopZhTool](https://github.com/robotze/GithubDesktopZhTool)：同样按「版本对应 + 替换打包产物 + 字典驱动」工作）。区别在于本仓库**源码与字典全部开源**：字典可贡献、可自定义、可随官方版本重建，不依赖闭源二进制工具。

## 工作原理

1. GitHub Desktop 是 Electron 应用，界面文本硬编码在 `app.asar` 解包后的 `main.js`（主进程）与 `renderer.js`（渲染进程）中；
2. `dictionaries/<版本>/zh-CN.json` 维护「原文 → 中文」映射，字典与 GitHub Desktop 版本**强对应**（错配可能导致应用无法启动）；
3. 脚本工具链完成：定位官方安装目录 → 解包 `app.asar` → 按字典替换 → 重打包 / 直接替换目录文件。

## 目录结构

```
github-desktop-zh-cn/
├── README.md               # 本项目
├── LICENSE                 # MIT
├── package.json            # 脚本入口（unpack / patch / verify）
├── AGENTS.md / CLAUDE.md   # agent 指引（唯一权威源为 AGENTS.md）
├── dictionaries/           # 语言字典（核心资产），按版本目录组织
│   └── README.md           # 字典格式与贡献约定
├── scripts/                # 补丁工具链（Node.js）
│   └── README.md           # 各脚本职责与实现状态
└── docs/                   # 文档：使用说明 / 贡献指南（规划中）
```

## 使用方式

补丁工具链尚未落地（当前为仓库骨架初始化），使用步骤将在 `docs/` 补齐后写入本节。

## 与上游的关系与版权

- 本工具仅替换官方安装包内的界面文本，不修改官方功能；
- GitHub Desktop 遵循 MIT License，汉化后产物保留其版权声明；
- 本仓库代码与字典遵循 MIT License（见 `LICENSE`）。

## 贡献

字典条目贡献与脚本改进方式见 `docs/`（贡献指南，规划中）。
