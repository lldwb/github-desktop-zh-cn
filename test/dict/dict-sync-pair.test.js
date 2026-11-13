// dict-sync 成对语义单测：fetchPair（逐源两份都要）/ writePair（原子 + 回滚 + 只补缺）/
// ensureDict（本地成对不联网、半对只补缺、失败不静默）/ syncLatest（成对覆盖、未变不动）。
//
// 零网络：fetchPair 的 fetch 与 ensureDict 的 fetchPair 都可注入；夹具版本用非三段数字形态
// （0.0.0-sync），落盘走生产 SSOT 路径（common.dictFile / versionProfile.profileFile），
// 用例前后由 fixtures/scratch 清理。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const common = require('../../scripts/common');
const versionProfile = require('../../scripts/version-profile');
const dictSync = require('../../scripts/dict/dict-sync');
const scratch = require('../fixtures/scratch');
const profileFixture = require('../fixtures/profile');

const VERSION = '0.0.0-sync';

function prepare(t) {
  scratch.cleanup(VERSION);
  scratch.isolate(t, VERSION);
  fs.rmSync(common.backupDir(VERSION), { recursive: true, force: true });
}

function dictText(entries = { 'Hello': '你好' }) {
  return `${JSON.stringify({
    _meta: { version: VERSION, formatVersion: 2 },
    common: entries,
    windows: {},
    macos: {},
    linux: {},
    groups: {},
  }, null, 2)}\n`;
}

function profileText(overrides = {}) {
  return `${JSON.stringify(profileFixture.make(VERSION, overrides), null, 2)}\n`;
}

function dictPath() {
  return common.dictFile(VERSION);
}

function profilePath() {
  return versionProfile.profileFile(VERSION);
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

// 注入式 fetch：routes 是 URL 子串 → 行为（返回文本 / 抛错）
function fakeFetch(routes, calls = []) {
  return async (url) => {
    calls.push(url);
    for (const [needle, behavior] of Object.entries(routes)) {
      if (!url.includes(needle)) continue;
      if (typeof behavior === 'function') return behavior(url);
      if (behavior instanceof Error) throw behavior;
      return behavior;
    }
    throw new Error(`未预置的 fetch：${url}`);
  };
}

// ============================ fetchPair ============================

test('fetchPair：一个源缺档案时换下一个源（两份都取到才算成功）', async () => {
  const calls = [];
  const fetch = fakeFetch(
    {
      // 第 1 个源（GitHub raw）：字典在、档案 404
      'raw.githubusercontent.com': (url) => {
        if (url.endsWith('zh-CN.json')) return dictText();
        throw new Error('HTTP 404');
      },
      // 第 2 个源（jsDelivr）：两份都在
      'cdn.jsdelivr.net': (url) => (url.endsWith('zh-CN.json') ? dictText() : profileText()),
      'gitee.com': (url) => (url.endsWith('zh-CN.json') ? dictText() : profileText()),
    },
    calls
  );

  const pair = await dictSync.fetchPair(VERSION, { fetch });
  assert.strictEqual(pair.version, VERSION);
  assert.ok(pair.dictText.includes('你好'));
  // 档案文本是经 version-profile 校验后的规范化 JSON（写盘/比对都用这份）
  assert.strictEqual(JSON.parse(pair.profileText).version, VERSION);
  assert.ok(calls.some((u) => u.includes('cdn.jsdelivr.net')), '应从第二个源成功');
  assert.ok(calls.filter((u) => u.includes('raw.githubusercontent.com')).length === 2, '第一个源两次请求（字典+档案）');
});

test('fetchPair：全源失败 → 错误逐源写清缺哪一份', async () => {
  const fetch = fakeFetch({
    'raw.githubusercontent.com': (url) => {
      if (url.endsWith('zh-CN.json')) return dictText();
      throw new Error('HTTP 404');
    },
    'cdn.jsdelivr.net': (url) => {
      if (url.endsWith('zh-CN.json')) throw new Error('连接超时');
      return profileText();
    },
    'gitee.com': (url) => {
      if (url.endsWith('zh-CN.json')) throw new Error('连接超时');
      return profileText();
    },
  });

  await assert.rejects(dictSync.fetchPair(VERSION, { fetch }), (e) => {
    assert.match(e.message, /字典与替换逻辑档案/);
    assert.match(e.message, /成对/);
    assert.match(e.message, /raw\.githubusercontent\.com 的替换逻辑档案取不到/, e.message);
    assert.match(e.message, /cdn\.jsdelivr\.net 的字典取不到/, e.message);
    assert.match(e.message, /已尝试 3 个源/);
    return true;
  });
});

test('fetchPair：档案内容非法（版本错配）→ 该源失败，不落盘', async () => {
  const wrongVersion = profileFixture.make('9.9.9');
  const fetch = fakeFetch({
    'raw.githubusercontent.com': (url) => (url.endsWith('zh-CN.json') ? dictText() : JSON.stringify(wrongVersion)),
    'cdn.jsdelivr.net': (url) => (url.endsWith('zh-CN.json') ? dictText() : JSON.stringify(wrongVersion)),
    'gitee.com': (url) => (url.endsWith('zh-CN.json') ? dictText() : JSON.stringify(wrongVersion)),
  });

  await assert.rejects(dictSync.fetchPair(VERSION, { fetch }), (e) => {
    assert.match(e.message, /替换逻辑档案校验失败/);
    assert.match(e.message, /版本/);
    return true;
  });
});

// ============================ writePair ============================

test('writePair：onlyMissing 只补缺的那份，不覆盖用户已有文件', (t) => {
  prepare(t);
  writeFile(dictPath(), dictText({ 'UserOwned': '用户自定义' })); // 用户已有字典
  const pair = { dictText: dictText({ 'Remote': '远端' }), profileText: profileText() };

  const r = dictSync.writePair(VERSION, pair, { onlyMissing: true });
  assert.deepStrictEqual(r.files, [profilePath()], '只应写缺失的档案');
  assert.ok(fs.readFileSync(dictPath(), 'utf8').includes('用户自定义'), '用户字典不被覆盖');
  assert.match(fs.readFileSync(profilePath(), 'utf8'), /"schemaVersion"/);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(dictPath())).filter((f) => f.endsWith('.part')), []);
});

