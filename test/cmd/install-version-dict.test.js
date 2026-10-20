// test/cmd/install-version-dict.test.js — 「切换版本」的字典判定与切换/安装时的字典预取
//
// 背景（2026-09-23，用户报「3.6.7 明明有字典却显示无字典」）：远端 main 上已有
// dictionaries/3.6.7（提交 e9e7146），但本地工作区 / 打包数据根没有；「切换版本」窗口原先只按
// common.listDictVersions() 的**本地**口径判 hasDict，于是把「切过去就能汉化」的版本标成「无字典」。
// 修复后的契约（本文件逐条覆盖）：
//   1. remoteDictVersions：取远端字典**目录列表**（只取列表，显示阶段不下载字典），过滤非版本
//      形态的目录项（README.md / beta / 测试残留），成功结果按 TTL 缓存、失败不缓存；
//   2. listDownloadable：hasDict = 本地有 ∪ 远端有，三态 dictState（local / remote / none）
//      可区分——「远端也没有」不能放宽成有字典；
//   3. 远端列表取不到时降级为本地判断，并把可读原因随 remoteDict 带回（不抛、不阻塞界面）；
//   4. prefetchDict：本地已有不联网；缺则联网取；失败收成 { ok:false, error } 不抛
//      （切换 / 安装成功但提示字典失败，不回滚用户的选择）。
//
// 零网络的保证：所有网络与写盘路径都经注入驱动（fetchJson / listVersions / ensure / dictVersions），
// 不真发请求、不落任何字典文件；夹具形态取自 GitHub contents API（type: 'dir' | 'file'）。
//
// 环境隔离（2026-09-23 补，方案 A 前置）：`listDownloadable` 的「本地有没有字典」一律通过
// `opts.dictVersions` **显式注入**，不读仓库 `dictionaries/` 的真实内容。原因：仓库 checkout 的内容
// 会变——CI / 收尾分支上仓库自带 `dictionaries/3.6.7`，而早期 HEAD 上没有；若测试直读
// `common.listDictVersions()`，同一份代码在两种 checkout 上会得出相反的断言结果（那不是行为回归，
// 是测试变成了「环境断言」）。注入后 local / remote / none 三态语义与产品默认路径完全一致。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const common = require('../../scripts/common');
const dictSync = require('../../scripts/dict/dict-sync');
const installer = require('../../scripts/cmd/install-version');

// 注入用的本地字典集合：本地只有 3.6.6（刻意不含 3.6.7，也不含仓库里可能出现的任何其它版本）。
// 这样「远端有 3.6.7、本地没有」这一被测场景与 checkout 内容无关。
const LOCAL_DICTS = ['3.6.6'];
// 「仓库必然不存在」的版本号：用于落盘断言（任何 checkout 都不会有 9.9.9 的字典文件）
const ABSENT_VERSION = '9.9.9';

// 远端目录列表的条目形态（GitHub contents API 与 Gitee v5 同形）
const dir = (name) => ({ name, type: 'dir', path: `dictionaries/${name}` });
const file = (name) => ({ name, type: 'file', path: `dictionaries/${name}` });

// 官方 Release 列表的替身：只填 listDownloadable 用到的字段，不碰 release-assets 的网络路径
function releaseStub(versions) {
  return async () => ({
    platform: 'windows',
    arch: 'x64',
    versions: versions.map((v) => ({
      version: v,
      assetName: `GitHubDesktop-${v}-x64-full.nupkg`,
      size: 1024,
    })),
  });
}

// ============================ remoteDictVersions ============================

test('remoteDictVersions：只取目录名，非版本形态的项被过滤', async () => {
  const calls = [];
  const r = await dictSync.remoteDictVersions({
    ttlMs: 0, // 不读不写缓存：用例之间不串味
    fetchJson: async (url) => {
      calls.push(url);
      return [dir('3.6.7'), dir('3.6.6'), dir('0.0.0-test'), dir('3.6.6-beta'), file('README.md')];
    },
  });

  assert.strictEqual(r.ok, true, '应成功');
  assert.deepStrictEqual(r.versions, ['3.6.6', '3.6.7'], '只留三段数字形态的目录，并按版本升序');
  // 「显示阶段只取列表、不下载字典」的机械判据：只请求了目录列表地址，没有任何 zh-CN.json 请求
  assert.strictEqual(calls.length, 1, '一次取列表只应发一个请求');
  assert.ok(calls[0].includes('/contents/dictionaries'), calls[0]);
  assert.ok(!calls[0].includes('zh-CN.json'), `显示阶段不该请求字典文件：${calls[0]}`);
});

