// dict-auto.js — 按官方新版本产物自动产出字典（CI 定时任务与人肉回填共用同一条链路）
//
//   官方发新版本 → 取两平台产物 → 以历史字典为锚核对每条键在新产物里的形态
//     → 官方新增的界面文案走 AI 翻译 → dict-edit 事务写入 → 组名推断
//       → 干跑校验（替换 + 语法 + 生效比例）→ 出报告
//
// 为什么是「产物驱动」而不是「源码驱动」：字典的键就是产物里的字面量（patch.js 做的是产物
// 字符串替换），「新版本还该保留哪些键」这个问题的答案只能在产物里找。
//
// 【候选口径】这是本文件最要紧的取舍。产物里能提取出的字面量有近 2000 条，但「是不是界面文案」
// 在静态层面无从判断——实测 3.6.6 的 macOS 产物：字面量侧 1714 条候选里有 1138 条是枚举值
// （`Canceled`）、事件名（`PageDown`）、注册表配置（`VSCodium`）、URL 片段（`/graphql`）、
// 第三方包标识符这类东西，与真文案形态上无从区分。把 `/graphql` 写进字典翻成中文，
// 替换下去就是当场改坏 API 调用。故：
//
//   ① 继承：以历史字典的键为锚。它们是人审过的界面文案，逐条查在新产物里还存不存在
//      （不存在的就是官方删了，丢弃）。这是字典的主体，也是零风险的。
//   ② 新增：只取「源码 JSX 文本节点里有、产物里也有」的候选（scan.collectCandidates 的
//      jsx 标记）。同口径下 3.6.6 的 150 条里 130 条命中既有字典，准确率与字面量侧天差地别。
//   ③ 字面量侧新增一律不自动收录——真文案会被淹没在噪声里。它们照旧出现在 scan 的候选
//      报告里由人工判断，这是第 3 章就在跑的既有流程。
//
// 【平台分段】只有「macOS 产物独有」的进 macos 段，其余一律进 common。
// 不把「Windows 独有」的分出去，是因为没有 Linux 产物可查，而 Linux 版走的是与 Windows 相同的
// 非 darwin 分支（助记符 & 与 sentence case 都在）——分出去会让 Linux 用户平白少一批条目。
// 反过来 macOS 独有的（无 & 的 label、Title Case）在其它平台本就不存在，分出去功能等价且语义正确。
// 一句话：宁可多收（放 common，最多多一条永不命中的键），不可漏收。
'use strict';

const fs = require('fs');
const path = require('path');
const common = require('../common');
const dictEdit = require('./dict-edit');
const dictGroups = require('./dict-groups');
const releaseAssets = require('./release-assets');
const scan = require('../cmd/scan');
const net = require('../net');

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

// 生效比例下限：字典条目里至少这么多条能在产物上真正替换到。
// 每一条键都是「确认过在新产物里存在」才写进去的，理应条条命中；低于阈值说明写入链路出了问题。
const MIN_HIT_RATE = 0.95;
// 未译比例上限（相对新增条目）。超过说明 AI 链路本身出了问题，不是个别条目译不出来。
const MAX_UNTRANSLATED_RATE = 0.3;

const PLATFORMS = ['windows', 'macos'];
const TARGETS = ['main.js', 'renderer.js'];
// 最低候选长度，与 scan.js 的默认值一致
const MIN_LENGTH = 8;

// 已有字典时怎么办：
//   skip（默认）——跳过。定时任务靠它保持幂等：每日跑一次不会重跑已产出的版本、白烧 tokens；
//   diff        ——照常产出但**不写盘**，把产出与磁盘上那份逐键比一遍报差异（纯只读，零风险）；
//   overwrite   ——产出后整体覆盖。失败时恢复原内容而非删除，否则「覆盖」会把原有的那份一起弄丢。
const ON_EXIST = 'skip';
const ON_EXIST_MODES = ['skip', 'diff', 'overwrite'];

// diff 报告里每类差异最多留多少条明细。差异通常只有几十条，上限防的是「换了继承来源」这类
// 整体性变化——那时报告 JSON 会被几千条明细撑大，而人真正要看的是总数与分布。
const DIFF_LIMIT = 500;
// 汉字判据：译文里一个都没有，说明它压根没被翻译（AI 原样返回了英文、或返回了别的拉丁文）
const CJK = /[㐀-䶿一-鿿豈-﫿]/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================ 参数 ============================

function parseArgs(argv) {
  const args = {
    version: null, arch: 'x64', work: null, report: null,
    dryRun: false, noAi: false, reuse: false, onExist: ON_EXIST,
    aiBase: null, aiKey: null, aiModel: null, aiEffort: null, aiTimeout: null, token: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version') args.version = argv[++i];
    else if (a === '--arch') args.arch = argv[++i];
    else if (a === '--work') args.work = argv[++i];
    else if (a === '--report') args.report = argv[++i];
    else if (a === '--on-exist') args.onExist = argv[++i];
    else if (a === '--ai-base') args.aiBase = argv[++i];
    else if (a === '--ai-key') args.aiKey = argv[++i];
    else if (a === '--ai-model') args.aiModel = argv[++i];
    else if (a === '--ai-effort') args.aiEffort = argv[++i];
    else if (a === '--ai-timeout') args.aiTimeout = argv[++i];
    else if (a === '--token') args.token = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-ai') args.noAi = true;
    else if (a === '--reuse') args.reuse = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`未知参数：${a}（--help 查看用法）`);
  }
  if (!ON_EXIST_MODES.includes(args.onExist)) {
    throw new Error(`--on-exist 取值非法：${args.onExist}（可用：${ON_EXIST_MODES.join(' / ')}）`);
  }
  return args;
}

