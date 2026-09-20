// restore.js — 还原官方原版 main.js / renderer.js
// 两条路径：
//   有备份 → 从「数据目录/tmp/backup/<版本>/」逐字节复制回来（精确还原）；
//   无备份 → 按字典逆向替换（中文 → 英文），与 patch 构成双向切换（见 common.reverseEntries）。
// 用途：字典有「删改」时必须先还原再重打——patch 是原地追加式，删掉的键不会自己从产物里退出。
'use strict';

const fs = require('fs');
const path = require('path');
const common = require('../common.js');
const dictSync = require('../dict/dict-sync.js');
const restart = require('./restart.js');
const updateControl = require('../inject/update-control.js');

const {
  locateApp,
  backupDir,
  backupExists,
  isPatched,
  loadDict,
  reverseEntries,
  applyDictInStrings,
  checkSyntax,
  isPackaged,
  PATCH_GROUPS,
  PATCH_GROUP_LABELS,
  getPatchGroups,
  setPatchGroups,
  dataRoot,
} = common;

const TARGETS = ['main.js', 'renderer.js'];

function parseArgs(argv) {
  const args = { explicitPath: null, version: null, groups: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--path') args.explicitPath = argv[++i];
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--group') args.groups.push(argv[++i]);
    else if (a === '--help' || a === '-h') { args.help = true; }
    else throw new Error(`未知参数：${a}（--help 查看用法）`);
  }
  return args;
}

function printHelp() {
  console.log(`用法：node scripts/cmd/restore.js [选项]

把安装目录里的 main.js / renderer.js 还原成官方原版：
  有备份时从「数据目录/tmp/backup/<版本>/」逐字节复制回来（精确）；
  没有备份时按字典逆向替换（中文 → 英文），少数词形可能与官方略有差异。
还原完成后重启 GitHub Desktop。

选项：
  --path <目录>    显式指定 resources 目录（绕过自动探测，跨平台可用）
  --version <版本>  指定版本（默认取安装版本）
  --group <组名>    只撤指定的补丁组（可重复），其余组原样保留。
                    组名：i18n（汉化）、updateControl（更新管控）。
                    不给该参数时整份还原成官方原版。
  -h, --help       显示本帮助`);
}

// 按组还原：只撤指定的补丁组，其余组从官方原文备份重新应用一遍。
// **重放而不是逐组撤销**——产物是若干补丁叠加的结果，逆运算既难写又易错（注入块要精确
// 摘除、文案替换要逐条逆推），而从权威的官方原文重放剩下的组，结果与「一开始就只打这几组」
// 逐字节相同。这也正是备份始终只有一份（官方原文）的原因。
async function restoreGroups(app, version, removeGroups, log) {
  const bad = removeGroups.filter((g) => !PATCH_GROUPS.includes(g));
  if (bad.length > 0) {
    throw new Error(`未知补丁组：${bad.join(', ')}（可用：${PATCH_GROUPS.join(' / ')}）`);
  }
  if (!backupExists(version)) {
    throw new Error(`没有 ${version} 的官方原文备份（${backupDir(version)}），无法按组还原——请改用整份还原`);
  }

  const current = getPatchGroups(version);
  // 账上没有记录、产物却已改动：多半是**记账功能上线前**打的补丁（老用户装的就是这种）。
  // 这时按组还原会把没记上账的那组一起还原掉——用户只想撤更新管控，汉化却一并没了。
  // 与其猜「他大概打过汉化」，不如让他先重打一次把账补上（patch 是幂等的）。
  if (current.length === 0 && isPatched(app.appDir, version)) {
    throw new Error(
      `账上没有 ${version} 的补丁记录，产物却已不是官方原文——无法判断该保留哪几组。` +
        `请先执行一次 patch（会补记账），或改用整份还原（不带 --group）。`
    );
  }
  const keep = current.filter((g) => !removeGroups.includes(g));
  const label = (gs) => (gs.length ? gs.map((g) => PATCH_GROUP_LABELS[g] || g).join('、') : '无');
  log(`补丁组：当前 ${label(current)}；撤 ${label(removeGroups)}；保留 ${label(keep)}`);

  // 1) 先回到官方原文
  for (const f of TARGETS) {
    const dst = path.join(app.appDir, f);
    fs.copyFileSync(path.join(backupDir(version), f), dst);
    log(`已还原官方原文：app/${f}`);
  }

  // 2) 重放要保留的组
  if (keep.includes('i18n')) {
    log('\n重新应用汉化…');
    // noRestart：由本函数末尾统一重启一次，避免两次拉起应用
    await require('./patch.js').run({ version, explicitPath: app.resourcesDir, quiet: false, noRestart: true });
  }
  if (keep.includes('updateControl')) {
    const mainFile = path.join(app.appDir, 'main.js');
    const r = updateControl.inject(fs.readFileSync(mainFile, 'utf8'), {
      dictDir: path.join(dataRoot(), 'dictionaries'),
      mode: 'guard',
    });
    if (r.changed) {
      fs.writeFileSync(mainFile, r.content, 'utf8');
      log('已重新注入更新管控（没有字典就不更新）');
    } else {
      log(`更新管控未重新注入：${r.reason}`);
    }
  }

  // 3) 记账以 keep 为准。上一步的 patch.run 会把旧账并进来（它按「并入已有」写账），
  //    所以撤掉的那组必须在最后显式落定，否则账上还留着它。
  setPatchGroups(version, keep);

  const restarted = restart.restartApp(app.resourcesDir);
  return { version, app, source: 'groups', removed: removeGroups, kept: keep, restarted };
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

  // 按组还原：只撤指定的组，其余组从官方原文重放（见 restoreGroups）
  if (args.groups && args.groups.length > 0) {
    return restoreGroups(app, version, args.groups, log);
  }

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
    // 整份还原 = 回到官方原文，账上不该再留着任何补丁组：留着会让「按组还原」以为还有
    // 东西可撤，也会让下次 patch 把早已撤掉的组当成仍在生效（记账是「并入已有」的写法）。
    setPatchGroups(version, []);
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
    const nameOf = (gs) => gs.map((g) => PATCH_GROUP_LABELS[g] || g).join('、');
    const how =
      r.source === 'groups'
        ? `已撤 ${nameOf(r.removed)}${r.kept.length ? `，保留 ${nameOf(r.kept)}` : '（已回到官方原版）'}`
        : r.source === 'backup'
          ? '已从备份精确还原'
          : `已按字典逆向还原（${r.total} 处）`;
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