test('remoteDictVersions：GitHub 失败时自动退到 Gitee 镜像', async () => {
  const calls = [];
  const r = await dictSync.remoteDictVersions({
    ttlMs: 0,
    fetchJson: async (url) => {
      calls.push(url);
      if (calls.length === 1) throw new Error('HTTP 403：api.github.com');
      return [dir('3.6.7')];
    },
  });

  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.versions, ['3.6.7']);
  assert.strictEqual(calls.length, 2, '第一个源失败后应尝试第二个源');
  assert.ok(calls[1].includes('gitee.com'), `第二个源应是 Gitee 镜像：${calls[1]}`);
});

test('remoteDictVersions：全部源失败时降级——不抛错、给可读原因', async () => {
  const r = await dictSync.remoteDictVersions({
    ttlMs: 0,
    fetchJson: async (url) => {
      throw new Error(`连不上 ${new URL(url).host}`);
    },
  });

  assert.strictEqual(r.ok, false, '取不到应返回 ok:false 而不是抛错');
  assert.deepStrictEqual(r.versions, []);
  assert.ok(r.error.includes('未能获取远端字典列表'), r.error);
  assert.ok(r.error.includes('本地'), '降级说明里要讲清「已按本地字典判断」');
  assert.strictEqual(r.failures.length, 2, '两个源的失败原因都要留下（CLI 详列用）');
});

