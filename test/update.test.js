// 工具自更新（scripts/update.js）单测：挑附件 + 下载直链两条口径
//
// 这条链路挑错的代价不是「少个功能」——下载错东西会去替换用户手里的工具本身。2026-09-20
// 真机复现过一个从 v0.1.1 起就存在的失效：GitHub 的资产对象有两个地址，`url` 是 **API 端点**
//（少了 `Accept: application/octet-stream` 只回元数据 JSON），`browser_download_url` 才是二进制
// 直链；老代码把前者当下载地址，于是自更新下的永远是几十 KB 的 JSON，被文件头护栏拦下——
// 工具没被写坏，但更新**从来没装成过**。这里把「挑哪个名字」与「从哪个地址下」两件事都钉住。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const net = require('../scripts/net.js');
const { pickAsset, pickGuiAsset, pickSums, parseSums, verifySha256 } = require('../scripts/update.js');

// v1.1.3 发布页的命名（cli / gui 两套，见 `docs/agents/发版.md` 的「产物命名」）：
// 平台词 v1.1.3 起 mac 侧用 macos（darwin 是 v1.1.2 及更早的旧词，工具要能从两边都更新）
const CLI = [
  'github-desktop-zh-cn-cli-v0.4.0-macos-arm64.bin',
  'github-desktop-zh-cn-cli-v0.4.0-macos-x64.bin',
  'github-desktop-zh-cn-cli-v0.4.0-linux-x64.bin',
  'github-desktop-zh-cn-cli-v0.4.0-win32-x64.exe',
];
const GUI = [
  'github-desktop-zh-cn-gui-v0.4.0-macos-arm64.dmg',
  'github-desktop-zh-cn-gui-v0.4.0-macos-x64.dmg',
  'github-desktop-zh-cn-gui-v0.4.0-linux-amd64.deb',
  'github-desktop-zh-cn-gui-v0.4.0-linux-x86_64.AppImage',
  'github-desktop-zh-cn-gui-v0.4.0-win32-x64-setup.exe',
  'github-desktop-zh-cn-gui-v0.4.0-win32-x64.7z', // 免安装包：随 Release 分发，但不走自动更新
];
// 过渡期 Release 的 mac 附件是双名字（macos + darwin 各一份，见 build.yml 的 TRANSITION_DARWIN_ALIASES）
const CLI_LEGACY_DARWIN = [
  'github-desktop-zh-cn-cli-v0.4.0-darwin-arm64.bin',
  'github-desktop-zh-cn-cli-v0.4.0-darwin-x64.bin',
];
const GUI_LEGACY_DARWIN = [
  'github-desktop-zh-cn-gui-v0.4.0-darwin-arm64.dmg',
  'github-desktop-zh-cn-gui-v0.4.0-darwin-x64.dmg',
];
const OTHER = ['SHA256SUMS'];

const DIRECT = (name) => `https://github.com/lldwb/github-desktop-zh-cn/releases/download/v0.4.0/${name}`;
const API = (name) => `https://api.github.com/repos/lldwb/github-desktop-zh-cn/releases/assets/${name.length}${name.charCodeAt(0)}`;

// GitHub 的资产对象：两个地址都在（url 是 API 端点，browser_download_url 是直链）
function asGitHubAsset(name) {
  return { name, size: 12345, url: API(name), browser_download_url: DIRECT(name) };
}
function githubAssets() {
  return [...CLI, ...GUI, ...OTHER].map(asGitHubAsset);
}

// Gitee 的资产对象：实测只有 name 与 browser_download_url（连 url 都没有），另有自动生成的源码包
function giteeAssets() {
  return [
    ...['v0.4.0.zip', 'v0.4.0.tar.gz'].map((name) => ({
      name,
      browser_download_url: `https://gitee.com/lldwb/github-desktop-zh-cn/archive/refs/tags/${name}`,
    })),
    ...[...CLI, ...GUI].map((name) => ({
      name,
      browser_download_url: `https://gitee.com/lldwb/github-desktop-zh-cn/releases/download/v0.4.0/${name}`,
    })),
  ];
}

// pick 函数都是**调用时**读 process.platform / process.arch，故伪装只在这一小段里生效
function on(platform, arch, fn) {
  const saved = { platform: process.platform, arch: process.arch };
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: saved.platform, configurable: true });
    Object.defineProperty(process, 'arch', { value: saved.arch, configurable: true });
  }
}

