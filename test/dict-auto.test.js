// 字典自动产出（scripts/dict-auto.js）单测：候选口径、形态核对、平台分段与译文校验。
//
// 只测纯函数——真正读产物、联网取版本、调翻译服务的那几段由 CI 的定时任务在真实产物上跑，
// 单测里落一份几十 MB 的产物夹具既慢又容易过期。literalIndex 的返回值在下面按同样结构手工
// 构造：它本身就是「原文 → 出现在哪几个文件」的两张表，构造出来比读盘更能锁定被测行为。
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const common = require('../scripts/common');
const dictAuto = require('../scripts/dict-auto');

// literalIndex(appDir) 的替身：texts 里每个原文都当作出现在 main.js 里
function index(texts, file = 'main.js') {
  const exact = new Map();
  const lower = new Map();
  for (const t of texts) {
    exact.set(t, new Set([file]));
    const lk = t.toLowerCase();
    if (!lower.has(lk)) lower.set(lk, new Set());
    lower.get(lk).add(t);
  }
  return { exact, lower };
}

// ============================ resolveIn：形态核对 ============================

test('resolveIn：精确形态直接命中', () => {
  const idx = index(['Sign in to GitHub Desktop']);
  const r = dictAuto.resolveIn(idx, 'Sign in to GitHub Desktop');
  assert.strictEqual(r.text, 'Sign in to GitHub Desktop');
});

test('resolveIn：多词文案允许大小写兜底（官方只改了大小写）', () => {
  // Copy file path → Copy File Path 是官方常见的书写调整，译文不该因此丢掉
  const idx = index(['Copy File Path']);
  const r = dictAuto.resolveIn(idx, 'Copy file path');
  assert.strictEqual(r.text, 'Copy File Path');
});

test('resolveIn：无空格且不足 8 字符的单形态短键不做兜底', () => {
  // 这些词在产物里几乎都是代码标识符：Electron 菜单的 role 值（role:"cut"）、
  // Git LFS 子命令参数（["lfs","install"]）、属性描述符键名（{key:"options"}）。
  // 兜底会把它们替换成中文，直接破坏功能（实测 3.6.7 产物取证）。
  const idx = index(['cut', 'find', 'paste', 'redo', 'install', 'options']);
  for (const k of ['Cut', 'Find', 'Paste', 'Redo', 'Install', 'Options']) {
    assert.strictEqual(dictAuto.resolveIn(idx, k), null, `${k} 不该兜底命中 ${k.toLowerCase()}`);
  }
});

test('resolveIn：单形态短键的精确形态仍然正常命中', () => {
  // 不做兜底不等于不认它——官方若真把 Cut 写进产物，键 Cut 应当照常命中
  const idx = index(['Cut', 'Options']);
  assert.strictEqual(dictAuto.resolveIn(idx, 'Cut').text, 'Cut');
  assert.strictEqual(dictAuto.resolveIn(idx, 'Options').text, 'Options');
});

test('resolveIn：作用域键只认它绑定的那个文件', () => {
  const idx = index(['Not Now'], 'main.js');
  assert.strictEqual(dictAuto.resolveIn(idx, 'renderer.js|Not Now'), null);
  assert.strictEqual(dictAuto.resolveIn(idx, 'main.js|Not Now').text, 'Not Now');
});

// ============================ buildCandidates：继承与新增 ============================

// 两平台产物形态不同的常见组合：macOS 用 Title Case、Windows 用带助记符的写法
function twoPlatforms(winTexts, macTexts) {
  return { windows: index(winTexts), macos: index(macTexts) };
}

test('buildCandidates：按本平台真实形态继承，官方删掉的记入 dropped', () => {
  const indexes = twoPlatforms(['&Open', 'Stale Entry'], ['Open', 'Stale Entry']);
  const history = new Map([
    ['&Open', '打开'],
    ['Stale Entry', '陈旧条目'],
    ['Gone Forever', '早已删除'],
  ]);
  const { perPlatform, stats, dropped } = dictAuto.buildCandidates({ indexes, history, jsxFound: new Map() });

  assert.strictEqual(perPlatform.windows.get('&Open').zh, '打开');
  assert.strictEqual(perPlatform.windows.get('Stale Entry').zh, '陈旧条目');
  // &Open 在 macOS 产物里没有精确形态，短键又不做兜底 → macOS 侧不收录它。
  // 这是有意的：让 Windows 专有键留在 common 段由 Windows 产物命中，不硬塞进 macos 段
  assert.ok(!perPlatform.macos.has('&Open'), 'macOS 侧不该凭空出现 &Open');
  assert.deepStrictEqual(dropped, ['Gone Forever']);
  assert.strictEqual(stats.dropped, 1);
  assert.strictEqual(stats.inherited, 2);
});

test('buildCandidates：精确命中压过兜底命中，平台专用译文不被挤掉', () => {
  // 3.6.6 字典里 common 段有 `Open with…`（打开方式…）、macos 段有 `Open With…`（用其他应用打开…）。
  // 落到 macOS 产物上，前一条只能兜底命中、后一条是精确命中——必须后者胜出，
  // 否则 common 段那句通用的译法会把 macOS 习惯的说法覆盖掉（实测出现过这个回归）。
  const indexes = twoPlatforms(['Open with…'], ['Open With…']);
  const history = new Map([
    ['Open with…', '打开方式…'],      // common 段，先遍历到
    ['Open With…', '用其他应用打开…'], // macos 段，精确命中同一形态
  ]);
  const { perPlatform } = dictAuto.buildCandidates({ indexes, history, jsxFound: new Map() });
  assert.strictEqual(perPlatform.macos.get('Open With…').zh, '用其他应用打开…');
});

