// dict-ai.js — AI 翻译协议适配（OpenAI 兼容的 chat/completions）
//
// 从 dict-auto.js 拆出的一层：只做「把待译条目交给模型、校验它返回的译文」，不认识字典、
// 产物与分组，故与字典领域零耦合。CI 定时任务与人肉回填都经 dict-auto.js 走这条链路。
//
// 【引用约束】本文件只由 dict-auto.js 以**字面量** require 引入（bundle.js 靠静态扫描收集
// 依赖，改成动态拼接就收不到）；一对一，别的模块不要引它。
//
// 【提示词出处】SYSTEM_PROMPT 的唯一来源仍是 dict-prompt.js——GUI 的「翻译提示词」标签页
// 要原样展示它，别把它内联回本文件。

'use strict';

const net = require('../net');
const { SYSTEM_PROMPT } = require('./dict-prompt');

// 一次请求翻译多少条。太小则请求数暴涨（AI 接口的往返延迟是大头），太大则单次失败
// 连坐的条目多、且模型注意力分散后更容易漏占位符。
const BATCH_SIZE = 20;
// 默认的思考强度。批量翻译界面短句用不上深度推理，取最低档即可——实测这一档的思考量约为
// 最高档的 1/6（1847 vs 11979 思考 tokens），档位越高耗时涨得越快。想开高思考强度用
// AI_REASONING_EFFORT（或 --ai-effort），并同步放大下面的超时。
const AI_EFFORT = 'low';
// 单次请求的超时。翻译一批几十秒很正常，用 net.js 默认的 20 秒会必然超时。
//
// 这是**默认值**，可用 AI_TIMEOUT_SEC 环境变量（或 --ai-timeout）覆盖：推理模型的耗时随思考
// 强度非线性增长——实测 deepseek-v4-flash 回答一个简单问题，不传思考强度时 10 秒 / 思考
// 0.5k tokens，最高档 97 秒 / 思考 12k tokens（约 23 倍）。要开高思考强度就必须同步放大这个值。
const AI_TIMEOUT = 120000;
// 逐条重试之间的间隔，避免失败时把接口打爆
const RETRY_DELAY = 500;

// 汉字判据：译文里一个都没有，说明它压根没被翻译（AI 原样返回了英文、或返回了别的拉丁文）
const CJK = /[㐀-䶿一-鿿豈-﫿]/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================ AI 翻译 ============================

// --ai-timeout / AI_TIMEOUT_SEC 的解析：秒 → 毫秒。给了非法值就报错，不静默退回默认——
// 「以为设成了 1200 秒、实际还是 120 秒」的症状是每批都超时，从日志里看不出原因。
function resolveTimeout(spec, fallback = AI_TIMEOUT) {
  if (spec === undefined || spec === null || spec === '') return fallback;
  const sec = Number(spec);
  if (!Number.isFinite(sec) || sec <= 0) {
    throw new Error(`AI 超时得是正数秒，收到 ${JSON.stringify(spec)}`);
  }
  return Math.round(sec * 1000);
}

// --ai-effort / AI_REASONING_EFFORT 的解析：没给就用默认档，显式给 none 表示**不带这个字段**。
// 留这个逃生口是因为取值原样透传、不校验——有的网关对不认识的档位直接报错，那时得能退回
// 接口自己的默认档（而不是被迫去猜一个它认的值）。
function resolveEffort(spec) {
  const v = String(spec ?? AI_EFFORT).trim();
  return v === 'none' ? '' : v;
}

