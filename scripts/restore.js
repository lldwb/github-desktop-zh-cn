// restore.js — 还原官方原版 main.js / renderer.js
// 两条路径：
//   有备份 → 从「数据目录/tmp/backup/<版本>/」逐字节复制回来（精确还原）；
//   无备份 → 按字典逆向替换（中文 → 英文），与 patch 构成双向切换（见 common.reverseEntries）。
// 用途：字典有「删改」时必须先还原再重打——patch 是原地追加式，删掉的键不会自己从产物里退出。
'use strict';

const fs = require('fs');
const path = require('path');
const common = require('./common.js');
const dictSync = require('./dict-sync.js');
const restart = require('./restart.js');

const {
  locateApp,
  backupDir,
  backupExists,
  loadDict,
  reverseEntries,
  applyDictInStrings,
  checkSyntax,
  isPackaged,
} = common;

const TARGETS = ['main.js', 'renderer.js'];

function parseArgs(argv) {
  const args = { explicitPath: null, version: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--path') args.explicitPath = argv[++i];
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--help' || a === '-h') { args.help = true; }
    else throw new Error(`未知参数：${a}（--help 查看用法）`);
  }
  return args;
}

function printHelp() {
  console.log(`用法：node scripts/restore.js [选项]

把安装目录里的 main.js / renderer.js 还原成官方原版：
  有备份时从「数据目录/tmp/backup/<版本>/」逐字节复制回来（精确）；
  没有备份时按字典逆向替换（中文 → 英文），少数词形可能与官方略有差异。
还原完成后重启 GitHub Desktop。

选项：
  --path <目录>    显式指定 resources 目录（绕过自动探测，跨平台可用）
  --version <版本>  指定版本（默认取安装版本）
  -h, --help       显示本帮助`);
}

// 无备份时的逆向还原：先全部算好并做语法校验，通过后再统一落盘。
// 逐个文件边算边写会留下「只还原了一半」的中间状态。
async function restoreByReverse(app, version, log) {
  await dictSync.ensureDict(version).catch(() => {}); // 取不到就用本地/内嵌，由 loadDict 兜底报错
  const entries = loadDict(version);
  log('还原来源：字典逆向（没有备份）');

  const pending = [];
  let ambiguous = 0;
  let skipped = 0;
  for (const f of TARGETS) {
    const file = path.join(app.appDir, f);
    const rev = reverseEntries(entries, f);
    const before = fs.readFileSync(file, 'utf8');
    const { content: after, total } = applyDictInStrings(before, rev.entries);
    const { ok, output } = checkSyntax(after, file);
    if (!ok) {
      const e = new Error(`按字典还原后 ${f} 语法校验未通过，已放弃写盘（保留当前内容）：\n${output}`);
      e.hint = '该文件可能不是本工具汉化出来的；可到 https://desktop.github.com 重新安装该版本。';
      throw e;
    }
    pending.push({ file, f, after, total });
    ambiguous = Math.max(ambiguous, rev.ambiguous);
    skipped = Math.max(skipped, rev.skipped);
  }

  let total = 0;
  for (const p of pending) {
    fs.writeFileSync(p.file, p.after, 'utf8');
    total += p.total;
    log(`已还原：app/${p.f}（${p.total} 处）`);
  }
  return { total, ambiguous, skipped };
}

// 执行还原（CLI 与交互式入口共用）：args = { explicitPath, version, quiet }
// quiet 为真时不输出中间过程，只留最终结果（交互式菜单用）。
// 成功返回 { version, app, source, total, ambiguous, restarted }；source ∈ backup|reverse。
async function run(args = {}) {
  const log = args.quiet ? () => {} : console.log;
  const app = locateApp({ explicitPath: args.explicitPath });
  const version = args.version || app.version;
  const backup = backupDir(version);

  log(`安装版本：${app.version}`);

  let source = 'backup';
  let total = 0;
  let ambiguous = 0;
  let skipped = 0;

  if (backupExists(version)) {
    log(`还原来源：${backup}`);
    for (const f of TARGETS) {
      const dst = path.join(app.appDir, f);
      fs.copyFileSync(path.join(backup, f), dst);
      log(`已还原：app/${f}（${fs.statSync(dst).size} 字节）`);
    }
  } else {
    source = 'reverse';
    ({ total, ambiguous, skipped } = await restoreByReverse(app, version, log));
  }

  // 还原后重启：Electron 已把汉化代码载入内存，不重启仍是中文界面。
  // 应用原本没在运行时不动它（避免替用户多开窗口），只提示。
  const restarted = restart.restartApp(app.resourcesDir);

  return { version, app, source, total, ambiguous, skipped, restarted };
}

async function main() {
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
    const r = await run(args);
    const how = r.source === 'backup' ? '已从备份精确还原' : `已按字典逆向还原（${r.total} 处）`;
    console.log(
      r.restarted === 'restarted'
        ? `还原完成：${how}，并已重启 GitHub Desktop。`
        : `还原完成：${how}。启动 GitHub Desktop 查看效果。`
    );
    if (r.source === 'reverse' && (r.ambiguous > 0 || r.skipped > 0)) {
      const parts = [];
      if (r.ambiguous > 0) parts.push(`${r.ambiguous} 条译文对应多个英文原文`);
      if (r.skipped > 0) parts.push(`${r.skipped} 条译文是空格/标点等通用文本，保持原样未替换`);
      console.log(`提示：${parts.join('；')}，还原结果可能与官方略有差异。`);
    }
    if (r.source === 'backup' && !isPackaged()) {
      console.log('如需再次汉化：npm run patch。');
    }
  } catch (e) {
    console.error(`错误：${e.message}`);
    if (e.hint) console.error(e.hint);
    process.exit(e.exitCode || 1);
  }
}

// run：执行还原（交互式入口传 args 对象）；main：命令行入口（透传子命令时由 cli.js 调用）
module.exports = { run, main };

if (require.main === module) main();
