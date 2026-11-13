// version-profile.js — 每个版本的「替换逻辑档案」（dictionaries/<版本>/patch.json）
//
// 背景：3.6.x 各版本的官方产物结构并不相同（注入锚点、右键菜单标签来源都可能变），而
// 「一套全局替换逻辑服务所有版本字典」意味着引擎永远按最新版实测到的结构下手——旧版本
// 只是「没报错」，不是「验证过」。本模块把**版本相关的替换逻辑**从代码里搬进数据：
//
//   dictionaries/<版本>/zh-CN.json   该版本的翻译字典（唯一翻译资产，不变）
//   dictionaries/<版本>/patch.json   该版本的替换逻辑档案（本模块负责）
//
// 档案是**数据**，引擎只解释它、不执行其中的代码（不 require 远端代码、不 eval）。它声明：
//   - 替换对象（targets，须与 common.TARGETS 一致）；
//   - 注入策略与参数：右键菜单汉化（角色表/标签表/是否启用）、更新管控（方法锚点、注入点锚点、
//     每个锚点的期望出现次数）；
//   - sourcemap 可用性；
//   - 两平台官方产物的探测证据（产物名、版本、文件字节数与 sha256、锚点实测次数、标签字面量
//     出现位置与次数）。
//
// 引擎语义（**拒绝而不是降级**）：
//   - 档案缺失 / schemaVersion 不认识 / 结构非法 → 明确拒绝，并给可执行的下一步；
//   - 锚点出现次数与档案期望不符 → 拒绝（0 次 = 产物结构变了；多次 = 锚点不再唯一 / 产物不是
//     该版本官方原版）。绝不静默套用「最新版」逻辑；
//   - 策略名未知 → 拒绝并列出可用策略（多写一个键意味着有人以为它生效了）；
//   - 字典与档案必须成对：只有一半视为不完整，明确报缺哪份（见 pairStatus）。
//
// 探测（probe）只读官方产物、不执行其中任何代码：两平台产物经 dict/release-assets.js 用
// HTTP Range 取 app 目录到本地临时目录，再在本地逐项测量。右键菜单的 role→英文标签表从
// 产物 sourcemap 里的官方源码（main-process/menu/build-default-menu.ts）推导，并用该平台
// 产物 main.js 里的标签字面量交叉验证——标签错一个字，注入后再由字典替换就会静默落空，
// 所以这里宁可探测失败，也不把「大概是这样」写进档案。
//
// 写入口：档案的唯一写入口是本模块的 writeProfile()（同 dict-edit.js 之于字典）。探测命令：
//   node scripts/version-profile.js probe --version 3.6.7 --write
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const common = require('./common.js');

// 档案格式版本：结构有破坏性变化时 +1；引擎只认自己认识的那个版本，**不猜测**旧/新结构。
const SCHEMA_VERSION = 1;

// 档案文件名（与字典 zh-CN.json 同目录）。两者必须成对存在，缺一不可。
const PROFILE_FILE = 'patch.json';

// —— 支持的注入策略（策略名是档案与引擎之间的契约）——
// params：该策略在档案 injections.<策略名> 里引用的锚点 id 列表（按 id 引用 anchors 里的定义，
//         避免同一个锚点（如注入点）在多个策略里各写一遍字符串而漂移）。
const STRATEGIES = {
  'context-menu': {
    label: '右键菜单汉化',
    params: ['injectionPoint'],
    // 额外参数：labels（windows / macos 两张 role → 英文标签表）。标签必须是该平台官方菜单
    // 实际使用的英文原文，注入后由同一次字典替换译掉——字典键与它逐字相同才有效。
  },
  'update-control': {
    label: '更新管控',
    params: ['injectionPoint', 'methodAnchor'],
  },
};

// 官方产物只发 Windows 与 macOS：这两个平台是**探测证据**的来源，也是档案 labels 的两张表。
// 其它平台（Linux）没有官方产物可探测，沿用 windows 表（与 build-default-menu.ts 的
// __DARWIN__ 三目一致：非 darwin 走带 & 助记符的那套），这一点在 labels 的取用处分档说明。
const PLATFORM_KEYS = ['windows', 'macos'];

// 注入点锚点：两个注入块都插在产物末尾 sourceMappingURL 注释之前（IIFE 之外，require 是原生
// CommonJS）。档案记录实测次数；次数为 0 时注入退回「追加到文件末尾」（现行为），档案用
// placement: 'append-eof' 表达。文案里的换行是**锚点的一部分**（前面是行首，避免命中别的注释）。
const INJECTION_POINT_TEXT = '\n//# sourceMappingURL=';

// 更新管控的方法闸门锚点：3.6.6 / 3.6.7 两平台实测均唯一（checkForUpdates 共出现 3 次，
// 只有方法名那处带 async 前缀）。方法名形态在旧版本未必一样，所以它由档案声明、探测实测，
// 不在引擎里写死。
const UPDATE_CONTROL_ANCHOR_TEXT = 'async checkForUpdates(';

// Electron 内建菜单角色里「产物没有显式 label」的那几个：标签由 Electron 运行时生成。
// 右键菜单注入要自己造出英文字面量再让字典译掉，故档案必须给出这个英文标签；
// 目前只有 delete 一个（菜单栏 Edit 子菜单没有 delete 项，其标签是 Electron 的英文默认值）。
const ELECTRON_DEFAULT_ROLE_LABELS = { delete: 'Delete' };

// Edit 子菜单里必须能推导出标签的角色集合：缺一个就说明官方菜单结构变了（或 sourcemap 结构
// 变了），探测直接失败并要求人工确认——不生成「猜出来」的档案。
const REQUIRED_MENU_ROLES = ['undo', 'redo', 'cut', 'copy', 'paste', 'selectall'];

// ============================ 小工具 ============================

function fail(message, hint) {
  const e = new Error(message);
  if (hint) e.hint = hint;
  throw e;
}

