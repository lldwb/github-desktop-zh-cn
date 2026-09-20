// verify.js — 校验替换结果：版本一致性、字典命中率、补丁后 JS 语法
'use strict';

const fs = require('fs');
const path = require('path');
const {
  locateApp, listDictVersions, loadDict, scopedEntries, stringLiterals, checkSyntax,
  effectiveKeys, isPatched, TARGETS,
} = require('../common');
const contextMenu = require('../inject/context-menu.js');

function parseArgs(argv) {
  const args = { explicitPath: null, version: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--path') args.explicitPath = argv[++i];
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`未知参数：${a}（--help 查看用法）`);
  }
  return args;
}

function printHelp() {
  console.log(`用法：node scripts/cmd/verify.js [选项]

校验补丁结果：字典与安装版本一致性、每条字典在文件中的命中次数、补丁后 JS 语法。

选项：
  --version <版本>  指定字典版本（默认取 dictionaries/ 下最新版本）
  --path <目录>    显式指定 resources 目录
  -h, --help       显示本帮助`);
}

// 1. 版本一致性：字典目录名与安装版本必须相等（错配可能导致应用无法启动）
function checkVersion(version, app) {
  if (version === app.version) {
    console.log(`版本一致性：字典 ${version} = 安装 ${app.version} ✓`);
    return true;
  }
  console.error(`版本一致性：字典 ${version} ≠ 安装 ${app.version} ✗`);
  return false;
}

// 2. 字典命中率（两个文件合并统计；与 patch 口径一致：字符串字面量整串匹配 + 整模板键）。
// 返回 { perFile, keys }——顺带给出两个文件的「生效键」并集，供下面的覆盖率报告用。
function checkHits(app, entries) {
  const perFile = {};
  for (const f of TARGETS) {
    const file = path.join(app.appDir, f);
    const content = fs.readFileSync(file, 'utf8');
    const fileEntries = scopedEntries(entries, f);
    const keyHits = new Map();
    let hits = 0;
    for (const l of stringLiterals(content)) {
      if (fileEntries.has(l.content)) {
        keyHits.set(l.content, (keyHits.get(l.content) || 0) + 1);
        hits++;
      }
    }
    perFile[f] = keyHits;
    console.log(`${f}：命中 ${hits} 处`);
  }
  return { perFile, keys: effectiveKeys(entries) };
}

// 2b. 右键菜单：标签由 Electron 运行时按 role 生成、产物里没有字面量，靠注入的代码造出来再由字典译掉
//（见 context-menu.js）。这里只看两件事：代码在不在、本平台这套标签字典覆盖得全不全。
function checkContextMenu(app, entries) {
  const mainContent = fs.readFileSync(path.join(app.appDir, 'main.js'), 'utf8');
  const menuRange = contextMenu.blockRange(mainContent);
  if (menuRange) {
    const labels = Object.values(contextMenu.labelsFor(process.platform === 'darwin'));
    const mainEntries = scopedEntries(entries, 'main.js');
    const uncovered = labels.filter((l) => !mainEntries.has(l));
    const state = uncovered.length === 0 ? '✓' : `（${uncovered.join(' / ')} 保持英文）`;
    console.log(
      `右键菜单代码：已注入，标签 ${labels.length} 个，字典未覆盖 ${uncovered.length} 个${state}`
    );
  } else {
    console.log('右键菜单代码：未注入（产物是还原过的、或补丁是旧版工具打的）');
  }
}

// 覆盖率报告：已汉化看「仍残留英文的条目」，未汉化看「两个文件均 0 命中」的条目
function reportCoverage(keys, perFile, patched) {
  const globalMisses = keys.filter(
    (k) => !perFile['main.js'].has(k) && !perFile['renderer.js'].has(k)
  );
  if (patched) {
    // 已汉化：报告仍残留的英文条目（未替换到的）
    const remain = keys.filter((k) => perFile['main.js'].has(k) || perFile['renderer.js'].has(k));
    console.log(`已汉化：仍残留英文的条目 ${remain.length}/${keys.length} 条`);
    if (remain.length > 0) {
      for (const k of remain.slice(0, 20)) console.log(`    - ${k}`);
      if (remain.length > 20) console.log(`    …（其余 ${remain.length - 20} 条略）`);
    }
  } else {
    // 未汉化：0 命中条目提示字典可能与版本不符
    console.log(`未汉化：两个文件均 0 命中的条目 ${globalMisses.length}/${keys.length} 条`);
    if (globalMisses.length > 0) {
      for (const k of globalMisses.slice(0, 20)) console.log(`    - ${k}`);
      if (globalMisses.length > 20) console.log(`    …（其余 ${globalMisses.length - 20} 条略）`);
    }
  }
}

// 3. 语法校验（补丁后文件是否仍是合法 JS）
function checkSyntaxAll(app) {
  let passed = true;
  for (const f of TARGETS) {
    const file = path.join(app.appDir, f);
    const { ok, output } = checkSyntax(fs.readFileSync(file, 'utf8'), file);
    if (ok) {
      console.log(`语法校验 ${f}：通过 ✓`);
    } else {
      console.error(`语法校验 ${f}：失败 ✗`);
      if (output) console.error(output);
      passed = false;
    }
  }
  return passed;
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

  try {
    const versions = listDictVersions();
    if (versions.length === 0) throw new Error('dictionaries/ 下没有版本目录');
    const version = args.version || versions[versions.length - 1];
    const app = locateApp({ explicitPath: args.explicitPath });

    let failed = false;

    // 1. 版本一致性
    if (!checkVersion(version, app)) failed = true;

    // 2. 字典命中率（两个文件合并统计；与 patch 口径一致：字符串字面量整串匹配 + 整模板键）
    const entries = loadDict(version);
    const { perFile, keys } = checkHits(app, entries);

    // 2b. 右键菜单：标签由 Electron 运行时按 role 生成、产物里没有字面量，靠注入的代码造出来再由字典译掉
    //（见 context-menu.js）。这里只看两件事：代码在不在、本平台这套标签字典覆盖得全不全。
    checkContextMenu(app, entries);

    // 已汉化判定：备份存在且与当前文件不一致（判据的 SSOT 在 common.isPatched）
    reportCoverage(keys, perFile, isPatched(app.appDir, version));

    // 3. 语法校验（补丁后文件是否仍是合法 JS）
    if (!checkSyntaxAll(app)) failed = true;

    if (failed) {
      console.error('\n校验未通过，请勿启动应用；可恢复官方版后重新打补丁。');
      process.exit(1);
    }
    console.log('\n校验通过。');
  } catch (e) {
    console.error(`错误：${e.message}`);
    process.exit(1);
  }
}

main();
