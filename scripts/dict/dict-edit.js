// dict-edit.js — 字典的**唯一写入口**
//
// 约束（见 AGENTS.md 与 docs/design/dict-v2/design.md）：字典的一切修改都经由本模块暴露的函数完成，
// AI 与其它工具只调用这些方法，**不直接读写 dictionaries/<版本>/zh-CN.json**。理由有三：
//   1. formatVersion 2 是分段结构，条目段与 groups 段靠键名关联，分处两地写就会漂移；
//   2. 条目合法性（整模板键译文须是 JS 字面量、键不得跨段重复）不是 JSON 结构能表达的；
//   3. 一次修改要么整体生效、要么完全不动——手改没有这个保证。
//
// 写入模型是事务式的：读原文 → 内存变更 → 校验 → 写 .tmp → 读回重校验 → 原子替换 → 写后复核。
// 任一步失败，原文件从未被改动——最可靠的回滚是不制造需要回滚的状态；写后复核若不一致，
// 再用内存中的原文覆盖回去并报错。
'use strict';

const fs = require('fs');
const path = require('path');
const common = require('../common');

const SEGMENTS = common.SEGMENT_NAMES; // ['common', 'windows', 'macos', 'linux']
const PLATFORMS = ['common', ...common.PLATFORM_SEGMENTS];
// 作用域键只允许指向这两个产物文件——产物里也只有它们会被替换
const SCOPE_FILES = ['main.js', 'renderer.js'];

// —— 问题结构 ——
// { level: 'error'|'warning', code, key?, detail }
const err = (code, detail, key) => ({ level: 'error', code, detail, ...(key ? { key } : {}) });
const warn = (code, detail, key) => ({ level: 'warning', code, detail, ...(key ? { key } : {}) });

// 事务失败时抛出的错误：problems 里是逐条原因，调用方据此打印可读说明
class DictError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.name = 'DictError';
    this.problems = problems;
  }
}

// ============================ 读取 ============================

function dictPath(version) {
  return common.dictFile(version);
}

function readRaw(version) {
  const file = dictPath(version);
  if (!fs.existsSync(file)) {
    throw new DictError(`字典不存在：${version}（查找 ${file}）`);
  }
  const text = fs.readFileSync(file, 'utf8');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new DictError(`字典不是合法 JSON：${file}（${e.message}）`);
  }
  return { file, text, raw };
}

// 顶层出现任一条目段名或 groups，即认为结构已经是分段的。
// 用来把「结构对但 formatVersion 写错」与「真的还是旧扁平字典」分开：
// 前者报 meta/format（写对了结构不该被引导去 migrate），后者才引导去 migrate。
function looksSegmented(raw) {
  return (
    SEGMENTS.some((n) => raw[n] && typeof raw[n] === 'object' && !Array.isArray(raw[n])) ||
    (raw.groups !== null && typeof raw.groups === 'object')
  );
}

// 规范化成五段结构。扁平字典不在这里兼容——那是 migrate 的职责，
// 否则「读到的到底是哪种格式」会在调用方各处扩散。
//
// 这里**只做浅拷贝，不做兜底补齐**：段缺失、组值是字符串这类问题必须原样留给
// validateDoc 报出来。补齐等于替调用方把坏字典修好，validate 就再也报不出这些错误了。
function normalize(raw, version) {
  const fv = raw && raw._meta ? raw._meta.formatVersion : undefined;
  if (fv !== 2 && !looksSegmented(raw)) {
    throw new DictError(
      `字典 ${version} 是旧格式（formatVersion=${fv === undefined ? '缺失' : fv}），` +
        `请先运行：dict-edit migrate ${version}`
    );
  }
  const copy = (seg) => (seg && typeof seg === 'object' && !Array.isArray(seg) ? { ...seg } : seg);
  const out = { _meta: { ...(raw._meta || {}) } };
  for (const name of SEGMENTS) out[name] = copy(raw[name]);
  out.groups = copy(raw.groups);
  return out;
}

// 只读：返回规范化后的五段结构（调用方改它不会影响磁盘）
function read(version) {
  const { raw } = readRaw(version);
  return normalize(raw, version);
}

