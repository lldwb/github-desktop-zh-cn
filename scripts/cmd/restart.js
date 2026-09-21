// scripts/cmd/restart.js — 关闭并重启 GitHub Desktop
// 汉化/还原后必须重启才生效：Electron 已把代码载入内存，磁盘上的替换不会自动重载。
'use strict';
const fs = require('fs');
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
  // spawn 的失败有**两条**通道：目标不存在（ENOENT）走**异步** error 事件；而「文件在、内容却
  // 不是有效可执行体」在 Windows 上是**同步抛**的（实测 `spawn UNKNOWN` / `EFTYPE`），不进事件。
  // 两条都得接——调用方（patch / restore）此刻产物早就写好了，崩在这一步纯属误伤。
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* 同上：产物已写好，起不来交给调用方提示用户手动启动 */
  }
  return target;
}

// 原本在运行 → 关闭并重新启动；原本没运行 → 不动（避免替用户多开一个窗口）
function restartApp(resourcesDir) {
  // **kill 之前先确认目标存在**：进程识别只能按进程名（Windows 的 tasklist 拿不到路径），
  // 所以「本机装的那份在跑」与「我们正要改的那份」未必是同一个。目标不存在时若照杀，
  // 结果是「把用户开着的应用关掉、却起不来还回去」。产物此刻已经写好了，这种情况按
  // 「没在运行」处理，由调用方提示用户手动启动即可。
  const target = appTarget(resourcesDir);
  if (process.platform !== 'darwin' && !fs.existsSync(target)) return 'not-running';
  if (!isRunning()) return 'not-running';
  kill();
  // 等句柄释放；强杀通常立即生效，这里只做一次短等待
  const until = Date.now() + 3000;
  while (isRunning() && Date.now() < until) sleep(120);
  launch(resourcesDir);
  return 'restarted';
}

module.exports = { restartApp };
