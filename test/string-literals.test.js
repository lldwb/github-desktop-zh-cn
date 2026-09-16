// stringLiterals / applyDictInStrings 单测：字面量提取 + 整串匹配（不误伤标识符、协议串、子串）
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { stringLiterals, applyDictInStrings } = require('../scripts/common');

// 覆盖：双引号 / 单引号 / 模板文本段 / 行注释 / 块注释 / 转义 / 嵌套模板 / 插值内正则 /
// 除法与正则字面量的区分 / return 后的正则 / 协议串 / 子串诱饵
const SAMPLE = [
  'const a = "Hello World";',
  "var b = 'single quote';",
  'let c = `template ${a} text`;',
  '// comment "not a string"',
  '/* block "also not" */',
  'const d = "escaped \\" quote";',
  'const e = `nested ${fn("inner string")} done`;',
  'throw new Error("boom");',
  'const f = `a${x}${y.map(i => `deep ${i}`).join(", ")}z`;',
  'const g = `re ${/["\']/.test(s) ? 1 : 0} tail`;',
  'if (x) { return/^\\d+$/.test(y); }',
  'const h = "after regex";',
  'const proto = "sessions.setAdditionalPlugins";',
  'const ui = "Add a repository";',
  'const en = "Add";',
].join('\n');

const EXPECTED_LITERALS = [
  'Hello World',
  'single quote',
  'template ',
  ' text',
  'escaped \\" quote',
  'nested ',
  ' done',
  'boom',
  'a',
  'z',
  're ',
  ' tail',
  'after regex',
  'sessions.setAdditionalPlugins',
  'Add a repository',
  'Add',
];

test('stringLiterals：只提取字符串与模板文本段，跳过注释与正则', () => {
  const lits = stringLiterals(SAMPLE).filter((l) => !l.template);
  assert.deepStrictEqual(
    lits.map((l) => l.content),
    EXPECTED_LITERALS
  );
});

test('applyDictInStrings：整串匹配替换，命中数准确', () => {
  const entries = new Map([
    ['Hello World', '你好世界'],
    ['boom', '轰'],
    ['Add', '添加'],
    ['Add a repository', '添加仓库'],
  ]);
  const { content, total } = applyDictInStrings(SAMPLE, entries);

  assert.strictEqual(total, 4);
  assert.ok(content.includes('"你好世界"'));
  assert.ok(content.includes('"轰"'));
  assert.ok(content.includes('"添加"'));
  assert.ok(content.includes('"添加仓库"'));
});

test('applyDictInStrings：不误伤协议串、正则结果与嵌套模板', () => {
  const entries = new Map([
    ['Add', '添加'],
    ['Add a repository', '添加仓库'],
  ]);
  const { content } = applyDictInStrings(SAMPLE, entries);

  // 子串不替换：协议串里的 Add 必须原样保留
  assert.ok(content.includes('"sessions.setAdditionalPlugins"'));
  assert.ok(!content.includes('添加dditionalPlugins'));
  assert.ok(!content.includes('添加a repository'));
  // 正则字面量后的字符串照常参与匹配，说明扫描状态未被正则内的引号污染
  assert.ok(content.includes('"after regex"'));
  // 插值内的嵌套模板内容不替换（插值内是代码）
  assert.ok(content.includes('deep '));
});
