// release-assets.js — 从官方 Release 产物里按需取文件（HTTP Range，不下载整包）
//
// 官方把 Windows/macOS 产物打成 zip 发布（nupkg 也是 zip），单个 250~330 MB，而 CI 与本机
// 要的只是其中的 app 目录。zip 的结构允许只取需要的部分：
//
//   尾部窗口 → 定位 EOCD（中央目录的偏移与大小都写在里面）
//     → 精确 Range 取中央目录 → 找到目标条目的本地头偏移
//       → Range 取本地头（长度不定，须读出 nameLen/extraLen 才能算数据起点）
//         → Range 取压缩数据 → inflateRaw
//
// 全程只传输几十 KB 到几 MB，零依赖（node:zlib + scripts/net.js）。
//
// 产出刻意与真实安装目录同形（<out>/app/…），于是 scan / verify / dict-groups 都能用
// `--path <out>` 直接跑——不必为「离线的产物目录」再造一套输入口径。
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const net = require('../net.js');
const common = require('../common.js');

const UPSTREAM_WEB = 'https://github.com/desktop/desktop';
const UPSTREAM_API = 'https://api.github.com/repos/desktop/desktop';

// 各平台的产物名与包内 app 目录。macOS 的资产名不含版本号（3.6.5 与 3.6.6-beta2 实测皆如此），
// 版本只体现在 tag 里；Windows 的资产名含版本与架构。
// linux 为 null：官方不发 Linux 产物——近 30 个 release 的资产清单里一个都没有。
const PLATFORM_SPECS = {
  windows: {
    asset: (version, arch) => `GitHubDesktop-${version}-${arch}-full.nupkg`,
    appDir: 'lib/net45/resources/app',
  },
  macos: {
    asset: (version, arch) => `GitHub.Desktop-${arch}.zip`,
    appDir: 'GitHub Desktop.app/Contents/Resources/app',
  },
  linux: null,
};

// 取哪几个文件：前三个是 common.locateApp 认出「有效资源目录」的必要条件，
// 后两个供 scan / dict-groups 使用——它们读 sourcemap 里的官方源码来提取文案与出处。
const CORE_FILES = ['main.js', 'renderer.js', 'package.json'];
const MAP_FILES = ['main.js.map', 'renderer.js.map'];

// ============================ zip 结构 ============================
// 只实现取单个条目所需的最小集：EOCD → 中央目录 → 本地头 → 数据。不处理 zip64——官方产物
// 最大 330 MB，远够不着 4 GB 的边界；真遇到说明打包方式变了，应当报错而不是猜。

const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LH = 0x04034b50;

// EOCD 定长 22 字节，其后可跟最多 65535 字节的注释，故 64 KB 窗口必然覆盖；
// 多取 22 字节是让「注释恰好顶满」时签名不至于被切在窗口之外。
const TAIL_WINDOW = 65536 + 22;

// 从尾部窗口里找 EOCD。offset 是相对窗口起点的，调用方按需换算。
function readEocd(tail) {
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== SIG_EOCD) continue;
    // 从后往前遇到的第一个签名可能是注释里的偶然字节：真 EOCD 的注释长度必然正好顶到文件末尾
    if (i + 22 + tail.readUInt16LE(i + 20) !== tail.length) continue;
    const entries = tail.readUInt16LE(i + 10);
    const cdSize = tail.readUInt32LE(i + 12);
    const cdOffset = tail.readUInt32LE(i + 16);
    if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new Error('产物是 zip64 格式，当前解析器只支持普通 zip');
    }
    return { entries, cdSize, cdOffset };
  }
  return null;
}

