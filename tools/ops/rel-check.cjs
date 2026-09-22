// 核实各 tag Release 的**当前**附件名是否符合 cli / gui 命名规范（匿名 API 只读，零依赖）
// 用法：node tools/ops/rel-check.cjs [tag...]（缺省取最新 Release 的 tag）
// 后缀口径（docs/agents/发版.md「产物命名」）：cli——win32 用 .exe、其余平台 .bin；
// gui——win32 用 .exe（NSIS 安装包）/.7z（便携）、mac 侧用 .dmg（平台词 v1.1.3 起是 macos，
// 更早的 Release 上是 darwin，两个词都认）、linux 用 .AppImage/.deb（架构词 x86_64/amd64 不参与判定）。
const { getJson } = require('./lib.js');
const { GH_OWNER, GH_REPO } = require('../../scripts/common.js');

function nameOk(name) {
  const gui = /-gui-/.test(name);
  if (/-win32-/.test(name)) return gui ? /\.(exe|7z)$/.test(name) : /\.exe$/.test(name);
  if (/-macos-|-darwin-/.test(name)) return gui ? /\.dmg$/.test(name) : /\.bin$/.test(name);
  return gui ? /\.(AppImage|deb)$/.test(name) : /\.bin$/.test(name);
}

(async () => {
  let tags = process.argv.slice(2);
  if (!tags.length) {
    const latest = await getJson(`/repos/${GH_OWNER}/${GH_REPO}/releases/latest`).catch(() => null);
    if (!latest || latest.message || !latest.tag_name) {
      console.error('取不到最新 Release（网络 / 404），请显式传 tag');
      process.exit(1);
    }
    tags = [latest.tag_name];
  }
  for (const tag of tags) {
    const j = await getJson(`/repos/${GH_OWNER}/${GH_REPO}/releases/tags/${tag}`).catch(() => null);
    if (!j || j.message) { console.log(`
${tag}: ${j && j.message || '取不到（404 / 网络）'}`); continue; }
    console.log(`
${tag}  draft=${j.draft}  published=${j.published_at}  附件 ${j.assets.length} 个`);
    for (const a of j.assets) {
      if (!/-cli-|-gui-/.test(a.name)) { console.log(`   - ${a.name}（非产物附件，不核对）`); continue; }
      console.log(`   ${nameOk(a.name) ? '✓' : '✗'} ${a.name}`);
    }
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
