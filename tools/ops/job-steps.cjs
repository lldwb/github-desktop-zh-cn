// 探针：取某次运行里失败 job 的 id 与步骤结论（公开仓库，无需认证）
const { getJson } = require('./lib.js');
const { GH_OWNER, GH_REPO } = require('../../scripts/common.js');
const ID = process.argv[2];

(async () => {
  const R = '/repos/' + GH_OWNER + '/' + GH_REPO;
  const jobs = (await getJson(`${R}/actions/runs/${ID}/jobs`)).jobs || [];
  for (const j of jobs) {
    if (j.conclusion !== 'failure') continue;
    console.log(`[失败 job] ${j.name} id=${j.id}`);
    for (const s of j.steps || []) {
      if (s.conclusion === 'failure' || s.conclusion === 'skipped') console.log(`   ${s.number}. ${s.name} → ${s.conclusion}`);
    }
  }
})();
