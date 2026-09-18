// 字典写入口（scripts/dict-edit.js）单测：只读 API、校验清单、事务写入与失败回滚
//
// 隔离方式：用例一律使用仓库里不存在的版本号 0.0.0-test，它落在 dictionaries/ 下但不会被
// build.js 内嵌、也不会被 listDictVersions 之外的地方看到；每个用例结束即整目录删除。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const common = require('../scripts/common');
const dictEdit = require('../scripts/dict-edit');

const VERSION = '0.0.0-test';
const FILE = common.dictFile(VERSION);
const DIR = path.dirname(FILE);

// 扁平夹具：迁移用例的输入，也是"旧格式不该被 read 直接接受"的证据
const FLAT = {
  _meta: { version: VERSION, notes: '扁平夹具' },
  'Sign in': '登录',
  'en-US': 'zh-CN',
  'renderer.js|en-US': 'zh-CN-渲染进程',
  '`${n} file`': '`${n} 个文件`',
};

function segmented(over = {}) {
  return {
    _meta: { version: VERSION, formatVersion: 2 },
    common: { 'Sign in': '登录', 'en-US': 'zh-CN' },
    windows: { 'label:"Open &with…"': 'label:"打开方式…"' },
    macos: {},
    linux: {},
    groups: { 菜单: ['Sign in'] },
    ...over,
  };
}

function writeDoc(raw) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

const bytes = () => fs.readFileSync(FILE);
const tmpExists = () => fs.existsSync(`${FILE}.tmp`);

// 每个用例自带清理：断言失败也不会把临时字典留在仓库里
function isolate(t) {
  t.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
}

const codes = (problems) => problems.map((p) => p.code);

// ============================ 只读 ============================

test('read：返回五段结构，改动返回值不回写磁盘', (t) => {
  isolate(t);
  writeDoc(segmented());
  const before = bytes();

  const doc = dictEdit.read(VERSION);
  assert.deepStrictEqual(Object.keys(doc), ['_meta', 'common', 'windows', 'macos', 'linux', 'groups']);
  assert.strictEqual(doc.common['Sign in'], '登录');
  assert.deepStrictEqual(doc.groups['菜单'], ['Sign in']);

  doc.common['Sign in'] = '改了也不该落盘';
  doc.groups['菜单'].push('乱加');
  assert.deepStrictEqual(bytes(), before);
});

test('read：旧扁平格式不在这里兼容，报错并指路 migrate', (t) => {
  isolate(t);
  writeDoc(FLAT);
  assert.throws(() => dictEdit.read(VERSION), /formatVersion|migrate/);
});

test('query：按平台 / 组 / 关键字过滤，省略平台时不筛段', (t) => {
  isolate(t);
  writeDoc(segmented());

  assert.deepStrictEqual(
    dictEdit.query(VERSION, { platform: 'windows' }).map((r) => r.key),
    ['Sign in', 'en-US', 'label:"Open &with…"']
  );
  assert.deepStrictEqual(
    dictEdit.query(VERSION, { group: '菜单' }).map((r) => r.key),
    ['Sign in']
  );
  // 关键字同时匹配原文与译文，大小写不敏感
  assert.deepStrictEqual(dictEdit.query(VERSION, { keyword: 'sign' }).map((r) => r.key), ['Sign in']);
  assert.deepStrictEqual(dictEdit.query(VERSION, { keyword: '打开方式' }).map((r) => r.key), [
    'label:"Open &with…"',
  ]);
  // 无组的条目 group 为 null，供 GUI 落「待分组」
  assert.strictEqual(dictEdit.query(VERSION, { keyword: 'en-US' })[0].group, null);
});

// ============================ 校验 ============================

test('validate：合法字典零错误，未分组只给 warning', (t) => {
  isolate(t);
  writeDoc(segmented());

  const { errors, warnings } = dictEdit.validate(VERSION);
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(codes(warnings), ['group/ungrouped']);
  // 分组只是参考，不阻断写入：3 条里只有 Sign in 归了组
  assert.ok(warnings[0].detail.includes('2 条'));
});

test('validate：_meta 的版本号与格式版本', (t) => {
  isolate(t);
  writeDoc(segmented({ _meta: { version: '9.9.9', formatVersion: 2 } }));
  assert.deepStrictEqual(codes(dictEdit.validate(VERSION).errors), ['meta/version-mismatch']);

  writeDoc(segmented({ _meta: { formatVersion: 2 } }));
  assert.deepStrictEqual(codes(dictEdit.validate(VERSION).errors), ['meta/version']);

  writeDoc(segmented({ _meta: { version: VERSION, formatVersion: 1 } }));
  assert.deepStrictEqual(codes(dictEdit.validate(VERSION).errors), ['meta/format']);

  // 真·扁平字典（顶层没有段名）才引导去 migrate
  writeDoc(FLAT);
  assert.deepStrictEqual(codes(dictEdit.validate(VERSION).errors), ['format/old']);
});

