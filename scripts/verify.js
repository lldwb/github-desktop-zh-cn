// verify.js — 校验替换结果：版本一致性、字典命中率、补丁后 JS 语法
'use strict';

const fs = require('fs');
const path = require('path');
const {
  locateApp, listDictVersions, loadDict, scopedEntries, stringLiterals, checkSyntax, backupDir,
} = require('./common');

const TARGETS = ['main.js', 'renderer.js'];

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
  console.log(`用法：node scripts/verify.js [选项]

校验补丁结果：字典与安装版本一致性、每条字典在文件中的命中次数、补丁后 JS 语法。

选项：
  --version <版本>  指定字典版本（默认取 dictionaries/ 下最新版本）
  --path <目录>    显式指定 resources 目录
  -h, --help       显示本帮助`);
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
    if (version === app.version) {
      console.log(`版本一致性：字典 ${version} = 安装 ${app.version} ✓`);
    } else {
      console.error(`版本一致性：字典 ${version} ≠ 安装 ${app.version} ✗`);
      failed = true;
    }

    // 2. 字典命中率（两个文件合并统计；与 patch 口径一致：字符串字面量整串匹配 + 整模板键）
    const entries = loadDict(version);
    const effectiveKeys = [
      ...new Set([
        ...scopedEntries(entries, 'main.js').keys(),
        ...scopedEntries(entries, 'renderer.js').keys(),
      ]),
    ];
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

    // 已汉化判定：备份存在且与当前文件不一致
    const backup = backupDir(version);
    const patched = TARGETS.some((f) => {
      const b = path.join(backup, f);
      return fs.existsSync(b) && !fs.readFileSync(b).equals(fs.readFileSync(path.join(app.appDir, f)));
    });

    const globalMisses = effectiveKeys.filter(
      (k) => !perFile['main.js'].has(k) && !perFile['renderer.js'].has(k)
    );
    if (patched) {
      // 已汉化：报告仍残留的英文条目（未替换到的）
      const remain = effectiveKeys.filter((k) => perFile['main.js'].has(k) || perFile['renderer.js'].has(k));
      console.log(`已汉化：仍残留英文的条目 ${remain.length}/${effectiveKeys.length} 条`);
      if (remain.length > 0) {
        for (const k of remain.slice(0, 20)) console.log(`    - ${k}`);
        if (remain.length > 20) console.log(`    …（其余 ${remain.length - 20} 条略）`);
      }
    } else {
      // 未汉化：0 命中条目提示字典可能与版本不符
      console.log(`未汉化：两个文件均 0 命中的条目 ${globalMisses.length}/${effectiveKeys.length} 条`);
      if (globalMisses.length > 0) {
        for (const k of globalMisses.slice(0, 20)) console.log(`    - ${k}`);
        if (globalMisses.length > 20) console.log(`    …（其余 ${globalMisses.length - 20} 条略）`);
      }
    }

    // 3. 语法校验（补丁后文件是否仍是合法 JS）
    for (const f of TARGETS) {
      const file = path.join(app.appDir, f);
      const { ok, output } = checkSyntax(fs.readFileSync(file, 'utf8'), file);
      if (ok) {
        console.log(`语法校验 ${f}：通过 ✓`);
      } else {
        console.error(`语法校验 ${f}：失败 ✗`);
        if (output) console.error(output);
        failed = true;
      }
    }

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
