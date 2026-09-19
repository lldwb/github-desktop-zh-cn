// references/copilot-behavior-test.cjs —— 提示词类改动后的行为验证模板
//
// 用途：改动了「发给模型的文本」（Copilot 系统提示词 / 冲突输入文档 / 仓库约束说明）后，
// 用应用自带的 Copilot 运行时实测：中文提示词是否让模型输出中文、且 JSON 契约不被破坏。
//
// 做法（不另起炉灶，照 copilot-store.ts 的方式）：
//   spawn(<app exe>, ['--eval', "import '<appDir>/copilot/index.js'", '--'])
//   环境 ELECTRON_RUN_AS_NODE=1 / COPILOT_RUN_APP=1 / GITHUB_COPILOT_INTEGRATION_ID=copilot-desktop
// 系统提示词不写死：直接从**已打补丁的 renderer.js** 里按 marker 找到字面量、eval 成运行期字符串，
// 测的就是装机产物里那一条。token 从凭据管理器读，全程不打印。
//
// 运行：
//   copy 到 tmp/ 后： HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 \
//                     node tmp/copilot-test.cjs
// 代价：每条用例消耗 1 次 Copilot 请求（模型 auto，约 6–7 秒）——先告知用户配额消耗。
//
// 改什么：MARKERS 里的 marker 随字典译文变化（译文改了、产物里找不到就报错）；
// RUN_CASE1 / RUN_CASE2 / RUN_CASE3 开关用例；断言函数按需加。
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { locateApp, stringLiterals } = require('../scripts/common');

// ---------------------------------------------------------------- 配置

// 从 patched renderer.js 里找中文提示词的 marker（字典译文变化时同步改）
const MARKERS = {
  commitSystem: '你是 GitHub Desktop 里的 AI 助手',
  commitTags: '随每次请求变化的 token', // 动态系统提示词模板（带 ${KC} / ${t.*} 插值）
  conflictSystem: '你是一名 Git 冲突解决专家',
};

const RUN_CASE1 = true; // 提交信息（无仓库规则）
const RUN_CASE2 = true; // 提交信息（带仓库规则，走动态系统提示词模板）
const RUN_CASE3 = true; // 冲突解决

const SERVICE = 'GitHub - https://api.github.com'; // keytar 服务名：`GitHub - <endpoint>`
const MODEL = 'auto';

// ---------------------------------------------------------------- 基本定位

const app = locateApp({});
const appDir = app.appDir;
const exePath = path.join(path.dirname(path.dirname(appDir)), 'GitHubDesktop.exe');
const cliPath = path.join(appDir, 'copilot', 'index.js');
const sdkPath = path.join(appDir, 'copilot', 'copilot-sdk', 'index.js');
const keytarPath = path.join(appDir, 'keytar.node');

for (const [name, p] of [
  ['app 可执行文件', exePath],
  ['CLI 入口', cliPath],
  ['SDK', sdkPath],
  ['keytar', keytarPath],
]) {
  if (!fs.existsSync(p)) {
    console.error(`✗ 找不到${name}：${p}`);
    process.exit(2);
  }
}
console.log(`appDir   = ${appDir}`);
console.log(`exe      = ${exePath}`);

// ------------------------------------------------- 从装机产物里取中文提示词

const rendererSrc = fs.readFileSync(path.join(appDir, 'renderer.js'), 'utf8');
const lits = stringLiterals(rendererSrc);

/** 按标记找到字面量，并把「含定界符的源码片段」eval 成运行期字符串。 */
function runtimeText(marker) {
  const hit = lits.find((l) => l.content.includes(marker));
  if (!hit) throw new Error(`产物里找不到含 ${JSON.stringify(marker)} 的字面量——字典译文变了吗？`);
  const quoted = rendererSrc.slice(hit.start - 1, hit.end + 1);
  // eslint-disable-next-line no-eval
  const value = eval(`(${quoted})`);
  return { template: hit.template, value };
}

