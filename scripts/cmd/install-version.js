// install-version.js — 下载官方产物，在本机铺出一份可用的 GitHub Desktop 安装
//
// 为什么是「解压」而不是「运行官方 Setup.exe」：Setup 是 Squirrel 安装器，走的是**升级**语义
// ——它会替换掉现有版本；而本工具的「切换版本」建立在**多版本并存**上（官方升级后旧的
// `app-<版本>` 目录本来就留着，本机实测并存 3.6.4 / 3.6.5 / 3.6.6 三个）。解压出来的目录与
// 官方安装**逐项同形**（实测对照 app-3.6.6：GitHubDesktop.exe / resources/ / 同名 dll /
// locales/ / squirrel.exe …，仅多一个 ExecutionStub），既不动现有安装，也不需要管理员权限。
//
// 只支持 Windows：官方不发 Linux 产物；macOS 的安装是把 `.app` 覆盖到 /Applications（覆盖
// 语义、要权限、运行中还会占用），是另一套东西，本次不做。
'use strict';
const fs = require('fs');
const path = require('path');
const common = require('../common.js');
const net = require('../net.js');
const update = require('../update.js');
const releaseAssets = require('../dict/release-assets.js');

const checksumFile = (version) => `GitHub.Desktop-${version}-checksums.txt`;

// 目标安装目录：`<安装根>/app-<版本>`，与官方装出来的同处一层
function targetDir(version) {
  return path.join(common.appRootDir(), `app-${version}`);
}

function installedAt(version) {
  return fs.existsSync(path.join(targetDir(version), 'resources', 'app', 'main.js'));
}

// 下载 + 解压的峰值占用。安装包本身之外还要一次解压（Electron 应用解压后约为压缩包的 2 倍），
// 按 2.2 倍估——宁可多留一点，也不要在解压到一半时把盘写满。
function checkSpace(dir, pkgBytes) {
  const need = Math.ceil(pkgBytes * 2.2);
  let free;
  try {
    const st = fs.statfsSync(dir);
    free = st.bavail * st.bsize;
  } catch {
    return null; // 拿不到磁盘信息（某些文件系统不支持 statfs）就不拦
  }
  if (free < need) {
    const gb = (n) => (n / 1073741824).toFixed(1);
    throw new Error(`磁盘空间不足：${path.parse(dir).root} 剩 ${gb(free)} GB，本次下载加解压约需 ${gb(need)} GB`);
  }
  return { free, need };
}

// 可下载的版本：官方列表（有产物的正式版） × 本机是否已装 × 本机是否有字典。
// `hasDict` 决定它出不出现在默认视图（「只列有汉化的版本」），由调用方过滤——
// 这里一律返回全量，GUI 的「显示没汉化的版本」勾选才有东西可展开。
async function listDownloadable(opts = {}) {
  const dictVersions = common.listDictVersions();
  const installed = new Set(common.listInstalledVersions().map((x) => x.version));
  const { platform, arch, versions } = await releaseAssets.listVersions(opts);
  return {
    ok: true,
    platform,
    arch,
    installable: platform === 'windows',
    versions: versions.map((v) => ({
      version: v.version,
      assetName: v.assetName,
      size: v.size,
      hasDict: dictVersions.includes(v.version),
      installed: installed.has(v.version),
    })),
  };
}

