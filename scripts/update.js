// scripts/update.js — 工具自更新（菜单「检查更新」用）
// 从 GitHub Releases 取与本平台匹配的产物，校验后替换自身并重启。
//
// 替换策略：旧文件改名而不是删除 —— Windows 允许重命名正在运行的 exe（不允许删除或覆盖），
// 任一步失败都能把旧文件改回来。重启后的新进程负责清理 .old 残留。
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('./net.js');
const common = require('./common.js');

const PKG = require('../package.json');

// 本平台可执行文件的文件头特征（十六进制前缀），用于拒绝把错误页当产物
const MAGIC = {
  win32: ['4d5a'], // MZ
  darwin: ['cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca'], // Mach-O 64/32、fat
  linux: ['7f454c46'], // \x7fELF
};

// Release 资产名形如 <name>-<tag>-<platform>-<arch>[.exe]；按后缀匹配，不拼死名字
function pickAsset(assets) {
  const suffix = `-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
  return assets.find((a) => String(a.name).endsWith(suffix)) || null;
}

async function check() {
  const release = await net.getJson(`${common.GH_API}/releases/latest`);
  const latest = String(release.tag_name || '').replace(/^v/, '');
  const current = PKG.version;
  return {
    current,
    latest,
    hasUpdate: common.compareVersions(latest, current) > 0,
    asset: pickAsset(release.assets || []),
    releaseUrl: release.html_url,
  };
}

// 自身路径相关的三个文件：当前产物、升级时暂存的新产物、升级后暂存的旧产物
function selfPaths() {
  const self = process.execPath;
  const dir = path.dirname(self);
  const ext = path.extname(self);
  const base = path.basename(self, ext);
  return { self, newFile: path.join(dir, `${base}.new${ext}`), oldFile: path.join(dir, `${base}.old${ext}`) };
}

function verifyExecutable(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(4);
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  const hex = head.toString('hex');
  const allowed = MAGIC[process.platform] || MAGIC.linux;
  if (!allowed.some((m) => hex.startsWith(m))) {
    throw new Error(`下载的内容不是本平台的可执行文件（文件头 ${hex}），已中止替换`);
  }
}

// 下载并替换自身；成功即启动新版本并退出当前进程（不再返回）
async function apply(asset, opts = {}) {
  if (!common.isPackaged()) {
    throw new Error('源码态不支持自更新：请用 git pull 更新仓库');
  }
  const log = opts.log || console.log;
  const { self, newFile, oldFile } = selfPaths();

  const mb = asset.size ? `（${(asset.size / 1024 / 1024).toFixed(1)} MB）` : '';
  log(`下载 ${asset.name}${mb} …`);
  await net.download(asset.url, newFile, { onProgress: opts.onProgress });
  try {
    verifyExecutable(newFile);
    fs.chmodSync(newFile, 0o755);

    fs.rmSync(oldFile, { force: true });
    fs.renameSync(self, oldFile);
    try {
      fs.renameSync(newFile, self);
    } catch (e) {
      fs.renameSync(oldFile, self); // 回滚：旧文件改回原名
      throw e;
    }
  } catch (e) {
    fs.rmSync(newFile, { force: true });
    throw e;
  }

  log('已替换，正在重启新版本 …');
  spawn(self, [], { detached: true, stdio: 'ignore' }).unref();
  process.exit(0);
}

// 清理上次自更新留下的 .old 残留；新进程启动时调用（旧进程可能尚未完全退出，失败就留到下次）
function cleanup() {
  if (!common.isPackaged()) return false;
  const { oldFile } = selfPaths();
  if (!fs.existsSync(oldFile)) return false;
  try {
    fs.rmSync(oldFile, { force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = { check, apply, cleanup, pickAsset };