test('validate：段落缺失或类型不对', (t) => {
  isolate(t);
  writeDoc(segmented({ groups: undefined }));
  assert.deepStrictEqual(codes(dictEdit.validate(VERSION).errors), ['segment/missing']);

  writeDoc(segmented({ macos: [] }));
  assert.deepStrictEqual(codes(dictEdit.validate(VERSION).errors), ['segment/missing']);
});

test('validate：译文必须是非空字符串，整模板键译文必须是 JS 字面量', (t) => {
  isolate(t);
  writeDoc(segmented({ common: { A: '', B: 42, C: null }, groups: {} }));
  assert.deepStrictEqual(codes(dictEdit.validate(VERSION).errors), [
    'entry/value',
    'entry/value',
    'entry/value',
  ]);

  writeDoc(segmented({ common: { '`${n} file`': '不是字面量' }, groups: {} }));
  const problems = dictEdit.validate(VERSION).errors;
  assert.deepStrictEqual(codes(problems), ['entry/template']);
  assert.ok(problems[0].detail.includes('整模板键'));

  // 带作用域前缀的整模板键：拿原键判断会因开头不是反引号而整条漏检
  writeDoc(segmented({ common: { 'renderer.js|`${t} ${n}s`': '不是字面量' }, groups: {} }));
  assert.deepStrictEqual(codes(dictEdit.validate(VERSION).errors), ['entry/template']);
});

test('validate：键跨段重复是 error，不静默取后写入者', (t) => {
  isolate(t);
  writeDoc(segmented({ windows: { 'Sign in': '登入' } }));
  const problems = dictEdit.validate(VERSION).errors;
  assert.deepStrictEqual(codes(problems), ['entry/duplicate']);
  assert.strictEqual(problems[0].key, 'Sign in');
  assert.ok(problems[0].detail.includes('common') && problems[0].detail.includes('windows'));
});

test('validate：作用域键只能指向 main.js / renderer.js', (t) => {
  isolate(t);
  writeDoc(segmented({ common: { 'index.js|Sign in': '登录' }, groups: {} }));
  const problems = dictEdit.validate(VERSION).errors;
  assert.deepStrictEqual(codes(problems), ['entry/scope']);
  assert.ok(problems[0].detail.includes('main.js'));
});

test('validate：groups 引用不存在的键是 error，非数组也是', (t) => {
  isolate(t);
  writeDoc(segmented({ groups: { 菜单: ['Sign in', '子虚乌有'] } }));
  const problems = dictEdit.validate(VERSION).errors;
  assert.deepStrictEqual(codes(problems), ['group/dangling']);
  assert.strictEqual(problems[0].key, '子虚乌有');

  writeDoc(segmented({ groups: { 菜单: 'Sign in' } }));
  assert.deepStrictEqual(codes(dictEdit.validate(VERSION).errors), ['group/type']);
});

test('validate：译文与原文相同只提示，不阻断', (t) => {
  isolate(t);
  writeDoc(segmented({ common: { 'Sign in': 'Sign in' } }));
  const { errors, warnings } = dictEdit.validate(VERSION);
  assert.deepStrictEqual(errors, []);
  assert.ok(codes(warnings).includes('entry/untranslated'));
});

// ============================ 事务写入 ============================

test('apply：正常写入落盘，无 .tmp 残留，段序稳定', (t) => {
  isolate(t);
  writeDoc(segmented());

  const r = dictEdit.apply(VERSION, [{ op: 'add', key: '&File', zh: '文件', group: '菜单-文件' }]);
  assert.deepStrictEqual(r.changes, ['add common &File']);
  assert.ok(!tmpExists());

  const after = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.strictEqual(after.common['&File'], '文件');
  assert.deepStrictEqual(after.groups['菜单-文件'], ['&File']);
  assert.deepStrictEqual(Object.keys(after), ['_meta', 'common', 'windows', 'macos', 'linux', 'groups']);
});

test('apply：批量里有一条破坏校验 → 原文件逐字节不变、无 .tmp、错误带 problems', (t) => {
  isolate(t);
  writeDoc(segmented());
  const before = bytes();

  // 第一条本身合法，第二条让 groups 引用了不存在的键——校验在写盘前拦下，两条都不生效
  assert.throws(
    () =>
      dictEdit.apply(VERSION, [
        { op: 'update', key: 'Sign in', zh: '登录（改）' },
        { op: 'setGroup', key: '根本没这个键', group: '菜单' },
      ]),
    (e) => {
      assert.ok(e instanceof dictEdit.DictError);
      assert.deepStrictEqual(codes(e.problems), ['group/dangling']);
      assert.ok(e.message.includes('已放弃写入'));
      return true;
    }
  );

  assert.deepStrictEqual(bytes(), before); // 逐字节对拍，不是字符串比较
  assert.ok(!tmpExists());
});

