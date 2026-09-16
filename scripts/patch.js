// patch.js — 按字典替换 main.js / renderer.js 中的界面文本
// 策略：只在字符串字面量内做整串替换（common.applyDictInStrings），
// 保护标识符 / 属性名 / 正则 / 注释，并避免子串误伤协议串与拼接片段
'use strict';

const fs = require('fs');
const path = require('path');
const { locateApp, listDictVersions, loadDict, scopedEntries, backupAppFiles, backupExists, backupDir, applyDictInStrings } = require('./common');

const TARGETS = ['main.js', 'renderer.js'];

function parseArgs(argv) {
  const args = { dryRun: false, explicitPath: null, version: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--path') args.explicitPath = argv[++i];
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`未知参数：${a}（--help 查看用法）`);
  }
  return args;
}

function printHelp() {
  console.log(`用法：node scripts/patch.js [选项]

按 dictionaries/<版本>/zh-CN.json 替换安装目录中 main.js / renderer.js 的界面文本。
写回前自动备份原文件到 tmp/backup/<版本>/。

选项：
  --dry-run        预览替换结果，不写盘
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
    if (version !== app.version) {
      console.error(`版本不一致：字典版本 ${version} ≠ 安装版本 ${app.version}`);
      console.error('请使用与安装版本对应的字典（--version 指定），错配可能导致应用无法启动。');
      process.exit(2);
    }

    const entries = loadDict(version);
    console.log(`字典：dictionaries/${version}/zh-CN.json（${entries.size} 条）`);
    console.log(`目标版本：${app.version}（${app.appDir}）`);

    // 「已汉化」判定必须在写回之前做：首次汉化时备份与当前文件相同（都是官方原版），
    // 判定为未汉化，0 命中条目才会作为「需人工核对」报出来，而不是被当成预期
    const backup = backupDir(version);
    const alreadyPatched = backupExists(version) && TARGETS.some((f) => {
      const b = path.join(backup, f);
      const cur = path.join(app.appDir, f);
      return fs.existsSync(b) && !fs.readFileSync(b).equals(fs.readFileSync(cur));
    });

    let totalAll = 0;
    const perFile = {};
    for (const f of TARGETS) {
      const file = path.join(app.appDir, f);
      const content = fs.readFileSync(file, 'utf8');
      // 只在字符串字面量内替换，保护标识符 / 属性名 / 正则 / 注释（单字词如 Error 亦是 JS 标识符）
      // 生效条目 = 全局键 + 作用域指向本文件的键（同名文本在两个文件中语义不同时按文件隔离）
      const { content: patched, total, perKey } = applyDictInStrings(content, scopedEntries(entries, f));
      perFile[f] = perKey;
      console.log(`\n${f}：命中 ${total} 处`);
      totalAll += total;

      if (args.dryRun) continue;
      if (!backupExists(version)) {
        const backed = backupAppFiles(app.appDir, version);
        for (const { f: bf, skipped } of backed) {
          console.log(`${skipped ? '已存在，跳过' : '已备份'}：tmp/backup/${version}/${bf}`);
        }
      }
      fs.writeFileSync(file, patched, 'utf8');
      console.log(`已写回：${file}`);
    }

    // 两个文件都未命中的条目（真正缺失，可能为版本错配或条目失效）
    // 已汉化时（增量补丁）0 命中属预期：英文串已被替换
    // 统计口径按「文件生效键」（作用域键去前缀）合并去重
    const effectiveKeys = [
      ...new Set([
        ...scopedEntries(entries, 'main.js').keys(),
        ...scopedEntries(entries, 'renderer.js').keys(),
      ]),
    ];
    const globalMisses = effectiveKeys.filter(
      (k) => !perFile['main.js'].has(k) && !perFile['renderer.js'].has(k)
    );
    if (globalMisses.length > 0 && !alreadyPatched) {
      console.log(`\n两个文件均 0 命中的条目 ${globalMisses.length} 条（需人工核对，可暂不处理）：`);
      for (const k of globalMisses) console.log(`    - ${k}`);
    } else if (globalMisses.length > 0) {
      console.log(`\n（已汉化状态，0 命中条目 ${globalMisses.length} 条属预期——英文串已被此前补丁替换）`);
    }

    console.log(`\n合计命中 ${totalAll} 处。`);
    if (args.dryRun) {
      console.log('（--dry-run 预览，未写盘）');
    } else {
      console.log('汉化完成。启动 GitHub Desktop 查看效果；恢复官方版：npm run restore。');
    }
  } catch (e) {
    console.error(`错误：${e.message}`);
    process.exit(1);
  }
}

main();