test('buildCandidates：只收 jsx 为真的新增候选，字面量侧一律不收', () => {
  const indexes = twoPlatforms(['Add Repository'], ['Add Repository']);
  const jsxFound = new Map([
    ['Add Repository', { source: 'ui/app.tsx', files: new Set(['main.js']), jsx: true }],
    ['PageDown', { source: 'lib/keys.ts', files: new Set(['main.js']), jsx: false }],
  ]);
  const { perPlatform, stats, pending } = dictAuto.buildCandidates({
    indexes,
    history: new Map(),
    jsxFound,
  });

  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].text, 'Add Repository');
  assert.strictEqual(perPlatform.windows.get('Add Repository').zh, null, '新增条目待译，zh 为 null');
  assert.strictEqual(stats.added, 1);
  assert.ok(!perPlatform.windows.has('PageDown'), '字面量侧候选不该进字典');
});

// ============================ toSegments：平台分段 ============================

test('toSegments：Windows 产物里存在的形态归 common，macOS 独有才进 macos 段', () => {
  const perPlatform = {
    windows: new Map([
      ['Open', { zh: '打开' }],   // 两平台都有
      ['&Undo', { zh: '撤销' }],  // Windows 独有，但 Windows 产物里有 → 归 common
    ]),
    macos: new Map([
      ['Open', { zh: '打开' }],
      ['Add Worktree', { zh: '添加工作树' }], // macOS 独有形态
    ]),
  };
  // 判据用的是「Windows 产物字面量里有没有这条」，而不是「perPlatform.windows 里有没有」
  const winExact = index(['Open', '&Undo']).exact;

  const { segments } = dictAuto.toSegments(perPlatform, winExact);
  assert.deepStrictEqual(Object.keys(segments.common).sort(), ['&Undo', 'Open']);
  assert.deepStrictEqual(Object.keys(segments.macos), ['Add Worktree']);
});

test('toSegments：未译条目（zh 为 null）不写入任何段，只记进 skipped', () => {
  // 写进去既不产生替换效果，又会让 dict validate 一直报「译文为空」
  const perPlatform = {
    windows: new Map([['Open', { zh: '打开' }], ['Untranslated', { zh: null }]]),
    macos: new Map([['Open', { zh: '打开' }], ['Mac Only Untranslated', { zh: null }]]),
  };
  const { segments, skipped } = dictAuto.toSegments(perPlatform, index(['Open', 'Untranslated']).exact);

  assert.deepStrictEqual(Object.keys(segments.common), ['Open']);
  assert.deepStrictEqual(Object.keys(segments.macos), []);
  assert.deepStrictEqual(skipped.sort(), ['Mac Only Untranslated', 'Untranslated']);
});

test('toSegments：windows 与 linux 段保持为空', () => {
  // 没有 Linux 产物，Linux 走非 darwin 分支；平台专有条目放 common 只是多一条永不命中的键（无害），
  // 放 windows 段则会让 Linux 用户漏覆盖（有害）
  const perPlatform = {
    windows: new Map([['&Undo', { zh: '撤销' }]]),
    macos: new Map(),
  };
  const { segments } = dictAuto.toSegments(perPlatform, index(['&Undo']).exact);
  assert.deepStrictEqual(segments.windows, {});
  assert.deepStrictEqual(segments.linux, {});
  assert.deepStrictEqual(Object.keys(segments.common), ['&Undo']);
});

// ============================ 译文校验 ============================

test('placeholdersOf：抽出花括号占位符并排序，忽略出现顺序', () => {
  const a = dictAuto.placeholdersOf('Open {{count}} of {total} in ${name}');
  const b = dictAuto.placeholdersOf('${name} 里的 {total} 项，共 {{count}} 项');
  assert.strictEqual(a, b);
  assert.strictEqual(dictAuto.placeholdersOf('没有占位符'), '');
});

test('rejectReason：占位符不一致的译文被拒', () => {
  assert.strictEqual(dictAuto.rejectReason('{{count}} files', '{{count}} 个文件'), null);
  assert.ok(dictAuto.rejectReason('{{count}} files', '个文件'), '少了占位符应被拒');
  assert.ok(dictAuto.rejectReason('{{count}} files', '{{count}} {{total}} 个文件'), '多了占位符应被拒');
});

test('rejectReason：没有中文的译文被拒（域名、路径等无需翻译的例外另说）', () => {
  assert.ok(dictAuto.rejectReason('Open Repository', 'Open Repository'));
  assert.ok(dictAuto.rejectReason('Open Repository', '   '), '空译文应被拒');
  assert.strictEqual(dictAuto.rejectReason('Open Repository', '打开仓库'), null);
});

test('rejectReason：逗号与星号等非花括号符号不当占位符', () => {
  // 只在花括号与 ${} 上校验；把 %, * 也算进去会误杀大量正常译文
  assert.strictEqual(dictAuto.rejectReason('Open %s now', '立即打开 %s'), null);
  assert.strictEqual(dictAuto.rejectReason('*.md 文件', 'Markdown 文件'), null);
});
