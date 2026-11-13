// common.packagedToolPath 单测（独立验收 P4）：
// 「更新后自动汉化」要写进产物的工具路径只在打包态有意义——patch 注入与 restore 按组重放
// 共用这一处取值，两处各写一份会让打包态行为悄悄不一致（restore 重放时静默丢掉 autoPatch）。
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const common = require('../../scripts/common');

test('packagedToolPath：源码态返回 null（不往产物写死 node 路径）', () => {
  assert.strictEqual(common.packagedToolPath(), null);
});

test('packagedToolPath：打包态返回 process.execPath（bundle/SEA 产物自身）', () => {
  // isPackaged() 的判据之一是 globalThis.__BUNDLED__（tools/bundle.js 打的单文件产物会置真）
  globalThis.__BUNDLED__ = true;
  try {
    assert.strictEqual(common.packagedToolPath(), process.execPath);
  } finally {
    delete globalThis.__BUNDLED__;
  }
});
