// dict-groups.js — 组名自动推断
//
// 输入是安装目录里官方产物自带的 sourcemap（app/src/** 的 sourcesContent）与字典本身。
// 思路：字典的键就是产物里的界面原文，而每段原文在源码里都有出处——出处在哪个目录，
// 就大致说明了这段文案属于哪个界面。于是「组名」可以由出处推断，不需要人工标注。
//
// 三级规则（见 docs/dict-v2/design.md）：
//   1. 出自主菜单构建文件的 → 「菜单-<父菜单>」；能确定是菜单项但定不了父菜单 → 「菜单」
//   2. 其余按源文件目录查 DIR_GROUPS → 中文组名
//   3. 都落不上 → 「待分组」
//
// 产出写进字典的 groups 段（整体替换），写入经由 dict-edit 的事务入口，故本脚本不自作主张
// 校验——失败了让 dict-edit 抛错，不静默吞掉。
'use strict';

const fs = require('fs');
const path = require('path');
const common = require('./common');
const dictEdit = require('./dict-edit');

// —— 组名映射表 ——
// 按实测的条目分布填充（`tmp/dict-groups-probe.cjs` 的产物）。未列入的目录落「待分组」，
// 补一行即可提升覆盖率——这里刻意不猜，猜出来的组名比「待分组」更误导。
const DIR_GROUPS = {
  // 主菜单及其右键菜单：用户可见的菜单文案
  'main-process/menu': '菜单',
  // 主要界面
  'ui/preferences': '设置',
  'ui/changes': '更改',
  'ui/history': '历史',
  'ui/diff': '差异',
  'ui/toolbar': '工具栏',
  'ui/branches': '分支',
  'ui/create-branch': '分支',
  'ui/delete-branch': '分支',
  'ui/rename-branch': '分支',
  'ui/branch': '分支',
  'ui/worktrees': '工作树',
  'ui/repositories-list': '仓库列表',
  'ui/repository-settings': '仓库设置',
  'ui/repository-rules': '仓库规则',
  'ui/add-repository': '添加本地仓库',
  'ui/clone-repository': '克隆',
  'ui/no-repositories': '无仓库',
  'ui/welcome': '开始页',
  'ui/about': '关于',
  'ui/tutorial': '教程',
  'ui/release-notes': '发行说明',
  'ui/notifications': '通知',
  'ui/test-notifications': '通知',
  'ui/check-runs': '检查运行',
  'ui/secret-scanning': '密钥扫描',
  'ui/discard-changes': '丢弃更改',
  'ui/stash-changes': '贮藏',
  'ui/stashing': '贮藏',
  'ui/merge-conflicts': '合并冲突',
  'ui/multi-commit-operation': '多提交操作',
  'ui/hook-failed': '钩子失败',
  'ui/ssh': 'SSH',
  'ui/copilot': 'Copilot',
  'ui/install-git': '安装 Git',
  'ui/lfs': 'Git LFS',
  'ui/terms-and-conditions': '条款',
  'ui/open-pull-request': '创建 PR',
  'ui/pull-request-quick-view.tsx': '创建 PR',
  'ui/commit-message': '提交信息',
  'ui/commit-progress': '提交进度',
  'ui/generate-commit-message': '提交信息',
  'ui/banners': '横幅提示',
  'ui/sign-in': '登录',
  'ui/account-picker.tsx': '登录',
  'ui/app-menu': '菜单',
  // 跨界面共用的文案
  lib: '通用',
  'ui/lib': '通用',
  models: '通用',
  // ui/ 兜底：ui 根下的文件（copy-button、app、tab-bar…）与未收录的子目录（dialog、editor、
  // shell、octicons…）都是跨界面复用件。收录了具体界面的子目录在上面各自命中，最长前缀优先。
  // 取舍：新增的 ui 子界面会被静默吞进「通用」而不是「待分组」——分组只是参考、不影响替换，
  // 而让 40 多个基础件目录落「待分组」会让这个信号失真。要单独成组在此表加一行即可。
  ui: '通用',
  // 主进程里非菜单的部分（入口、更新、存储）
  'main-process': '主进程',
};

