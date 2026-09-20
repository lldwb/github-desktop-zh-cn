// patch.js — 按字典替换 main.js / renderer.js 中的界面文本
// 策略：只在字符串字面量内做整串替换（common.applyDictInStrings），
// 保护标识符 / 属性名 / 正则 / 注释，并避免子串误伤协议串与拼接片段。
// 字典来源：本地外部字典 → 内嵌字典 → 联网下载（dict-sync.js）；汉化后重启应用（restart.js）。
// i18n 组里除了纯文案替换，还有一处注入：右键菜单的标签由 Electron 运行时按 role 生成、产物里没有
// 字面量，得靠 context-menu.js 先把英文标签造进产物，再由同一次字典替换译掉。
'use strict';

const fs = require('fs');
const path = require('path');
const common = require('../common.js');
const dictSync = require('../dict/dict-sync.js');
const restart = require('./restart.js');
const updateControl = require('../inject/update-control.js');
const contextMenu = require('../inject/context-menu.js');

const {
  locateApp,
  listDictVersions,
  loadDict,
  dictLabel,
  scopedEntries,
  backupAppFiles,
  backupExists,
  backupDir,
  isPatched,
  isPackaged,
  applyDictInStrings,
} = common;

const TARGETS = ['main.js', 'renderer.js'];

function parseArgs(argv) {
  const args = { dryRun: false, explicitPath: null, version: null, updateControl: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--path') args.explicitPath = argv[++i];
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--update-control') args.updateControl = 'guard';
    else if (a === '--block-update') args.updateControl = 'off';
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`未知参数：${a}（--help 查看用法）`);
  }
  return args;
}

function printHelp() {
  console.log(`用法：node scripts/cmd/patch.js [选项]

按 dictionaries/<版本>/zh-CN.json 替换安装目录中 main.js / renderer.js 的界面文本。
写回前自动备份原文件到「数据目录/tmp/backup/<版本>/」（源码态数据目录即仓库根）。
本地没有该版本字典时会联网获取；汉化完成后重启 GitHub Desktop。

选项：
  --dry-run        预览替换结果，不写盘
  --version <版本>  指定字典版本（默认取 dictionaries/ 下最新版本）
  --path <目录>    显式指定 resources 目录
  --update-control 额外打「更新管控」补丁：没有对应版本的字典时不放行自动更新
  --block-update   额外打「更新管控」补丁，且完全禁止自动更新（不看字典）
  -h, --help       显示本帮助`);
}

