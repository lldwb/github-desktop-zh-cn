// verify（scripts/cmd/verify.js）编排层契约测试：版本一致性 / 字典命中率 / 语法校验的输入 → 输出。
//
// verify 是「加载即执行」的脚本（无导出，见 docs/agents/已知坑.md 打包态一节），所以用子进程跑
// 真 CLI 入口（spawn(process.execPath, [verify.js, --path, fixture, ...])），断言 stdout / stderr /
// exitCode——这正是 CLI 的对外契约面：重构不许改这些输出行与退出码。
//
// 隔离与安全（零联网 / 零重启 / 不碰真实安装）：
//   - 安装目录用 mkdtemp 在系统临时目录现造（resources/app/{main.js, renderer.js, package.json}），
//     verify 全程只读，不会写到本机真实 GitHub Desktop；
//   - 字典夹具按 test/fixtures/scratch.js 的约定落在 dictionaries/<夹具版本>/，版本名刻意不是
//     X.Y.Z 形态——common.DICT_VERSION_RE 不把它当真实版本，并行的其他测试文件按形态过滤即可
//     忽略它的存在窗口（见 docs/agents/已知坑.md「并行夹具互扰」条）；
//   - 夹具字典在 spawn 之前落盘，verify 读的是本地文件，全程零联网。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const common = require('../../scripts/common');
const contextMenu = require('../../scripts/inject/context-menu');
const scratch = require('../fixtures/scratch');

// 本文件专属的夹具版本名：与 test/dict/**（0.0.0-test）、patch / restore 的测试各自独立成目录，
// tmp/backup/<版本>/ 的备份判定 likewise 互不干扰；名字非三段数字形态，不会进任何版本列表。
const VERSION = '0.0.0-verify';
const VERIFY_JS = path.resolve(__dirname, '../../scripts/cmd/verify.js');

// 官方产物的最小合成替身：几个字符串字面量供字典命中（普通键、作用域键、整模板键三种形态），
// 末尾的 sourceMappingURL 注释是两个注入器的真实锚点（见 test/inject/context-menu.test.js 的同款造法）。
const MAIN_EN = [
  ';(function () {',
  "  var title = 'Preferences';",
  "  var menu = { label: 'Check for Updates' };",
  '  console.log("Welcome to GitHub Desktop");',
  "  console.log('Delete');",
  '})();',
  '',
  '//# sourceMappingURL=main.js.map',
  '',
].join('\n');

const RENDERER_EN = [
  ';(function () {',
  "  var keys = { Delete: 'Delete' };",
  '  var n = 1;',
  '  console.log(`${n} file`);',
  '})();',
  '',
].join('\n');

// 汉化后的形态：普通键整串换译文；作用域键 renderer.js|Delete 只动 renderer.js（main.js 的
// 'Delete' 保持英文，这正是作用域键的契约）。
const RENDERER_ZH = [
  ';(function () {',
  "  var keys = { Delete: '删除' };",
  '  var n = 1;',
  '  console.log(`${n} 个文件`);',
  '})();',
  '',
].join('\n');

// 半汉化：Preferences 残留英文——verify「已汉化」口径报的就是这类未替换到的条目。
const MAIN_HALF = [
  ';(function () {',
  "  var title = 'Preferences';",
  "  var menu = { label: '检查更新' };",
  '  console.log("欢迎使用 GitHub Desktop");',
  "  console.log('Delete');",
  '})();',
  '',
  '//# sourceMappingURL=main.js.map',
  '',
].join('\n');

// 夹具字典：formatVersion 2 分段结构，条目全放 common 段（三个平台的 runner 上口径一致）
function writeDict() {
  const file = common.dictFile(VERSION);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        _meta: { version: VERSION, formatVersion: 2 },
        common: {
          'Welcome to GitHub Desktop': '欢迎使用 GitHub Desktop',
          Preferences: '偏好设置',
          'Check for Updates': '检查更新',
          'renderer.js|Delete': '删除',
          '`${n} file`': '`${n} 个文件`',
        },
        windows: {},
        macos: {},
        linux: {},
        groups: {},
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

// 造一个安装目录：resources/app/{main.js, renderer.js, package.json}（locateApp 认得的那三个），
// 不造 GitHubDesktop.exe——本文件只跑 verify（只读），不涉及重启。
function makeApp({ main = MAIN_EN, renderer = RENDERER_EN, pkgVersion = VERSION } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghd-verify-'));
  const resourcesDir = path.join(root, 'app-fixture', 'resources');
  const appDir = path.join(resourcesDir, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'main.js'), main, 'utf8');
  fs.writeFileSync(path.join(appDir, 'renderer.js'), renderer, 'utf8');
  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify({ name: 'github-desktop', version: pkgVersion }),
    'utf8'
  );
  return { root, resourcesDir, appDir };
}

// 用例的前后清理 + 备好本地字典：字典与备份的残留先清一遍（幂等，防上次异常退出留下），
// 结束后再清——断言失败也不会把夹具留在仓库里（scratch 约定，删除带门禁）。
function prepare(t, app) {
  scratch.cleanup(VERSION);
  fs.rmSync(common.backupDir(VERSION), { recursive: true, force: true });
  scratch.isolate(t, VERSION);
  t.after(() => fs.rmSync(common.backupDir(VERSION), { recursive: true, force: true }));
  t.after(() => fs.rmSync(app.root, { recursive: true, force: true }));
  writeDict();
}

// 跑真 CLI 入口（子进程），args 即命令行参数
function runVerify(args) {
  return spawnSync(process.execPath, [VERIFY_JS, ...args], {
    encoding: 'utf8',
    timeout: 30000,
  });
}

