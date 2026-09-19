// build/check-gui-dist.js — GUI 产物自检（零依赖，CI 与本地共用）
//
// 只做**静态**检查：产物文件在不在、应用包结构对不对、内置字典进没进包、
// Windows 产物是不是 GUI 子系统（双击不弹控制台）、体积裁剪有没有生效、
// 各产物多少 MB（日志里直接看得到，不必下载附件）。界面能不能起、汉化能不能成
// 属于运行态，得在带桌面的机器上实测——CI runner 没有桌面会话，起不了窗口。
//
// 用法：npm run dist 之后 `node build/check-gui-dist.js`（按当前平台检查对应产物）
'use strict';

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'dist', 'gui');
const PE_SIGNATURE = Buffer.from('PE');
// 与 electron-builder.yml 的 electronLanguages 一致：只保留这两个语言包（裁剪理由见该文件注释）
const KEEP_LOCALES = ['en-US', 'zh-CN'];
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

// macOS 的语言目录与 Windows / Linux 不是一套：语言包是 .lproj 目录，且分布在两处
//（应用级 Contents/Resources 与 Electron Framework 的 Resources，electron-builder 两处都裁），
// 目录名用下划线（zh_CN.lproj），与 electronLanguages 里的连字符写法（zh-CN）互不相认——
// 所以配置里两种写法都要写。这里把两处合并核对：中文要在，也不该剩下第三种语言。
function checkMacLocales(app, label) {
  const dirs = [
    path.join(app, 'Contents/Resources'),
    path.join(app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources'),
  ];
  const uniq = [...new Set(dirs.flatMap((d) => listDir(d).filter((f) => f.endsWith('.lproj'))))].sort();
  if (!uniq.length) {
    bad(`${label}：应用级与 Framework 级都找不到 .lproj`);
    return;
  }
  const items = uniq.map((name) => ({ name, lang: name.replace(/\.lproj$/i, '').toLowerCase().replace(/_/g, '-') }));
  const extra = items.filter((it) => !/^(en|zh)(-|$)/.test(it.lang)).map((it) => it.name);
  if (!items.some((it) => it.lang === 'zh' || it.lang.startsWith('zh-'))) {
    bad(`${label}：没有中文语言目录（${uniq.join(' / ')}）——electronLanguages 里要同时列 zh-CN 与 zh_CN`);
  } else if (extra.length) {
    bad(`${label}：语言目录没裁干净，多出 ${extra.join(' / ')}`);
  } else {
    ok(`${label}：语言目录 ${uniq.join(' / ')}`);
  }
}

// 语言包裁剪核验（electron-builder.yml 的 electronLanguages）：Electron 自带 55 个语言包
// 共约 50 MB，本应用界面是自绘 HTML，只需中英两个（缺语言包时 Chromium 回退 en-US）。
// Windows / Linux 的布局是 locales/<语言>.pak；macOS 是 .lproj 目录，见 checkMacLocales。
function checkLocales(dir, label) {
  const paks = listDir(dir).filter((f) => f.endsWith('.pak'));
  if (!paks.length) {
    bad(`${label}：找不到 locales 目录或里面没有 .pak（${dir}）`);
    return;
  }
  const extra = paks.filter((f) => !KEEP_LOCALES.includes(f.replace(/\.pak$/, '')));
  if (extra.length) bad(`${label}：语言包没裁干净，多出 ${extra.length} 个（${extra.slice(0, 5).join(' / ')}…）`);
  else ok(`${label}：语言包已裁剪到 ${paks.join(' / ')}`);
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
  checkLocales(path.join(unpacked, 'locales'), 'win-unpacked');
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
    // macOS 的语言目录（.lproj）名称与 electronLanguages 的写法不同一套，且分布在两处
    //（应用级与 Framework 级），合并核对，见 checkMacLocales。
    checkMacLocales(app, label);
  }
}

function checkLinux() {
  const unpacked = path.join(OUT, 'linux-unpacked');
  if (!exists(path.join(unpacked, 'GitHubDesktopZhTool'))) bad('找不到 linux-unpacked/GitHubDesktopZhTool');
  else ok('linux-unpacked 里有主可执行文件');
  const asar = checkResources(path.join(unpacked, 'resources'), 'linux-unpacked');
  if (asar) checkAsarContents(asar);
  checkLocales(path.join(unpacked, 'locales'), 'linux-unpacked');
}

// 产物文件：任何平台都至少要有一个能直接分发的（不能只有中间目录），且名字必须走 gui 通道命名
//（<项目名>-gui-v<版本>-<平台>-<架构>…，规范见 AGENTS.md「发版」一节）。
// 顺带把每个产物的体积打进日志——「跑一次 CI 看四平台体积」靠的就是这里，不必下载附件；
// 超 100 MB 只告警不判失败（CI 上打成 ::warning:: 注解，本地是一行提示）：Gitee 附件单文件
// 上限 100 MB（见 AGENTS.md「发版」）。各平台产物形态与压缩算法见 electron-builder.yml。
function checkArtifacts() {
  const files = listDir(OUT).filter((f) => /\.(exe|zip|7z|dmg|AppImage|deb)$/.test(f));
  if (!files.length) {
    bad('dist/gui 下没有任何可分发产物（只有中间目录？）');
    return;
  }
  ok(`可分发产物 ${files.length} 个：${files.join(' / ')}`);
  for (const f of files) {
    const mb = fs.statSync(path.join(OUT, f)).size / (1024 * 1024);
    const line = `${f}：${mb.toFixed(1)} MB`;
    if (mb > 100) {
      console.log(process.env.CI ? `::warning::${line}（超过 Gitee 附件单文件上限 100 MB）` : `  !  ${line}（超过 Gitee 附件单文件上限 100 MB）`);
    } else {
      console.log(`  ·  ${line}`);
    }
  }
  const offName = files.filter((f) => !/^github-desktop-zh-cn-gui-v\d+\.\d+\.\d+-/.test(f));
  if (offName.length) bad(`产物名不符合命名规范（应为 github-desktop-zh-cn-gui-v<版本>-…）：${offName.join(' / ')}`);
  else ok('产物名符合 gui 通道命名规范');
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