// 执行汉化（CLI 与交互式入口共用）：args = { dryRun, explicitPath, version, quiet }
// quiet 为真时不输出中间过程，只留最终结果（交互式菜单用）。
// 成功返回 { version, total, app, dryRun, restarted, downloaded }；
// 版本不一致抛 exitCode=2 的错误，其余错误按 exitCode=1 处理。
async function run(args = {}) {
  const log = args.quiet ? () => {} : console.log;
  const versions = listDictVersions();
  if (versions.length === 0) throw new Error('dictionaries/ 下没有版本目录');
  const version = args.version || versions[versions.length - 1];

  const app = locateApp({ explicitPath: args.explicitPath });
  if (version !== app.version) {
    const e = new Error(`版本不一致：字典版本 ${version} ≠ 安装版本 ${app.version}`);
    e.exitCode = 2;
    e.hint = '请使用与安装版本对应的字典（--version 指定），错配可能导致应用无法启动。';
    throw e;
  }

  // 字典就位：本地有外部字典或内嵌字典都不联网；两者都没有（如汉化旧版本）才下载
  const synced = await dictSync.ensureDict(version);
  if (synced.downloaded) log(`已下载字典：${synced.path}`);

  const entries = loadDict(version);
  log(`字典：${dictLabel(version)}（${entries.size} 条）`);
  log(`目标版本：${app.version}（${app.appDir}）`);

  // 「已汉化」判定必须在写回之前做：首次汉化时备份与当前文件相同（都是官方原版），
  // 判定为未汉化，0 命中条目才会作为「需人工核对」报出来，而不是被当成预期
  const alreadyPatched = isPatched(app.appDir, version);

  let totalAll = 0;
  const perFile = {};
  for (const f of TARGETS) {
    const file = path.join(app.appDir, f);
    const raw = fs.readFileSync(file, 'utf8');
    // 右键菜单的标签由 Electron 运行时按 role 生成、产物里没有字面量，字典够不着——先注入一段
    // 「按 role 重打标签」的代码把字面量造出来，紧接着由下面的字典替换译掉（见 context-menu.js）。
    // 只 main.js：菜单在 main 进程里拼（build-context-menu.ts）。干跑也注入（只在内存里），
    // 否则预览会少掉这批标签、与实际写盘结果对不上。
    let content = raw;
    if (f === 'main.js') {
      const inj = contextMenu.inject(raw, { darwin: process.platform === 'darwin' });
      content = inj.content;
      if (inj.changed) log('已注入右键菜单汉化代码（按 role 重打编辑菜单标签）：main.js');
    }

    // 只在字符串字面量内替换，保护标识符 / 属性名 / 正则 / 注释（单字词如 Error 亦是 JS 标识符）
    // 生效条目 = 全局键 + 作用域指向本文件的键（同名文本在两个文件中语义不同时按文件隔离）
    const effective = scopedEntries(entries, f);
    const { content: patched, total, perKey } = applyDictInStrings(content, effective);
    perFile[f] = perKey;
    // 注入块单独再跑一次替换：块里的字面量只有标签与几个 API 名，命中数即「本轮译掉几个菜单标签」。
    // 与整文件命中数分开报——混在一起就看不出右键菜单到底动没动（标签只有 7 个，淹没在数百条文案里）。
    const range = contextMenu.blockRange(content);
    const menuHits = range
      ? applyDictInStrings(content.slice(range.start, range.end), effective).total
      : 0;
    log(`\n${f}：命中 ${total} 处${range ? `（其中右键菜单标签 ${menuHits} 处）` : ''}`);
    totalAll += total;

    if (args.dryRun) continue;
    if (!backupExists(version)) {
      const backed = backupAppFiles(app.appDir, version);
      for (const { f: bf, skipped } of backed) {
        log(`${skipped ? '已存在，跳过' : '已备份'}：${path.join(backupDir(version), bf)}`);
      }
    }
    fs.writeFileSync(file, patched, 'utf8');
    log(`已写回：${file}`);
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
    log(`\n两个文件均 0 命中的条目 ${globalMisses.length} 条（需人工核对，可暂不处理）：`);
    for (const k of globalMisses) log(`    - ${k}`);
  } else if (globalMisses.length > 0) {
    log(`\n（已汉化状态，0 命中条目 ${globalMisses.length} 条属预期——英文串已被此前补丁替换）`);
  }

  log(`\n合计命中 ${totalAll} 处。`);

  // —— 更新管控补丁组 ——
  // 与汉化同属「补丁」，但改的是逻辑不是文案：往 main.js 注入一道闸。
  // 只动 main.js——checkForUpdates 的方法体与 IPC 入口都在那里，renderer 侧只是调用方。
  let injected = false;
  if (args.updateControl) {
    if (args.dryRun) {
      log('\n（--dry-run：更新管控未注入）');
    } else {
      const mainFile = path.join(app.appDir, 'main.js');
      const r = updateControl.inject(fs.readFileSync(mainFile, 'utf8'), {
        dictDir: path.join(common.dataRoot(), 'dictionaries'),
        mode: args.updateControl,
        // 「更新后自动汉化」只在打包态注入：源码态下工具就是仓库本身（npm run patch 即可），
        // 往产物里写死一个 node 路径，换台机器就指向不存在的东西了。
        toolPath: isPackaged() ? process.execPath : null,
      });
      if (r.changed) {
        fs.writeFileSync(mainFile, r.content, 'utf8');
        injected = true;
        const what = args.updateControl === 'off' ? '完全禁止自动更新' : '没有字典就不更新';
        log(`\n已注入更新管控（${what}）：main.js`);
      } else {
        log(`\n更新管控未注入：${r.reason}`);
      }
    }
  }

  // 记账：i18n 是本轮必打的（run 的主体就是它），updateControl 按参数。
  // **并入已有记录而不是覆盖**——不带 --update-control 再跑一次，不该把上次打的更新管控
  // 从账上抹掉，那会让「按组还原」漏掉它。要撤该组得走 restore 的按组还原。
  if (!args.dryRun) {
    const groups = new Set(['i18n', ...common.getPatchGroups(version)]);
    if (injected) groups.add('updateControl');
    // 模式随本次注入记账：按组还原重放 updateControl 时按账上模式来，而不是一律 guard
    common.setPatchGroups(version, [...groups], injected ? { updateControlMode: args.updateControl } : {});
  }

  // 汉化后重启：Electron 已把旧代码载入内存，不重启看不到效果。
  // 应用原本没在运行时不动它（避免替用户多开窗口），只提示。
  // noRestart：按组还原时由 restore 统一重启一次，避免「还原→重启→重新应用→再重启」两次拉起。
  const restarted = args.dryRun || args.noRestart ? 'skipped' : restart.restartApp(app.resourcesDir);

  return {
    version,
    total: totalAll,
    app,
    dryRun: !!args.dryRun,
    restarted,
    downloaded: synced.downloaded,
    updateControl: injected ? args.updateControl : null,
  };
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
    if (args.dryRun) {
      console.log('（--dry-run 预览，未写盘）');
    } else if (r.restarted === 'restarted') {
      console.log('汉化完成，已重启 GitHub Desktop。');
    } else {
      console.log(
        isPackaged()
          ? '汉化完成。启动 GitHub Desktop 即可看到中文界面；还原官方版：重新运行本工具选「还原官方原版」。'
          : '汉化完成。启动 GitHub Desktop 查看效果；恢复官方版：npm run restore。'
      );
    }
  } catch (e) {
    console.error(`错误：${e.message}`);
    if (e.hint) console.error(e.hint);
    process.exit(e.exitCode || 1);
  }
}

// run：执行汉化（交互式入口传 args 对象）；main：命令行入口（透传子命令时由 cli.js 调用）
module.exports = { run, main };

if (require.main === module) main();