// 某个平台下真正参与替换的段。platform 省略时给全部段（统计用途），
// 给了平台则是「common ∪ 该平台段」——与运行时 buildEntries 的口径一致，
// 否则查出来的条目集合跟实际生效的对不上。未知平台按宽容降级只给 common。
function platformView(platform) {
  if (!platform) return SEGMENTS;
  if (platform === 'common') return ['common'];
  return SEGMENTS.includes(platform) ? ['common', platform] : ['common'];
}

// 只读：按条件查条目。platform 省略时不筛平台（含全部段）
function query(version, { platform, group, keyword } = {}) {
  const doc = read(version);
  const index = groupIndex(doc);
  const out = [];
  for (const name of platformView(platform)) {
    for (const [key, zh] of Object.entries(doc[name] || {})) {
      if (group && index.get(key) !== group) continue;
      if (keyword) {
        const k = keyword.toLowerCase();
        if (!key.toLowerCase().includes(k) && !zh.toLowerCase().includes(k)) continue;
      }
      out.push({ key, zh, platform: name, group: index.get(key) || null });
    }
  }
  return out;
}

// 键 → 组名 反查表（同一个键在多组出现时取先出现的组）
function groupIndex(doc) {
  const map = new Map();
  for (const [g, keys] of Object.entries(doc.groups || {})) {
    if (!Array.isArray(keys)) continue;
    for (const k of keys) if (!map.has(k)) map.set(k, g);
  }
  return map;
}

// ============================ 校验 ============================

// 一致性校验。errors 阻断写入，warnings 只提示。
// 判据清单见 docs/design/dict-v2/design.md 的「一致性校验清单」。
function validateDoc(doc, version) {
  const errors = [];
  const warnings = [];
  const meta = doc._meta || {};

  if (typeof meta.version !== 'string' || !meta.version) {
    errors.push(err('meta/version', '_meta.version 缺失或不是字符串'));
  } else if (meta.version !== version) {
    errors.push(
      err('meta/version-mismatch', `_meta.version=${meta.version} 与目录名 ${version} 不一致`)
    );
  }
  if (meta.formatVersion !== 2) {
    errors.push(err('meta/format', `_meta.formatVersion 须为 2，当前为 ${meta.formatVersion}`));
  }

  // 段落齐全且皆为对象
  for (const name of [...SEGMENTS, 'groups']) {
    const seg = doc[name];
    if (seg === null || typeof seg !== 'object' || Array.isArray(seg)) {
      errors.push(err('segment/missing', `缺少对象形式的 "${name}" 段`));
    }
  }
  if (errors.some((e) => e.code === 'segment/missing')) return { errors, warnings };

  // 条目合法性 + 键跨段重复 + 作用域文件名
  const seen = new Map();
  for (const name of SEGMENTS) {
    for (const [k, v] of Object.entries(doc[name])) {
      const where = seen.get(k);
      if (where) {
        errors.push(
          err('entry/duplicate', `${k} 同时出现在 "${where}" 与 "${name}" 段`, k)
        );
      } else {
        seen.set(k, name);
      }
      if (typeof v !== 'string' || v.length === 0) {
        errors.push(err('entry/value', `${k} 的译文必须是非空字符串`, k));
        continue;
      }
      const problem = common.templateValueProblem(common.splitScopedKey(k).key, v);
      if (problem) errors.push(err('entry/template', problem, k));
      const scope = common.splitScopedKey(k).file;
      if (scope && !SCOPE_FILES.includes(scope)) {
        errors.push(
          err('entry/scope', `作用域键只能指向 ${SCOPE_FILES.join(' / ')}，当前为 ${scope}`, k)
        );
      }
    }
  }

  // groups：值须为字符串数组；引用的键必须存在
  for (const [g, keys] of Object.entries(doc.groups)) {
    if (!Array.isArray(keys)) {
      errors.push(err('group/type', `组 "${g}" 的值必须是键名数组`));
      continue;
    }
    for (const k of keys) {
      if (typeof k !== 'string') {
        errors.push(err('group/type', `组 "${g}" 里有非字符串项`));
      } else if (!seen.has(k)) {
        errors.push(err('group/dangling', `组 "${g}" 引用了不存在的键：${k}`, k));
      }
    }
  }

  // 警告：未分组 / 未翻译
  const grouped = groupIndex(doc);
  const ungrouped = [...seen.keys()].filter((k) => !grouped.has(k));
  if (ungrouped.length) {
    warnings.push(
      warn('group/ungrouped', `${ungrouped.length} 条未归入任何组（分组只是参考，不阻断）`)
    );
  }
  const untranslated = [...seen.entries()].filter(([k, name]) => doc[name][k] === k);
  if (untranslated.length) {
    warnings.push(warn('entry/untranslated', `${untranslated.length} 条译文与原文相同（可能是漏译）`));
  }

  return { errors, warnings };
}

