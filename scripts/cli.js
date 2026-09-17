// cli.js — 交互式入口
// 无参数：进入中文菜单（面向普通用户，双击即可用）；
// 带子命令（locate / patch / restore / verify / scan）：透传给对应脚本，命令行行为与直接运行脚本一致。
'use strict';

const path = require('path');
const readline = require('readline');
const {
  locateApp, listDictVersions, loadDict, dictLabel, backupDir, backupExists, isPatched,
  isPackaged, dataRoot, readConfig, writeConfig, APP_NAME,
} = require('./common');

// 静态映射（不是模板字符串）：bundle.js 靠字面量扫描收集依赖，动态 require 不会被收集
const RUNNERS = {
  locate: () => require('./locate.js'),
  patch: () => require('./patch.js'),
  restore: () => require('./restore.js'),
  verify: () => require('./verify.js'),
  scan: () => require('./scan.js'),
};

const SUBCOMMANDS = Object.keys(RUNNERS);
const LINE = '─'.repeat(64);

function printHelp() {
  console.log(`用法：github-desktop-zh-cn [子命令] [选项]

不带子命令时进入中文交互菜单（双击运行即此模式），菜单里可汉化 / 还原 / 指定安装位置 / 检查更新。

子命令（等价于直接运行对应脚本）：
  locate    定位安装目录并备份原文件
  patch     按字典汉化（--dry-run 预览不写盘）
  restore   还原官方原版
  verify    校验版本一致性、命中率与补丁后语法
  scan      未翻译文案自查（输出待补清单）

公共选项：
  --path <目录>    显式指定 resources 目录（自动探测失败或非默认安装位置时用）
  --version <版本>  指定字典版本
  -h, --help       显示本帮助

运行 GitHub Desktop 汉化工具 ${require('../package.json').version}`);
}

function runSubcommand(name, rest) {
  // 透传：argv 换成子命令脚本的形态，让脚本自身的参数解析逻辑原样生效
  process.argv = [process.execPath, `${name}.js`, ...rest];
  const mod = RUNNERS[name]();
  // locate / verify / scan 加载即执行；patch / restore 导出 main，需显式调用
  // （打包态下 require.main 指向入口 cli，脚本自身的 require.main === module 判断不成立）
  if (typeof mod.main === 'function') mod.main();
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (a) => resolve((a || '').trim())));
}

async function confirm(rl, question) {
  const a = (await ask(rl, question)).toLowerCase();
  return a === '' || a === 'y' || a === 'yes' || a === '是';
}

// 解析目标安装目录：手动指定的路径优先，否则自动探测
function resolveTarget() {
  const cfg = readConfig();
  const explicitPath = cfg.resourcesPath || null;
  try {
    return { app: locateApp({ explicitPath }), explicitPath };
  } catch (e) {
    return { error: e.message, explicitPath };
  }
}

function printStatus(state) {
  if (state.error) {
    console.log(' 安装位置：未找到');
    console.log(`   （${state.error}）`);
    console.log(' 请选择「4) 指定安装位置」手动指定 GitHub Desktop 的 resources 目录。');
    return;
  }
  const { app } = state;
  const versions = listDictVersions();
  const matched = versions.includes(app.version);
  console.log(` 安装位置：${app.appDir}`);
  console.log(` 应用版本：${app.version}`);
  if (matched) {
    let count = '';
    try {
      count = `（${loadDict(app.version).size} 条）`;
    } catch (e) {
      count = `（字典读取失败：${e.message}）`;
    }
    console.log(` 字典版本：${app.version}${count}`);
  } else {
    console.log(` 字典版本：无 ${app.version} 对应字典${versions.length ? `（现有：${versions.join(' / ')}）` : ''}`);
  }
  const patched = isPatched(app.appDir, app.version);
  console.log(` 当前状态：${patched ? '已汉化' : '未汉化（官方原版）'}`);
  console.log(` 备份目录：${backupExists(app.version) ? backupDir(app.version) : '（无——首次汉化时自动生成）'}`);
}

