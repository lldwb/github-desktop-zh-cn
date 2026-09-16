// locate.js — 定位 GitHub Desktop 安装目录，校验结构并备份原文件
'use strict';

const fs = require('fs');
const path = require('path');
const { locateApp, backupAppFiles } = require('./common');

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
  console.log(`用法：node scripts/locate.js [选项]

定位 GitHub Desktop 安装目录，校验 app/main.js、app/renderer.js、app/package.json 存在，
并把原文件备份到 tmp/backup/<版本>/（已备份则跳过）。

选项：
  --path <目录>    显式指定 resources 目录（绕过自动探测，跨平台可用）
  --version <版本>  仅打印该字典版本对应的安装目录是否匹配（不修改文件）
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
    const appDir = app.appDir;
    console.log(`安装版本：${app.version}`);
    console.log(`资源目录：${app.resourcesDir}`);
    for (const f of ['main.js', 'renderer.js', 'package.json']) {
      const p = path.join(appDir, f);
      const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
      console.log(`  app/${f}  ${fs.existsSync(p) ? size + ' bytes' : '（缺失！）'}`);
    }

    if (args.version) {
      const ok = args.version === app.version;
      console.log(ok ? `字典版本 ${args.version} 与安装版本一致 ✓` : `字典版本 ${args.version} 与安装版本 ${app.version} 不一致 ✗`);
      if (!ok) process.exit(2);
    }

    const backed = backupAppFiles(appDir, app.version);
    for (const { f, skipped } of backed) {
      console.log(`${skipped ? '已存在，跳过' : '已备份'}：tmp/backup/${app.version}/${f}`);
    }
    console.log('备份用于恢复官方版：npm run restore。');
  } catch (e) {
    console.error(`错误：${e.message}`);
    process.exit(1);
  }
}

main();