// 校验磁盘上的字典
function validate(version) {
  const { raw } = readRaw(version);
  let doc;
  try {
    doc = normalize(raw, version);
  } catch (e) {
    return { errors: [err('format/old', e.message)], warnings: [] };
  }
  return validateDoc(doc, version);
}

// ============================ 写入 ============================

// 序列化：固定段序（_meta → common → 平台段 → groups），条目保持插入顺序——
// 这样迁移与多次编辑的 diff 都稳定，评审时能看清真正改动的那几行。
function serialize(doc) {
  const ordered = { _meta: doc._meta };
  for (const name of SEGMENTS) ordered[name] = doc[name];
  ordered.groups = doc.groups;
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

// 事务写入：校验不通过就抛错，**原文件不动**。
// dryRun 为真时走完全部步骤（含校验）但不落盘，用来预览一次批量修改的结果。
// 目标版本还没有字典时（CI 给新版本产出首版）也走这里——original 为 null 表示「原文件不存在」，
// 写后复核失败时的回滚动作相应地是删除而不是覆盖回原文。
function write(version, doc, { dryRun = false } = {}) {
  const file = dictPath(version);
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;

  const { errors, warnings } = validateDoc(doc, version);
  if (errors.length) {
    throw new DictError(`字典校验未通过（${errors.length} 项），已放弃写入`, errors);
  }

  const next = serialize(doc);
  if (dryRun) return { ok: true, file, changes: 0, warnings, dryRun: true, text: next };
  if (next === original) return { ok: true, file, changes: 0, warnings };

  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true }); // 新版本目录尚不存在
    fs.writeFileSync(tmp, next, 'utf8');

    // 读回 .tmp 重新解析 + 校验：挡住序列化与解析之间的意外
    const back = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    const recheck = validateDoc(normalize(back, version), version);
    if (recheck.errors.length) {
      throw new DictError('写入前复核失败，已放弃写入', recheck.errors);
    }

    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e instanceof DictError ? e : new DictError(`写入失败：${e.message}`);
  }

  // 写后复核：rename 成功但内容意外时，用内存里的原文覆盖回去
  if (fs.readFileSync(file, 'utf8') !== next) {
    if (original === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, original, 'utf8');
    throw new DictError('写入后复核不一致，已回滚为修改前内容');
  }

  return { ok: true, file, changes: 1, warnings };
}

// 从零建一份字典（目标版本还没有字典目录时用）。CI 给新版本产出首版字典走这里——
// 「文件还不存在」不是跳过校验的理由，恰恰相反：新字典没有既有内容兜底，第一版内容的
// 合法性全靠这一次校验。已存在则报错，避免把「新建」误用在「改已有字典」上（那会整段覆盖）。
// opts.overwrite：允许覆盖一份已存在的字典（dict-auto 的 --on-exist=overwrite）。默认拒绝——
// 那道闸拦的是「本该用 apply 逐条改、却整体重建」的误用，整体重建会静默丢掉别人经 apply
// 加进来的条目。写入本身仍走 write 的事务模型（写后复核 + 不一致即回滚）。
function create(version, { meta = {}, segments = {}, groups = {} } = {}, opts = {}) {
  const file = dictPath(version);
  if (fs.existsSync(file) && !opts.overwrite) {
    throw new DictError(`字典已存在，改用 apply / mergeIn 修改：${file}`);
  }
  // version / formatVersion 放在展开之后：它们与目录结构、解析分支绑定，不该被 meta 覆盖
  const doc = { _meta: { ...meta, version, formatVersion: 2 } };
  for (const name of SEGMENTS) {
    const seg = segments[name];
    doc[name] = seg && typeof seg === 'object' && !Array.isArray(seg) ? { ...seg } : {};
  }
  doc.groups = groups && typeof groups === 'object' && !Array.isArray(groups) ? { ...groups } : {};
  return write(version, doc, opts);
}

