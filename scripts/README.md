# scripts/ — 补丁工具链（Node.js，零依赖）

字典驱动的汉化补丁工具链，三个脚本均为 CLI 入口（`package.json` 中 `npm run locate / patch / verify`），共享逻辑在 `common.js`（SSOT：安装目录定位、版本读取、字典读取、备份）。

| 脚本 | 职责 | 状态 |
|------|------|------|
| `locate.js` | 定位安装目录（Windows 自动探测取最新版本；`--path` 手动指定跨平台），校验 `app/` 结构，备份原文件到 `tmp/backup/<版本>/` | 已实现 |
| `patch.js` | 校验字典版本与安装版本一致 → 按 `dictionaries/<版本>/zh-CN.json` 替换 `main.js` / `renderer.js` → 命中统计 → 写回（写回前自动备份） | 已实现 |
| `verify.js` | 校验版本一致性、字典条目命中率（两个文件均 0 命中才算缺失）、补丁后 `node --check` 语法校验 | 已实现 |

## 用法

```bash
node scripts/locate.js [--path <resources目录>] [--version <版本>]
node scripts/patch.js   [--dry-run] [--version <版本>] [--path <resources目录>]
node scripts/verify.js  [--version <版本>] [--path <resources目录>]
```

## 实现要点

- **零依赖**：官方 3.6.x 产物为 `resources/app/` 裸目录（无 `app.asar`，3.6.4 / 3.6.5 实测），无需 `@electron/asar` 解包 / 重打包，仅用 Node 内置模块。
- **替换策略（整串匹配）**：替换只发生在字符串字面量区间内，且仅当区间内容与字典键**完全相等**时替换。既保护标识符 / 属性名 / 正则 / 注释（如 `new Error()` 的 `Error` 是标识符，整串匹配不会命中），也避免子串误伤（如协议串 `sessions.setAdditionalPlugins` 含 `Add`）。
- **两种键**：
  - **普通键**：匹配字符串字面量内容，或模板字符串的文本段（如 `` `Fetch ${t}` `` 的 `"Fetch "`）；
  - **整模板键**：以反引号开头结尾、含 `${}` 插值的完整模板源码，**整段替换**——用于运行时拼接的文案（复数后缀 `${xU(n)}`、由函数拼出的动词等）。值与键同为 JS 模板/字符串字面量，外层模板优先、其内部文本段不再单独替换。
- **版本一致性**：字典目录名必须等于安装版本（`app/package.json` 的 `version` 字段），不一致直接拒绝，避免错配导致应用无法启动。
- **幂等**：对已汉化文件重复 `patch` 不会重复替换（英文原文已不存在），0 命中条目不告警。
- **安全边界**：写回前自动备份原文件到 `tmp/backup/<版本>/`，恢复 = 把备份复制回 `app/`；补丁后必须 `verify`（`node --check` 语法校验 + 残留英文清单）。
- **预览**：`patch --dry-run` 输出命中统计与 0 命中条目，不写盘。
- **验证**：`verify` 对补丁后文件跑 `node --check`（语法合法性）；已汉化状态下列出仍残留英文的条目，人工核对。
