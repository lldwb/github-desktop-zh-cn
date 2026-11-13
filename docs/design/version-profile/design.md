# 每版本替换逻辑档案（version-profile）设计

> 状态：**第一阶段已落地**（模块 + 3.6.7 样板档案 + patch/restore/verify 接入 + 单测 + 端到端）。
> 第二阶段（其余 4 个存量版本档案、dict-sync / 打包 / GUI / dict-auto / CI / 文档）见 §8，尚未实施。
>
> 读者：维护「版本升级」流水线的人、正在改 `scripts/cmd/*` 与 CII 的人、需要读/写 `dictionaries/<版本>/patch.json` 的人。
> 相关实现：`scripts/version-profile.js`（本设计的唯一实现）、`scripts/cmd/patch.js`、`scripts/cmd/restore.js`、
> `scripts/cmd/verify.js`、`scripts/inject/context-menu.js`、`scripts/inject/update-control.js`。

## 1. 背景与问题

仓库的核心资产是 `dictionaries/<版本>/zh-CN.json`（字典），替换引擎按字典对官方产物做字符串替换。
但**替换逻辑本身也有版本相关性**，而它此前是全局单份、按「最新版实测值」写死的：

| 版本相关点 | 原实现 | 风险 |
| --- | --- | --- |
| 注入点（两个注入块插在 `//# sourceMappingURL=` 注释之前） | `context-menu.js` / `update-control.js` 各写一份 `'\n//# sourceMappingURL='` 字面量 | 产物结构变化时静默落到文件末尾或插错位置 |
| 更新管控方法闸门锚点 | `update-control.js` 写死 `'async checkForUpdates('` 并要求 1 次 | 旧版本方法形态不同（如非 `async`）时**只是没报错**，不是验证过 |
| 右键菜单标签表 | `context-menu.js` 按 Electron 44 写死两套标签，**没有任何锚点断言** | Electron/菜单结构变化时标签保持英文且不报错；旧版本全局套用 |
| 目标文件清单 `TARGETS` | `common.TARGETS` 全局常量 | 各版本产物结构差异无从表达 |

结论：所谓「一套全局替换逻辑服务所有版本字典」只对 3.6.6 实测过；其它版本是「没报表」而非「验证过」。
同时 CI「字典自动更新」最近三次定时全红（3.6.10 的 11 条新文案 AI 翻译全部 ECONNREFUSED、未译超门槛），
根因之一是**失败不可分类**（网关不可达与翻译质量差在日志里长得一样），且流水线只产字典、不产「怎么替换」。

用户已确认的策略：**严格质量门禁不变**；把「AI 不可达」与「翻译质量差」分类，失败时上传待译草稿 artifact +
可执行注解，不静默降级。

最终形态：**每个版本自包含「一份字典 + 一套替换逻辑档案」**，流水线成对产出、成对校验。

## 2. 目标与非目标

**目标**

1. 版本相关的替换逻辑从代码搬进数据：`dictionaries/<版本>/patch.json`（下称「档案」）。
2. 引擎按目标版本加载档案并**强校验**：档案缺失 / 结构非法 / 锚点次数不符 / 策略名未知 → 明确拒绝 + 可读下一步。
   绝不静默套用其它版本（或「最新版」）的逻辑。
3. 字典与档案**成对**：只有一半视为不完整（`pairStatus` / `assertPair`）。
4. 档案由官方两平台产物**探测生成**，探测证据（产物名、版本、文件字节数与 sha256、锚点实测次数、
   标签来源与字面量次数）随档案入库、可追溯。
5. 数据驱动、**不执行远端代码**：档案只是 JSON，引擎只解释它，不 `eval`、不 `require` 档案里引用的任何东西。

**非目标**

- 不改变字典的格式与内容（`zh-CN.json` 不动，翻译资产仍只有字典一份）。
- 不在档案里存任何「原文 → 中文」映射（翻译仍只在字典）。
- 不引入第三方依赖（仍只用 Node 内置模块 + 本仓模块）。
- 本设计不改变「替换算法」本身（字符串字面量整串替换、作用域键、整模板键等都不变）。

## 3. 核心模型

```text
dictionaries/<版本>/
├── zh-CN.json        翻译字典：原文 → 中文（唯一翻译资产；格式见 dictionaries/README.md）
└── patch.json        替换逻辑档案：该版本「怎么替换」（本文件设计；数据，不执行）
```

- 两个文件**同版本强对应**：目录名 = 官方产物 `package.json.version`；档案里也写 `version`，加载时核对。
- 「字典 + 档案」是**一对**：`pairStatus(version)` 返回 `{ dict, profile, paired, missing }`；
  `assertPair(version)` 在不成对时抛错并指出缺哪份、怎么补。缺一半时不拿其它版本凑合。
- 档案的来源与字典同序：**外部文件 → 内嵌资源（SEA 产物）→ 联网获取**（第二阶段接通；见 §8.1）。
- 档案的写入口只有一个：`version-profile.js` 的 `writeProfile()`（先整份校验、再 `.part` 改名的原子落盘）；
  探测生成、dict-auto 二阶段产出都要走它。字典仍只走 `dict-edit.js`——两条写入口不混。