function findSegments(doc, key, platform) {
  const names = platform ? [platform] : SEGMENTS;
  return names.filter((n) => Object.prototype.hasOwnProperty.call(doc[n], key));
}

function assertPlatform(p, what = 'platform') {
  if (!PLATFORMS.includes(p)) {
    throw new DictError(`${what} 取值非法：${p}（可用：${PLATFORMS.join(' / ')}）`);
  }
}

// ============================ 操作 ============================

// 一次事务里应用多条操作。ops 是操作对象数组，见各 op 的说明。
// 全部成功才落盘；任何一条不合法都整体放弃，不产生"改了一半"的字典。
function apply(version, ops, opts = {}) {
  const doc = read(version);
  const changes = [];

  for (const [i, opItem] of ops.entries()) {
    const at = `第 ${i + 1} 条操作`;
    switch (opItem.op) {
      case 'add': {
        const platform = opItem.platform || 'common';
        assertPlatform(platform);
        if (typeof opItem.key !== 'string' || !opItem.key) {
          throw new DictError(`${at}：add 需要 key`);
        }
        const found = findSegments(doc, opItem.key);
        if (found.length) {
          throw new DictError(`${at}：键已存在于 "${found[0]}" 段，改用 update：${opItem.key}`);
        }
        common.checkEntry(version, opItem.key, opItem.zh);
        doc[platform][opItem.key] = opItem.zh;
        if (opItem.group) addToGroup(doc, opItem.group, opItem.key);
        changes.push(`add ${platform} ${opItem.key}`);
        break;
      }
      case 'update': {
        const found = findSegments(doc, opItem.key, opItem.platform);
        if (found.length === 0) {
          throw new DictError(`${at}：找不到键${opItem.platform ? `（限 ${opItem.platform} 段）` : ''}：${opItem.key}`);
        }
        if (found.length > 1) {
          throw new DictError(`${at}：键出现在多个段（${found.join(' / ')}），请用 platform 指明：${opItem.key}`);
        }
        common.checkEntry(version, opItem.key, opItem.zh);
        doc[found[0]][opItem.key] = opItem.zh;
        changes.push(`update ${found[0]} ${opItem.key}`);
        break;
      }
      case 'remove': {
        const found = findSegments(doc, opItem.key, opItem.platform);
        if (found.length === 0) {
          throw new DictError(`${at}：找不到要删除的键：${opItem.key}`);
        }
        for (const n of found) {
          delete doc[n][opItem.key];
          changes.push(`remove ${n} ${opItem.key}`);
        }
        removeFromGroups(doc, opItem.key);
        break;
      }
      case 'setGroup': {
        if (!Object.prototype.hasOwnProperty.call(doc.groups, opItem.group)) {
          doc.groups[opItem.group] = [];
        }
        removeFromGroups(doc, opItem.key);
        addToGroup(doc, opItem.group, opItem.key);
        changes.push(`setGroup ${opItem.key} → ${opItem.group}`);
        break;
      }
      case 'moveTo': {
        assertPlatform(opItem.from, 'from');
        assertPlatform(opItem.to, 'to');
        if (opItem.from === opItem.to) {
          throw new DictError(`${at}：from 与 to 相同（${opItem.from}）`);
        }
        if (!Object.prototype.hasOwnProperty.call(doc[opItem.from], opItem.key)) {
          throw new DictError(`${at}：键不在 "${opItem.from}" 段：${opItem.key}`);
        }
        if (Object.prototype.hasOwnProperty.call(doc[opItem.to], opItem.key)) {
          throw new DictError(`${at}：键已存在于 "${opItem.to}" 段：${opItem.key}`);
        }
        doc[opItem.to][opItem.key] = doc[opItem.from][opItem.key];
        delete doc[opItem.from][opItem.key];
        changes.push(`moveTo ${opItem.key} ${opItem.from} → ${opItem.to}`);
        break;
      }
      case 'mergeIn': {
        const platform = opItem.platform || 'common';
        assertPlatform(platform);
        if (!opItem.entries || typeof opItem.entries !== 'object') {
          throw new DictError(`${at}：mergeIn 需要 entries 对象`);
        }
        let n = 0;
        for (const [k, v] of Object.entries(opItem.entries)) {
          common.checkEntry(version, k, v);
          doc[platform][k] = v; // 已存在的直接覆盖——继承场景下新译文优先
          n++;
        }
        if (opItem.group) {
          for (const k of Object.keys(opItem.entries)) addToGroup(doc, opItem.group, k);
        }
        changes.push(`mergeIn ${platform} ${n} 条`);
        break;
      }
      case 'regroup': {
        // 整体替换 groups 段：组名推断脚本每次重建分组时用，避免逐条 diff
        if (!opItem.groups || typeof opItem.groups !== 'object') {
          throw new DictError(`${at}：regroup 需要 groups 对象`);
        }
        doc.groups = {};
        for (const [g, keys] of Object.entries(opItem.groups)) {
          if (!Array.isArray(keys)) throw new DictError(`${at}：组 "${g}" 的值必须是键名数组`);
          doc.groups[g] = [...keys];
        }
        changes.push(`regroup ${Object.keys(doc.groups).length} 组`);
        break;
      }
      case 'setMeta': {
        // _meta 只允许改这几个字段，避免把 version / formatVersion 改坏
        for (const f of ['updated', 'notes']) {
          if (opItem[f] !== undefined) doc._meta[f] = opItem[f];
        }
        changes.push('setMeta');
        break;
      }
      default:
        throw new DictError(`${at}：未知操作 "${opItem.op}"`);
    }
  }

  const res = write(version, doc, opts);
  return { ...res, changes };
}