function printHelp() {
  console.log(`用法：node scripts/dict/dict-auto.js [选项]

按官方产物自动产出字典：取两平台产物 → 以历史字典为锚核对每条键在新产物里的形态 →
官方新增的界面文案走 AI 翻译 → 经 dict-edit 事务写入 → 推断组名 → 干跑校验。

版本已有字典默认跳过（幂等）；传多个版本按升序逐个产出，前一个正好是后一个的继承来源。
要重跑一个已有字典的版本，用 --on-exist 显式说明意图。

选项：
  --version <版本>   官方版本号，逗号分隔可传多个（默认取官方最新正式版）
  --arch <架构>      取哪个架构的产物（默认 x64；同版本各架构的文案相同）
  --work <目录>      产物与中间文件目录（默认 tmp/release）
  --report <文件>    把统计写成 JSON（CI 据此拼提交信息与判断是否继续）
  --on-exist <模式>  已有字典时怎么办（默认 skip）：
                       skip      跳过——定时任务靠它保持幂等，不会重跑已产出的版本
                       diff      照常产出但不写盘，与磁盘上那份逐键对比后报差异。只读操作，
                                 跑完磁盘毫无变化。照常调 AI：跳过的话新增候选会全变成
                                 「未译」而被剔除，对比结果里将尽是并不存在的「删除」
                       overwrite 产出后整体覆盖；失败则恢复原内容，不会把旧的弄丢
  --dry-run          算完就停，不写字典（本地验证用）
  --no-ai            只继承不翻译（缺译文的新增条目记为未译）
  --reuse            复用 --work 下已提取的产物，不重新下载
  --ai-base <URL>    OpenAI 兼容接口的 base url（默认取环境变量 AI_BASE_URL）
  --ai-key <密钥>    接口密钥（默认取 AI_API_KEY）
  --ai-model <模型>  模型名（默认取 AI_MODEL）
  --ai-effort <档位> 思考强度（reasoning_effort，如 low / medium / high / max；默认 low，
                     给 none 表示不带该字段、用接口自己的默认档）
  --ai-timeout <秒>  单次请求超时秒数（默认 120；高思考强度要放大，见下方说明）
  --token <令牌>     GitHub API 令牌，仅用于提高取版本号时的速率上限
  -h, --help         显示本帮助

环境变量：AI_BASE_URL / AI_API_KEY / AI_MODEL / AI_REASONING_EFFORT / AI_TIMEOUT_SEC
提供默认值，命令行参数优先。

思考强度：默认 low——批量翻译界面短句用不上深度推理，最低档的思考量约为最高档的 1/6
（实测 deepseek-v4-flash 回答同一个简单问题：low 1847、high 6526、max 11979 思考 tokens），
而耗时涨得更快（同一问题：不传该字段 10 秒，max 档 97 秒）。开高思考强度时务必同步放大
--ai-timeout，否则每批都会超时并退化成逐条重试（更慢、请求数还翻倍）。
取值原样透传给接口、不校验——不同网关认的档位不同，服务端不认识的会被忽略或报错，
真遇到报错时用 none 退回接口自己的默认档。`);
}

// ============================ 目标版本 ============================

// 解析要产出的版本列表。回填时按升序——前一个产出的字典正好是后一个的继承来源，
// 顺序反了会让本该继承到的译文全部走 AI 重译一遍。
async function resolveVersions(spec, token) {
  if (!spec) {
    const r = await releaseAssets.latestVersion({ token });
    console.log(`官方最新正式版：${r.version}（${r.publishedAt || '未知发布时间'}）`);
    return [r.version];
  }
  const list = spec.split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new Error('--version 没给出有效版本号');
  return list.sort(common.compareVersions);
}

// ============================ 历史译文 ============================

// 「原样键 → 译文」的历史表，供继承用。版本降序合并、同键先见者胜：新版本的译文优先。
// 坏字典跳过而不报错——它自己的 validate 会报出来，不该拦住新版本的产出。
function inheritTable(exclude) {
  const table = new Map();
  const versions = common.listDictVersions().filter((v) => !exclude.includes(v));
  for (const v of [...versions].reverse()) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(common.dictFile(v), 'utf8'));
    } catch {
      continue;
    }
    for (const seg of common.SEGMENT_NAMES) {
      for (const [k, zh] of Object.entries(raw[seg] || {})) {
        if (typeof zh === 'string' && zh && !table.has(k)) table.set(k, zh);
      }
    }
  }
  return { table, versions };
}

// ============================ 产物侧索引 ============================

// 产物里的字符串字面量索引。exact 是「字面量原文 → 它出现在哪几个产物文件」；
// lower 是「全小写形态 → 真实形态集合」，供「官方只改了大小写」的兜底。
// 整模板键（含反引号与 ${} 的整段）一并收录：patch 的替换就是按 l.content 整串匹配的。
function literalIndex(appDir) {
  const exact = new Map();
  const lower = new Map();
  for (const f of TARGETS) {
    const src = fs.readFileSync(path.join(appDir, f), 'utf8');
    for (const l of common.stringLiterals(src)) {
      const t = l.content;
      if (!exact.has(t)) {
        exact.set(t, new Set());
        const lk = t.toLowerCase();
        if (!lower.has(lk)) lower.set(lk, new Set());
        lower.get(lk).add(t);
      }
      exact.get(t).add(f);
    }
  }
  return { exact, lower };
}

