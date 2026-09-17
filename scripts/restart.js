// scripts/restart.js — 关闭并重启 GitHub Desktop
// 汉化/还原后必须重启才生效：Electron 已把代码载入内存，磁盘上的替换不会自动重载。
'use strict';
const path = require('path');
const { execFileSync, spawn } = require('child_process');

// 进程识别用；macOS/Linux 的进程名与安装目录同名，按路径特征匹配更稳
const PROC_PATTERN =
  process.platform === 'darwin' ? 'GitHub Desktop.app' : 'github-desktop';

// 应用可执行体（或 macOS 的 .app 包）路径。
// Windows 必须用 app-<版本>/GitHubDesktop.exe：安装根目录那个只有几百 KB，是 Squirrel 的 stub。
function appTarget(resourcesDir) {
  if (process.platform === 'win32') {
    return path.join(path.dirname(resourcesDir), 'GitHubDesktop.exe');
  }
  if (process.platform === 'darwin') {
    // <X.app>/Contents/Resources → <X.app>
    return path.resolve(resourcesDir, '..', '..');
  }
  return path.join(path.dirname(resourcesDir), 'github-desktop');
}

function isRunning() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq GitHubDesktop.exe', '/NH'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return /GitHubDesktop\.exe/i.test(out);
    }
    execFileSync('pgrep', ['-f', PROC_PATTERN], { stdio: 'ignore' });
    return true;
  } catch {
    // tasklist 无匹配时输出「信息: 没有运行的任务」；pgrep 无匹配时退出码非 0
    return false;
  }
}

function kill() {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/IM', 'GitHubDesktop.exe', '/F'], { stdio: 'ignore' });
    } else {
      execFileSync('pkill', ['-f', PROC_PATTERN], { stdio: 'ignore' });
    }
  } catch {
    // 进程可能已在退出中，交给调用方按「是否仍在运行」判断
  }
}

// 同步小睡。不用子进程实现：打包态 process.execPath 是产物自身，起子进程会递归启动自己。
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function launch(resourcesDir) {
  const target = appTarget(resourcesDir);
  const args = process.platform === 'darwin' ? [target] : [];
  const cmd = process.platform === 'darwin' ? 'open' : target;
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return target;
}

// 原本在运行 → 关闭并重新启动；原本没运行 → 不动（避免替用户多开一个窗口）
function restartApp(resourcesDir) {
  if (!isRunning()) return 'not-running';
  kill();
  // 等句柄释放；强杀通常立即生效，这里只做一次短等待
  const until = Date.now() + 3000;
  while (isRunning() && Date.now() < until) sleep(120);
  launch(resourcesDir);
  return 'restarted';
}

module.exports = { appTarget, isRunning, launch, restartApp };
