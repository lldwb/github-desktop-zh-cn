// 探针：v0.2.0 重发的 CI 进度（tag 强推触发的 build.yml 运行）
const { get, getJson } = require('./lib.js');
const { GH_OWNER, GH_REPO } = require('../../scripts/common.js');

const R = '/repos/' + GH_OWNER + '/' + GH_REPO;

(async () => {
  const runs = await getJson(`${R}/actions/workflows/build.yml/runs?per_page=2`);
  for (const r of runs.workflow_runs || []) {
    const secs = Math.round((Date.parse(r.updated_at) - Date.parse(r.run_started_at)) / 1000);
    console.log(`[build] #${r.run_number} ${r.status}/${r.conclusion || '-'} 触发=${r.event} ref=${r.head_branch} ${secs}s 开始于 ${r.run_started_at}`);
    const jobs = await getJson(`${R}/actions/runs/${r.id}/jobs`);
    for (const j of jobs.jobs || []) {
      const done = (j.steps || []).filter((s) => s.conclusion).length;
      const bad = (j.steps || []).filter((s) => s.conclusion === 'failure').map((s) => s.name);
      console.log(`   [job] ${j.name} ${j.status}/${j.conclusion || '-'} 步骤 ${done}/${(j.steps || []).length}${bad.length ? ' 失败：' + bad.join(' / ') : ''}`);
      if (j.conclusion === 'failure') {
        const ann = await getJson(`${R}/check-runs/${j.id}/annotations`);
        for (const a of Array.isArray(ann) ? ann : []) console.log(`     [${a.annotation_level}] ${String(a.message).slice(0, 240)}`);
      }
    }
  }

  // tag 现在指向哪份提交（应为我重建后的发版提交）
  // 本探针只在这一处要看状态码（200 才解析），故用原始形态；非 2xx 时正文是错误 JSON，不能当结果用
  const ref = await get(`${R}/git/ref/tags/v0.2.0`);
  if (ref.status === 200) {
    const obj = JSON.parse(ref.text).object || {};
    let sha = obj.sha;
    if (obj.type === 'tag') sha = ((await getJson(`${R}/git/tags/${obj.sha}`)).object || {}).sha;
    console.log(`[tag] v0.2.0 → 提交 ${String(sha).slice(0, 7)}`);
  } else {
    console.log(`[tag] v0.2.0 HTTP ${ref.status}`);
  }

  const rel = await getJson(`${R}/releases?per_page=10`);
  const list = Array.isArray(rel) ? rel : [];
  console.log(`[releases] 公开可见 ${list.length} 个`);
  for (const x of list) console.log(`   - ${x.tag_name} 作者=${x.author.login} 附件=${x.assets.length}`);
})();
