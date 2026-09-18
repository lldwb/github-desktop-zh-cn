// 探针：给 workflow 做体检——run: 块逐个过 `bash -n`（GitHub 用的是 bash，语法错了整个 job 起不来），
// 顺便查 YAML 禁忌（制表符缩进、缩进非 2 的倍数）。零依赖，本地就能跑。
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const wfName = process.argv[2] || 'repair-release.yml';
const file = path.resolve(__dirname, '..', '..', '.github', 'workflows', wfName);
const lines = fs.readFileSync(file, 'utf8').split('\n');
const problems = [];

// 1. YAML 禁忌
lines.forEach((line, i) => {
  if (/^\t/.test(line) || /\t/.test(line.split('#')[0])) problems.push(`第 ${i + 1} 行有制表符（YAML 缩进只能用空格）`);
  const indent = line.length - line.trimStart().length;
  if (line.trim() && indent % 2 !== 0) problems.push(`第 ${i + 1} 行缩进 ${indent} 不是 2 的倍数`);
});

// 2. 抽 run: 块，交给 bash -n
const blocks = [];
for (let i = 0; i < lines.length; i++) {
  const m = /^(\s*)run:\s*\|/.exec(lines[i]);
  if (!m) continue;
  const base = m[1].length;
  const body = [];
  let j = i + 1;
  for (; j < lines.length; j++) {
    const line = lines[j];
    if (!line.trim()) { body.push(''); continue; }
    const indent = line.length - line.trimStart().length;
    if (indent <= base) break;
    body.push(line);
  }
  // 去掉公共缩进
  const common = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  blocks.push({ line: i + 1, sh: body.map((l) => (l.trim() ? l.slice(common) : '')).join('\n') });
  i = j - 1;
}

const dir = path.join(require('os').tmpdir(), 'wf-lint');
fs.mkdirSync(dir, { recursive: true });
for (const b of blocks) {
  const tmp = path.join(dir, `step-${b.line}.sh`);
  fs.writeFileSync(tmp, b.sh + '\n');
  try {
    execFileSync('bash', ['-n', tmp], { stdio: 'pipe' });
    console.log(`  ✓ run: 块（第 ${b.line} 行起，${b.sh.split('\n').length} 行）语法通过`);
  } catch (e) {
    problems.push(`第 ${b.line} 行起的 run: 块 bash 语法不过：${String(e.stderr || e.message).split('\n').slice(0, 3).join(' / ')}`);
    console.log(`  ✗ run: 块（第 ${b.line} 行起）语法不过`);
  }
}

// 3. 结构核对：步骤名与 uses 的缩进层级
const stepLines = lines.filter((l) => /^\s*-\s+(name|uses):/.test(l));
console.log(`\n步骤 ${stepLines.length} 个：`);
for (const l of stepLines) console.log('  ' + l.trim());

if (problems.length) {
  console.log('\n问题：');
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log('\n探针通过');
