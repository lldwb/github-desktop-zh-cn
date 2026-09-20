# test/fixtures — 测试夹具的约定

本目录**不放夹具数据**，放的是夹具的「约定」：唯一的夹具版本号、配套的清理助手与目录名形态
过滤常量（`scratch.js`）。夹具数据本身落在 `dictionaries/<夹具版本>/`，原因见下。

## 为什么夹具不能放在本目录下

字典路径是生产侧的 SSOT：`common.dictFile(版本)` = `<数据根>/dictionaries/<版本>/zh-CN.json`
（源码态数据根 = 仓库根）。而 `dict-edit` 的公开 API **只接受版本号、没有 root 参数**——把夹具
挪到 `test/fixtures/` 下就要求给生产代码加 `root` / 环境变量开关，那属于「重构不许改对外行为」
的边界之外。所以：**夹具目录必须与真实版本平级**，即 `dictionaries/0.0.0-test/`。

代价是这个夹具与真实字典同住一个目录，而 `node --test` 各测试文件是**并行**跑的子进程——夹具
存在的那几百毫秒会被读 `dictionaries/` 的测试读到（v0.4.0 CI 实测：ubuntu / macos-15-intel 红、
windows 绿）。对策有两条，都在本目录里：

1. 夹具版本号形态**刻意不是** `X.Y.Z`（是 `0.0.0-test`），生产侧 `common.DICT_VERSION_RE`
   不会把它当真实版本；
2. 读真实字典目录的测试**必须按目录名形态过滤**，用的就是 `scratch.js` 里那个与生产侧同源的
   `VERSION_RE`。建夹具的一侧与读目录的一侧共用同一套判据，是这个目录存在的全部理由。

## 什么时候该用它

- 测试要写入 / 读取一份字典文件 → 用 `FIXTURE_VERSION` 造夹具，用例结束必须清理。
- 测试要遍历真实 `dictionaries/` 下的版本 → 必须用 `VERSION_RE` 过滤，别自己写正则
  （自己写的正则迟早与生产侧判据漂移，夹具就会重新变成撞车源）。
- 只做纯函数断言（不落盘）的测试**不需要**本目录。

## 怎么用

```js
// test/dict/xxx.test.js（test/inject/** 同理，注意相对深度）
const test = require('node:test');
const fs = require('fs');
const path = require('path');

const common = require('../../scripts/common');
const scratch = require('../fixtures/scratch');

const VERSION = scratch.FIXTURE_VERSION;        // 夹具版本号：不要自己写字面量
const FILE = common.dictFile(VERSION);          // 路径一律走生产侧 SSOT，不拼 __dirname

test('用例自带清理：断言失败也不把夹具留在仓库里', (t) => {
  scratch.isolate(t);                          // = t.after(() => scratch.cleanup())
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, '{"_meta":{"formatVersion":2}}\n', 'utf8');
  // ... 断言 ...
});

test('读真实 dictionaries/ 时按形态过滤', () => {
  const root = path.join(__dirname, '..', '..', 'dictionaries');
  const versions = fs
    .readdirSync(root)
    .filter((v) => scratch.VERSION_RE.test(v) && fs.existsSync(path.join(root, v, 'zh-CN.json')));
  // versions 里不会有 0.0.0-test、3.6.6-beta 这类非版本形态目录
});
```

`scratch.js` 的对外 API（这就是全部）：

| 导出 | 形态 | 用途 |
|---|---|---|
| `FIXTURE_VERSION` | `'0.0.0-test'` | 夹具版本号，**全仓唯一一处定义** |
| `VERSION_RE` | `RegExp`（`common.DICT_VERSION_RE`） | 真实字典版本的目录名形态，读 `dictionaries/` 时过滤用 |
| `cleanup(version = FIXTURE_VERSION)` | 函数 | 删掉该版本对应的夹具目录，幂等 |
| `isolate(t, version = FIXTURE_VERSION)` | 函数 | 登记 `t.after` 清理，用例里最常用 |

`cleanup()` / `isolate()` 的 `version` 形参带门禁：删除目标必须是 `dictionaries/` 的**直接子目录**、且名字**不是真实版本形态**（不匹配 `VERSION_RE`），否则抛错——夹具清理只许删非版本形态的目录，真实版本（`'3.6.6'`）、空串（会折叠成整个 `dictionaries/`）、`'..'`（会归一化到仓库根）一律拒删。默认参数 `FIXTURE_VERSION` 的删除效果与加门禁前一字不差。

## 纪律（改测试前先读）

1. **不新增生产 API**：为了测试方便去给 `scripts/**` 加 `root` / `dataRoot` 参数或环境变量开关，
   属于改对外行为，不许做。本目录的 API 只准用生产侧既有的 `common.dictFile()` /
   `common.dataRoot()` / `common.DICT_VERSION_RE`。
2. **断言一律不改**：夹具来源、清理方式、`require` 路径、文件位置可以改，既有用例的断言语义
   一个字都不动（包括测试里作为断言载荷硬写的 `'0.0.0-test'` 字面量——那是用例数据，不是定义）。
3. **生产侧的形态过滤是独立提交**：`listDictVersions()` / `collectAssets()` 按
   `^\\d+\\.\\d+\\.\\d+$` 过滤目录的那次加固是单独的 `fix` 提交（`01896fb`），不要混进重构提交，
   也不要为了让测试变绿去动生产判据。
4. **本目录的 `.js` 会被 `node --test` 当测试文件收集**（`test/` 下任意深度的 `.js` 都在收集范围
   内，`npm test` = 裸 `node --test`）。所以 `scratch.js` 只能是「常量 + 纯函数」，**不得引入任何
   顶层副作用**；它会让 `npm test` 的总条目数多 1（一条没有子用例的空跑条目，0 失败），这是预期内的。
