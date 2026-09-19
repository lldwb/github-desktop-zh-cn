// 共享模块：安装目录定位、版本读取、字典读取、备份（SSOT，其余脚本引用）
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.resolve(__dirname, '..');

const RESOURCES_REL = ['resources'];
const APP_SUBDIR = 'app';
const APP_NAME = 'github-desktop-zh-cn';

// —— 远程仓库（在线字典与自更新，SSOT）——
// 字典按候选顺序尝试：GitHub raw 为权威源，jsDelivr 兜底（部分地区可达性更好）。
const GH_OWNER = 'lldwb';
const GH_REPO = 'github-desktop-zh-cn';
const GH_BRANCH = 'main';
const GH_RAW = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}`;
const GH_CDN = `https://cdn.jsdelivr.net/gh/${GH_OWNER}/${GH_REPO}@${GH_BRANCH}`;
const GH_API = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}`;
// Gitee 镜像：仓库由镜像自动同步（commit / 分支 / tag 同步，**发行版不同步**），raw 文件可直连。
// 放在末位兜底——它不是权威源，内容与 main 分支一致时才有同等效力。
const GITEE_RAW = `https://gitee.com/${GH_OWNER}/${GH_REPO}/raw/${GH_BRANCH}`;
const GITEE_API = `https://gitee.com/api/v5/repos/${GH_OWNER}/${GH_REPO}`;

// —— 运行形态与数据根目录（SSOT）——
// 四种运行形态，判据只有 isPackaged()（SEA / bundle 产物）与 isElectronPackaged()（Electron 产物）两个：
//   源码态（node scripts/xxx.js）与 Electron 开发态（electron .）：数据根 = 仓库根，字典与备份位置与既有版本一致；
//   打包态（scripts/build.js 的 SEA 单文件产物 / electron-builder 的 GUI 产物）：数据根 = 可执行文件所在目录——
//   解压即用、字典可直接替换；该目录不可写（如放在 Program Files）时回退用户数据目录。
//   一个例外：macOS 的 Electron 产物（.app）数据根恒为用户数据目录——exe 在 .app 包内，包内写入会让签名失效。
// 字典一律「外部优先、内嵌兜底」：<数据根>/dictionaries/<版本>/zh-CN.json 存在则用它，
//   否则取打包时内嵌进可执行文件的同名资源（内嵌资源只有 SEA 产物具备），保证单文件分发时字典不丢失。
//   Electron 产物没有内嵌资源（node:sea 不可用），字典随包放在应用的 resources/dictionaries，
//   由 GUI 首次运行时播种到数据根（见 gui/main.js 的 seedBundledDicts）。

let _seaCache;
// node:sea 在 Node <20.12 不存在，require 抛错时按源码态处理
function seaApi() {
  if (_seaCache === undefined) {
    try { _seaCache = require('node:sea'); } catch { _seaCache = null; }
  }
  return _seaCache;
}

function isPackaged() {
  if (globalThis.__BUNDLED__) return true; // bundle 产物（scripts/build.js 打出的单文件）
  const sea = seaApi();
  return !!(sea && sea.isSea());
}

// Electron 运行态：process.versions.electron 由 Electron 运行时注入，纯 Node 下不存在。
// 判据只读运行时字段、不 require('electron')——common.js 被 CLI 与 GUI 共用，不能依赖 GUI 的依赖。
function isElectron() {
  return !!process.versions.electron;
}

// Electron 打包产物（改名后的应用 exe）；开发态（`electron .`）下 process.defaultApp 为 true 故为假。
// 与 isPackaged() 的关系：两者互斥地描述「是否需要把数据根放到可执行文件旁」。
function isElectronPackaged() {
  return isElectron() && !process.defaultApp;
}

function userDataDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, APP_NAME);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
  }
  const share = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(share, APP_NAME);
}

