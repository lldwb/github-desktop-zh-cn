// 探针：判定某处文案可否替换。
//
// 判据是**看出现位置的上下文**，不是看文案长相——同一个 `File` 既可能是菜单项、也可能是
// 模块导出名（见 docs/design/dict-v2/design.md）。本探针把每处出现的前 80 / 后 16 字符打出来，
// 并对几类高危上下文给出警告；最终判断由人做，探针只负责把证据摆齐。
//
// 用法：
//   node tools/ops/check-replaceable.cjs <文案> [选项]
//     --version <版本>   从 tmp/release/<版本>/<平台>-<架构>/app 取产物（默认取最新字典版本）
//     --path <目录>      显式指定产物目录：resources 目录（含 app/）或 app 目录本身都行。
//                        查英文原文请指向 tmp/backup/<版本>/——产物可能已汉化，那里才是原文
//     --all              连标识符 / 注释里的出现也列出（默认只看字符串字面量，排查误伤时用）
'use strict';
const fs = require('fs');
const path = require('path');
const common = require('../../scripts/common.js');

const BEFORE = 80;
// 后文窗口要比前文大一些：`case "x"`、`.get("x")` 这类判据里，关键调用**跟在字符串后面**，
// 16 字符常常刚够露出 `switch(e){case ` 而看不到后面还有没有别的分支。
const AFTER = 40;

// 高危上下文：命中说明这处很可能是「与运行时数据比较 / 查表」的常量，翻译会破坏逻辑。
// 这张表只是提示，不是判决——判据仍然是「赋值处与比较处是否同源」，那要人看上下文才能定。
// 规则分两类：看**前文**的（`.get("` —— 字符串是实参）与看**后文**的（`"===` —— 字符串在左）。
const DANGER = [
  [/\.(get|set|has|delete|getItem|setItem|removeItem|includes|indexOf)\(\s*$/, '作为查表 / 比较的实参'],
  [/Object\.defineProperty\(\s*[^,]+,\s*$/, '作为模块导出名'],
  [/process\.env\[\s*$/, '作为环境变量名'],
  [/[!=]==?\s*$/, '与某值比较（本处在前）'],
  [/^\s*[!=]==?/, '与某值比较（本处在后）'],
  [/^\s*;?\s*switch\([^)]*\)\s*\{\s*case\s*/, '作为 switch 分支值'],
];

function parseArgs(argv) {
  const args = { text: null, version: null, explicitPath: null, all: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version') args.version = argv[++i];
    else if (a === '--path') args.explicitPath = argv[++i];
    else if (a === '--all') args.all = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (!args.text) args.text = a;
    else throw new Error(`未知参数：${a}`);
  }
  return args;
}

// 定位产物目录。**参数化而不是写死路径**——写死的话换台机器就跑不起来，
// 而「能不能跑起来」正是这个探针有没有价值的全部。
function locateAppDir(args) {
  if (args.explicitPath) {
    const p = path.resolve(args.explicitPath);
    // 允许两种形态：resources 目录（含 app/）与 app 目录本身（含 main.js）。
    // 后者是官方原文备份 tmp/backup/<版本>/ 的形态——查「某处文案原本长什么样」时，
    // 那份才是权威来源（产物可能已经汉化过了，中文里当然找不到英文原文）。
    const appDir = fs.existsSync(path.join(p, 'main.js')) ? p : path.join(p, 'app');
    if (!fs.existsSync(path.join(appDir, 'main.js'))) {
      throw new Error(`指定目录下没有 main.js（既不是 resources 目录也不是 app 目录）：${p}`);
    }
    return appDir;
  }
  const versions = common.listDictVersions();
  const version = args.version || versions[versions.length - 1];
  if (!version) throw new Error('dictionaries/ 下没有版本目录，且未指定 --version');
  const work = path.join(common.dataRoot(), 'tmp', 'release', version);
  const plat = `${process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'}-${process.arch}`;
  const appDir = path.join(work, plat, 'app');
  if (!fs.existsSync(path.join(appDir, 'main.js'))) {
    const hint = fs.existsSync(work)
      ? `（${work} 下只有：${fs.readdirSync(work).join(' / ')}）`
      : '（该目录不存在，先跑一次 dict-auto.js 取产物，或用 --path 指定）';
    throw new Error(`找不到产物：${appDir}${hint}`);
  }
  return appDir;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.text) {
    console.log(`用法：node tools/ops/check-replaceable.cjs <文案> [选项]

判定某处文案可否替换：把产物里每处出现的前 ${BEFORE} / 后 ${AFTER} 字符打出来，
并对高危上下文（查表 / 比较 / 枚举取值）给出提示。**判断由人做**——判据是
「赋值处与比较处是否同源」，那要看上下文才能定。

选项：
  --version <版本>   从 tmp/release/<版本>/<平台>-<架构>/app 取产物（默认最新字典版本）
  --path <目录>      显式指定产物目录：resources 目录（含 app/）或 app 目录本身都行。
                     查英文原文请指向 tmp/backup/<版本>/——产物可能已汉化，那里才是原文
  --all              连标识符 / 注释里的出现也列出（默认只看字符串字面量）`);
    process.exit(args.help ? 0 : 1);
  }

  const appDir = locateAppDir(args);
  const needle = args.all ? args.text : `"${args.text}"`;
  console.log(`产物：${appDir}`);
  console.log(`查找：${JSON.stringify(needle)}${args.all ? '（含标识符与注释）' : '（仅字符串字面量）'}`);
  console.log();

  let total = 0;
  let danger = 0;
  for (const f of ['main.js', 'renderer.js']) {
    const file = path.join(appDir, f);
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    let i = -1;
    let n = 0;
    while ((i = src.indexOf(needle, i + 1)) !== -1) {
      n++;
      total++;
      const before = src.slice(Math.max(0, i - BEFORE), i);
      const after = src.slice(i + needle.length, i + needle.length + AFTER);
      const ctx = `${before}${needle}${after}`.replace(/\n/g, '\\n');
      const hits = DANGER.filter(([re]) => re.test(before) || re.test(after)).map(([, why]) => why);
      if (hits.length) danger++;
      console.log(`  ${f} @${i}${hits.length ? `  ⚠ ${hits.join('；')}` : ''}`);
      console.log(`    …${ctx}…`);
    }
    if (n) console.log(`  —— ${f} 共 ${n} 处\n`);
  }

  console.log(total === 0 ? '产物里没有这处文案（可能拼写不符，或用 --all 连标识符一起找）' : `合计 ${total} 处，其中 ${danger} 处命中高危上下文`);
  console.log('判定：高危上下文 ≠ 不能翻译——要看赋值处与比较处是否**同源**（同源的整组一起替换是自洽的）。');
}

main();