## 4. 档案 schema（`schemaVersion: 1`）

完整示例见 `dictionaries/3.6.7/patch.json`。字段定义如下（标 `?` 为可选）。

```jsonc
{
  "schemaVersion": 1,              // 结构版本：引擎只认自己认识的值，不猜测旧/新结构
  "version": "3.6.7",              // 必须等于目录名 / 目标版本
  "generatedAt": "…ISO…",          // 探测时间（人工维护的档案可省）
  "generator": "scripts/version-profile.js probe --version 3.6.7",
  "targets": ["main.js", "renderer.js"],   // 替换对象：必须与 common.TARGETS 完全一致

  "sourcemaps": { "main.js": true, "renderer.js": true },  // 官方产物 sourcemap 可用性（scan/组名推断依赖）

  "anchors": {
    // 锚点 id → 定义。id 由策略参数引用，避免同一个锚点在多个策略里各写一遍字符串而漂移。
    "injectionPoint": {
      "text": "\n//# sourceMappingURL=",     // 锚点文本（含换行：行首定位，避免命中别的注释）
      "file": "main.js",                    // 锚点所在替换对象
      "placement": "before-last",           // unique | before-last | append-eof
      "expected": 1                         // 实测出现次数（探测得到，两平台必须一致）
    },
    "checkForUpdates": {
      "text": "async checkForUpdates(",
      "file": "main.js",
      "placement": "unique",
      "expected": 1
    }
  },

  "injections": {
    // 策略名 → 参数。策略名是档案与引擎之间的契约：未知名字一律拒绝（多写一个键 = 有人以为它生效了）。
    "context-menu": {
      "enabled": true,                      // 是否启用该注入（探测判定；引擎按此跳过或拒绝）
      "injectionPoint": "injectionPoint",   // 引用 anchors 里的 id（注入块插在锚点之前）
      "labels": {                           // 该平台官方菜单实际使用的英文标签（role → label）
        "windows": { "undo": "&Undo", "redo": "&Redo", "cut": "Cu&t", "copy": "&Copy",
                     "paste": "&Paste", "delete": "Delete", "selectall": "Select &all" },
        "macos":   { "undo": "Undo", "redo": "Redo", "cut": "Cut", "copy": "Copy",
                     "paste": "Paste", "delete": "Delete", "selectall": "Select All" }
      }
    },
    "update-control": {
      "enabled": true,
      "injectionPoint": "injectionPoint",
      "methodAnchor": "checkForUpdates"     // 引用 anchors 里的 id（闸门插在该方法体开头）
      // 禁用时写 "enabled": false 并附 "reason"（探测记录为什么该版本不支持，如锚点出现 0/2 次）
    }
  },

  "evidence": {                              // 探测证据（可选：手工夹具可省；probe 生成的档案必带）
    "probe": {
      "at": "…ISO…", "tool": "scripts/version-profile.js",
      "platforms": ["windows", "macos"],
      "archs": { "windows": "x64", "macos": "x64" },
      "menuSource": "webpack:///./app/src/main-process/menu/build-default-menu.ts"
    },
    "platforms": {
      "windows": {
        "platform": "windows", "arch": "x64",
        "assetName": "GitHubDesktop-3.6.7-x64-full.nupkg",
        "assetBytes": 236870636, "archiveEntries": 1161,
        "appDir": "lib/net45/resources/app",     // 包内路径（不是本机解包路径）
        "appVersion": "3.6.7",
        "files": {                               // 探测所用文件的字节数与 sha256（可复核取到的产物没错）
          "main.js":     { "bytes": 242446, "sha256": "05a1…" },
          "renderer.js": { "bytes": 3218276, "sha256": "e43d…" },
          "package.json":{ "bytes": 507, "sha256": "edcd…" }
        },
        "sourcemaps": { "main.js": { "present": true, "sourcesContent": true },
                        "renderer.js": { "present": true, "sourcesContent": true } },
        "anchors": { "injectionPoint": 1, "checkForUpdates": 1 },   // 实测次数
        "labels": {                             // 每个 role 的标签 + 来源 + 该平台 bundle 里字面量出现次数
          "undo": { "label": "&Undo", "origin": "build-default-menu",
                    "source": "webpack:///…/build-default-menu.ts:161", "bundleLiteralCount": 1 },
          "delete": { "label": "Delete", "origin": "electron-default", "source": "electron-default", "bundleLiteralCount": 0 }
        }
      },
      "macos": { /* 同形 */ }
    }
  }
}
```

### 4.1 锚点 placement 的语义

| placement | 期望次数 | 注入器行为 | 用途 |
| --- | --- | --- | --- |
| `unique` | 必须恰好 1 | `indexOf` 定位，必须是唯一一处 | 更新管控方法闸门（`async checkForUpdates(`） |
| `before-last` | ≥1（实测值） | `lastIndexOf` 定位，插在最后一次之前 | 注入点（文件末尾 `//# sourceMappingURL=` 注释之前，IIFE 之外） |
| `append-eof` | 必须 0 | 追加到文件末尾 | 产物没有 sourceMappingURL 注释时的兜底（探测到 0 次才用） |