const UNGROUPED = '待分组';
const MENU_FILE = 'main-process/menu/build-default-menu.ts';

// 父菜单译名：Windows 分支的 label 去掉 & 助记符后的英文 → 中文
const MENU_NAMES = {
  File: '文件',
  Edit: '编辑',
  View: '视图',
  Repository: '仓库',
  Branch: '分支',
  Help: '帮助',
  'GitHub Desktop': '应用',
};

// 产物侧归一化：与 scan.js 同一口径——产物文案经 sentenceCase 处理，与源码的 Title Case
// 不同，JSX 多行文本在产物里还带转义换行与缩进，故折叠空白 + 忽略大小写。
const normalize = (c) => c.replace(/\\n|\\t|\\r/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
// 助记符 `&`：源码 label 带它（`&File`），产物里被剥掉；两侧都剥才比得上
const stripMnemonic = (s) => s.replace(/&/g, '');

// ============================ 菜单归属 ============================
//
// build-default-menu.ts 不是一个大字面量，而是「先定义菜单项变量 → 收进数组变量 →
// template.push({ label, submenu }) 组装」，还有 `const fileItems = fileMenu.submenu`
// 这类别名在块外继续 push。所以要按引用关系做三级传播，不能按源码位置就近归属——
// 后者会把帮助菜单的项（定义在分支菜单之后）误判成分支菜单。

// 从 p（指向 { 或 [）起找配对收尾；跳过字符串、模板字面量与注释
function matchBracket(src, p) {
  let depth = 0;
  for (let i = p; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// 区间内深度为 1 的文本（跳过更深层的括号内容）
function topLevelText(src, open, close) {
  let out = '';
  let depth = 0;
  for (let i = open; i <= close; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      out += c;
      i++;
      while (i <= close && src[i] !== c) {
        out += src[i];
        if (src[i] === '\\') {
          i++;
          out += src[i];
        }
        i++;
      }
      out += c;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') {
      depth++;
      if (depth > 1) continue;
    } else if (c === '}' || c === ']' || c === ')') {
      depth--;
      if (depth >= 1) continue;
    }
    if (depth <= 1) out += c;
  }
  return out;
}

// 区间内按顶层逗号切出的元素区间
function elementRanges(src, open, close) {
  const parts = [];
  let start = open + 1;
  let depth = 0;
  for (let i = open + 1; i < close; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < close && src[i] !== q) {
        if (src[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < close && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < close && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push([start, i]);
      start = i + 1;
    }
  }
  if (start < close) parts.push([start, close]);
  return parts.filter(([a, b]) => src.slice(a, b).trim());
}

// label 取值：`__DARWIN__ ? 'Mac 名' : '&Windows 名'` 取 Windows 名（字典就是从 Windows 产物提取的），
// 无三元则两边同名
const LABEL_RE = /label\s*:\s*(?:__DARWIN__\s*\?\s*'([^']*)'\s*:\s*)?'([^']*)'/;
function labelOf(text) {
  const m = LABEL_RE.exec(text);
  return m ? { win: m[2], mac: m[1] || m[2] } : null;
}

// 解析主菜单构建文件，返回 Map<源码 label, 父菜单译名>
function parseMenuLabels(src) {
  const decls = new Map();
  const declRe = /const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*([{[])/g;
  let m;
  while ((m = declRe.exec(src))) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(src, open);
    if (close >= 0) decls.set(m[1], { open, close, kind: src[open] });
  }

  const pushItems = (open, close, out, depth = 0) => {
    if (depth > 4) return;
    for (const [a, b] of elementRanges(src, open, close)) {
      const txt = src.slice(a, b).trim();
      const at = a + (src.slice(a, b).length - src.slice(a, b).trimStart().length);
      if (txt.startsWith('{')) {
        const l = labelOf(topLevelText(src, at, matchBracket(src, at)));
        if (l) out.push(l);
        continue;
      }
      const id = /^(?:\.\.\.\s*)?([A-Za-z_$][\w$]*)/.exec(txt);
      const d = id && decls.get(id[1]);
      if (!d) continue;
      if (d.kind === '[') pushItems(d.open, d.close, out, depth + 1);
      else {
        const l = labelOf(topLevelText(src, d.open, d.close));
        if (l) out.push(l);
      }
    }
  };

  // submenu 的值可能是内联数组，也可能是数组变量名
  const pushSubmenu = (open, close, out) => {
    const seg = src.slice(open, close);
    const sm = /submenu\s*:\s*/.exec(seg);
    if (!sm) return;
    const sp = open + sm.index + sm[0].length;
    if (src[sp] === '[') return pushItems(sp, matchBracket(src, sp), out);
    const id = /^([A-Za-z_$][\w$]*)/.exec(src.slice(sp, sp + 60));
    const d = id && decls.get(id[1]);
    if (d && d.kind === '[') pushItems(d.open, d.close, out);
  };

  // `const fileItems = fileMenu.submenu` 之后的 fileItems.push(...) 仍属 fileMenu
  const aliasPush = new Map();
  const aliasRe = /const\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\.submenu\b/g;
  while ((m = aliasRe.exec(src))) {
    const [, alias, owner] = m;
    const re = new RegExp(`\\b${alias}\\.push\\s*\\(`, 'g');
    let p;
    while ((p = re.exec(src))) {
      const open = p.index + p[0].length - 1;
      const out = aliasPush.get(owner) || [];
      pushItems(open, matchBracket(src, open), out);
      aliasPush.set(owner, out);
    }
  }

  const byLabel = new Map();
  const pushRe = /template\.push\(\s*([{A-Za-z_$])/g;
  while ((m = pushRe.exec(src))) {
    const isObj = m[1] === '{';
    const vp = m.index + m[0].length - 1;
    let label = null;
    let items = [];
    let varName = null;
    if (isObj) {
      const close = matchBracket(src, vp);
      label = labelOf(topLevelText(src, vp, close));
      pushSubmenu(vp, close, items);
    } else {
      const name = /^[A-Za-z_$][\w$]*/.exec(src.slice(vp));
      const d = name && decls.get(name[0]);
      if (!d) continue;
      varName = name[0];
      if (d.kind === '{') {
        label = labelOf(topLevelText(src, d.open, d.close));
        pushSubmenu(d.open, d.close, items);
      } else {
        pushItems(d.open, d.close, items);
      }
    }
    if (varName && aliasPush.has(varName)) items = items.concat(aliasPush.get(varName));
    // macOS 专有的 role 菜单（无 label）跳过；其子项在 Windows 上不出现
    const menuName = label ? MENU_NAMES[label.win.replace(/&/g, '')] : null;
    if (!menuName) continue;
    // 顶层菜单自身的 label 也算该菜单的条目——用户看到的菜单标题就是它
    for (const name of [label.win, label.mac]) {
      if (!byLabel.has(name)) byLabel.set(name, menuName);
    }
    for (const it of items) {
      for (const name of [it.win, it.mac]) {
        if (!byLabel.has(name)) byLabel.set(name, menuName);
      }
    }
  }
  return byLabel;
}

// ============================ 主流程 ============================

function parseArgs(argv) {
  const args = { explicitPath: null, version: null, dryRun: false, json: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--path') args.explicitPath = argv[++i];
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--json') args.json = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`未知参数：${a}（--help 查看用法）`);
  }
  return args;
}

function printHelp() {
  console.log(`用法：node scripts/dict-groups.js [选项]

推断字典条目的组名并写进 groups 段（读安装目录的 renderer.js.map / main.js.map）。
组名只是分类参考，不影响替换行为。未归入任何组的条目落「待分组」。

选项：
  --version <版本>  指定字典版本（默认取 dictionaries/ 下最新版本）
  --path <目录>     显式指定 resources 目录
  --json <文件>     把推断结果写成 JSON（不写入字典）
  --dry-run         只打印统计并校验，不写入字典
  -h, --help        显示本帮助

本脚本也可通过交互式入口调用：github-desktop-zh-cn groups [选项]`);
}

// 字典键 → 源文件（键即产物原文，故产物侧索引直接用字典建，不去读已汉化的产物文件）
function buildFileIndex(keys, appDir) {
  const byNormalized = new Map();
  for (const k of keys) {
    const bare = common.splitScopedKey(k).key;
    if (bare.startsWith('`')) continue; // 整模板键的插值变量名在构建时被重命名，源码对不上
    const n = normalize(bare);
    if (!byNormalized.has(n)) byNormalized.set(n, new Set());
    byNormalized.get(n).add(k);
  }

  const fileOf = new Map();
  let scanned = 0;
  for (const f of ['main.js', 'renderer.js']) {
    const mapFile = path.join(appDir, `${f}.map`);
    if (!fs.existsSync(mapFile)) continue;
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    for (let i = 0; i < map.sources.length; i++) {
      const src = map.sources[i];
      const content = map.sourcesContent[i];
      if (!content || !/\/app\/src\//.test(src)) continue;
      scanned++;
      const file = src.replace(/^.*\/app\/src\//, '');
      const add = (text) => {
        const c = text.replace(/\s+/g, ' ').trim();
        if (!c) return;
        for (const k of byNormalized.get(normalize(c)) || []) if (!fileOf.has(k)) fileOf.set(k, file);
      };
      for (const l of common.stringLiterals(content)) {
        if (l.template) continue;
        add(l.content);
      }
      // JSX 文本节点：夹在 `>`/`}` 与 `<`/`{` 之间，可跨行。JSX 编译时同一节点内的
      // 换行进产物会折叠成单个空格（首尾紧邻标签的那种则被删除，靠 normalize 的 trim 抹平），
      // 所以这里整体取出再折叠空白，与产物的形态对上。
      // 只对 .tsx/.jsx 做——.ts 里的 `>` `<` 是泛型与比较运算符，误抓无益。
      if (/\.jsx?$|\.tsx$/.test(file)) {
        const re = /(?<=[>}])([^<>{}]+)(?=[<{])/g;
        let m;
        while ((m = re.exec(content))) add(m[1]);
      }
    }
  }
  return { fileOf, scanned };
}

// 文件级映射，优先于目录前缀。`build-test-menu.ts` 是官方仅用于开发调试的测试菜单——它把
// 各对话框与横幅的标题做成一键打开的按钮，所以它的"菜单项"其实是标题文案，归「菜单」会误导。
// `build-spell-check-menu.ts` 则是用户可见的右键菜单，留在「菜单」组。
const FILE_GROUPS = {
  'main-process/menu/build-test-menu.ts': UNGROUPED,
};

// 源文件 → 组名。按最长前缀匹配：lib/git/x.ts 先试 lib/git 再试 lib
function groupOfFile(file) {
  if (FILE_GROUPS[file]) return FILE_GROUPS[file];
  const parts = file.split('/');
  for (let n = Math.min(parts.length - 1, 3); n >= 1; n--) {
    const g = DIR_GROUPS[parts.slice(0, n).join('/')];
    if (g) return g;
  }
  return null;
}

function infer(version, { explicitPath } = {}) {
  const app = common.locateApp({ explicitPath });
  if (version !== app.version) {
    throw new Error(`版本不一致：字典版本 ${version} ≠ 安装版本 ${app.version}`);
  }
  // 遍历所有平台段的键，而不是 loadDict 的平台合并结果：分段字典里非本机平台的条目
  // （如 macOS 的 Title Case 变体）不在合并结果里，漏掉会让它们永远落「待分组」。
  const raw = JSON.parse(fs.readFileSync(dictEdit.dictPath(version), 'utf8'));
  const allKeys = [...new Set(common.SEGMENT_NAMES.flatMap((s) => Object.keys(raw[s] || {})))];

  const menuMap = new Map();
  const menuMapFile = path.join(app.appDir, 'main.js.map');
  if (fs.existsSync(menuMapFile)) {
    const map = JSON.parse(fs.readFileSync(menuMapFile, 'utf8'));
    const i = map.sources.findIndex((s) => s.endsWith(MENU_FILE));
    if (i >= 0 && map.sourcesContent[i]) {
      for (const [label, menu] of parseMenuLabels(map.sourcesContent[i])) {
        menuMap.set(normalize(stripMnemonic(label)), menu);
      }
    }
    // 解析器失效（官方改了菜单文件的写法）时不报错：菜单条目会退到「菜单」组
  }

  const { fileOf, scanned } = buildFileIndex(allKeys, app.appDir);
  const groups = {};
  const add = (g, k) => {
    if (!groups[g]) groups[g] = [];
    groups[g].push(k);
  };

  const stats = { 菜单: 0, 有来源: 0, 无来源: 0 };
  for (const k of allKeys) {
    const file = fileOf.get(k);
    const bare = common.splitScopedKey(k).key;
    if (file === MENU_FILE) {
      const menu = menuMap.get(normalize(stripMnemonic(bare)));
      add(menu ? `菜单-${menu}` : '菜单', k);
      stats.菜单++;
    } else {
      const g = file ? groupOfFile(file) : null;
      if (g) stats.有来源++;
      else stats.无来源++;
      add(g || UNGROUPED, k);
    }
  }

  // 组内按键名排序，让 groups 段稳定——否则源文件遍历顺序一变就产生整段 diff
  for (const g of Object.keys(groups)) groups[g].sort();
  return { app, groups, stats: { ...stats, scanned, 已定位: fileOf.size } };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (e) {
    console.error(`错误：${e.message}`);
    process.exit(1);
  }
  if (args.help) {
    printHelp();
    return;
  }

  try {
    const versions = common.listDictVersions();
    if (versions.length === 0) throw new Error('dictionaries/ 下没有版本目录');
    const version = args.version || versions[versions.length - 1];

    const { groups, stats } = infer(version, { explicitPath: args.explicitPath });
    const names = Object.keys(groups).sort();
    console.log(`字典 ${version}：推断出 ${names.length} 个组，扫描 ${stats.scanned} 个自有源文件`);
    for (const g of names) console.log(`  ${g.padEnd(12)} ${groups[g].length} 条`);
    console.log(`\n菜单条目 ${stats.菜单} 条；按源文件目录定位 ${stats.有来源} 条；落「${UNGROUPED}」${stats.无来源} 条`);

    if (args.json) {
      fs.writeFileSync(args.json, `${JSON.stringify(groups, null, 2)}\n`, 'utf8');
      console.log(`已写出：${args.json}`);
      return;
    }
    if (args.dryRun) {
      console.log('（--dry-run 预览，未写入字典）');
      return;
    }
    const r = dictEdit.regroup(version, { groups });
    console.log(`\n已写入字典：${r.changes.join('；')}`);
    if (r.warnings.length) for (const w of r.warnings) console.log(`  [提示] ${w.code}：${w.detail}`);
  } catch (e) {
    console.error(`错误：${e.message}`);
    if (e.problems) for (const p of e.problems) console.error(`  ${p.code}：${p.detail}`);
    process.exit(1);
  }
}

module.exports = { infer, groupOfFile, parseMenuLabels, DIR_GROUPS, MENU_NAMES, main };

if (require.main === module) main();