const commitSystem = runtimeText(MARKERS.commitSystem);
// 动态模板带 ${KC} / ${t.repoRulesOpen} 等插值：用 new Function 给它喂同名变量
const commitTagsHit = lits.find(
  (l) => l.template && l.content.includes(MARKERS.commitTags)
);
if (!commitTagsHit) throw new Error(`产物里找不到动态系统提示词模板（marker=${MARKERS.commitTags}）`);
// 注意：模板字面量的 content 自带反引号定界符（字典的整模板键就是这么存的），
// 所以这里不能再补反引号。
const renderCommitTagsTemplate = new Function(
  'KC',
  't',
  `return ${commitTagsHit.content};` // eslint-disable-line no-new-func
);
const conflictSystem = runtimeText(MARKERS.conflictSystem);

console.log(`\n提交信息系统提示词：运行期 ${commitSystem.value.length} 字符`);
console.log(`冲突解决系统提示词：运行期 ${conflictSystem.value.length} 字符`);

// ------------------------------------------------------------ 取 GitHub token

const keytar = require(keytarPath);

// ------------------------------------------- 复刻 copilot-commit-message 的解析

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCopilotCommitMessage(content) {
  const jsonMatch =
    content.match(/```json\s*([\s\S]*?)```/) || content.match(/```\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : content.trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error('Copilot returned invalid JSON for commit message generation');
  }
  if (!isRecord(parsed)) {
    throw new Error('Copilot returned an invalid commit message payload: expected an object');
  }
  const title = parsed.title;
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new Error('"title" must be a non-empty string');
  }
  const description = parsed.description;
  if (description === undefined) return { title, description: '' };
  if (typeof description !== 'string') {
    throw new Error('"description" must be a string when provided');
  }
  return { title, description };
}

// ------------------------------------------ 复刻 copilot-conflict-resolution 的关键校验

function parseConflictContent(content) {
  const nonGreedy =
    content.match(/```json\s*([\s\S]*?)```/) || content.match(/```\s*([\s\S]*?)```/);
  const greedy =
    content.match(/```json\s*([\s\S]*)```/) || content.match(/```\s*([\s\S]*)```/);
  const candidates = [];
  if (nonGreedy) candidates.push(nonGreedy[1].trim());
  if (greedy && greedy[1].trim() !== nonGreedy?.[1]?.trim()) candidates.push(greedy[1].trim());
  candidates.push(content.trim());

  let parsed;
  let err;
  for (const c of candidates) {
    try {
      parsed = JSON.parse(c);
      err = undefined;
      break;
    } catch {
      err = new Error('Copilot returned invalid JSON for conflict resolution generation');
    }
  }
  if (err) throw err;
  if (!isRecord(parsed)) throw new Error('expected an object');

  const { resolutions, summary, references } = parsed;
  if (!Array.isArray(resolutions)) throw new Error('"resolutions" must be an array');
  if (resolutions.length === 0) throw new Error('"resolutions" must not be empty');

  const problems = [];
  for (let i = 0; i < resolutions.length; i++) {
    const e = resolutions[i];
    if (!isRecord(e)) { problems.push(`#${i} 不是对象`); continue; }
    if (typeof e.path !== 'string' || !e.path.trim()) problems.push(`#${i} path 非法`);
    const action = e.action === 'keep' || e.action === 'delete' ? e.action : undefined;
    if (action !== undefined) {
      if (typeof e.reasoning !== 'string' || !e.reasoning.trim()) {
        problems.push(`#${i} action=${action} 缺 reasoning`);
      }
      continue;
    }
    if (!Array.isArray(e.hunks) || e.hunks.length === 0) { problems.push(`#${i} hunks 为空`); continue; }
    for (let j = 0; j < e.hunks.length; j++) {
      const h = e.hunks[j];
      if (!isRecord(h) || typeof h.resolvedContent !== 'string') {
        problems.push(`#${i} hunk#${j} resolvedContent 非字符串`);
        continue;
      }
      const rc = h.resolvedContent;
      if (/^<{7}\s/m.test(rc) && /^={7}$/m.test(rc)) {
        problems.push(`#${i} hunk#${j} 仍含冲突标记`);
      }
    }
  }
  const summaryOk = typeof summary === 'string' && summary.trim().length > 0;
  return { parsed, resolutions, summary, references, summaryOk, problems };
}

// ------------------------------------------------------------------ 输入素材

