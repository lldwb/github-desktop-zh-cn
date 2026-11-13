// version-profile（scripts/version-profile.js）单元测试：
// 加载 / 结构校验 / 策略解析 / 锚点断言 / 成对校验 / 写入口 / 探测（probeApp + buildProfile）.
//
// 覆盖工单验收要求的失败语义：正常加载、缺档案、锚点 0/2 次、未知策略、成对同步（校验）失败；
// 另加「探测生成」的合成产物用例——探测是纯读文件的，用两平台最小合成产物即可钉住
// 「标签从官方源码推导 + 两平台交叉校验 + 证据落档案」这条链，不需要联网。
//
// 隔离：档案夹具落在 dictionaries/<非版本形态>/（scratch 约定），探测产物落在系统临时目录，
// 用例前后清理。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const common = require('../scripts/common');
const versionProfile = require('../scripts/version-profile');
const scratch = require('./fixtures/scratch');
const profileFixture = require('./fixtures/profile');

const VERSION = '0.0.0-profile';

function prepare(t) {
  scratch.cleanup(VERSION);
  scratch.isolate(t, VERSION);
}

// 合成「官方产物」目录：app/{main.js, renderer.js, package.json, main.js.map}。
// 两平台产物只差在 bundle 里出现的标签字面量（windows 带 &、macos 不带），与真实产物同形。
const MENU_SOURCE = `
import { Menu } from 'electron'

function buildDefaultMenu() {
  const template = []
  template.push({
    label: __DARWIN__ ? 'Edit' : '&Edit',
    submenu: [
      { role: 'undo', label: __DARWIN__ ? 'Undo' : '&Undo' },
      { role: 'redo', label: __DARWIN__ ? 'Redo' : '&Redo' },
      separator,
      { role: 'cut', label: __DARWIN__ ? 'Cut' : 'Cu&t' },
      { role: 'copy', label: __DARWIN__ ? 'Copy' : '&Copy' },
      { role: 'paste', label: __DARWIN__ ? 'Paste' : '&Paste' },
      {
        label: __DARWIN__ ? 'Select All' : 'Select &all',
        accelerator: 'CmdOrCtrl+A',
        click: emit('select-all'),
      },
    ],
  })
  return template
}
`;

const LABEL_LITERALS = {
  windows: {
    undo: '&Undo',
    redo: '&Redo',
    cut: 'Cu&t',
    copy: '&Copy',
    paste: '&Paste',
    selectall: 'Select &all',
  },
  macos: {
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectall: 'Select All',
  },
};

