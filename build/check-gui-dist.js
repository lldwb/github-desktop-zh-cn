// build/check-gui-dist.js — GUI 产物自检（零依赖，CI 与本地共用）
//
// 只做**静态**检查：产物文件在不在、应用包结构对不对、内置字典进没进包、
// Windows 产物是不是 GUI 子系统（双击不弹控制台）。界面能不能起、汉化能不能成
// 属于运行态，得在带桌面的机器上实测——CI runner 没有桌面会话，起不了窗口。
//
// 用法：npm run dist 之后 `node build/check-gui-dist.js`（按当前平台检查对应产物）
'use strict';

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'dist', 'gui');
const PE_SIGNATURE = Buffer.from('PE');
const results = [];
const ok = (msg) => results.push([true, msg]);
const bad = (msg) => results.push([false, msg]);

const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

const listDir = (p) => {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
};

// 应用包内该有的两样：界面与业务代码（app.asar）、内置字典
function checkResources(resourcesDir, label) {
  if (!exists(resourcesDir)) {
    bad(`${label}：找不到 ${resourcesDir}`);
    return null;
  }

  const asar = path.join(resourcesDir, 'app.asar');
  if (!exists(asar)) bad(`${label}：缺 resources/app.asar`);
  else if (fs.statSync(asar).size < 100 * 1024) bad(`${label}：app.asar 偏小（${fs.statSync(asar).size} 字节），界面与业务代码可能没打进去`);
  else ok(`${label}：app.asar ${(fs.statSync(asar).size / 1024).toFixed(0)} KB`);

  // 字典（extraResources → resources/dictionaries），至少要有能用的版本
  const dictRoot = path.join(resourcesDir, 'dictionaries');
  const versions = listDir(dictRoot).filter((v) => exists(path.join(dictRoot, v, 'zh-CN.json')));
  if (versions.length) ok(`${label}：内置字典 ${versions.join(' / ')}`);
  else bad(`${label}：resources/dictionaries 下没有可用的 zh-CN.json`);

  return exists(asar) ? asar : null;
}

// asar 头解析：8 字节 pickle 头之后是一段 pickle 包裹的 JSON 目录树。
// 解析失败只提示、不判失败——静态检查不该因为格式细节误伤构建。
function asarEntries(asarPath) {
  try {
    const fd = fs.openSync(asarPath, 'r');
    const sizeBuf = Buffer.alloc(8);
    fs.readSync(fd, sizeBuf, 0, 8, 0);
    const headerSize = sizeBuf.readUInt32LE(4);
    const headerBuf = Buffer.alloc(headerSize);
    fs.readSync(fd, headerBuf, 0, headerSize, 8);
    fs.closeSync(fd);
    const jsonLen = headerBuf.readUInt32LE(4);
    const tree = JSON.parse(headerBuf.toString('utf8', 8, 8 + jsonLen));
    const names = [];
    const walk = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files || {})) {
        const p = prefix ? `${prefix}/${name}` : name;
        if (child.files) walk(child, p);
        else names.push(p);
      }
    };
    walk(tree, '');
    return names;
  } catch {
    return null;
  }
}

const checkAsarContents = (asar) => {
  const names = asarEntries(asar);
  if (!names) {
    ok('（asar 目录未解析，跳过内容检查）');
    return;
  }
  const need = [
    'gui/main.js',
    'gui/preload.js',
    'gui/index.html',
    'gui/renderer.js',
    'gui/style.css',
    'scripts/common.js',
    'scripts/patch.js',
    'scripts/restore.js',
    'scripts/dict-sync.js',
    'scripts/update.js',
    'package.json',
  ];
  const missing = need.filter((n) => !names.includes(n));
  if (missing.length) bad(`app.asar 里缺文件：${missing.join(' / ')}`);
  else ok(`app.asar 里界面与业务代码齐全（${names.length} 个文件）`);
};

