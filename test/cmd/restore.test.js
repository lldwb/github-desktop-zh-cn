// restore（scripts/cmd/restore.js）编排层契约测试：备份还原 / 字典逆向还原两条路径的输入 → 副作用。
//
// 只经导出的 run() 直测（CLI 的 main() 只做参数解析与打印）。断言落在「输入 → 返回值 /
// 文件系统副作用」上，不掺内部调用。
//
// 隔离与安全（零联网 / 零重启 / 不碰真实安装）：
//   - restore.run() 没有关闭重启的参数（重启是它编排的最后一步）；fixture 安装目录里不存在
//     GitHubDesktop.exe——restartApp 判定「目标不在运行」直接返回 'not-running'，全程不碰
//     真实进程。返回值里 restarted === 'not-running' 被钉成断言，正是「没有重启」的契约表现
//     （判定逻辑见 scripts/cmd/restart.js：目标可执行体不存在时连进程检查都不做）；
//   - 安装目录用 mkdtemp 在系统临时目录现造（resources/app/…，与真实安装同形）；
//   - 字典夹具按 test/fixtures/scratch.js 的约定落在 dictionaries/0.0.0-restore/（非版本形态，
//     并行测试互不可见），且在 run() 之前落盘——逆向还原取本地字典，全程零联网。
// 备份落在数据根的 tmp/backup/<夹具版本>/（生产 SSOT 路径），用例前后都清这个专属目录，
// 绝不触碰真实版本（如 3.6.6）的备份。
//
// 记账隔离：有备份路径会销账、按组还原会落账——它们写数据根的 tmp/patch-state.json（所有
// 进程共享），而 node --test 各测试文件并行跑，「读改写」交错理论上可互相覆盖（丢真实版本的
// 记账）。写它的用例统一走 withPatchState：跨进程互斥锁 + 用例前后快照恢复，测试结束零残留、
// 真实数据原封不动（readPatchState 对丢失/损坏一律当空账，故保守处理是必要的）。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const common = require('../../scripts/common');
const restore = require('../../scripts/cmd/restore');
const patch = require('../../scripts/cmd/patch');
const updateControl = require('../../scripts/inject/update-control');
const scratch = require('../fixtures/scratch');

// 本文件专属的夹具版本名（与 verify / patch 的测试目录互不撞车，非三段数字形态）
const VERSION = '0.0.0-restore';

// 官方产物的最小合成替身：几个字符串字面量供字典命中（普通键、作用域键、整模板键三种形态）。
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

// 汉化后的形态（patch 产物的等价物）：普通键整串换译文；作用域键 renderer.js|Delete 只动
// renderer.js（main.js 的 'Delete' 保持英文）。逆还原的期望结果就是上面的两个原文。
const MAIN_ZH = [
  ';(function () {',
  "  var title = '偏好设置';",
  "  var menu = { label: '检查更新' };",
  '  console.log("欢迎使用 GitHub Desktop");',
  "  console.log('Delete');",
  '})();',
  '',
  '//# sourceMappingURL=main.js.map',
  '',
].join('\n');

const RENDERER_ZH = [
  ';(function () {',
  "  var keys = { Delete: '删除' };",
  '  var n = 1;',
  '  console.log(`${n} 个文件`);',
  '})();',
  '',
].join('\n');

// 带更新管控锚点的官方原文：`async checkForUpdates(` 要求全文件唯一（按组还原重放
// updateControl 时要往这个方法体里插闸门，见 scripts/inject/update-control.js）
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghd-restore-'));
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
//    与 test/cmd/patch.test.js 里的同名函数是同一把锁（名字一致），两侧的写者互斥。
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

// ============================ 正向：有备份 ============================

test('有备份：逐字节复制回官方原文，source=backup（version 缺省取安装版本）', async (t) => {
  const app = makeApp({ main: MAIN_ZH, renderer: RENDERER_ZH }); // 当前是汉化态
  prepare(t, app);
  fs.mkdirSync(common.backupDir(VERSION), { recursive: true });
  fs.writeFileSync(path.join(common.backupDir(VERSION), 'main.js'), MAIN_EN, 'utf8');
  fs.writeFileSync(path.join(common.backupDir(VERSION), 'renderer.js'), RENDERER_EN, 'utf8');

  const r = await withPatchState(() => restore.run({ explicitPath: app.resourcesDir, quiet: true }));

  assert.strictEqual(r.source, 'backup');
  assert.strictEqual(r.version, VERSION, '不传 version 时取安装版本');
  assert.strictEqual(r.total, 0, '备份路径不做替换计数');
  assert.strictEqual(r.restarted, 'not-running');
  assert.strictEqual(fs.readFileSync(app.mainPath, 'utf8'), MAIN_EN);
  assert.strictEqual(fs.readFileSync(app.rendererPath, 'utf8'), RENDERER_EN);
});

// ============================ 正向：无备份（字典逆向） ============================

test('无备份：按字典逆向还原，译文整串换回原文、逐字节回到官方版', async (t) => {
  const app = makeApp({ main: MAIN_ZH, renderer: RENDERER_ZH });
  prepare(t, app);

  const r = await restore.run({ version: VERSION, explicitPath: app.resourcesDir, quiet: true });

  assert.strictEqual(r.source, 'reverse');
  assert.strictEqual(r.total, 5); // main 3（普通键×3）+ renderer 2（作用域键值 + 整模板键）
  assert.strictEqual(r.ambiguous, 0, '夹具字典一键一译文，无歧义');
  assert.strictEqual(r.skipped, 0, '译文全是中文（可逆），无跳过');
  assert.strictEqual(r.restarted, 'not-running');
  assert.strictEqual(fs.readFileSync(app.mainPath, 'utf8'), MAIN_EN);
  assert.strictEqual(fs.readFileSync(app.rendererPath, 'utf8'), RENDERER_EN);
});

