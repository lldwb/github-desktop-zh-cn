// 核实各 tag Release 的**当前**附件名是否符合 cli / gui 命名规范（匿名 API 只读，零依赖）
// 用法：node tools/ops/rel-check.cjs [tag...]（缺省取最新 Release 的 tag）
const https = require('https');
const { GH_OWNER, GH_REPO } = require('../../scripts/common.js');

function get(path) {
  return new Promise((resolve, reject) => {
    https.get({ host: 'api.github.com', path, headers: { 'User-Agent': 'rel-check', Accept: 'application/vnd.github+json' } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('HTTP ' + res.statusCode)); } });
    }).on('error', reject);
  });
}

(async () => {
  let tags = process.argv.slice(2);
  if (!tags.length) {
    const latest = await get(`/repos/${GH_OWNER}/${GH_REPO}/releases/latest`).catch(() => null);
    if (!latest || latest.message || !latest.tag_name) {
      console.error('取不到最新 Release（网络 / 404），请显式传 tag');
      process.exit(1);
    }
    tags = [latest.tag_name];
  }
  for (const tag of tags) {
    const j = await get(`/repos/${GH_OWNER}/${GH_REPO}/releases/tags/${tag}`).catch(() => null);
    if (!j || j.message) { console.log(`
${tag}: ${j && j.message || '取不到（404 / 网络）'}`); continue; }
    console.log(`
${tag}  draft=${j.draft}  published=${j.published_at}  附件 ${j.assets.length} 个`);
    for (const a of j.assets) {
      if (!/-cli-|-gui-/.test(a.name)) { console.log(`   - ${a.name}（非产物附件，不核对）`); continue; }
      const ok = /-win32-/.test(a.name) ? /\.exe$/.test(a.name) : /\.bin$/.test(a.name);
      console.log(`   ${ok ? '✓' : '✗'} ${a.name}`);
    }
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