### 4.2 校验规则清单（`validateProfile`）

引擎在加载时逐项校验，任何一项不满足即拒绝（错误消息 + `hint` 给下一步）：

1. `schemaVersion` 必须是引擎支持的值（当前 1）。
2. `version` 必须等于目标版本。
3. `targets` 必须是引擎支持的替换对象且**顺序完全一致**（共同契约，不能单方面改）。
4. `anchors` 非空；每个锚点：`text` 非空串、`file` ∈ targets、`placement` ∈ 三种、`expected` 非负整数且与
   placement 组合自洽（`unique`⇒expected=1；`before-last`⇒expected≥1；`append-eof`⇒expected=0）。
5. `injections` 的每个键必须是已知策略名（当前 `context-menu` / `update-control`）；值为对象，`enabled` 是布尔。
6. 启用的策略必须把参数引用的锚点 id 都指向**已定义**的锚点。
7. `context-menu` 启用时：`labels` 必须含 `windows` 与 `macos` 两张**非空** role→label 表；role 名小写；
   两平台 **role 集合必须一致**（同一批 Electron editMenu 展开项，只是标签不同）。
8. `sourcemaps`（若有）键 ∈ targets、值为布尔。
9. `evidence`（若有）：两个官方平台齐全；`appVersion` 等于档案版本；文件 bytes 为整数、sha256 为 64 位小写十六进制；
   每个「被启用策略引用的锚点」在**两平台**的实测次数都必须等于档案 `expected`（期望值不是手填，是实测）；
   声明表里的每个 role 都必须在该平台证据里有同标签记录。
10. 校验函数**返回规范化对象**（不原地改传入对象），保证写盘与内存中是同一份结构。

## 5. 引擎语义

### 5.1 加载与来源

`loadProfile(version)` → `{ profile, source: 'external'|'embedded', path, label }`：

1. `<数据根>/dictionaries/<版本>/patch.json`（外部优先；数据根 = `common.dataRoot()`，源码态即仓库根）；
2. 内嵌资源 `dictionaries/<版本>/patch.json`（SEA 单文件产物用 `node:sea` 的 `getAsset`；第二阶段内嵌）；
3. 都没有 → 抛错：`缺少 GitHub Desktop <版本> 的替换逻辑档案：<路径>（也没有内嵌档案）`，
   hint 指向「工具菜单「同步字典」会成对拉取」或 `node scripts/version-profile.js probe --version <版本> --write`。

**注意**：档案缺失时绝不回退到「最新版」或「其它版本」的逻辑——那正是本次改造要消灭的全局假设。

### 5.2 策略解析

`hasStrategy(profile, name)`：声明且 `enabled !== false` 才算有。
`strategy(profile, name, { platform })`：

- 未声明 / 未启用 → **抛错**（带 `reason` 与下一步），调用方不得静默跳过；
- `context-menu` → 返回 `{ label, labels: role→英文标签（当前平台的表）, injectionPoint: 锚点定义 }`；
- `update-control` → 返回 `{ label, injectionPoint, methodAnchor }`；
- 平台选择：`darwin → macos`，其余（含 linux）→ `windows` 表。理由与 `build-default-menu.ts` 的
  `__DARWIN__ ? mac : win` 三目一致——Linux 无官方产物可探测，社区产物沿用非 darwin 形态。

### 5.3 锚点断言

`assertAnchors(content, profile, { file, strategies })`：

- 只断言**本次操作真正要注入的策略**所引用的锚点（`strategies` 省略 = 所有启用策略）：
  只汉化不该被「更新管控」的锚点变化挡住；但一旦请求了该操作，锚点不符就必须拒绝。
- 对每个锚点用 `countOccurrences` 与期望次数比较；不符抛错，消息含：
  文件、锚点文本、实测/期望次数、判读（0 次 = 产物结构变了；多次 = 锚点不再唯一或产物非该版本官方原版）、
  下一步（确认安装版本 / `--path` 指向官方产物 / 重新探测生成档案）。
- 返回 `{ 锚点 id → 实测次数 }`，供日志与测试使用。

### 5.4 各入口的接入点与失败语义

| 入口 | 读档案 | 锚点断言 | 失败语义 |
| --- | --- | --- | --- |
| `patch.run` | 恒读（`resolveVersion` 之后、联网与写盘之前） | 写盘前：i18n 的 `context-menu` 锚点；请求了 `--update-control` 时**同时**断言 `update-control` 锚点 | 抛错（exit 1）；hint 给下一步；**失败前不写盘/不建备份** |
| `patch` 的注入 | 标签表、注入点、方法锚点全部来自档案（`strategy()`） | 注入器内部再加一道次数防线（返回 `changed:false`+reason） | 未启用策略被请求 → 明确拒绝（不静默跳过） |
| `restore.run`（按组重放 updateControl） | 读档案 | 在官方原文上断言 `update-control` 锚点 | 档案缺失/策略未启用 → 明确失败（账上记着该组却无法重放，静默跳过会让「保留的组」凭空消失） |
| `restore.run`（整份还原 / 字典逆向） | 不需要（不注入） | — | 不受档案影响：这是恢复通道，不能被档案问题卡死 |
| `verify` | 恒读 | 对当前产物断言**所有启用策略**的锚点；失败计入 `failed` → exit 1 | 同时用档案标签表检查右键菜单标签的字典覆盖情况 |
| `version-profile check` | 读档案 | 对 `--path` 指定产物断言锚点 | 失败 exit 1（探测后/迁移前的核对命令） |
| `version-profile probe` | 生成档案 | 生成即校验（`validateProfile`） | 探测失败给可读原因（见 §6.3） |

