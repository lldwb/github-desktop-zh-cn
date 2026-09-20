// patch（scripts/cmd/patch.js）编排层契约测试：run() 的参数 → 返回结构与写盘副作用。
//
// 只经导出的 run() 直测（CLI 的 main() 只做参数解析与打印，run 是命令行与交互式菜单共用的
// 执行入口，也是 GUI IPC 走的那条路）。断言落在「输入 → 返回值 / 文件系统副作用」上，
// 不掺内部调用。
//
// 隔离与安全（零联网 / 零重启 / 不碰真实安装）：
//   - 一律传 noRestart: true（或 dryRun: true）：本机装着真实 GitHub Desktop，绝不允许测试触发
//     真实重启；返回值里 restarted === 'skipped' 正是「没有重启」这一契约的外在表现；
//   - 安装目录用 mkdtemp 在系统临时目录现造（resources/app/…，与真实安装同形），
//     restartApp 在其中找不到 GitHubDesktop.exe，判定「没在运行」；
//   - 字典夹具按 test/fixtures/scratch.js 的约定落在 dictionaries/0.0.0-patch/（非版本形态，
//     并行测试互不可见），且在 run() 之前落盘——ensureDict 走「本地已有」分支，全程零联网。
// 备份落在数据根的 tmp/backup/<夹具版本>/（生产 SSOT 路径），用例前后都清这个专属目录，
// 绝不触碰真实版本（如 3.6.6）的备份。
//
// 记账隔离：真跑（非 dryRun）会写数据根的 tmp/patch-state.json——它是所有进程共享的文件，
// 而 node --test 各测试文件并行跑，「读改写」交错理论上可互相覆盖（丢真实版本的记账）。
// 故写它的用例统一走 withPatchState：跨进程互斥锁 + 用例前后快照恢复，测试结束零残留、
// 真实数据原封不动（readPatchState 对丢失/损坏一律当空账，故保守处理是必要的）。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const common = require('../../scripts/common');
const patch = require('../../scripts/cmd/patch');
const contextMenu = require('../../scripts/inject/context-menu');
const updateControl = require('../../scripts/inject/update-control');
const scratch = require('../fixtures/scratch');

// 本文件专属的夹具版本名（与 verify / restore 的测试目录互不撞车，非三段数字形态）
const VERSION = '0.0.0-patch';

// 官方产物的最小合成替身：几个字符串字面量供字典命中（普通键、作用域键、整模板键三种形态），
// 末尾的 sourceMappingURL 注释是两个注入器的真实锚点。
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

// 带更新管控锚点的产物：`async checkForUpdates(` 要求全文件唯一（方法闸门插在它后面第一个
// '{' 之后，见 scripts/inject/update-control.js）
const MAIN_UPD = [
  'class Updater {',
  '  async checkForUpdates(a) { return a }',
  '}',
  'console.log("Welcome to GitHub Desktop");',
  '',
  '//# sourceMappingURL=main.js.map',
  '',
].join('\n');

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
// 不造 GitHubDesktop.exe——restartApp 找不到目标可执行体，判定「没在运行」。
function makeApp({ main = MAIN_EN, renderer = RENDERER_EN, pkgVersion = VERSION } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghd-patch-'));
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
  return {
    root,
    resourcesDir,
    appDir,
    mainPath: path.join(appDir, 'main.js'),
    rendererPath: path.join(appDir, 'renderer.js'),
  };
}

// 用例的前后清理 + 备好本地字典（幂等；scratch 删除带门禁）
function prepare(t, app) {
  scratch.cleanup(VERSION);
  fs.rmSync(common.backupDir(VERSION), { recursive: true, force: true });
  scratch.isolate(t, VERSION);
  t.after(() => fs.rmSync(common.backupDir(VERSION), { recursive: true, force: true }));
  t.after(() => fs.rmSync(app.root, { recursive: true, force: true }));
  writeDict();
}

