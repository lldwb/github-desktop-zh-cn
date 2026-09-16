# scripts/ — 补丁工具链（Node.js）

字典驱动的汉化补丁工具链，三个脚本均为 CLI 入口（`package.json` 中 `npm run unpack / patch / verify`）：

| 脚本 | 职责 | 状态 |
|------|------|------|
| `unpack.js` | 定位 GitHub Desktop 安装目录，解包 `app.asar` | 未实现（骨架） |
| `patch.js` | 按 `dictionaries/<版本>/zh-CN.json` 替换 `main.js` / `renderer.js` 中的界面文本，重打包 / 写回 | 未实现（骨架） |
| `verify.js` | 校验替换结果（替换计数、残留英文串、字典与目标版本一致性） | 未实现（骨架） |

## 实现要点（规划）

- 解包 / 重打包使用官方维护的 `@electron/asar`；
- 替换策略：精确串匹配优先、正则兜底，处理占位符与 HTML 实体；
- 替换前校验字典版本与目标 GitHub Desktop 版本一致性；
- 支持 `--dry-run` 输出替换预览，不实际写盘。