// opts: { platform, version, menuSource, extraMain, anchorCount, maps }
function makeArtifact(opts) {
  const platform = opts.platform;
  const version = opts.version || VERSION;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ghd-profile-${platform}-`));
  const appDir = path.join(root, 'app');
  fs.mkdirSync(appDir, { recursive: true });

  const labels = Object.values(opts.labelLiterals || LABEL_LITERALS[platform]);
  const anchorCount = opts.anchorCount === undefined ? 1 : opts.anchorCount;
  const main = [
    ';(function(){',
    ...labels.map((l) => `  console.log('${l}');`),
    ...(opts.extraMain || []),
    ...Array.from({ length: anchorCount }, (_, i) => `class U${i} { async checkForUpdates(a) { return a } }`),
    '})();',
    '//# sourceMappingURL=main.js.map',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(appDir, 'main.js'), main, 'utf8');
  fs.writeFileSync(path.join(appDir, 'renderer.js'), 'var x = 1;\n', 'utf8');
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'desktop', version }), 'utf8');

  if (opts.maps !== false) {
    const menuSource = opts.menuSource === undefined ? MENU_SOURCE : opts.menuSource;
    const map = {
      version: 3,
      sources: ['webpack:///./app/src/main-process/menu/build-default-menu.ts'],
      sourcesContent: [menuSource],
      names: [],
      mappings: '',
    };
    fs.writeFileSync(path.join(appDir, 'main.js.map'), JSON.stringify(map), 'utf8');
  }

  const meta = {
    platform,
    version,
    arch: 'x64',
    assetName: platform === 'windows' ? `GitHubDesktop-${version}-x64-full.nupkg` : 'GitHub.Desktop-x64.zip',
    assetBytes: 123456,
    archiveEntries: 100,
    appDirInArchive: platform === 'windows' ? 'lib/net45/resources/app' : 'GitHub Desktop.app/Contents/Resources/app',
  };
  return { root, appDir, meta };
}

function cleanupArtifact(artifact) {
  fs.rmSync(artifact.root, { recursive: true, force: true });
}

// ============================ 加载与结构校验 ============================

test('正常加载：外部档案读入并规范化，来源标为 external', (t) => {
  prepare(t);
  const file = profileFixture.write(VERSION);
  assert.ok(fs.existsSync(file));

  const { profile, source, path: filePath } = versionProfile.loadProfile(VERSION);
  assert.strictEqual(source, 'external');
  assert.strictEqual(filePath, versionProfile.profileFile(VERSION));
  assert.strictEqual(profile.version, VERSION);
  assert.strictEqual(profile.schemaVersion, versionProfile.SCHEMA_VERSION);
  assert.deepStrictEqual(profile.targets, [...common.TARGETS]);
  assert.ok(profile.anchors.injectionPoint, '应带注入点锚点');
  assert.strictEqual(profile.injections['context-menu'].enabled, true);
});

test('缺档案：抛可读错误，提示里带可执行下一步', (t) => {
  prepare(t);
  scratch.cleanup(VERSION); // 确保没有档案

  assert.throws(
    () => versionProfile.loadProfile(VERSION),
    (e) => {
      assert.match(e.message, /替换逻辑档案/);
      assert.match(e.message, new RegExp(`patch\\.json`));
      assert.ok(e.hint && e.hint.includes('version-profile.js probe'), e.hint);
      return true;
    }
  );
});

test('非法 JSON：拒绝并说明档案位置', (t) => {
  prepare(t);
  const file = versionProfile.profileFile(VERSION);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');

  assert.throws(() => versionProfile.loadProfile(VERSION), /不是合法 JSON/);
});

test('schemaVersion 不认识：拒绝（不猜测新旧结构）', (t) => {
  prepare(t);
  const raw = profileFixture.make(VERSION);
  raw.schemaVersion = versionProfile.SCHEMA_VERSION + 1;
  profileFixture.writeRaw(VERSION, raw);

  assert.throws(() => versionProfile.loadProfile(VERSION), /schemaVersion 不受支持/);
});

test('版本错配：档案版本与目标版本不一致 → 拒绝', (t) => {
  prepare(t);
  const raw = profileFixture.make('9.9.9');
  raw.version = '9.9.9';
  profileFixture.writeRaw(VERSION, raw);

  assert.throws(() => versionProfile.loadProfile(VERSION), /版本.*不一致/);
});

test('targets 与引擎不一致：拒绝（共同契约不能单方面改）', (t) => {
  prepare(t);
  const raw = profileFixture.make(VERSION);
  raw.targets = ['main.js'];
  profileFixture.writeRaw(VERSION, raw);

  assert.throws(() => versionProfile.loadProfile(VERSION), /targets 与引擎支持的替换对象不一致/);
});

test('未知策略名：拒绝并列出可用策略', (t) => {
  prepare(t);
  const raw = profileFixture.make(VERSION);
  raw.injections['not-a-strategy'] = { enabled: true };
  profileFixture.writeRaw(VERSION, raw);

  assert.throws(
    () => versionProfile.loadProfile(VERSION),
    (e) => {
      assert.match(e.message, /未知的替换策略/);
      assert.match(e.message, /context-menu/);
      assert.match(e.message, /update-control/);
      return true;
    }
  );
});

test('策略引用了不存在的锚点：拒绝', (t) => {
  prepare(t);
  const raw = profileFixture.make(VERSION);
  raw.injections['context-menu'].injectionPoint = 'missing-anchor';
  profileFixture.writeRaw(VERSION, raw);

  assert.throws(() => versionProfile.loadProfile(VERSION), /引用了不存在的锚点/);
});

test('锚点 placement 与 expected 组合非法：拒绝', (t) => {
  prepare(t);
  const raw = profileFixture.make(VERSION);
  raw.anchors.injectionPoint.placement = 'unique';
  raw.anchors.injectionPoint.expected = 2; // unique 要求恰好 1
  profileFixture.writeRaw(VERSION, raw);

  assert.throws(() => versionProfile.loadProfile(VERSION), /unique 要求 expected=1/);
});

test('labels 两平台角色集合不一致：拒绝', (t) => {
  prepare(t);
  const raw = profileFixture.make(VERSION);
  raw.injections['context-menu'].labels.macos.delete = 'Delete';
  delete raw.injections['context-menu'].labels.windows.delete; // 只删一侧 → 集合不一致
  profileFixture.writeRaw(VERSION, raw);

  assert.throws(() => versionProfile.loadProfile(VERSION), /角色集合必须一致/);
});

test('探测证据与声明不一致（两平台实测次数不同）：拒绝', (t) => {
  prepare(t);
  const artifactW = makeArtifact({ platform: 'windows' });
  const artifactM = makeArtifact({ platform: 'macos' });
  t.after(() => {
    cleanupArtifact(artifactW);
    cleanupArtifact(artifactM);
  });
  const measurements = {
    windows: versionProfile.probeApp(artifactW.appDir, artifactW.meta),
    macos: versionProfile.probeApp(artifactM.appDir, artifactM.meta),
  };
  const profile = versionProfile.buildProfile(VERSION, { measurements });
  // 篡改证据：platform 实测次数与档案声明不同 → 校验必须拒绝（证据不是装饰，是「为什么是 1 次」的凭据）
  profile.evidence.platforms.macos.anchors.injectionPoint = 2;

  assert.throws(
    () => versionProfile.validateProfile(profile, { version: VERSION }),
    /证据与声明不一致[\s\S]*实测锚点 injectionPoint 出现 2 次/
  );
});

// ============================ 锚点断言 ============================

test('assertAnchors：次数匹配则通过并返回实测次数', () => {
  const profile = profileFixture.make(VERSION);
  const content = `var x = 1;\n//# sourceMappingURL=main.js.map\n`;
  const counts = versionProfile.assertAnchors(content, profile, { file: 'main.js' });
  assert.deepStrictEqual(counts, { injectionPoint: 1 });
});