test('writePair：全量覆盖两份；第二次 rename 失败时回滚字典、不留半对', (t) => {
  prepare(t);
  writeFile(dictPath(), dictText({ 'Old': '旧' }));
  const pair = { dictText: dictText({ 'New': '新' }), profileText: profileText() };

  // 用「目标路径是个目录」制造第二次 rename 失败（Windows/POSIX 上文件改名到已存在目录都会失败）
  fs.mkdirSync(profilePath(), { recursive: true });

  assert.throws(
    () => dictSync.writePair(VERSION, pair),
    (e) => {
      assert.match(e.message, /写入 GitHub Desktop 0\.0\.0-sync/);
      assert.match(e.message, /回滚/);
      return true;
    }
  );
  // 已 rename 的字典被回滚成旧内容；不残留 .part；档案目录原样（测试自己清）
  assert.ok(fs.readFileSync(dictPath(), 'utf8').includes('旧'), '字典应回滚为原内容');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(dictPath())).filter((f) => f.endsWith('.part')), []);
  fs.rmSync(profilePath(), { recursive: true, force: true });
});

test('writePair：两份都覆盖且没有 .part 残留', (t) => {
  prepare(t);
  writeFile(dictPath(), dictText({ 'Old': '旧' }));
  writeFile(profilePath(), profileText({ updateControl: true }));
  dictSync.writePair(VERSION, { dictText: dictText({ 'New': '新' }), profileText: profileText() });
  assert.ok(fs.readFileSync(dictPath(), 'utf8').includes('新'));
  // 默认夹具档案的 update-control 是 enabled:false（不带 methodAnchor）；覆盖后不该残留旧档案的启用参数
  assert.ok(!fs.readFileSync(profilePath(), 'utf8').includes('"methodAnchor"'));
  assert.deepStrictEqual(fs.readdirSync(path.dirname(dictPath())).filter((f) => f.endsWith('.part')), []);
});

// ============================ ensureDict ============================

test('ensureDict：本地已成对 → 不联网、不下载', async (t) => {
  prepare(t);
  writeFile(dictPath(), dictText());
  writeFile(profilePath(), profileText());
  let calls = 0;
  const r = await dictSync.ensureDict(VERSION, {
    fetchPair: async () => {
      calls++;
      throw new Error('不该联网');
    },
  });
  assert.strictEqual(r.source, 'external');
  assert.strictEqual(r.downloaded, false);
  assert.strictEqual(calls, 0);
});

test('ensureDict：本地只有字典 → 联网只补档案（不动用户字典）', async (t) => {
  prepare(t);
  writeFile(dictPath(), dictText({ 'UserOwned': '用户自定义' }));
  const r = await dictSync.ensureDict(VERSION, {
    fetchPair: async () => ({ dictText: dictText({ 'Remote': '远端' }), profileText: profileText(), url: 'stub' }),
  });
  assert.strictEqual(r.source, 'downloaded');
  assert.strictEqual(r.downloaded, true);
  assert.deepStrictEqual(r.files, [profilePath()]);
  assert.ok(fs.readFileSync(dictPath(), 'utf8').includes('用户自定义'));
  assert.ok(fs.existsSync(profilePath()));
});

test('ensureDict：两份都缺 → 都写入；联网失败 → 抛错且不留半对', async (t) => {
  prepare(t);
  let calls = 0;
  const r = await dictSync.ensureDict(VERSION, {
    fetchPair: async () => {
      calls++;
      return { dictText: dictText(), profileText: profileText(), url: 'stub' };
    },
  });
  assert.strictEqual(r.source, 'downloaded');
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(r.files.sort(), [dictPath(), profilePath()].sort());
  assert.strictEqual(versionProfile.pairStatus(VERSION).paired, true);

  scratch.cleanup(VERSION);
  await assert.rejects(
    dictSync.ensureDict(VERSION, {
      fetchPair: async () => {
        throw new Error('断网');
      },
    }),
    /断网/
  );
  assert.strictEqual(versionProfile.pairStatus(VERSION).paired, false, '失败不应留下任何文件');
});

// ============================ syncLatest ============================

test('syncLatest：成对覆盖；内容未变时不动文件（changed=false）', async (t) => {
  prepare(t);
  const pair = { dictText: dictText(), profileText: profileText(), url: 'stub' };
  writeFile(dictPath(), pair.dictText);
  writeFile(profilePath(), pair.profileText);

  let r = await dictSync.syncLatest(VERSION, { fetchPair: async () => pair });
  assert.strictEqual(r.changed, false);
  assert.deepStrictEqual(r.changedFiles, []);

  const next = { ...pair, dictText: dictText({ 'New': '新' }), profileText: profileText({ updateControl: true }) };
  r = await dictSync.syncLatest(VERSION, { fetchPair: async () => next });
  assert.strictEqual(r.changed, true);
  assert.deepStrictEqual(r.changedFiles.sort(), ['patch.json', 'zh-CN.json'].sort());
  assert.ok(fs.readFileSync(dictPath(), 'utf8').includes('新'));
  assert.match(fs.readFileSync(profilePath(), 'utf8'), /"methodAnchor"/);
});
