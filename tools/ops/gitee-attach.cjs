#!/usr/bin/env node
// gitee-attach.cjs — 发版后把 Release 附件补传到 Gitee 镜像发行版（配额交接 + 下载校验 + 补传 + 核对）
//
// 为什么在本地跑而不是 CI：GitHub Actions 的 runner 在境外，跨境上行传不完一个 90 MB 的附件
// （v1.1.3 发版 run #35 实测：两次 20 分钟 curl 超时、0 bytes received，job 的 45 分钟超时兜底
// 把整步掐死）。所以 `release` job 的「发布到 Gitee」只创建发行版正文，附件由本工具在发版后
// 本地补传——本机直连 Gitee，~1 GB 几分钟传完。
//
// 用法：node tools/ops/gitee-attach.cjs <tag>
//   <tag>        已在 GitHub 发布 Release 的 tag（如 v1.1.3）；Gitee 上该 tag 的发行版须已存在
//                （CI 创建正文，或本工具按「探测不到就报错退出」处理——正文是 CI 的职责，不在本工具范围）
// 环境变量：
//   GITEE_TOKEN  必填，Gitee 私人令牌（https://gitee.com/profile/personal_access_tokens，勾 projects）
//   HTTPS_PROXY  可选，下载 GitHub 附件走代理（Gitee API 恒直连）
// 步骤：1) 配额交接——删其它发行版的附件、旧版正文补 GitHub 下载链接（幂等：已含链接跳过）
//       2) 列 GitHub Release 附件，过滤 darwin 过渡附件（不进 Gitee）
//       3) 下载 + 按 SHA256SUMS 逐个校验（已下载且大小一致则跳过下载）
//       4) 按「名字 + 大小」判等补传（重跑幂等：已传的不重传，缺的补传；同名不同大小删了重传）
//       5) 列 Gitee 侧最终清单人工核对
// 退出码：0 = 附件齐且核对通过；1 = 任何一步失败。
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const [tag] = process.argv.slice(2);
if (!tag) {
  console.error('用法：node tools/ops/gitee-attach.cjs <tag>');
  process.exit(1);
}
const TOKEN = process.env.GITEE_TOKEN;
if (!TOKEN) {
  console.error('缺 GITEE_TOKEN 环境变量——Gitee 私人令牌见 https://gitee.com/profile/personal_access_tokens（勾 projects）');
  process.exit(1);
}

const REPO = process.env.GITHUB_REPOSITORY || 'lldwb/github-desktop-zh-cn';
const GITEE_API = `https://gitee.com/api/v5/repos/${REPO}`;
const DL_DIR = path.join(os.tmpdir(), `gitee-attach-${tag}`);
const AUTH = ['--noproxy', '*', '-H', `Authorization: Bearer ${TOKEN}`];

function gitee(args) {
  // Gitee API 恒直连（--noproxy 抵消环境变量里的代理设置）
  return execFileSync('curl', ['-sfS', '-m', '300', ...AUTH, ...args], { encoding: 'utf8' });
}
function giteeUpload(file) {
  return execFileSync('curl', ['-sfS', '-m', '1800', ...AUTH,
    '-F', `file=@${file}`, `${GITEE_API}/releases/${RID}/attach_files`], { encoding: 'utf8' });
}
function ghDownload(name, out) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const px = proxy ? ['-x', proxy] : [];
  execFileSync('curl', ['-sfS', ...px, '-L', '-m', '1800', '-o', out,
    `https://github.com/${REPO}/releases/download/${tag}/${name}`], { stdio: ['ignore', 'pipe', 'inherit'] });
}

fs.mkdirSync(DL_DIR, { recursive: true });

// —— 找 Gitee 发行版 id：正文是 CI 的职责，这里只探测 ——
let RID;
try {
  const existing = gitee([`${GITEE_API}/releases/tags/${tag}`]);
  RID = JSON.parse(existing).id;   // 不存在时 Gitee 返回字面量 null，JSON.parse 得 null → 下面判空
} catch { /* 404 等错误同「不存在」处理 */ }
if (!RID) {
  console.error(`Gitee 上还没有 ${tag} 的发行版——先由 CI 的「发布到 Gitee」创建正文，再跑本工具`);
  process.exit(1);
}
console.log(`Gitee 发行版 id=${RID}：https://gitee.com/${REPO}/releases/tag/${tag}`);

// —— 1/4 配额交接 ——
console.log('== 1/4 配额交接（其它发行版删附件、正文补 GitHub 链接）==');
for (let page = 1; page <= 10; page++) {
  const list = JSON.parse(gitee([`${GITEE_API}/releases?page=${page}&per_page=20`]));
  if (!list.length) break;
  for (const r of list) {
    if (String(r.id) === String(RID)) continue;
    let files = [];
    try { files = JSON.parse(gitee([`${GITEE_API}/releases/${r.id}/attach_files`])); } catch { /* 无附件/异常按空处理 */ }
    for (const f of files) {
      console.log(`  删 ${r.tag_name} 附件 ${f.name}（#${f.id}）`);
      try { gitee(['-X', 'DELETE', `${GITEE_API}/releases/${r.id}/attach_files/${f.id}`]); }
      catch (e) { console.log(`    警告：删除失败——${String(e.status || e.message)}`); }
    }
    const ghUrl = `https://github.com/${REPO}/releases/tag/${r.tag_name}`;
    if (String(r.body || '').includes(ghUrl)) { console.log(`  ${r.tag_name} 正文已含 GitHub 链接，跳过`); continue; }
    const body = `${r.body || ''}\n\n---\n\n本页附件已清理（配额让给最新版），请到 GitHub Release 下载：\n${ghUrl}`;
    gitee(['-X', 'PATCH', '-H', 'Content-Type: application/json',
      '-d', JSON.stringify({ body }), `${GITEE_API}/releases/${r.id}`]);
    console.log(`  ${r.tag_name}：正文补上 GitHub 下载链接`);
  }
}

