// scripts/dict-sync.js — 字典在线同步
// 打包只内嵌最新版本字典，其余版本的字典运行时从仓库获取：
//   - ensureDict：本地缺该版本字典时才联网（汉化最新版本不联网，直接吃内嵌）；
//   - syncLatest：用户主动「检查更新」时强制拉取仓库最新版并覆盖。
// 远程源按 common.remoteDictUrls 的顺序尝试，全失败则抛出可读错误由调用方兜底。
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('./net.js');
const common = require('./common.js');

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

// 强制更新到仓库最新版（菜单「检查更新」用）；内容未变时不动本地文件
async function syncLatest(version) {
  const file = common.dictFile(version);
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const { text, url } = await fetchDict(version);
  if (before === text) return { changed: false, path: file, url };
  return { changed: true, path: writeDict(version, text), url };
}

module.exports = { fetchDict, writeDict, ensureDict, syncLatest };
