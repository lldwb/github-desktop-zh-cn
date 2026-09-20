// scripts/update.js — 工具自更新（菜单「检查更新」用）
// 从 GitHub Releases 取与本平台匹配的产物，校验后替换自身并重启。
//
// 替换策略：旧文件改名而不是删除 —— Windows 允许重命名正在运行的 exe（不允许删除或覆盖），
// 任一步失败都能把旧文件改回来。重启后的新进程负责清理 .old 残留。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

// 资产的**下载直链**。GitHub 的资产对象有两个地址：`url` 是 **API 端点**
//（`api.github.com/repos/<owner>/<repo>/releases/assets/<id>`），`browser_download_url` 才是
// 发布页上那条下载直链。API 端点少了 `Accept: application/octet-stream` 只会回一份**元数据 JSON**
//（2026-09-20 实测：HTTP 200 + `application/json`，正文开头 `{"url":"https://api.github.com/…`）——
// 直接 GET 它下载到的是几十 KB 的 JSON，被 `verifyExecutable` 的文件头校验拦下并中止替换
//（护栏本身有效，工具没被写坏；但自更新因此**从来装不上**，v0.1.1 起一直如此，真机复现见
// tmp/asset-url.cjs）。Gitee 的资产对象连 `url` 都没有、只有 `browser_download_url`，本来走的就是
// 这条路；两边现在统一取直链。取不到直链的极端形态仍退回 API 端点，下载时补上那个 accept 头（见 apply）。
function downloadUrl(asset) {
  return asset.browser_download_url || asset.url || null;
}

// Release 资产名形如 <name>-cli-v<版本>-<platform>-<arch>[.exe|.bin]；按「-平台-架构」后缀匹配，不拼死名字。
// 后缀随平台：Windows 是 .exe，macOS / Linux 是 .bin（v0.2.0 起）；无后缀的老产物也认，
// 免得还留在旧版本上的使用者更新时找不到附件。
// 返回的是**归一后的副本**：`url` 一律是能直接下载到二进制的那条（见 downloadUrl），调用方不必再分辨来源。
function pickAsset(assets) {
  const suffix = `-${process.platform}-${process.arch}`;
  const exts = process.platform === 'win32' ? ['.exe'] : ['.bin', ''];
  const hit = assets.find((a) => exts.some((e) => String(a.name).endsWith(suffix + e))) || null;
  if (!hit) return null;
  return { ...hit, url: downloadUrl(hit) };
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
//
// 这里**只挑能被 installGuiUpdate 直接跑起来的那种**，不是「产物里最小的那种」：
// Windows 侧 `installGuiUpdate` 直接 spawn 下载下来的文件，所以只认 `-setup.exe`——
// 免安装包是 7z（自 v0.3.0 起，替代原先的 zip），7z 不是可执行文件，挑中它只会让更新失败。
// 同理 macOS 只认 .dmg（应用无法自己装 dmg，交给 `open`），Linux 认 .AppImage / .deb。
// 免安装包（7z）仍然随 Release 分发，只是不走「自动更新」这条路——使用者手动解压即可。
const ARCH_ALIASES = {
  x64: ['x64', 'x86_64', 'amd64'],
  arm64: ['arm64', 'aarch64'],
  ia32: ['ia32', 'i386', 'x86'],
};

function pickGuiAsset(assets) {
  const suffixes = (ARCH_ALIASES[process.arch] || [process.arch]).map((a) => `-${process.platform}-${a}`);
  const exts =
    { win32: ['.exe'], darwin: ['.dmg'], linux: ['.AppImage', '.deb'] }[process.platform] || ['.AppImage'];
  const hit =
    assets.find((a) => {
      const name = String(a.name);
      if (!name.includes('-gui-')) return false; // 只认 gui 那一套，别把 cli 产物当安装包
      return suffixes.some((s) => exts.some((e) => name.endsWith(s + e) || name.endsWith(`${s}-setup${e}`)));
    }) || null;
  if (!hit) return null;
  return { ...hit, url: downloadUrl(hit) }; // 与 pickAsset 同一条口径：url 一律是下载直链
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
    // 校验和清单的直链（取不到就是 null，见 verifySha256 的跳过口径）
    sumsUrl: pickSums(release.assets || []),
    // Gitee 的 release 对象没有 html_url 字段（实测字段：id / tag_name / name / body /
    // prerelease / author / created_at / assets），按 tag 拼一个出来
    releaseUrl: release.html_url || `https://gitee.com/${common.GH_OWNER}/${common.GH_REPO}/releases/tag/${release.tag_name}`,
    source,
  };
}