function addToGroup(doc, group, key) {
  if (!Object.prototype.hasOwnProperty.call(doc.groups, group)) doc.groups[group] = [];
  if (!doc.groups[group].includes(key)) doc.groups[group].push(key);
}

function removeFromGroups(doc, key) {
  for (const g of Object.keys(doc.groups)) {
    doc.groups[g] = doc.groups[g].filter((k) => k !== key);
    if (doc.groups[g].length === 0) delete doc.groups[g];
  }
}

// —— 便捷单操作（都走 apply，保证只有一条写入路径）——
const one = (version, opItem, opts) => apply(version, [opItem], opts);
const add = (version, o, opts) => one(version, { op: 'add', ...o }, opts);
const update = (version, o, opts) => one(version, { op: 'update', ...o }, opts);
const remove = (version, o, opts) => one(version, { op: 'remove', ...o }, opts);
const setGroup = (version, o, opts) => one(version, { op: 'setGroup', ...o }, opts);
const moveTo = (version, o, opts) => one(version, { op: 'moveTo', ...o }, opts);
const mergeIn = (version, o, opts) => one(version, { op: 'mergeIn', ...o }, opts);
const regroup = (version, o, opts) => one(version, { op: 'regroup', ...o }, opts);
const setMeta = (version, o, opts) => one(version, { op: 'setMeta', ...o }, opts);

// ============================ 迁移与互通 ============================