**dry-run**：`patch --dry-run` 不写盘，但档案加载、锚点断言照做（预览必须能暴露与真实运行同样的失败）；
`--update-control --dry-run` 会断言锚点后提示「未注入」。

**版本错配**：`patch` 的 `resolveVersion` 仍是第一道（字典目录名 ≠ 安装版本 → exit 2，既有契约）；
档案版本不一致是第二道（exit 1，消息含「不要改名绕过」）。

## 6. 探测与档案生成

### 6.1 探测流程（`probeVersion`，联网）

1. 对 `windows` / `macos` 两平台，用 `scripts/dict/release-assets.js` 的 `fetchApp()` 经 HTTP Range
   只取官方产物 zip/nupkg 里的 app 目录（`main.js` / `renderer.js` / `package.json` / `*.map`），
   解包到 `<数据根>/tmp/version-profile/<版本>/<平台>/app/`（与真实安装目录同形，可直接喂 scan/verify）。
   产物取失败重试一次（release-assets 主机在部分网络下会被重置）。
2. 对每个平台目录调 `probeApp(appDir, meta)`（纯本地读文件，不联网）：
   - 读 `package.json.version`，与目标版本核对（取错版本立刻失败）；
   - 记录 `main.js` / `renderer.js` / `package.json` 的字节数与 sha256；
   - 记录 `main.js.map` / `renderer.js.map` 是否 present、是否有 `sourcesContent`；
   - 统计锚点实测次数（`injectionPoint`、`checkForUpdates`）；
   - **标签推导**：从 `main.js.map` 的官方源码里找 `app/src/main-process/menu/build-default-menu.ts`，
     解析 Edit 子菜单块：`{ role: 'undo', label: __DARWIN__ ? 'Undo' : '&Undo' }` 取三目两侧；
     Select All 项（无 role、靠 `accelerator: 'CmdOrCtrl+A'` 识别）映射到 role `selectall`；
     只写 role 的角色（如 `delete`）用 `ELECTRON_DEFAULT_ROLE_LABELS`（Electron 运行时生成的英文默认标签）补齐；
     必需角色（undo/redo/cut/copy/paste/selectall）缺一个即失败——不生成「猜出来」的档案；
   - **交叉验证**：推导出的该平台标签必须在该平台 `main.js` 的字符串字面量里至少出现 1 次
     （delete 例外：产物里 0 次是预期，若已存在字面量则拒绝——避免注入引入重复替换目标）。
3. `buildProfile(version, { measurements })`（纯函数，不联网）把两平台测量合并成档案：
   - 两平台锚点实测次数**必须一致**（schema v1 不支持按平台不同期望；不一致 → 探测失败，人工确认后再扩 schema）；
   - 两平台从源码推导的标签表**必须一致**，且与各自 bundle 的字面量证据一致；
   - `checkForUpdates` 两平台都恰好 1 次 → 启用 `update-control`；否则**显式禁用并写 reason**（该版本不支持这项注入）；
   - `injectionPoint` 实测 ≥1 → `before-last`；0 次 → `append-eof`；
   - 组装 `evidence`（不含本机绝对路径——只记产物名与包内路径，开源仓库不写机器路径/机器名）；
   - 最后调 `validateProfile` **生成即校验**，保证探出来的档案一定能被引擎加载。
4. CLI `probe --write` 经 `writeProfile` 原子写入 `dictionaries/<版本>/patch.json`。

### 6.2 命令

```bash
# 探测并落盘（需要网络；产物解包到 <数据根>/tmp/version-profile/<版本>/）
node scripts/version-profile.js probe --version 3.6.7 --write

# 覆盖已有档案（默认拒绝覆盖，防止冲掉已人工核对的版本）
node scripts/version-profile.js probe --version 3.6.7 --write --overwrite

# 查看摘要 / 校验 / 对本地产物断言锚点
node scripts/version-profile.js show --version 3.6.7 [--json]
node scripts/version-profile.js validate --version 3.6.7
node scripts/version-profile.js check --version 3.6.7 --path <resources目录>
```

### 6.3 探测失败语义（都明确失败，不产出半成品档案）