// 素材用英文原始形态（通用）。若输入文档标签也已中文化、要验证译文标签，
// 把下面素材的标签段替换成字典译文即可（或直接从 patched 产物拼接）。
const TOKEN = 'a1b2c3d4e5f60718'; // 复刻 generateCommitMessagePromptTags 的 8 字节 hex token
const tags = {
  repoRulesOpen: `<repo-rules-${TOKEN}>`,
  repoRulesClose: `</repo-rules-${TOKEN}>`,
  diffOpen: `<diff-${TOKEN}>`,
  diffClose: `</diff-${TOKEN}>`,
};

const DIFF = `diff --git a/src/format.js b/src/format.js
index 1a2b3c4..5d6e7f8 100644
--- a/src/format.js
+++ b/src/format.js
@@ -1,6 +1,14 @@
+const UNITS = ['B', 'KB', 'MB', 'GB']
+
+export function formatBytes(bytes) {
+  let value = bytes
+  let unit = 0
+  while (value >= 1024 && unit < UNITS.length - 1) {
+    value /= 1024
+    unit++
+  }
+  return \`\${value.toFixed(unit === 0 ? 0 : 1)} \${UNITS[unit]}\`
+}
+
 export function formatDate(date) {
   return date.toISOString().slice(0, 10)
 }
`;

const RULES = [
  'Mention the affected module in the description.',
  'Keep the title under 50 characters.',
];

function commitUserPrompt(diff, ruleDescriptions) {
  const diffBlock = `${tags.diffOpen}\n${diff}\n${tags.diffClose}`;
  if (ruleDescriptions.length === 0) return diffBlock;
  const bullets = ruleDescriptions.map((d) => `- ${d}`).join('\n');
  return `${tags.repoRulesOpen}
The combined commit message (the title followed by a blank line and then
the description) MUST satisfy ALL of the following constraints:
${bullets}
${tags.repoRulesClose}

${diffBlock}`;
}

const CONFLICT_DOC = `Merge conflict between "feature/size-format" (ours) and "main" (theirs).

## File: src/format.js

### Conflict 1 of 1

Ours (current branch):
\`\`\`js
export function formatBytes(bytes) {
  const kb = (bytes / 1024).toFixed(2)
  return \`\${kb} KB\`
}
\`\`\`

Theirs (incoming branch):
\`\`\`js
export function formatBytes(bytes) {
  const mb = (bytes / 1024 / 1024).toFixed(1)
  return \`\${mb} MB\`
}
\`\`\`

## File: docs/legacy.md (delete-vs-modify conflict)

Deleted on "main" (theirs), modified on "feature/size-format" (ours).
`;

// ---------------------------------------------------------------------- 主流程

const overall = setTimeout(() => {
  console.error('\n✗ 总超时（10 分钟），强制退出');
  process.exit(3);
}, 10 * 60 * 1000);
overall.unref?.();

const results = [];