// 真写一个探针文件判断可写性：Windows 下 accessSync(W_OK) 不看 ACL，不可靠
function isWritableDir(dir) {
  const probe = path.join(dir, `.write-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

let _dataRoot;
function dataRoot() {
  if (_dataRoot) return _dataRoot;
  // 源码态与 Electron 开发态：数据根 = 仓库根（开发时字典、备份、config.json 都在仓库里）
  if (!isPackaged() && !isElectronPackaged()) {
    _dataRoot = REPO_ROOT;
    return _dataRoot;
  }
  // macOS 的 Electron 产物：数据根不取 exe 所在目录——它在 .app 包的 Contents/MacOS 里，
  // 往包内写一个字节就会让签名失效，下次启动被 Gatekeeper 当「已损坏」拒开（macOS 上包内不可写
  // 也不是解法：那样备份与字典会散在只读区）。故恒取用户数据目录；随包内置的字典由 GUI 播种过去。
  if (isElectronPackaged() && process.platform === 'darwin') {
    _dataRoot = userDataDir();
    fs.mkdirSync(_dataRoot, { recursive: true });
    return _dataRoot;
  }
  // 打包态（SEA 产物 / Electron 产物）：数据根 = 可执行文件所在目录。
  // Electron 里 process.execPath 即应用 exe 自身，故同样取 dirname。
  const beside = path.dirname(process.execPath);
  _dataRoot = isWritableDir(beside) ? beside : userDataDir();
  fs.mkdirSync(_dataRoot, { recursive: true });
  return _dataRoot;
}

function getTmpDir() {
  const dir = path.join(dataRoot(), 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 用户配置（打包态与源码态共用）：目前只存手动指定的 resources 目录
function configPath() {
  return path.join(dataRoot(), 'config.json');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  const cfg = { ...readConfig(), ...patch };
  fs.writeFileSync(configPath(), `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return cfg;
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

// 内嵌资源读取（仅打包态）：key 形如 dictionaries/3.6.5/zh-CN.json
function embeddedAsset(key) {
  const sea = seaApi();
  if (!sea || !sea.isSea()) return null;
  try {
    return sea.getAsset(key, 'utf8');
  } catch {
    return null;
  }
}

// 内嵌字典的版本列表（打包时 build.js 把 dictionaries/*/zh-CN.json 全部内嵌）
function embeddedDictVersions() {
  const sea = seaApi();
  if (!sea || !sea.isSea()) return [];
  let keys;
  try {
    keys = sea.getAssetKeys();
  } catch {
    return [];
  }
  const out = [];
  for (const k of keys) {
    const m = /^dictionaries\/([^/]+)\/zh-CN\.json$/.exec(k);
    if (m) out.push(m[1]);
  }
  return out;
}

// 列出可用字典版本：外部目录（数据根/dictionaries/）与内嵌资源合并去重，按版本排序
function listDictVersions() {
  const found = new Set(embeddedDictVersions());
  const dir = path.join(dataRoot(), 'dictionaries');
  if (fs.existsSync(dir)) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'zh-CN.json'))) found.add(e.name);
    }
  }
  return [...found].sort(compareVersions);
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

// —— 平台分段（formatVersion 2 的字典结构，SSOT）——
// 官方只发 Windows 与 macOS 产物；Linux 版由社区维护，其条目在有人提供产物前保持为空。
// 平台名在这里定死三处：段名白名单、process.platform 映射、字典维护脚本的参数校验——
// 后两者都引用本常量，不各写一份。
const PLATFORM_SEGMENTS = ['windows', 'macos', 'linux'];

// 当前运行平台对应的段名。未知平台返回 null——调用方只取 common 段，宽容降级而非抛错
// （在 freebsd 之类平台上读字典不该直接失败）。
function currentPlatform() {
  return { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform] || null;
}

// 条目段名：common 加三个平台段。groups 不是条目段——它只描述分组，不参与替换。
const SEGMENT_NAMES = ['common', ...PLATFORM_SEGMENTS];

// 没被任何组收录的条目的兜底组名。GUI 的组名列与 dict-groups 的推断共用它——
// 字面量在两处各写一份，改一处忘一处就是静默的不一致。
const UNGROUPED = '待分组';

// 拆解一个字典键：作用域键返回 { file: 文件名, key: 去掉前缀的原文 }，
// 全局键返回 { file: null, key: 原键 }。键的两种形态只在这里解析，调用方不再自己碰正则。
function splitScopedKey(k) {
  const m = SCOPED_KEY.exec(k);
  return m ? { file: m[1], key: m[2] } : { file: null, key: k };
}

