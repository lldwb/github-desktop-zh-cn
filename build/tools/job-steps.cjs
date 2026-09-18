// 探针：取某次运行里失败 job 的 id 与步骤结论（公开仓库，无需认证）
const https = require('https');
const { GH_OWNER, GH_REPO } = require('../../scripts/common.js');
const ID = process.argv[2];

function get(path, redirects) {
  return new Promise((resolve, reject) => {
    https
      .get(
        {
          host: 'api.github.com',
          path,
          headers: { 'User-Agent': 'ci-status-probe', Accept: 'application/vnd.github+json' },
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
            res.resume();
            return resolve(get(res.headers.location.replace('https://api.github.com', ''), redirects - 1));
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        }
      )
      .on('error', reject);
  });
}

(async () => {
  const R = '/repos/' + GH_OWNER + '/' + GH_REPO;
  const { body } = await get(`${R}/actions/runs/${ID}/jobs`, 0);
  const jobs = JSON.parse(body.toString('utf8')).jobs || [];
  for (const j of jobs) {
    if (j.conclusion !== 'failure') continue;
    console.log(`[失败 job] ${j.name} id=${j.id}`);
    for (const s of j.steps || []) {
      if (s.conclusion === 'failure' || s.conclusion === 'skipped') console.log(`   ${s.number}. ${s.name} → ${s.conclusion}`);
    }
  }
})();
