// 字典条目整理单测：作用域键隔离 + 整模板键译文校验
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildEntries, scopedEntries } = require('../scripts/common');

const RAW = {
  _meta: { version: '3.6.5' },
  'Sign in': '登录',
  'en-US': 'zh-CN',
  'main.js|en-US': 'en-US-主进程',
  'renderer.js|en-US': 'zh-CN-渲染进程',
  '&About GitHub Desktop': '&关于 GitHub Desktop',
  '`${GE(n)} file${xU(n)}`': '`${GE(n)} 个文件`',
};

test('buildEntries：跳过 _ 元信息键，保留原样键（含作用域前缀）', () => {
  const entries = buildEntries(RAW, '3.6.5');
  assert.ok(!entries.has('_meta'));
  assert.strictEqual(entries.size, 6);
  assert.strictEqual(entries.get('renderer.js|en-US'), 'zh-CN-渲染进程');
});

test('buildEntries：整模板键译文必须是 JS 字面量，否则报错', () => {
  assert.throws(() => buildEntries({ '`${a}`': '不是字面量' }, '3.6.5'), /整模板键/);
  assert.doesNotThrow(() => buildEntries({ '`${a}`': '`${a} 译文`' }, '3.6.5'));
  assert.throws(() => buildEntries({ 'Sign in': '' }, '3.6.5'), /非空字符串/);
});

test('scopedEntries：按文件隔离，作用域键去前缀后生效', () => {
  const entries = buildEntries(RAW, '3.6.5');

  const renderer = scopedEntries(entries, 'renderer.js');
  assert.strictEqual(renderer.get('en-US'), 'zh-CN-渲染进程'); // 作用域键覆盖全局键（后写入生效）
  assert.ok(renderer.has('Sign in'));
  assert.ok(!renderer.has('renderer.js|en-US'));
  assert.ok(!renderer.has('en-US-主进程'));

  const main = scopedEntries(entries, 'main.js');
  assert.strictEqual(main.get('en-US'), 'en-US-主进程');
  assert.strictEqual(main.get('&About GitHub Desktop'), '&关于 GitHub Desktop');

  // 不指定文件时保留全部条目（含作用域前缀），供统计/报告使用
  const all = scopedEntries(entries);
  assert.ok(all.has('renderer.js|en-US'));
  assert.ok(all.has('en-US'));
  assert.strictEqual(all.size, 6);
});

// —— formatVersion 2：分段结构（平台段 + groups 段）——
// common 放三平台共有的条目，windows / macos / linux 放各平台独有的；groups 只描述分组，
// 不参与替换。判据见 docs/dict-v2/design.md。
const SEGMENTED = {
  _meta: { version: '3.6.6', formatVersion: 2 },
  common: { '&File': '文件', 'renderer.js|en-US': 'zh-CN' },
  windows: { 'label:"Open &with…"': 'label:"打开方式…"' },
  macos: { 'label:"File"': 'label:"文件"' },
  linux: { 'Show in your File Manager': '在文件管理器中打开' },
  groups: { '菜单-文件': ['&File', 'label:"Open &with…"'], 待分组: ['renderer.js|en-US'] },
};

test('buildEntries：formatVersion 2 合并 common 与当前平台段，groups 不参与替换', () => {
  const win = buildEntries(SEGMENTED, '3.6.6', 'windows');
  assert.deepStrictEqual(
    [...win.keys()],
    ['&File', 'renderer.js|en-US', 'label:"Open &with…"']
  );
  assert.ok(!win.has('groups'));
  assert.ok(!win.has('菜单-文件'));

  const mac = buildEntries(SEGMENTED, '3.6.6', 'macos');
  assert.ok(mac.has('label:"File"'));
  assert.ok(!mac.has('label:"Open &with…"'));
  assert.strictEqual(mac.get('&File'), '文件'); // common 段两个平台都取

  // linux 段独自生效
  assert.ok(buildEntries(SEGMENTED, '3.6.6', 'linux').has('Show in your File Manager'));
});

test('buildEntries：未知平台只取 common 段（宽容降级，不抛错）', () => {
  const other = buildEntries(SEGMENTED, '3.6.6', 'freebsd');
  assert.deepStrictEqual([...other.keys()], ['&File', 'renderer.js|en-US']);
});

test('buildEntries：段间同名键属非法，报错而非静默覆盖', () => {
  const dup = {
    _meta: { formatVersion: 2 },
    common: { 'Sign in': '登录' },
    windows: { 'Sign in': '登入' },
    macos: {},
    linux: {},
    groups: {},
  };
  assert.throws(() => buildEntries(dup, '3.6.6', 'windows'), /字典条目重复.*common.*windows/);
  // 只看 common 的平台不受影响——重复的段没被读入
  assert.doesNotThrow(() => buildEntries(dup, '3.6.6', 'freebsd'));
});

test('buildEntries：段落缺失或类型不对时报错', () => {
  const base = { _meta: { formatVersion: 2 }, common: {}, windows: {}, macos: {}, linux: {}, groups: {} };
  assert.throws(() => buildEntries({ ...base, groups: undefined }, '3.6.6'), /缺少对象形式的 "groups" 段/);
  assert.throws(() => buildEntries({ ...base, macos: [] }, '3.6.6'), /缺少对象形式的 "macos" 段/);
});

test('buildEntries：分段结构沿用同一套条目校验，作用域前缀先剥再判整模板键', () => {
  const seg = (entries) => ({
    _meta: { formatVersion: 2 },
    common: entries,
    windows: {},
    macos: {},
    linux: {},
    groups: {},
  });
  assert.throws(() => buildEntries(seg({ 'Sign in': '' }), '3.6.6'), /非空字符串/);
  // 带作用域的整模板键：拿原键判断会因开头不是反引号而整条漏检，故先剥前缀
  assert.throws(
    () => buildEntries(seg({ 'renderer.js|`${t} ${n}s`': '不是字面量' }), '3.6.6'),
    /整模板键/
  );
  assert.doesNotThrow(() =>
    buildEntries(seg({ 'renderer.js|`${t} ${n}s`': '`${t} ${n} 秒`' }), '3.6.6')
  );
});

test('buildEntries：无 formatVersion 的扁平字典仍按原逻辑解析（向后兼容）', () => {
  const entries = buildEntries(RAW, '3.6.5', 'windows');
  assert.strictEqual(entries.size, 6);
  assert.strictEqual(entries.get('Sign in'), '登录');
});
