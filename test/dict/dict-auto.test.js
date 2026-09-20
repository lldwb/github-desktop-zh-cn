// 字典自动产出（scripts/dict/dict-auto.js）单测：候选口径、形态核对、平台分段（译文校验用例随 AI 适配层迁至 dict-ai.test.js）。
//
// 只测纯函数——真正读产物、联网取版本、调翻译服务的那几段由 CI 的定时任务在真实产物上跑，
// 单测里落一份几十 MB 的产物夹具既慢又容易过期。literalIndex 的返回值在下面按同样结构手工
// 构造：它本身就是「原文 → 出现在哪几个文件」的两张表，构造出来比读盘更能锁定被测行为。
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const common = require('../../scripts/common');
const dictAuto = require('../../scripts/dict/dict-auto');

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

test('buildCandidates：形态已被历史键继承到译文的候选不进待译队列', () => {
  // 实测 3.6.7 的 22 条候选里有 8 条属此类：源码写 Description、产物里是 description，
  // 而历史键 Description 已经经大小写兜底把这形态占了。它们不该再问 AI——白花 tokens，
  // 更要紧的是 AI 的译文会覆盖掉人工审过的那条（那次译文恰好相同才没显出问题）
  const indexes = twoPlatforms(['description'], ['description']);
  const history = new Map([['Description', '描述']]);
  const jsxFound = new Map([
    ['description', { source: 'ui/preferences.tsx', files: new Set(['main.js']), jsx: true }],
  ]);

  const { perPlatform, stats, pending } = dictAuto.buildCandidates({ indexes, history, jsxFound });

  assert.strictEqual(pending.length, 0, '已有译文的形态不该进待译队列');
  assert.strictEqual(stats.added, 0, 'added 的口径是「需要 AI 的形态数」');
  assert.strictEqual(perPlatform.windows.get('description').zh, '描述', '继承来的译文要留住');
  assert.strictEqual(perPlatform.macos.get('description').zh, '描述');
});

