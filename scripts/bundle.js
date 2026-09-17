// bundle.js — 零依赖的 CommonJS 单文件打包器
// 用途：把 scripts/ 下的模块合成一个自包含 .js，供 build.js 打成单文件可执行（SEA）。
// 边界：只处理本仓库的用法——相对 require 走模块表，内建模块（fs / path / os / readline / node:sea…）原样透传；
//       不做 tree-shaking / 压缩 / 转译。模块 id 用「相对仓库根的正斜杠路径」，不把构建机绝对路径写进产物。
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

// 模块 id：相对仓库根、正斜杠分隔（如 scripts/common.js）
function moduleId(absPath) {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
}

// 解析相对 require 目标（补 .js / index.js 后缀）
function resolveDep(fromAbs, spec) {
  const base = path.resolve(path.dirname(fromAbs), spec);
  for (const cand of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  throw new Error(`${moduleId(fromAbs)} 中无法解析依赖：${spec}`);
}

// 收集模块图：id → { source, deps: { require 字面量 → 模块 id } }
function collect(entryAbs) {
  const mods = new Map();
  const visit = (abs) => {
    const id = moduleId(abs);
    if (mods.has(id)) return id;
    const raw = fs.readFileSync(abs, 'utf8');
    // JSON 模块（如 package.json）转成 module.exports 赋值：JSON 是 JS 字面量的子集
    const source = abs.endsWith('.json') ? `module.exports = ${raw.trim()};` : raw;
    const entry = { source, deps: {} };
    mods.set(id, entry); // 先占位：循环依赖时不至于无限递归
    for (const m of source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      entry.deps[m[1]] = visit(resolveDep(abs, m[1]));
    }
    return id;
  };
  return { entryId: visit(entryAbs), mods };
}

// 生成单文件源码
function generate({ entryId, mods }) {
  const out = [];
  out.push('// 由 scripts/bundle.js 从 scripts/ 下的源文件生成，请勿手工修改');
  out.push("'use strict';");
  // 标记「这是打包产物」：common.isPackaged() 据此把数据根目录定为可执行文件所在目录
  out.push('globalThis.__BUNDLED__ = true;');
  out.push("const __path = require('path');");
  out.push('const __mods = Object.create(null);');
  out.push('const __cache = Object.create(null);');
  out.push('function __def(id, deps, fn) { __mods[id] = { deps, fn }; }');
  // 打包态下模块的 __dirname / __filename 统一指向可执行文件位置：
  // 源码里的 path.resolve(__dirname, '..') 之类不会随运行目录（cwd）漂移。
  out.push(`const __base = __path.dirname(process.execPath);`);
  out.push('let __mainMod = null;');
  out.push(`function __load(id, isEntry) {
  if (__cache[id]) return __cache[id].exports;
  const mod = { exports: {} };
  __cache[id] = mod;
  if (isEntry) __mainMod = mod;
  const rec = __mods[id];
  if (!rec) throw new Error('未打包的模块：' + id);
  const req = (spec) => {
    if (spec.startsWith('.')) {
      const target = rec.deps[spec];
      if (!target) throw new Error('未打包的依赖：' + spec + '（来自 ' + id + '）');
      return __load(target);
    }
    return require(spec); // 内建模块
  };
  // 复刻 Node 的 require.main：入口模块据此判断「我是被直接运行的」，
  // 源码里的 if (require.main === module) main() 在打包态同样成立
  req.main = __mainMod;
  rec.fn(mod, mod.exports, req, process.execPath, __base);
  return mod.exports;
}`);

  for (const [id, { source, deps }] of mods) {
    out.push(
      `__def(${JSON.stringify(id)}, ${JSON.stringify(deps)}, function (module, exports, require, __filename, __dirname) {\n${source}\n});`
    );
  }
  out.push(`__load(${JSON.stringify(entryId)}, true);`);
  return `${out.join('\n')}\n`;
}

// 打包入口脚本，返回生成的单文件源码
function bundle(entryAbs) {
  return generate(collect(entryAbs));
}

module.exports = { bundle };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const outFile = outIdx >= 0 ? argv[outIdx + 1] : null;
  // 排除 --out 的取值，剩下的第一个非选项参数才是入口
  const entry = argv.find((a, i) => !a.startsWith('--') && i !== outIdx + 1) || path.join(__dirname, 'cli.js');
  const code = bundle(path.resolve(entry));
  if (outFile) {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(path.resolve(outFile), code, 'utf8');
    console.log(`已生成 ${outFile}（${Buffer.byteLength(code)} 字节）`);
  } else {
    process.stdout.write(code);
  }
}