// 解析中央目录。条目是一条接一条记录的，靠每条自己的 nameLen/extraLen/commentLen 步进；
// 步进不动的（签名不符）即认为目录到此为止，由调用方核对条目总数。
function parseCentralDirectory(buf) {
  const out = [];
  let i = 0;
  while (i + 46 <= buf.length && buf.readUInt32LE(i) === SIG_CD) {
    const nameLen = buf.readUInt16LE(i + 28);
    const extraLen = buf.readUInt16LE(i + 30);
    const commentLen = buf.readUInt16LE(i + 32);
    out.push({
      name: buf.toString('utf8', i + 46, i + 46 + nameLen),
      method: buf.readUInt16LE(i + 10),
      csize: buf.readUInt32LE(i + 20),
      usize: buf.readUInt32LE(i + 24),
      lho: buf.readUInt32LE(i + 42),
    });
    i += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ============================ 传输 ============================

// 取一段字节。服务端必须真的按区间返回（206）——若回 200 说明它忽略了 Range，正把整个
// 250 MB 送过来；maxBytes 就是为这种情况准备的保险丝，宁可失败也不能把内存打满。
async function readRange(url, start, end) {
  const want = end - start + 1;
  if (want <= 0) throw new Error(`请求的字节区间为空：${start}-${end}`);
  const { status, buffer } = await net.getRaw(url, {
    headers: { range: `bytes=${start}-${end}`, 'accept-encoding': 'identity' },
    maxBytes: want + 4096,
  });
  if (status !== 206) {
    throw new Error(`服务端未按区间返回（HTTP ${status}），无法只取部分内容：${url}`);
  }
  if (buffer.length !== want) {
    throw new Error(`区间 ${start}-${end} 应得 ${want} 字节，实得 ${buffer.length} 字节：${url}`);
  }
  return buffer;
}

// 打开远端 zip：HEAD 探大小与 Range 支持 → 尾部窗口定位 EOCD → 精确取回中央目录
async function openArchive(url) {
  const h = await net.head(url);
  if (!h.size) throw new Error(`无法获取产物大小（HTTP ${h.status}）：${url}`);
  if (h.acceptRanges !== 'bytes') {
    throw new Error(`服务端不支持 Range 请求（accept-ranges=${h.acceptRanges || '无'}），无法只取部分内容：${url}`);
  }
  const eocd = readEocd(await readRange(url, Math.max(0, h.size - TAIL_WINDOW), h.size - 1));
  if (!eocd) throw new Error(`未能定位 zip 中央目录（文件不是 zip 或已被截断）：${url}`);
  const entries = parseCentralDirectory(await readRange(url, eocd.cdOffset, eocd.cdOffset + eocd.cdSize - 1));
  if (entries.length !== eocd.entries) {
    throw new Error(`中央目录不完整：解析到 ${entries.length} 条，EOCD 记录 ${eocd.entries} 条（${url}）`);
  }
  return { url, size: h.size, entries };
}

// 取一个条目的内容并解压。本地头定长 30 字节，但其 extra 字段长度与中央目录里记录的不一定
// 相同（zip 规范允许差异），所以数据起点必须从本地头现算，不能拿中央目录的值凑。
async function readEntry(archive, entry) {
  const lh = await readRange(archive.url, entry.lho, entry.lho + 29);
  if (lh.readUInt32LE(0) !== SIG_LH) throw new Error(`本地头签名不符：${entry.name}`);
  const dataStart = entry.lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  const raw = await readRange(archive.url, dataStart, dataStart + entry.csize - 1);
  if (entry.method === 0) return raw; // 存储（未压缩）
  if (entry.method !== 8) throw new Error(`不支持的压缩方式 ${entry.method}：${entry.name}`);
  return zlib.inflateRawSync(raw);
}

// ============================ 对外 ============================

// 版本 → 官方下载地址。tag 就是 release-<版本>，正式版与 beta 同形（实测 release-3.6.5、
// release-3.6.6-beta2 皆如此），所以版本号原样拼进去即可。
function assetUrl(version, assetName) {
  return `${UPSTREAM_WEB}/releases/download/release-${version}/${assetName}`;
}

// 官方最新正式版（不含 beta）。CI 的定时任务据此决定目标版本。
// 走 /releases/latest，语义是「**有产物可下的**最新正式版」，比官方发布说明页
// （desktop.github.com/release-notes/）滞后：正式版的 GitHub Release 对象比 notes 晚
// 若干天才建（实测 3.6.6 的 notes 是 2026-09-16，其 Release 对象与产物至 09-19 仍不存在）。
// 别改成「按 tag 取最新版本号」——tag 里混着 release-3.6.6（无产物）、release-3.6.7-test2、
// tmp-e2e-screenshots-* 这类取不到产物的名字，会让 CI 直接失败。
// 传 token 可提高 GitHub API 的速率上限（CI 里用 GITHUB_TOKEN）。
async function latestVersion(opts = {}) {
  const headers = opts.token ? { authorization: `Bearer ${opts.token}` } : {};
  const release = await net.getJson(`${UPSTREAM_API}/releases/latest`, { headers });
  const tag = String(release.tag_name || '');
  if (!tag.startsWith('release-')) {
    throw new Error(`官方 release 的 tag 命名变了（${tag}），版本解析需要同步修改`);
  }
  return {
    version: tag.slice('release-'.length),
    url: release.html_url,
    publishedAt: release.published_at,
  };
}

// 打开某版本的某平台产物，返回归档句柄（供 listEntries / fetchApp 复用同一次解析）
async function open(version, { platform, arch } = {}) {
  const plat = platform || common.currentPlatform();
  const spec = PLATFORM_SPECS[plat];
  if (!spec) throw new Error(`官方不发布 ${plat} 平台的产物（官方只发 Windows 与 macOS）`);
  const archName = arch || process.arch;
  return { ...(await openArchive(assetUrl(version, spec.asset(version, archName)))), platform: plat, arch: archName, spec };
}

// 把产物里的 app 目录提取到 outDir，形态与真实安装目录一致（outDir/app/…）。
// 缺核心文件即失败——那说明产物结构变了，静默产出半个目录只会让下游莫名报错。
// sourcemap 缺失只警告：它不影响替换，受影响的只是 scan 与组名推断。
async function fetchApp(version, opts = {}) {
  const log = opts.log || console.log;
  const archive = await open(version, opts);
  const files = [...CORE_FILES, ...(opts.maps === false ? [] : MAP_FILES)];
  const appDir = path.join(opts.out, 'app');
  fs.mkdirSync(appDir, { recursive: true });

  log(`${version} ${archive.platform}-${archive.arch}：产物 ${(archive.size / 1048576).toFixed(1)} MB，`
    + `中央目录 ${archive.entries.length} 条`);

  const written = [];
  const missing = [];
  for (const file of files) {
    const entry = archive.entries.find((e) => e.name === `${archive.spec.appDir}/${file}`);
    if (!entry) {
      if (MAP_FILES.includes(file)) {
        missing.push(file);
        continue;
      }
      throw new Error(`产物里没有 ${archive.spec.appDir}/${file}——官方可能改了打包结构`);
    }
    const buf = await readEntry(archive, entry);
    fs.writeFileSync(path.join(appDir, file), buf);
    written.push({ file, bytes: buf.length });
    log(`  ${file.padEnd(16)} ${(buf.length / 1024).toFixed(0)} KB`
      + `（压缩 ${(entry.csize / 1024).toFixed(0)} KB，${((1 - entry.csize / Math.max(buf.length, 1)) * 100).toFixed(0)}% 省下）`);
  }
  if (missing.length) log(`  [警告] 产物里没有 ${missing.join(' / ')}——scan 与组名推断将不可用`);
  return { ...archive, appDir, files: written, missing };
}

// 列出产物里匹配后缀的条目（探测产物结构用）。entries 是筛选结果，total 是中央目录总数——
// 两者都要有，否则「中央目录 5 条」会让人以为整个包只有 5 个文件。
async function listEntries(version, opts = {}) {
  const archive = await open(version, opts);
  const want = opts.match || [];
  return {
    ...archive,
    total: archive.entries.length,
    entries: want.length ? archive.entries.filter((e) => want.some((w) => e.name.endsWith(w))) : archive.entries,
  };
}

// ============================ CLI ============================

function parseArgs(argv) {
  const args = { action: null, version: null, platform: null, arch: null, out: null, match: null, maps: true, token: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'fetch' || a === 'list' || a === 'latest') args.action = a;
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--platform') args.platform = argv[++i];
    else if (a === '--arch') args.arch = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--match') args.match = argv[++i].split(',');
    else if (a === '--no-map') args.maps = false;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`未知参数：${a}（--help 查看用法）`);
  }
  return args;
}

