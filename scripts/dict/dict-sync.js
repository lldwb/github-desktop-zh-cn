// scripts/dict/dict-sync.js — 字典与替换逻辑档案的成对在线同步
// 打包只内嵌最新版本（成对的字典 + 档案），其余版本运行时从仓库获取：
//   - ensureDict：本地缺该版本资源时才联网；「本地有」按**成对**判（外部成对 → 内嵌成对 → 联网），
//     只补缺的那份（用户已有的文件不覆盖）；
//   - syncLatest：用户主动「同步字典」时成对拉取仓库最新版并覆盖（字典 + 档案一起）。
// 远程源按 common.remoteDictUrls / common.remoteProfileUrls 的顺序成对尝试（raw → jsDelivr → Gitee），
// 每个源都要两份都取到且校验通过才算成功；全失败抛出可读错误（逐源写清缺哪一份）。
//
// 为什么必须成对：引擎（patch / verify）按版本加载档案并强校验锚点，只有字典没有档案时无法汉化。
// 半对落盘比没落盘更糟——本地看似有资源、引擎却拒绝，且「已存在」判断会让后续同步不再重试。
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('../net.js');
const common = require('../common.js');
const versionProfile = require('../version-profile.js');

// —— 远程成对资源：同一套候选源，每个源同时取两份文件 ——
// 字典与档案的候选地址各自由 common 的远程地址函数拼（地址 SSOT 在 common），这里只按序配对。
// 返回值 label 取主机名（不硬编码源名，换源时日志自动跟着变）。
function pairSources(version) {
  const dictUrls = common.remoteDictUrls(version);
  const profileUrls = common.remoteProfileUrls(version);
  return dictUrls.map((dictUrl, i) => ({
    label: new URL(dictUrl).host,
    dictUrl,
    profileUrl: profileUrls[i],
  }));
}

// 拉取并校验一对资源。opts.fetch 仅供单测注入（默认 net.get）；每个源必须两份都取到、
// 字典能被 JSON.parse、档案能通过 version-profile 的结构校验，才算该源成功。
// 全部源失败时抛错：逐源列出「缺哪一份 / 哪份校验失败」，调用方直接展示给用户。
async function fetchPair(version, opts = {}) {
  const fetchText = opts.fetch || ((url) => net.get(url, { timeout: 15000 }));
  const sources = pairSources(version);
  const failures = [];
  for (const source of sources) {
    const texts = {};
    let broken = false;
    for (const [kind, url] of [
      ['dict', source.dictUrl],
      ['profile', source.profileUrl],
    ]) {
      if (broken) break;
      try {
        texts[kind] = await fetchText(url);
      } catch (e) {
        failures.push(`${source.label} 的${kind === 'dict' ? '字典' : '替换逻辑档案'}取不到：${e.message}`);
        broken = true;
      }
    }
    if (broken) continue;
    // 先校验字典（错页/半截内容不落盘），再校验档案并取规范化结果（写盘/比对都用这份）。
    try {
      JSON.parse(texts.dict);
    } catch (e) {
      failures.push(`${source.label} 的字典不是合法 JSON：${e.message}`);
      continue;
    }
    let profile;
    try {
      profile = versionProfile.validateProfile(JSON.parse(texts.profile), { version });
    } catch (e) {
      failures.push(`${source.label} 的替换逻辑档案校验失败：${e.message}`);
      continue;
    }
    return {
      version,
      dictText: texts.dict,
      profileText: `${JSON.stringify(profile, null, 2)}\n`,
      profile,
      url: source.label,
    };
  }
  throw new Error(
    `无法获取 GitHub Desktop ${version} 的字典与替换逻辑档案（两者必须成对，缺一不可；` +
      `已尝试 ${sources.length} 个源）：\n    ${failures.join('\n    ')}`
  );
}

