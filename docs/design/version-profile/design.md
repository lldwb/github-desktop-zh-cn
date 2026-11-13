# 每版本替换逻辑档案（version-profile）设计

> 状态：**两个阶段均已落地**。
> 第一阶段：模块 + 3.6.7 样板档案 + patch/restore/verify 接入 + 单测 + 端到端；
> 第二阶段：3.6.0/3.6.4/3.6.5/3.6.6 档案、dict-sync 成对获取、build 内嵌最新成对、Electron 播种与打包校验、
> GUI/CLI 成对判定、dict-auto 档案产出 + 失败分类 + 待译草稿 artifact、CI workflow、文档同步
>（§8 各节末尾有「实现状态」回填，§9 有最终测试与端到端记录）。3.6.8~3.6.10 的档案由版本/字典线用同一工具产出，
> 不属本线写作用域。
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
| `patch.run` | 先 `ensureDict` 成对就位（本地成对不联网、半对只补缺；联网失败抛错拒绝），**之后**才 `loadProfile` | 写盘前：i18n 的 `context-menu` 锚点；请求了 `--update-control` 时**同时**断言 `update-control` 锚点 | 抛错（exit 1）；hint 给下一步；**失败前不写盘/不建备份** |
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

### 6.5 存量版本探测记录（第二阶段，2026-11-14）

四个存量版本均按同一命令逐版本探测（各自独立进程；release-assets 主机偶发重置时重试），**全部成功**，
档案结构一致（schemaVersion 1，锚点两平台均为 `injectionPoint=1` / `checkForUpdates=1` 故 update-control 启用，
标签 7 个 × 两平台），每个档案约 7 KB：

| 版本 | windows 产物 | macos 产物 | windows main.js（字节 / sha256 前 12） | macos main.js | 探测证据 |
| --- | --- | --- | --- | --- | --- |
| 3.6.0 | `GitHubDesktop-3.6.0-x64-full.nupkg` | `GitHub.Desktop-x64.zip` | 240,785 / `f9db58c97b52` | 237,890 / `8da24bf1f7f0` | 两平台锚点 1/1、标签 7/7 |
| 3.6.4 | `GitHubDesktop-3.6.4-x64-full.nupkg` | `GitHub.Desktop-x64.zip` | 241,605 / `d082cb40047e` | 238,726 / `5436eaec56a2` | 同上 |
| 3.6.5 | `GitHubDesktop-3.6.5-x64-full.nupkg` | `GitHub.Desktop-x64.zip` | 241,676 / `ea583adb1bb2` | 238,797 / `d1bf7e201d2c` | 同上 |
| 3.6.6 | `GitHubDesktop-3.6.6-x64-full.nupkg` | `GitHub.Desktop-x64.zip` | 242,192 / `ff9db9cb646e` | 239,979 / `1718e97b55dd` | 同上 |

结论：3.6.0~3.6.7 的注入点/方法锚点与右键菜单标签表在官方产物上同形（「旧版本只是没报错」的猜测被实测取代）；
每份档案的 `evidence.platforms.<平台>.files` 记录了 main.js / renderer.js / package.json 的字节数与 sha256，
可据此复核探测所用产物（例如 3.6.6 的 windows main.js 与 `tmp/backup/3.6.6/main.js` 一致）。
端到端（patch/verify/restore 在官方产物副本上）结果见 §9.2。

## 7. 兼容与迁移

### 7.1 阶段划分与迁移状态

- **第一阶段（已落地）**：模块 + 3.6.7 样板 + patch/restore/verify 接入 + 单测。当时存量 5 个版本里只有 3.6.7
  有档案，其余版本会被明确拒绝（消息给「探测生成」下一步）——宁可拒绝，也不静默套用未经探测的锚点。
- **第二阶段（已落地）**：3.6.0 / 3.6.4 / 3.6.5 / 3.6.6 按各自官方产物探测生成档案（§6.5），
  至此 3.6.0~3.6.7 全部成对；`3.6.8~3.6.10` 由版本/字典线用同一工具产出（不属本线写作用域）；
  流水线各环节改为成对（§8）。
- **中间态语义保留**：任何版本只要缺档案（例如用户只手动放了 `zh-CN.json`、或远端只同步到一半），
  `patch` / `verify` 都会**明确拒绝**并给出下一步（同步字典 / 探测生成），不会回退到其它版本的逻辑。
  这是设计内的安全语义，不是故障。

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

