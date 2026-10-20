// scripts/dict/dict-sync.js — 字典在线同步
// 打包只内嵌最新版本字典，其余版本的字典运行时从仓库获取：
//   - ensureDict：本地缺该版本字典时才联网（汉化最新版本不联网，直接吃内嵌）；
//   - syncLatest：用户主动「同步字典」时强制拉取仓库最新版并覆盖。
// 远程源按 common.remoteDictUrls 的顺序尝试，全失败则抛出可读错误由调用方兜底。
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('../net.js');
const common = require('../common.js');

// 拉取并校验字典文本：JSON 必须能解析，避免把错误页 / 半截内容落盘成坏字典
async function fetchDict(version) {
  const urls = common.remoteDictUrls(version);
  const failures = [];
  for (const url of urls) {
    try {
      const text = await net.get(url, { timeout: 15000 });
      JSON.parse(text);
      return { text, url };
    } catch (e) {
      failures.push(`${url}\n      ${e.message}`);
    }
  }
  throw new Error(
    `无法获取 GitHub Desktop ${version} 的字典（已尝试 ${urls.length} 个源）：\n    ${failures.join('\n    ')}`
  );
}

// 原子落盘：先写 .part 再改名，避免读到写了一半的文件
function writeDict(version, text) {
  const file = common.dictFile(version);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const part = `${file}.part`;
  fs.writeFileSync(part, text);
  fs.renameSync(part, file);
  return file;
}

// 确保汉化前有字典可用。返回 downloaded 告知调用方是否发生了联网下载。
async function ensureDict(version) {
  const file = common.dictFile(version);
  if (fs.existsSync(file)) return { source: 'external', path: file, downloaded: false };
  if (common.hasEmbeddedDict(version)) {
    return { source: 'embedded', path: null, downloaded: false };
  }
  const { text, url } = await fetchDict(version);
  return { source: 'downloaded', path: writeDict(version, text), downloaded: true, url };
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

// 切换 / 安装动作之后的字典预取：本地（外部或内嵌）已有就不碰网络，缺了才联网取一份。
// 与 ensureDict 的区别只在**失败语义**：切换 / 安装本身已经成功，字典没取到不该把整件事判失败，
// 故这里把异常收成 { ok: false, error } 返回，由调用方在界面 / 菜单里明说「已切换，但字典没取到」。
//
// 降级策略（任务要求二选一并说明）：**切换 / 安装成功 + 明确提示字典获取失败**，不拒绝切换。
// 理由：版本切换（写 config）是用户选定的意图，字典是「切过去顺便准备好」的附赠能力——为一次
// 网络失败把用户的选择回滚，等于制造一个「切不过去」的假故障；且后续「汉化」时 patch.ensureDict
// 还会再兜底一次，失败提示里也指向下一步（稍后可在「关于」里点「同步字典」重试）。
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
      message: r.downloaded ? `已自动下载 ${version} 的字典。` : null,
    };
  } catch (e) {
    return { ok: false, version, error: `未能获取 ${version} 的字典：${e.message}` };
  }
}

// 强制更新到仓库最新版（菜单「检查更新」用）；内容未变时不动本地文件
async function syncLatest(version) {
  const file = common.dictFile(version);
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const { text, url } = await fetchDict(version);
  if (before === text) return { changed: false, path: file, url };
  return { changed: true, path: writeDict(version, text), url };
}

module.exports = { fetchDict, writeDict, ensureDict, syncLatest, remoteDictVersions, prefetchDict };