| 失败情形 | 处理 |
| --- | --- |
| 产物取不到 / 版本与目标不符 | 抛错（提示确认版本与网络） |
| `main.js.map` 缺失或没有 `sourcesContent` | 抛错（标签推导依赖官方源码，不瞎猜） |
| 官方源码里找不到 Edit 子菜单 / 必需角色标签 | 抛错（提示人工核对后更新探测规则） |
| 推导出的标签在该平台 bundle 里找不到字面量 | 抛错（平台分支推导错或官方菜单结构变了） |
| `delete` 标签在 bundle 里已有字面量 | 抛错（注入会引入重复替换目标，需人工确认） |
| 两平台锚点次数不一致 / 标签推导不一致 | 抛错（schema v1 不支持按平台差异；人工确认后再扩 schema） |

### 6.4 3.6.7 样板探测记录（可复核）

生成命令：`node scripts/version-profile.js probe --version 3.6.7 --write`（本机网络环境下 release-assets 主机
偶发重置，尝试 2 次后成功；产物随后按 sha256 与档案证据逐项复核一致）。落盘文件
`dictionaries/3.6.7/patch.json`（约 7 KB）。

| 平台 | 产物 | 大小 / 中央目录 | app 包内路径 | main.js | renderer.js |
| --- | --- | --- | --- | --- | --- |
| windows-x64 | `GitHubDesktop-3.6.7-x64-full.nupkg` | 236,870,636 B / 1161 条 | `lib/net45/resources/app` | 242,446 B `05a1b607…` | 3,218,276 B `e43df79e…` |
| macos-x64 | `GitHub.Desktop-x64.zip` | 524,332,240 B / 2184 条 | `GitHub Desktop.app/Contents/Resources/app` | 240,272 B `cae8bacf…` | 3,197,149 B `e757f1a9…` |

锚点实测（两平台一致）：`\n//# sourceMappingURL=` = 1，`async checkForUpdates(` = 1。
sourcemap：两平台 `main.js.map` / `renderer.js.map` 均 present 且带 sourcesContent。
标签推导来源：`build-default-menu.ts`（windows 标签在第 161/162/164/165/166/168 行；`delete` 为 Electron 默认标签）：
windows `&Undo / &Redo / Cu&t / &Copy / &Paste / Delete / Select &all`，
macos `Undo / Redo / Cut / Copy / Paste / Delete / Select All`；每个标签在对应平台 bundle 的字面量次数均为 1（delete 为 0）。

## 7. 兼容与迁移

### 7.1 阶段划分与中间态

- **第一阶段（已落地）**：模块 + 3.6.7 样板 + patch/restore/verify 接入 + 单测。存量 5 个版本里只有 3.6.7 有档案，
  因此 **3.6.0 / 3.6.4 / 3.6.5 / 3.6.6 在本阶段会明确拒绝打补丁/校验**（消息给「探测生成」下一步）。
  这是**刻意的**：宁可拒绝，也不静默套用未经探测的锚点。第二阶段补上这 4 份档案后恢复。
- **第二阶段**：其余 4 个存量版本按各自官方产物探测生成档案；`3.6.8~3.6.10` 由版本/字典线在产出字典时同步产出档案
  （同一套 `probeApp` + `buildProfile`，见 §8.6）；流水线各环节改为成对（§8）。

### 7.2 过渡默认值（二阶段应删除）

`context-menu.js` 保留 `DEFAULT_LABELS` / `labelsFor()`，`update-control.js` 保留 `DEFAULT_ANCHOR` / `DEFAULT_MARKER`：

- **生产路径不使用它们**：`patch` / `restore` / `verify` 一律显式传档案里的值；
- 保留原因：`dict-auto` 的「注入块字面量索引」在二阶段接入档案前仍依赖默认标签表（那是翻译候选判据）；
  注入器单测也用它当夹具基线；
- 二阶段把 `dict-auto` 改为按版本档案取标签后，这些默认值应删除（注入器只接受调用方给的参数）。

### 7.3 旧档案 / 外部自定义资源

- `schemaVersion` 不认识 → 拒绝（不猜测新旧结构）；工具升级后应同步字典与档案。
- 用户只有外部 `zh-CN.json`、没有 `patch.json`：`pairStatus` 判为不完整，`patch/verify` 拒绝并提示补齐档案路径。
  ——这改变了「只放一份字典就能覆盖」的既有能力，是有意的成对纪律；说明要进 `dictionaries/README.md`。
- 旧版工具（不认识档案）读新目录：只会忽略 `patch.json`，行为与改造前一致（向后兼容）。

## 8. 流水线改造清单（第二阶段，待实施）

> 以下为设计定稿，实施时逐项落地并回填本文件状态。**接口以 `scripts/version-profile.js` 的导出为准**（§10）。

### 8.1 在线获取成对（`scripts/dict/dict-sync.js` + `common.js`）

- `common.js`：新增 `remoteProfileUrls(version)`（与 `remoteDictUrls` 同一套 raw → jsDelivr → Gitee 兜底；
  URL 拼装仍只能在 common，遵守「远程地址只有一处定义」纪律）；新增 `profileFile` / 内嵌档案判定所需的路径函数
  （或直接复用 `version-profile.js` 的 `profileFile` / `hasEmbeddedProfile`）。
