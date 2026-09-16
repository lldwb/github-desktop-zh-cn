// restore.js — 从 tmp/backup/<版本> 还原官方原版 main.js / renderer.js
// 用途：字典有「删改」时必须先还原再重打——patch 是原地追加式，删掉的键不会自己从产物里退出
'use strict';

const fs = require('fs');
const path = require('path');
const { locateApp, backupDir, backupExists } = require('./common');

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

把 tmp/backup/<版本>/ 下的官方原版 main.js / renderer.js 复制回安装目录，
覆盖当前已汉化的文件。用于字典条目被删除或修改后重新打补丁：
先 restore 还原原版，再 patch 重打，否则已删条目的译文仍会留在产物里。

选项：
  --path <目录>    显式指定 resources 目录（绕过自动探测，跨平台可用）
  --version <版本>  指定备份版本目录（默认取安装版本）
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
    const app = locateApp({ explicitPath: args.explicitPath });
    const version = args.version || app.version;
    const backup = backupDir(version);

    if (!backupExists(version)) {
      console.error(`备份不存在或不完整：${backup}`);
      console.error('请先运行 npm run locate（或 npm run patch）生成官方原版备份。');
      process.exit(2);
    }

    console.log(`安装版本：${app.version}`);
    console.log(`还原来源：tmp/backup/${version}/`);
    for (const f of TARGETS) {
      const dst = path.join(app.appDir, f);
      fs.copyFileSync(path.join(backup, f), dst);
      console.log(`已还原：app/${f}（${fs.statSync(dst).size} 字节）`);
    }
    console.log('还原完成——接着运行 npm run patch 用当前字典重新打补丁。');
  } catch (e) {
    console.error(`错误：${e.message}`);
    process.exit(1);
  }
}

main();