// 子串出现次数（不重叠）。锚点断言与证据记录共用同一口径——两者口径不一致时，探测生成的
// 档案会在引擎断言处失败，那种事最难查。
function countOccurrences(text, needle) {
  if (typeof needle !== 'string' || needle.length === 0) {
    throw new Error('锚点文本必须是非空字符串');
  }
  let count = 0;
  let at = 0;
  for (;;) {
    const hit = text.indexOf(needle, at);
    if (hit < 0) return count;
    count++;
    at = hit + 1;
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function mustString(value, what) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${what}必须是非空字符串`);
  }
  return value;
}

// 运行平台 → 档案里 labels 的平台键。非 darwin（含 linux）沿用 windows 表，见 PLATFORM_KEYS 处说明。
function profilePlatform(platform = process.platform) {
  return platform === 'darwin' ? 'macos' : 'windows';
}

// ============================ 路径与读取 ============================

// 档案路径：<数据根>/dictionaries/<版本>/patch.json。数据根由 common.dataRoot() 决定，
// 本函数只拼路径——脚本不得自行假设工作目录（与 common 的纪律一致）。
function profileFile(version) {
  return path.join(common.dataRoot(), 'dictionaries', version, PROFILE_FILE);
}

// 内嵌资源键（SEA 单文件产物）：与字典同一次构建内嵌（tools/build.js）。
function profileAssetKey(version) {
  return `dictionaries/${version}/${PROFILE_FILE}`;
}

// 是否存在该版本的内嵌档案（源码态恒为假）
function hasEmbeddedProfile(version) {
  return common.embeddedAsset(profileAssetKey(version)) !== null;
}

// 档案来源：外部文件优先、内嵌兜底（与字典的「外部优先、内嵌兜底」同一套语义）。
// 返回 { text, source: 'external'|'embedded', path, label }。
function readProfileText(version) {
  const file = profileFile(version);
  if (fs.existsSync(file)) {
    return { text: fs.readFileSync(file, 'utf8'), source: 'external', path: file, label: file };
  }
  const embedded = common.embeddedAsset(profileAssetKey(version));
  if (embedded !== null) {
    return {
      text: embedded,
      source: 'embedded',
      path: null,
      label: `内嵌档案 ${profileAssetKey(version)}`,
    };
  }
  fail(
    `缺少 GitHub Desktop ${version} 的替换逻辑档案：${file}（也没有内嵌档案）`,
    '缺档案时不会套用其它版本的替换逻辑（锚点与注入策略必须按该版本官方产物实测）。' +
      '请先获取该版本的字典与档案（工具菜单「同步字典」会成对拉取），' +
      `或本地探测生成：node scripts/version-profile.js probe --version ${version} --write。`
  );
}

// 加载并校验档案。返回 { profile, source, path, label }；任何结构问题都抛可读错误。
function loadProfile(version) {
  const { text, source, path: filePath, label } = readProfileText(version);
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    fail(
      `替换逻辑档案不是合法 JSON：${label}（${e.message}）`,
      '档案损坏时不会拿其它版本的档案凑合；请重新获取该版本档案（或重新探测生成）。'
    );
  }
  const profile = validateProfile(raw, { version });
  return { profile, source, path: filePath, label };
}

// ============================ 结构校验（SSOT） ============================
// 锚点定义：{ text, file, placement: 'unique'|'before-last'|'append-eof', expected }
//   unique      —— 产物里必须恰好出现一次（注入器用 indexOf / 唯一性判断）；
//   before-last —— 出现 expected 次，注入器插在最后一次之前（末尾 sourceMappingURL 注释）；
//   append-eof  —— 产物里 0 次，注入器追加到文件末尾（没有 sourceMappingURL 注释时的兜底）。
function validateAnchor(id, raw) {
  if (!isPlainObject(raw)) fail(`档案 anchors.${id} 必须是对象`);
  const text = mustString(raw.text, `档案 anchors.${id}.text `);
  const file = mustString(raw.file, `档案 anchors.${id}.file `);
  if (!common.TARGETS.includes(file)) {
    fail(`档案 anchors.${id}.file 不是引擎支持的替换对象：${file}（可用：${common.TARGETS.join(' / ')}）`);
  }
  const placement = raw.placement;
  if (!['unique', 'before-last', 'append-eof'].includes(placement)) {
    fail(
      `档案 anchors.${id}.placement 不受支持：${JSON.stringify(placement)}（可用：unique / before-last / append-eof）`
    );
  }
  if (!Number.isInteger(raw.expected) || raw.expected < 0) {
    fail(`档案 anchors.${id}.expected 必须是非负整数（实测出现次数）`);
  }
  if (placement === 'unique' && raw.expected !== 1) {
    fail(`档案 anchors.${id}：placement=unique 要求 expected=1（当前 ${raw.expected}）`);
  }
  if (placement === 'before-last' && raw.expected < 1) {
    fail(`档案 anchors.${id}：placement=before-last 要求 expected≥1（当前 ${raw.expected}）`);
  }
  if (placement === 'append-eof' && raw.expected !== 0) {
    fail(`档案 anchors.${id}：placement=append-eof 要求 expected=0（当前 ${raw.expected}）`);
  }
  return { text, file, placement, expected: raw.expected };
}

function validateLabels(platform, raw) {
  if (!isPlainObject(raw) || Object.keys(raw).length === 0) {
    fail(`档案 injections.context-menu.labels.${platform} 必须是「role → 英文标签」的非空对象`);
  }
  const out = {};
  for (const [role, label] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9]*$/.test(role)) {
      fail(`档案 injections.context-menu.labels.${platform} 的角色名必须是小写字母开头的小写串：${JSON.stringify(role)}`);
    }
    mustString(label, `档案 injections.context-menu.labels.${platform}.${role} `);
    out[role] = label;
  }
  return out;
}

// 注入策略参数校验。返回规范化后的策略对象（含 enabled）：
//   { enabled, injectionPoint, [methodAnchor], [labels], [reason] }
function validateInjection(name, raw, anchors) {
  const def = STRATEGIES[name];
  if (!isPlainObject(raw)) fail(`档案 injections.${name} 必须是对象`);
  if (typeof raw.enabled !== 'boolean') {
    fail(`档案 injections.${name}.enabled 必须是布尔值（true/false）`);
  }
  const out = { enabled: raw.enabled };
  // 禁用的策略也允许写 reason（探测记录为什么禁用），但不再要求锚点/参数齐全。
  if (raw.reason !== undefined) mustString(raw.reason, `档案 injections.${name}.reason `);
  if (raw.reason !== undefined) out.reason = raw.reason;
  if (!raw.enabled) return out;

  for (const param of def.params) {
    const anchorId = raw[param];
    mustString(anchorId, `档案 injections.${name}.${param}（锚点 id）`);
    if (!Object.prototype.hasOwnProperty.call(anchors, anchorId)) {
      fail(
        `档案 injections.${name}.${param} 引用了不存在的锚点：${anchorId}` +
          `（已定义：${Object.keys(anchors).join(' / ') || '无'}）`
      );
    }
    out[param] = anchorId;
  }
  if (name === 'context-menu') {
    if (!isPlainObject(raw.labels)) {
      fail(`档案 injections.context-menu.labels 必须是对象（windows / macos 两张 role → 英文标签表）`);
    }
    out.labels = {};
    for (const platform of PLATFORM_KEYS) {
      out.labels[platform] = validateLabels(platform, raw.labels[platform]);
    }
    const winRoles = Object.keys(out.labels.windows).sort().join(',');
    const macRoles = Object.keys(out.labels.macos).sort().join(',');
    if (winRoles !== macRoles) {
      fail(
        `档案 injections.context-menu.labels 两个平台的角色集合必须一致：` +
          `windows=[${Object.keys(out.labels.windows).join(' / ')}]，macos=[${Object.keys(out.labels.macos).join(' / ')}]`
      );
    }
  }
  return out;
}

function validateSourcemaps(raw) {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) fail('档案 sourcemaps 必须是对象（文件名 → 布尔值）');
  const out = {};
  for (const [file, available] of Object.entries(raw)) {
    if (!common.TARGETS.includes(file)) {
      fail(`档案 sourcemaps 的键必须是替换对象：${file}（可用：${common.TARGETS.join(' / ')}）`);
    }
    if (typeof available !== 'boolean') fail(`档案 sourcemaps.${file} 必须是布尔值`);
    out[file] = available;
  }
  return out;
}

function validateEvidenceSourcemaps(raw) {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) fail('档案 evidence.platforms.<平台>.sourcemaps 必须是对象');
  const out = {};
  for (const file of common.TARGETS) {
    const entry = raw[file];
    if (!isPlainObject(entry)) {
      fail(`档案 evidence.platforms.<平台>.sourcemaps.${file} 缺失（应记录该文件 sourcemap 是否可用）`);
    }
    if (typeof entry.present !== 'boolean' || typeof entry.sourcesContent !== 'boolean') {
      fail(`档案 evidence.platforms.<平台>.sourcemaps.${file} 的 present / sourcesContent 必须是布尔值`);
    }
    out[file] = { present: entry.present, sourcesContent: entry.sourcesContent };
  }
  return out;
}

// 探测证据校验（可选字段：手工夹具/迁移期档案可以不带证据；probe 生成的档案必带）。
// 有证据时逐项核对「两平台实测值」与「档案声明值」一致——这是「档案自洽」的机器检查：
// 期望次数不是拍脑袋写的，而是两平台官方产物各测了一遍且结果相同。
function validateEvidence(raw, { version, anchors, injections }) {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) fail('档案 evidence 必须是对象');
  if (!isPlainObject(raw.platforms)) fail('档案 evidence.platforms 必须是对象（windows / macos）');
  // probe 元信息（可缺省）：记录探测时间、工具、平台/架构与标签推导所用的官方源码文件。
  // 它在证据里的作用是「可追溯」——谁在什么时候用什么命令、从两平台产物的哪个源文件推出来的。
  let probe;
  if (raw.probe !== undefined) {
    if (!isPlainObject(raw.probe)) fail('档案 evidence.probe 必须是对象');
    probe = {
      at: mustString(raw.probe.at, '档案 evidence.probe.at '),
      tool: mustString(raw.probe.tool, '档案 evidence.probe.tool '),
      platforms: Array.isArray(raw.probe.platforms) ? raw.probe.platforms.map((x) => mustString(x, '档案 evidence.probe.platforms 的条目 ')) : [],
      archs: isPlainObject(raw.probe.archs) ? { ...raw.probe.archs } : {},
    };
    if (raw.probe.menuSource !== undefined) probe.menuSource = mustString(raw.probe.menuSource, '档案 evidence.probe.menuSource ');
  }
  const platforms = {};
  for (const platform of PLATFORM_KEYS) {
    const p = raw.platforms[platform];
    if (!isPlainObject(p)) fail(`档案 evidence.platforms.${platform} 缺失（探测证据必须覆盖两个官方平台）`);
    const out = {
      platform,
      arch: mustString(p.arch, `档案 evidence.platforms.${platform}.arch `),
      assetName: mustString(p.assetName, `档案 evidence.platforms.${platform}.assetName `),
      appVersion: mustString(p.appVersion, `档案 evidence.platforms.${platform}.appVersion `),
    };
    if (out.appVersion !== version) {
      fail(
        `档案证据的平台版本（${out.appVersion}）与档案版本（${version}）不一致——产物取错了版本`
      );
    }
    if (p.assetBytes !== undefined) {
      if (!Number.isInteger(p.assetBytes) || p.assetBytes <= 0) fail(`档案 evidence.platforms.${platform}.assetBytes 必须是正整数`);
      out.assetBytes = p.assetBytes;
    }
    if (p.archiveEntries !== undefined) {
      if (!Number.isInteger(p.archiveEntries) || p.archiveEntries <= 0) fail(`档案 evidence.platforms.${platform}.archiveEntries 必须是正整数`);
      out.archiveEntries = p.archiveEntries;
    }
    if (p.appDir !== undefined) out.appDir = mustString(p.appDir, `档案 evidence.platforms.${platform}.appDir `);
    if (!isPlainObject(p.files)) fail(`档案 evidence.platforms.${platform}.files 缺失`);
    out.files = {};
    for (const file of common.TARGETS.concat(['package.json'])) {
      const f = p.files[file];
      if (!isPlainObject(f)) fail(`档案 evidence.platforms.${platform}.files.${file} 缺失`);
      if (!Number.isInteger(f.bytes) || f.bytes < 0) fail(`档案 evidence.platforms.${platform}.files.${file}.bytes 必须是非负整数`);
      const hash = mustString(f.sha256, `档案 evidence.platforms.${platform}.files.${file}.sha256 `);
      if (!/^[0-9a-f]{64}$/.test(hash)) fail(`档案 evidence.platforms.${platform}.files.${file}.sha256 必须是 64 位小写十六进制`);
      out.files[file] = { bytes: f.bytes, sha256: hash };
    }
    if (p.sourcemaps !== undefined) out.sourcemaps = validateEvidenceSourcemaps(p.sourcemaps);
    // 证据记录的是「探测时测到了什么」，可以比档案声明多：禁用的策略（如 update-control）不再
    // 定义锚点，但它的实测次数仍应留在证据里供人工追溯，故这里不要求 id 必须在 anchors 里。
    if (!isPlainObject(p.anchors)) fail(`档案 evidence.platforms.${platform}.anchors 缺失（锚点实测次数）`);
    out.anchors = {};
    for (const [id, count] of Object.entries(p.anchors)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) fail(`档案证据里的锚点 id 形态非法：${JSON.stringify(id)}`);
      if (!Number.isInteger(count) || count < 0) fail(`档案 evidence.platforms.${platform}.anchors.${id} 必须是非负整数`);
      out.anchors[id] = count;
    }
    if (!isPlainObject(p.labels)) fail(`档案 evidence.platforms.${platform}.labels 缺失`);
    out.labels = {};
    for (const [role, info] of Object.entries(p.labels)) {
      if (!isPlainObject(info)) fail(`档案 evidence.platforms.${platform}.labels.${role} 必须是对象`);
      out.labels[role] = {
        label: mustString(info.label, `档案 evidence.platforms.${platform}.labels.${role}.label `),
        origin: mustString(info.origin, `档案 evidence.platforms.${platform}.labels.${role}.origin `),
        bundleLiteralCount: Number.isInteger(info.bundleLiteralCount) ? info.bundleLiteralCount : 0,
      };
      if (info.source !== undefined) out.labels[role].source = mustString(info.source, `档案 evidence.platforms.${platform}.labels.${role}.source `);
    }
    platforms[platform] = out;
  }

  // 证据 ↔ 声明 一致性：每个声明为启用策略所需的锚点，两平台实测次数必须等于档案期望次数。
  for (const [id, anchor] of Object.entries(anchors)) {
    const used = strategyUsesAnchor(injections, id);
    if (!used) continue;
    for (const platform of PLATFORM_KEYS) {
      const measured = platforms[platform].anchors[id];
      if (measured === undefined) {
        fail(`档案证据缺锚点实测值：evidence.platforms.${platform}.anchors.${id}（档案声明了该锚点）`);
      }
      if (measured !== anchor.expected) {
        fail(
          `档案证据与声明不一致：${platform} 实测锚点 ${id} 出现 ${measured} 次，档案期望 ${anchor.expected} 次。` +
            `期望次数必须来自两平台官方产物的实测（探测生成），不能手填。`
        );
      }
    }
  }
  // 证据 ↔ 标签表 一致性（启用了右键菜单策略时）：声明表里的每个 role 都要在对应平台证据里
  // 记到同一个标签；证据多出来的 role（如 delete）只做记录，不要求进声明表。
  const menu = injections['context-menu'];
  if (menu && menu.enabled) {
    for (const platform of PLATFORM_KEYS) {
      for (const [role, label] of Object.entries(menu.labels[platform])) {
        const info = platforms[platform].labels[role];
        if (!info) {
          fail(`档案证据缺标签记录：evidence.platforms.${platform}.labels.${role}（声明表里有该角色）`);
        }
        if (info.label !== label) {
          fail(
            `档案标签与证据不一致：${platform}/${role} 声明 ${JSON.stringify(label)}，` +
              `探测证据是 ${JSON.stringify(info.label)}`
          );
        }
      }
    }
  }
  return { probe, platforms };
}

// 某锚点是否被某个「启用的策略」引用（锚点断言与证据校验都按它筛）。
function strategyUsesAnchor(injections, anchorId) {
  for (const [name, entry] of Object.entries(injections)) {
    if (!entry || entry.enabled === false) continue;
    const def = STRATEGIES[name];
    if (!def) continue;
    for (const param of def.params) if (entry[param] === anchorId) return true;
  }
  return false;
}

// 校验整份档案，返回规范化对象（不原地改传入对象）。
function validateProfile(raw, { version } = {}) {
  if (!isPlainObject(raw)) fail('替换逻辑档案必须是一个 JSON 对象');
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    fail(
      `替换逻辑档案的 schemaVersion 不受支持：${JSON.stringify(raw.schemaVersion)}（引擎支持 ${SCHEMA_VERSION}）`,
      '档案与工具版本不匹配时不要强行使用：请升级/同步工具与字典档案，或按当前 schema 重新探测生成。'
    );
  }
  if (version !== undefined && raw.version !== version) {
    fail(
      `替换逻辑档案的版本（${JSON.stringify(raw.version)}）与目标版本（${version}）不一致`,
      '版本错配可能导致应用无法启动；请获取与安装版本对应的档案（--version 指定），不要改名绕过。'
    );
  }
  mustString(raw.version, '档案 version ');
  if (raw.targets === undefined || !Array.isArray(raw.targets) || raw.targets.length === 0) {
    fail('档案 targets 必须是非空数组（替换对象清单）');
  }
  for (const f of raw.targets) mustString(f, '档案 targets 的条目 ');
  if (raw.targets.join(',') !== common.TARGETS.join(',')) {
    fail(
      `档案 targets 与引擎支持的替换对象不一致：档案 [${raw.targets.join(' / ')}]，` +
        `引擎 [${common.TARGETS.join(' / ')}]。替换对象的清单是引擎与档案的共同契约，不能单方面改。`
    );
  }

  if (!isPlainObject(raw.anchors) || Object.keys(raw.anchors).length === 0) {
    fail('档案 anchors 必须是非空对象（锚点 id → 定义）');
  }
  const anchors = {};
  for (const [id, anchor] of Object.entries(raw.anchors)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) fail(`档案里的锚点 id 形态非法：${JSON.stringify(id)}`);
    anchors[id] = validateAnchor(id, anchor);
  }

  if (!isPlainObject(raw.injections)) fail('档案 injections 必须是对象（策略名 → 参数）');
  const injections = {};
  for (const [name, entry] of Object.entries(raw.injections)) {
    if (!STRATEGIES[name]) {
      fail(
        `档案声明了未知的替换策略：${JSON.stringify(name)}（可用：${Object.keys(STRATEGIES).join(' / ')}）`,
        '未知策略不会被静默忽略——多写一个键意味着有人以为它生效了。请升级引擎或从档案删除该键。'
      );
    }
    injections[name] = validateInjection(name, entry, anchors);
  }

  const sourcemaps = validateSourcemaps(raw.sourcemaps);
  const evidence = validateEvidence(raw.evidence, { version, anchors, injections });

  return {
    schemaVersion: SCHEMA_VERSION,
    version: raw.version,
    generatedAt: raw.generatedAt === undefined ? undefined : mustString(raw.generatedAt, '档案 generatedAt '),
    generator: raw.generator === undefined ? undefined : mustString(raw.generator, '档案 generator '),
    targets: [...raw.targets],
    sourcemaps,
    anchors,
    injections,
    evidence,
  };
}

// ============================ 策略解析 ============================

// 该版本档案是否声明并启用了某策略（未声明等价于不支持）。
function hasStrategy(profile, name) {
  if (!STRATEGIES[name]) fail(`未知替换策略：${name}（可用：${Object.keys(STRATEGIES).join(' / ')}）`);
  const entry = profile.injections[name];
  return !!entry && entry.enabled !== false;
}

// 解析某策略在**当前平台**的参数。返回注入器可直接使用的值：
//   context-menu   → { label, labels: {role→英文标签}, injectionPoint: {text, placement, expected} }
//   update-control → { label, injectionPoint, methodAnchor }
// 未声明 / 未启用 → 明确失败（附下一步），不静默跳过。
function strategy(profile, name, { platform = process.platform } = {}) {
  const def = STRATEGIES[name];
  if (!def) fail(`未知替换策略：${name}（可用：${Object.keys(STRATEGIES).join(' / ')}）`);
  const entry = profile.injections[name];
  const where = profileFile(profile.version);
  if (!entry) {
    fail(
      `该版本替换逻辑档案未声明「${def.label}」策略（${name}）：${where}`,
      '该版本的官方产物可能不支持这项注入；请去掉对应操作（如 --update-control），或等待该版本档案支持。'
    );
  }
  if (entry.enabled === false) {
    fail(
      `该版本替换逻辑档案未启用「${def.label}」策略：${where}` +
        (entry.reason ? `（探测记录：${entry.reason}）` : ''),
      '档案按官方产物实测结果标记为不支持；请去掉对应操作，或等待该版本档案支持。'
    );
  }
  const anchors = {};
  for (const param of def.params) {
    const anchor = profile.anchors[entry[param]];
    if (!anchor) fail(`档案内部不一致：策略 ${name} 引用的锚点 ${entry[param]} 不存在`);
    anchors[param] = anchor;
  }
  if (name === 'context-menu') {
    const key = profilePlatform(platform);
    const labels = entry.labels[key];
    if (!isPlainObject(labels) || Object.keys(labels).length === 0) {
      fail(`档案内部不一致：injections.context-menu.labels.${key} 为空`);
    }
    return { name, label: def.label, labels: { ...labels }, injectionPoint: anchors.injectionPoint };
  }
  return {
    name,
    label: def.label,
    injectionPoint: anchors.injectionPoint,
    methodAnchor: anchors.methodAnchor,
  };
}

// ============================ 锚点断言 ============================

// 收集某次操作实际要用的锚点（按策略筛）：strategies 省略时 = 所有启用的策略。
// 只断言「这次真的要注入的策略」所需的锚点——只汉化（i18n）不该被更新管控的锚点变化挡住；
// 但一旦请求了该操作，锚点不符就必须拒绝（绝不带着错的锚点往产物里插代码）。
function anchorsFor(profile, strategies) {
  const names = strategies || Object.keys(profile.injections);
  const ids = new Set();
  for (const name of names) {
    const entry = profile.injections[name];
    if (!entry || entry.enabled === false) continue;
    const def = STRATEGIES[name];
    if (!def) continue;
    for (const param of def.params) {
      if (entry[param]) ids.add(entry[param]);
    }
  }
  return [...ids].map((id) => ({ id, ...profile.anchors[id] }));
}

// 对产物的某个文件断言锚点出现次数。返回 { 锚点 id → 实测次数 }；不符则抛错（含实测/期望与
// 可执行下一步）。file 必须是 common.TARGETS 之一；该文件没有锚点定义时返回空对象。
function assertAnchors(content, profile, { file, strategies } = {}) {
  if (!common.TARGETS.includes(file)) {
    fail(`锚点断言的文件不是引擎支持的替换对象：${file}`);
  }
  const anchors = anchorsFor(profile, strategies).filter((a) => a.file === file);
  const counts = {};
  for (const anchor of anchors) {
    const actual = countOccurrences(content, anchor.text);
    counts[anchor.id] = actual;
    const expected = anchor.placement === 'append-eof' ? 0 : anchor.expected;
    if (actual !== expected) {
      const structure =
        actual === 0
          ? '产物里找不到该锚点——官方产物结构可能变了，或文件不是该版本的产物'
          : `锚点出现 ${actual} 次而档案期望 ${expected} 次——锚点不再唯一，或文件不是该版本官方原版`;
      fail(
        `锚点不符（${profile.version} / ${file}）：${JSON.stringify(anchor.text)} 出现 ${actual} 次，` +
          `档案期望 ${expected} 次。${structure}。`,
        `本次操作已拒绝（不会带着错的锚点往产物里插代码）。请确认安装的确是官方 ${profile.version}` +
          `（--path 可指向官方产物目录），或重新探测生成档案：` +
          `node scripts/version-profile.js probe --version ${profile.version} --write`
      );
    }
  }
  return counts;
}

// ============================ 成对校验 ============================

// 字典与档案的成对状态（本地口径：外部文件 ∪ 内嵌资源）。返回
//   { version, dict, profile, paired, missing: ['zh-CN.json'|'patch.json', …] }
// 两者必须成对：只有一半视为不完整——引擎会拒绝，流水线应在同步/产出时把另一半一起补齐。
function pairStatus(version) {
  const dict = fs.existsSync(common.dictFile(version)) || common.hasEmbeddedDict(version);
  const profile = fs.existsSync(profileFile(version)) || hasEmbeddedProfile(version);
  const missing = [];
  if (!dict) missing.push('zh-CN.json');
  if (!profile) missing.push(PROFILE_FILE);
  return { version, dict, profile, paired: dict && profile, missing };
}

// 成对校验：不完整时抛可读错误（缺哪份 + 怎么补）。patch/restore/verify 与流水线共用。
function assertPair(version) {
  const status = pairStatus(version);
  if (status.paired) return status;
  fail(
    `GitHub Desktop ${version} 的字典与替换逻辑档案不完整：缺 ${status.missing.join(' 与 ')}`,
    '字典（翻译）与档案（该版本的替换逻辑）必须成对存在，缺一半时不会用其它版本凑合。' +
      `请同步该版本的字典与档案（工具菜单「同步字典」/ 在线获取），或本地探测生成档案：` +
      `node scripts/version-profile.js probe --version ${version} --write`
  );
}

// 本机**成对完整**的版本列表（外部文件 ∪ 内嵌资源；升序，与 common.listDictVersions 同序）。
// GUI/CLI 的「切换版本」「有没有字典」判定用它：只有字典没有档案的版本不算可用——引擎会拒绝，
// 界面若标成「有字典」，用户点了汉化才报错（见 docs/design/version-profile/design.md §8.4）。
// 注意保留 common.listDictVersions() 原义（字典存在），不要直接改它：它被字典维护、构建内嵌
// 等「只看字典」的场景使用，语义改成成对会扩散到一堆无关调用点。
function listPairVersions() {
  return common.listDictVersions().filter((version) => pairStatus(version).paired);
}

// ============================ 写入口 ============================

// 档案的唯一写入口：先整份校验、再写 .part 改名（原子落盘，失败不留半截文件）。
// overwrite=false 时已存在即拒绝（探测默认不覆盖已提交的档案，防止误操作冲掉人工核对过的版本）。
function writeProfile(version, profile, { overwrite = false, outFile = null } = {}) {
  const normalized = validateProfile(profile, { version });
  const target = outFile ? path.resolve(outFile) : profileFile(version);
  if (fs.existsSync(target) && !overwrite) {
    fail(
      `替换逻辑档案已存在：${target}`,
      '探测默认不覆盖已有档案（防止误操作冲掉已核对过的版本）；确认要替换时加 --overwrite。'
    );
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const text = `${JSON.stringify(normalized, null, 2)}\n`;
  const part = `${target}.part`;
  fs.writeFileSync(part, text, 'utf8');
  fs.renameSync(part, target);
  return target;
}

// ============================ 探测 ============================

// sourcemap 里的官方源码：读 map，按 sources 后缀找目标文件，返回 { file, content }。
// 找不到或没有 sourcesContent 时抛错（探测依赖它推导右键菜单标签，不猜）。
function readSourceFromMap(mapPath, suffix) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  } catch (e) {
    fail(`读取 sourcemap 失败：${mapPath}（${e.message}）`);
  }
  const sources = Array.isArray(raw.sources) ? raw.sources : [];
  const contents = Array.isArray(raw.sourcesContent) ? raw.sourcesContent : [];
  const index = sources.findIndex((s) => typeof s === 'string' && s.endsWith(suffix));
  if (index < 0) {
    fail(
      `产物的 sourcemap 里没有 ${suffix}：${mapPath}`,
      '右键菜单标签表要从官方源码推导；sourcemap 结构变了需要人工确认，探测不会瞎猜标签。'
    );
  }
  const content = contents[index];
  if (typeof content !== 'string' || content.length === 0) {
    fail(
      `sourcemap 缺少 sourcesContent，无法读取官方源码：${mapPath}（${suffix}）`,
      '探测需要产物内嵌的官方源码（sourcesContent）；该版本产物可能没有带完整 sourcemap。'
    );
  }
  return { file: sources[index], content };
}

// 从 `label: __DARWIN__ ? 'Mac' : '&Win'` 里取两个平台的标签。返回 null 表示形态不认识。
function parseDarwinTernary(expr) {
  const m = /^__DARWIN__\s*\?\s*'((?:[^'\\]|\\.)*)'\s*:\s*'((?:[^'\\]|\\.)*)'$/.exec(expr.trim());
  if (!m) return null;
  return { macos: m[1], windows: m[2] };
}

// 在 TS 源码里从 start（'[' 的下标）扫到配对的 ']'，跳过字符串 / 模板 / 行注释 / 块注释。
// 只用于解析官方源码里的 Edit 子菜单块——不需要完整 TS 解析器，但要避免被字符串里的括号带偏。
function matchBracket(source, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      if (nl < 0) return -1;
      i = nl;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// 从 build-default-menu.ts 源码推导 Edit 子菜单的 role → 英文标签（两平台）。
// 只认 Edit 子菜单块：右键菜单展开项与菜单栏 Edit 子菜单是同一批 role，标签沿用同一批英文
// 原文，字典早已覆盖，注入后由同一次字典替换译掉。返回：
//   { labels: { windows: {role: label}, macos: {...} },
//     evidence: { role: { windows, macos, source: '文件:行号', origin: 'build-default-menu' } } }
function deriveMenuLabels(menuSource) {
  const src = menuSource.content;
  const editMatch = /label:\s*__DARWIN__\s*\?\s*'Edit'\s*:\s*'&Edit'/.exec(src);
  if (!editMatch) {
    fail(
      `官方源码里找不到 Edit 菜单的定义：${menuSource.file}`,
      '菜单结构变了，右键菜单标签表无法自动推导；请人工核对 build-default-menu.ts 后更新探测规则。'
    );
  }
  const subAt = src.indexOf('submenu:', editMatch.index);
  if (subAt < 0) fail(`官方源码里 Edit 菜单没有 submenu：${menuSource.file}`);
  const lb = src.indexOf('[', subAt);
  if (lb < 0) fail(`官方源码里 Edit 菜单的 submenu 不是数组：${menuSource.file}`);
  const rb = matchBracket(src, lb);
  if (rb < 0) fail(`官方源码里 Edit 菜单的 submenu 括号不配对：${menuSource.file}`);
  const block = src.slice(lb + 1, rb);
  const blockOffset = lb + 1;

  const lineOf = (offset) => src.slice(0, offset).split('\n').length;
  const found = {}; // role → { windows, macos, source, origin }
  const record = (role, label, offset, origin) => {
    if (found[role]) {
      fail(
        `官方源码里角色 ${role} 出现了两套标签（${JSON.stringify(found[role])} / ${JSON.stringify(label)}），` +
          `探测无法判断该用哪套：${menuSource.file}`
      );
    }
    found[role] = {
      windows: label.windows,
      macos: label.macos,
      source: `${menuSource.file}:${lineOf(offset)}`,
      origin,
    };
  };

  // 形态一：单行 { role: 'undo', label: __DARWIN__ ? 'Undo' : '&Undo' }
  const withRole = /\{\s*role:\s*'([a-z][a-z0-9]*)'\s*,\s*label:\s*(__DARWIN__\s*\?\s*'[^']*'\s*:\s*'[^']*')\s*\}/g;
  for (const m of block.matchAll(withRole)) {
    const labels = parseDarwinTernary(m[2]);
    if (!labels) {
      fail(`官方源码里角色 ${m[1]} 的标签不是 __DARWIN__ 三目形态：${menuSource.file}`);
    }
    record(m[1], labels, blockOffset + m.index, 'build-default-menu');
  }

  // 形态二：Select All 项没有 role（走 click 事件），靠 accelerator CmdOrCtrl+A 识别。
  const selectAll =
    /label:\s*(__DARWIN__\s*\?\s*'((?:[^'\\]|\\.)*)'\s*:\s*'((?:[^'\\]|\\.)*)')\s*,\s*(?:[^,}]*,\s*)*accelerator:\s*'CmdOrCtrl\+A'/g;
  for (const m of block.matchAll(selectAll)) {
    record('selectall', { macos: m[2], windows: m[3] }, blockOffset + m.index, 'build-default-menu');
  }

  // 形态三：只写 role、label 交给 Electron 运行时生成（如 delete）
  const roleOnly = /\{\s*role:\s*'([a-z][a-z0-9]*)'\s*\}/g;
  for (const m of block.matchAll(roleOnly)) {
    const role = m[1];
    if (found[role]) continue;
    const label = ELECTRON_DEFAULT_ROLE_LABELS[role];
    if (!label) {
      fail(
        `官方源码里角色 ${role} 没有显式标签、也不在 Electron 默认标签表里：${menuSource.file}`,
        '探测需要知道该角色的英文标签；请人工确认后扩充 ELECTRON_DEFAULT_ROLE_LABELS。'
      );
    }
    record(role, { windows: label, macos: label }, blockOffset + m.index, 'electron-default');
  }

  // 必需角色缺一不可：缺了说明菜单结构变了，探测失败而不是生成「猜出来」的档案。
  const missing = REQUIRED_MENU_ROLES.filter((role) => !found[role]);
  if (missing.length > 0) {
    fail(
      `官方源码 Edit 子菜单里找不到这些角色的标签：${missing.join(' / ')}（${menuSource.file}）`,
      '菜单结构变了，右键菜单标签表无法自动推导；请人工核对后更新探测规则。'
    );
  }
  // Electron 运行时生成标签的角色（菜单栏菜单里可能只有 role、没有 label，例如 delete）：
  // 源码里没有可推导的标签，用 Electron 的英文默认值补齐——右键菜单展开项同样由 Electron 按
  // role 生成，注入时要给这些 role 造出英文字面量，字典才有东西可替换（如 main.js|Delete）。
  for (const [role, label] of Object.entries(ELECTRON_DEFAULT_ROLE_LABELS)) {
    if (found[role]) continue;
    found[role] = {
      windows: label,
      macos: label,
      source: 'electron-default',
      origin: 'electron-default',
    };
  }
  return found;
}

// 产物侧字符串字面量内容 → 出现次数（与字典替换的匹配口径一致；标签字面量必须能被字典命中）。
function literalContentCounts(source) {
  const counts = new Map();
  for (const literal of common.stringLiterals(source)) {
    counts.set(literal.content, (counts.get(literal.content) || 0) + 1);
  }
  return counts;
}

// 测量一个平台产物目录（与真实安装目录同形：<appDir>/main.js 等）。
// 只读、不联网——dict-auto 二阶段会把已取到的产物目录直接喂给它。
// meta：{ platform, version, arch, assetName, assetBytes, archiveEntries, appDirInArchive }
function probeApp(appDir, meta = {}) {
  const platform = meta.platform;
  if (!PLATFORM_KEYS.includes(platform)) {
    fail(`probeApp 的平台必须是 ${PLATFORM_KEYS.join(' / ')}（官方只发这两个平台的产物）：${JSON.stringify(platform)}`);
  }
  const version = mustString(meta.version, 'probeApp 的 version ');
  const read = (file) => {
    const p = path.join(appDir, file);
    if (!fs.existsSync(p)) {
      fail(
        `产物目录缺 ${file}：${appDir}`,
        '探测需要官方产物的完整 app 目录（main.js / renderer.js / package.json / *.map）。'
      );
    }
    return fs.readFileSync(p);
  };

  const mainBuf = read('main.js');
  const rendererBuf = read('renderer.js');
  const pkgBuf = read('package.json');
  const mainText = mainBuf.toString('utf8');
  const rendererText = rendererBuf.toString('utf8');
  let pkg;
  try {
    pkg = JSON.parse(pkgBuf.toString('utf8'));
  } catch (e) {
    fail(`产物 package.json 不是合法 JSON：${appDir}（${e.message}）`);
  }
  if (pkg.version !== version) {
    fail(
      `产物版本（${JSON.stringify(pkg.version)}）与目标版本（${version}）不一致：${appDir}`,
      '产物取错了版本，或目录不是该版本的官方产物。'
    );
  }

  // sourcemap 可用性（scan / dict-groups 依赖 renderer.js.map；探测标签依赖 main.js.map）。
  const sourcemaps = {};
  for (const file of common.TARGETS) {
    const mapPath = path.join(appDir, `${file}.map`);
    if (!fs.existsSync(mapPath)) {
      sourcemaps[file] = { present: false, sourcesContent: false };
      continue;
    }
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    } catch (e) {
      fail(`sourcemap 不是合法 JSON：${mapPath}（${e.message}）`);
    }
    const hasContent =
      Array.isArray(raw.sourcesContent) && raw.sourcesContent.some((s) => typeof s === 'string' && s.length > 0);
    sourcemaps[file] = { present: true, sourcesContent: hasContent };
  }
  if (!sourcemaps['main.js'].present || !sourcemaps['main.js'].sourcesContent) {
    fail(
      `产物 main.js.map 缺失或没有 sourcesContent，无法推导右键菜单标签：${appDir}`,
      '探测需要官方源码（来源 sourcemap）；该版本产物结构变了，需要人工确认标签表。'
    );
  }

  // 标签推导 + 该平台 bundle 字面量交叉验证（标签必须真的出现在该平台产物里）。
  const menuSource = readSourceFromMap(
    path.join(appDir, 'main.js.map'),
    'app/src/main-process/menu/build-default-menu.ts'
  );
  const derived = deriveMenuLabels(menuSource);
  const literals = literalContentCounts(mainText);
  const labels = {};
  for (const role of Object.keys(derived)) {
    const info = derived[role];
    const label = info[platform];
    const bundleLiteralCount = literals.get(label) || 0;
    // delete 的标签由 Electron 运行时生成、产物里没有字面量是预期；其余角色必须能在产物里
    // 找到对应字面量——找不到说明推导错了平台分支（或官方菜单改了），直接失败。
    if (role === 'delete') {
      if (bundleLiteralCount > 0) {
        fail(
          `delete 标签 ${JSON.stringify(label)} 在 ${platform} 产物 main.js 里已有 ${bundleLiteralCount} 处字面量：` +
            `${appDir}。注入会引入重复替换目标，需人工确认该角色的标签来源。`
        );
      }
    } else if (bundleLiteralCount < 1) {
      fail(
        `标签 ${JSON.stringify(label)}（role=${role}）在 ${platform} 产物 main.js 里找不到字面量：${appDir}` +
          `（推导位置 ${info.source}）。说明平台分支推导错了或官方菜单结构变了。`
      );
    }
    labels[role] = {
      label,
      origin: info.origin,
      source: info.source,
      bundleLiteralCount,
    };
  }

  return {
    platform,
    arch: meta.arch || null,
    version,
    assetName: meta.assetName || null,
    assetBytes: meta.assetBytes || null,
    archiveEntries: meta.archiveEntries || null,
    appDirInArchive: meta.appDirInArchive || null,
    appVersion: pkg.version,
    files: {
      'main.js': { bytes: mainBuf.length, sha256: sha256(mainBuf) },
      'renderer.js': { bytes: rendererBuf.length, sha256: sha256(rendererBuf) },
      'package.json': { bytes: pkgBuf.length, sha256: sha256(pkgBuf) },
    },
    sourcemaps: {
      'main.js': { present: sourcemaps['main.js'].present, sourcesContent: sourcemaps['main.js'].sourcesContent },
      'renderer.js': {
        present: sourcemaps['renderer.js'].present,
        sourcesContent: sourcemaps['renderer.js'].sourcesContent,
      },
    },
    anchors: {
      injectionPoint: countOccurrences(mainText, INJECTION_POINT_TEXT),
      checkForUpdates: countOccurrences(mainText, UPDATE_CONTROL_ANCHOR_TEXT),
    },
    labels,
    // 本平台 map 里官方源码推导出的**两平台**标签表（role → { windows, macos }），
    // buildProfile 用它做跨平台一致性校验；实际写进档案的是按平台拆开的 labels。
    derived,
    menuSourceFile: menuSource.file,
  };
}

// 由两平台测量结果生成档案（纯函数，不联网；dict-auto 二阶段与 CLI probe 共用）。
// 语义：
//   - 两个平台的锚点实测次数必须一致（schema v1 不支持按平台不同的期望次数；不一致 = 探测失败，
//     人工确认后再扩 schema，绝不静默取其一）；
//   - 右键菜单标签表从 sourcemap 官方源码推导，两平台推导结果必须一致；
//   - 更新管控方法锚点在两平台都恰好 1 次才启用该策略，否则档案显式记 enabled:false + reason
//     （该版本不支持这项注入，比「插错地方」安全）。
function buildProfile(version, { measurements, generatedAt = new Date().toISOString(), generator } = {}) {
  if (!isPlainObject(measurements)) fail('buildProfile 需要 { measurements: { windows, macos } }');
  for (const platform of PLATFORM_KEYS) {
    if (!measurements[platform]) fail(`探测结果缺平台：${platform}`);
  }

  // 1) 锚点：两平台实测必须一致（见函数头）。
  const anchorCounts = {};
  for (const id of ['injectionPoint', 'checkForUpdates']) {
    const win = measurements.windows.anchors[id];
    const mac = measurements.macos.anchors[id];
    if (win !== mac) {
      fail(
        `锚点 ${id} 在两平台官方产物中的出现次数不一致（windows ${win} / macos ${mac}），无法生成跨平台档案。`,
        '当前 schema 不支持按平台声明不同期望次数；请人工确认两个平台的结构差异后再扩展 schema（不要取其一）。'
      );
    }
    anchorCounts[id] = win;
  }

  // 2) 标签表：两平台从各自 map 推导的结果必须一致（官方源码是同一份，__DARWIN__ 三目的两侧
  //    都在源码里；两平台产物 map 的 sourcesContent 应当逐字相同）。
  const derivedWin = measurements.windows.derived;
  const derivedMac = measurements.macos.derived;
  const winRoles = Object.keys(derivedWin).sort();
  const macRoles = Object.keys(derivedMac).sort();
  if (winRoles.join(',') !== macRoles.join(',')) {
    fail(
      `两平台推导出的右键菜单角色集合不一致：windows [${winRoles.join(' / ')}]，macos [${macRoles.join(' / ')}]`,
      '官方源码或菜单结构可能按平台分叉了；当前 schema 要求两平台角色表一致，请人工确认。'
    );
  }
  const labels = { windows: {}, macos: {} };
  for (const role of winRoles) {
    for (const platform of PLATFORM_KEYS) {
      const a = derivedWin[role][platform];
      const b = derivedMac[role][platform];
      if (a !== b) {
        fail(
          `角色 ${role} 的 ${platform} 标签在两平台产物的官方源码里不一致（windows 产物 ${JSON.stringify(a)} / ` +
            `macos 产物 ${JSON.stringify(b)}）`,
          '两平台官方源码应当只有 __DARWIN__ 一个差异来源；这里不一致说明产物取的版本不同或源码结构变了。'
        );
      }
      labels[platform][role] = a;
    }
    // 平台自身 bundle 的标签字面量证据必须与推导表一致（probeApp 里已逐个校验过存在性/次数）。
    for (const platform of PLATFORM_KEYS) {
      const evidence = measurements[platform].labels[role];
      if (!evidence || evidence.label !== labels[platform][role]) {
        fail(
          `角色 ${role} 在 ${platform} 产物的标签证据与推导表不一致：` +
            `证据 ${JSON.stringify(evidence && evidence.label)} / 推导 ${JSON.stringify(labels[platform][role])}`
        );
      }
    }
  }

  // 3) 锚点定义。
  const injectionCount = anchorCounts.injectionPoint;
  const anchors = {
    injectionPoint: {
      text: INJECTION_POINT_TEXT,
      file: 'main.js',
      placement: injectionCount >= 1 ? 'before-last' : 'append-eof',
      expected: injectionCount,
    },
  };
  const injections = {
    'context-menu': {
      enabled: true,
      injectionPoint: 'injectionPoint',
      labels,
    },
  };
  const updateCount = anchorCounts.checkForUpdates;
  if (updateCount === 1) {
    anchors.checkForUpdates = {
      text: UPDATE_CONTROL_ANCHOR_TEXT,
      file: 'main.js',
      placement: 'unique',
      expected: 1,
    };
    injections['update-control'] = {
      enabled: true,
      injectionPoint: 'injectionPoint',
      methodAnchor: 'checkForUpdates',
    };
  } else {
    // 不支持的策略在档案里显式禁用并记原因：引擎在请求该操作时会明确拒绝，而不是插错地方。
    injections['update-control'] = {
      enabled: false,
      injectionPoint: 'injectionPoint',
      reason:
        `方法锚点 ${JSON.stringify(UPDATE_CONTROL_ANCHOR_TEXT)} 在官方产物中出现 ${updateCount} 次` +
        `（期望恰好 1 次），该版本无法安全注入更新管控`,
    };
  }

  // 4) sourcemap 可用性（profile 级）：两平台都可用才算可用。
  const sourcemaps = {};
  for (const file of common.TARGETS) {
    sourcemaps[file] = PLATFORM_KEYS.every(
      (p) => measurements[p].sourcemaps[file].present && measurements[p].sourcemaps[file].sourcesContent
    );
  }

  // 5) 探测证据（逐平台、逐文件、锚点实测次数、标签字面量证据）。**不含本地路径**：档案进版本库，
  //    只记录产物名与包内路径，不写机器上的解包目录（仓库为开源仓库，不写绝对路径/机器名）。
  const platforms = {};
  for (const platform of PLATFORM_KEYS) {
    const m = measurements[platform];
    const p = {
      platform,
      arch: m.arch,
      assetName: m.assetName,
      appVersion: m.appVersion,
      files: m.files,
      sourcemaps: m.sourcemaps,
      anchors: { injectionPoint: m.anchors.injectionPoint, checkForUpdates: m.anchors.checkForUpdates },
      labels: m.labels,
    };
    if (m.assetBytes) p.assetBytes = m.assetBytes;
    if (m.archiveEntries) p.archiveEntries = m.archiveEntries;
    if (m.appDirInArchive) p.appDir = m.appDirInArchive;
    platforms[platform] = p;
  }

  const profile = {
    schemaVersion: SCHEMA_VERSION,
    version,
    generatedAt,
    generator: generator || `scripts/version-profile.js probe --version ${version}`,
    targets: [...common.TARGETS],
    sourcemaps,
    anchors,
    injections,
    evidence: {
      probe: {
        at: generatedAt,
        tool: 'scripts/version-profile.js',
        platforms: PLATFORM_KEYS.slice(),
        archs: Object.fromEntries(PLATFORM_KEYS.map((p) => [p, measurements[p].arch])),
        menuSource: measurements.windows.menuSourceFile,
      },
      platforms,
    },
  };
  // 探测生成即校验：生成器的产物必须能通过引擎的同一套校验（避免「探出来的档案自己都过不了」）。
  return validateProfile(profile, { version });
}

// 联网探测：用 release-assets 从官方 Release 按 HTTP Range 取两平台产物的 app 目录，再测量。
// 产物解包到 <work>/<platform>/app（形态与真实安装目录一致，可直接喂给 scan/verify）。
async function probeVersion(version, opts = {}) {
  const log = opts.log || (() => {});
  // 延迟 require：只有探测需要联网能力；加载/校验/断言路径不碰网络模块。
  // （bundle.js 静态收集依赖，这条 require 会随 patch 一起进产物——release-assets 本就在包装图里。）
  const releaseAssets = require('./dict/release-assets.js');
  const workDir = opts.workDir || path.join(common.getTmpDir(), 'version-profile', version);
  const archs = { windows: opts.archWindows || 'x64', macos: opts.archMacos || 'x64' };
  const measurements = {};
  for (const platform of PLATFORM_KEYS) {
    const spec = releaseAssets.PLATFORM_SPECS[platform];
    if (!spec) fail(`release-assets 不认识平台 ${platform}`);
    const outDir = path.join(workDir, platform);
    log(`探测 ${version} ${platform}-${archs[platform]} 官方产物…`);
    // 官方产物走 GitHub 的 release-assets 主机，个别网络环境下单次请求可能被重置（实测有）。
    // 探测本身只取几 MB（HTTP Range），失败重试一次即可，不让偶发网络抖动把整次探测判死。
    let fetched;
    for (let attempt = 1; ; attempt++) {
      try {
        fetched = await releaseAssets.fetchApp(version, {
          platform,
          arch: archs[platform],
          out: outDir,
          log,
        });
        break;
      } catch (e) {
        if (attempt >= 2) throw e;
        log(`  取产物失败（${e.message}），重试一次…`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    measurements[platform] = probeApp(fetched.appDir, {
      platform,
      version,
      arch: archs[platform],
      assetName: spec.asset(version, archs[platform]),
      assetBytes: fetched.size,
      archiveEntries: fetched.entries.length,
      appDirInArchive: spec.appDir,
    });
    const m = measurements[platform];
    log(
      `  ${platform}：main.js ${m.files['main.js'].bytes} 字节 sha256 ${m.files['main.js'].sha256.slice(0, 12)}…，` +
        `锚点 injectionPoint=${m.anchors.injectionPoint} / checkForUpdates=${m.anchors.checkForUpdates}，` +
        `标签 ${Object.keys(m.labels).length} 个`
    );
  }
  return buildProfile(version, { measurements, generator: opts.generator });
}

// ============================ 一句话摘要（日志用） ============================

// 给人看的一行描述：哪些策略启用、锚点几个（不解析 JSON 大块）。
function describe(profile) {
  const enabled = Object.keys(profile.injections).filter((name) => profile.injections[name].enabled !== false);
  const disabled = Object.keys(profile.injections).filter((name) => profile.injections[name].enabled === false);
  const parts = enabled.map((name) => STRATEGIES[name].label);
  if (disabled.length > 0) parts.push(`${disabled.map((n) => STRATEGIES[n].label).join(' / ')}未启用`);
  return `schemaVersion ${profile.schemaVersion}，锚点 ${Object.keys(profile.anchors).length} 个，策略：${parts.join(' / ')}`;
}

// ============================ CLI ============================

function parseArgs(argv) {
  const args = {
    action: null,
    version: null,
    work: null,
    out: null,
    write: false,
    overwrite: false,
    json: false,
    path: null,
    archWindows: null,
    archMacos: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!args.action && ['probe', 'show', 'validate', 'check'].includes(a)) args.action = a;
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--work') args.work = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--write') args.write = true;
    else if (a === '--overwrite') args.overwrite = true;
    else if (a === '--json') args.json = true;
    else if (a === '--path') args.path = argv[++i];
    else if (a === '--arch-windows') args.archWindows = argv[++i];
    else if (a === '--arch-macos') args.archMacos = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`未知参数：${a}（--help 查看用法）`);
  }
  return args;
}

function printHelp() {
  console.log(`用法：node scripts/version-profile.js <probe|show|validate|check> [选项]

每个版本的「替换逻辑档案」（dictionaries/<版本>/patch.json）的探测、查看与校验。
档案与字典（zh-CN.json）必须成对存在：缺档案时 patch/restore/verify 会明确拒绝，
不会套用其它版本的替换逻辑。

动作：
  probe     探测官方两平台产物，生成档案（--write 落盘；默认只打印摘要）
  show      查看本地档案摘要（--json 打印完整 JSON）
  validate  校验本地档案的结构与证据自洽性
  check     对本地产物断言档案锚点（--path 指定 resources 目录）

选项：
  --version <版本>       目标版本（probe/show/validate/check 必填；probe 时也用于拼官方产物名）
  --write                probe 后把档案写入 dictionaries/<版本>/patch.json（写入口唯一）
  --overwrite            probe 时允许覆盖已有档案（默认拒绝，防止冲掉已核对的版本）
  --out <文件>           probe 后额外把档案写到指定路径（供审阅 / CI 产物）
  --work <目录>          probe 的产物解包目录（默认 <数据根>/tmp/version-profile/<版本>）
  --arch-windows <架构>  Windows 产物架构（默认 x64）
  --arch-macos <架构>    macOS 产物架构（默认 x64）
  --path <目录>          check 用的 resources 目录（其下应有 app/main.js 等）
  --json                show 时打印完整档案 JSON
  -h, --help            显示本帮助`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (e) {
    console.error(`错误：${e.message}`);
    process.exit(1);
  }
  if (args.help || !args.action) {
    printHelp();
    if (!args.action && !args.help) process.exit(1);
    return;
  }
  if (!args.version) {
    console.error('错误：需要 --version 指定目标版本');
    process.exit(1);
  }

  try {
    if (args.action === 'probe') {
      const profile = await probeVersion(args.version, {
        workDir: args.work ? path.resolve(args.work) : undefined,
        archWindows: args.archWindows,
        archMacos: args.archMacos,
        log: (line) => console.log(` ${line}`),
      });
      console.log(`\n探测完成：${args.version}（${describe(profile)}）`);
      if (args.out) {
        const outFile = writeProfile(args.version, profile, { overwrite: true, outFile: args.out });
        console.log(`已写出档案（审阅用）：${outFile}`);
      }
      if (args.write) {
        const file = writeProfile(args.version, profile, { overwrite: args.overwrite });
        console.log(`已写入档案：${file}`);
        const pair = pairStatus(args.version);
        if (!pair.paired) {
          console.log(
            `注意：该版本字典与档案还不完整（缺 ${pair.missing.join(' 与 ')}）——` +
              '工具在补齐前会拒绝打补丁；流水线应在同一轮把字典与档案一起产出/提交。'
          );
        }
      } else {
        console.log('（未加 --write，档案未落盘；加 --write 写入 dictionaries/<版本>/patch.json）');
      }
      return;
    }

    if (args.action === 'show') {
      const { profile, source, label } = loadProfile(args.version);
      console.log(`档案：${label}（${source === 'external' ? '外部文件' : '内嵌资源'}）`);
      console.log(`版本：${profile.version}（${describe(profile)}）`);
      console.log(`替换对象：${profile.targets.join(' / ')}`);
      for (const [id, anchor] of Object.entries(profile.anchors)) {
        console.log(
          `锚点 ${id}：${JSON.stringify(anchor.text)}（${anchor.placement}，期望 ${anchor.expected} 次，文件 ${anchor.file}）`
        );
      }
      for (const [name, entry] of Object.entries(profile.injections)) {
        const label0 = STRATEGIES[name].label;
        if (entry.enabled === false) console.log(`策略 ${name}（${label0}）：未启用${entry.reason ? `——${entry.reason}` : ''}`);
        else if (name === 'context-menu') {
          console.log(
            `策略 ${name}（${label0}）：启用，标签 ${Object.keys(entry.labels.windows).length} 个（windows / macos）`
          );
        } else console.log(`策略 ${name}（${label0}）：启用`);
      }
      if (profile.evidence) {
        for (const [platform, p] of Object.entries(profile.evidence.platforms)) {
          console.log(
            `证据 ${platform}-${p.arch}：${p.assetName}，main.js ${p.files['main.js'].bytes} 字节 ` +
              `sha256 ${p.files['main.js'].sha256.slice(0, 12)}…，锚点 ${JSON.stringify(p.anchors)}`
          );
        }
      }
      if (args.json) console.log(`\n${JSON.stringify(profile, null, 2)}`);
      return;
    }

    if (args.action === 'validate') {
      const { profile, label } = loadProfile(args.version);
      console.log(`档案校验通过：${label}（${describe(profile)}）`);
      const pair = pairStatus(args.version);
      console.log(
        pair.paired
          ? `成对校验：字典 ${common.dictLabel(args.version)} ✓`
          : `注意：缺 ${pair.missing.join(' 与 ')}——工具会拒绝打补丁`
      );
      return;
    }

    // check：对一份具体产物断言锚点（不做替换、不写盘）
    if (!args.path) {
      console.error('错误：check 需要 --path 指定 resources 目录（其下应有 app/main.js）');
      process.exit(1);
    }
    const appDir = path.join(path.resolve(args.path), 'app');
    const { profile, label } = loadProfile(args.version);
    const mainFile = path.join(appDir, 'main.js');
    if (!fs.existsSync(mainFile)) {
      console.error(`错误：找不到 ${mainFile}（--path 应指向 resources 目录）`);
      process.exit(1);
    }
    const counts = assertAnchors(fs.readFileSync(mainFile, 'utf8'), profile, { file: 'main.js' });
    console.log(`档案：${label}
锚点校验通过：${Object.entries(counts)
      .map(([id, n]) => `${id}=${n}`)
      .join('、')}（${args.path}）
产物是官方 ${args.version} 的形态，可以按该档案打补丁。`);
  } catch (e) {
    console.error(`错误：${e.message}`);
    if (e.hint) console.error(e.hint);
    process.exit(1);
  }
}

module.exports = {
  SCHEMA_VERSION,
  PROFILE_FILE,
  STRATEGIES,
  PLATFORM_KEYS,
  INJECTION_POINT_TEXT,
  UPDATE_CONTROL_ANCHOR_TEXT,
  profileFile,
  profileAssetKey,
  hasEmbeddedProfile,
  readProfileText,
  loadProfile,
  validateProfile,
  hasStrategy,
  strategy,
  anchorsFor,
  assertAnchors,
  pairStatus,
  assertPair,
  listPairVersions,
  writeProfile,
  probeApp,
  deriveMenuLabels,
  buildProfile,
  probeVersion,
  describe,
  countOccurrences,
  profilePlatform,
  main,
};

if (require.main === module) main();