// 某个字典键（可能是 `main.js|原文` 形式的作用域键）在本平台产物里的真实形态；不存在则 null。
// 先试精确形态，再退到「只差大小写」的形态——官方把 Copy file path 改成 Copy File Path
// 这类纯大小写微调很常见，不该让整条译文因此丢掉。作用域键只认它绑定的那个文件。
//
// 但「无空格且不足 8 字符」的单形态短键不做兜底。产物里这类形态的大小写变体几乎都是代码
// 标识符而非文案：实测 Windows 产物里 `cut`/`find`/`paste`/`redo` 是 Electron 菜单的 role 值
// （role:"cut"）、`install` 是 Git LFS 子命令参数（["lfs","install"]）、`options` 是属性描述符
// 键名（{key:"options"}）——照兜底会把这些词替换成 剪切/查找/粘贴/重做/安装/选项，破坏功能。
// 真正的形态漂移是多词文案（Copy file path → Copy File Path），含空格的键一律照旧兜底。
function resolveIn(idx, key) {
  const { file, key: bare } = common.splitScopedKey(key);
  const exact = idx.exact.get(bare);
  if (exact && (!file || exact.has(file))) return { text: bare, files: exact };
  if (!bare.includes(' ') && bare.length < 8) return null;
  const cands = idx.lower.get(bare.toLowerCase());
  if (cands) {
    // 排序后取首见，保证同输入必定同输出
    for (const t of [...cands].sort()) {
      const files = idx.exact.get(t);
      if (!file || files.has(file)) return { text: t, files };
    }
  }
  return null;
}

// ============================ 候选与分段 ============================

// 把历史字典的键与 JSX 新增候选，按「在本平台产物里的真实形态」归到各平台。
// 返回 { perPlatform, stats, pending }：
//   perPlatform[p] 是 Map<该平台的真实键（含作用域前缀）, { zh | null }>，zh 为 null 表示待译；
//   pending 是待译条目，每条自带它在哪些平台的哪个键上落地。
function buildCandidates({ indexes, history, jsxFound }) {
  const perPlatform = { windows: new Map(), macos: new Map() };
  const stats = { inherited: 0, dropped: 0, variant: 0, added: 0 };
  const pending = [];
  const dropped = [];

  // 同一个形态可能被多条历史键命中：macos 段的 `Open With…` 精确命中，而 common 段的
  // `Open with…` 只能兜底命中同一形态。精确命中必须压过兜底——字典维护者按实际形态逐条写入，
  // 与该形态逐字一致的那条键，译文才是为这个形态定制的（macOS 的「用其他应用打开…」比
  // common 的「打开方式…」更贴合该平台习惯）。没有这一条，先遍历到的 common 段会把它挤掉。
  const put = (p, key, entry, exact) => {
    const old = perPlatform[p].get(key);
    if (!old || (exact && !old.exact)) perPlatform[p].set(key, { ...entry, exact: !!exact });
  };

  // ① 历史字典的键：逐条核对在新产物里还在不在、形态变没变
  for (const [key, zh] of history) {
    const { file, key: bare } = common.splitScopedKey(key);
    let alive = false;
    for (const p of PLATFORMS) {
      const r = resolveIn(indexes[p], key);
      if (!r) continue;
      alive = true;
      if (r.text !== bare) stats.variant++;
      put(p, (file ? `${file}|` : '') + r.text, { zh }, r.text === bare);
    }
    if (alive) stats.inherited++;
    else {
      stats.dropped++;
      dropped.push(key);
    }
  }

  // ② JSX 文本节点：官方在元素里新写的显示文案。字面量侧的候选一律不收（理由见文件头）。
  // 同一个文本在两平台的形态可能不同（Title Case vs sentence case），按真实形态各立一条待译，
  // 译文分别贴合各平台的书写惯例。
  //
  // 只收「该形态还没有译文」的：候选的文本可能与某条历史键只差大小写，而那条形态早已由
  // ① 继承到了译文。这类不该进待译队列——既白花 tokens，更要紧的是 AI 的译文会覆盖掉人工
  // 审过的那一条（实测 3.6.7 的候选由 22 条降到 20 条，即拦下 2 条这类重复请求；那次译文
  // 恰好相同，才没显出问题）。
  const byForm = new Map();
  for (const [text, info] of jsxFound) {
    if (!info.jsx || history.has(text)) continue;
    for (const p of PLATFORMS) {
      const r = resolveIn(indexes[p], text);
      if (!r) continue;
      const slot = perPlatform[p].get(r.text);
      if (slot && typeof slot.zh === 'string') continue;
      let item = byForm.get(r.text);
      if (!item) {
        item = { text: r.text, source: info.source, targets: [] };
        byForm.set(r.text, item);
        pending.push(item);
      }
      if (!slot) perPlatform[p].set(r.text, { zh: null, item });
      item.targets.push({ platform: p, key: r.text });
    }
  }
  // added 的口径是「需要 AI 的形态数」，与 translated + echoed + untranslated 对齐；
  // 被 ① 覆盖掉的候选不算新增——它们的形态在产物里早已存在，只是官方改了大小写
  stats.added = pending.length;

  return { perPlatform, stats, pending, dropped };
}