test('assertAnchors：0 次 → 报「出现 0 次」与期望次数（产物结构变了）', () => {
  const profile = profileFixture.make(VERSION);
  assert.throws(
    () => versionProfile.assertAnchors('var x = 1;\n', profile, { file: 'main.js' }),
    (e) => {
      assert.match(e.message, /锚点不符/);
      assert.match(e.message, /出现 0 次/);
      assert.match(e.message, /档案期望 1 次/);
      assert.ok(e.hint && e.hint.includes('probe --version'), e.hint);
      return true;
    }
  );
});

test('assertAnchors：2 次 → 报「出现 2 次」（锚点不再唯一）', () => {
  const profile = profileFixture.make(VERSION);
  const content = 'var x = 1;\n//# sourceMappingURL=a.map\n//# sourceMappingURL=b.map\n';
  assert.throws(
    () => versionProfile.assertAnchors(content, profile, { file: 'main.js' }),
    /出现 2 次/
  );
});

test('assertAnchors：按策略筛选——未请求的策略锚点不参与断言', () => {
  // 档案声明了更新管控（夹具产物带方法锚点），但本次只断言 i18n 的右键菜单策略：
  // 方法锚点即使 0 次也不该挡住只汉化的操作（反过来请求了更新管控就必须断言）。
  const profile = profileFixture.make(VERSION, { updateControl: true });
  const contentWithoutMethodAnchor = 'var x = 1;\n//# sourceMappingURL=main.js.map\n';
  assert.deepStrictEqual(
    versionProfile.assertAnchors(contentWithoutMethodAnchor, profile, {
      file: 'main.js',
      strategies: ['context-menu'],
    }),
    { injectionPoint: 1 }
  );
  assert.throws(
    () =>
      versionProfile.assertAnchors(contentWithoutMethodAnchor, profile, {
        file: 'main.js',
        strategies: ['update-control'],
      }),
    /出现 0 次/
  );
});