// 重启结果的一句话说明（汉化与还原共用）
function restartLine(restarted) {
  return restarted === 'restarted'
    ? ' 已重启 GitHub Desktop，现在看到的就是新界面。'
    : ' 启动 GitHub Desktop 即可看到效果。';
}

async function doPatch(rl, state) {
  if (state.error) {
    console.log('\n 未找到 GitHub Desktop，请先选择「4) 指定安装位置」。');
    return;
  }
  const version = state.app.version;
  // 本地（含内嵌）没有对应字典时**不中止**：交给 patch 联网取，取不到再报错
  const local = listDictVersions().includes(version);
  const tip = local ? '' : `（本地无 ${version} 字典，将联网获取）`;
  if (!(await confirm(rl, `\n 即将汉化 GitHub Desktop ${version}${tip}（原文件会先自动备份），继续？[Y/n] `))) {
    console.log(' 已取消。');
    return;
  }
  try {
    // quiet：中间过程不出现在菜单里，只留最终结果（命令行入口仍输出明细）
    const r = await require('./patch.js').run({ explicitPath: state.explicitPath, version, quiet: true });
    console.log(`\n 汉化完成：命中 ${r.total} 处。`);
    console.log(restartLine(r.restarted));
  } catch (e) {
    console.log(`\n 汉化失败：${e.message}`);
    if (e.hint) console.log(` ${e.hint}`);
  }
}

async function doRestore(rl, state) {
  if (state.error) {
    console.log('\n 未找到 GitHub Desktop，请先选择「4) 指定安装位置」。');
    return;
  }
  const version = state.app.version;
  // 没有备份也能还原：按字典逆向替换（中文 → 英文），只是少数词形可能与官方略有差异
  const tip = backupExists(version) ? '（从备份精确还原）' : '（没有备份，将按字典还原为英文）';
  if (!(await confirm(rl, `\n 即将把 ${version} 还原为官方原版${tip}，继续？[Y/n] `))) {
    console.log(' 已取消。');
    return;
  }
  try {
    const r = await require('./restore.js').run({ explicitPath: state.explicitPath, version, quiet: true });
    const how = r.source === 'backup' ? '已从备份精确还原' : `已按字典还原 ${r.total} 处`;
    console.log(`\n 还原完成：${how}。`);
    if (r.source === 'reverse' && (r.ambiguous > 0 || r.skipped > 0)) {
      const parts = [];
      if (r.ambiguous > 0) parts.push(`${r.ambiguous} 条译文有多个英文写法`);
      if (r.skipped > 0) parts.push(`${r.skipped} 条译文是空格/标点等通用文本，保持原样`);
      console.log(` 注：${parts.join('；')}，个别词形可能与官方略有差异。`);
    }
    console.log(restartLine(r.restarted));
  } catch (e) {
    console.log(`\n 还原失败：${e.message}`);
    if (e.hint) console.log(` ${e.hint}`);
  }
}

// 检查更新：先看工具自身有无新版本，再拉当前安装版本的字典
async function doUpdate(rl, state) {
  console.log('');

  if (!state.error) {
    const version = state.app.version;
    try {
      const r = await require('./dict-sync.js').syncLatest(version);
      console.log(r.changed ? ` 字典已更新：${version}` : ` 字典已是最新（${version}）。`);
    } catch (e) {
      console.log(` 更新字典失败：${e.message}`);
    }
  }

  if (!isPackaged()) {
    console.log(' 源码模式不支持自更新——请用 git pull 更新本工具。');
    return;
  }

  try {
    const info = await require('./update.js').check();
    if (!info.hasUpdate) {
      console.log(` 本工具已是最新版本（v${info.current}）。`);
      return;
    }
    if (!info.asset) {
      console.log(` 发现新版本 v${info.latest}，但没有本平台（${process.platform}-${process.arch}）的产物。`);
      console.log(` 可到 ${info.releaseUrl} 查看。`);
      return;
    }
    if (!(await confirm(rl, ` 发现新版本 v${info.latest}（当前 v${info.current}），现在更新并重启？[Y/n] `))) {
      console.log(' 已跳过工具更新。');
      return;
    }
    // apply 成功后进程已退出、新版本已启动，不会返回
    await require('./update.js').apply(info.asset);
  } catch (e) {
    console.log(` 检查更新失败：${e.message}`);
  }
}