// 分段：common 段收「在 Windows 产物里存在的形态」，macos 段收「只在 macOS 产物里存在的形态」。
// 注意判据用的是产品物里的字面量，而不是 perPlatform.windows 里有没有这条键——同一条历史键
// 在两平台可能解析出不同形态（Windows 精确命中 Options、macOS 只找得到 options），
// 后者若在 Windows 产物里同样存在，就该归 common，否则会凭空造出一条只在 macOS 生效的键。
// 未译条目（zh 为 null）不写入——写进去既不产生替换效果，又会让 validate 持续报空译提示。
function toSegments(perPlatform, winExact) {
  const commonSeg = {};
  const macosSeg = {};
  const skipped = [];
  for (const [k, v] of [...perPlatform.windows].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (typeof v.zh === 'string') commonSeg[k] = v.zh;
    else skipped.push(k);
  }
  for (const [k, v] of [...perPlatform.macos].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const shared = winExact.has(common.splitScopedKey(k).key);
    if (typeof v.zh !== 'string') {
      skipped.push(k);
    } else if (shared) {
      if (!(k in commonSeg)) commonSeg[k] = v.zh;
    } else {
      macosSeg[k] = v.zh;
    }
  }
  return { segments: { common: commonSeg, macos: macosSeg, windows: {}, linux: {} }, skipped };
}

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

const SYSTEM_PROMPT = `你是 GitHub Desktop 中文汉化字典的译者。用户给你一批界面文案，你返回它们的简体中文译文。

硬性要求：
1. 只输出一个 JSON 对象，形如 {"1": "译文", "2": "译文"}，键是条目 id 的字符串形式。不要输出任何其它文字、不要用代码块包裹。
2. 占位符一律原样保留：《{{count}}》《{name}}》《\${x}}》里的花括号一个都不能少、不能多，变量名也不能改。
3. 原文里的 & 是菜单助记符，保留，并放在中文里对应的字之前（&File → &文件，Cu&t → 剪&切）。
4. 省略号用单个 … 字符；原文末尾若有 … 或 : 等标点，译文同样收尾。
5. GitHub、Copilot、Git、SSH、URL、Markdown、Desktop 等专有名词不翻译。
6. 译文风格与用户给出的示例一致：贴近软件界面的习惯说法，简洁，句末不加句号。
7. 无需翻译的条目（域名、仓库路径、纯专有名词、纯符号）原样返回。`;

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

// ============================ 干跑校验 ============================

// 把字典套回产物（内存里替换，不落盘），统计生效条目数并做补丁后语法校验。
// 收的是内存里的 segments 而非磁盘上的字典——dry-run 时字典还没写。
//
// 分母只算「本平台产物里真实存在的键」：common 段里有一批 Windows 专有的键
// （Show in Explorer、&Options… 之类），它们在 macOS 产物里根本没有，拿它们去算
// macOS 侧的命中率只会让数字失真。判据用产物字面量索引，与写入时的判据同源。
function dryRunPlatform(appDir, version, segments, platform, idx) {
  const doc = { _meta: { version, formatVersion: 2 }, groups: {}, ...segments };
  const entries = common.buildEntries(doc, version, platform);
  const scoped = {};
  const effective = new Set();
  for (const f of TARGETS) {
    scoped[f] = common.scopedEntries(entries, f);
    for (const k of scoped[f].keys()) if (idx.exact.has(k)) effective.add(k);
  }
  const hit = new Set();
  let hits = 0;
  for (const f of TARGETS) {
    const file = path.join(appDir, f);
    const r = common.applyDictInStrings(fs.readFileSync(file, 'utf8'), scoped[f]);
    const syn = common.checkSyntax(r.content, file);
    if (!syn.ok) {
      return { ok: false, error: `${f} 替换后语法不过：${syn.output}`, hits, effective: effective.size, hit: hit.size };
    }
    hits += r.total;
    for (const k of r.perKey.keys()) hit.add(k);
  }
  // 未命中的键：整模板键替换时会覆盖它内部的文本段（applyDictInStrings 里外层优先），
  // 那些文本段自然不会单独命中——这是既有设计的预期结果，不该混进异常清单。
  const missed = [...effective].filter((k) => !hit.has(k));
  const templates = [...hit].filter((k) => k.startsWith('`'));
  const unexpected = missed.filter((k) => !templates.some((t) => t.includes(k)));
  return {
    ok: true,
    hits,
    effective: effective.size,
    hit: hit.size,
    rate: effective.size ? hit.size / effective.size : 1,
    coveredByTemplate: missed.length - unexpected.length,
    missed: unexpected.slice(0, 50),
  };
}

// ============================ 与已有字典对比 ============================

// 键 → 所在段。字典不允许同键跨段（validate 列为 error），所以一张表就够。
function segmentIndex(doc) {
  const m = new Map();
  for (const seg of common.SEGMENT_NAMES) {
    for (const k of Object.keys(doc[seg] || {})) m.set(k, seg);
  }
  return m;
}