test('assertAnchors：append-eof 形态（锚点 0 次是预期）通过', () => {
  const profile = profileFixture.make(VERSION);
  profile.anchors.injectionPoint = {
    text: '\n//# sourceMappingURL=',
    file: 'main.js',
    placement: 'append-eof',
    expected: 0,
  };
  const counts = versionProfile.assertAnchors('var x = 1;\n', profile, { file: 'main.js' });
  assert.deepStrictEqual(counts, { injectionPoint: 0 });
});

// ============================ 策略解析 ============================

test('strategy：context-menu 按平台给出标签表与注入点锚点', () => {
  const profile = profileFixture.make(VERSION);
  const win = versionProfile.strategy(profile, 'context-menu', { platform: 'win32' });
  assert.strictEqual(win.labels.undo, '&Undo');
  assert.strictEqual(win.injectionPoint.text, profileFixture.DEFAULT_MARKER);
  const mac = versionProfile.strategy(profile, 'context-menu', { platform: 'darwin' });
  assert.strictEqual(mac.labels.undo, 'Undo');
  // 非官方平台（linux）沿用 windows 表——与 build-default-menu 的 __DARWIN__ 三目一致
  assert.strictEqual(versionProfile.strategy(profile, 'context-menu', { platform: 'linux' }).labels.undo, '&Undo');
});

test('strategy：未启用/未声明/未知 → 明确失败（绝不静默跳过）', () => {
  const disabled = profileFixture.make(VERSION); // 默认 update-control enabled:false
  assert.throws(
    () => versionProfile.strategy(disabled, 'update-control'),
    (e) => {
      assert.match(e.message, /未启用「更新管控」/);
      assert.ok(e.hint, '应给出下一步');
      return true;
    }
  );

  const notDeclared = profileFixture.make(VERSION);
  delete notDeclared.injections['update-control'];
  assert.throws(() => versionProfile.strategy(notDeclared, 'update-control'), /未声明「更新管控」/);

  assert.throws(() => versionProfile.strategy(disabled, 'mystery'), /未知替换策略/);
});

test('hasStrategy：声明且启用才算有', () => {
  const profile = profileFixture.make(VERSION, { updateControl: true });
  assert.strictEqual(versionProfile.hasStrategy(profile, 'context-menu'), true);
  assert.strictEqual(versionProfile.hasStrategy(profile, 'update-control'), true);
  const disabled = profileFixture.make(VERSION);
  assert.strictEqual(versionProfile.hasStrategy(disabled, 'update-control'), false);
});

// ============================ 成对校验 ============================

test('pairStatus：只有字典 / 只有档案 / 成对，三种状态可区分', (t) => {
  prepare(t);
  // 1) 只有字典
  const dictFile = common.dictFile(VERSION);
  fs.mkdirSync(path.dirname(dictFile), { recursive: true });
  fs.writeFileSync(dictFile, JSON.stringify({ _meta: { version: VERSION, formatVersion: 2 }, common: { a: 'b' }, windows: {}, macos: {}, linux: {}, groups: {} }), 'utf8');
  let status = versionProfile.pairStatus(VERSION);
  assert.strictEqual(status.dict, true);
  assert.strictEqual(status.profile, false);
  assert.strictEqual(status.paired, false);
  assert.deepStrictEqual(status.missing, ['patch.json']);

  // 2) 只有档案（成对同步失败的一半——引擎必须拒绝而不是当「有资源」）
  fs.rmSync(dictFile, { force: true });
  profileFixture.write(VERSION);
  status = versionProfile.pairStatus(VERSION);
  assert.strictEqual(status.dict, false);
  assert.strictEqual(status.profile, true);
  assert.strictEqual(status.paired, false);
  assert.deepStrictEqual(status.missing, ['zh-CN.json']);

  // 3) 成对
  fs.writeFileSync(dictFile, JSON.stringify({ _meta: { version: VERSION, formatVersion: 2 }, common: { a: 'b' }, windows: {}, macos: {}, linux: {}, groups: {} }), 'utf8');
  status = versionProfile.pairStatus(VERSION);
  assert.strictEqual(status.paired, true);
  assert.deepStrictEqual(status.missing, []);
});

