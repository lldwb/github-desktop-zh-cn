// 字典版本列表单测：只有「三段数字」的目录才算可用字典版本
//
// 背景：dictionaries/ 下除了正式版本（3.6.6），还会短暂出现测试夹具（0.0.0-test）、
// 下载残留（3.6.6-beta）、临时解包目录。这些被当成真实版本时，菜单会列出打不开的版本、
// 打包内嵌会选错字典。所以 common.listDictVersions() 与 build.js 的 collectAssets()
// 都按 common.DICT_VERSION_RE 过滤。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DICT_VERSION_RE, listDictVersions, dataRoot } = require('../scripts/common');

test('DICT_VERSION_RE：只认三段数字', () => {
  for (const ok of ['3.6.6', '3.6.0', '0.0.0', '10.20.30']) {
    assert.ok(DICT_VERSION_RE.test(ok), `${ok} 应被认作版本`);
  }
  for (const no of ['0.0.0-test', '3.6.6-beta', '3.6.6-beta2', '3.6', 'v3.6.6', '3.6.6-official', 'README']) {
    assert.ok(!DICT_VERSION_RE.test(no), `${no} 不应被认作版本`);
  }
});

test('listDictVersions：非版本形态的目录不算字典版本', () => {
  // 夹具必须与真版本平级（dictionaries/<名字>/），才受同一套判据管辖——
  // 造深一层的话任何判据都不会收它，用例就成了空跑。
  const fixture = path.join(dataRoot(), 'dictionaries', '0.0.0-fixture');
  fs.mkdirSync(fixture, { recursive: true });
  fs.writeFileSync(path.join(fixture, 'zh-CN.json'), JSON.stringify({ _meta: { formatVersion: 2 } }));
  try {
    assert.ok(fs.existsSync(path.join(fixture, 'zh-CN.json')), '夹具应已落盘');
    assert.ok(fs.existsSync(path.join(dataRoot(), 'dictionaries', '3.6.6', 'zh-CN.json')), '真版本应同时在场');
    assert.ok(!listDictVersions().includes('0.0.0-fixture'), '夹具目录不该出现在版本列表里');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('listDictVersions：真实版本仍能列出，且列表里没有非版本形态', () => {
  const versions = listDictVersions();
  assert.ok(versions.includes('3.6.6'), '当前版本字典应在列表里');
  const bad = versions.filter((v) => !DICT_VERSION_RE.test(v));
  assert.deepStrictEqual(bad, [], `版本列表里混入了非版本形态：${bad.join(', ')}`);
});