// 地址不合法时，每次请求都会在 net.js 的 `new URL()` 上抛 "Invalid URL"：两批 + 逐条重试
// 会把这个同一个错误重复几十遍，日志里只留下满屏重复、看不出该去查哪个配置。在这里一次拦住，
// 并直接说出该怎么改。**不回显地址本身**——AI_BASE_URL 是私密配置，而注解与 step summary
// 在公开仓库上人人可见（日志里它会被 GitHub 脱敏成 ***，别指望别处也有这层）。
function assertBaseUrl(base) {
  // 常见错法的清单取自实测：这几种都让 `new URL()` 抛 Invalid URL（与 CI 那次一模一样），
  // 而它们看起来都「挺像个地址」，不逐条列出来很难自己想到
  const hint =
    '需要形如 http://主机:端口/路径 的绝对地址。逐项核对：' +
    '① 开头就是 http:// 或 https://，没有引号、方括号、Markdown 链接的残留；' +
    '② 冒号是半角 : 而不是全角 ：；' +
    '③ 地址内部没有空格、换行（首尾的半角空格 / Tab / 换行会被自动去掉，内部的不行）';
  // 不可见字符要先查：URL 标准会把制表符与换行从整串里删掉、再去掉首尾的控制符与半角空格，而其余
  // 不可见字符（不换行空格、零宽空格、BOM、串内空格……）不是被百分号编码进路径就是让解析直接失败
  // ——前者请求打到 /v1%C2%A0 上静默 404，不报错、肉眼也看不出哪里不同，比 Invalid URL 更难查。
  // 所以这里先按标准做一遍同样的删除（否则会把「换行只是粘贴时折了行」这种其实可用的值误拦），
  // 剩下的值里再出现不可见字符就是必然打错的配置。（判据只覆盖空白与格式类字符，中文域名、路径
  // 里的汉字是字母类，不受影响）
  const stripped = base.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+|[\u0000- ]+$/g, '');
  const invisible = stripped.match(/[\p{C}\p{Z}]/u);
  if (invisible) {
    const cp = `U+${invisible[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
    throw new Error(
      `AI_BASE_URL 里有不可见字符 ${cp}（抹掉它就能发请求）：${hint}。` +
        '这一位多半是粘贴时带进来的，回 Secrets 页清空、重新粘一次即可。'
    );
  }
  let u;
  try {
    u = new URL(base);
  } catch {
    throw new Error(`AI_BASE_URL 不是合法 URL：${hint}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`AI_BASE_URL 的协议是 ${u.protocol.replace(':', '')}，只支持 http / https`);
  }
  // 地址本身合法、但它与打印出来的值对不上时，GitHub 就脱敏不了日志里的那一行（它按 secret 的
  // 完整值做子串匹配）。这里只提示、不失败——尾随空格这类差异完全不影响请求能不能发出去，
  // 为此拦下整轮产出不值当。去不去掉由使用者定，提示只是让「地址会不会被公开」这件事可见。
  if (base !== base.trim()) {
    console.warn('::warning::AI_BASE_URL 首尾有空白字符：地址本身可用（已自动按去空白后的值发请求），但 GitHub 的日志脱敏按 secret 的完整值匹配，日志里那一行可能不被打成 ***。到 Secrets 页删掉首尾空白即可。');
  }
  return u;
}

// 系统提示词在 dict-prompt.js：GUI 的「翻译提示词」标签页要原样展示它，两处同源，别内联回本文件。

const PLACEHOLDER = /\{\{[^{}]*\}\}|\{[^{}]*\}|\$\{[^{}]*\}/g;
const placeholdersOf = (s) => (s.match(PLACEHOLDER) || []).sort().join(' ');

// 译文的横向校验。拦两类会真正改坏界面的问题：占位符缺失或多出、以及返回了内容却没有一个汉字。
// 「AI 原样返回」不归这里判——那是合法结论，由 isEcho 分流（见下）。
function rejectReason(src, zh) {
  if (typeof zh !== 'string' || !zh.trim()) return '译文为空';
  const want = placeholdersOf(src);
  const got = placeholdersOf(zh);
  if (want !== got) {
    return `占位符不一致（原文 ${want || '无'}，译文 ${got || '无'}）`;
  }
  if (!CJK.test(zh)) return `译文里没有中文：${JSON.stringify(zh)}`;
  return null;
}

// 「AI 原样返回」＝它判定这条无需翻译，而不是它没干活。候选里混着域名（github.com）、
// 仓库路径（hubot/cool-repo）、品牌名（GitHub Desktop、Anthropic），SYSTEM_PROMPT 第 7 条
// 正是要求这类原样返回。**这类条目不写进字典**：写了就是「原文 → 原文」，没有替换效果，
// 还会让 validate 一直提示「疑似漏译」。
//
// 代价是它们每个版本都会作为新增候选重新问一次 AI（多花几条 tokens）。不为此另建持久清单——
// 那要往字典里加一个新段与一套读写的迁移，收益只是省几条 tokens。
//
// 与「AI 偷懒把该译的也原样返回」在数据上区分不了，故：这些条目全部记进报告的 echoedRows，
// 数量与清单在日志和 CI 汇总里可见；干跑命中率与人工抽查是它剩下的防线。
function isEcho(src, zh) {
  return typeof zh === 'string' && zh.trim() === src.trim();
}

// 从历史字典抽风格示例。刻意挑含 & / 占位符 / 末尾省略号的条目——AI 最容易在这三类上走样，
// 给例子比在提示词里描述有效。
function buildExamples(table) {
  const entries = [...table.entries()].filter(([k, v]) => k !== v);
  const pick = (re, n) => entries.filter(([k]) => re.test(k)).slice(0, n);
  const chosen = [];
  const seen = new Set();
  for (const [k, v] of [
    ...pick(/&/, 4),
    ...pick(/\{\{/, 3),
    ...pick(/…$/, 3),
    ...entries.slice(0, 6),
  ]) {
    if (seen.has(k)) continue;
    seen.add(k);
    chosen.push([k, v]);
  }
  return chosen;
}

// 请求一批译文。响应体是 OpenAI 兼容的 chat/completions 结构。
async function translateBatch(items, cfg) {
  const body = {
    model: cfg.model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          '【既有译文的风格示例】',
          ...cfg.examples.map(([en, zh]) => `${en} → ${zh}`),
          '',
          '【待翻译】',
          JSON.stringify(items.map((it, i) => ({ id: String(i + 1), text: it.text, from: it.source }))),
        ].join('\n'),
      },
    ],
  };
  // 只在明确给了档位时才带上：不传即接口默认，传空串会被部分网关判成非法取值
  if (cfg.effort) body.reasoning_effort = cfg.effort;
  const { status, data } = await net.postJson(`${cfg.base}/chat/completions`, body, {
    timeout: cfg.timeout,
    headers: { authorization: `Bearer ${cfg.key}` },
  });
  if (status < 200 || status >= 300) {
    const detail =
      (data && data.error && (data.error.message || data.error.code)) || JSON.stringify(data).slice(0, 200);
    throw new Error(`HTTP ${status}：${detail}`);
  }
  const text =
    data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof text !== 'string') throw new Error(`响应结构不认识：${JSON.stringify(data).slice(0, 200)}`);

  // 有的实现会把 JSON 包在代码块里或前后带一句解释，截取最外层的花括号再解析
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`模型未返回 JSON：${text.slice(0, 120)}`);
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`模型返回的不是合法 JSON（${e.message}）：${text.slice(start, start + 120)}`);
  }
}