// 整模板键（以反引号开头、含 ${}）的译文必须是 JS 字符串/模板字面量——首尾引号须一致。
// 返回错误说明，合法时返回 null。
function templateValueProblem(key, value) {
  if (!key.startsWith('`')) return null;
  const q = value[0];
  if ((q !== '`' && q !== '"' && q !== "'") || value[value.length - 1] !== q) {
    return `整模板键 ${key} 的译文必须是 JS 字符串/模板字面量（首尾同为引号或反引号）`;
  }
  return null;
}

// 校验单条条目，非法时抛错。两种格式共用，保证「字典维护脚本」与「运行时读取」口径一致。
// 判整模板键要先用 splitScopedKey 剥掉作用域前缀——`renderer.js|`${t} ${n}s`` 这类
// 带作用域的整模板键，拿原键判断会因开头不是反引号而整条漏检。
function checkEntry(version, key, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`字典条目非法（${version}）：${key} 的译文必须是非空字符串`);
  }
  const problem = templateValueProblem(splitScopedKey(key).key, value);
  if (problem) throw new Error(`字典条目非法（${version}）：${problem}`);
}

// 把 formatVersion 2 的分段字典整理为「原样键 → 译文」的 Map。
// 合并 common ∪ 当前平台段；platform 显式传入时以它为准（CI 里按平台产出字典时用）。
// 键在段间重复属于非法而非「后写入者覆盖」——静默覆盖是分段格式特有的失效模式，
// 会让人以为改对了、实际生效的是另一段。
function buildSegmentedEntries(raw, version, platform) {
  for (const name of [...SEGMENT_NAMES, 'groups']) {
    const seg = raw[name];
    if (seg === null || typeof seg !== 'object' || Array.isArray(seg)) {
      throw new Error(`字典段落非法（${version}）：缺少对象形式的 "${name}" 段`);
    }
  }
  const segs = [...SEGMENT_NAMES];
  const active = platform === undefined ? currentPlatform() : platform;
  const use = active && segs.includes(active) ? ['common', active] : ['common'];

  const entries = new Map();
  const seen = new Map(); // 键 → 首次出现的段名
  for (const name of use) {
    for (const [k, v] of Object.entries(raw[name])) {
      checkEntry(version, k, v);
      const prev = seen.get(k);
      if (prev) {
        throw new Error(
          `字典条目重复（${version}）：${k} 同时出现在 "${prev}" 与 "${name}" 段`
        );
      }
      seen.set(k, name);
      entries.set(k, v);
    }
  }
  return entries;
}

// 把字典原始对象整理为「原样键 → 译文」的 Map，并校验条目合法性。
// 两种格式：
//   formatVersion 2 —— 分段结构（见 buildSegmentedEntries）；
//   无 formatVersion / 为 1 —— 扁平结构，顶层即条目（跳过 _ 开头的元信息键）。
function buildEntries(raw, version, platform) {
  if (raw && raw._meta && raw._meta.formatVersion === 2) {
    return buildSegmentedEntries(raw, version, platform);
  }
  const entries = new Map();
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    checkEntry(version, k, v);
    entries.set(k, v);
  }
  return entries;
}

// 取某文件的生效条目 Map<键, 译文>：全局键 + 作用域指向该文件的键（键名去掉前缀）；
// 指向其他文件的作用域键被跳过。file 省略时返回全部（保留原键名，供统计/报告使用）。
function scopedEntries(entries, file) {
  const out = new Map();
  for (const [k, v] of entries) {
    const { file: scope, key } = splitScopedKey(k);
    if (!scope) {
      out.set(k, v);
    } else if (!file) {
      out.set(k, v);
    } else if (scope === file) {
      out.set(key, v);
    }
  }
  return out;
}

// 远程字典候选地址（按序尝试：权威源 → CDN 兜底 → 镜像兜底）
function remoteDictUrls(version) {
  const rel = `dictionaries/${version}/zh-CN.json`;
  return [`${GH_RAW}/${rel}`, `${GH_CDN}/${rel}`, `${GITEE_RAW}/${rel}`];
}