// 下载并安装指定版本。返回 { version, appDir, bytes, files }；已装且未 force 时返回 { skipped: true }。
// `opts.from` 指定本地安装包时跳过下载（离线 / 自备包——也是下载通道不通时的降级路径）。
//
// 失败语义：**任一步失败都不留半个 app-<版本> 目录**——先铺到 `app-<版本>.part`，必需文件齐了
// 才改名成正式目录。官方改了打包结构时也能在这一步挡住（缺 main.js 即失败并清理）。
async function install(version, opts = {}) {
  const log = opts.log || (() => {});
  const onProgress = opts.onProgress || (() => {});
  if (process.platform !== 'win32') {
    throw new Error(
      `在线安装目前只支持 Windows（当前 ${process.platform}）——请到 GitHub Releases 手动下载本平台安装包`
    );
  }

  const dest = targetDir(version);
  if (!opts.force && installedAt(version)) {
    return { version, appDir: dest, skipped: true };
  }

  const platform = 'windows';
  const spec = releaseAssets.PLATFORM_SPECS[platform];

  // —— 包来源：本地文件，或在线下载 ——
  let pkg;
  let bytes;
  if (opts.from) {
    pkg = path.resolve(opts.from);
    if (!fs.existsSync(pkg)) throw new Error(`本地安装包不存在：${pkg}`);
    bytes = fs.statSync(pkg).size;
    log(`用本地包 ${path.basename(pkg)}（${(bytes / 1048576).toFixed(1)} MB）`);
  } else {
    const { versions } = await releaseAssets.listVersions({ platform, arch: opts.arch });
    const hit = versions.find((v) => v.version === version);
    if (!hit) throw new Error(`官方没有可供下载的 ${version}（未发产物，或不在最近 100 个版本内）`);
    bytes = hit.size;

    // ① 先取校验和：它只有几百字节，拿不到就没必要开始下 293 MB
    let want = null;
    try {
      const text = await net.get(releaseAssets.assetUrl(version, checksumFile(version)));
      want = update.parseSums(text).get(hit.assetName) || null;
      if (!want) log(`（官方校验文件里没有 ${hit.assetName}，跳过比对）`);
    } catch (e) {
      log(`（取校验文件失败，跳过比对：${e.message}）`);
    }

    // ② 下载。整包下一遍再本地解压——按条目走 Range 是「取几个文件」的用法，
    //    铺满上千个文件时每条一次往返不可行。
    const tmpDir = path.join(common.getTmpDir(), 'downloads');
    fs.mkdirSync(tmpDir, { recursive: true });
    pkg = path.join(tmpDir, hit.assetName);
    const url = hit.url || releaseAssets.assetUrl(version, hit.assetName);
    log(`下载 ${hit.assetName}（${(bytes / 1048576).toFixed(1)} MB）…`);
    await net.download(url, pkg, { onProgress, timeout: opts.timeout || 120000 });

    // ③ 校验：不符即丢弃下载内容，不碰安装目录
    if (want) {
      const got = await update.sha256File(pkg);
      if (got !== want) {
        fs.rmSync(pkg, { force: true });
        throw new Error(
          `校验和不符（官方 ${want.slice(0, 16)}…，下载到 ${got.slice(0, 16)}…），已丢弃下载内容`
        );
      }
      log('校验和一致');
    }
  }

  // —— 以下与来源无关：查空间 → 解压到 .part → 验必需文件 → 落位 ——
  const root = common.appRootDir();
  fs.mkdirSync(root, { recursive: true });
  checkSpace(root, bytes);

  const staging = `${dest}.part`;
  fs.rmSync(staging, { recursive: true, force: true });
  log(`解压（${spec.prefix} → app-${version}/）…`);
  const r = releaseAssets.extractLocal(pkg, { prefix: spec.prefix, outDir: staging });

  // 必需文件齐不齐——不齐说明官方改了打包结构，清掉半成品而不是留个假目录
  for (const f of ['resources/app/main.js', 'resources/app/renderer.js', 'resources/app/package.json']) {
    if (fs.existsSync(path.join(staging, f))) continue;
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`解压结果缺少 ${f}，官方可能改了打包结构（共解出 ${r.written} 个文件），已清理`);
  }

  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(staging, dest);
  // 安装包只在是下载来的、且放在临时目录时才删；用户自己给的本地包不动
  if (!opts.from) fs.rmSync(pkg, { force: true });
  return { version, appDir: dest, bytes, files: r.written };
}

// ============================ CLI ============================

function parseArgs(argv) {
  const args = { version: null, list: false, force: false, from: null, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') args.list = true;
    else if (a === '--force') args.force = true;
    else if (a === '--from') args.from = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
    else if (!a.startsWith('-')) args.version = a;
    else throw new Error(`未知参数：${a}（--help 查看用法）`);
  }
  return args;
}

function printHelp() {
  console.log(`用法：node scripts/cmd/install-version.js [版本] [选项]

从官方 Release 下载指定版本的 GitHub Desktop，解压到 <安装根>/app-<版本>/（只支持 Windows）。
装出来的目录与官方安装同形，可被 locateApp 直接识别，与已装版本并存。

  <版本>          要安装的版本，如 3.6.4
  --list          列出可下载的版本（只列本工具有字典的）
  --force         已装也重新下载覆盖
  --from <文件>   用本地安装包（跳过下载；下载通道不通时的降级路径）
  -h, --help      显示本帮助

下载自动读系统代理配置（环境变量 HTTPS_PROXY / Windows 注册表 / macOS scutil）。`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  if (args.list) {
    const r = await listDownloadable();
    const rows = r.versions.filter((v) => v.hasDict);
    console.log(`可下载版本（${r.platform}-${r.arch}，只列有汉化字典的）：`);
    for (const v of rows) {
      const mark = v.installed ? '（已安装）' : '';
      console.log(`  ${v.version.padEnd(10)} ${(v.size / 1048576).toFixed(1).padStart(7)} MB ${mark}`);
    }
    if (!rows.length) console.log('  （无）');
    return;
  }

  if (!args.version) {
    printHelp();
    return;
  }

  let lastPct = -1;
  const onProgress = (got, total) => {
    const pct = total ? Math.floor((got / total) * 100) : 0;
    if (pct >= lastPct + 5 || pct === 100) {
      lastPct = pct;
      process.stdout.write(`\r  ${String(pct).padStart(3)}%  ${(got / 1048576).toFixed(1)} MB`);
    }
  };

  const r = await install(args.version, {
    log: (m) => console.log(m), onProgress, force: args.force, from: args.from,
  });
  if (r.skipped) {
    console.log(`\n${r.version} 已经在本机：${r.appDir}`);
    console.log('（要重新下载加 --force）');
    return;
  }
  console.log(`\n\n已安装 ${r.version}：${r.appDir}`);
  console.log(`共铺开 ${r.files} 个文件。用「切换版本」切过去即可汉化。`);
}

module.exports = { listDownloadable, install, targetDir, installedAt, main };

if (require.main === module) {
  main().catch((e) => {
    console.error(`\n错误：${e.message}`);
    process.exit(1);
  });
}