- `dict-sync.js`：`fetchPair(version)` 逐源同时取 `zh-CN.json` 与 `patch.json`，**两者都取到且都通过校验才算该源成功**；
  `writePair()` 两文件各写 `.part`、全部就绪后依次 rename，第二次 rename 失败要回滚第一次；
  `ensureDict()` 改为**成对判断**（外部成对 → 内嵌成对 → 联网成对），返回 `missing` 区分缺哪份；
  `syncLatest()` 覆盖语义同样成对；`prefetchDict()` 文案改「字典与档案」并区分网络失败 / 远端缺档案。
- 失败语义：只拿到一半 → 明确失败（列缺哪份），不落盘半对。

### 8.2 打包内嵌（`tools/build.js`）

- `collectAssets()` 改为「最新版本成对」：`dictionaries/<latest>/{zh-CN.json,patch.json}` 两份都内嵌；
  最新版本缺任一文件 → **构建失败**（不产出半对产物）。
- **一并修正既有不一致**（archify-lead 取证发现）：`build.js:61-74` 的实现只内嵌最新一版字典，
  而 159 行附近注释写「内嵌全部字典」——以实现为准改注释/日志（日志按「版本数」而不按 assets 条数打印）。

### 8.3 Electron 打包与播种（`electron-builder.yml` + `gui/main.js` + `tools/check-gui-dist.js`）

- `extraResources: dictionaries → resources/dictionaries` 会把 `patch.json` 自动带进包，配置无需改；
- `seedBundledDicts()` 改为**逐文件补齐**：`zh-CN.json` 与 `patch.json` 分别判断目标缺则复制
  （老用户数据根已有字典、没有档案，必须能只补档案；不能按「版本已播种」整体跳过）；
  `readdirSync` 增加 `DICT_VERSION_RE` 过滤（README/夹具目录不进数据根）。
- `check-gui-dist.js`：内置资源校验改为**成对**（两文件都在才算版本可用；档案做最小结构校验：合法 JSON、
  `version` 与目录名一致、`schemaVersion` 存在）；asar 清单加入 `scripts/version-profile.js`。

### 8.4 GUI / CLI 的「有没有字典」判定

- 保留 `common.listDictVersions()` 原义（字典存在），新增 `listDictPairs()`（成对）给需要成对语义处——
  避免直接改语义扩散到 8+ 调用点与既有测试。
- `gui/ipc/misc.js` 的 `hasDict` 与 `collectState` 改为**成对口径**；`gui/renderer.js` 三态
  `local / remote / none` 不变，但 `local` 指成对完整；「本地半对」要有单独提示（如「缺替换逻辑档案，请同步」），
  不能显示成可用、点汉化才报错。
- `install-version.listDownloadable()` / CLI 菜单 / `prefetchDict` 文案同步成对口径。
- 远端**目录列表无法证明档案存在**（现在只取 `dictionaries/` 目录名）：二选一
  （① 增加 `dictionaries/manifest.json` 由产出时同 commit 更新，含两文件 sha256；② 维持目录级但把
  `remoteDict.ok` 语义降为「远端可能有」，prefetch 失败文案区分网络失败与远端缺档案）。实施前定夺并更新 §8.4。

### 8.5 自动产出（`scripts/dict/dict-auto.js` + `.github/workflows/dict-auto.yml`）

- **产出档案**：`buildOne` 里在取到两平台产物后调 `probeApp` + `buildProfile`（纯函数，不额外联网）；
  与字典同一轮写盘、同一事务（任一失败 → 两个文件都回滚）；`--no-ai` 也产出/校验档案（档案与 AI 无关）。
- **迁移死锁**：`--on-exist=skip` 现在只判 `zh-CN.json` 存在 → 存量版本永远补不上档案、而引擎会拒绝。
  改为「字典**与档案**都存在才算 skip」。
- **失败分类**（用户已确认策略）：
  - `failureKind`：`ai-unreachable`（网络/超时/鉴权/5xx）/ `ai-quality`（占位符/空译/无汉字）/
    `product-fetch` / `profile-probe` / `dry-run-threshold` / `dict-validate`；
  - 失败时上传**待译草稿 artifact**（`tmp/dict-auto-pending-*.json`：version / text / source / targets / reason），
    workflow 加 `actions/upload-artifact`（`always()`，与报告 JSON 一起）；
  - 注解带 `title=`（`::error title=AI 网关不可达::…` / `::error title=翻译质量不达标::…`）；
  - AI 连通性**预检**（`--preflight` 或 workflow 内小脚本）：不可达时 fail-fast，不再伪装成「未译超门槛」。
- **gate 不变**：干跑语法/命中率、未译比例上限、字典校验等既有门槛保持严格；不静默降级。
- **提交门禁**：提交前加「字典与档案成对」检查步骤（轮内 `dictionaries/*` 缺任一 → `::error title=字典与档案不成对::`），
  防止半对入库后被 skip 永久固化。

### 8.6 新版本产出（版本/字典线）

新增版本时产出字典的人按同一入口产出档案：取到两平台官方产物后
`probeApp` → `buildProfile` → `writeProfile`（或 dict-auto 的同一链路）。不允许手写/复制旧版本档案的锚点。

### 8.7 文档同步（第二阶段一并做）

