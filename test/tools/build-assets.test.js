// tools/build.js 的 collectAssets 单测：内嵌「最新一版**成对**资源」的选择规则。
//
// 背景：单文件产物（SEA）只内嵌一份资源，运行时其余版本由 dict-sync 成对获取。引擎按档案
// 替换，所以「可用版本」= 字典 + 档案都齐：最新版本缺档案时不能内嵌它（否则产物汉化最新版
// 会因缺档案被拒），应退到最新的成对版本并在构建日志里警告。
//
// 用临时目录 + 显式 dictRoot 参数驱动，不读仓库 checkout 的真实 dictionaries/（仓库内容会变，
// 直读会让测试变成「环境断言」——同 test/cmd/install-version-dict.test.js 的教训）。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { collectAssets } = require('../../tools/build');

function makeRoot(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghd-build-assets-'));
  for (const [version, files] of Object.entries(spec)) {
    const dir = path.join(root, version);
    fs.mkdirSync(dir, { recursive: true });
    for (const file of files) fs.writeFileSync(path.join(dir, file), '{}', 'utf8');
  }
  return root;
}

// 临时劫持 console.warn/console.log：断言警告内容后恢复（测试结束零残留）
function captureConsole(fn) {
  const warn = [];
  const log = [];
  const origWarn = console.warn;
  const origLog = console.log;
  console.warn = (...args) => warn.push(args.join(' '));
  console.log = (...args) => log.push(args.join(' '));
  try {
    return { result: fn(), warn, log };
  } finally {
    console.warn = origWarn;
    console.log = origLog;
  }
}

test('collectAssets：选最新成对版本，只内嵌该版本的两份文件', (t) => {
  const root = makeRoot({
    '3.6.0': ['zh-CN.json', 'patch.json'],
    '3.6.5': ['zh-CN.json'],
    '3.6.6': ['zh-CN.json', 'patch.json'],
    '3.6.7': ['patch.json'],
    '0.0.0-test': ['zh-CN.json', 'patch.json'], // 非版本形态：不参与
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { result: assets, warn } = captureConsole(() => collectAssets(root));
  assert.deepStrictEqual(Object.keys(assets).sort(), [
    'dictionaries/3.6.6/patch.json',
    'dictionaries/3.6.6/zh-CN.json',
  ]);
  for (const value of Object.values(assets)) assert.ok(fs.existsSync(value), value);
  // 3.6.5 有字典缺档案：不内嵌，但要在构建日志里暴露（维护者能看见缺口）
  assert.ok(warn.some((line) => line.includes('3.6.5')), warn.join('\n'));
});

test('collectAssets：最新版本缺档案 → 退到最新的成对版本并警告', (t) => {
  const root = makeRoot({
    '3.6.6': ['zh-CN.json', 'patch.json'],
    '3.6.7': ['zh-CN.json'], // 更新，但缺档案
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { result: assets, warn } = captureConsole(() => collectAssets(root));
  assert.deepStrictEqual(Object.keys(assets).sort(), [
    'dictionaries/3.6.6/patch.json',
    'dictionaries/3.6.6/zh-CN.json',
  ]);
  assert.ok(warn.some((line) => line.includes('3.6.7')), warn.join('\n'));
});

test('collectAssets：没有任何成对版本 → 构建失败（不产出半对产物）', (t) => {
  const root = makeRoot({
    '3.6.6': ['zh-CN.json'],
    '3.6.7': ['zh-CN.json'],
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(() => collectAssets(root), /没有成对的「字典 \+ 替换逻辑档案」/);
});
