// 共享模块：安装目录定位、版本读取、字典读取、备份（SSOT，其余脚本引用）
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const TMP_DIR = path.join(REPO_ROOT, 'tmp');

const RESOURCES_REL = ['resources'];
const APP_SUBDIR = 'app';

function getTmpDir() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  return TMP_DIR;
}

// 解析 app-3.6.5 形式的版本号，用于取最新安装目录
function parseVersion(v) {
  const m = /^app-(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return { raw: v, major: +m[1], minor: +m[2], patch: +m[3] };
}

// 候选安装根目录（按平台）
function candidateRoots() {
  const roots = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    roots.push(path.join(local, 'GitHubDesktop'));
  } else if (process.platform === 'darwin') {
    roots.push('/Applications/GitHub Desktop.app/Contents/Resources');
    roots.push(path.join(os.homedir(), 'Applications', 'GitHub Desktop.app', 'Contents', 'Resources'));
  } else {
    roots.push('/usr/lib/github-desktop/resources');
    roots.push('/opt/GitHubDesktop/resources');
  }
  return roots;
}

// 定位安装目录。返回 { resourcesDir, appDir, version } 或抛错。
// 优先 --path 显式指定（指向 resources 目录），否则自动探测最新版本。
function locateApp({ explicitPath } = {}) {
  if (explicitPath) {
    const resourcesDir = path.resolve(explicitPath);
    const appDir = path.join(resourcesDir, APP_SUBDIR);
    for (const f of ['main.js', 'renderer.js', 'package.json']) {
      if (!fs.existsSync(path.join(appDir, f))) {
        throw new Error(`指定目录不是有效的 GitHub Desktop 资源目录：${resourcesDir}（缺少 app/${f}）`);
      }
    }
    return { resourcesDir, appDir, version: readVersion(appDir) };
  }

  const found = [];
  for (const root of candidateRoots()) {
    if (!fs.existsSync(root)) continue;
    if (process.platform === 'win32') {
      // Windows：GitHubDesktop/app-<版本>/
      for (const entry of fs.readdirSync(root)) {
        const ver = parseVersion(entry);
        if (ver) {
          const resourcesDir = path.join(root, entry, ...RESOURCES_REL);
          if (fs.existsSync(resourcesDir)) {
            found.push({ ver, resourcesDir });
          }
        }
      }
    } else {
      // macOS/Linux：安装根本身即 Resources，无版本子目录
      if (fs.existsSync(path.join(root, APP_SUBDIR, 'package.json'))) {
        found.push({ ver: { raw: root, major: 0, minor: 0, patch: 0 }, resourcesDir: root });
      }
    }
  }
  if (found.length === 0) {
    throw new Error(
      '未找到 GitHub Desktop 安装目录。请用 --path 指定 resources 目录（例如 …/GitHubDesktop/app-3.6.5/resources）'
    );
  }
  found.sort((a, b) => b.ver.major - a.ver.major || b.ver.minor - a.ver.minor || b.ver.patch - a.ver.patch);
  const { resourcesDir } = found[0];
  const appDir = path.join(resourcesDir, APP_SUBDIR);
  return { resourcesDir, appDir, version: readVersion(appDir) };
}

// 读取 app/package.json 的 version 字段
function readVersion(appDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  if (!pkg.version) throw new Error('app/package.json 缺少 version 字段');
  return pkg.version;
}

// 列出 dictionaries/ 下的版本目录（目录名即版本号），返回按版本排序的数组
function listDictVersions() {
  const dir = path.join(REPO_ROOT, 'dictionaries');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(compareVersions);
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// 作用域键：`<文件名>.js|原文` 只对该文件生效（同一字面量在两个文件中语义不同时用，
// 如 "en-US" 在 renderer 是相对时间语言、在 main.js 是拼写检查逻辑）。
const SCOPED_KEY = /^([A-Za-z0-9._-]+\.js)\|([\s\S]+)$/;

// 把字典原始对象整理为「原样键 → 译文」的 Map，并校验条目合法性。
// 整模板键（以反引号开头、含 ${}）的译文必须是 JS 字符串/模板字面量。
function buildEntries(raw, version) {
  const entries = new Map();
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`字典条目非法（${version}）：${k} 的译文必须是非空字符串`);
    }
    const m = SCOPED_KEY.exec(k);
    const key = m ? m[2] : k;
    if (key.startsWith('`')) {
      const q = v[0];
      if ((q !== '`' && q !== '"' && q !== "'") || v[v.length - 1] !== q) {
        throw new Error(
          `字典条目非法（${version}）：整模板键 ${k} 的译文必须是 JS 字符串/模板字面量（首尾同为引号或反引号）`
        );
      }
    }
    entries.set(k, v);
  }
  return entries;
}