test('assertPair：不成对时抛错，指出缺哪份并给补齐方式', (t) => {
  prepare(t);
  const dictFile = common.dictFile(VERSION);
  fs.mkdirSync(path.dirname(dictFile), { recursive: true });
  fs.writeFileSync(dictFile, '{}', 'utf8'); // 只有字典

  assert.throws(
    () => versionProfile.assertPair(VERSION),
    (e) => {
      assert.match(e.message, /不完整/);
      assert.match(e.message, /patch\.json/);
      assert.ok(e.hint && e.hint.includes('version-profile.js probe'), e.hint);
      return true;
    }
  );
});

// ============================ 写入口 ============================

test('writeProfile：默认拒绝覆盖已有档案；overwrite 才替换；落盘是原子替换', (t) => {
  prepare(t);
  const first = profileFixture.write(VERSION);
  assert.ok(fs.existsSync(first));
  assert.throws(() => versionProfile.writeProfile(VERSION, profileFixture.make(VERSION)), /已存在/);

  const replaced = versionProfile.writeProfile(VERSION, profileFixture.make(VERSION, { updateControl: true }), {
    overwrite: true,
  });
  assert.strictEqual(replaced, first);
  const loaded = JSON.parse(fs.readFileSync(first, 'utf8'));
  assert.strictEqual(loaded.injections['update-control'].enabled, true);
  // 原子写：不残留 .part 半成品
  assert.deepStrictEqual(
    fs.readdirSync(path.dirname(first)).filter((f) => f.endsWith('.part')),
    []
  );
});

// ============================ 探测（probeApp + buildProfile） ============================

test('探测：两平台合成产物 → 生成档案（锚点/标签/证据齐全，且通过引擎自身校验）', (t) => {
  const w = makeArtifact({ platform: 'windows' });
  const m = makeArtifact({ platform: 'macos' });
  t.after(() => {
    cleanupArtifact(w);
    cleanupArtifact(m);
  });

  const measurements = {
    windows: versionProfile.probeApp(w.appDir, w.meta),
    macos: versionProfile.probeApp(m.appDir, m.meta),
  };
  assert.deepStrictEqual(measurements.windows.anchors, { injectionPoint: 1, checkForUpdates: 1 });
  assert.deepStrictEqual(measurements.macos.anchors, { injectionPoint: 1, checkForUpdates: 1 });
  // 标签从官方源码（sourcemap 的 sourcesContent）推导：两平台各取三目的一侧
  assert.strictEqual(measurements.windows.labels.undo.label, '&Undo');
  assert.strictEqual(measurements.macos.labels.undo.label, 'Undo');
  assert.strictEqual(measurements.windows.labels.delete.label, 'Delete');

  const profile = versionProfile.buildProfile(VERSION, { measurements, generatedAt: '2026-01-01T00:00:00.000Z' });
  assert.strictEqual(profile.schemaVersion, versionProfile.SCHEMA_VERSION);
  assert.strictEqual(profile.anchors.injectionPoint.expected, 1);
  assert.strictEqual(profile.anchors.checkForUpdates.expected, 1);
  assert.deepStrictEqual(profile.injections['context-menu'].labels.windows, {
    undo: '&Undo',
    redo: '&Redo',
    cut: 'Cu&t',
    copy: '&Copy',
    paste: '&Paste',
    selectall: 'Select &all',
    delete: 'Delete',
  });
  // 证据：产物名 / 版本 / 文件字节数与 sha256 / 锚点实测次数都在档案里可查
  const evidence = profile.evidence.platforms.windows;
  assert.strictEqual(evidence.assetName, w.meta.assetName);
  assert.strictEqual(evidence.appVersion, VERSION);
  assert.strictEqual(evidence.files['main.js'].bytes, fs.statSync(path.join(w.appDir, 'main.js')).size);
  assert.match(evidence.files['main.js'].sha256, /^[0-9a-f]{64}$/);
  assert.deepStrictEqual(evidence.anchors, { injectionPoint: 1, checkForUpdates: 1 });
  assert.strictEqual(evidence.labels.undo.bundleLiteralCount, 1);
  // 本地解包路径不进档案（开源仓库不写绝对路径/机器名）
  assert.ok(!JSON.stringify(profile).includes(w.root), '档案不该包含本机解包路径');
  // 生成即校验：探测产物必须能被引擎加载
  assert.doesNotThrow(() => versionProfile.validateProfile(profile, { version: VERSION }));
});

