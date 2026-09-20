// 探针：轮询某次运行直到结束，打印各 job 结论与 Release 列表
// 用法：node tools/ops/wait-run.cjs <runId> [最长分钟数]
const { getJson } = require('./lib.js');
const { GH_OWNER, GH_REPO } = require('../../scripts/common.js');
const ID = process.argv[2];
const MAX_MIN = Number(process.argv[3] || 55);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = '/repos/' + GH_OWNER + '/' + GH_REPO;

(async () => {
  const deadline = Date.now() + MAX_MIN * 60 * 1000;
  let last = '';
  for (;;) {
    let r;
    try {
      r = await getJson(`${R}/actions/runs/${ID}`);
    } catch (e) {
      console.log('查询失败（重试）：' + e.message);
      await sleep(30000);
      continue;
    }
    const line = `${r.status}/${r.conclusion || '-'}`;
    if (line !== last) {
      console.log(`[${new Date().toISOString()}] run #${r.run_number} ${line}`);
      last = line;
    }
    if (r.status === 'completed') {
      const jobs = await getJson(`${R}/actions/runs/${ID}/jobs`);
      for (const j of jobs.jobs || []) {
        console.log(`  [job] ${j.name} ${j.status}/${j.conclusion || '-'}`);
      }
      const rel = await getJson(`${R}/releases?per_page=3`);
      for (const x of rel) {
        console.log(`  [release] ${x.tag_name} by ${x.author && x.author.login} 附件 ${x.assets.length} 个：`);
        for (const a of x.assets) console.log(`    - ${a.name} (${(a.size / 1048576).toFixed(1)} MB)`);
      }
      return;
    }
    if (Date.now() > deadline) {
      console.log(`等待超过 ${MAX_MIN} 分钟，仍未结束（${line}）——先退出，稍后再查`);
      return;
    }
    await sleep(45000);
  }
})();