async function main() {
  const creds = await keytar.findCredentials(SERVICE);
  const cred = creds[0];
  if (!cred) throw new Error(`凭据管理器里没有 ${SERVICE} 的 token`);
  const token = cred.password;
  console.log(`\n凭据：service=${SERVICE} account=${cred.account} token=${token ? `已取到（${token.length} 字符，不打印）` : '空'}`);

  const { CopilotClient, RuntimeConnection } = await import(pathToFileURL(sdkPath).href);
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({
      path: exePath,
      args: ['--eval', `import '${pathToFileURL(cliPath).href}'`, '--'],
    }),
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      COPILOT_RUN_APP: '1',
      GITHUB_COPILOT_INTEGRATION_ID: 'copilot-desktop',
    },
    workingDirectory: process.cwd(),
    gitHubToken: token,
  });

  const openSession = async (systemContent, label) => {
    const session = await client.createSession({
      model: MODEL,
      systemMessage: { mode: 'append', content: systemContent },
      availableTools: [],
      enableSessionStore: false,
      onPermissionRequest: async () => ({ kind: 'reject' }),
    });
    session.on((e) => {
      if (e.type === 'session.error') {
        console.error(`  [${label}] session.error: ${e.toString().slice(0, 400)}`);
      }
    });
    return session;
  };

  const hasCJK = (s) => /[一-鿿]/.test(s);

  // ---- 用例 1：提交信息（无仓库规则）
  if (RUN_CASE1) {
    console.log('\n========== 用例 1：生成提交信息（无仓库规则） ==========');
    const session = await openSession(commitSystem.value, 'commit-1');
    try {
      const started = Date.now();
      const res = await session.sendAndWait(
        { prompt: commitUserPrompt(DIFF, []) },
        180000
      );
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const content = res?.data?.content ?? '';
      console.log(`耗时 ${secs}s，响应 ${content.length} 字符\n--- 模型原文 ---\n${content}\n--- 原文结束 ---`);
      let parsed = null;
      let err = null;
      try {
        parsed = parseCopilotCommitMessage(content);
      } catch (e) {
        err = e;
      }
      if (err) {
        console.log(`解析：✗ ${err.message}`);
      } else {
        console.log(`解析：✓ title=${JSON.stringify(parsed.title)} 中文：${hasCJK(parsed.title) ? '✓' : '✗'}`);
      }
      results.push({ name: '提交信息（无规则）', ok: err === null, note: err ? err.message : parsed.title });
    } finally {
      await session.disconnect().catch(() => {});
    }
  }

  // ---- 用例 2：提交信息（带仓库规则，走动态系统提示词模板）
  if (RUN_CASE2) {
    console.log('\n========== 用例 2：生成提交信息（带仓库规则，走动态系统提示词模板） ==========');
    const sysContent = renderCommitTagsTemplate(commitSystem.value, tags);
    console.log(`系统提示词 ${sysContent.length} 字符`);
    const session = await openSession(sysContent, 'commit-2');
    try {
      const res = await session.sendAndWait(
        { prompt: commitUserPrompt(DIFF, RULES) },
        180000
      );
      const content = res?.data?.content ?? '';
      console.log(`--- 模型原文 ---\n${content}\n--- 原文结束 ---`);
      let parsed = null;
      let err = null;
      try {
        parsed = parseCopilotCommitMessage(content);
      } catch (e) {
        err = e;
      }
      if (err) {
        console.log(`解析：✗ ${err.message}`);
      } else {
        console.log(`解析：✓ title=${JSON.stringify(parsed.title)} 中文：${hasCJK(parsed.title) ? '✓' : '✗'}`);
      }
      results.push({ name: '提交信息（带规则）', ok: err === null, note: err ? err.message : parsed.title });
    } finally {
      await session.disconnect().catch(() => {});
    }
  }

  // ---- 用例 3：冲突解决
  if (RUN_CASE3) {
    console.log('\n========== 用例 3：冲突解决 ==========');
    const session = await openSession(conflictSystem.value, 'conflict');
    try {
      const started = Date.now();
      const res = await session.sendAndWait({ prompt: CONFLICT_DOC }, 180000);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const content = res?.data?.content ?? '';
      console.log(`耗时 ${secs}s，响应 ${content.length} 字符\n--- 模型原文 ---\n${content}\n--- 原文结束 ---`);
      let out = null;
      let err = null;
      try {
        out = parseConflictContent(content);
      } catch (e) {
        err = e;
      }
      if (err) {
        console.log(`解析：✗ ${err.message}`);
      } else {
        console.log(`解析：✓ resolutions ${out.resolutions.length} 条，summary ${out.summaryOk ? '有' : '无'}`);
        for (const r of out.resolutions) {
          console.log(`  - path=${r.path} action=${r.action ?? '(无)'} hunks=${(r.hunks || []).length}`);
        }
        console.log(`  契约问题：${out.problems.length === 0 ? '无' : out.problems.join('；')}`);
        console.log(`  中文：${hasCJK(content) ? '✓' : '✗'}`);
      }
      results.push({
        name: '冲突解决',
        ok: err === null && out.problems.length === 0,
        note: err ? err.message : `${out.resolutions.length} 条`,
      });
    } finally {
      await session.disconnect().catch(() => {});
    }
  }

  await client.stop().catch(() => {});
}

main()
  .then(() => {
    console.log('\n========== 汇总 ==========');
    for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name} —— ${r.note}`);
    process.exit(results.length > 0 && results.every((r) => r.ok) ? 0 : 1);
  })
  .catch((e) => {
    console.error('\n✗ 测试中断：', e && e.stack ? e.stack : e);
    process.exit(4);
  });
