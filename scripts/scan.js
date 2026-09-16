// scan.js — 未翻译界面文案自查
// 思路：官方产物的 sourcemap（renderer.js.map）里有 GitHub Desktop 自有源码（app/src/**），
// 从中提取界面文案候选（JSX 文本节点 + 字符串字面量），再回到产物里核对是否存在、是否已收录字典。
// 产物侧按「忽略大小写 + 折叠空白」匹配：产物里的文案经 sentenceCase 处理（Confirm discard changes），
// 与源码的 Title Case（Confirm Discard Changes）不同，且 JSX 多行文本在产物里带转义换行与缩进。
'use strict';

const fs = require('fs');
const path = require('path');
const { locateApp, listDictVersions, loadDict, scopedEntries, stringLiterals } = require('./common');

function parseArgs(argv) {
  const args = { explicitPath: null, version: null, out: null, minLength: 8 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--path') args.explicitPath = argv[++i];
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--min-length') args.minLength = Number(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`未知参数：${a}（--help 查看用法）`);
  }
  return args;
}

function printHelp() {
  console.log(`用法：node scripts/scan.js [选项]

自查「官方源码里有、字典尚未收录」的界面文案候选（读安装目录的 renderer.js.map）。
报告写入 --out 指定的文件（默认打印到终端），供人工判断后补进字典。

选项：
  --out <文件>      报告输出路径（默认 stdout）
  --min-length <n>  候选最短长度（默认 8，太小会产生大量噪声）
  --version <版本>  指定字典版本（默认取 dictionaries/ 下最新版本）
  --path <目录>     显式指定 resources 目录
  -h, --help        显示本帮助`);
}

// 产物侧归一化：转义换行/制表符当空白，折叠连续空白，忽略大小写
const normalize = (c) => c.replace(/\\n|\\t|\\r/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

// 明显不是界面文案的候选（代码键名、CSS 类、路径、URL、模型/SVG 数据等）
function looksLikeNoise(c) {
  if (!/[A-Za-z]{2}/.test(c)) return true;
  if (/[:{}=<>\\`#$~^|]|--|\/\/|=>|&&|\|\||@/.test(c)) return true;
  if (/^[a-z0-9_-]+$/.test(c)) return true; // 小写单词 / kebab-case / 枚举值
  if (/^[a-z][A-Za-z0-9]*([A-Z][A-Za-z0-9]*)+$/.test(c)) return true; // camelCase
  if (/^(?:M|m)[\d.\- ]+[a-zA-Z]/.test(c)) return true; // SVG path
  if (/\.(?:tsx?|js|json|md|png|svg|cmd|exe|node)$/.test(c)) return true;
  if (/https?:|^\d/.test(c)) return true;
  return false;
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
      throw new Error(`版本不一致：字典版本 ${version} ≠ 安装版本 ${app.version}`);
    }

    const mapFile = path.join(app.appDir, 'renderer.js.map');
    if (!fs.existsSync(mapFile)) {
      throw new Error(`缺少 sourcemap：${mapFile}（自查需要官方产物自带的 renderer.js.map）`);
    }
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));

    // 待查条目：两个文件合并（忽略作用域，只判断「是否已收录」）
    const entries = loadDict(version);
    const known = new Set([
      ...[...scopedEntries(entries, 'main.js').keys()].map(normalize),
      ...[...scopedEntries(entries, 'renderer.js').keys()].map(normalize),
    ]);

    // 产物侧索引：归一化文本 → 真实字面量
    const index = new Map();
    for (const f of ['main.js', 'renderer.js']) {
      const src = fs.readFileSync(path.join(app.appDir, f), 'utf8');
      for (const l of stringLiterals(src)) {
        if (l.template) continue;
        const k = normalize(l.content);
        if (!index.has(k)) index.set(k, new Set());
        index.get(k).add(l.content);
      }
    }

    const found = new Map(); // 产物真实文本 → 源码文件
    let scanned = 0;
    for (let i = 0; i < map.sources.length; i++) {
      const src = map.sources[i];
      const content = map.sourcesContent[i];
      if (!/\/app\/src\/(ui|lib)\//.test(src) || !content) continue;
      scanned++;
      const file = src.replace(/^.*\/app\/src\//, '');
      const add = (text) => {
        const c = text.replace(/\s+/g, ' ').trim();
        if (!c || c.length < args.minLength) return;
        if (looksLikeNoise(c)) return;
        if (known.has(normalize(c))) return;
        const real = index.get(normalize(c));
        if (!real) return; // 产物里不存在（JSX 元素拼接出来的显示文本等）
        for (const r of real) if (!found.has(r)) found.set(r, file);
      };
      // 1) 字符串字面量（含模板文本段）
      for (const l of stringLiterals(content)) add(l.content);
      // 2) JSX 文本节点
      const re = />([^<>{}\n]{2,200})</g;
      let m;
      while ((m = re.exec(content))) add(m[1]);
    }

    const rows = [...found.entries()].sort((a, b) => a[0].length - b[0].length);
    const lines = [
      `# 未翻译界面文案候选（字典 ${version}，扫描 ${scanned} 个自有源文件）`,
      `# 共 ${rows.length} 条；格式：<产物中的原文> <TAB> <来源文件>`,
      '',
      ...rows.map(([text, file]) => `${text}\t${file}`),
    ];
    if (args.out) {
      fs.writeFileSync(args.out, lines.join('\n') + '\n', 'utf8');
      console.log(`候选 ${rows.length} 条 → ${args.out}`);
    } else {
      console.log(lines.join('\n'));
    }
  } catch (e) {
    console.error(`错误：${e.message}`);
    process.exit(1);
  }
}

main();