// 英文排版同样会用到的 Unicode 标点：官方原版里本来就可能存在，不能当「来自汉化」的凭据。
// 实测教训——「…」译文（省略号）单靠「非 ASCII」判据会通过，而官方原版里 11 处省略号
// 并未被汉化，逆替换后全变成 "automatically…"。
// 代价：官方原文是 `The "` 的位置会保留中文弯引号（3.6.6 实测 1 处）。这个代价是刻意付的——
// 若让 `“` 参与还原，一旦它落到双引号字符串里就会把引号提前闭合，语法校验不过、还原被整体拒绝，
// 比留一个弯引号严重得多。
const SHARED_PUNCT = new Set([
  '\u00a0', // 不换行空格
  '\u00b7', // 间隔号
  '\u2013', '\u2014', // 短破折号 / 长破折号
  '\u2018', '\u2019', // 弯单引号
  '\u201c', '\u201d', // 弯双引号
  '\u2022', // 项目符号
  '\u2026', // 省略号
]);

// 「该译文能安全地当逆向键用吗」的判据。译文本身**在官方原版里不会自然出现**才安全——
// 否则拿它当键做逆替换，会误伤原版里本来就有的同名文本（实测 "that " → " " 会让原版
// 所有空格字面量都变成 "that "）。满足其一即可：
//   - 含字母数字（如 "zh-CN"、整模板译文 "`${t} ${n}`"）：原版对应位置是 "en-US" 之类；
//   - 含非 ASCII 且不属于 SHARED_PUNCT（汉字、全角标点）：官方是纯英文界面，不会有这类文本。
// 其余一律排除：空格、ASCII 标点，以及只由通用 Unicode 标点组成的译文（" "、" / "、"…"）。
function isReversible(v) {
  if (/[A-Za-z0-9]/.test(v)) return true;
  for (const ch of v) {
    if (ch > '\x7e' && !SHARED_PUNCT.has(ch)) return true;
  }
  return false;
}

// 构建「译文 → 原文」的逆向条目，供没有备份时按字典还原。
// 返回 { entries, ambiguous, skipped }：
//   entries     译文 → 原文（键为译文原样，与产物里该字面量的 content 逐字符相同）；
//   ambiguous   存在多个原文候选的译文条数；
//   skipped     未参与还原的条目数（纯 ASCII 译文，见下）。
// **逆向键就是译文本身，不做任何加工**：正向替换是把「区间内容」整体换成译文文本——
// 落在字符串字面量里就是引号之间的内容，落在整模板键上就是含两侧反引号的整段源码。
// 两种情况下产物里该区间的 content 都恰好等于译文本体，故按 content 直查即可命中
// （整模板译文含反引号，与无插值模板的整段区间形态一致，见 stringLiterals）。
//
// 同一译文可能对应多个原文（如 Account / Accounts 都译作「账户」），字典本身无从判断某处
// 原本是哪一个——按确定性规则取候选，保证「汉化 → 还原 → 再汉化」往返稳定、不漂移：
//   1) 作用域键优先：它为特定文件而定，比全局键更精确；
//   2) 更短的原文优先：通常是词根形式（Account 优于 Accounts）；
//   3) 先入者优先（字典中的书写顺序），保证结果唯一。
// 纯 ASCII 译文（如 " "、" / "）不参与：它们本身就是原版里到处都有的文本，
// 当作键逆替换会**误伤没被汉化过的位置**——实测 "that " → " " 会让原版所有空格字面量
// 变成 "that "。这类条目列入 skipped，文件对应位置保持原样（多为中性，不影响界面）。
// 判据详见 REVERSIBLE：含非 ASCII 或含字母数字的译文才参与。
// file 省略时收全部（含各文件的作用域键），取舍同 scopedEntries。
function reverseEntries(entries, file) {
  const best = new Map(); // 译文 → { text, scoped }
  const conflicting = new Set();
  let skipped = 0;
  const wins = (next, prev) =>
    next.scoped !== prev.scoped ? next.scoped > prev.scoped : next.text.length < prev.text.length;

  for (const [k, v] of entries) {
    const m = SCOPED_KEY.exec(k);
    if (m && file && m[1] !== file) continue;
    if (!isReversible(v)) {
      if (k !== v) skipped++; // 原文与译文相同的条目跳过也不产生差异
      continue;
    }
    const next = { text: m ? m[2] : k, scoped: m ? 1 : 0 };
    const prev = best.get(v);
    if (!prev) {
      best.set(v, next);
    } else if (prev.text !== next.text) {
      // 原文不同才算歧义；全局键与作用域键指向同一原文属正常共存
      conflicting.add(v);
      if (wins(next, prev)) best.set(v, next);
    }
  }

  return { entries: new Map([...best].map(([v, info]) => [v, info.text])), ambiguous: conflicting.size, skipped };
}

