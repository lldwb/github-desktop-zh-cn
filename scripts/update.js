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

// Release 资产名形如 <name>-cli-v<版本>-<platform>-<arch>[.exe|.bin]；按「-平台-架构」后缀匹配，不拼死名字。
// 后缀随平台：Windows 是 .exe，macOS / Linux 是 .bin（v0.2.0 起）；无后缀的老产物也认，
// 免得还留在旧版本上的使用者更新时找不到附件。
function pickAsset(assets) {
  const suffix = `-${process.platform}-${process.arch}`;
  const exts = process.platform === 'win32' ? ['.exe'] : ['.bin', ''];
  const hit = assets.find((a) => exts.some((e) => String(a.name).endsWith(suffix + e))) || null;
  if (!hit) return null;
  // Gitee 的资产对象只有 browser_download_url 与 name（实测无 url / size / digest），
  // 把直链补进 url 字段——apply() 只认 url，补过之后两条来源的资产对下游是同一种形状。
  return hit.url ? hit : { ...hit, url: hit.browser_download_url };
}

// GUI 产物（Electron 安装包）的匹配规则。**与 pickAsset 分开**：那个服务 CLI 自更新
//（下载单文件可执行体替换自身），这个服务 GUI（下载安装包交给用户去装）——两者的命名
// 与扩展名都不一样，混在一个函数里只会让两边都判不准。
// 命名见 AGENTS.md「产物命名」：github-desktop-zh-cn-gui-v<版本>-<平台>-<架构>[-setup].<扩展名>
// 实测核对过：GUI 的 Windows 产物以 `-setup.exe` 结尾，pickAsset 的 `-win32-x64.exe`
// 匹配不到；macOS / Linux 是 .dmg / .AppImage / .deb，更是完全在它的扩展名表之外。
// electron-builder 的 Linux 产物把 x64 写成 x86_64 / amd64、arm64 写成 aarch64——
// 同一个架构三套写法，匹配时都得认，否则 Linux 用户永远找不到自己的安装包
//（cli 产物是我们自己命名的，用 Node 那套 x64 / arm64，不受影响）。
const ARCH_ALIASES = {
  x64: ['x64', 'x86_64', 'amd64'],
  arm64: ['arm64', 'aarch64'],
  ia32: ['ia32', 'i386', 'x86'],
};

function pickGuiAsset(assets) {
  const suffixes = (ARCH_ALIASES[process.arch] || [process.arch]).map((a) => `-${process.platform}-${a}`);
  const exts =
    { win32: ['.exe'], darwin: ['.dmg', '.zip'], linux: ['.AppImage', '.deb'] }[process.platform] || ['.zip'];
  const hit =
    assets.find((a) => {
      const name = String(a.name);
      if (!name.includes('-gui-')) return false; // 只认 gui 那一套，别把 cli 产物当安装包
      return suffixes.some((s) => exts.some((e) => name.endsWith(s + e) || name.endsWith(`${s}-setup${e}`)));
    }) || null;
  if (!hit) return null;
  return hit.url ? hit : { ...hit, url: hit.browser_download_url };
}

async function check() {
  // 优先 GitHub；取不到时退回 Gitee 镜像。Gitee 的镜像只同步 commit / 分支 / tag，
  // **发行版要 CI 补发**（build.yml 的「发布到 Gitee」步骤），所以两边都得问一次。
  // 兜底触发条件比「网络不通」宽：仓库还没建过 Release 时 GitHub 返回 404 也会抛到这里，
  // 那种情况下 Gitee 同样没有，最终仍会如实报错——不吞异常、不假装是最新。
  let release;
  let source = 'github';
  try {
    release = await net.getJson(`${common.GH_API}/releases/latest`);
  } catch (e) {
    release = await net.getJson(`${common.GITEE_API}/releases/latest`);
    source = 'gitee';
  }
  const latest = String(release.tag_name || '').replace(/^v/, '');
  const current = PKG.version;
  return {
    current,
    latest,
    hasUpdate: common.compareVersions(latest, current) > 0,
    asset: pickAsset(release.assets || []),
    guiAsset: pickGuiAsset(release.assets || []),
    // Gitee 的 release 对象没有 html_url 字段（实测字段：id / tag_name / name / body /
    // prerelease / author / created_at / assets），按 tag 拼一个出来
    releaseUrl: release.html_url || `https://gitee.com/${common.GH_OWNER}/${common.GH_REPO}/releases/tag/${release.tag_name}`,
    source,
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

module.exports = { check, apply, cleanup, pickAsset, pickGuiAsset };
