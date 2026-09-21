#!/usr/bin/env node
// 生成 / 刷新 docs/design/gui/design.md 里两个模态窗口的界面示意块。
//
// 为什么要脚本：等宽图按**显示宽度**对齐——中文与全角标点占 2 格、ASCII 与盒绘制
// 字符（U+2500–U+257F）占 1 格。按 String.length 补白会让新画的框比既有图宽出一截
// （踩过），手写空格更不可靠。幂等：先删掉上一次插入的块再重新插入。
//
// 用法：
//   node tools/make-gui-fig.cjs                     # 刷新 docs/design/gui/design.md
//   node tools/make-gui-fig.cjs --file <路径>       # 指定目标文档（相对仓库根或绝对路径）
//   node tools/make-gui-fig.cjs --dry-run           # 只打印将写入的块，不落盘
//
// 退出码：0 成功；1 锚点未命中 / 旧块不完整 / 宽度自检不过；2 参数错误。
'use strict';
const fs = require('fs');
const path = require('path');
const common = require('../scripts/common.js');

const ROOT = path.resolve(__dirname, '..');

function usage(msg) {
  if (msg) console.error(msg);
  console.error('用法：node tools/make-gui-fig.cjs [--file <路径>] [--dry-run]');
  process.exit(2);
}

const argv = process.argv.slice(2);
let target = 'docs/design/gui/design.md';
let dryRun = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry-run') dryRun = true;
  else if (a === '--file') {
    const v = argv[++i];
    if (!v || v.startsWith('--')) usage('--file 缺少值');
    target = v;
  } else if (a === '--help' || a === '-h') usage();
  else usage(`未知参数：${a}`);
}
const file = path.isAbsolute(target) ? target : path.join(ROOT, target);

// —— 显示宽度：盒绘制字符与 ASCII 算 1 格，CJK / 全角标点算 2 格 ——
function dw(s) {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    w += cp >= 0x2500 && cp <= 0x257f ? 1 : cp > 0x2e80 ? 2 : 1;
  }
  return w;
}

const W = 63; // 边框内宽度：┌ + 63×─ + ┐ = 65 格
const row = (t) => {
  const inner = ' ' + t;
  return '│' + inner + ' '.repeat(Math.max(0, W - dw(inner))) + '│';
};
// 左右两端对齐的一行：左侧控件贴左、按钮组贴右（界面里「关闭」就在右下角）
const rowLR = (left, right) => {
  const inner = ' ' + left;
  const gap = W - dw(inner) - dw(right);
  return '│' + inner + ' '.repeat(Math.max(1, gap)) + right + '│';
};
const title = (t) => {
  const head = `── ${t} `;
  return '┌' + head + '─'.repeat(Math.max(0, W - dw(head))) + '┐';
};
const bottom = () => '└' + '─'.repeat(W) + '┘';

const switchLines = [
  '切换 GitHub Desktop 版本',
  '',
  '本机装了多个时（官方升级后旧目录会留着）在这里换一个；',
  '之后汉化 / 还原 / 更新管控与字典表格都作用于选中的版本。',
  '',
  '本机已安装',
  '  3.6.6  [当前]',
  '    C:\\Users\\…\\GitHubDesktop\\app-3.6.6\\resources',
  '  3.6.5',
  '    C:\\Users\\…\\GitHubDesktop\\app-3.6.5\\resources',
  '可下载（官方 Release）',
  '  3.6.4  293 MB',
  '  3.6.0  218 MB',
];

// 地址取自 common.repoUrls()——与 GUI「关于」窗口（gui/ipc/misc.js）展示的是同一份，
// 别在这里再写一份硬编码（换仓库时图会与界面不一致）。
const URLS = common.repoUrls();

const aboutLines = [
  'GitHub Desktop 汉化工具',
  '',
  '版本      v1.1.0',
  `项目地址  ${URLS.repo}`,
  `国内镜像  ${URLS.mirror}`,
  '许可证    GPL-3.0',
  '数据目录  D:\\工具',
];

const FIG_HEAD = '两个模态窗口（点工具栏按钮弹出；点遮罩、按 Esc 或点「关闭」关掉）——参考截图里没有，是本仓库新增的：';
const FIG_PREFIX = '两个模态窗口（点';

const fig = [
  '',
  FIG_HEAD,
  '',
  title('切换版本'),
  ...switchLines.map(row),
  row(''),
  rowLR('[ ] 显示没汉化的版本', '[关闭]'),
  bottom(),
  '',
  title('关于'),
  ...aboutLines.map(row),
  row(''),
  rowLR('', '[检查更新] [同步字典] [关闭]'),
  bottom(),
];

// 宽度自检：每一条框线（顶 / 底 / 内容）都恰好 65 格
const bad = fig.filter((l) => /^[┌└│]/.test(l) && dw(l) !== 65);
if (bad.length) {
  console.error(`宽度自检不过：${bad.length} 行宽度不是 65 格`);
  for (const l of bad) console.error(`  ${dw(l)} 格 | ${l}`);
  process.exit(1);
}

if (!fs.existsSync(file)) {
  console.error(`目标文件不存在：${file}`);
  process.exit(1);
}
let src = fs.readFileSync(file, 'utf8');
const EOL = src.includes('\r\n') ? '\r\n' : '\n';

// 幂等：先删掉上一次插入的块（连同它前面的空行——插入时会补回，否则每次重跑都多留一个空行）
let lines = src.split(EOL);
const start = lines.findIndex((l) => l.startsWith(FIG_PREFIX));
if (start >= 0) {
  const end = lines.findIndex((l, i) => i > start && l === '```');
  if (end < 0) {
    console.error('找到旧块但找不到结束的 ```，原文件未改动');
    process.exit(1);
  }
  let from = start;
  while (from > 0 && lines[from - 1] === '') from--;
  lines.splice(from, end - from);
  src = lines.join(EOL);
  console.log(`已移除上一次插入的 ${end - from} 行`);
}

const anchor = `${EOL}\`\`\`${EOL}${EOL}与截图的**有意差异**`;
if (!src.includes(anchor)) {
  console.error(`锚点未命中（找不到「与截图的**有意差异**」前的围栏），原文件未改动：${file}`);
  process.exit(1);
}
src = src.replace(anchor, `${EOL}${fig.join(EOL)}${EOL}\`\`\`${EOL}${EOL}与截图的**有意差异**`);

if (dryRun) {
  console.log(`[dry-run] 将写入 ${fig.length} 行，未落盘：`);
  console.log(fig.join('\n'));
  process.exit(0);
}
fs.writeFileSync(file, src);
console.log(`已插入 ${fig.length} 行子窗口示意（按显示宽度对齐）→ ${path.relative(ROOT, file)}`);