// 字典文件位置：<数据根>/dictionaries/<版本>/zh-CN.json
function dictFile(version) {
  return path.join(dataRoot(), 'dictionaries', version, 'zh-CN.json');
}

// 内嵌资源键（打包态）
function dictAssetKey(version) {
  return `dictionaries/${version}/zh-CN.json`;
}

// 字典来源：外部文件优先，其次打包内嵌资源；label 供日志展示「这份字典从哪来」
function readDictSource(version) {
  const file = dictFile(version);
  if (fs.existsSync(file)) return { text: fs.readFileSync(file, 'utf8'), label: file };
  const embedded = embeddedAsset(dictAssetKey(version));
  if (embedded !== null) return { text: embedded, label: `内嵌字典 ${dictAssetKey(version)}` };
  throw new Error(`字典不存在：${version}（已查找 ${file} 与内嵌资源）`);
}

// 是否存在该版本的内嵌字典（打包态为真；源码态恒为假）
function hasEmbeddedDict(version) {
  return embeddedAsset(dictAssetKey(version)) !== null;
}

// 字典来源的可读标签（不解析 JSON，供脚本日志用）
function dictLabel(version) {
  const file = dictFile(version);
  return fs.existsSync(file) ? file : `内嵌字典 ${dictAssetKey(version)}`;
}

// 读取字典：外部文件或内嵌资源，跳过 _ 开头的元信息键。
// platform 省略时取当前运行平台对应的条目段（见 buildEntries）。
function loadDict(version, platform) {
  const { text, label } = readDictSource(version);
  const raw = JSON.parse(text);
  const entries = buildEntries(raw, version, platform);
  if (entries.size === 0) throw new Error(`字典为空：${label}`);
  return entries;
}

// groups 段（「组名 → 键数组」的正排，便于整组重建与人工阅读）翻成「键 → 组名」反查表。
// 消费方要的都是反查，转换只此一处——GUI 的组名列与 CI 的分组统计都走它，各写一遍必然漂移。
// 同键落在两个组里时取首见：分组不参与替换，不值得为它抛错中断读取。
function reverseGroups(seg) {
  const groups = new Map();
  if (!seg || typeof seg !== 'object' || Array.isArray(seg)) return groups;
  for (const [group, keys] of Object.entries(seg)) {
    if (!Array.isArray(keys)) continue;
    for (const k of keys) if (!groups.has(k)) groups.set(k, group);
  }
  return groups;
}