test('remoteDictVersions：返回不是数组时也算失败并降级', async () => {
  const r = await dictSync.remoteDictVersions({
    ttlMs: 0,
    fetchJson: async () => ({ message: 'Not Found' }), // 某些镜像可能回对象
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.failures.some((f) => f.includes('不是目录列表')), JSON.stringify(r.failures));
});

test('remoteDictVersions：成功结果按 TTL 缓存，失败不缓存', async () => {
  let calls = 0;
  const fetchJson = async () => {
    calls++;
    return [dir('3.6.7')];
  };

  const first = await dictSync.remoteDictVersions({ ttlMs: 60000, fetchJson });
  const second = await dictSync.remoteDictVersions({ ttlMs: 60000, fetchJson });
  assert.strictEqual(calls, 1, 'TTL 内第二次调用应命中缓存（不多发 GitHub API 请求）');
  assert.deepStrictEqual(second.versions, first.versions);

  // 失败不进缓存：让上面的成功缓存按 1ms TTL 过期后，两次调用都应重新尝试两个源。
  // （成功缓存项不会在失败时被清掉，故这里靠 TTL 过期而不是靠失败来「清缓存」。）
  await new Promise((r) => setTimeout(r, 10));
  let failCalls = 0;
  const failFetch = async () => {
    failCalls++;
    throw new Error('断网');
  };
  await dictSync.remoteDictVersions({ ttlMs: 1, fetchJson: failFetch });
  await dictSync.remoteDictVersions({ ttlMs: 1, fetchJson: failFetch });
  assert.strictEqual(failCalls, 4, '失败不缓存：两次调用 × 两个源都要重新尝试');
});

// ============================ listDownloadable ============================

test('listDownloadable：hasDict = 本地 ∪ 远端，三态可区分（3.6.7 不再是无字典）', async () => {
  const r = await installer.listDownloadable({
    listVersions: releaseStub(['3.6.7', '3.6.6', '3.6.3']),
    // 本地注入只有 3.6.6（与 checkout 里 dictionaries/ 的真实内容无关）；
    // 远端有 3.6.7；3.6.3 两边都没有 → 覆盖 remote / local / none 三态
    dictVersions: LOCAL_DICTS,
    remoteDict: { ok: true, versions: ['3.6.7'], error: null, failures: [] },
  });

  const byVersion = new Map(r.versions.map((v) => [v.version, v]));
  assert.deepStrictEqual(
    [byVersion.get('3.6.7').dictState, byVersion.get('3.6.7').hasDict],
    ['remote', true],
    '远端有、本地没有 → 字典待下载，但仍算「有字典」'
  );
  assert.deepStrictEqual(
    [byVersion.get('3.6.7').dictLocal, byVersion.get('3.6.7').dictRemote],
    [false, true]
  );
  assert.deepStrictEqual(
    [byVersion.get('3.6.6').dictState, byVersion.get('3.6.6').hasDict],
    ['local', true],
    '本地有 → 直接可用'
  );
  assert.deepStrictEqual(
    [byVersion.get('3.6.3').dictState, byVersion.get('3.6.3').hasDict],
    ['none', false],
    '本地与远端都没有 → 仍是无字典（不能放宽）'
  );

  // 默认视图（「只列有汉化的版本」）的过滤判据：3.6.7 / 3.6.6 在列，3.6.3 不在
  const defaultView = r.versions.filter((v) => v.hasDict).map((v) => v.version);
  assert.deepStrictEqual(defaultView, ['3.6.7', '3.6.6']);
});

test('listDownloadable：远端列表取不到时降级为本地判断，并带回可读原因', async () => {
  const r = await installer.listDownloadable({
    listVersions: releaseStub(['3.6.7', '3.6.6']),
    // 本地注入只有 3.6.6：3.6.7 在「远端未知 + 本地没有」时必须退回 dictState 'none'
    dictVersions: LOCAL_DICTS,
    remoteDict: {
      ok: false,
      versions: [],
      error: '未能获取远端字典列表（已尝试 2 个源），已按本地字典判断',
      failures: ['https://api.github.com/…：断网'],
    },
  });

  assert.strictEqual(r.remoteDict.ok, false, '界面据此显示降级提示');
  assert.ok(r.remoteDict.error.includes('未能获取远端字典列表'));

  const byVersion = new Map(r.versions.map((v) => [v.version, v]));
  assert.strictEqual(byVersion.get('3.6.7').hasDict, false, '远端未知时按本地口径：3.6.7 标无字典');
  assert.strictEqual(byVersion.get('3.6.7').dictState, 'none');
  assert.strictEqual(byVersion.get('3.6.6').hasDict, true, '本地有字典的版本不受降级影响');
});

test('listDownloadable：显示阶段不下载任何字典文件', async () => {
  const fetched = [];
  // 落盘判据用「仓库必然不存在」的版本号：不依赖 checkout 里有没有 3.6.7 字典
  //（早先版本用 3.6.7 + `if (!before)`，仓库自带该字典时断言会被静默跳过，等于放弃判据）。
  const absent = common.dictFile(ABSENT_VERSION);
  assert.strictEqual(fs.existsSync(absent), false, `夹具前提：${ABSENT_VERSION} 的字典文件不应存在`);

  await installer.listDownloadable({
    listVersions: releaseStub([ABSENT_VERSION]),
    dictVersions: [],
    // 用真实的 remoteDictVersions 走一遍，但把唯一的网络出口换成计数桩
    remoteDict: dictSync.remoteDictVersions({
      ttlMs: 0,
      fetchJson: async (url) => {
        fetched.push(url);
        return [dir(ABSENT_VERSION)];
      },
    }),
  });

  // 全部请求都是「目录列表」，没有一个是字典文件
  assert.ok(fetched.length >= 1);
  for (const url of fetched) {
    assert.ok(url.includes('/contents/dictionaries'), url);
    assert.ok(!url.includes('zh-CN.json'), `显示阶段请求了字典文件：${url}`);
  }
  // 落盘判据：只取列表、绝不写盘——调用后该版本字典仍不存在（断言无条件执行）
  assert.strictEqual(fs.existsSync(absent), false, '显示阶段不该落任何字典文件');
});

test('listDownloadable：dict 判定不依赖官方 Release 列表的网络结果结构（防回归）', async () => {
  // 官方列表返回的版本号与远端字典列表互不相关：远端有字典但官方没产物的版本不会出现在列表里
  const r = await installer.listDownloadable({
    listVersions: releaseStub(['3.6.6']),
    dictVersions: LOCAL_DICTS,
    remoteDict: { ok: true, versions: ['3.6.7', '3.6.6'], error: null, failures: [] },
  });
  assert.deepStrictEqual(r.versions.map((v) => v.version), ['3.6.6']);
  assert.strictEqual(r.versions[0].dictState, 'local');
});

// ============================ prefetchDict ============================

test('prefetchDict：本地已有字典 → 不联网、没有下载动作', async () => {
  const r = await dictSync.prefetchDict('3.6.6', {
    ensure: async () => ({ source: 'external', path: '/tmp/x/zh-CN.json', downloaded: false }),
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.downloaded, false);
  assert.strictEqual(r.message, null, '本地已有就不该提示「已自动下载」');
});

test('prefetchDict：本地缺字典 → 联网取一份并给出提示文案', async () => {
  const r = await dictSync.prefetchDict('3.6.7', {
    ensure: async () => ({ source: 'downloaded', path: '/data/3.6.7/zh-CN.json', downloaded: true }),
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.downloaded, true);
  assert.ok(r.message.includes('3.6.7'), r.message);
});

test('prefetchDict：取不到时降级为可读错误、不抛（切换/安装不回滚）', async () => {
  const r = await dictSync.prefetchDict('3.6.7', {
    ensure: async () => {
      throw new Error('无法获取 GitHub Desktop 3.6.7 的字典（已尝试 3 个源）');
    },
  });
  assert.strictEqual(r.ok, false, '失败以返回值表达，而不是抛给调用方把切换判失败');
  assert.ok(r.error.includes('3.6.7'), r.error);
  assert.ok(r.error.includes('已尝试 3 个源'), r.error);
});