## 8. 流水线改造（第二阶段，已实施）

> 本节是**实现后的最终口径**；各小节末尾的「实现状态」标注了对应代码与验证方式。文档同步（AGENTS.md /
> dictionaries/README.md / 版本升级.md / 已知坑.md）见 §8.7。

### 8.1 在线获取成对（`scripts/dict/dict-sync.js` + `common.js`）

- `common.js`：新增 `remoteProfileUrls(version)`（与 `remoteDictUrls` 同一套 raw → jsDelivr → Gitee 兜底；
  URL 拼装仍只能在 common，遵守「远程地址只有一处定义」纪律）。
- `dict-sync.js`：`fetchPair(version)` 按源成对取两份——**同一个源必须字典与档案都取到、字典通过
  `dict-edit.validateDoc`（`_meta.version` 与目标版本一致、formatVersion=2、条目合法）、档案通过
  `validateProfile`**，才算该源成功（只做 JSON.parse 会把别的版本/旧格式字典写进 `<版本>/zh-CN.json`）；失败时逐源列出「缺哪一份 / 哪份校验失败」。
  `writePair()` 两份都先写 `.part`、全部就绪后再逐个 rename；任一 rename 失败即回滚已替换的文件并清 `.part`，
  保证磁盘上不出现半对。`ensureDict()` 改为**成对判断**（外部成对 → 内嵌成对 → 联网成对），
  本地只有一半时联网**只补缺的那份**（用户已有文件不被覆盖）；`syncLatest()` 成对覆盖，
  返回 `changedFiles`；`prefetchDict()` 文案改「字典与替换逻辑档案」，失败消息来自 fetchPair（写清缺哪份）。
- **实现状态**：已落地；单测 `test/dict/dict-sync-pair.test.js`（fetchPair 逐源成功/失败文案、writePair
  只补缺/原子回滚/无 `.part` 残留、ensureDict 三态、syncLatest 成对覆盖与未变不动，全部注入式零网络）。

### 8.2 打包内嵌（`tools/build.js`）

- `collectAssets()` 改为内嵌**最新一版成对资源**（`zh-CN.json` + `patch.json` 两份都齐才算可用版本）；
  若更新的版本有字典但缺档案，**退到最新的成对版本并在构建日志里警告**（让产物可用，同时把缺口暴露给维护者），
  只有在没有任何成对版本时才失败。
- **一并修正既有不一致**：原实现只内嵌最新一版字典，而注释写「内嵌全部字典」——以实现为准改注释/日志
  （日志按「最新成对资源 N 个文件」打印）。
- **实现状态**：已落地；`collectAssets(dictRoot)` 导出供单测，`test/tools/build-assets.test.js` 覆盖
  「选最新成对 / 缺档案告警退档 / 无成对即失败」（临时目录驱动，不依赖仓库 checkout 内容）。

### 8.3 Electron 打包与播种（`electron-builder.yml` + `gui/main.js` + `tools/check-gui-dist.js`）

- `extraResources: dictionaries → resources/dictionaries` 会把 `patch.json` 自动带进包，配置无需改；
- `seedBundledDicts()` 改为**逐文件补齐**：`zh-CN.json` 与 `patch.json` 分别判断目标缺则复制
  （老用户数据根已有字典、没有档案，必须能只补档案；不能按「版本已播种」整体跳过）；
  `readdirSync` 增加 `DICT_VERSION_RE` 过滤（README/夹具目录不进数据根）。
- `check-gui-dist.js`：内置资源校验改为**成对**（两文件都在才算版本可用；档案做最小结构校验：
  合法 JSON、`version` 与目录名一致、`schemaVersion` 存在）；asar 清单加入 `scripts/version-profile.js`。
- **实现状态**：已落地（GUI 链由并行子任务完成，主线复核 diff 与 `node --check`；Electron 运行时冒烟
  由 CI 的产物启动冒烟步骤覆盖，本地未跑 GUI 运行时）。

### 8.4 GUI / CLI 的「有没有字典」判定

- 保留 `common.listDictVersions()` 原义（字典存在），新增 `version-profile.js` 的
  `listPairVersions()`（成对完整）——避免直接改语义扩散到 8+ 调用点与既有测试。