// 取某文件的生效条目 Map<键, 译文>：全局键 + 作用域指向该文件的键（键名去掉前缀）；
// 指向其他文件的作用域键被跳过。file 省略时返回全部（保留原键名，供统计/报告使用）。
function scopedEntries(entries, file) {
  const out = new Map();
  for (const [k, v] of entries) {
    const m = SCOPED_KEY.exec(k);
    if (!m) {
      out.set(k, v);
    } else if (!file) {
      out.set(k, v);
    } else if (m[1] === file) {
      out.set(m[2], v);
    }
  }
  return out;
}

// 读取字典：dictionaries/<version>/zh-CN.json，跳过 _ 开头的元信息键
function loadDict(version) {
  const file = path.join(REPO_ROOT, 'dictionaries', version, 'zh-CN.json');
  if (!fs.existsSync(file)) {
    throw new Error(`字典不存在：${file}`);
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = buildEntries(raw, version);
  if (entries.size === 0) throw new Error(`字典为空：${file}`);
  return entries;
}

// 备份目录：tmp/backup/<version>/
function backupDir(version) {
  return path.join(getTmpDir(), 'backup', version);
}

// 备份 main.js / renderer.js 到 tmp/backup/<version>/（已存在则跳过）
function backupAppFiles(appDir, version) {
  const dest = backupDir(version);
  const targets = ['main.js', 'renderer.js'];
  const backed = [];
  for (const f of targets) {
    const src = path.join(appDir, f);
    const dst = path.join(dest, f);
    if (fs.existsSync(dst)) {
      backed.push({ f, skipped: true });
      continue;
    }
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(src, dst);
    backed.push({ f, skipped: false });
  }
  return backed;
}

function backupExists(version) {
  const dest = backupDir(version);
  return fs.existsSync(path.join(dest, 'main.js')) && fs.existsSync(path.join(dest, 'renderer.js'));
}

// 关键字后可直接跟正则字面量（如 return/regex/、typeof/x/），此时 '/' 前是关键字末尾字母
const REGEX_AFTER = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
]);

// 判断 src[i] 的 '/' 是除法还是正则开头：看前一个非空白字符，
// 若为标识符/数字/闭括号/闭引号 → 除法（但若该标识符是 REGEX_AFTER 关键字则视为正则）；
// 其余（操作符、分隔符、行首）→ 正则。webpack 产物风格统一，该启发式在其上可靠。
function isRegexStart(src, i) {
  let p = i - 1;
  while (p >= 0 && /\s/.test(src[p])) p--;
  if (p < 0) return true;
  const c = src[p];
  if (/[A-Za-z0-9_$)\]}"']/.test(c) || c === '`') {
    let q = p;
    while (q >= 0 && /[A-Za-z0-9_$]/.test(src[q])) q--;
    const word = src.slice(q + 1, p + 1);
    if (REGEX_AFTER.has(word)) return true;
    return false;
  }
  return true;
}