// 扁平（formatVersion 1）→ 分段（formatVersion 2）。
// platform 决定非作用域条目初次落在哪一段——迁移时按「该版本产物来自哪个平台」给，
// 默认 windows（现有字典就是从 Windows 产物提取的）。
// 已经分段的字典不重复迁移：直接返回，避免把手改过的分段结构打平重来。
function migrate(version, { platform = 'common', groups = {}, notes, dryRun = false } = {}) {
  assertPlatform(platform, 'platform 参数');
  const { raw } = readRaw(version);
  const fv = raw._meta ? raw._meta.formatVersion : undefined;
  if (fv === 2) return { ok: true, already: true, changes: [] };

  const doc = {
    _meta: {
      ...(raw._meta || {}),
      version: (raw._meta && raw._meta.version) || version,
      formatVersion: 2,
      updated: new Date().toISOString().slice(0, 10),
    },
    common: {},
    windows: {},
    macos: {},
    linux: {},
    groups: {},
  };
  if (notes !== undefined) doc._meta.notes = notes;

  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    common.checkEntry(version, k, v);
    // 作用域键与全局键都进平台段：迁移时的 platform 表示「这批条目来自哪个平台的产物」，
    // 跨平台共有关系由后续的 dict-groups / 跨平台补齐步骤重新划分。
    doc[platform][k] = v;
  }
  for (const [g, keys] of Object.entries(groups)) doc.groups[g] = [...keys];

  const res = write(version, doc, { dryRun });
  return { ...res, already: false, changes: [`migrate ${Object.keys(doc[platform]).length} 条 → ${platform} 段`] };
}

// 导出为扁平对象（formatVersion 1 形态），供对照参考工具 / 兼容旧消费方。
// platform 省略时导出当前平台视角（common ∪ 当前平台段）——那正是运行时真正生效的集合。
function exportFlat(version, { platform } = {}) {
  const doc = read(version);
  const p = platform === undefined ? common.currentPlatform() : platform;
  const out = {};
  const use = p && SEGMENTS.includes(p) ? ['common', p] : ['common'];
  for (const name of use) Object.assign(out, doc[name] || {});
  return out;
}

// ============================ CLI ============================

const USAGE = `用法：node scripts/dict/dict-edit.js <子命令> <版本> [选项]

字典的唯一写入口。所有修改都先校验、再原子替换；校验不通过时原文件保持不动。
校验输出里 error 阻断写入，warning 只提示。

子命令：
  read <版本>                 打印五段结构（默认只打印统计）
  validate <版本>             一致性校验，有 error 时以非零码退出
  query <版本>                按平台 / 组 / 关键字查条目
  apply <版本> --ops <文件>    批量操作（JSON 数组），--dry-run 只预览不落盘
  add <版本> --key K --zh Z [--platform common|windows|macos|linux] [--group G]
  update <版本> --key K --zh Z [--platform P]
  remove <版本> --key K [--platform P]
  set-group <版本> --key K --group G
  move <版本> --key K --from P --to P
  merge <版本> --file <扁平JSON> [--platform P] [--group G]
  regroup <版本> --file <groups.json>
  export-flat <版本> [--platform P] [--out 文件]
  migrate <版本> [--platform P] [--groups 文件] [--notes 文本]

公共选项：
  --dry-run        走完全部校验但不落盘
  -h, --help       显示本帮助

上文的 <版本> 指 dictionaries/ 下的目录名（如 3.6.6）。
本脚本也可通过交互式入口调用：github-desktop-zh-cn dict <子命令> <版本> [选项]`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

function loadJsonArg(file, what) {
  if (!file) throw new DictError(`缺少 --${what}`);
  const p = path.resolve(file);
  if (!fs.existsSync(p)) throw new DictError(`文件不存在：${p}`);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new DictError(`${p} 不是合法 JSON：${e.message}`);
  }
}

