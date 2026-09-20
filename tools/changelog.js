// changelog.js — 从 CHANGELOG.md 提取指定版本的段落
// 用法：node tools/changelog.js <版本号> [--file <CHANGELOG 路径>]
//
// 用途：发版时把该版本的 CHANGELOG 段落作为 Release 正文（见 .github/workflows/build.yml
//       的 release job）；本地也可用它预览「这一版的 Release 会长什么样」。
//       找不到该版本时以非 0 退出，CI 据此在发版前拦住「CHANGELOG 漏写条目」。
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
// 与发版规范一致：条目形如 `## [1.2.3] - 2026-09-17`（日期可省略）
const HEADING_RE = /^## \[(\d+\.\d+\.\d+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/;

function parseArgs(argv) {
  const args = { version: null, file: path.join(REPO_ROOT, 'CHANGELOG.md') };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = path.resolve(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
    else if (args.version === null) args.version = a.replace(/^v/, '');
    else throw new Error(`未知参数：${a}（--help 查看用法）`);
  }
  return args;
}

function printHelp() {
  console.log(`用法：node tools/changelog.js <版本号> [选项]

提取 CHANGELOG.md 中该版本的段落（不含「## [版本]」标题行），输出到标准输出。
发版时 CI 用它生成 Release 正文，本地可用它预览。

选项：
  --file <路径>   指定 CHANGELOG 文件（默认仓库根的 CHANGELOG.md）
  -h, --help      显示本帮助

示例：
  node tools/changelog.js 0.1.0`);
}

// 取「该版本标题行」到「下一个版本标题行」之间的内容；无此版本返回 null
function extract(markdown, version) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => {
    const m = HEADING_RE.exec(l);
    return m !== null && m[1] === version;
  });
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n').trim();
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
  if (!args.version) {
    console.error('错误：缺少版本号（用法：node tools/changelog.js <版本号>，--help 查看帮助）');
    process.exit(1);
  }

  let markdown;
  try {
    markdown = fs.readFileSync(args.file, 'utf8');
  } catch (e) {
    console.error(`错误：读不到 ${args.file}`);
    process.exit(1);
  }

  const section = extract(markdown, args.version);
  if (section === null) {
    console.error(`错误：CHANGELOG 里没有 ${args.version} 的条目（文件：${args.file}）`);
    process.exit(1);
  }
  if (section === '') {
    console.error(`错误：CHANGELOG 里 ${args.version} 的条目是空的`);
    process.exit(1);
  }
  process.stdout.write(`${section}\n`);
}

main();
