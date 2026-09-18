// 字典自动产出（scripts/dict-auto.js）单测：候选口径、形态核对、平台分段与译文校验。
//
// 只测纯函数——真正读产物、联网取版本、调翻译服务的那几段由 CI 的定时任务在真实产物上跑，
// 单测里落一份几十 MB 的产物夹具既慢又容易过期。literalIndex 的返回值在下面按同样结构手工
// 构造：它本身就是「原文 → 出现在哪几个文件」的两张表，构造出来比读盘更能锁定被测行为。
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const common = require('../scripts/common');
const dictAuto = require('../scripts/dict-auto');

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

// ============================ 译文校验 ============================

test('placeholdersOf：抽出花括号占位符并排序，忽略出现顺序', () => {
  const a = dictAuto.placeholdersOf('Open {{count}} of {total} in ${name}');
  const b = dictAuto.placeholdersOf('${name} 里的 {total} 项，共 {{count}} 项');
  assert.strictEqual(a, b);
  assert.strictEqual(dictAuto.placeholdersOf('没有占位符'), '');
});

test('rejectReason：占位符不一致的译文被拒', () => {
  assert.strictEqual(dictAuto.rejectReason('{{count}} files', '{{count}} 个文件'), null);
  assert.ok(dictAuto.rejectReason('{{count}} files', '个文件'), '少了占位符应被拒');
  assert.ok(dictAuto.rejectReason('{{count}} files', '{{count}} {{total}} 个文件'), '多了占位符应被拒');
});

test('rejectReason：没有中文的译文被拒（域名、路径等无需翻译的例外另说）', () => {
  assert.ok(dictAuto.rejectReason('Open Repository', 'Open Repository'));
  assert.ok(dictAuto.rejectReason('Open Repository', '   '), '空译文应被拒');
  assert.strictEqual(dictAuto.rejectReason('Open Repository', '打开仓库'), null);
});

test('rejectReason：逗号与星号等非花括号符号不当占位符', () => {
  // 只在花括号与 ${} 上校验；把 %, * 也算进去会误杀大量正常译文
  assert.strictEqual(dictAuto.rejectReason('Open %s now', '立即打开 %s'), null);
  assert.strictEqual(dictAuto.rejectReason('*.md 文件', 'Markdown 文件'), null);
});

// ============================ AI 请求参数与「无需翻译」分流 ============================

test('resolveTimeout：秒转毫秒，未给则用默认值', () => {
  assert.strictEqual(dictAuto.resolveTimeout('1200'), 1200000);
  assert.strictEqual(dictAuto.resolveTimeout(60), 60000);
  // 环境变量为空串（没设）与 undefined 是同一件事：用默认
  assert.strictEqual(dictAuto.resolveTimeout(''), dictAuto.AI_TIMEOUT);
  assert.strictEqual(dictAuto.resolveTimeout(undefined), dictAuto.AI_TIMEOUT);
});

test('resolveTimeout：非法值报错，不静默退回默认', () => {
  // 静默退回的症状是「每批都超时，但日志里明明写着设了 1200 秒」——比直接失败难查得多
  for (const bad of ['abc', '0', '-5', 'NaN']) {
    assert.throws(() => dictAuto.resolveTimeout(bad), /正数秒/, `${bad} 应被拒`);
  }
});

test('resolveEffort：默认取最低档，none 表示不带该字段', () => {
  // 批量翻译界面短句用不上深度推理：最低档的思考量约为最高档的 1/6，耗时差一个数量级
  assert.strictEqual(dictAuto.resolveEffort(undefined), dictAuto.AI_EFFORT);
  assert.strictEqual(dictAuto.resolveEffort(null), dictAuto.AI_EFFORT);
  assert.strictEqual(dictAuto.AI_EFFORT, 'low');
  // 取值原样透传、不校验：网关认哪些档位由它自己说了算
  assert.strictEqual(dictAuto.resolveEffort('max'), 'max');
  assert.strictEqual(dictAuto.resolveEffort('  high  '), 'high', '两侧空白剥掉');
  // none 是逃生口：网关对不认识的档位直接报错时，退回接口自己的默认档（空串 = 不带该字段）
  assert.strictEqual(dictAuto.resolveEffort('none'), '');
  // 只认小写 none——取值原样透传，网关若真认 NONE 就该照样传过去
  assert.strictEqual(dictAuto.resolveEffort('NONE'), 'NONE');
});