// 提取 JS 源码中的可替换区间，返回 [{ start, end, content, template }]：
//   - 字符串字面量内容区间（不含引号/反引号；模板字符串剔除 ${} 插值部分），template=false；
//   - 含插值的模板字符串整体区间（含两侧反引号），template=true——供「整模板替换」使用。
// 替换只应发生在这些区间内，避免误伤标识符/属性名/正则/注释。
// 递归处理：模板插值内是完整代码（含嵌套字符串/模板/正则/注释/花括号），其中的字符串与模板不收集
// （插值内是代码，替换单段文本会破坏逻辑；需要替换插值内整段文本时按整模板键处理外层模板）。
function stringLiterals(src) {
  const out = [];
  const n = src.length;
  const push = (start, end) => {
    if (end > start) out.push({ start, end, content: src.slice(start, end), template: false });
  };

  // 扫描代码；stopOnBrace 时在花括号深度归零的 '}' 处返回（用于模板插值）。
  // collect=false 时不提取任何字符串（模板插值内是代码，替换会破坏逻辑）。
  function scanCode(i, stopOnBrace, collect) {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '"' || c === "'") {
        const q = c;
        let j = i + 1;
        while (j < n) {
          if (src[j] === '\\') j += 2;
          else if (src[j] === q) break;
          else j++;
        }
        if (collect) push(i + 1, j);
        i = j < n ? j + 1 : j;
      } else if (c === '`') {
        i = scanTemplate(i, collect);
      } else if (c === '/' && src[i + 1] === '/') {
        while (i < n && src[i] !== '\n') i++;
      } else if (c === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i = Math.min(i + 2, n);
      } else if (c === '/' && isRegexStart(src, i)) {
        let j = i + 1;
        let inClass = false;
        while (j < n) {
          const ch = src[j];
          if (ch === '\\') j += 2;
          else if (ch === '[') { inClass = true; j++; }
          else if (ch === ']') { inClass = false; j++; }
          else if (ch === '/' && !inClass) break;
          else j++;
        }
        i = j < n ? j + 1 : j;
      } else if (c === '{') {
        depth++;
        i++;
      } else if (c === '}') {
        if (stopOnBrace && depth === 0) return i;
        depth = Math.max(0, depth - 1);
        i++;
      } else {
        i++;
      }
    }
    return i;
  }

  // 扫描模板字符串（i 指向反引号），返回闭合反引号后的位置；
  // collect=false 时不提取文本段（插值内的嵌套模板同样是代码）；
  // 含插值的模板额外整段收集一个区间（content 含两侧反引号），供给整模板键匹配。
  function scanTemplate(i, collect) {
    const tStart = i;
    let hasInterp = false;
    let j = i + 1;
    let segStart = j;
    while (j < n) {
      if (src[j] === '\\') j += 2;
      else if (src[j] === '`') {
        if (collect) {
          push(segStart, j);
          if (hasInterp) {
            out.push({ start: tStart, end: j + 1, content: src.slice(tStart, j + 1), template: true });
          }
        }
        return j + 1;
      } else if (src[j] === '$' && src[j + 1] === '{') {
        hasInterp = true;
        if (collect) push(segStart, j);
        j = scanCode(j + 2, true, false);
        if (j < n) j++; // 跳过插值闭合的 '}'
        segStart = j;
      } else {
        j++;
      }
    }
    return j;
  }

  scanCode(0, false, true);
  return out;
}

// 在字符串字面量区间内做字典替换；非字符串代码原样保留。
// 整串匹配：仅当字符串内容与字典 key 完全相等时才替换（候选池按完整字面量提取，天然兼容）。
// 不做子串替换——子串会误伤协议串 / 枚举键名 / 拼接片段（如 "sessions.setAdditionalPlugins" 含 "Add"）。
// 两种键：
//   - 普通键：匹配字符串字面量内容或模板的文本段（如 "Fetch "）；
//   - 整模板键（以反引号开头结尾，含 ${} 插值）：匹配整个模板字面量源码，替换值须是合法 JS 字符串/模板字面量，
//     用于「运行时拼接」文案（复数后缀、由函数拼出的动词等）——外层模板优先，其内部文本段不再单独替换。
function applyDictInStrings(content, entries) {
  const lits = stringLiterals(content);
  const repls = [];
  for (const l of lits) {
    const v = entries.get(l.content);
    if (v !== undefined) repls.push({ start: l.start, end: l.end, key: l.content, text: v });
  }
  // 起点升序、同起点时长的优先（外层模板覆盖其内部文本段）
  repls.sort((a, b) => a.start - b.start || b.end - a.end);

  let out = '';
  let pos = 0;
  let total = 0;
  const perKey = new Map();
  for (const r of repls) {
    if (r.start < pos) continue; // 已被外层替换覆盖
    out += content.slice(pos, r.start) + r.text;
    pos = r.end;
    total++;
    perKey.set(r.key, (perKey.get(r.key) || 0) + 1);
  }
  out += content.slice(pos);
  return { content: out, total, perKey };
}

module.exports = {
  REPO_ROOT,
  TMP_DIR,
  getTmpDir,
  locateApp,
  readVersion,
  listDictVersions,
  loadDict,
  backupDir,
  backupAppFiles,
  backupExists,
  stringLiterals,
  applyDictInStrings,
  buildEntries,
  scopedEntries,
};