- `gui/ipc/misc.js` 的 `hasDict` 与 `collectState` 改为**成对口径**，并带 `profileMissing`（有字典缺档案，
  供界面单独提示）；`gui/renderer.js` 三态 `local / remote / none` 不变，但 `local` 指成对完整，
  「缺替换逻辑档案」有独立标签（不能显示成可用、点汉化才报错）。
- `install-version.listDownloadable()` / CLI 菜单 / `prefetchDict` 文案同步成对口径
  （`opts.pairVersions` 可注入；保留 `opts.dictVersions` 兼容测试）。
- **决策（用户已确认）：不引入 manifest 资产。** 理由：manifest 要新增资产 + 缓存 + 原子性（产出/提交/同步
  三处都要维护），而收益只是「显示阶段更精确」；正确性由**下载与使用时的强校验**保证——远端目录列表只代表
  「远端可能有版本目录」，真正 prefetch / patch 时 `fetchPair` 会成对校验，缺档案给明确错误与下一步
  （同步字典 / 更新工具）。因此切换版本窗口显示阶段维持「本地目录 + 远端目录名」。
- **实现状态**：已落地（`listPairVersions` 单测见 `test/version-profile.test.js`；install-version 用例已更新）。

### 8.5 自动产出（`scripts/dict/dict-auto.js` + `.github/workflows/dict-auto.yml`）

- **产出档案**：`buildOne` 取到两平台产物后调 `probeProfile`（`probeApp` + `buildProfile`，纯本地、不额外联网），
  与字典同一轮落盘：字典走 dict-edit 事务 → 档案走 `writeProfile`；任一失败把**两份一起**回滚
  （失败即删/恢复原内容，不留半对）。`--dry-run` 不写任一份（含「已有字典缺档案」的**迁移路径**：
  只打印「将写入档案」、不落盘）但照常做档案生成校验；`--no-ai` 也产出/校验档案，
  报告标 `draftOnly: true`。
- **迁移死锁修复**：`--on-exist=skip` 的判据改为「字典**与**档案都在才跳过」；「已有字典、缺档案」走
  **只补档案**的迁移路径（不重跑 AI、不改字典，产出档案后 ok）。
- **失败分类**：`report.failureKind` 取值 `ai-unreachable`（网络/超时/鉴权/5xx/模型没按契约回 JSON）、
  `ai-quality`（占位符不一致/空译/无中文）、`product-fetch`、`profile-probe`、`dry-run-threshold`、
  `dict-validate`、`dict-write`、`groups-infer`；分类由 `dict-ai.classifyFailure()`（协议层，只认错误形态）
  给出，`kind` 取**多数类**（tie 按 transport→auth→server→format→quality 优先级；1 条网关错误混在
  大量质量失败里不会把排查方向带偏），各类计数写进报告 `failureCounts`。`dict-auto` 把非 quality 的
  AI 类别映射为 `ai-unreachable`；注解用 `::error title=…::` 并附「分类 <类> <数>」，运行摘要与提交信息
  同样带计数，不必翻日志。
- **待译草稿 artifact**：`tmp/dict-auto-pending-<版本>.json`（version / fetchedAt / failureKind / reason /
  untranslated / untranslatedRows（含 reason）/ candidates（text、source、targets））。在候选确定后先写一份
  （AI 卡死/超时也不丢「待译的是什么」），翻译后再写一份补上每条真实原因；workflow 用
  `actions/upload-artifact`（`always()`）与报告 JSON 一起上传。
- **严格质量门禁不降级**：未译比例上限、干跑语法/命中率、字典校验、`node --test` 门禁全部保留；
  `--dry-run` 也不再掩盖失败（`reason` 存在即失败）。提交前新增「字典与档案成对」门禁步骤
  （有字典缺档案 → `::error title=字典与档案不成对::` 并失败，防止半对入库后被 skip 永久固化）。
- **未做**：独立的「AI 网关连通性预检」请求（需要额外一次请求，且失败原因仍要靠分类给出精确区分）；
  以 `failureKind=ai-unreachable` + 注解标题替代。若后续需要可在 `--preflight` 下补。
- **实现状态**：已落地；`test/dict/dict-auto.test.js` 覆盖纯函数与注入标签；`dict-ai` 新增
  `classifyFailure` 单测。CI 侧改动用 `tools/ops/wf-lint.cjs`（本机无 bash，run 块 bash -n 不可用；
  YAML 结构解析通过，内嵌 3 段 `node -e` 脚本另行用 vm 语法解析通过）。