function printHelp() {
  console.log(`用法：node scripts/dict/release-assets.js <list|fetch|latest> [选项]

从官方 Release 产物里按需取文件，只走 HTTP Range，不下载整包（产物单个 250~330 MB）。
fetch 产出的目录与真实安装目录同形，可直接喂给其它脚本：

  node scripts/dict/release-assets.js fetch --version 3.6.6-beta2 --platform macos --out tmp/release/3.6.6-beta2/macos
  node scripts/cmd/scan.js --path tmp/release/3.6.6-beta2/macos --version 3.6.6-beta2

动作：
  list     列出产物内的条目（默认全列，--match 按后缀筛选）
  fetch    把 app 目录提取到 --out/app/
  latest   打印官方最新正式版（不含 beta）

选项：
  --version <版本>    官方版本号，含 beta 后缀（如 3.6.6-beta2）；latest 动作不需要
  --platform <平台>   windows | macos（默认取当前平台）
  --arch <架构>       x64 | arm64（默认取当前架构）
  --out <目录>        fetch 的输出目录（必填）
  --match <后缀,..>   list 的条目筛选（如 app/main.js,app/package.json）
  --no-map            跳过 sourcemap（体积更小，但 scan 与组名推断不可用）
  -h, --help          显示本帮助`);
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

  try {
    if (args.action === 'latest') {
      const r = await latestVersion({ token: args.token || process.env.GITHUB_TOKEN });
      console.log(`${r.version}\t${r.publishedAt || ''}\t${r.url}`);
      return;
    }
    if (!args.version) throw new Error(`${args.action} 需要 --version（或用 latest 查看当前最新正式版）`);

    if (args.action === 'list') {
      const r = await listEntries(args.version, { platform: args.platform, arch: args.arch, match: args.match });
      console.log(`${args.version} ${r.platform}-${r.arch}：${(r.size / 1048576).toFixed(1)} MB，`
        + `中央目录 ${r.total} 条${r.total === r.entries.length ? '' : `，筛出 ${r.entries.length} 条`}`);
      for (const e of r.entries) {
        console.log(`  ${e.name}  压缩 ${(e.csize / 1024).toFixed(0)} KB / 原始 ${(e.usize / 1024).toFixed(0)} KB`);
      }
      return;
    }

    if (!args.out) throw new Error('fetch 需要 --out 指定输出目录');
    const r = await fetchApp(args.version, {
      platform: args.platform, arch: args.arch, out: args.out, maps: args.maps,
    });
    console.log(`\n已提取到 ${r.appDir}`);
    console.log(`可用：node scripts/cmd/scan.js --path ${path.dirname(r.appDir)} --version ${args.version}`);
  } catch (e) {
    console.error(`错误：${e.message}`);
    process.exit(1);
  }
}

module.exports = {
  fetchApp, listEntries, open, openArchive, readRange, readEntry,
  readEocd, parseCentralDirectory, latestVersion, assetUrl, PLATFORM_SPECS, CORE_FILES, MAP_FILES, main,
};

if (require.main === module) main();