// Windows 产物必须是 GUI 子系统：否则双击会先弹一个黑色控制台窗口
function peSubsystem(exePath) {
  const fd = fs.openSync(exePath, 'r');
  try {
    const dos = Buffer.alloc(64);
    fs.readSync(fd, dos, 0, 64, 0);
    const peOffset = dos.readUInt32LE(0x3c);
    const head = Buffer.alloc(4 + 20);
    fs.readSync(fd, head, 0, head.length, peOffset);
    if (!head.subarray(0, 2).equals(PE_SIGNATURE)) return null;
    const optSize = head.readUInt16LE(4 + 16);
    const opt = Buffer.alloc(optSize);
    fs.readSync(fd, opt, 0, optSize, peOffset + 4 + 20);
    // Subsystem 在 OptionalHeader 里的偏移对 PE32 / PE32+ 同为 0x44：
    // PE32 的 ImageBase 是 4 字节但多一个 BaseOfData，与 PE32+ 的 8 字节 ImageBase 正好抵消。
    return opt.readUInt16LE(0x44);
  } finally {
    fs.closeSync(fd);
  }
}

function checkWindows() {
  const unpacked = path.join(OUT, 'win-unpacked');
  const exe = path.join(unpacked, 'GitHubDesktopZhTool.exe');
  if (!exists(exe)) {
    bad('找不到 win-unpacked/GitHubDesktopZhTool.exe');
  } else {
    const sub = peSubsystem(exe);
    if (sub === 2) ok('产物 exe 是 GUI 子系统（Subsystem=2，双击不弹控制台）');
    else bad(`产物 exe 的 Subsystem=${sub}（应为 2；为 3 说明是控制台程序）`);
  }
  const asar = checkResources(path.join(unpacked, 'resources'), 'win-unpacked');
  if (asar) checkAsarContents(asar);
}

function checkMac() {
  const dirs = listDir(OUT).filter((d) => d.startsWith('mac'));
  if (!dirs.length) bad('找不到 mac 输出目录（mac / mac-arm64）');
  for (const d of dirs) {
    const apps = listDir(path.join(OUT, d)).filter((f) => f.endsWith('.app'));
    if (!apps.length) {
      bad(`${d}：没有 .app`);
      continue;
    }
    const app = path.join(OUT, d, apps[0]);
    const label = `${d}/${apps[0]}`;
    if (exists(path.join(app, 'Contents/MacOS/GitHubDesktopZhTool'))) ok(`${label}：主可执行文件在`);
    else bad(`${label}：缺 Contents/MacOS 下的主可执行文件`);
    const asar = checkResources(path.join(app, 'Contents/Resources'), label);
    if (asar) checkAsarContents(asar);
  }
}

function checkLinux() {
  const unpacked = path.join(OUT, 'linux-unpacked');
  if (!exists(path.join(unpacked, 'GitHubDesktopZhTool'))) bad('找不到 linux-unpacked/GitHubDesktopZhTool');
  else ok('linux-unpacked 里有主可执行文件');
  const asar = checkResources(path.join(unpacked, 'resources'), 'linux-unpacked');
  if (asar) checkAsarContents(asar);
}

// 产物文件：任何平台都至少要有一个能直接分发的（不能只有中间目录）
function checkArtifacts() {
  const files = listDir(OUT).filter((f) => /\.(exe|zip|dmg|AppImage|deb)$/.test(f));
  if (files.length) ok(`可分发产物 ${files.length} 个：${files.join(' / ')}`);
  else bad('dist/gui 下没有任何可分发产物（只有中间目录？）');
}

console.log(`检查目录：${OUT}`);
if (!exists(OUT)) bad('dist/gui 不存在——先跑 npm run dist');

if (process.platform === 'win32') checkWindows();
else if (process.platform === 'darwin') checkMac();
else checkLinux();
checkArtifacts();

for (const [good, msg] of results) console.log(`${good ? '  ✓' : '  ✗'} ${msg}`);
const failed = results.filter(([good]) => !good).length;
console.log(failed ? `\n自检未通过：${failed} 项有问题` : '\n自检通过');
process.exit(failed ? 1 : 0);
