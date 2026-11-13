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
//   - 替换逻辑档案（patch.json）同样落在该夹具目录，由 test/fixtures/profile.js 生成：
//     引擎要求「字典 + 档案」成对，缺档案/锚点不符/未知策略都必须明确拒绝（见「档案」一节）。
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
const versionProfile = require('../../scripts/version-profile');
const contextMenu = require('../../scripts/inject/context-menu');
const updateControl = require('../../scripts/inject/update-control');
const scratch = require('../fixtures/scratch');
const profileFixture = require('../fixtures/profile');

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

// 用例的前后清理 + 备好本地字典与替换逻辑档案（幂等；scratch 删除带门禁）。
// profileOptions 传给 test/fixtures/profile.js 的 make：需要更新管控的用例传 { updateControl: true }，
// 需要证明「参数来自档案」的用例传自定义 marker / labels。
function prepare(t, app, profileOptions = {}) {
  scratch.cleanup(VERSION);
  fs.rmSync(common.backupDir(VERSION), { recursive: true, force: true });
  scratch.isolate(t, VERSION);
  t.after(() => fs.rmSync(common.backupDir(VERSION), { recursive: true, force: true }));
  t.after(() => fs.rmSync(app.root, { recursive: true, force: true }));
  writeDict();
  profileFixture.write(VERSION, profileOptions);
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
  // 更新管控的锚点来自该版本档案，夹具档案要显式声明并启用它
  prepare(t, app, { updateControl: true });

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

// ============================ 档案（dictionaries/<版本>/patch.json） ============================
// 替换逻辑档案把「版本相关的替换逻辑」从代码搬进数据。引擎的拒绝语义必须钉死：缺档案、
// 锚点 0/2 次、未知策略、请求了档案里未启用的策略——一律**明确失败**，且失败发生在写盘之前
// （不留下「文案改了一半」的中间态）。

test('缺档案：联网与写盘之前拒绝，错误带可执行的下一步', async (t) => {
  const app = makeApp();
  prepare(t, app);
  fs.rmSync(versionProfile.profileFile(VERSION)); // 只留字典，缺档案 → 不完整

  await assert.rejects(
    patch.run({ version: VERSION, explicitPath: app.resourcesDir, quiet: true }),
    (e) => {
      assert.match(e.message, /替换逻辑档案/);
      assert.match(e.message, /patch\.json/);
      assert.ok(e.hint && e.hint.includes('version-profile.js probe'), e.hint);
      return true;
    }
  );
  assert.strictEqual(fs.readFileSync(app.mainPath, 'utf8'), MAIN_EN, '拒绝时不该写盘');
  assert.strictEqual(fs.readFileSync(app.rendererPath, 'utf8'), RENDERER_EN);
  assert.strictEqual(common.backupExists(VERSION), false, '拒绝时不该建备份');
});

test('锚点 0 次：产物没有注入点 → 拒绝且不写盘', async (t) => {
  const main = ';(function () {\n  var x = 1;\n})();\n'; // 没有 sourceMappingURL 锚点
  const app = makeApp({ main });
  prepare(t, app); // 档案期望注入点出现 1 次

  await assert.rejects(
    patch.run({ version: VERSION, explicitPath: app.resourcesDir, quiet: true }),
    (e) => {
      assert.match(e.message, /锚点不符/);
      assert.match(e.message, /出现 0 次/);
      assert.ok(e.hint && e.hint.includes('probe --version'), e.hint);
      return true;
    }
  );
  assert.strictEqual(fs.readFileSync(app.mainPath, 'utf8'), main);
  assert.strictEqual(common.backupExists(VERSION), false);
});

test('锚点 2 次：注入点不再唯一 → 拒绝', async (t) => {
  // 两个 sourceMappingURL 注释：锚点出现 2 次（档案期望 1 次）——插错位置风险，必须拒绝
  const main = `${MAIN_EN}\n//# sourceMappingURL=extra.map\n`;
  const app = makeApp({ main });
  prepare(t, app);

  await assert.rejects(
    patch.run({ version: VERSION, explicitPath: app.resourcesDir, quiet: true }),
    /锚点不符[\s\S]*出现 2 次/
  );
  assert.strictEqual(fs.readFileSync(app.mainPath, 'utf8'), main);
  assert.strictEqual(common.backupExists(VERSION), false);
});

test('未知策略：档案多写一个键 → 拒绝并列出可用策略', async (t) => {
  const app = makeApp();
  prepare(t, app);
  const raw = profileFixture.make(VERSION);
  raw.injections['mystery-strategy'] = { enabled: true };
  profileFixture.writeRaw(VERSION, raw);

  await assert.rejects(
    patch.run({ version: VERSION, explicitPath: app.resourcesDir, quiet: true }),
    (e) => {
      assert.match(e.message, /未知的替换策略/);
      assert.match(e.message, /context-menu/); // 列出可用策略
      return true;
    }
  );
  assert.strictEqual(fs.readFileSync(app.mainPath, 'utf8'), MAIN_EN);
});

test('schemaVersion 不认识 / targets 不一致 → 拒绝', async (t) => {
  const app = makeApp();
  prepare(t, app);

  // 1) 未来 schema：引擎不猜结构
  const future = profileFixture.make(VERSION);
  future.schemaVersion = 99;
  profileFixture.writeRaw(VERSION, future);
  await assert.rejects(
    patch.run({ version: VERSION, explicitPath: app.resourcesDir, quiet: true }),
    /schemaVersion 不受支持/
  );

  // 2) 替换对象清单是引擎与档案的共同契约，单方面改即拒绝
  const targets = profileFixture.make(VERSION);
  targets.targets = ['main.js'];
  profileFixture.writeRaw(VERSION, targets);
  await assert.rejects(
    patch.run({ version: VERSION, explicitPath: app.resourcesDir, quiet: true }),
    /targets 与引擎支持的替换对象不一致/
  );
});

test('参数来自档案：注入点锚点与标签表都用档案里的值', async (t) => {
  // 产物用一个**非默认**的注入点注释，档案声明同一个文本——若引擎仍写死
  // `//# sourceMappingURL=`，注入块就会落到文件末尾而不是锚点之前，标签也不会是自定义那套。
  const marker = '\n//# custom-anchor=';
  const labels = { windows: { undo: '&CustomUndo' }, macos: { undo: 'CustomUndo' } };
  const main = `;(function () {\n  var x = 1;\n})();\n${marker}main.js\n`;
  const app = makeApp({ main });
  prepare(t, app, { marker, labels });

  await withPatchState(() =>
    patch.run({ version: VERSION, explicitPath: app.resourcesDir, noRestart: true, quiet: true })
  );

  const patched = fs.readFileSync(app.mainPath, 'utf8');
  const range = contextMenu.blockRange(patched);
  assert.ok(range, 'main.js 应有右键菜单注入块');
  // 块被插在档案声明的锚点之前（行首换行之后），而不是被追加到文件末尾
  assert.ok(patched.indexOf(contextMenu.BEGIN) < patched.indexOf('//# custom-anchor='), patched);
  assert.ok(patched.slice(range.end).startsWith('//# custom-anchor='), '锚点应紧跟在注入块之后');
  // 标签表来自档案：块里是自定义标签，不是注入器的默认表
  assert.ok(patched.includes("'&CustomUndo'"), patched);
  assert.ok(!patched.includes("'&Undo'"), '不该混入默认标签表');
});

test('更新管控：档案未启用该策略时请求 → 写盘前拒绝（不静默跳过）', async (t) => {
  const app = makeApp({ main: MAIN_UPD }); // 产物有方法锚点，但档案默认禁用该策略
  prepare(t, app);

  await assert.rejects(
    patch.run({
      version: VERSION,
      explicitPath: app.resourcesDir,
      noRestart: true,
      updateControl: 'guard',
      quiet: true,
    }),
    (e) => {
      assert.match(e.message, /未启用「更新管控」/);
      assert.ok(e.hint, '应给出下一步');
      return true;
    }
  );
  assert.strictEqual(fs.readFileSync(app.mainPath, 'utf8'), MAIN_UPD, '拒绝时不该写盘');
  assert.strictEqual(common.backupExists(VERSION), false);
});

test('更新管控锚点 0 / 2 次：拒绝且不写盘', async (t) => {
  // 0 次：档案启用更新管控，但产物没有 async checkForUpdates( 方法
  const zero = makeApp();
  prepare(t, zero, { updateControl: true });
  await assert.rejects(
    patch.run({
      version: VERSION,
      explicitPath: zero.resourcesDir,
      noRestart: true,
      updateControl: 'guard',
      quiet: true,
    }),
    /锚点不符[\s\S]*出现 0 次/
  );
  assert.strictEqual(fs.readFileSync(zero.mainPath, 'utf8'), MAIN_EN);

  // 2 次：锚点不再唯一
  const two = [
    'class A { async checkForUpdates(a) { return a } }',
    'class B { async checkForUpdates(b) { return b } }',
    '',
    '//# sourceMappingURL=main.js.map',
    '',
  ].join('\n');
  const dup = makeApp({ main: two });
  prepare(t, dup, { updateControl: true });
  await assert.rejects(
    patch.run({
      version: VERSION,
      explicitPath: dup.resourcesDir,
      noRestart: true,
      updateControl: 'guard',
      quiet: true,
    }),
    /锚点不符[\s\S]*出现 2 次/
  );
  assert.strictEqual(fs.readFileSync(dup.mainPath, 'utf8'), two);
});
