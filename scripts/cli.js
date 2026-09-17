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

不带子命令时进入中文交互菜单（双击运行即此模式）。

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

async function doPatch(rl, state) {
  if (state.error) {
    console.log('\n 未找到 GitHub Desktop，请先选择「4) 指定安装位置」。');
    return;
  }
  const version = state.app.version;
  const versions = listDictVersions();
  if (!versions.includes(version)) {
    console.log(`\n 没有与安装版本 ${version} 对应的字典${versions.length ? `（现有：${versions.join(' / ')}）` : ''}。`);
    console.log(' 字典与版本强对应，错配可能导致应用无法启动，已中止。');
    return;
  }
  if (!(await confirm(rl, `\n 即将汉化 GitHub Desktop ${version}（原文件会先自动备份），继续？[Y/n] `))) {
    console.log(' 已取消。');
    return;
  }
  try {
    require('./patch.js').run({ explicitPath: state.explicitPath, version });
    console.log('\n 汉化完成。请重启 GitHub Desktop 查看效果（运行中的实例仍是旧界面）。');
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
  if (!backupExists(version)) {
    console.log(`\n 没有 ${version} 的备份——备份在首次汉化时自动生成，当前无需还原。`);
    return;
  }
  if (!(await confirm(rl, `\n 即将把 ${version} 还原为官方原版（覆盖当前已汉化文件），继续？[Y/n] `))) {
    console.log(' 已取消。');
    return;
  }
  try {
    require('./restore.js').run({ explicitPath: state.explicitPath, version });
    console.log('\n 还原完成。请重启 GitHub Desktop 查看效果。');
  } catch (e) {
    console.log(`\n 还原失败：${e.message}`);
    if (e.hint) console.log(` ${e.hint}`);
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
      console.log(' 0) 退出');
      const choice = await ask(rl, ' 请选择：');
      if (choice === '0' || choice === 'q' || choice === '') break;
      if (choice === '1') { await doPatch(rl, state); state = resolveTarget(); continue; }
      if (choice === '2') { await doRestore(rl, state); state = resolveTarget(); continue; }
      if (choice === '3') { await showDetail(state); continue; }
      if (choice === '4') { state = await setPath(rl); continue; }
      console.log(' 输入无效，请输入 0-4 的数字。');
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
  menu().catch(async (e) => {
    console.error(`错误：${e.message}`);
    await pauseBeforeExit();
    process.exit(1);
  });
}

module.exports = { menu };

if (require.main === module) main();