### 8.6 新版本产出（版本/字典线）

新增版本时产出字典的人按同一入口产出档案：取到两平台官方产物后
`probeApp` → `buildProfile` → `writeProfile`（或 dict-auto 的同一链路）。不允许手写/复制旧版本档案的锚点。
3.6.8~3.6.10 已由版本/字典线用该工具产出（不在本线提交范围）。

### 8.7 文档同步（已实施）

- `AGENTS.md`：核心资产、版本强对应、`version-profile.js` 定位、dict-sync 成对、build 内嵌最新成对、
  Electron 播种/校验、hasDict 三态、dict-auto 产出档案 + 失败分类 + 草稿 + 不降级、跨模块共用约定。
- `dictionaries/README.md`：目录树加 `patch.json`、新增「每版本替换逻辑档案」一节（字段概览/生成/唯一写入口/
  缺档案行为/升级需重新探测）。
- `.claude/skills/translation-maintain/references/版本升级.md`：升级流程加「探测生成/校验档案」一步、
  失效分类加「档案失效」、提交命令加档案文件、强调不能复制旧版本档案。
- `docs/agents/已知坑.md`：补充档案语义、半对/中间态明确拒绝、锚点按策略断言、播种逐文件补齐、
  远端目录列表 ≠ 远端有档案、自动产出的失败分类与草稿 artifact。

## 9. 测试与验收

### 9.1 单元测试

- `test/version-profile.test.js`（28 例）：加载/来源、非法 JSON、schemaVersion、版本错配、targets 不一致、
  未知策略、锚点引用不存在、placement/expected 组合非法、labels 平台角色集合不一致、证据与声明不一致、
  锚点断言（正常 / 0 次 / 2 次 / append-eof / 按策略筛选）、策略解析（含 linux 沿用 windows 表、未启用/未声明/未知）、
  成对校验（只有字典 / 只有档案 / 成对 / assertPair）、写入口（拒绝覆盖 / overwrite / 原子无 `.part` 残留）、
  探测（两平台合成产物生成档案、两平台锚点不一致拒绝、两平台标签推导不一致拒绝、bundle 缺字面量拒绝、
  产物版本不符拒绝、sourcemap 缺 sourcesContent 拒绝）。
- `test/dict/dict-sync-pair.test.js`（13 例）：`fetchPair` 逐源成对（一个源缺档案换源、全源失败写清缺哪份、
  档案校验失败不落盘）；`writePair` onlyMissing 只补缺、全量覆盖、第二次 rename 失败回滚且无 `.part` 残留；
  `ensureDict` 成对不联网 / 半对只补缺 / 两份都缺 / 失败不留半对；`syncLatest` 未变不动、成对覆盖与 `changedFiles`。
- `test/tools/build-assets.test.js`（3 例）：`collectAssets` 选最新成对版本、最新缺档案时告警退档、
  无任何成对版本时构建失败（临时目录驱动，不依赖仓库 checkout 内容）。
- `test/cmd/install-version-dict.test.js`：`listDownloadable` 的 `dictLocal` 改为成对口径（`opts.pairVersions`），
  保留 `opts.dictVersions` 兼容注入；prefetch 文案按「字典与替换逻辑档案」。
- `test/cmd/patch.test.js`：缺档案、锚点 0/2 次、未知策略、schemaVersion/targets、参数来自档案
  （自定义注入点 + 自定义标签表）、更新管控未启用被请求、更新管控锚点 0/2 次——都断言**拒绝且不写盘/不建备份**。
- `test/cmd/verify.test.js`：缺档案、锚点 0/2 次、档案声明更新管控但产物缺方法锚点。
- `test/inject/context-menu.test.js`：注入器参数化（自定义标签表 + 自定义注入点）；标签表来源改为
  「有档案的版本用档案表，无档案的版本退回过渡默认表」。
- `test/dict/dict-ai.test.js`：`classifyFailure`（transport/auth/server/format/quality/other 归类；
  `kind` 取**多数类**、tie 按优先级；`响应结构不认识` 归 format）。