// 读取字典的组名（键 → 组名）。段里的键就是字典的原样键（含作用域前缀），查表时不要剥前缀。
// 旧扁平格式没有 groups 段，返回空 Map 而非报错——分组只是参考，不该拦住宿主字典的读取。
function loadGroups(version) {
  const { text } = readDictSource(version);
  const raw = JSON.parse(text);
  return reverseGroups(raw && raw._meta && raw._meta.formatVersion === 2 ? raw.groups : null);
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

// 是否已汉化：备份存在，且当前产物与备份不完全一致（逐字节比较）
function isPatched(appDir, version) {
  if (!backupExists(version)) return false;
  const backup = backupDir(version);
  return ['main.js', 'renderer.js'].some((f) => {
    const b = path.join(backup, f);
    const cur = path.join(appDir, f);
    return fs.existsSync(b) && fs.existsSync(cur) && !fs.readFileSync(b).equals(fs.readFileSync(cur));
  });
}

// —— 补丁组记账 ——
// 补丁分两组：i18n（文案替换）与 updateControl（更新管控注入）。记账文件记下「对哪个版本
// 应用了哪几组」，还原时按组执行——只撤某一组时，从官方原文备份重新应用剩下的组即可。
// **备份因此始终只有一份（官方原文）**：按组还原不能靠「每组各存一份备份」，那样每加一组
// 就多一份中间态，版本一多就没法收拾，而且「当前产物到底是哪几组的叠加」也说不清。
const PATCH_GROUPS = ['i18n', 'updateControl'];
const PATCH_GROUP_LABELS = { i18n: '汉化', updateControl: '更新管控' };

function patchStatePath() {
  return path.join(getTmpDir(), 'patch-state.json');
}

function readPatchState() {
  try {
    const raw = JSON.parse(fs.readFileSync(patchStatePath(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {}; // 不存在或损坏都当空账——它只是记账，丢了顶多退化成「按备份整体还原」
  }
}

// 记录某版本已应用的补丁组。groups 是**全集**（覆盖写），不是增量——调用方拼好再传。
// 传空数组即销账（该版本已回到官方原版）。
function setPatchGroups(version, groups) {
  const state = readPatchState();
  const clean = [...new Set(groups)].filter((g) => PATCH_GROUPS.includes(g));
  if (clean.length === 0) delete state[version];
  else state[version] = { groups: clean, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(patchStatePath()), { recursive: true });
  fs.writeFileSync(patchStatePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return clean;
}

function getPatchGroups(version) {
  const entry = readPatchState()[version];
  return entry && Array.isArray(entry.groups) ? entry.groups : [];
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

// 提取 JS 源码中的可替换区间，返回 [{ start, end, content, template, inTemplate }]：
//   - 字符串字面量内容区间（不含引号），template=false；
//   - 模板字符串**整体**区间（含两侧反引号），template=true——整模板键按它匹配。
//     含插值与否都收集：只收集含插值的会让「译文变成无插值模板」的条目在还原时失配
//     （成品里只剩文本段，含反引号的原文塞回文本段会提前闭合反引号，产生语法错误）。
//   - inTemplate 标出该区间的文本来自模板（整段区间与其内部的文本段），供上游区分
//     「模板文本段」与「引号字符串」——两者 content 可能相同，但所属容器不同。
// 替换只应发生在这些区间内，避免误伤标识符/属性名/正则/注释。
// 递归处理：模板插值内是完整代码（含嵌套字符串/模板/正则/注释/花括号），其中的字符串与模板不收集
// （插值内是代码，替换单段文本会破坏逻辑；需要替换插值内整段文本时按整模板键处理外层模板）。
function stringLiterals(src) {
  const out = [];
  const n = src.length;
  const push = (start, end, inTemplate = false) => {
    if (end > start) out.push({ start, end, content: src.slice(start, end), template: false, inTemplate });
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
  // 整段区间（含两侧反引号）一律收集，供整模板键按整段匹配。
  function scanTemplate(i, collect) {
    const tStart = i;
    let j = i + 1;
    let segStart = j;
    while (j < n) {
      if (src[j] === '\\') j += 2;
      else if (src[j] === '`') {
        if (collect) {
          push(segStart, j, true);
          out.push({
            start: tStart, end: j + 1, content: src.slice(tStart, j + 1), template: true, inTemplate: true,
          });
        }
        return j + 1;
      } else if (src[j] === '$' && src[j + 1] === '{') {
        if (collect) push(segStart, j, true);
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

// 语法校验：用 vm.Script 按脚本模式解析，只解析不执行（等价于 node --check）。
// 不用 `node --check` 子进程：打包态下 process.execPath 是产物自身，不具备该参数。
// 接收源码文本而非路径——调用方可以在落盘之前先校验。
function checkSyntax(source, file = '<string>') {
  try {
    new vm.Script(source, { filename: file });
    return { ok: true, output: '' };
  } catch (e) {
    return { ok: false, output: String(e.message || e) };
  }
}

module.exports = {
  REPO_ROOT,
  APP_NAME,
  getTmpDir,
  dataRoot,
  isPackaged,
  isElectron,
  isElectronPackaged,
  configPath,
  readConfig,
  writeConfig,
  locateApp,
  readVersion,
  listDictVersions,
  loadDict,
  loadGroups,
  reverseGroups,
  UNGROUPED,
  dictLabel,
  dictFile,
  backupDir,
  backupAppFiles,
  backupExists,
  isPatched,
  PATCH_GROUPS,
  PATCH_GROUP_LABELS,
  patchStatePath,
  readPatchState,
  setPatchGroups,
  getPatchGroups,
  stringLiterals,
  applyDictInStrings,
  checkSyntax,
  buildEntries,
  scopedEntries,
  splitScopedKey,
  reverseEntries,
  remoteDictUrls,
  hasEmbeddedDict,
  compareVersions,
  PLATFORM_SEGMENTS,
  SEGMENT_NAMES,
  currentPlatform,
  templateValueProblem,
  checkEntry,
  GH_API,
  GH_OWNER,
  GH_REPO,
  GH_RAW,
  GITEE_RAW,
  GITEE_API,
};