test('探测：两平台锚点次数不一致 → 拒绝生成（schema 不支持按平台不同期望）', (t) => {
  const w = makeArtifact({ platform: 'windows', anchorCount: 2 });
  const m = makeArtifact({ platform: 'macos', anchorCount: 1 });
  t.after(() => {
    cleanupArtifact(w);
    cleanupArtifact(m);
  });
  const measurements = {
    windows: versionProfile.probeApp(w.appDir, w.meta),
    macos: versionProfile.probeApp(m.appDir, m.meta),
  };
  assert.throws(
    () => versionProfile.buildProfile(VERSION, { measurements }),
    /两平台.*不一致/
  );
});

test('探测：两平台官方源码推导的标签不一致 → 拒绝生成', (t) => {
  // 两个平台的产物各自自洽（bundle 里能找到自己那套字面量），但 map 里的官方源码被改成
  // 不同的标签——buildProfile 的跨平台一致性校验必须拒绝。
  const changed = MENU_SOURCE.replace("'Paste'", "'PasteX'");
  const w = makeArtifact({ platform: 'windows' });
  const m = makeArtifact({
    platform: 'macos',
    menuSource: changed,
    labelLiterals: { ...LABEL_LITERALS.macos, paste: 'PasteX' },
  });
  t.after(() => {
    cleanupArtifact(w);
    cleanupArtifact(m);
  });
  assert.throws(
    () =>
      versionProfile.buildProfile(VERSION, {
        measurements: {
          windows: versionProfile.probeApp(w.appDir, w.meta),
          macos: versionProfile.probeApp(m.appDir, m.meta),
        },
      }),
    /不一致/
  );
});

test('探测：本平台产物里找不到标签字面量 → 拒绝（推导错分支就失败）', (t) => {
  const w = makeArtifact({ platform: 'windows' });
  t.after(() => cleanupArtifact(w));
  // 删掉 windows bundle 里的 'Cu&t' 字面量（模拟平台分支推导错 / 官方菜单改了）
  const mainFile = path.join(w.appDir, 'main.js');
  fs.writeFileSync(mainFile, fs.readFileSync(mainFile, 'utf8').replace("'Cu&t'", "'Cut'"), 'utf8');
  assert.throws(() => versionProfile.probeApp(w.appDir, w.meta), /找不到字面量/);
});

test('探测：产物版本与目标版本不一致 → 拒绝', (t) => {
  const w = makeArtifact({ platform: 'windows', version: '9.9.9' });
  t.after(() => cleanupArtifact(w));
  assert.throws(() => versionProfile.probeApp(w.appDir, { ...w.meta, version: VERSION }), /版本.*不一致/);
});

test('探测：sourcemap 缺 sourcesContent → 拒绝（标签推导不瞎猜）', (t) => {
  const w = makeArtifact({ platform: 'windows' });
  t.after(() => cleanupArtifact(w));
  const mapFile = path.join(w.appDir, 'main.js.map');
  const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
  map.sourcesContent = [null];
  fs.writeFileSync(mapFile, JSON.stringify(map), 'utf8');
  assert.throws(() => versionProfile.probeApp(w.appDir, w.meta), /sourcesContent/);
});