// patch-state.json 是数据根下所有进程共享的记账文件。node --test 的各测试文件是并行子进程，
// patch / restore 的 run() 都会对它「读改写」，交错时互相覆盖（生产代码的写是非原子的，
// readPatchState 读到半截 JSON 会当空账——丢真实版本的记账）。写它的用例统一走本函数：
//   1. 跨进程互斥（锁文件在系统临时目录，独占创建即持有；持有者崩溃没释放时按 mtime 接管）；
//   2. 进入前快照、退出后原样恢复——夹具的记账不残留，真实数据原封不动。
const PATCH_STATE_LOCK = path.join(os.tmpdir(), 'ghd-cmd-tests.lock');

async function withPatchState(fn) {
  for (let i = 0; ; i++) {
    try {
      fs.closeSync(fs.openSync(PATCH_STATE_LOCK, 'wx'));
      break;
    } catch {
      if (i >= 240) throw new Error('等待 patch-state 测试锁超时（约 12s）');
      // 陈旧锁兜底：上次进程被硬杀没释放时，按 mtime 判定超过 15s 即接管
      try {
        if (Date.now() - fs.statSync(PATCH_STATE_LOCK).mtimeMs > 15000) fs.rmSync(PATCH_STATE_LOCK, { force: true });
      } catch { /* 锁恰被释放，下一轮独占创建即成功 */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const raw = fs.existsSync(common.patchStatePath())
    ? fs.readFileSync(common.patchStatePath(), 'utf8')
    : null;
  try {
    return await fn();
  } finally {
    try {
      if (raw === null) fs.rmSync(common.patchStatePath(), { force: true });
      else fs.writeFileSync(common.patchStatePath(), raw, 'utf8');
    } finally {
      fs.rmSync(PATCH_STATE_LOCK, { force: true });
    }
  }
}

// ============================ 正向 ============================

test('dryRun：统计命中与返回结构，不写盘也不备份', async (t) => {
  const app = makeApp();
  prepare(t, app);

  const r = await patch.run({
    version: VERSION,
    explicitPath: app.resourcesDir,
    dryRun: true,
    quiet: true,
  });

  assert.strictEqual(r.version, VERSION);
  assert.strictEqual(r.dryRun, true);
  assert.strictEqual(r.total, 5); // main 3（普通键×3）+ renderer 2（作用域键值 + 整模板键）
  assert.strictEqual(r.downloaded, false, '本地已有字典，不该联网下载');
  assert.strictEqual(r.restarted, 'skipped');
  assert.strictEqual(r.updateControl, null);
  assert.strictEqual(r.app.version, VERSION);

  // 文件逐字节不变（干跑也注入右键菜单，但只在内存里）
  assert.strictEqual(fs.readFileSync(app.mainPath, 'utf8'), MAIN_EN);
  assert.strictEqual(fs.readFileSync(app.rendererPath, 'utf8'), RENDERER_EN);
  assert.strictEqual(common.backupExists(VERSION), false, 'dry-run 不该建备份');
});

test('正式汉化：字面量整串替换、右键菜单注入、先备份后写回，restarted=skipped', async (t) => {
  const app = makeApp();
  prepare(t, app);

  const r = await withPatchState(() =>
    patch.run({
      version: VERSION,
      explicitPath: app.resourcesDir,
      noRestart: true,
      quiet: true,
    })
  );

  assert.strictEqual(r.dryRun, false);
  assert.strictEqual(r.total, 5);
  assert.strictEqual(r.downloaded, false);
  assert.strictEqual(r.restarted, 'skipped');
  assert.strictEqual(r.updateControl, null);

  const main = fs.readFileSync(app.mainPath, 'utf8');
  assert.ok(main.includes(contextMenu.BEGIN), 'main.js 应注入右键菜单块');
  assert.ok(main.includes("var title = '偏好设置';"), main);
  assert.ok(main.includes("var menu = { label: '检查更新' };"), main);
  assert.ok(main.includes('console.log("欢迎使用 GitHub Desktop");'), main);
  assert.ok(!main.includes("'Preferences'"), '原文键应已被替换');
  // 作用域键 renderer.js|Delete 只对 renderer.js 生效：main.js 的 'Delete' 保持英文
  assert.ok(main.includes("console.log('Delete');"), '作用域键不该动 main.js 的 Delete');

  const renderer = fs.readFileSync(app.rendererPath, 'utf8');
  assert.ok(renderer.includes("var keys = { Delete: '删除' };"), '字面量值被换、属性名保持');
  assert.ok(renderer.includes('console.log(`${n} 个文件`);'), '整模板键按整段替换');
  assert.ok(!renderer.includes("'Delete'"), "renderer.js 的 'Delete' 字面量应已替换");

  // 备份 = 写回之前的官方原文（逐字节）
  assert.strictEqual(common.backupExists(VERSION), true);
  assert.strictEqual(fs.readFileSync(path.join(common.backupDir(VERSION), 'main.js'), 'utf8'), MAIN_EN);
  assert.strictEqual(
    fs.readFileSync(path.join(common.backupDir(VERSION), 'renderer.js'), 'utf8'),
    RENDERER_EN
  );
});

test('updateControl=guard：checkForUpdates 方法体注入闸门，返回值带模式', async (t) => {
  const app = makeApp({ main: MAIN_UPD });
  prepare(t, app);

  const r = await withPatchState(() =>
    patch.run({
      version: VERSION,
      explicitPath: app.resourcesDir,
      noRestart: true,
      updateControl: 'guard',
      quiet: true,
    })
  );

  assert.strictEqual(r.updateControl, 'guard');
  assert.strictEqual(r.total, 3); // main 1 + renderer 2

  const main = fs.readFileSync(app.mainPath, 'utf8');
  assert.ok(main.includes(updateControl.BEGIN), '应注入更新管控块');
  assert.ok(main.includes('if(!globalThis.__gdzcAllowUpdate())return;'), '方法体开头应有闸门');
  assert.ok(main.includes(contextMenu.BEGIN), '右键菜单块与更新管控块共存');
  // 写进产物的代码必须是合法 JS
  assert.deepStrictEqual(common.checkSyntax(main, 'main.js'), { ok: true, output: '' });
});

// ============================ 异常 ============================

test('版本错配：抛 exitCode=2 的错误（契约：patch 的错配退出码是 2，其余才是 1）', async (t) => {
  const app = makeApp({ pkgVersion: '9.9.9' });
  prepare(t, app);

  await assert.rejects(
    patch.run({ version: VERSION, explicitPath: app.resourcesDir, quiet: true }),
    (e) => {
      assert.match(e.message, /版本不一致/);
      assert.match(e.message, /9\.9\.9/);
      assert.strictEqual(e.exitCode, 2);
      assert.ok(e.hint, '应带可操作的提示（CLI 会打印它）');
      return true;
    }
  );
});

test('指定目录缺文件：locateApp 报错（发生在联网取字典之前）', async (t) => {
  const app = makeApp();
  prepare(t, app);
  fs.rmSync(app.mainPath);

  await assert.rejects(
    patch.run({ version: VERSION, explicitPath: app.resourcesDir, quiet: true }),
    /指定目录不是有效的 GitHub Desktop 资源目录/
  );
});

// ============================ 边界 ============================

test('0 命中：字典与产物零交集 → total=0，renderer 原样、main 只多注入块', async (t) => {
  const main = 'var config = { mode: "production" };\nconsole.log("ready");\n\n//# sourceMappingURL=main.js.map\n';
  const renderer = 'var api = { endpoint: "/status" };\n';
  const app = makeApp({ main, renderer });
  prepare(t, app);

  const r = await withPatchState(() =>
    patch.run({
      version: VERSION,
      explicitPath: app.resourcesDir,
      noRestart: true,
      quiet: true,
    })
  );

  assert.strictEqual(r.total, 0);
  // renderer 无命中、无注入：逐字节不变
  assert.strictEqual(fs.readFileSync(app.rendererPath, 'utf8'), renderer);
  // main 的命中为零，但右键菜单块照注入（这是编排行为）；摘掉块后与原文逐字节相同
  const patched = fs.readFileSync(app.mainPath, 'utf8');
  const range = contextMenu.blockRange(patched);
  assert.ok(range, 'main.js 应有右键菜单注入块');
  assert.strictEqual(
    patched.slice(0, range.start) + patched.slice(range.end),
    main,
    '除注入块外原文逐字节不变'
  );
});