test('pickAsset：四个平台各挑本平台的 cli 产物，且 url 是下载直链（不是 API 端点）', () => {
  const want = {
    'win32-x64': CLI[3],
    'darwin-arm64': CLI[0],
    'darwin-x64': CLI[1],
    'linux-x64': CLI[2],
  };
  for (const [key, name] of Object.entries(want)) {
    const [platform, arch] = key.split('-');
    const got = on(platform, arch, () => pickAsset(githubAssets()));
    assert.ok(got, `${key} 应当挑到附件`);
    assert.strictEqual(got.name, name, key);
    // 这条是 2026-09-20 那个 bug 的回归点：API 端点少了 accept 头只回元数据 JSON
    assert.strictEqual(got.url, DIRECT(name), `${key} 的 url 应当是下载直链`);
    assert.ok(!got.url.includes('api.github.com'), `${key} 不该把 API 端点当下载地址`);
    assert.strictEqual(got.size, 12345, '其它字段照旧带出来');
  }
});

test('pickAsset：压缩包 / 安装包 / 校验和都不算可执行产物', () => {
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'x64']]) {
    const got = on(platform, arch, () => pickAsset(githubAssets()));
    assert.ok(got.name.includes('-cli-'), `${platform}-${arch} 挑的不是 cli 产物：${got.name}`);
    assert.ok(!/\.(7z|zip|dmg|deb|AppImage|txt)$/.test(got.name), `${platform}-${arch} 挑中了非可执行产物：${got.name}`);
  }
});

test('pickGuiAsset：只挑能被直接装起来的那种（win32 是 -setup.exe，7z 免安装包不算）', () => {
  const win = on('win32', 'x64', () => pickGuiAsset(githubAssets()));
  assert.strictEqual(win.name, 'github-desktop-zh-cn-gui-v0.4.0-win32-x64-setup.exe');
  assert.strictEqual(win.url, DIRECT(win.name));

  for (const [arch, name] of [['arm64', GUI[0]], ['x64', GUI[1]]]) {
    const got = on('darwin', arch, () => pickGuiAsset(githubAssets()));
    assert.strictEqual(got.name, name, `darwin-${arch}`);
    assert.strictEqual(got.url, DIRECT(name));
  }

  // electron-builder 把 Linux 的 x64 写成 x86_64 / amd64 两种，两个都得认
  const linux = on('linux', 'x64', () => pickGuiAsset(githubAssets()));
  assert.ok([GUI[2], GUI[3]].includes(linux.name), `linux-x64 挑的不是安装包：${linux.name}`);
  assert.strictEqual(linux.url, DIRECT(linux.name));
});

test('mac 平台词：新 Release 只有 macos 名时挑得中，macos 与 darwin 并存时优先 macos', () => {
  // 过渡期：同一份产物挂 macos / darwin 两个名字——只挑 macos 那份，别拿到重复的 darwin 拷贝
  const both = on('darwin', 'arm64', () => pickAsset([...CLI_LEGACY_DARWIN, ...CLI, ...GUI_LEGACY_DARWIN, ...GUI].map(asGitHubAsset)));
  assert.strictEqual(both.name, CLI[0]);
  const bothGui = on('darwin', 'arm64', () => pickGuiAsset([...GUI_LEGACY_DARWIN, ...GUI, ...CLI_LEGACY_DARWIN, ...CLI].map(asGitHubAsset)));
  assert.strictEqual(bothGui.name, GUI[0]);

  // 下一版：Release 上只剩 macos 名（过渡结束）——新工具照样挑得中
  const macosOnly = on('darwin', 'x64', () => pickAsset([...CLI, ...GUI, ...OTHER].map(asGitHubAsset)));
  assert.strictEqual(macosOnly.name, CLI[1]);
});

test('mac 平台词：旧 Release 只有 darwin 名时也能更新（darwin 兜底）', () => {
  const cli = on('darwin', 'arm64', () => pickAsset([...CLI_LEGACY_DARWIN, ...GUI_LEGACY_DARWIN].map(asGitHubAsset)));
  assert.strictEqual(cli.name, CLI_LEGACY_DARWIN[0]);
  const gui = on('darwin', 'x64', () => pickGuiAsset([...CLI_LEGACY_DARWIN, ...GUI_LEGACY_DARWIN].map(asGitHubAsset)));
  assert.strictEqual(gui.name, GUI_LEGACY_DARWIN[1]);
  assert.strictEqual(gui.url, DIRECT(GUI_LEGACY_DARWIN[1]));
});

