// 探针：按 run id 直查某次运行的详情与各 job 结论（公开仓库，无需认证）
const { getJson } = require('./lib.js');
const { GH_OWNER, GH_REPO } = require('../../scripts/common.js');
const ID = process.argv[2];

(async () => {
  if (!ID) {
    const runs = await getJson(`/repos/${GH_OWNER}/${GH_REPO}/actions/runs?per_page=8`);
    for (const r of runs.workflow_runs || []) {
      console.log(
        `id=${r.id} #${r.run_number} ${r.event} ${r.head_branch} ${r.status}/${r.conclusion || '-'} ${r.created_at} by ${r.triggering_actor && r.triggering_actor.login}`
      );
    }
    return;
  }
  const r = await getJson(`/repos/${GH_OWNER}/${GH_REPO}/actions/runs/${ID}`);
  console.log(
    `run #${r.run_number} id=${r.id} ${r.event} ${r.head_branch} ${r.status}/${r.conclusion} 创建 ${r.created_at} 更新 ${r.updated_at}`
  );
  console.log(`  发起人 ${r.triggering_actor && r.triggering_actor.login} / 分支 ${r.head_branch} / sha ${(r.head_sha || '').slice(0, 7)}`);
  const jobs = await getJson(`/repos/${GH_OWNER}/${GH_REPO}/actions/runs/${ID}/jobs`);
  for (const j of jobs.jobs || []) {
    console.log(`  [job] ${j.name} ${j.status}/${j.conclusion || '-'} 起 ${j.started_at || '-'} 止 ${j.completed_at || '-'}`);
  }
})();
