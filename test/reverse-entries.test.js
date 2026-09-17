// reverseEntries 单测：逆向还原的键形态、安全判据、歧义取舍与往返一致性
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { reverseEntries, applyDictInStrings, scopedEntries } = require('../scripts/common');

// 把「原样键 → 译文」的字面量对象转成 loadDict 的产物形态
const dict = (obj) => new Map(Object.entries(obj));

test('reverseEntries：逆向键就是译文原样，不剥引号', () => {
  const entries = dict({
    'last commit': '上次提交',
    '`${this.getButtonVerb()} last commit`': '`修改上次提交`',
  });
  const { entries: rev } = reverseEntries(entries, 'renderer.js');

  assert.strictEqual(rev.get('上次提交'), 'last commit');
  // 整模板译文连反引号一起作键——产物里无插值模板的整段区间正是这个形态
  assert.strictEqual(rev.get('`修改上次提交`'), '`${this.getButtonVerb()} last commit`');
});

test('reverseEntries：还原后模板仍是完整模板（反引号不落在文本段中间）', () => {
  const src = 'const a=`修改上次提交`;';
  const entries = dict({ '`${x} last commit`': '`修改上次提交`' });
  const { entries: rev } = reverseEntries(entries, 'renderer.js');
  const { content, total } = applyDictInStrings(src, rev);

  assert.strictEqual(total, 1);
  assert.strictEqual(content, 'const a=`${x} last commit`;');
});

test('reverseEntries：纯空白/标点/通用标点译文不参与（否则误伤原版同名文本）', () => {
  const entries = dict({
    'that ': ' ',
    ' of ': ' / ',
    'automatically…': '…',
    'The "': '“',
  });
  const { entries: rev, skipped } = reverseEntries(entries, 'renderer.js');

  assert.strictEqual(rev.size, 0);
  assert.strictEqual(skipped, 4);
  // 原版里本来就有的空格与省略号必须原样保留
  const src = 'const a=" ";const b="…";const c=" of ";';
  const { content, total } = applyDictInStrings(src, rev);
  assert.strictEqual(total, 0);
  assert.strictEqual(content, src);
});

test('reverseEntries：含字母数字或非通用非 ASCII 的译文参与还原', () => {
  const entries = dict({
    'en-US': 'zh-CN',
    '`${t} ${n}s`': '`${t} ${n}`',
    'in the browser.': '。',
    'Account': '账户',
  });
  const { entries: rev, skipped } = reverseEntries(entries, 'renderer.js');

  assert.strictEqual(skipped, 0);
  assert.strictEqual(rev.get('zh-CN'), 'en-US');
  assert.strictEqual(rev.get('`${t} ${n}`'), '`${t} ${n}s`');
  assert.strictEqual(rev.get('。'), 'in the browser.');
  assert.strictEqual(rev.get('账户'), 'Account');
});

test('reverseEntries：歧义取舍——作用域键优先、更短原文优先、先入者优先', () => {
  // 长度不同：短者胜（词根形式）
  const shorter = reverseEntries(dict({ Accounts: '账户', Account: '账户' }), 'renderer.js');
  assert.strictEqual(shorter.entries.get('账户'), 'Account');
  assert.strictEqual(shorter.ambiguous, 1);

  // 长度相同：先入者胜
  const first = reverseEntries(dict({ Parameters: '参数', ' arguments': '参数' }), 'renderer.js');
  assert.strictEqual(first.entries.get('参数'), 'Parameters');

  // 作用域键优先于全局键（即使原文更长）
  const scoped = reverseEntries(
    dict({ Branch: '分支', 'renderer.js|Branches': '分支' }),
    'renderer.js'
  );
  assert.strictEqual(scoped.entries.get('分支'), 'Branches');

  // 指向别的文件的作用域键不参与本文件
  const other = reverseEntries(dict({ 'main.js|Branch': '分支' }), 'renderer.js');
  assert.strictEqual(other.entries.size, 0);
});

test('往返一致：官方原版 → 汉化 → 逆向还原 → 再汉化，逐字节相同', () => {
  const entries = dict({
    'Add': '添加',
    'Add a repository': '添加仓库',
    '`${n} changed file${s}`': '`${n} 个更改的文件${s}`',
    'last commit': '上次提交',
    '`${x} last commit`': '`修改上次提交`',
    'en-US': 'zh-CN',
    ' of ': ' / ',
  });
  const pristine = [
    'const a="Add a repository";',
    'const b="Add";',
    'const c=`${n} changed file${s}`;',
    'const d=`${x} last commit`;',
    'const e="en-US";',
    'const f=`${i} of ${j}`;',
  ].join('\n');

  const patched = applyDictInStrings(pristine, scopedEntries(entries, 'renderer.js')).content;
  assert.ok(patched.includes('"添加仓库"'));
  assert.ok(patched.includes('const c=`${n} 个更改的文件${s}`;'));
  assert.ok(patched.includes('const d=`修改上次提交`;'));
  assert.ok(patched.includes('"zh-CN"'));
  // " of " 译作 " / "，产物里与官方原版里的同名文本无法区分——这正是它不参与还原的原因
  assert.ok(patched.includes('const f=`${i} / ${j}`;'));

  const back = applyDictInStrings(patched, reverseEntries(entries, 'renderer.js').entries).content;
  assert.ok(back.includes('const a="Add a repository";'));
  assert.ok(back.includes('const c=`${n} changed file${s}`;'));
  assert.ok(back.includes('const d=`${x} last commit`;'));
  assert.ok(back.includes('const e="en-US";'));
  assert.ok(back.includes('const f=`${i} / ${j}`;')); // 保留产物内容，不误改成 " of "

  const again = applyDictInStrings(back, scopedEntries(entries, 'renderer.js')).content;
  assert.strictEqual(again, patched);
});