test('apply：操作本身非法时同样整体放弃，错误说明第几条', (t) => {
  isolate(t);
  writeDoc(segmented());
  const before = bytes();

  assert.throws(
    () =>
      dictEdit.apply(VERSION, [
        { op: 'add', key: '新键', zh: '新译文' },
        { op: 'add', key: 'Sign in', zh: '重复添加' }, // 键已存在
      ]),
    /第 2 条操作.*已存在/
  );
  assert.deepStrictEqual(bytes(), before);

  assert.throws(() => dictEdit.apply(VERSION, [{ op: '飞天' }]), /第 1 条操作.*未知操作/);
  assert.deepStrictEqual(bytes(), before);
  assert.ok(!tmpExists());
});

test('apply：dryRun 走完全部校验但不落盘', (t) => {
  isolate(t);
  writeDoc(segmented());
  const before = bytes();

  const r = dictEdit.apply(VERSION, [{ op: 'add', key: '&File', zh: '文件' }], { dryRun: true });
  assert.strictEqual(r.dryRun, true);
  assert.deepStrictEqual(r.changes, ['add common &File']);
  assert.deepStrictEqual(bytes(), before);
  assert.ok(!tmpExists());
  // 预览文本就是将要写入的内容，好让调用方先看一眼再做决定
  assert.ok(r.text.includes('"&File": "文件"'));

  // dryRun 也一样会拦下非法修改
  assert.throws(
    () => dictEdit.apply(VERSION, [{ op: 'update', key: '无此键', zh: 'x' }], { dryRun: true }),
    /找不到键/
  );
});

test('apply：内容与原文一致时不写盘（避免无谓的 mtime 变化）', (t) => {
  isolate(t);
  writeDoc(segmented());
  const before = bytes();
  const mtime = fs.statSync(FILE).mtimeMs;

  dictEdit.apply(VERSION, [{ op: 'update', key: 'Sign in', zh: '登录' }]);
  assert.deepStrictEqual(bytes(), before);
  assert.strictEqual(fs.statSync(FILE).mtimeMs, mtime);
  assert.ok(!tmpExists());
});

test('update：键在多个段有歧义时要求指明平台', (t) => {
  isolate(t);
  // 这个夹具本身非法（跨段重复），这里只用它验证 op 阶段的歧义处理：
  // 若不拦，found[0] 会随机挑一段改，等 validate 报「跨段重复」时已看不出是 update 造成的
  writeDoc(segmented({ windows: { 'Sign in': '登入' } }));

  assert.throws(
    () => dictEdit.update(VERSION, { key: 'Sign in', zh: 'x' }),
    /出现在多个段（common \/ windows）.*platform/
  );
  assert.throws(
    () => dictEdit.update(VERSION, { key: 'Sign in', zh: 'x', platform: 'windows' }),
    /字典校验未通过.*entry\/duplicate|已放弃写入/s
  );
  assert.deepStrictEqual(codes(dictEdit.validate(VERSION).errors), ['entry/duplicate']);
});

test('moveTo：目标段已有同键时拒绝（夹具跨段重复，只验 op 阶段）', (t) => {
  isolate(t);
  // 合法字典不可能出现跨段同键，这条防线针对的正是「字典已经坏了」的情况：
  // 此时搬迁不该再往坏结构上叠一层，而应报出确切冲突
  writeDoc(segmented({ windows: { 'Sign in': '登入' } }));
  assert.throws(
    () => dictEdit.moveTo(VERSION, { key: 'Sign in', from: 'common', to: 'windows' }),
    /已存在于 "windows" 段/
  );
});