- `test/dict/dict-auto.test.js`：既有纯函数 + 注入标签用例（`withInjectedLiterals` 兼容布尔/标签表两种入参）；
  `profileSummary` / `failureTitle` / `draftFile` / `writePendingDraft` 纯函数用例；**`buildOne` 迁移路径
  `--dry-run` 不写档案**（合成两平台产物 + `--reuse`，离线；非 dry-run 才写且可被 validate）。
- `test/common/tool-path.test.js`：`packagedToolPath()` 源码态 null / 打包态 `process.execPath`（P4：
  patch 注入与 restore 按组重放共用同一取值）。
- `test/dict/dict-sync-pair.test.js` 追加：本地只有档案 → 只补字典（P5）；字典 `_meta.version` 错配 /
  formatVersion≠2 → 该源失败且不留半对（P7）。
- `test/version-profile.test.js` 追加：启用策略引用的锚点必须声明在 main.js（P6）、`anchorsFor` 未知策略
  fail-closed（P6）。
- `test/inject/context-menu.test.js` 追加：`updateControl.buildInjection` 传 `profileFile` 时「支持上限 /
  自动汉化前置」两处都判成对完整（P3）。
- `test/cmd/patch.test.js` 更新：缺档案时**先尝试成对补齐**，补齐失败才拒绝（仍断言不写盘/不建备份），
  并新增「补齐后继续汉化」正向用例（P1）。

### 9.2 端到端（官方产物解包副本；3.6.7 + 存量 4 版本）

产物：各版本官方 windows-x64 的 app 目录复制到 `tmp/version-profile/e2e-<版本>/resources/app/`
（sha256 与档案 `evidence` 一致）；备份为官方原文。取证时点 2026-11；命中数随字典迭代变化，
**不在文档写死**（仓库既有纪律），复跑时看命令输出的「合计命中」。命令与结论：

| 版本 | `version-profile check` | `patch --dry-run` / `patch` | `verify` | `restore` 后与官方产物 |
| --- | --- | --- | --- | --- |
| 3.6.7（第一阶段样板） | 锚点 1/1 ✓ | 通过（含右键菜单标签命中） | 校验通过 | 逐字节相同（sha256 与档案证据一致） |
| 3.6.6 | 锚点 1/1 ✓ | 通过 | 校验通过 | 逐字节相同 |
| 3.6.5 | 锚点 1/1 ✓ | 通过 | 校验通过 | 逐字节相同 |
| 3.6.4 | 锚点 1/1 ✓ | 通过 | 校验通过 | 逐字节相同 |
| 3.6.0 | 锚点 1/1 ✓ | 通过 | 校验通过 | 逐字节相同 |

3.6.7 额外做了 `--update-control` 轮：注入块 + `if(!globalThis.__gdzcAllowUpdate())return;` 闸门 + guard 模式代码
均在，`verify` 通过，二轮 `restore` 仍逐字节相同。存量 4 版本的 `--update-control` 轮同样注入成功、`verify` 通过、
`restore` 逐字节还原（日志 `tmp/version-profile/e2e-<版本>.log`、汇总 `tmp/version-profile/e2e-legacy.log`）。
返工轮另对 3.6.7 与 3.6.10 双平台产物副本复跑（`version-profile check` 两平台锚点断言 + Windows 副本
patch/verify/restore + `--update-control` 轮），结论同上。

复跑命令（本机零重启：tmp 副本没有 `GitHubDesktop.exe`，`restartApp` 判定「未运行」不会碰真实应用；
`<版本>` 取 3.6.0/3.6.4/3.6.5/3.6.6/3.6.7）：

```bash
D=tmp/version-profile/e2e-<版本>
node scripts/version-profile.js check --version <版本> --path $D/resources
node scripts/cmd/patch.js --version <版本> --path $D/resources --dry-run
node scripts/cmd/patch.js --version <版本> --path $D/resources
node scripts/cmd/verify.js --version <版本> --path $D/resources
node scripts/cmd/restore.js --version <版本> --path $D/resources
node scripts/cmd/patch.js --version <版本> --path $D/resources --update-control
node scripts/cmd/verify.js --version <版本> --path $D/resources
node scripts/cmd/restore.js --version <版本> --path $D/resources
```

### 9.3 档案有效性复核与全量测试