// 翻一批，逐条校验；原样返回的收进 echoed，其余不通过的收回重试队列
async function attempt(items, cfg) {
  const raw = await translateBatch(items, cfg);
  const done = new Map();
  const echoed = [];
  const retry = [];
  for (const [i, item] of items.entries()) {
    const zh = raw[String(i + 1)];
    if (isEcho(item.text, zh)) {
      echoed.push(item);
      continue;
    }
    const bad = rejectReason(item.text, zh);
    if (bad) retry.push({ ...item, reason: bad });
    else done.set(item, zh);
  }
  return { done, retry, echoed };
}

// 批量翻译 + 失败逐条重试。返回 { done, failed, echoed }。
// 批次整体失败（网络、鉴权、模型没按格式回）时降级为逐条——一条坏输出不该连坐同批另外十九条。
async function translateAll(candidates, cfg, log) {
  const done = new Map();
  const echoed = [];
  const failed = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    let r;
    try {
      r = await attempt(batch, cfg);
    } catch (e) {
      log(`  第 ${i / BATCH_SIZE + 1} 批（${batch.length} 条）失败：${e.message}——改为逐条重试`);
      r = { done: new Map(), retry: batch.map((it) => ({ ...it, reason: e.message })), echoed: [] };
    }
    for (const [item, zh] of r.done) done.set(item, zh);
    echoed.push(...r.echoed);

    let restored = 0;
    let retryEchoed = 0;
    for (const item of r.retry) {
      await sleep(RETRY_DELAY);
      try {
        const one = await attempt([item], cfg);
        // 单条重问时被判无需翻译——重试路径也得认这个结论，否则它会一直失败下去
        if (one.echoed.length) {
          echoed.push(item);
          retryEchoed++;
          continue;
        }
        const hit = [...one.done][0];
        if (hit) {
          done.set(item, hit[1]);
          restored++;
          continue;
        }
        item.reason = (one.retry[0] && one.retry[0].reason) || item.reason;
      } catch (e) {
        item.reason = e.message;
      }
      failed.push(item);
    }
    if (r.retry.length) {
      log(
        `  逐条重试 ${r.retry.length} 条：补回 ${restored} 条，判为无需翻译 ${retryEchoed} 条，` +
          `仍失败 ${r.retry.length - restored - retryEchoed} 条`
      );
    }
  }
  return { done, failed, echoed };
}

// 失败原因常把接口地址原样带出来：net.js 的报错大多以「……：<URL 或主机名>」收尾
// （HTTP 401、请求超时、连接被拒绝都如此）。这些文本要写进注解、step summary 与提交信息，
// 公开仓库上人人可见，所以进任何对外文本之前先替换掉。太短的值不参与替换——它在正常文本里
// 误伤的概率大于它是真凭据的概率。
function redact(text, secrets) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (s && s.length >= 8 && out.includes(s)) out = out.split(s).join('***');
  }
  return out;
}

// 把「为什么全都没译出来」压成一行：同因合并计数、按条数排序、只留前几条。
// 门槛只报「未译 11/11 条（100%）」时，看的人不知道是地址错、鉴权错还是模型不听话——
// 而这三种的处理方式完全不同，所以原因必须跟结论一起出现。
function collapseReasons(rows, secrets, limit = 3) {
  const merged = new Map();
  for (const r of rows) {
    const text = redact(r.reason || '（无原因）', secrets).replace(/\s+/g, ' ');
    const key = text.length > 160 ? `${text.slice(0, 160)}…` : text;
    merged.set(key, (merged.get(key) || 0) + 1);
  }
  return [...merged]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([text, n]) => (n > 1 ? `${text} ×${n}` : text))
    .join('；');
}

// 失败条目的统一文案：结论 + 原因明细。只报「未译 11/11 条（100%）超过上限 30%」时，
// 看的人不知道是地址错、鉴权错还是模型不听话——三种的处理方式完全不同。
const failureText = (r) => (r.reasonDetail ? `${r.reason}——${r.reasonDetail}` : r.reason);

module.exports = {
  resolveTimeout, resolveEffort, assertBaseUrl, placeholdersOf, rejectReason, isEcho,
  buildExamples, translateBatch, translateAll, redact, collapseReasons, failureText,
  AI_EFFORT, AI_TIMEOUT,
};