test('remove / moveTo 的边界', (t) => {
  isolate(t);
  writeDoc(segmented({ windows: {}, groups: { 菜单: ['Sign in'] } }));

  assert.throws(() => dictEdit.remove(VERSION, { key: '无此键' }), /找不到要删除的键/);

  assert.doesNotThrow(() => dictEdit.add(VERSION, { key: 'OnlyWin', zh: '仅 Windows', platform: 'windows' }));
  assert.throws(
    () => dictEdit.moveTo(VERSION, { key: 'OnlyWin', from: 'macos', to: 'linux' }),
    /不在 "macos" 段/
  );
  assert.throws(
    () => dictEdit.moveTo(VERSION, { key: 'OnlyWin', from: 'common', to: 'common' }),
    /from 与 to 相同/
  );
  assert.throws(
    () => dictEdit.moveTo(VERSION, { key: 'OnlyWin', from: 'freebsd', to: 'linux' }),
    /取值非法/
  );
  assert.doesNotThrow(() => dictEdit.moveTo(VERSION, { key: 'OnlyWin', from: 'windows', to: 'linux' }));
  assert.deepStrictEqual(dictEdit.read(VERSION).linux, { OnlyWin: '仅 Windows' });

  // 删除条目要连带清掉 groups 里的引用，否则留下悬空键；组随之清空也要一并删掉
  assert.doesNotThrow(() => dictEdit.remove(VERSION, { key: 'Sign in' }));
  const doc = dictEdit.read(VERSION);
  assert.ok(!doc.common['Sign in']);
  assert.ok(!('菜单' in doc.groups));
  assert.deepStrictEqual(dictEdit.validate(VERSION).errors, []);
});

test('mergeIn：已存在的键按新译文覆盖，符合"继承后新译文优先"', (t) => {
  isolate(t);
  writeDoc(segmented());
  const r = dictEdit.mergeIn(VERSION, {
    entries: { 'Sign in': '登录（新版）', '新文案': '新译文' },
    group: '菜单',
  });
  assert.deepStrictEqual(r.changes, ['mergeIn common 2 条']);

  const doc = dictEdit.read(VERSION);
  assert.strictEqual(doc.common['Sign in'], '登录（新版）');
  assert.strictEqual(doc.common['新文案'], '新译文');
  assert.deepStrictEqual(doc.groups['菜单'], ['Sign in', '新文案']);
});

test('regroup：整体替换 groups 段', (t) => {
  isolate(t);
  writeDoc(segmented());
  assert.doesNotThrow(() => dictEdit.regroup(VERSION, { groups: { 待分组: ['Sign in', 'en-US', 'label:"Open &with…"'] } }));
  assert.deepStrictEqual(dictEdit.read(VERSION).groups, {
    待分组: ['Sign in', 'en-US', 'label:"Open &with…"'],
  });
  assert.deepStrictEqual(dictEdit.validate(VERSION).warnings, []);
  assert.throws(() => dictEdit.regroup(VERSION, { groups: { 菜单: 'Sign in' } }), /必须是键名数组/);
});

// ============================ 迁移与互通 ============================

test('migrate：扁平 → 分段，条目一条不丢、作用域键原样保留', (t) => {
  isolate(t);
  writeDoc(FLAT);

  const r = dictEdit.migrate(VERSION, { platform: 'windows', groups: { 测试组: ['Sign in'] } });
  assert.deepStrictEqual(r.changes, ['migrate 4 条 → windows 段']);
  assert.deepStrictEqual(dictEdit.validate(VERSION).errors, []);

  const doc = dictEdit.read(VERSION);
  assert.deepStrictEqual(Object.keys(doc.windows), Object.keys(FLAT).filter((k) => !k.startsWith('_')));
  assert.strictEqual(doc.windows['renderer.js|en-US'], 'zh-CN-渲染进程');
  assert.strictEqual(doc._meta.formatVersion, 2);
  assert.strictEqual(doc._meta.notes, '扁平夹具'); // 原有 _meta 字段保留
  assert.strictEqual(typeof doc._meta.updated, 'string');

  // 幂等：已经分段的字典不重复迁移，避免把手改过的结构打平重来
  const again = dictEdit.migrate(VERSION, { platform: 'windows' });
  assert.strictEqual(again.already, true);
  assert.strictEqual(dictEdit.read(VERSION).windows['Sign in'], '登录');
});

test('migrate：译文非法时拒绝迁移，原文件不动', (t) => {
  isolate(t);
  writeDoc({ ...FLAT, '坏条目': '' });
  const before = bytes();
  assert.throws(() => dictEdit.migrate(VERSION, { platform: 'windows' }), /非空字符串/);
  assert.deepStrictEqual(bytes(), before);
});

test('exportFlat：省略平台时导出当前平台视角（common ∪ 当前平台段）', (t) => {
  isolate(t);
  writeDoc(segmented());

  const mac = dictEdit.exportFlat(VERSION, { platform: 'macos' });
  assert.deepStrictEqual(Object.keys(mac), ['Sign in', 'en-US']); // macos 段为空
  const win = dictEdit.exportFlat(VERSION, { platform: 'windows' });
  assert.deepStrictEqual(Object.keys(win), ['Sign in', 'en-US', 'label:"Open &with…"']);
  // groups 不是条目，绝不进扁平导出
  assert.ok(!('菜单' in win));

  assert.deepStrictEqual(
    Object.keys(dictEdit.exportFlat(VERSION)),
    ['Sign in', 'en-US', 'label:"Open &with…"'] // 本机是 win32
  );
});