function reportProblems(problems) {
  for (const p of problems) {
    const mark = p.level === 'error' ? '错误' : '提示';
    console.log(`  [${mark}] ${p.code}：${p.detail}${p.key ? `\n         ${p.key}` : ''}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const cmd = args._[0];
  const version = args._[1];
  if (!cmd || !version) {
    console.error(USAGE);
    process.exit(1);
  }

  try {
    switch (cmd) {
      case 'read': {
        const doc = read(version);
        if (args.segment) {
          console.log(JSON.stringify(doc[args.segment], null, 2));
        } else {
          for (const name of [...SEGMENTS, 'groups']) {
            const n = Object.keys(doc[name] || {}).length;
            console.log(`  ${name.padEnd(8)} ${name === 'groups' ? `${n} 组` : `${n} 条`}`);
          }
        }
        break;
      }
      case 'validate': {
        const { errors, warnings } = validate(version);
        console.log(`校验 ${version}：${errors.length} 项错误、${warnings.length} 项提示`);
        reportProblems([...errors, ...warnings]);
        if (errors.length) process.exit(1);
        break;
      }
      case 'query': {
        const rows = query(version, {
          platform: args.platform,
          group: args.group,
          keyword: args.keyword,
        });
        for (const r of rows) console.log(`${r.platform}\t${r.group || common.UNGROUPED}\t${r.key}\t${r.zh}`);
        console.log(`共 ${rows.length} 条`);
        break;
      }
      case 'apply': {
        const ops = loadJsonArg(args.ops, 'ops');
        if (!Array.isArray(ops)) throw new DictError('--ops 文件的内容必须是操作对象数组');
        const r = apply(version, ops, { dryRun: args.dryRun });
        console.log(`${args.dryRun ? '预览' : '已应用'} ${r.changes.length} 项：`);
        for (const c of r.changes) console.log(`  ${c}`);
        if (r.warnings.length) reportProblems(r.warnings);
        break;
      }
      case 'add': {
        const r = add(version, { key: args.key, zh: args.zh, platform: args.platform, group: args.group }, { dryRun: args.dryRun });
        console.log(`${args.dryRun ? '预览' : '已添加'}：${r.changes.join('；')}`);
        break;
      }
      case 'update':
        console.log(`已更新：${update(version, { key: args.key, zh: args.zh, platform: args.platform }, { dryRun: args.dryRun }).changes.join('；')}`);
        break;
      case 'remove':
        console.log(`已删除：${remove(version, { key: args.key, platform: args.platform }, { dryRun: args.dryRun }).changes.join('；')}`);
        break;
      case 'set-group':
        console.log(`已分组：${setGroup(version, { key: args.key, group: args.group }, { dryRun: args.dryRun }).changes.join('；')}`);
        break;
      case 'move':
        console.log(`已搬迁：${moveTo(version, { key: args.key, from: args.from, to: args.to }, { dryRun: args.dryRun }).changes.join('；')}`);
        break;
      case 'merge': {
        const entries = loadJsonArg(args.file, 'file');
        const r = mergeIn(version, { entries, platform: args.platform, group: args.group }, { dryRun: args.dryRun });
        console.log(`${args.dryRun ? '预览' : '已合并'}：${r.changes.join('；')}`);
        break;
      }
      case 'regroup': {
        const groups = loadJsonArg(args.file, 'file');
        const r = regroup(version, { groups }, { dryRun: args.dryRun });
        console.log(`${args.dryRun ? '预览' : '已重建'}：${r.changes.join('；')}`);
        break;
      }
      case 'export-flat': {
        const flat = exportFlat(version, { platform: args.platform });
        const text = `${JSON.stringify(flat, null, 2)}\n`;
        if (args.out) {
          fs.writeFileSync(args.out, text, 'utf8');
          console.log(`已导出 ${Object.keys(flat).length} 条 → ${args.out}`);
        } else {
          console.log(text);
        }
        break;
      }
      case 'migrate': {
        const groups = args.groups ? loadJsonArg(args.groups, 'groups') : {};
        const r = migrate(version, { platform: args.platform || 'common', groups, notes: args.notes, dryRun: args.dryRun });
        if (r.already) console.log(`${version} 已是 formatVersion 2，无需迁移。`);
        else console.log(`${args.dryRun ? '预览' : '已迁移'}：${r.changes.join('；')}`);
        if (r.warnings && r.warnings.length) reportProblems(r.warnings);
        break;
      }
      default:
        throw new DictError(`未知子命令：${cmd}`);
    }
  } catch (e) {
    if (e instanceof DictError) {
      console.error(`错误：${e.message}`);
      if (e.problems && e.problems.length) reportProblems(e.problems);
    } else {
      console.error(`错误：${e.message}`);
    }
    process.exit(1);
  }
}

module.exports = {
  DictError,
  read,
  query,
  validate,
  validateDoc,
  create,
  apply,
  add,
  update,
  remove,
  setGroup,
  moveTo,
  mergeIn,
  regroup,
  setMeta,
  migrate,
  exportFlat,
  dictPath,
  groupIndex,
  USAGE,
  main,
};

if (require.main === module) main();