async function showDetail(state) {
  console.log('');
  console.log(` 数据目录：${dataRoot()}${isPackaged() ? '（可执行文件所在目录）' : '（仓库根目录）'}`);
  console.log(` 配置文件：${path.join(dataRoot(), 'config.json')}`);
  const versions = listDictVersions();
  console.log(` 可用字典：${versions.length ? versions.join(' / ') : '（无）'}`);
  if (versions.length) {
    const latest = versions[versions.length - 1];
    console.log(` 字典文件：${dictLabel(latest)}`);
  }
  if (state.error) {
    console.log(' 安装位置：未找到');
  } else {
    console.log(` 安装位置：${state.app.appDir}`);
    console.log(` 备份目录：${backupDir(state.app.version)}`);
  }
  console.log('');
  console.log(' 命令行用法（高级）：github-desktop-zh-cn patch --dry-run');
}

async function setPath(rl) {
  console.log('');
  console.log(' 请粘贴 GitHub Desktop 的 resources 目录路径（也可把文件夹拖进本窗口）：');
  console.log('   Windows 例：C:\\Users\\<用户名>\\AppData\\Local\\GitHubDesktop\\app-3.6.5\\resources');
  console.log('   macOS  例：/Applications/GitHub Desktop.app/Contents/Resources');
  console.log('   Linux  例：/usr/lib/github-desktop/resources');
  const input = (await ask(rl, ' 路径：')).replace(/^["']|["']$/g, '');
  if (!input) return resolveTarget();
  try {
    const app = locateApp({ explicitPath: input });
    writeConfig({ resourcesPath: input });
    console.log(` 已记住：${app.appDir}（版本 ${app.version}）`);
  } catch (e) {
    console.log(` 无效：${e.message}`);
  }
  return resolveTarget();
}

async function menu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('');
    console.log(` GitHub Desktop 汉化工具 v${require('../package.json').version}${isPackaged() ? '' : '（源码模式）'}`);
    console.log(LINE);
    let state = resolveTarget();
    for (;;) {
      console.log('');
      printStatus(state);
      console.log(LINE);
      console.log(' 1) 汉化 GitHub Desktop       2) 还原官方原版');
      console.log(' 3) 详细信息                  4) 指定安装位置');
      console.log(' 5) 检查更新（工具 + 字典）');
      console.log(' 0) 退出');
      const choice = await ask(rl, ' 请选择：');
      if (choice === '0' || choice === 'q' || choice === '') break;
      if (choice === '1') { await doPatch(rl, state); state = resolveTarget(); continue; }
      if (choice === '2') { await doRestore(rl, state); state = resolveTarget(); continue; }
      if (choice === '3') { await showDetail(state); continue; }
      if (choice === '4') { state = await setPath(rl); continue; }
      if (choice === '5') { await doUpdate(rl, state); state = resolveTarget(); continue; }
      console.log(' 输入无效，请输入 0-5 的数字。');
    }
    console.log(' 已退出。');
  } finally {
    rl.close();
  }
}

// 双击运行（打包态）时出错退出会让窗口瞬间关闭，等一次回车让用户看清信息
async function pauseBeforeExit() {
  if (!process.stdin.isTTY) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => rl.question('\n按回车键关闭窗口…', () => resolve()));
  rl.close();
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === '-h' || cmd === '--help') {
    printHelp();
    return;
  }
  if (cmd) {
    if (!SUBCOMMANDS.includes(cmd)) {
      console.error(`未知子命令：${cmd}（可用：${SUBCOMMANDS.join(' / ')}）`);
      process.exit(1);
    }
    runSubcommand(cmd, rest);
    return;
  }
  // 上次自更新可能留下 .old 残留，启动时清理（仅打包态；失败不影响使用）
  try {
    require('./update.js').cleanup();
  } catch (e) {
    /* 清理失败无妨，下次启动再试 */
  }
  menu().catch(async (e) => {
    console.error(`错误：${e.message}`);
    await pauseBeforeExit();
    process.exit(1);
  });
}

module.exports = { menu };

if (require.main === module) main();