// 键 → 组名。groups 段是「组名 → 键数组」，这里翻过来查。
function groupIndex(groups) {
  const m = new Map();
  for (const [g, keys] of Object.entries(groups || {})) {
    for (const k of keys || []) if (!m.has(k)) m.set(k, g);
  }
  return m;
}

// 对比两份字典（existing = 磁盘上那份，produced = 本次产出）。纯函数，不碰磁盘。
// 按「键」而不是按「段 + 键」对齐：同键换段（common ↔ macos）若按段对齐会表现成一删一增，
// 看着像两条无关的变化；单列成 moved 才看得出「这条只是换了归属」。
function diffDicts(existing, produced) {
  const before = segmentIndex(existing);
  const after = segmentIndex(produced);
  const added = [];
  const removed = [];
  const changed = [];
  const moved = [];

  for (const [key, seg] of after) {
    const was = before.get(key);
    if (was === undefined) added.push({ seg, key, zh: produced[seg][key] });
    else if (was !== seg) moved.push({ key, from: was, to: seg, zh: produced[seg][key] });
    else if (existing[seg][key] !== produced[seg][key]) {
      changed.push({ seg, key, from: existing[seg][key], to: produced[seg][key] });
    }
  }
  for (const [key, seg] of before) {
    if (!after.has(key)) removed.push({ seg, key, zh: existing[seg][key] });
  }

  // 组归属只对两边都在的键比——新增/删除的键各自的归属没有「变化」可言
  const ga = groupIndex(existing.groups);
  const gb = groupIndex(produced.groups);
  const groupsChanged = [];
  for (const [key] of after) {
    if (!before.has(key)) continue;
    const from = ga.get(key) || common.UNGROUPED;
    const to = gb.get(key) || common.UNGROUPED;
    if (from !== to) groupsChanged.push({ key, from, to });
  }
  return { added, removed, changed, moved, groupsChanged };
}

// 明细进报告前的整形：每类截到 DIFF_LIMIT 条，同时保留总数——截断了多少要看得出来，
// 否则「报告里只有 500 条」会被读成「一共就 500 条」。
function shapeDiff(d) {
  const out = {};
  for (const [name, rows] of Object.entries(d)) {
    out[name] = rows.slice(0, DIFF_LIMIT);
    out[`${name}Count`] = rows.length;
  }
  out.limit = DIFF_LIMIT;
  return out;
}

// 差异摘要。明细可能上千条，日志里每类只给前几条当样本，全量在报告 JSON 里。
function logDiff(d, log) {
  const parts = [
    ['新增', d.added],
    ['删除', d.removed],
    ['译文变化', d.changed],
    ['换段', d.moved],
    ['组归属变化', d.groupsChanged],
  ];
  if (!parts.some(([, rows]) => rows.length)) {
    log('  与磁盘上的字典完全一致：键、译文、段归属、组归属都没有变化');
    return;
  }
  for (const [name, rows] of parts) {
    if (!rows.length) continue;
    const sample = rows.slice(0, 5).map((r) => JSON.stringify(r.key)).join('、');
    log(`  ${name} ${rows.length} 条：${sample}${rows.length > 5 ? ' …' : ''}`);
  }
}

// ============================ 单个版本 ============================

// 把字典恢复成本次产出之前的样子：此前没有字典就删掉，有就写回原字节。返回一句可打印的描述。
// 这是「撤销一次未完成的写入」，不是修改字典内容——故不走 dict-edit 的事务模型：字节级还原
// 比重序列化更可靠，也不该再触发一遍校验（校验刚失败过，正是要撤回去的时候）。
function restoreDict(dictFile, previous) {
  if (previous !== null) {
    fs.writeFileSync(dictFile, previous, 'utf8');
    return '已恢复原有字典';
  }
  fs.rmSync(dictFile, { force: true });
  try {
    fs.rmdirSync(path.dirname(dictFile));
  } catch {
    /* 目录非空或已被删，忽略 */
  }
  return '已删除刚产出的字典';
}

