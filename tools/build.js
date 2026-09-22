// build.js — 打包成单文件可执行（Node SEA：Single Executable Application）
// 用法：node tools/build.js [--out <目录>] [--name <文件名>] [--node <node 可执行文件>]
//
// 流程：bundle.js 合成单文件 → 生成 sea-config（内嵌全部字典）→ node 生成 blob
//       → 复制当前 node 可执行文件 → postject 注入 → 产出 dist/ 下的单文件。
// 说明：产物只能在「构建平台」运行（Windows 构建出 .exe，macOS 构建出 Mach-O，Linux 构建出 ELF）；
//       跨平台发布用 GitHub Actions 的矩阵构建，或在各平台各跑一次本脚本。
//       要求 Node ≥ 20.12（SEA 的 assets 支持版本）。其中 getAssetKeys()（列出内嵌字典版本）
//       是更晚才加的：低版本构建出的产物字典本身仍可用，但菜单里列不出内嵌版本，构建时告警。
//       Node ≥ 24 也可改用官方 `node --build-sea=sea-config.json` 一步到位，本脚本按兼容
//       20.12+ 的流程实现。
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { bundle } = require('./bundle');
const { compareVersions, DICT_VERSION_RE } = require('../scripts/common.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const PKG = require('../package.json');
// Node SEA 哨兵串（Node 官方文档固定值，postject 靠它定位注入位置）
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
// 固定 postject 版本：构建可复现（postject 只在构建期用，不进产物）
const POSTJECT_VERSION = '1.0.0-alpha.6';

function parseArgs(argv) {
  const args = { outDir: path.join(REPO_ROOT, 'dist'), name: null, node: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.outDir = path.resolve(argv[++i]);
    else if (a === '--name') args.name = argv[++i];
    else if (a === '--node') args.node = path.resolve(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`未知参数：${a}（--help 查看用法）`);
  }
  return args;
}

// 产物名里的平台词：mac 产物写 macos（使用者一眼看出是给什么系统的），Windows / Linux
// 直接用 Node 词。**只影响产物文件名**——文件头 / 签名 / 注入等运行时判定仍用 process.platform
//（内核词 darwin），两者是两回事。
const PLATFORM_WORD = { darwin: 'macos' }[process.platform] || process.platform;

function printHelp() {
  console.log(`用法：node tools/build.js [选项]

把工具打包成单文件可执行（产物在 dist/ 下，双击即用，无需安装 Node）。

选项：
  --out <目录>      产物输出目录（默认 dist/）
  --name <文件名>   自定义产物文件名（默认 github-desktop-zh-cn-cli-v<版本>-<平台>-<架构>[.exe|.bin]）
  --node <可执行文件> 指定作为产物基底的 node（默认当前 node；CI 上传 small-icu 自编译基底以压缩体积，
                    官方 node 的 ICU 数据约 28 MB，见 docs/打包与分发.md）
  -h, --help       显示本帮助`);
}

// 只内嵌最新版本的字典：产物保持单文件、体积最小。其余版本由运行时的 dict-sync
// 从仓库获取（见 AGENTS.md 的「在线能力」）——汉化最新版本无需联网。
// 「最新」只认三段数字目录（DICT_VERSION_RE）：夹具、下载残留、临时解包目录都不算数。
function collectAssets() {
  const dir = path.join(REPO_ROOT, 'dictionaries');
  const versions = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && DICT_VERSION_RE.test(e.name) && fs.existsSync(path.join(dir, e.name, 'zh-CN.json')))
    .map((e) => e.name)
    .sort(compareVersions);
  if (versions.length === 0) throw new Error('dictionaries/ 下没有可用字典，无法内嵌');
  const latest = versions[versions.length - 1];
  if (versions.length > 1) {
    console.log(`     内嵌字典只取最新版本 ${latest}（其余 ${versions.length - 1} 个版本运行时在线获取）`);
  }
  return { [`dictionaries/${latest}/zh-CN.json`]: path.join(dir, latest, 'zh-CN.json') };
}