// —— SHA256SUMS：Release 里那份「附件名 → sha256」清单 ——
// 内容是 sha256sum 的输出：一行一条 `<64 位十六进制><空白><文件名>`（CI 的 release job 里生成，
// 实测已发布的 v0.4.0 就是这个形态）。它是**完整性**校验，不是防篡改：清单与产物同源（同一次
// Release、同一段 TLS），能证明「下到的就是发布的那份」——半成品、错版本、被中间层改写都挡得住；
// 能改产物的对手也能改清单，那要靠签名，不在本工具的能力范围内。
function parseSums(text) {
  const map = new Map();
  for (const line of String(text).split('\n')) {
    // 认 `sha256sum` 的两种写法：文本模式两个空格、二进制模式一个空格加 `*`
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m) map.set(m[2].trim(), m[1].toLowerCase());
  }
  return map;
}

// 从附件列表里取 SHA256SUMS 的直链；没有就返回 null（Gitee 的发行版只发正文、不带任何附件）
function pickSums(assets) {
  const hit = assets.find((a) => String(a.name).toUpperCase() === 'SHA256SUMS') || null;
  return hit ? downloadUrl(hit) : null;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (c) => hash.update(c));
    s.on('end', () => resolve(hash.digest('hex')));
    s.on('error', reject);
  });
}

// 比对下载物的 sha256，对不上就抛错（调用方据此中止替换 / 中止安装）。
// `sumsUrl` 缺失时**跳过并返回 false**，而不是拒绝更新：没有清单的来源（Gitee）本来就没有，
// 不能因此把更新堵死——CLI 侧另有文件头校验兜底。清单在手却对不上、或清单里压根没有这个名字，
// 都直接抛错：那说明「下到的东西不是这次发布的那份」，没有理由继续。
async function verifySha256(file, name, sumsUrl, log = () => {}) {
  if (!sumsUrl) {
    log('（该来源没有 SHA256SUMS，跳过校验和比对）');
    return false;
  }
  log(`比对 SHA256SUMS 里的 ${name} …`);
  const want = parseSums(await net.get(sumsUrl)).get(name);
  if (!want) throw new Error(`SHA256SUMS 里没有 ${name}，无法确认下到的是发布的那份，已中止`);
  const got = await sha256File(file);
  if (got !== want) {
    throw new Error(
      `校验和不符：发布的是 ${want.slice(0, 16)}…，下到的是 ${got.slice(0, 16)}…，已中止`
    );
  }
  return true;
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
  // accept 头是给「退回 API 端点」那种极端形态兜底的：那个端点少了它只会回元数据 JSON（见 downloadUrl）。
  // 直链（github.com/…/releases/download/…）不看这个头，带上无害。
  await net.download(asset.url, newFile, {
    headers: { accept: 'application/octet-stream' },
    onProgress: opts.onProgress,
  });
  try {
    // 两道都是**替换自身之前**的闸：文件头管「是不是本平台的可执行文件」，校验和管「是不是发布的
    // 那一份字节」。先做文件头——它便宜，且下到 JSON / 错误页这类东西时能立刻失败，不必再去取清单。
    verifyExecutable(newFile);
    await verifySha256(newFile, asset.name, opts.sumsUrl, log);
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
  // 起不来不该把这次更新报成失败：此刻文件**已经换好了**，手动重开一次就是新版。spawn 的失败
  // 有两条通道——ENOENT 走异步 error 事件，「文件在、内容却不是有效可执行体」在 Windows 上
  // 则是同步抛（实测 `spawn UNKNOWN` / `EFTYPE`）。两条都吞掉，理由同上。
  try {
    const child = spawn(self, [], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* 文件已替换完成，重开即可 */
  }
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

module.exports = {
  check, apply, cleanup, pickAsset, pickGuiAsset, pickSums, parseSums, verifySha256, sha256File,
};