test('Gitee 形态（只有 browser_download_url）也拿得到直链', () => {
  const cli = on('win32', 'x64', () => pickAsset(giteeAssets()));
  const gui = on('win32', 'x64', () => pickGuiAsset(giteeAssets()));
  assert.strictEqual(cli.name, CLI[3]);
  assert.ok(cli.url.startsWith('https://gitee.com/'), `cli 直链没补上：${cli.url}`);
  assert.strictEqual(gui.name, 'github-desktop-zh-cn-gui-v0.4.0-win32-x64-setup.exe');
  assert.ok(gui.url.startsWith('https://gitee.com/'), `gui 直链没补上：${gui.url}`);
  // Gitee 自动附的源码包（v0.4.0.zip / .tar.gz）不该命中任何一个
  assert.ok(!cli.url.includes('archive/refs'), 'cli 不该挑中源码包');
  assert.ok(!gui.url.includes('archive/refs'), 'gui 不该挑中源码包');
});

test('没有本平台产物时返回 null（调用方据此提示「没有本平台产物」）', () => {
  const assets = githubAssets();
  assert.strictEqual(on('linux', 'arm64', () => pickAsset(assets)), null);
  assert.strictEqual(on('linux', 'arm64', () => pickGuiAsset(assets)), null);
  assert.strictEqual(on('win32', 'x64', () => pickAsset([{ name: 'SHA256SUMS', url: API('x') }])), null);
});

// —— SHA256SUMS 校验和 ——
const H1 = '80be9b03ef8d41edfd9257a08bf3453edd12f49890e0d73763410812fe824220'; // v0.4.0 发布清单里的真值

test('pickSums：取清单的下载直链，没有就 null（Gitee 的发行版不带附件）', () => {
  const url = pickSums(githubAssets());
  assert.strictEqual(url, DIRECT('SHA256SUMS'));
  assert.ok(!url.includes('api.github.com'), '不该把 API 端点当下载地址');
  // 名字要精确对上：SHA256SUMS.txt 这类同名后缀不是清单
  assert.strictEqual(pickSums([{ name: 'SHA256SUMS.txt', browser_download_url: 'https://x/y' }]), null);
  assert.strictEqual(pickSums(giteeAssets()), null); // 只有源码包
  assert.strictEqual(pickSums([]), null);
});

test('parseSums：认 sha256sum 的两种写法，忽略空行与杂行', () => {
  const map = parseSums(
    [
      `${H1}  github-desktop-zh-cn-cli-v0.4.0-win32-x64.exe\r`, // CRLF
      `${'c'.repeat(64)} *binary-mode.bin`, // 二进制模式：一个空格加 *
      '', // 空行
      '这一行不是校验和',
      'abcd1234  too-short.bin', // 十六进制位数不够
      `${'A'.repeat(64)}  uppercase-hex.bin`, // 大写十六进制也要认
    ].join('\n')
  );
  assert.strictEqual(map.get('github-desktop-zh-cn-cli-v0.4.0-win32-x64.exe'), H1);
  assert.strictEqual(map.get('binary-mode.bin'), 'c'.repeat(64));
  assert.strictEqual(map.get('uppercase-hex.bin'), 'a'.repeat(64), '大写十六进制应归一成小写');
  assert.strictEqual(map.has('too-short.bin'), false);
  assert.strictEqual(map.size, 3);
});

test('verifySha256：对得上放行，对不上 / 清单里没这个名字都中止，没清单则跳过', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-update-'));
  const file = path.join(dir, 'artifact.bin');
  const body = Buffer.from('假装这是一份很大的产物');
  fs.writeFileSync(file, body);
  const real = crypto.createHash('sha256').update(body).digest('hex');

  const realGet = net.get; // 打桩：这一步只验比对逻辑，不去碰网络
  try {
    net.get = async () => `${real}  artifact.bin\n${'0'.repeat(64)}  other.bin\n`;
    assert.strictEqual(await verifySha256(file, 'artifact.bin', 'https://example.invalid/SHA256SUMS'), true);

    // 清单在手，却没有这个名字 → 下到的东西不是这次发布的那份
    await assert.rejects(
      () => verifySha256(file, 'missing.bin', 'https://example.invalid/SHA256SUMS'),
      /SHA256SUMS 里没有 missing\.bin/
    );

    // 清单说的是另一份字节（下载被中间层改写 / 只落了一半）
    net.get = async () => `${'1'.repeat(64)}  artifact.bin\n`;
    await assert.rejects(() => verifySha256(file, 'artifact.bin', 'https://example.invalid/SHA256SUMS'), /校验和不符/);

    // 来源没有清单（Gitee 只发正文）→ 跳过而不是拒绝更新
    assert.strictEqual(await verifySha256(file, 'artifact.bin', null), false);
  } finally {
    net.get = realGet;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