// ============================ 未汉化产物 ============================

test('未汉化产物：版本一致、逐文件命中数、语法结论，退出码 0', (t) => {
  const app = makeApp();
  prepare(t, app);

  const r = runVerify(['--path', app.resourcesDir, '--version', VERSION]);
  assert.strictEqual(r.error, undefined);
  assert.strictEqual(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.ok(r.stdout.includes(`版本一致性：字典 ${VERSION} = 安装 ${VERSION} ✓`));
  // main 命中 3（两个普通键 + 双引号键），renderer 命中 2（作用域键值 + 整模板键）
  assert.ok(r.stdout.includes('main.js：命中 3 处'), r.stdout);
  assert.ok(r.stdout.includes('renderer.js：命中 2 处'), r.stdout);
  // 夹具没有注入块：走「未注入」提示行
  assert.ok(r.stdout.includes('右键菜单代码：未注入'));
  assert.ok(r.stdout.includes('未汉化：两个文件均 0 命中的条目 0/5 条'), r.stdout);
  assert.ok(r.stdout.includes('语法校验 main.js：通过 ✓'));
  assert.ok(r.stdout.includes('语法校验 renderer.js：通过 ✓'));
  assert.ok(r.stdout.includes('校验通过。'));
});

// ============================ 已汉化产物 ============================

test('已汉化产物：报仍残留英文的条目清单，右键菜单块在场', (t) => {
  const app = makeApp({
    main: contextMenu.inject(MAIN_HALF, { darwin: process.platform === 'darwin' }).content,
    renderer: RENDERER_ZH,
  });
  prepare(t, app);
  // 「已汉化」的判定依据是备份在场且与当前文件不同：备份放官方原文
  fs.mkdirSync(common.backupDir(VERSION), { recursive: true });
  fs.writeFileSync(path.join(common.backupDir(VERSION), 'main.js'), MAIN_EN, 'utf8');
  fs.writeFileSync(path.join(common.backupDir(VERSION), 'renderer.js'), RENDERER_EN, 'utf8');

  const r = runVerify(['--path', app.resourcesDir, '--version', VERSION]);
  assert.strictEqual(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  // 残留清单：5 键里只有 Preferences 还以英文留在产物里
  assert.ok(r.stdout.includes('已汉化：仍残留英文的条目 1/5 条'), r.stdout);
  assert.ok(r.stdout.includes('    - Preferences'), r.stdout);
  assert.ok(r.stdout.includes('右键菜单代码：已注入'), r.stdout);
});

// ============================ 异常 ============================

test('版本错配：字典与安装版本不一致 → ✗ 且退出码 1', (t) => {
  const app = makeApp({ pkgVersion: '0.0.0-mismatch' });
  prepare(t, app);

  const r = runVerify(['--path', app.resourcesDir, '--version', VERSION]);
  assert.strictEqual(r.status, 1);
  assert.ok(r.stderr.includes(`版本一致性：字典 ${VERSION} ≠ 安装 0.0.0-mismatch ✗`), r.stderr);
  assert.ok(r.stderr.includes('校验未通过'), r.stderr);
});

test('缺文件：--path 指向缺 renderer.js 的目录 → 报错退出 1', (t) => {
  const app = makeApp();
  prepare(t, app);
  fs.rmSync(path.join(app.appDir, 'renderer.js'));

  const r = runVerify(['--path', app.resourcesDir, '--version', VERSION]);
  assert.strictEqual(r.status, 1);
  assert.ok(r.stderr.includes('指定目录不是有效的 GitHub Desktop 资源目录'), r.stderr);
  assert.ok(r.stderr.includes('app/renderer.js'), r.stderr);
});

test('坏产物：补丁后语法不过 → 语法校验失败行 + 退出码 1', (t) => {
  const app = makeApp({ main: 'var 1 = ;\n' });
  prepare(t, app);

  const r = runVerify(['--path', app.resourcesDir, '--version', VERSION]);
  assert.strictEqual(r.status, 1);
  assert.ok(r.stderr.includes('语法校验 main.js：失败 ✗'), r.stderr);
});

test('未知参数：报错退出 1（其余错误一律按 1，patch 的版本错配才是 2）', (t) => {
  const app = makeApp();
  prepare(t, app);

  const r = runVerify(['--path', app.resourcesDir, '--bogus']);
  assert.strictEqual(r.status, 1);
  assert.ok(r.stderr.includes('未知参数'), r.stderr);
});

// ============================ 边界 ============================

test('0 命中：产物里没有字典键 → 0 命中清单格式，退出码 0', (t) => {
  const app = makeApp({
    main: 'var config = { mode: "production", retries: 3 };\nconsole.log("ready");\n',
    renderer: 'var api = { endpoint: "/status" };\n',
  });
  prepare(t, app);

  const r = runVerify(['--path', app.resourcesDir, '--version', VERSION]);
  assert.strictEqual(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.ok(r.stdout.includes('main.js：命中 0 处'));
  assert.ok(r.stdout.includes('renderer.js：命中 0 处'));
  assert.ok(r.stdout.includes('未汉化：两个文件均 0 命中的条目 5/5 条'), r.stdout);
  // 0 命中清单逐条列出（这正是「字典可能与版本不符」的提示口径，行格式冻结）
  for (const k of [
    'Welcome to GitHub Desktop',
    'Preferences',
    'Check for Updates',
    'Delete',
    '`${n} file`',
  ]) {
    assert.ok(r.stdout.includes(`    - ${k}`), `清单里应有：${k}\n${r.stdout}`);
  }
});