// —— 2/4 列 GitHub Release 附件 ——
console.log('== 2/4 列 GitHub Release 附件（darwin 过渡附件不进 Gitee）==');
const rel = JSON.parse(execFileSync('curl', ['-sfS', '-m', '60',
  ...(process.env.HTTPS_PROXY ? ['-x', process.env.HTTPS_PROXY] : []),
  '-H', 'Accept: application/vnd.github+json',
  `https://api.github.com/repos/${REPO}/releases/tags/${tag}`], { encoding: 'utf8' }));
const targets = rel.assets.filter(a => !/-darwin-/.test(a.name));
console.log(`  Release 附件 ${rel.assets.length} 个，Gitee 目标 ${targets.length} 个：\n    ${targets.map(a => a.name).join('\n    ')}`);

// —— 3/4 下载 + 校验 ——
console.log('== 3/4 下载 + 按 SHA256SUMS 校验 ==');
let sums = null;
for (const a of targets) {
  const p = path.join(DL_DIR, a.name);
  if (fs.existsSync(p) && fs.statSync(p).size === a.size) { console.log(`  已下载且大小一致，跳过：${a.name}`); }
  else { console.log(`  下载 ${a.name}（${Math.round(a.size / 1048576)} MB）…`); ghDownload(a.name, p); }
  if (fs.statSync(p).size !== a.size) { console.error(`  ✗ ${a.name} 下载后大小不符`); process.exit(1); }
  if (a.name === 'SHA256SUMS') sums = fs.readFileSync(p, 'utf8');
}
if (!sums) { console.error('  ✗ 附件里没有 SHA256SUMS'); process.exit(1); }
const sumsMap = new Map(sums.trim().split('\n').map(l => {
  const m = l.match(/^([0-9a-f]{64})\s+\*?(.+)$/);
  return m ? [m[2].trim(), m[1]] : null;
}).filter(Boolean));
for (const a of targets) {
  if (a.name === 'SHA256SUMS') continue;
  const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(DL_DIR, a.name))).digest('hex');
  const want = sumsMap.get(a.name);
  if (!want) { console.error(`  ✗ ${a.name} 不在 SHA256SUMS 里`); process.exit(1); }
  if (h !== want) { console.error(`  ✗ ${a.name} sha256 不符（下载件损坏或清单与产物不同源）`); process.exit(1); }
  console.log(`  ✓ ${a.name}`);
}

// —— 4/4 补传 + 核对 ——
console.log('== 4/4 补传（名字 + 大小判等）+ 最终核对 ==');
const have = JSON.parse(gitee([`${GITEE_API}/releases/${RID}/attach_files`]));
for (const a of targets) {
  const old = have.find(x => x.name === a.name);
  if (old && old.size === a.size) { console.log(`  已有且大小一致，跳过：${a.name}`); continue; }
  if (old) {
    console.log(`  同名大小不符，删 #${old.id} 重传：${a.name}`);
    gitee(['-X', 'DELETE', `${GITEE_API}/releases/${RID}/attach_files/${old.id}`]);
  }
  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    try { giteeUpload(path.join(DL_DIR, a.name)); ok = true; console.log(`  已上传 ${a.name}（${Math.round(a.size / 1048576)} MB）`); }
    catch (e) {
      console.log(`  第 ${attempt} 次上传失败：${String(e.message).slice(-200)}`);
      if (attempt < 3) execFileSync(process.platform === 'win32' ? 'timeout' : 'sleep',
        process.platform === 'win32' ? ['/t', '15', '/nobreak'] : ['15'], { stdio: 'ignore', shell: process.platform === 'win32' });
    }
  }
  if (!ok) { console.error(`  ✗ ${a.name} 三次未传上（重跑本工具即可续传，已传的不重来）`); process.exit(1); }
}
const final = JSON.parse(gitee([`${GITEE_API}/releases/${RID}/attach_files`]));
console.log(`\nGitee ${tag} 附件 ${final.length} 个：`);
for (const f of final) console.log(`  ${f.name}  ${Math.round((f.size || 0) / 1048576)} MB`);
if (final.length !== targets.length) {
  console.error(`\n✗ 附件数不符：Gitee ${final.length} ≠ 目标 ${targets.length}（重跑本工具补缺）`);
  process.exit(1);
}
console.log(`\n✓ Gitee 附件已齐：https://gitee.com/${REPO}/releases/tag/${tag}`);
