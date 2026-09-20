// 探针：打印某次运行里所有 job 的步骤名、结论与耗时（用于判断失败发生在哪一步、跑了多久）
const { getJson } = require('./lib.js');
const { GH_OWNER, GH_REPO } = require('../../scripts/common.js');
const ID = process.argv[2];
const ONLY = process.argv[3]; // 可选：只打印名字含该字串的 job

const secs = (a, b) => (a && b ? ((new Date(b) - new Date(a)) / 1000).toFixed(0) + 's' : '-');

(async () => {
  const jobs = await getJson(`/repos/${GH_OWNER}/${GH_REPO}/actions/runs/${ID}/jobs`);
  for (const j of jobs.jobs || []) {
    if (ONLY && !j.name.includes(ONLY)) continue;
    console.log(`\n=== ${j.name} ${j.status}/${j.conclusion} 总耗时 ${secs(j.started_at, j.completed_at)}`);
    for (const s of j.steps || []) {
      console.log(`  ${String(s.number).padStart(2)}. ${s.name} → ${s.conclusion || s.status} (${secs(s.started_at, s.completed_at)})`);
    }
  }
})();