async function buildOne(version, args, log) {
  const dictFile = common.dictFile(version);
  const mode = args.onExist || ON_EXIST;
  // 覆盖模式失败时要把原有的那份放回去，所以先把字节读进内存。diff 模式不写盘，用不上它。
  const previous = fs.existsSync(dictFile) ? fs.readFileSync(dictFile, 'utf8') : null;

  if (previous !== null && mode === 'skip') {
    return {
      version,
      ok: true,
      skipped: true,
      reason: `已有字典 ${dictFile}，跳过（--on-exist=diff 只对比、=overwrite 覆盖）`,
    };
  }

  // diff 要拿磁盘上那份逐键对比，读不了就没得比。这道校验放在最前面而不是第 7 步：
  // 「读不了」这件事一开始就知道，没道理等产物下载完、AI 也调完才报——那是白烧几分钟
  // 与一轮 tokens（实测在旧格式字典上踩到）。overwrite 不读它（覆盖掉就是了），不受影响。
  if (previous !== null && mode === 'diff') {
    try {
      dictEdit.read(version);
    } catch (e) {
      return { version, ok: false, reason: `磁盘上的字典读不了，无法对比：${e.message}` };
    }
  }

  const workRoot = path.join(args.work, version);
  log(`\n=== ${version} ===`);
  if (previous !== null) {
    log(
      mode === 'diff'
        ? '已有字典，diff 模式：照常产出并与磁盘上那份逐键对比，全程不写盘'
        : '已有字典，overwrite 模式：产出后整体覆盖（任一步失败则恢复原内容）'
    );
  }
  log('1/7 取产物与索引');
  const appDirs = {};
  const indexes = {};
  for (const platform of PLATFORMS) {
    // 目录带 arch：同一版本两个架构并存时不会互相覆盖，也与 release-assets 的 CLI 用法一致
    const out = path.join(workRoot, `${platform}-${args.arch}`);
    const appDir = path.join(out, 'app');
    if (args.reuse && TARGETS.every((f) => fs.existsSync(path.join(appDir, f)))) {
      log(`  ${platform}：复用已提取的产物 ${appDir}`);
    } else {
      log(`  ${platform}：提取产物…`);
      await releaseAssets.fetchApp(version, { platform, arch: args.arch, out, log });
    }
    appDirs[platform] = appDir;
    indexes[platform] = literalIndex(appDir);
    log(`  ${platform}：产物字面量索引 ${indexes[platform].exact.size} 条`);
  }

  log('2/7 提取官方新增文案候选');
  const jsxFound = new Map();
  for (const platform of PLATFORMS) {
    const { found, scanned } = scan.collectCandidates({
      appDir: appDirs[platform],
      known: new Set(),
      minLength: MIN_LENGTH,
    });
    let n = 0;
    for (const [text, info] of found) {
      if (!info.jsx) continue;
      n++;
      if (!jsxFound.has(text)) jsxFound.set(text, info);
    }
    log(`  ${platform}：扫描 ${scanned} 个自有源文件，JSX 文本候选 ${n} 条（字面量侧候选不计入，见文件头）`);
  }

  log('3/7 以历史字典为锚核对新产物');
  // 重跑已有版本时把自己也算作继承来源——它的译文正是最该保住的东西。排除自己的话产出会
  // 退化成「从零翻译」：实测重跑 3.6.6 时继承 0 条、产出只剩 140 条，overwrite 会把原有
  // 1963 条的好字典换成这份残缺品，diff 也会把「继承不到」误报成「删除 1833 条」。
  // 官方删掉的键仍会被正确剔除：核对的锚是键集，新产物里没有的照样进 dropped。
  const { table, versions } = inheritTable(previous !== null ? [] : [version]);
  log(`  历史字典：${versions.length ? versions.join(' / ') : '（无）'}，共 ${table.size} 条`);
  const { perPlatform, stats, pending, dropped } = buildCandidates({ indexes, history: table, jsxFound });
  log(
    `  续用旧译文 ${stats.inherited} 条（跨平台核对时 ${stats.variant} 次发现官方改了大小写，按新形态收录）；` +
      `官方已删除 ${stats.dropped} 条；新增待译 ${pending.length} 条`
  );

  const report = {
    version,
    ok: false,
    fetchedAt: new Date().toISOString(),
    history: versions,
    inherited: stats.inherited,
    variant: stats.variant,
    dropped: stats.dropped,
    added: stats.added,
    untranslated: 0,
    echoed: 0,
  };

  log('4/7 AI 翻译新增条目');
  if (pending.length) {
    if (args.noAi) {
      log('  --no-ai：跳过翻译，未译条目不计入字典');
      report.untranslated = pending.length;
      report.untranslatedRows = pending.map((it) => ({ text: it.text, reason: '--no-ai' }));
    } else {
      const base = (args.aiBase || process.env.AI_BASE_URL || '').replace(/\/+$/, '');
      const key = args.aiKey || process.env.AI_API_KEY || '';
      const model = args.aiModel || process.env.AI_MODEL || '';
      if (!base || !key || !model) {
        throw new Error(
          '需要翻译但没有 AI 配置：请设置 AI_BASE_URL / AI_API_KEY / AI_MODEL 环境变量，或用 --no-ai 只做继承'
        );
      }
      // 发请求之前先校验地址：拼错了就是几十次同样的失败，等失败回来再说就晚了
      const baseUrl = assertBaseUrl(base);
      // 对外文本里要抹掉的值。除了地址本身还要抹它的 host：net.js 的报错用的是 `new URL(…).host`
      // （「连接被拒绝……：主机:端口」「请求超时……：主机:端口」都只带主机），拿完整地址当 needle
      // 匹配不上——实测过，两处都会漏。
      const secrets = [base, baseUrl.host, key];
      const effort = resolveEffort(args.aiEffort ?? process.env.AI_REASONING_EFFORT);
      const timeout = resolveTimeout(args.aiTimeout || process.env.AI_TIMEOUT_SEC);
      const cfg = { base, key, model, effort, timeout, examples: buildExamples(table) };
      log(
        `  接口 ${base}，模型 ${model}，思考强度 ${effort || '（不传，用接口默认）'}` +
          `，超时 ${timeout / 1000}s，风格示例 ${cfg.examples.length} 条`
      );
      const { done, failed, echoed } = await translateAll(pending, cfg, log);
      for (const [item, zh] of done) {
        for (const t of item.targets) perPlatform[t.platform].set(t.key, { zh });
      }
      report.translated = done.size;
      // 译出的条目连译文一起进报告：这是人工复核 AI 译文的唯一依据（日志只打总数），
      // 也是排查「某条译文怎么变成这样了」时唯一能回溯到的东西
      report.translatedRows = [...done].map(([item, zh]) => ({ text: item.text, zh }));
      report.untranslated = failed.length;
      report.untranslatedRows = failed.map((it) => ({ text: it.text, reason: it.reason }));
      if (failed.length) {
        report.reasonDetail = collapseReasons(report.untranslatedRows, secrets);
        log(`  未译原因：${report.reasonDetail}`);
      }
      // 无需翻译的条目单列：它们既不算译出也不算未译，但要留痕——AI 若成片原样返回，
      // 这里就是唯一能看出来「它是在偷懒还是在正确地放过专有名词」的地方
      report.echoed = echoed.length;
      report.echoedRows = echoed.map((it) => it.text);
      log(
        `  译出 ${done.size} 条；无需翻译 ${echoed.length} 条${echoed.length ? `（${echoed.map((it) => it.text).join('、')}）` : ''}；` +
          `未译 ${failed.length} 条`
      );
    }
    // 未译比例超过上限，说明 AI 链路整体不可用而不是个别条目译不出来。
    // --no-ai 是「明说这次不译」，不适用该门槛。
    const rate = report.untranslated / pending.length;
    if (!args.noAi && rate > MAX_UNTRANSLATED_RATE) {
      report.reason = `未译 ${report.untranslated}/${pending.length} 条（${(rate * 100).toFixed(0)}%）超过上限 ${MAX_UNTRANSLATED_RATE * 100}%`;
      return report;
    }
  } else {
    log('  无新增条目');
  }

  const { segments, skipped } = toSegments(perPlatform, indexes.windows.exact);
  report.counts = {
    common: Object.keys(segments.common).length,
    macos: Object.keys(segments.macos).length,
    skippedNoTranslation: skipped.length,
  };
  log(
    `5/7 分段结果：common ${report.counts.common} 条 / macos ${report.counts.macos} 条` +
      `${skipped.length ? `（因无译文未写入 ${skipped.length} 条）` : ''}`
  );

  log('6/7 干跑校验');
  const checks = {};
  for (const platform of PLATFORMS) {
    const r = dryRunPlatform(appDirs[platform], version, segments, platform, indexes[platform]);
    checks[platform] = r;
    if (r.ok) {
      log(`  ${platform}：命中 ${r.hits} 处，生效条目 ${r.hit}/${r.effective}（${(r.rate * 100).toFixed(1)}%）`);
      if (r.missed.length) log(`    索引里有、替换时未命中：${r.missed.map((k) => JSON.stringify(k)).join('、')}`);
    } else {
      log(`  ${platform}：${r.error}`);
    }
  }
  report.checks = checks;
  const bad = PLATFORMS.find((p) => !checks[p].ok);
  const low = PLATFORMS.find((p) => checks[p].rate < MIN_HIT_RATE);
  if (bad) report.reason = `${bad} 平台干跑失败：${checks[bad].error}`;
  else if (low) report.reason = `${low} 平台生效比例 ${(checks[low].rate * 100).toFixed(1)}% 低于阈值 ${MIN_HIT_RATE * 100}%`;
  if (report.reason && !args.dryRun) {
    report.droppedKeys = dropped.slice(0, 100);
    return report;
  }

  log('7/7 推断组名并写入');
  // 键集从内存里的 segments 取，而不是让 infer 去读磁盘上的字典——写入前磁盘上还是旧字典
  // （overwrite 模式）或根本没有（新版本），读它会拿错键集。顺带让 diff 模式能在不写盘的前提下推断。
  let groups;
  let gs;
  try {
    ({ groups, stats: gs } = dictGroups.infer(version, {
      explicitPath: path.dirname(appDirs.windows),
      keys: common.SEGMENT_NAMES.flatMap((s) => Object.keys(segments[s] || {})),
    }));
  } catch (e) {
    report.reason = `组名推断失败：${e.message}`;
    return report;
  }
  report.groups = Object.keys(groups).length;
  report.ungrouped = gs.无来源;
  log(`  推断出 ${report.groups} 个组，扫描 ${gs.scanned} 个自有源文件，${gs.无来源} 条未定位来源`);

  // diff 模式到此为止：产出全在内存里，与磁盘上那份逐键比一遍就结束。这是只读操作，
  // 因此不需要备份与恢复——磁盘上的字典从头到尾没被碰过。
  if (mode === 'diff') {
    const d = diffDicts(dictEdit.read(version), { ...segments, groups });
    report.diff = shapeDiff(d);
    report.ok = true;
    report.diffMode = true;
    logDiff(d, log);
    log('  磁盘未改动');
    return report;
  }

  if (args.dryRun) {
    log('  --dry-run：跳过写入');
    report.ok = true;
    report.dryRun = true;
    return report;
  }

  // 写入之后任一环节失败，就把字典恢复成本次产出之前的样子——否则下次重跑会因为「已有字典」
  // 而跳过，把一次失败的产出永久固化下来（回填时尤其要紧）；覆盖模式下更要紧，直接删掉
  // 会把原有的那份一起弄丢。
  let written = false;
  try {
    const w = dictEdit.create(
      version,
      {
        meta: {
          updated: new Date().toISOString().slice(0, 10),
          notes:
            '由官方产物自动产出（scripts/dict/dict-auto.js）：以上一版字典为锚核对每条键在新产物里的形态，' +
            '官方新增的 JSX 文案由 AI 按既有风格补译，写入前经 dict-edit 事务校验与产物干跑。' +
            '键的三类形态：普通键（字符串字面量内容或模板文本段整串匹配）、整模板键（含 ${} 的' +
            '完整模板源码整段替换）、作用域键（<文件名>.js|原文，只对该文件生效）。' +
            '大小写敏感、精确匹配；common 段为两平台共有与 Windows 专有，macos 段为 macOS 独有形态。' +
            '字面量侧的候选不自动收录（真文案会被枚举值/事件名/URL 片段淹没），需人工从 scan 报告补充。',
        },
        segments,
        groups: {},
      },
      // overwrite 是「重跑已有版本」的显式入口。create 默认拒绝覆盖，那道闸拦的正是
      // 「本该用 apply 改、却整体重建」的误用，只有这里明确说了要覆盖才放行
      { overwrite: mode === 'overwrite' }
    );
    written = true;
    log(`  已写入 ${w.file}`);
    const r = dictEdit.regroup(version, { groups });
    for (const warn of r.warnings) log(`  [提示] ${warn.code}：${warn.detail}`);
  } catch (e) {
    if (written) log(`  写入后出错，${restoreDict(dictFile, previous)}：${e.message}`);
    report.reason = e.message;
    return report;
  }

  const v = dictEdit.validate(version);
  if (v.errors.length) {
    log(`  校验未通过，${restoreDict(dictFile, previous)}`);
    report.reason = `字典校验未通过：${v.errors.map((e) => `${e.code}${e.key ? `(${e.key})` : ''}`).join(' / ')}`;
    return report;
  }
  report.warnings = v.warnings.map((x) => `${x.code}：${x.detail}`);
  report.droppedKeys = dropped.slice(0, 100);
  report.ok = true;
  return report;
}

