// 探针模板 —— 拷成 tmp/probeNNN.cjs，改 VERSION / MODE / CANDIDATES 后执行：node tmp/probeNNN.cjs
//
// 两种口径（口径搞反会得到完全错误的结论，见 SKILL.md 铁律 1）：
//   dry  —— 收录前预演：在【备份的官方原文】tmp/backup/<版本>/ 上跑候选，逐键报命中数与位置。
//           零命中的候选一律剔除；合计命中数作为第 5 步 npm run patch 的预期值。
//   land —— 打包后复查：在【安装目录的 patched 产物】上数「原文残留」与「译文在位」。
'use strict';

const fs = require('fs');
const path = require('path');
const {
  loadDict,
  buildEntries,
  scopedEntries,
  applyDictInStrings,
  stringLiterals,
  locateApp,
  backupDir,
} = require('../scripts/common');

const VERSION = '3.6.5'; // 改成目标字典版本（须与 dictionaries/ 下目录名、安装版本一致）
const MODE = 'dry'; // 'dry'（收录前预演） | 'land'（打包后复查）
const CANDIDATES = {
  // '原文': '译文',
  // 'renderer.js|原文': '译文',        // 作用域键写全前缀
  // '`${a} 原文 ${b}`': '`${a} 译文 ${b}`',   // 整模板键：键值都是完整模板源码
};
const LIMIT = 20; // 铁律 3：输出必须截断，每键最多打印几处位置

const FILES = ['main.js', 'renderer.js'];
const SCOPED = /^([A-Za-z0-9._-]+\.js)\|([\s\S]+)$/;

// 候选 → 生效键（剥离作用域前缀）+ 该键生效的文件（null = 两个文件都生效）
function normKey(raw) {
  const m = SCOPED.exec(raw);
  return { key: m ? m[2] : raw, file: m ? m[1] : null };
}

function candidatesFor(file) {
  return Object.entries(CANDIDATES).filter(([raw]) => {
    const { file: f } = normKey(raw);
    return f === null || f === file;
  });
}

// 合并「现有字典 + 候选」：候选用 buildEntries 走一遍校验（译文非空、整模板键首尾引号对称）
function mergedEntries() {
  return buildEntries({ ...Object.fromEntries(loadDict(VERSION)), ...CANDIDATES }, VERSION);
}

// ---- dry：在备份原文上预演 --------------------------------------------------
function dry() {
  const entries = mergedEntries();
  for (const file of FILES) {
    const src = fs.readFileSync(path.join(backupDir(VERSION), file), 'utf8');
    // applyDictInStrings 期望已剥离作用域前缀的键（SKILL.md「关键机制」）
    const { total, perKey } = applyDictInStrings(src, scopedEntries(entries, file));
    console.log(`\n===== ${file}（备份原文）合计命中 ${total} 处 =====`);

    for (const [raw] of candidatesFor(file)) {
      const { key } = normKey(raw);
      const n = perKey.get(key) || 0;
      console.log(`  ${n > 0 ? '✓' : '✗'} [${n} 处] ${JSON.stringify(raw)}`);
      if (n === 0) continue; // 铁律 5：零命中 = 剔除该候选

      let shown = 0;
      for (const lit of stringLiterals(src)) {
        if (lit.content !== key) continue;
        if (shown >= LIMIT) {
          console.log('      …（其余位置略）');
          break;
        }
        const from = Math.max(0, lit.start - 60);
        const ctx = src.slice(from, lit.end + 60).replace(/\s+/g, ' ');
        console.log(`      @${lit.start} …${ctx}…`);
        shown++;
      }
    }
  }
}

// ---- land：在 patched 产物上复查 --------------------------------------------
function land() {
  const app = locateApp({});
  if (app.version !== VERSION) {
    console.error(`安装版本 ${app.version} ≠ 探针 VERSION ${VERSION}`);
    process.exit(2);
  }
  for (const file of FILES) {
    const src = fs.readFileSync(path.join(app.appDir, file), 'utf8');
    const count = new Map(); // 字面量内容 → 出现次数（整串匹配口径，与引擎一致）
    for (const lit of stringLiterals(src)) count.set(lit.content, (count.get(lit.content) || 0) + 1);
    const rawCount = (s) => src.split(s).length - 1; // 纯文本口径（整模板键只能用它）

    console.log(`\n===== ${file}（patched 产物）=====`);
    for (const [raw, text] of candidatesFor(file)) {
      const { key } = normKey(raw);
      if (key.startsWith('`')) {
        // 整模板键：键/值都是完整模板源码，用纯文本口径
        console.log(`  ${rawCount(key) === 0 ? '✓' : '✗'} 原模板残留 ${rawCount(key)} 处 / 新模板在位 ${rawCount(text)} 处 ${JSON.stringify(raw)}`);
        continue;
      }
      const left = count.get(key) || 0;
      const hit = count.get(text) || 0;
      // 三态：残留=0 且有译文 → 已生效；两者皆 0 → 该键在本文件不出现（作用域隔离的正常结果，不是失败）
      const mark = left === 0 ? (hit > 0 ? '✓' : '·') : '✗';
      console.log(`  ${mark} 原文残留 ${left} 处 / 译文在位 ${hit} 处 ${JSON.stringify(raw)}`);
    }
  }
}

console.log(`模式 ${MODE}：${MODE === 'dry' ? '在备份原文上预演（收录前）' : '在 patched 产物上复查（打包后）'}`);
if (MODE === 'dry') dry();
else land();
