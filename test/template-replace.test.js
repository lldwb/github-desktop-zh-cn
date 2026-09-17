// 整模板键单测：整模板区间提取 + 整段替换 + 与文本段替换的优先级
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { stringLiterals, applyDictInStrings } = require('../scripts/common');

// 覆盖：普通模板 / 含插值模板 / 无插值模板 / 插值内的嵌套模板 / 嵌套模板所在的外层模板
const SAMPLE = [
  'const a="Hello";',
  'const b=`${GE(n)} changed file${xU(n)}`;',
  'const c=`${i} of ${j}`;',
  'const d=`plain`;',
  'const e=`seg ${x} tail`;',
  'const f=`outer ${cond?`${GE(i)} of `:""} ${GE(m)} changed file${xU(m)}`;',
].join('\n');

test('stringLiterals：模板整段一律收集（含插值与否），文本段另计', () => {
  const tmpl = stringLiterals(SAMPLE)
    .filter((l) => l.template)
    .map((l) => l.content);
  assert.deepStrictEqual(tmpl, [
    '`${GE(n)} changed file${xU(n)}`',
    '`${i} of ${j}`',
    '`plain`',
    '`seg ${x} tail`',
    '`outer ${cond?`${GE(i)} of `:""} ${GE(m)} changed file${xU(m)}`',
  ]);
});

test('applyDictInStrings：整模板键整段替换，插值结构与同级代码保留', () => {
  const entries = new Map([
    ['`${GE(n)} changed file${xU(n)}`', '`${GE(n)} 个更改的文件`'],
    ['`${i} of ${j}`', '`${i} / ${j}`'],
    [' tail', ' 尾部'],
    ['Hello', '你好'],
  ]);
  const { content, total } = applyDictInStrings(SAMPLE, entries);

  assert.strictEqual(total, 4);
  assert.ok(content.includes('const a="你好";'));
  assert.ok(content.includes('const b=`${GE(n)} 个更改的文件`;'));
  assert.ok(content.includes('const c=`${i} / ${j}`;'));
  assert.ok(content.includes('const d=`plain`;'));
  // 未整段替换的模板，其文本段仍按普通键替换
  assert.ok(content.includes('const e=`seg ${x} 尾部`;'));
  // 外层模板未命中整模板键时保持原样（其插值内的嵌套模板不单独替换）
  assert.ok(
    content.includes(
      'const f=`outer ${cond?`${GE(i)} of `:""} ${GE(m)} changed file${xU(m)}`;'
    )
  );
});

test('applyDictInStrings：整模板键优先，内层文本段不重复替换', () => {
  const entries = new Map([
    ['`${i} of ${j}`', '`${i} / ${j}`'],
    [' of ', ' / '], // 若内层文本段也被替换，将产生 `${i} / ${j}` 之外的偏差
  ]);
  const { content, total } = applyDictInStrings('const c=`${i} of ${j}`;', entries);

  assert.strictEqual(total, 1);
  assert.strictEqual(content, 'const c=`${i} / ${j}`;');
});