// ============================ 主流程 ============================

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (e) {
    console.error(`错误：${e.message}`);
    process.exit(1);
  }
  if (args.help) {
    printHelp();
    return;
  }
  args.work = args.work || path.join(common.REPO_ROOT, 'tmp', 'release');

  const reports = [];
  try {
    const versions = await resolveVersions(args.version, args.token || process.env.GITHUB_TOKEN);
    console.log(`待产出：${versions.join(' / ')}${args.dryRun ? '（--dry-run）' : ''}`);
    for (const version of versions) {
      let r;
      try {
        r = await buildOne(version, args, console.log);
      } catch (e) {
        // 单版本出意外不该拖垮整轮：回填十几个版本时，中间一个失败会让后面的全不跑，
        // 而 CI 的提交步骤正是靠「已成功的那些」产出内容的。转成失败条目，继续下一个。
        r = { version, ok: false, reason: e.message };
      }
      reports.push(r);
      if (r.skipped) console.log(`跳过：${r.reason}`);
      else if (!r.ok) console.error(`::error::${version} 产出失败：${failureText(r)}`);
    }
  } catch (e) {
    console.error(`错误：${e.message}`);
    writeReport(args.report, { ok: false, reason: e.message, reports });
    process.exit(1);
  }

  const failed = reports.filter((r) => !r.ok);
  const diffed = reports.filter((r) => r.ok && r.diffMode);
  const produced = reports.filter((r) => r.ok && !r.skipped && !r.diffMode);
  const skipped = reports.filter((r) => r.skipped);
  console.log(
    `\n产出 ${produced.length} 个版本${diffed.length ? `，对比 ${diffed.length} 个` : ''}` +
      `${failed.length ? `，失败 ${failed.length} 个` : ''}${skipped.length ? `，跳过 ${skipped.length} 个` : ''}`
  );
  for (const r of produced) {
    console.log(
      `  ${r.version}：common ${r.counts.common} / macos ${r.counts.macos} 条，续用旧译文 ${r.inherited}` +
        `（其中 ${r.variant} 条官方改了大小写），新译 ${r.translated || 0}，未译 ${r.untranslated}，` +
        `官方已删除 ${r.dropped}`
    );
  }
  for (const r of diffed) {
    const c = r.diff;
    console.log(
      `  ${r.version}（对比，磁盘未改动）：新增 ${c.addedCount} / 删除 ${c.removedCount} / ` +
        `译文变化 ${c.changedCount} / 换段 ${c.movedCount} / 组归属变化 ${c.groupsChangedCount}`
    );
  }
  for (const r of failed) console.log(`  ${r.version}：失败——${failureText(r)}`);

  writeReport(args.report, { ok: failed.length === 0, reports });
  if (failed.length) process.exit(1);
}

function writeReport(file, data) {
  if (!file) return;
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`报告：${abs}`);
}

module.exports = {
  main, buildOne, resolveVersions, inheritTable, literalIndex, resolveIn,
  buildCandidates, toSegments, dryRunPlatform, buildExamples, rejectReason, placeholdersOf,
  resolveTimeout, resolveEffort, isEcho, translateBatch,
  assertBaseUrl, redact, collapseReasons, failureText,
  diffDicts, shapeDiff, segmentIndex, groupIndex, parseArgs,
  BATCH_SIZE, AI_EFFORT, AI_TIMEOUT, MIN_HIT_RATE, MAX_UNTRANSLATED_RATE,
  ON_EXIST, ON_EXIST_MODES, DIFF_LIMIT,
};

if (require.main === module) main();