- 收口时对 `3.6.7 / 3.6.8 / 3.6.9 / 3.6.10` 逐份 `version-profile validate`（schema 本阶段**未变更**：
  仅新增 `listPairVersions()` 读出接口与 `remoteProfileUrls`，`schemaVersion`/必填字段/校验规则/标签结构/
  `writeProfile` 序列化形态都不变，因此两份已由版本线生成的档案无需重生成；3.6.10 若尚未落盘则如实标注）。
- `npm test` 全绿（`node --test`；第二阶段新增用例见 §9.1）。
- `node --check` 覆盖全部改动的脚本与测试文件；`npm run bundle` 通过（`version-profile.js` 的静态 require
  依赖 common / dict/release-assets 均可收集）；`tools/ops/wf-lint.cjs` 的 YAML 结构解析通过、内嵌 node 脚本语法通过
  （本机无 bash，run 块 `bash -n` 不可用，已注明）。

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
listPairVersions() -> string[],          // 本机成对完整的版本（GUI/CLI 判定用）
writeProfile(version, profile, { overwrite, outFile }) -> file,
probeApp(appDir, meta) -> measurement,       // 纯本地读文件（dict-auto 二阶段直接用）
buildProfile(version, { measurements }) -> profile,  // 纯函数，生成即校验
probeVersion(version, { workDir, archWindows, archMacos, log }) -> Promise<profile>,  // 联网
describe(profile), countOccurrences(text, needle), profilePlatform(platform),
main  // CLI
```

**改动的文件（两个阶段合计）**

| 文件 | 改动 |
| --- | --- |
| `scripts/version-profile.js` | 新增：档案加载/校验/策略解析/锚点断言/成对校验/写入口/探测/CLI；`listPairVersions()` |
| `dictionaries/3.6.0|3.6.4|3.6.5|3.6.6|3.6.7/patch.json` | 新增：样板与存量版本档案（探测生成，含两平台证据）。3.6.8~3.6.10 由版本/字典线产出 |
| `scripts/common.js` | 导出 `embeddedAsset`（内嵌档案读取复用）；新增 `remoteProfileUrls`（远程档案地址 SSOT） |
| `scripts/dict/dict-sync.js` | 成对在线同步：`fetchPair` / `writePair` / `readPairText`；`ensureDict` 成对语义（只补缺）；`syncLatest` 成对覆盖；`prefetchDict` 文案 |
| `scripts/cmd/patch.js` | 读档案、写盘前锚点断言、注入参数来自档案、更新管控失败语义、成对下载日志 |
| `scripts/cmd/restore.js` | 按组重放 updateControl 时读档案 + 断锚点 + 传参 |
| `scripts/cmd/verify.js` | 读档案、锚点断言、右键菜单标签表来自档案、打印档案摘要；错误打印 hint |
| `scripts/inject/context-menu.js` | 标签表/注入点参数化（生产路径必须传，默认值仅过渡） |
| `scripts/inject/update-control.js` | 方法锚点/期望次数/注入点参数化（同上） |
| `tools/build.js` | `collectAssets` 内嵌最新**成对**版本（缺档案告警退档、无成对即失败）；修正实现与注释不一致；导出供单测 |
| `gui/main.js` | `seedBundledDicts` 逐文件补齐（老用户只缺档案也能补）+ 版本目录形态过滤 |
| `gui/ipc/misc.js` | `hasDict` 成对口径 + `profileMissing` / `pairVersions` 供界面提示 |
| `gui/renderer.js` | 三态 local 指成对完整；缺档案独立标签 |
| `gui/ipc/patching.js` / `gui/ipc/versions.js` | 本地可见性/提示成对口径（透传字段） |
| `scripts/cmd/install-version.js` | `listDownloadable` 的 `dictLocal` 成对口径（`opts.pairVersions`，保留 `opts.dictVersions` 兼容） |
| `scripts/cli.js` | 切换版本的本地判定改用 `listPairVersions`；同步文案成对 |
| `tools/check-gui-dist.js` | 内置资源成对校验 + asar 清单加 `scripts/version-profile.js` |
| `scripts/dict/dict-auto.js` | 每版本探测/生成/写入档案（与字典同轮、失败一起回滚）；skip 条件成对；只补档案迁移路径；失败分类 `failureKind`；待译草稿 artifact；`::error title=` 注解；dry-run 不再掩盖失败 |
| `scripts/dict/dict-ai.js` | 新增协议层失败归类 `classifyFailure()` |
| `.github/workflows/dict-auto.yml` | 上传待译草稿+报告 artifact；成对提交门禁；分类注解；提交信息含档案锚点；汇总含失败分类/草稿 |
| `test/version-profile.test.js`、`test/dict/dict-sync-pair.test.js`、`test/tools/build-assets.test.js`、`test/fixtures/profile.js` | 新增测试/夹具 |
| `test/cmd/{patch,restore,verify,install-version-dict}.test.js`、`test/inject/context-menu.test.js`、`test/dict/{dict-ai,dict-auto}.test.js` | 更新/补用例 |
| `docs/design/version-profile/design.md`、`AGENTS.md`、`dictionaries/README.md`、`.claude/skills/translation-maintain/references/版本升级.md`、`docs/agents/已知坑.md` | 设计文档与四份文档同步 |

**给调度线的提示**

- `latest-version-lead` / `archify-lead` 可用 `probeApp` + `buildProfile`（纯函数、不联网）在已取到的产物目录上产出档案；
  联网单跑用 CLI `probe`。
- 第二阶段改 `dict-sync` / `build` / GUI / dict-auto 时，档案读取一律走 `loadProfile` / `pairStatus`，
  不要自己 `existsSync('patch.json')` 或自行拼路径（数据根与内嵌判定都在模块里）。
- 3.6.8~3.6.10 的档案归版本/字典线产出；本线在第二阶段只做「其余 4 个存量版本（3.6.0/3.6.4/3.6.5/3.6.6）」，
  避免双方对 `dictionaries/3.6.8~3.6.10/` 的写作用域重叠。

## 11. 风险与未决

**第二阶段已消除的风险**（记录原因，防止回退）：

| 原风险 | 处置 |
| --- | --- |
| 3.6.0 / 3.6.4 / 3.6.5 的官方产物锚点形态未知 | 已逐版本探测：四版本两平台锚点均为 1/1、标签表同形，档案已入库（§6.5）；若未来某版本结构不同，探测会失败/禁用策略而不是猜测 |
| `--on-exist=skip` 只判字典 → 存量版本补不上档案（迁移死锁） | skip 条件改为成对；「已有字典缺档案」走只补档案迁移路径（§8.5） |
| dict-auto 只回滚字典、半对残留 | 字典与档案同轮写入、失败一起回滚（§8.5） |
| 打包只加字典不加档案 → 离线汉化最新版失败 | build 内嵌最新成对 + 缺档案告警退档（§8.2）；播种逐文件补齐（§8.3） |
| 老用户数据根已有字典、无档案 | `seedBundledDicts` 逐文件补齐（§8.3） |
| 远端目录列表证明不了档案存在（manifest 方案悬而未决） | **决策：不引入 manifest**；显示阶段维持目录级，正确性由下载/使用时成对强校验保证（§8.4） |
| `--dry-run` 掩盖干跑失败 / `--no-ai` 静默产出缺译字典 | dry-run 的 reason 也判失败；`--no-ai` 报告标 `draftOnly` 并进待译草稿 artifact（§8.5） |
| 半对资源不静默 | `pairStatus` / `assertPair` + 引擎拒绝（§5）；dict-sync 成对事务（§8.1） |

**仍在 / 未决**：

| # | 项 | 说明与处置 |
| --- | --- | --- |
| 1 | 两平台锚点次数/标签推导不一致时 schema v1 无法表达 | 探测失败、人工确认后再扩 schema（不静默取其一）。当前 5 个版本均一致 |
| 2 | 3.6.8~3.6.10 档案归属版本/字典线 | 已用同一工具产出；本线不提交这些目录。若未来新版本只产字典不产档案，patch/verify 会明确拒绝——流水线已改为成对产出，正常路径不会出现 |
| 3 | AI 连通性预检未做 | 以 `failureKind=ai-unreachable` + `::error title=AI 网关不可达` 替代；后续如需 fail-fast 可加 `--preflight`（§8.5「未做」） |
| 4 | 档案 `generatedAt` 每次探测会变 | 属预期（证据可追溯）；审阅关注 anchors/labels/evidence |
| 5 | Electron/GUI 运行时行为 | 本线只做静态校验与 `node --check`；GUI 产物启动冒烟由 CI（`build.yml` 的 `--smoke-test`）覆盖，本地未跑 Electron 运行时 |