// ============================ 异常 ============================

test('逆向还原后语法不过：拒绝写盘，两个文件都保持原样', async (t) => {
  const badRenderer = "var y = '删除';\nvar 1 = ;\n";
  const app = makeApp({ main: MAIN_ZH, renderer: badRenderer });
  prepare(t, app);

  await assert.rejects(
    restore.run({ version: VERSION, explicitPath: app.resourcesDir, quiet: true }),
    /按字典还原后 renderer\.js 语法校验未通过，已放弃写盘/
  );
  // 「先全部算好、语法过了再统一落盘」：坏的是第二个文件，算好的第一个也不该被写
  assert.strictEqual(fs.readFileSync(app.mainPath, 'utf8'), MAIN_ZH);
  assert.strictEqual(fs.readFileSync(app.rendererPath, 'utf8'), badRenderer);
});

test('指定目录缺文件：locateApp 报错', async (t) => {
  const app = makeApp();
  prepare(t, app);
  fs.rmSync(app.mainPath);

  await assert.rejects(
    restore.run({ version: VERSION, explicitPath: app.resourcesDir, quiet: true }),
    /指定目录不是有效的 GitHub Desktop 资源目录/
  );
});

// ============================ 边界 ============================

test('无备份且产物本就是官方原文：逆向替换 0 处，内容不变', async (t) => {
  const app = makeApp();
  prepare(t, app);

  const r = await restore.run({ version: VERSION, explicitPath: app.resourcesDir, quiet: true });

  assert.strictEqual(r.source, 'reverse');
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.restarted, 'not-running');
  assert.strictEqual(fs.readFileSync(app.mainPath, 'utf8'), MAIN_EN);
  assert.strictEqual(fs.readFileSync(app.rendererPath, 'utf8'), RENDERER_EN);
});

// ============================ 按组还原（D1 回归） ============================
// D1 缺陷曾在这里：按组还原重放 updateControl 一律硬编码 guard，用户先打「完全禁止」再
// 按组还原会被静默改回 guard。修复后重放模式按记账来（账上 off → 重放 off；老账无模式
// → 默认 guard）。两条都钉住，防回归。

test('按组还原：账上记 off → 重放 updateControl 仍是 off（撤汉化、保留管控）', async (t) => {
  const app = makeApp({ main: MAIN_UPD });
  prepare(t, app);

  await withPatchState(async () => {
    // 先打完整补丁：i18n + 「完全禁止更新」（off），账上记下 updateControlMode: 'off'
    await patch.run({
      version: VERSION,
      explicitPath: app.resourcesDir,
      noRestart: true,
      updateControl: 'off',
      quiet: true,
    });
    // 撤汉化组：从官方原文重放剩下的 updateControl，模式按账上来
    return restore.run({ version: VERSION, explicitPath: app.resourcesDir, groups: ['i18n'], quiet: true });
  }).then((r) => {
    assert.strictEqual(r.source, 'groups');
    assert.deepStrictEqual(r.removed, ['i18n']);
    assert.deepStrictEqual(r.kept, ['updateControl']);
    assert.strictEqual(r.restarted, 'not-running');
    return r;
  });

  const main = fs.readFileSync(app.mainPath, 'utf8');
  // 汉化撤了：i18n 组未重放，字符串回到官方英文原文
  assert.ok(main.includes('console.log("Welcome to GitHub Desktop");'), '撤 i18n 后应回到英文原文');
  // 更新管控保留，且按账上的 off 重放（不是一律 guard）
  assert.ok(main.includes(updateControl.BEGIN), '应保留更新管控块');
  assert.ok(main.includes('return false;'), 'off 模式的放行函数应直接返回 false');
  assert.ok(!main.includes('var lim=limit();'), '不该重放成 guard 模式');
  assert.deepStrictEqual(common.checkSyntax(main, 'main.js'), { ok: true, output: '' });
  // renderer 同样从备份回到官方原文
  assert.strictEqual(fs.readFileSync(app.rendererPath, 'utf8'), RENDERER_EN);
});

test('按组还原：老账没记模式 → 重放默认 guard（与 mode 字段上线前的行为一致）', async (t) => {
  const app = makeApp({ main: MAIN_UPD });
  prepare(t, app);
  // 备份在场（官方原文）
  fs.mkdirSync(common.backupDir(VERSION), { recursive: true });
  fs.writeFileSync(path.join(common.backupDir(VERSION), 'main.js'), MAIN_UPD, 'utf8');
  fs.writeFileSync(path.join(common.backupDir(VERSION), 'renderer.js'), RENDERER_EN, 'utf8');

  await withPatchState(async () => {
    // 老账形态：账上有 updateControl 组、但没记模式（mode 字段上线前打的补丁）——
    // setPatchGroups 不带第三参写出的正是这种账（只记组名）
    common.setPatchGroups(VERSION, ['i18n', 'updateControl']);
    return restore.run({ version: VERSION, explicitPath: app.resourcesDir, groups: ['i18n'], quiet: true });
  }).then((r) => {
    assert.deepStrictEqual(r.kept, ['updateControl']);
    return r;
  });

  const main = fs.readFileSync(app.mainPath, 'utf8');
  assert.ok(main.includes(updateControl.BEGIN), '应重放更新管控块');
  assert.ok(main.includes('var lim=limit();'), '老账无模式时按 guard 重放（没有字典就不更新）');
  assert.ok(!main.includes('return false;'), '不该把无模式的老账当成 off');
});