- `AGENTS.md`：核心资产、版本强对应、`common.js` 职责（内嵌资源读取）、dict-sync / dict-auto / build / check-gui-dist /
  字典组织 / hasDict 三态 等段落改「成对」口径（调研已给出逐行建议，实施时按行改）。
- `dictionaries/README.md`：目录树加 `patch.json`；新增「每版本替换逻辑档案」一节（字段、写入口、缺档案行为）。
- `.claude/skills/translation-maintain/references/版本升级.md`：升级流程加「探测生成/校验档案」一步；
  失效分类加「档案失效」；提交命令 `git add` 两文件；「不要拿旧版本套用」补充档案同样不能套用。
- `docs/agents/已知坑.md`：升级即失效、右键菜单锚点实测范围、Electron 播种、hasDict、自动产出注入标签等条目补成对口径。

## 9. 测试与验收

### 9.1 单元测试

- `test/version-profile.test.js`（28 例）：加载/来源、非法 JSON、schemaVersion、版本错配、targets 不一致、
  未知策略、锚点引用不存在、placement/expected 组合非法、labels 平台角色集合不一致、证据与声明不一致、
  锚点断言（正常 / 0 次 / 2 次 / append-eof / 按策略筛选）、策略解析（含 linux 沿用 windows 表、未启用/未声明/未知）、
  成对校验（只有字典 / 只有档案 / 成对 / assertPair）、写入口（拒绝覆盖 / overwrite / 原子无 `.part` 残留）、
  探测（两平台合成产物生成档案、两平台锚点不一致拒绝、两平台标签推导不一致拒绝、bundle 缺字面量拒绝、
  产物版本不符拒绝、sourcemap 缺 sourcesContent 拒绝）。
- `test/cmd/patch.test.js`：新增缺档案、锚点 0/2 次、未知策略、schemaVersion/targets、参数来自档案
  （自定义注入点 + 自定义标签表）、更新管控未启用被请求、更新管控锚点 0/2 次——都断言**拒绝且不写盘/不建备份**。
- `test/cmd/verify.test.js`：新增缺档案、锚点 0/2 次、档案声明更新管控但产物缺方法锚点。
- `test/inject/context-menu.test.js`：注入器参数化（自定义标签表 + 自定义注入点）；标签表来源改为
  「有档案的版本用档案表，无档案的版本退回过渡默认表」。
- `test/fixtures/profile.js`：档案夹具（make/write/writeRaw），与夹具字典同目录、非版本号形态、用例后清理。

### 9.2 3.6.7 端到端（官方产物解包副本）

产物：官方 windows-x64 3.6.7 的 app 目录复制到 `tmp/version-profile/e2e-3.6.7/resources/app/`
（`main.js` sha256 `05a1b607…`、`renderer.js` `e43df79e…`，与档案证据一致）。备份为官方原文（`tmp/backup/3.6.7/`）。
实测（命令与输出见交付回报）：

| 步骤 | 结果 |
| --- | --- |
| `version-profile check` | `锚点校验通过：injectionPoint=1、checkForUpdates=1`，exit 0 |
| `patch --dry-run` | 命中 main.js 128（其中右键菜单标签 7）/ renderer.js 2274，合计 2402，不写盘，exit 0 |
| `patch`（写盘） | 同上命中；exit 0 |
| `verify` | `main.js：命中 0 处`（已汉化）、`renderer.js：命中 8 处`、`校验通过。`，exit 0 |
| 抽查 | context-menu 注入块存在；main.js 中文片段去重 131 / renderer 1969 |
| `restore` | exit 0；两文件与官方产物 **逐字节相同**（sha256 一致） |
| `patch --update-control` | 命中同上；exit 0 |
| `verify`（含更新管控） | 校验通过，exit 0 |
| 抽查 | update-control 注入块存在、`if(!globalThis.__gdzcAllowUpdate())return;` 闸门在、guard 模式代码在 |
| 第二轮 `restore` | 两文件再次与官方产物逐字节相同 |

复跑命令（本机零重启：tmp 副本没有 `GitHubDesktop.exe`，`restartApp` 判定「未运行」不会碰真实应用）：

```bash
D=tmp/version-profile/e2e-3.6.7
node scripts/version-profile.js check --version 3.6.7 --path $D/resources
node scripts/cmd/patch.js --version 3.6.7 --path $D/resources --dry-run
node scripts/cmd/patch.js --version 3.6.7 --path $D/resources
node scripts/cmd/verify.js --version 3.6.7 --path $D/resources
node scripts/cmd/restore.js --version 3.6.7 --path $D/resources
node scripts/cmd/patch.js --version 3.6.7 --path $D/resources --update-control
node scripts/cmd/verify.js --version 3.6.7 --path $D/resources
node scripts/cmd/restore.js --version 3.6.7 --path $D/resources
```

### 9.3 全量测试 / 打包

- `npm test` 全绿（201 用例：200 pass，1 skip 为既有平台条件跳过；0 fail）。
- `node --check` 覆盖全部改动的脚本与测试文件。
- `npm run bundle`（`tools/bundle.js --out tmp/build/bundle.js`）通过：`version-profile.js` 的静态 `require`
  依赖（common / dict/release-assets）都能被收集。

