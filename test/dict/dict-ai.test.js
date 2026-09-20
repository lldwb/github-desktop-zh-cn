// AI 翻译协议适配（scripts/dict/dict-ai.js）单测：译文校验、请求参数、「无需翻译」分流与失败原因。
//
// 从 dict-auto.test.js 拆出：只测已迁到 dict-ai.js 的函数，用例与断言逐字保留（仅符号前缀由
// dictAuto 改为 dictAi）。真正联网调翻译服务的那几段仍由 CI 的定时任务在真实产物上跑；这里的
// translateBatch 用例只对着本地回环的假 chat/completions，锁定「参数有没有按约定进请求体」。

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const dictAi = require('../../scripts/dict/dict-ai');

// ============================ 译文校验 ============================

test('placeholdersOf：抽出花括号占位符并排序，忽略出现顺序', () => {
  const a = dictAi.placeholdersOf('Open {{count}} of {total} in ${name}');
  const b = dictAi.placeholdersOf('${name} 里的 {total} 项，共 {{count}} 项');
  assert.strictEqual(a, b);
  assert.strictEqual(dictAi.placeholdersOf('没有占位符'), '');
});

test('rejectReason：占位符不一致的译文被拒', () => {
  assert.strictEqual(dictAi.rejectReason('{{count}} files', '{{count}} 个文件'), null);
  assert.ok(dictAi.rejectReason('{{count}} files', '个文件'), '少了占位符应被拒');
  assert.ok(dictAi.rejectReason('{{count}} files', '{{count}} {{total}} 个文件'), '多了占位符应被拒');
});

test('rejectReason：没有中文的译文被拒（域名、路径等无需翻译的例外另说）', () => {
  assert.ok(dictAi.rejectReason('Open Repository', 'Open Repository'));
  assert.ok(dictAi.rejectReason('Open Repository', '   '), '空译文应被拒');
  assert.strictEqual(dictAi.rejectReason('Open Repository', '打开仓库'), null);
});

test('rejectReason：逗号与星号等非花括号符号不当占位符', () => {
  // 只在花括号与 ${} 上校验；把 %, * 也算进去会误杀大量正常译文
  assert.strictEqual(dictAi.rejectReason('Open %s now', '立即打开 %s'), null);
  assert.strictEqual(dictAi.rejectReason('*.md 文件', 'Markdown 文件'), null);
});

// ============================ AI 请求参数与「无需翻译」分流 ============================

test('resolveTimeout：秒转毫秒，未给则用默认值', () => {
  assert.strictEqual(dictAi.resolveTimeout('1200'), 1200000);
  assert.strictEqual(dictAi.resolveTimeout(60), 60000);
  // 环境变量为空串（没设）与 undefined 是同一件事：用默认
  assert.strictEqual(dictAi.resolveTimeout(''), dictAi.AI_TIMEOUT);
  assert.strictEqual(dictAi.resolveTimeout(undefined), dictAi.AI_TIMEOUT);
});

test('resolveTimeout：非法值报错，不静默退回默认', () => {
  // 静默退回的症状是「每批都超时，但日志里明明写着设了 1200 秒」——比直接失败难查得多
  for (const bad of ['abc', '0', '-5', 'NaN']) {
    assert.throws(() => dictAi.resolveTimeout(bad), /正数秒/, `${bad} 应被拒`);
  }
});

test('resolveEffort：默认取最低档，none 表示不带该字段', () => {
  // 批量翻译界面短句用不上深度推理：最低档的思考量约为最高档的 1/6，耗时差一个数量级
  assert.strictEqual(dictAi.resolveEffort(undefined), dictAi.AI_EFFORT);
  assert.strictEqual(dictAi.resolveEffort(null), dictAi.AI_EFFORT);
  assert.strictEqual(dictAi.AI_EFFORT, 'low');
  // 取值原样透传、不校验：网关认哪些档位由它自己说了算
  assert.strictEqual(dictAi.resolveEffort('max'), 'max');
  assert.strictEqual(dictAi.resolveEffort('  high  '), 'high', '两侧空白剥掉');
  // none 是逃生口：网关对不认识的档位直接报错时，退回接口自己的默认档（空串 = 不带该字段）
  assert.strictEqual(dictAi.resolveEffort('none'), '');
  // 只认小写 none——取值原样透传，网关若真认 NONE 就该照样传过去
  assert.strictEqual(dictAi.resolveEffort('NONE'), 'NONE');
});