test('buildCandidates：两平台形态不同时，只有缺译文的那个平台进队列', () => {
  // windows 产物里 Default branch 与 Default Branch 两个形态都在，历史键精确命中后者、
  // 前者仍是官方新写的（没译文）；macOS 产物只有后者、已被历史键占住
  const indexes = twoPlatforms(['Default branch', 'Default Branch'], ['Default Branch']);
  const history = new Map([['Default Branch', '默认分支']]);
  const jsxFound = new Map([
    ['Default branch', { source: 'ui/preferences.tsx', files: new Set(['main.js']), jsx: true }],
  ]);

  const { perPlatform, pending } = dictAuto.buildCandidates({ indexes, history, jsxFound });

  assert.strictEqual(pending.length, 1);
  assert.deepStrictEqual(pending[0].targets, [{ platform: 'windows', key: 'Default branch' }]);
  assert.strictEqual(perPlatform.macos.get('Default Branch').zh, '默认分支');
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

// ============================ 已有字典的处置模式 ============================

test('parseArgs：--on-exist 默认 skip，取值非法时报错而非静默退回', () => {
  // 默认 skip 是定时任务的幂等保证：没有它，每日一次的任务会把已产出的版本反复重跑、白烧 tokens
  assert.strictEqual(dictAuto.ON_EXIST, 'skip');
  assert.strictEqual(dictAuto.parseArgs(['node', 'x', '--version', '3.6.5']).onExist, 'skip');
  for (const mode of dictAuto.ON_EXIST_MODES) {
    assert.strictEqual(dictAuto.parseArgs(['node', 'x', '--on-exist', mode]).onExist, mode);
  }
  // 静默退回默认的症状是「明明写了 overwrite，却什么都没发生」——比直接失败难查得多
  assert.throws(() => dictAuto.parseArgs(['node', 'x', '--on-exist', 'force']), /取值非法/);
});

// 造一份最小字典：segments 是 {段名: {键: 译文}}，groups 是 {组名: [键]}
function doc(segments = {}, groups = {}) {
  return { common: {}, windows: {}, macos: {}, linux: {}, ...segments, groups };
}

test('diffDicts：新增、删除、译文变化、换段各归各类', () => {
  const existing = doc({ common: { A: '甲', B: '乙', C: '丙' }, macos: { D: '丁' } }, { 组一: ['A', 'B'] });
  const produced = doc(
    { common: { A: '甲', B: '乙改', E: '戊' }, macos: { C: '丙', D: '丁' } },
    { 组一: ['A'], 组二: ['B'] }
  );
  const d = dictAuto.diffDicts(existing, produced);

  assert.deepStrictEqual(d.added, [{ seg: 'common', key: 'E', zh: '戊' }]);
  assert.deepStrictEqual(d.changed, [{ seg: 'common', key: 'B', from: '乙', to: '乙改' }]);
  // C 从 common 换到 macos：按键对齐才能看出「只是换了归属」，按段对齐会误报成一删一增
  assert.deepStrictEqual(d.moved, [{ key: 'C', from: 'common', to: 'macos', zh: '丙' }]);
  assert.strictEqual(d.removed.length, 0);
  assert.deepStrictEqual(d.groupsChanged, [{ key: 'B', from: '组一', to: '组二' }]);
});

test('diffDicts：产出里没有的键记为删除，并带上原有译文', () => {
  const d = dictAuto.diffDicts(
    doc({ common: { Gone: '已删', Stay: '留' } }),
    doc({ common: { Stay: '留' } })
  );
  assert.deepStrictEqual(d.removed, [{ seg: 'common', key: 'Gone', zh: '已删' }]);
  assert.strictEqual(d.added.length, 0);
  assert.strictEqual(d.changed.length, 0);
  assert.strictEqual(d.moved.length, 0);
});

test('diffDicts：两份完全一致时四类差异都为空', () => {
  const a = doc({ common: { A: '甲' }, macos: { B: '乙' } }, { 组一: ['A', 'B'] });
  const d = dictAuto.diffDicts(a, doc({ common: { A: '甲' }, macos: { B: '乙' } }, { 组一: ['A', 'B'] }));
  for (const k of ['added', 'removed', 'changed', 'moved', 'groupsChanged']) {
    assert.strictEqual(d[k].length, 0, `${k} 应为空`);
  }
});

test('diffDicts：新增与删除的键不产生「组归属变化」', () => {
  // 新增的键在旧字典里没有归属、删除的键在新字典里没有，拿它们比归属没有意义
  const d = dictAuto.diffDicts(
    doc({ common: { Old: '旧' } }, { 组一: ['Old'] }),
    doc({ common: { New: '新' } }, { 组二: ['New'] })
  );
  assert.strictEqual(d.added.length, 1);
  assert.strictEqual(d.removed.length, 1);
  assert.strictEqual(d.groupsChanged.length, 0);
});

test('diffDicts：产出里没分到组的键，组归属记为待分组', () => {
  const d = dictAuto.diffDicts(
    doc({ common: { A: '甲' } }, { 组一: ['A'] }),
    doc({ common: { A: '甲' } }, {})
  );
  assert.deepStrictEqual(d.groupsChanged, [{ key: 'A', from: '组一', to: common.UNGROUPED }]);
});

test('shapeDiff：每类截到上限，但总数照实报', () => {
  // 只留 500 条而不记总数的话，「报告里只有 500 条」会被读成「一共就 500 条」
  const rows = Array.from({ length: dictAuto.DIFF_LIMIT + 3 }, (_, i) => ({ key: `k${i}` }));
  const shaped = dictAuto.shapeDiff({
    added: rows, removed: [], changed: [], moved: [], groupsChanged: [],
  });
  assert.strictEqual(shaped.added.length, dictAuto.DIFF_LIMIT);
  assert.strictEqual(shaped.addedCount, dictAuto.DIFF_LIMIT + 3);
  assert.strictEqual(shaped.removedCount, 0);
  assert.deepStrictEqual(shaped.removed, []);
});