## 10. 接口与文件清单（给其它工作线）

**模块导出（`scripts/version-profile.js`）**

```js
SCHEMA_VERSION, PROFILE_FILE, STRATEGIES, PLATFORM_KEYS,
profileFile(version), profileAssetKey(version), hasEmbeddedProfile(version),
readProfileText(version), loadProfile(version) -> { profile, source, path, label },
validateProfile(raw, { version }) -> normalizedProfile,
hasStrategy(profile, name), strategy(profile, name, { platform }) -> params,
anchorsFor(profile, strategies), assertAnchors(content, profile, { file, strategies }) -> counts,
pairStatus(version) -> { version, dict, profile, paired, missing },
assertPair(version),
writeProfile(version, profile, { overwrite, outFile }) -> file,
probeApp(appDir, meta) -> measurement,       // 纯本地读文件（dict-auto 二阶段直接用）
buildProfile(version, { measurements }) -> profile,  // 纯函数，生成即校验
probeVersion(version, { workDir, archWindows, archMacos, log }) -> Promise<profile>,  // 联网
describe(profile), countOccurrences(text, needle), profilePlatform(platform),
main  // CLI
```

**改动的文件**

| 文件 | 改动 |
| --- | --- |
| `scripts/version-profile.js` | 新增：档案加载/校验/策略解析/锚点断言/成对/写入口/探测/CLI |
| `dictionaries/3.6.7/patch.json` | 新增：3.6.7 样板档案（探测生成，含两平台证据） |
| `scripts/cmd/patch.js` | 读档案、写盘前锚点断言、注入参数来自档案、更新管控失败语义 |
| `scripts/cmd/restore.js` | 按组重放 updateControl 时读档案 + 断锚点 + 传参 |
| `scripts/cmd/verify.js` | 读档案、锚点断言、右键菜单标签表来自档案、打印档案摘要；错误打印 hint |
| `scripts/inject/context-menu.js` | 标签表/注入点参数化（生产路径必须传，默认值仅过渡） |
| `scripts/inject/update-control.js` | 方法锚点/期望次数/注入点参数化（同上） |
| `scripts/common.js` | 导出 `embeddedAsset`（内嵌档案读取需要；内嵌资源 SSOT 复用，不另写 node:sea 逻辑） |
| `test/version-profile.test.js` | 新增：本模块单测 |
| `test/fixtures/profile.js` | 新增：档案夹具 |
| `test/cmd/{patch,restore,verify}.test.js`、`test/inject/context-menu.test.js` | 补档案夹具与失败语义用例 |

**给调度线的提示**

- `latest-version-lead` / `archify-lead` 可用 `probeApp` + `buildProfile`（纯函数、不联网）在已取到的产物目录上产出档案；
  联网单跑用 CLI `probe`。
- 第二阶段改 `dict-sync` / `build` / GUI / dict-auto 时，档案读取一律走 `loadProfile` / `pairStatus`，
  不要自己 `existsSync('patch.json')` 或自行拼路径（数据根与内嵌判定都在模块里）。
- 3.6.8~3.6.10 的档案归版本/字典线产出；本线在第二阶段只做「其余 4 个存量版本（3.6.0/3.6.4/3.6.5/3.6.6）」，
  避免双方对 `dictionaries/3.6.8~3.6.10/` 的写作用域重叠。

## 11. 风险与未决

| # | 风险 / 未决 | 处置 |
| --- | --- | --- |
| 1 | 3.6.0 / 3.6.4 / 3.6.5 的官方产物锚点形态未知（本机尚无产物） | 第二阶段逐版本探测；三平台产物若结构与 3.6.7 不同（如方法不带 `async`、`editMenu` 缺失），探测会失败/禁用策略——**绝不把 3.6.7 的锚点抄给旧版本** |
| 2 | 两平台锚点次数/标签推导不一致时 schema v1 无法表达 | 探测失败、人工确认后再扩 schema（不静默取其一） |
| 3 | 远端目录列表无法证明 `patch.json` 存在 | §8.4 的 manifest 方案（待定夺） |
| 4 | `--on-exist=skip` 只判字典 → 存量版本补不上档案（迁移死锁） | §8.5 改为「成对才算 skip」 |
| 5 | dict-auto 只回滚字典、半对残留 | §8.5 同一事务回滚两文件 |
| 6 | 打包只加字典不加档案 → 离线汉化最新版失败 | §8.2 成对内嵌 + 最新版本缺任一即构建失败 |
| 7 | 老用户数据根已有字典、无档案 | §8.3 逐文件补齐播种 |
| 8 | `--dry-run` 掩盖干跑失败 / `--no-ai` 静默产出缺译字典 | 二阶段：dry-run 保留失败结论；`--no-ai` 报告标 `draftOnly` 并进草稿 artifact |
| 9 | 3.6.7 档案的 `generatedAt` 是探测时间，重新探测会变 | 属预期（证据可追溯）；归档/审阅关注 anchors/labels/evidence 而非时间戳 |