// 优先用本地安装的 postject，其次 npx 拉取固定版本
function runPostject(args) {
  try {
    const cli = require.resolve('postject/dist/cli.js');
    execFileSync(process.execPath, [cli, ...args], { stdio: 'inherit' });
    return 'local';
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e;
  }
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  execFileSync(npx, ['--yes', `postject@${POSTJECT_VERSION}`, ...args], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return 'npx';
}

// macOS：Node 官方 SEA 步骤要求「先移除签名 → 再注入 → 再重签」——已签名的 Mach-O
// 注入不进去，而未重签的可执行文件又会被 Gatekeeper 直接杀掉，两步都不能省
function removeSignature(file) {
  if (process.platform !== 'darwin') return;
  try {
    execFileSync('codesign', ['--remove-signature', file], { stdio: 'ignore' });
  } catch (e) {
    console.warn('警告：codesign --remove-signature 失败，注入可能不成功。');
  }
}

function adhocSign(file) {
  if (process.platform !== 'darwin') return;
  try {
    execFileSync('codesign', ['--sign', '-', file], { stdio: 'inherit' });
    console.log('已做 ad-hoc 签名（codesign --sign -）');
  } catch (e) {
    console.warn('警告：codesign 不可用，产物在 macOS 上可能无法直接运行（需手动签名或右键打开）。');
  }
}

function main() {
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

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20 || (major === 20 && Number(process.versions.node.split('.')[1]) < 12)) {
    console.error(`错误：单文件打包要求 Node ≥ 20.12（当前 ${process.versions.node}）`);
    process.exit(1);
  }

  // 按能力探测而非版本号：getAssetKeys() 缺失时，产物内嵌的字典仍能读到（getAsset 一直有），
  // 但 common.embeddedDictVersions() 会退化成空列表——菜单里看不到内嵌版本，先提醒构建者
  let hasAssetKeys = false;
  try {
    hasAssetKeys = typeof require('node:sea').getAssetKeys === 'function';
  } catch (e) {
    // node:sea 不可用：按源码态处理，与 common.seaApi() 一致
  }
  if (!hasAssetKeys) {
    console.warn(
      `警告：当前 Node（${process.versions.node}）没有 sea.getAssetKeys()，` +
        '产物将列不出内嵌字典版本（字典本身仍可用）；建议改用 Node ≥ 22.20 构建。'
    );
  }

  try {
    const buildDir = path.join(REPO_ROOT, 'tmp', 'build');
    fs.mkdirSync(buildDir, { recursive: true });
    fs.mkdirSync(args.outDir, { recursive: true });

    // 1. 合成单文件入口
    const bundleFile = path.join(buildDir, 'bundle.js');
    const code = bundle(path.join(__dirname, '..', 'scripts', 'cli.js'));
    fs.writeFileSync(bundleFile, code, 'utf8');
    console.log(`1/5 已打包入口：${path.relative(REPO_ROOT, bundleFile)}（${(Buffer.byteLength(code) / 1024).toFixed(1)} KB）`);

    // 2. 生成 SEA 配置（内嵌全部字典；用绝对路径，避免相对路径基准歧义）
    const assets = collectAssets();
    const blobFile = path.join(buildDir, 'sea-prep.blob');
    const configFile = path.join(buildDir, 'sea-config.json');
    fs.writeFileSync(
      configFile,
      `${JSON.stringify(
        {
          main: bundleFile,
          output: blobFile,
          disableExperimentalSEAWarning: true,
          useSnapshot: false,
          useCodeCache: false,
          assets,
        },
        null,
        2
      )}\n`,
      'utf8'
    );
    console.log(`2/5 已生成 SEA 配置（内嵌字典 ${Object.keys(assets).length} 份）`);

    // 3. 生成 blob（基底若非当前 node，用 --node 指定的那份来跑——blob 与最终产物必须是同一个 node）
    const baseNode = args.node || process.execPath;
    execFileSync(baseNode, ['--experimental-sea-config', configFile], { stdio: 'inherit' });

    // 4. 复制 node 可执行文件作为产物基底
    // 产物名带通道词：单文件可执行是 cli（图形界面是 gui，由 electron-builder 出，见 electron-builder.yml）。
    // macOS / Linux 也带后缀（.bin）——不带后缀的附件在 Release 页面里看不出是什么文件；
    // scripts/update.js 的自更新按「-平台词-架构 + 平台后缀」匹配附件（.exe / .bin）。
    // 平台词：macos / win32 / linux（见 PLATFORM_WORD），不带 darwin 这种内核词。
    const ext = process.platform === 'win32' ? '.exe' : '.bin';
    const name = args.name || `${PKG.name}-cli-v${PKG.version}-${PLATFORM_WORD}-${process.arch}${ext}`;
    const outFile = path.join(args.outDir, name);
    fs.copyFileSync(baseNode, outFile);
    fs.chmodSync(outFile, 0o755);
    console.log(`3/5 已复制运行时：${path.relative(REPO_ROOT, outFile)}`);

    // 5. 注入 blob（macOS 的 Mach-O 必须指定段名 NODE_SEA，且注入前要先移除原签名）
    removeSignature(outFile);
    const via = runPostject([
      outFile,
      'NODE_SEA_BLOB',
      blobFile,
      '--sentinel-fuse',
      SENTINEL_FUSE,
      ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
    ]);
    console.log(`4/5 已注入代码与字典（postject via ${via}）`);
    adhocSign(outFile);

    const size = fs.statSync(outFile).size;
    console.log(`5/5 完成：${outFile}`);
    console.log(`     体积 ${(size / 1024 / 1024).toFixed(1)} MB（压缩为 zip 后约 1/3）`);
    console.log('     双击运行即进入中文菜单；命令行用法：<产物> patch --dry-run');

    // 产物自检：能启动并输出帮助，说明注入成功
    const probe = execFileSync(outFile, ['--help'], { encoding: 'utf8' });
    if (!probe.includes('用法')) throw new Error('产物自检失败：--help 未输出预期内容');
    console.log('     自检通过：产物可执行且内嵌字典就位');
  } catch (e) {
    console.error(`错误：${e.message}`);
    process.exit(1);
  }
}

main();