function readFileOrNull(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

// 成对落盘：两份都先写 `.part`，全部就绪后再逐个 rename；任一失败即回滚已替换的文件、
// 清掉 `.part`，保证磁盘上不会出现「字典新、档案旧/缺」或反之的半对状态。
// onlyMissing：只写本地缺的文件（ensureDict 用——用户已有的那份不被覆盖）；false 时全量覆盖
//（syncLatest 用）。
function writePair(version, pair, { onlyMissing = false } = {}) {
  const entries = [
    { label: '字典', target: common.dictFile(version), text: pair.dictText, part: null },
    { label: '替换逻辑档案', target: versionProfile.profileFile(version), text: pair.profileText, part: null },
  ].filter((entry) => !(onlyMissing && fs.existsSync(entry.target)));
  if (entries.length === 0) return { changed: false, files: [] };

  const backups = new Map();
  const renamed = [];
  try {
    for (const entry of entries) {
      fs.mkdirSync(path.dirname(entry.target), { recursive: true });
      entry.part = `${entry.target}.part`;
      fs.writeFileSync(entry.part, entry.text, 'utf8');
    }
    for (const entry of entries) {
      backups.set(entry.target, readFileOrNull(entry.target));
      fs.renameSync(entry.part, entry.target);
      renamed.push(entry);
    }
    return { changed: true, files: entries.map((entry) => entry.target) };
  } catch (e) {
    for (const entry of entries) {
      if (!entry.part) continue;
      try {
        fs.rmSync(entry.part, { force: true });
      } catch {
        /* 清 .part 失败不掩盖原始错误 */
      }
    }
    for (const entry of renamed) {
      try {
        const backup = backups.get(entry.target);
        if (backup === null || backup === undefined) fs.rmSync(entry.target, { force: true });
        else fs.writeFileSync(entry.target, backup);
      } catch {
        /* 回滚尽力而为；错误消息里说明可能残留 */
      }
    }
    const err = new Error(
      `写入 GitHub Desktop ${version} 的字典/替换逻辑档案失败（已尝试回滚，不留半对）：${e.message}`
    );
    err.cause = e;
    throw err;
  }
}

// 读取本地一对资源的文本（不存在返回 null），供 syncLatest 判断「内容是否变化」。
function readPairText(version) {
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  return {
    dictText: read(common.dictFile(version)),
    profileText: read(versionProfile.profileFile(version)),
  };
}

// 确保汉化前有一对可用资源。返回 { source, path, downloaded, files }：
//   source: external（本地成对）/ embedded（内嵌成对，SEA 产物）/ downloaded（本次联网补齐）。
// 本地只有一半时联网只补缺的那份（用户已有文件不被覆盖）；联网失败抛错，不静默降级。
async function ensureDict(version, opts = {}) {
  const status = versionProfile.pairStatus(version);
  if (status.paired) {
    const external = fs.existsSync(common.dictFile(version));
    return {
      source: external ? 'external' : 'embedded',
      path: external ? common.dictFile(version) : null,
      downloaded: false,
      files: [],
    };
  }
  const pair = await (opts.fetchPair || fetchPair)(version, opts);
  const written = writePair(version, pair, { onlyMissing: true });
  return {
    source: 'downloaded',
    path: common.dictFile(version),
    downloaded: true,
    url: pair.url,
    files: written.files,
  };
}

// —— 远端字典版本列表（只取列表，不下载字典）——
// 「切换版本」窗口判断某版本有没有字典时，只看本地是不够的：打包产物只内嵌构建时的最新字典，
// 之后新产出的字典（如 3.6.7）远端 main 上已有、本地数据根没有——只看本地会把「切过去就能
// 汉化」的版本标成「无字典」（用户报的就是这个）。所以打开窗口时顺带取一次远端**目录列表**，
// 与本地列表取并集；此处只取目录名，**显示阶段绝不下载字典文件**（下载只在切换 / 安装动作里，
// 见 prefetchDict）。
//
// 返回 { ok, versions, url?, error?, failures? }，**不抛错**：取不到时工具降级为本地判断
// （窗口照常打开、列表照常渲染），调用方把 error 展示给用户即可——联网失败不该阻塞界面。
// 成功结果在进程内缓存 REMOTE_LIST_TTL_MS：窗口反复打开、状态与列表各取一次都不重复撞
// GitHub API 的匿名限流（60 次/小时/IP）；**失败结果不缓存**，下次窗口打开会重新尝试。
const REMOTE_LIST_TTL_MS = 5 * 60 * 1000;
let _remoteList = null; // { at, ok, versions, url }

// opts.fetchJson 仅供单测注入（默认 net.getJson）；opts.ttlMs 覆盖缓存时长（0 = 不读不写缓存）。
async function remoteDictVersions(opts = {}) {
  const ttl = opts.ttlMs === undefined ? REMOTE_LIST_TTL_MS : opts.ttlMs;
  if (ttl > 0 && _remoteList && Date.now() - _remoteList.at < ttl) return _remoteList;
  const fetchJson = opts.fetchJson || net.getJson;
  const urls = common.remoteDictListUrls();
  const failures = [];
  for (const url of urls) {
    let list;
    try {
      list = await fetchJson(url, { timeout: 15000 });
    } catch (e) {
      failures.push(`${url}：${e.message}`);
      continue;
    }
    if (!Array.isArray(list)) {
      failures.push(`${url}：返回的不是目录列表（期望 JSON 数组）`);
      continue;
    }
    // 只认目录、只认「三段数字」形态的目录名（与 common.listDictVersions 同一判据）：
    // 远端 dictionaries/ 下还有 README.md（type: file）与将来的 beta / 临时目录，一律不算。
    const versions = [...new Set(
      list
        .filter((e) => e && (e.type === undefined || e.type === 'dir'))
        .map((e) => String(e.name || ''))
        .filter((name) => common.DICT_VERSION_RE.test(name))
    )].sort(common.compareVersions);
    const hit = { at: Date.now(), ok: true, versions, url };
    if (ttl > 0) _remoteList = hit;
    return hit;
  }
  return {
    at: Date.now(),
    ok: false,
    versions: [],
    // error 是给界面的一句话；failures 留给 CLI 详列（含每个源的失败原因）
    error: `未能获取远端字典列表（已尝试 ${urls.length} 个源），已按本地字典判断`,
    failures,
  };
}

// 切换 / 安装动作之后的资源预取：本地（外部或内嵌）成对已有就不碰网络，缺了才联网补齐。
// 与 ensureDict 的区别只在**失败语义**：切换 / 安装本身已经成功，资源没取到不该把整件事判失败，
// 故这里把异常收成 { ok: false, error } 返回，由调用方在界面 / 菜单里明说「已切换，但字典与档案
// 没取全」。错误消息来自 fetchPair，会写清缺的是字典还是档案、试过哪些源。
//
// 降级策略（任务要求二选一并说明）：**切换 / 安装成功 + 明确提示失败**，不拒绝切换。
// 理由：版本切换（写 config）是用户选定的意图，字典与档案是「切过去顺便准备好」的附赠能力——
// 为一次网络失败把用户的选择回滚，等于制造一个「切不过去」的假故障；且后续「汉化」时
// patch.ensureDict 还会再兜底一次，失败提示里也指向下一步（稍后可在「关于」里点「同步字典」重试）。
// opts.ensure 仅供单测注入（默认 ensureDict）。
async function prefetchDict(version, opts = {}) {
  const ensure = opts.ensure || ensureDict;
  try {
    const r = await ensure(version);
    return {
      ok: true,
      version,
      source: r.source,
      downloaded: !!r.downloaded,
      path: r.path,
      message: r.downloaded ? `已自动下载 ${version} 的字典与替换逻辑档案。` : null,
    };
  } catch (e) {
    return { ok: false, version, error: `未能获取 ${version} 的字典与替换逻辑档案：${e.message}` };
  }
}

// 强制更新到仓库最新版（菜单「同步字典」/ GUI「关于」用）：**成对**拉取并覆盖，内容未变时不动本地文件。
// changed 为真表示至少一份文件被更新；changedFiles 列出实际写盘的文件（供界面/日志说清动了哪份）。
async function syncLatest(version, opts = {}) {
  const pair = await (opts.fetchPair || fetchPair)(version, opts);
  const before = readPairText(version);
  const changedFiles = [];
  if (before.dictText !== pair.dictText) changedFiles.push('zh-CN.json');
  if (before.profileText !== pair.profileText) changedFiles.push(versionProfile.PROFILE_FILE);
  const path = common.dictFile(version);
  const profilePath = versionProfile.profileFile(version);
  if (changedFiles.length === 0) return { changed: false, path, profilePath, url: pair.url, changedFiles };
  writePair(version, pair);
  return { changed: true, path, profilePath, url: pair.url, changedFiles };
}

module.exports = {
  fetchPair,
  writePair,
  readPairText,
  ensureDict,
  syncLatest,
  remoteDictVersions,
  prefetchDict,
};
