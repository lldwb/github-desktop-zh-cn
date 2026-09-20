// 探针：打印已发布 Release 的正文摘要、附件上传者与时间戳（判断附件是本次新传的还是续传时跳过的）
const { get } = require('./lib.js');
const { GH_OWNER, GH_REPO } = require('../../scripts/common.js');

(async () => {
  const tag = process.argv[2] || 'v0.2.0';
  // 本探针按 200 严格判定：非 200 一律以「HTTP <状态码>」失败（与迁移前一致，不解析错误正文）
  const res = await get(`/repos/${GH_OWNER}/${GH_REPO}/releases/tags/${tag}`);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const r = JSON.parse(res.text);
  console.log(`tag=${r.tag_name} 作者=${r.author.login} draft=${r.draft} prerelease=${r.prerelease}`);
  console.log(`target_commitish=${r.target_commitish}  建草稿=${r.created_at} 发布=${r.published_at}`);
  console.log(`正文全文：`);
  for (const line of (r.body || '').split('\n')) console.log(`    |${line}`);
  console.log(`附件 ${r.assets.length} 个：`);
  let bytes = 0;
  for (const a of r.assets) {
    bytes += a.size;
    console.log(`    ${a.name}  ${(a.size / 1048576).toFixed(1)} MB  上传者 ${a.uploader.login}  更新时间 ${a.updated_at}`);
  }
  console.log(`合计 ${(bytes / 1048576).toFixed(1)} MB`);
})().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});