test('isEcho：AI 原样返回判为无需翻译', () => {
  // 实测 3.6.7 新增候选里 10/22 是这类：域名、品牌名、仓库路径。SYSTEM_PROMPT 第 7 条
  // 要求的正是原样返回，判成「未译」会让整个版本因超门槛而产不出来（实测踩到过）
  for (const t of ['github.com', 'GitHub Desktop', 'GitHub Enterprise', 'anthropic', 'hubot/cool-repo', '.gitignore']) {
    assert.ok(dictAi.isEcho(t, t), `${t} 原样返回应判为无需翻译`);
  }
  // 产物里同一条文案常带前导空格（JSX 片段），AI 返回时去掉了——不该因此算失败
  assert.ok(dictAi.isEcho(' GitHub.com', 'GitHub.com'));
});

test('isEcho：译文不同、为空或非字符串时都不算原样返回', () => {
  assert.ok(!dictAi.isEcho('Open Repository', '打开仓库'));
  assert.ok(!dictAi.isEcho('Open Repository', ''));
  assert.ok(!dictAi.isEcho('Open Repository', undefined), 'AI 漏回这条 → 走重试，不能当成功');
  // 大小写不同的「返回」不是原样返回：官方文案的书写变体多数是内容变化，得由校验判
  assert.ok(!dictAi.isEcho('GitHub desktop', 'GitHub Desktop'));
});

// ============================ AI 配置校验与失败原因 ============================

test('assertBaseUrl：合法地址放行', () => {
  assert.strictEqual(dictAi.assertBaseUrl('https://gw.example.com/v1').host, 'gw.example.com');
  assert.strictEqual(dictAi.assertBaseUrl('http://127.0.0.1:8080').protocol, 'http:');
});

test('assertBaseUrl：拼错的地址报可操作的错，且不回显地址本身', () => {
  // 这几种是复制粘贴配置时最常见的三种错法。它们的症状原本是「每条文案都失败一遍、
  // 最后以未译 100% 收场」——报错只写 Invalid URL，看不出该去查哪个配置
  for (const bad of ['gw.example.com/v1', '"https://gw.example.com"', 'https://gw.example.com /v1']) {
    assert.throws(
      () => dictAi.assertBaseUrl(bad),
      (e) => /AI_BASE_URL/.test(e.message) && !e.message.includes(bad),
      `${bad} 应被拦下，且报错里不能带出地址值（AI_BASE_URL 是 Secret，注解与日志公开可见）`
    );
  }
  // 协议不对的情况给出实际协议，便于判断是漏了前缀还是写成了别的协议
  assert.throws(() => dictAi.assertBaseUrl('ftp://gw.example.com'), /ftp/);
});

test('assertBaseUrl：藏在地址里的不可见字符也拦下（它们不报错，只会静默 404）', () => {
  // 尾随不换行空格 / 零宽空格这类字符 new URL() 照收，只是被百分号编码进路径（/v1%C2%A0），
  // 请求打到别的地址上罢了——不抛错、肉眼更看不出差别，比 Invalid URL 还难查，所以一并拦下。
  // 报错里给码点：字符本身看不见，不说出它是哪一个就没法照着改
  const nbsp = String.fromCodePoint(0x00a0);
  const zwsp = String.fromCodePoint(0x200b);
  for (const [bad, cp] of [
    [`https://gw.example.com/v1${nbsp}`, /U\+00A0/],
    [`https://gw.example.com/v1${zwsp}`, /U\+200B/],
    [`https://gw.example.com/${nbsp}v1`, /U\+00A0/],
    // 串内空格同样拦下：它会被百分号编码进路径（/v1%20/x），请求打在别的地址上
    ['https://gw.example.com/v1 /x', /U\+0020/],
  ]) {
    assert.throws(
      () => dictAi.assertBaseUrl(bad),
      (e) => cp.test(e.message) && !e.message.includes(bad),
      `含不可见字符的地址应被拦下：${JSON.stringify(bad)}`
    );
  }
  // 首尾的半角空格与 Tab 是 URL 标准自己会去掉的，照旧放行（只提示日志脱敏可能失效）。
  // 这条提示要断言，但不能让它直接打到 stdout：`::warning::` 是工作流命令，CI 日志里会读成
  // 「AI_BASE_URL 配错了」——那只是本用例的假地址，且默认 reporter 把它当注释原样带进日志，
  // 换 reporter 时更会被 GitHub 当成一条真注解。截下来断言，日志里就干净了。
  const warns = [];
  const origWarn = console.warn;
  console.warn = (m) => warns.push(m);
  try {
    assert.strictEqual(dictAi.assertBaseUrl('  https://gw.example.com/v1\t').host, 'gw.example.com');
  } finally {
    console.warn = origWarn;
  }
  assert.strictEqual(warns.length, 1, '应提示一次');
  assert.match(warns[0], /^::warning::AI_BASE_URL 首尾有空白字符/);
  // 串内的制表符 / 换行也一样：标准会把它们从整串里删掉（粘贴时折行很常见），拦下来是误伤
  assert.strictEqual(dictAi.assertBaseUrl('https://gw.exam\nple.com/v1').host, 'gw.example.com');
  // 汉字域名、路径里的中文属字母类，不受这条判据影响（域名会按 IDNA 转成 punycode）
  assert.strictEqual(dictAi.assertBaseUrl('https://网关.example.com/接口').protocol, 'https:');
});