test('isEcho：AI 原样返回判为无需翻译', () => {
  // 实测 3.6.7 新增候选里 10/22 是这类：域名、品牌名、仓库路径。SYSTEM_PROMPT 第 7 条
  // 要求的正是原样返回，判成「未译」会让整个版本因超门槛而产不出来（实测踩到过）
  for (const t of ['github.com', 'GitHub Desktop', 'GitHub Enterprise', 'anthropic', 'hubot/cool-repo', '.gitignore']) {
    assert.ok(dictAuto.isEcho(t, t), `${t} 原样返回应判为无需翻译`);
  }
  // 产物里同一条文案常带前导空格（JSX 片段），AI 返回时去掉了——不该因此算失败
  assert.ok(dictAuto.isEcho(' GitHub.com', 'GitHub.com'));
});

test('isEcho：译文不同、为空或非字符串时都不算原样返回', () => {
  assert.ok(!dictAuto.isEcho('Open Repository', '打开仓库'));
  assert.ok(!dictAuto.isEcho('Open Repository', ''));
  assert.ok(!dictAuto.isEcho('Open Repository', undefined), 'AI 漏回这条 → 走重试，不能当成功');
  // 大小写不同的「返回」不是原样返回：官方文案的书写变体多数是内容变化，得由校验判
  assert.ok(!dictAuto.isEcho('GitHub desktop', 'GitHub Desktop'));
});

// ============================ AI 请求接线（本地假服务器）============================

// 起一个假 chat/completions，把收到的请求交给 handler。
// 用本地回环而非真服务：这里要锁的是「参数有没有按约定进请求体」，与模型译得好不好无关，
// 也不该因为外网不通就失败。
async function withFakeAI(handler, fn) {
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => handler(req, JSON.parse(raw), res));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

const replyOk = (res, content = '{"1":"打开仓库"}') => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content } }] }));
};

test('translateBatch：默认档位 low 进请求体，none 则整个字段不带', async () => {
  const seen = [];
  const items = [{ text: 'Open Repository', source: 'ui/x.tsx' }];
  await withFakeAI(
    (req, body, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      replyOk(res);
    },
    async (base) => {
      const fixed = { base, key: 'k', model: 'm', timeout: 5000, examples: [] };
      // 默认档（环境变量与命令行都没给）
      const out = await dictAuto.translateBatch(items, { ...fixed, effort: dictAuto.resolveEffort(undefined) });
      assert.strictEqual(out['1'], '打开仓库');
      // none 是逃生口：网关不认档位时要能退回「不带这个字段」
      await dictAuto.translateBatch(items, { ...fixed, effort: dictAuto.resolveEffort('none') });
    }
  );

  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[0].url, '/chat/completions');
  assert.strictEqual(seen[0].auth, 'Bearer k');
  assert.strictEqual(seen[0].body.model, 'm');
  assert.strictEqual(seen[0].body.reasoning_effort, 'low', '默认档位要真的进请求体');
  assert.ok(!('reasoning_effort' in seen[1].body), 'none 时不该带这个字段');
  // 不带档位的请求体必须是合法的：传空串而非删键，会被部分网关判成非法取值
  assert.strictEqual(seen[1].body.model, 'm');
});

test('translateBatch：超时按传入毫秒生效，不落到默认值', async () => {
  // 服务器接了连接就不说话，模拟「网关卡住」。用 600ms 验证 cfg.timeout 真的传到了请求上：
  // 若没生效，兜底的 20 秒会让这条用例跑满 20 秒，CI 上立刻能看出不对。
  // 这条正是「开了高思考强度却没放大超时」那个坑的护栏。
  const t = Date.now();
  await withFakeAI(
    () => {
      /* 故意不响应 */
    },
    async (base) => {
      await assert.rejects(
        () =>
          dictAuto.translateBatch([{ text: 'Open Repository', source: 'ui/x.tsx' }], {
            base, key: 'k', model: 'm', effort: 'low', timeout: 600, examples: [],
          }),
        /超时/
      );
    }
  );
  assert.ok(Date.now() - t < 5000, '不该退化成默认的 20 秒');
});
