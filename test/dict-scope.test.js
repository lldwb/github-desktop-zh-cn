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