test('redact：抹掉服务地址与密钥，短串不误伤', () => {
  const base = 'https://gw.example.com/v1';
  const key = 'sk-1234567890abcdef';
  // net.js 的报错大多以「……：<URL 或主机名>」收尾，直接进注解就等于把地址公开
  assert.strictEqual(
    dictAi.redact(`请求超时（120 秒无响应）：${base}/chat/completions`, [base, key]),
    '请求超时（120 秒无响应）：***/chat/completions'
  );
  assert.strictEqual(dictAi.redact(`HTTP 401：${key} 无效`, [base, key]), 'HTTP 401：*** 无效');
  // net.js 的网络层报错只带主机名（「连接被拒绝（可能被防火墙拦截）：主机:端口」），拿完整地址
  // 当 needle 匹配不上——所以调用处要把 host 也放进 needle，这条用例把这个前提钉住
  const host = new URL(base).host;
  const refused = `连接被拒绝（可能被防火墙拦截）：${host}`;
  assert.strictEqual(dictAi.redact(refused, [base, key]), refused);
  assert.strictEqual(dictAi.redact(refused, [base, host, key]), '连接被拒绝（可能被防火墙拦截）：***');
  // 太短的值不替换：它在正常文本里误伤的概率大于它是真凭据的概率
  assert.strictEqual(dictAi.redact('模型 deepseek-v4 不可用', ['deep', base]), '模型 deepseek-v4 不可用');
});

test('collapseReasons：同因合并计数、多的在前、只留前几条', () => {
  const rows = [
    { reason: 'Invalid URL' }, { reason: 'Invalid URL' }, { reason: 'Invalid URL' },
    { reason: '译文为空' }, { reason: '译文为空' },
    { reason: '占位符不一致（原文 {{count}}，译文 无）' },
    { reason: '译文里没有中文："Hello"' },
    { reason: '模型未返回 JSON：{}' },
  ];
  const s = dictAi.collapseReasons(rows, []);
  // 门槛只报「未译 7 条」时看不出主因是哪一类；条数排序让主因排在最前
  assert.ok(s.startsWith('Invalid URL ×3；译文为空 ×2；'), s);
  assert.strictEqual(s.split('；').length, 3, '默认只留 3 类');
  assert.strictEqual(dictAi.collapseReasons(rows, [], 5).split('；').length, 5);
  // 多行 / 超长的原因要压成一行：它最终会进注解与 step summary，换行会把汇总截断
  assert.strictEqual(dictAi.collapseReasons([{ reason: 'HTTP 500：\n 第一行\n第二行' }], []), 'HTTP 500： 第一行 第二行');
  assert.ok(dictAi.collapseReasons([{ reason: 'x'.repeat(300) }], []).length <= 161);
});

test('failureText：有原因明细时结论后面跟上它', () => {
  assert.strictEqual(dictAi.failureText({ reason: '未译 11/11 条（100%）超过上限 30%' }), '未译 11/11 条（100%）超过上限 30%');
  assert.strictEqual(
    dictAi.failureText({ reason: '未译 11/11 条（100%）超过上限 30%', reasonDetail: 'Invalid URL ×11' }),
    '未译 11/11 条（100%）超过上限 30%——Invalid URL ×11'
  );
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
      const out = await dictAi.translateBatch(items, { ...fixed, effort: dictAi.resolveEffort(undefined) });
      assert.strictEqual(out['1'], '打开仓库');
      // none 是逃生口：网关不认档位时要能退回「不带这个字段」
      await dictAi.translateBatch(items, { ...fixed, effort: dictAi.resolveEffort('none') });
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
          dictAi.translateBatch([{ text: 'Open Repository', source: 'ui/x.tsx' }], {
            base, key: 'k', model: 'm', effort: 'low', timeout: 600, examples: [],
          }),
        /超时/
      );
    }
  );
  assert.ok(Date.now() - t < 5000, '不该退化成默认的 20 秒');
});
