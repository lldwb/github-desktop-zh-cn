// 产物命名回归（原 tools/ops/check-naming.cjs 的断言，迁入 npm test 后由 CI 一并跑）：
// cli / gui 两套命名下，scripts/update.js 的 pickAsset 只挑中单文件（cli）产物、
// pickGuiAsset 只挑中图形界面（gui）产物。用假 assets 列表（GUI 附件排在前面，模拟真实
// Release 的乱序）只调这两个纯函数——不联网、不落盘。
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { pickAsset, pickGuiAsset } = require('../../scripts/update.js');

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

// 模拟 Gitee 的资产对象（只有 name 与 browser_download_url，没有 url）——两个 pick 函数
// 都要把直链补进 url 字段，否则下游 apply / 下载会拿到 undefined
const assets = (names) => names.map((name) => ({ name, browser_download_url: `https://example.invalid/${name}` }));

const CASES = [
  {
    title: 'win32-x64：cli 只挑 cli 产物，gui 只挑 setup.exe（7z 免安装包两个通道都不认）',
    platform: 'win32',
    arch: 'x64',
    // GUI 排在前面：若后缀匹配不严，会先挑中图形界面产物。
    // 自 v0.3.0 起 Windows 的免安装包是 7z（替代 zip），它**不能**被挑中——
    // installGuiUpdate 在 Windows 上是直接 spawn 下载下来的文件，7z 跑不起来。
    names: [
      'github-desktop-zh-cn-gui-v0.2.0-win32-x64.7z',
      'github-desktop-zh-cn-gui-v0.2.0-win32-x64-setup.exe',
      'github-desktop-zh-cn-cli-v0.2.0-win32-x64.exe',
      'SHA256SUMS',
    ],
    want: 'github-desktop-zh-cn-cli-v0.2.0-win32-x64.exe',
    wantGui: 'github-desktop-zh-cn-gui-v0.2.0-win32-x64-setup.exe',
  },
  {
    // macOS 自 v0.3.0 起只出 dmg，不再有 zip 附件；平台词 v1.1.3 起是 macos（darwin 是旧词）
    title: 'darwin-arm64：cli 认 .bin、gui 认 dmg（macos 平台词，v1.1.3 起）',
    platform: 'darwin',
    arch: 'arm64',
    names: [
      'github-desktop-zh-cn-gui-v0.2.0-macos-arm64.dmg',
      'github-desktop-zh-cn-cli-v0.2.0-macos-arm64.bin',
      'SHA256SUMS',
    ],
    want: 'github-desktop-zh-cn-cli-v0.2.0-macos-arm64.bin',
    wantGui: 'github-desktop-zh-cn-gui-v0.2.0-macos-arm64.dmg',
  },
  {
    // 反向用例：旧版本留下的 mac zip 附件（若还在某个老 Release 里）也不能被挑中——
    // 现在的产物形态是 dmg，挑 zip 等于把已废弃的形态当成有效路径
    title: 'darwin-arm64：只剩废弃的 mac zip 附件时，两个通道都返回 null',
    platform: 'darwin',
    arch: 'arm64',
    names: ['github-desktop-zh-cn-gui-v0.2.0-darwin-arm64.zip', 'SHA256SUMS'],
    want: null,
    wantGui: null,
  },
  {
    // 兼容：v0.1.x 的无后缀老产物（旧版本来更新时仍要挑得中）
    title: 'darwin-arm64：v0.1.x 的无后缀老 cli 产物仍挑得中',
    platform: 'darwin',
    arch: 'arm64',
    names: ['github-desktop-zh-cn-gui-v0.2.0-macos-arm64.dmg', 'github-desktop-zh-cn-v0.1.1-darwin-arm64'],
    want: 'github-desktop-zh-cn-v0.1.1-darwin-arm64',
    wantGui: 'github-desktop-zh-cn-gui-v0.2.0-macos-arm64.dmg',
  },
  {
    // 平台词过渡：v1.1.2 及更早装出去的工具只会发 darwin 词的附件名匹配——过渡期 Release
    // 同一份产物挂 macos / darwin 两个名字，macos 在前优先（见 build.yml 的 TRANSITION_DARWIN_ALIASES）
    title: 'darwin-x64：过渡期 macos / darwin 双名字并存时只挑 macos 那份',
    platform: 'darwin',
    arch: 'x64',
    names: [
      'github-desktop-zh-cn-gui-v1.1.3-darwin-x64.dmg',
      'github-desktop-zh-cn-gui-v1.1.3-macos-x64.dmg',
      'github-desktop-zh-cn-cli-v1.1.3-darwin-x64.bin',
      'github-desktop-zh-cn-cli-v1.1.3-macos-x64.bin',
      'SHA256SUMS',
    ],
    want: 'github-desktop-zh-cn-cli-v1.1.3-macos-x64.bin',
    wantGui: 'github-desktop-zh-cn-gui-v1.1.3-macos-x64.dmg',
  },
  {
    // 反向兜底：过渡结束后 Release 上只剩 darwin 名的老版本，新工具仍要挑得中
    title: 'darwin-arm64：只剩 darwin 旧词的 Release 也能挑中（兜底旧版本）',
    platform: 'darwin',
    arch: 'arm64',
    names: [
      'github-desktop-zh-cn-gui-v1.1.2-darwin-arm64.dmg',
      'github-desktop-zh-cn-cli-v1.1.2-darwin-arm64.bin',
      'SHA256SUMS',
    ],
    want: 'github-desktop-zh-cn-cli-v1.1.2-darwin-arm64.bin',
    wantGui: 'github-desktop-zh-cn-gui-v1.1.2-darwin-arm64.dmg',
  },
  {
    // Linux 的 GUI 产物用 x86_64 / amd64 而不是 Node 的 x64——三套写法都得认，
    // 否则 Linux 用户永远找不到自己的安装包（cli 产物是自己命名的，不受影响）
    title: 'linux-x64：gui 的 x86_64 / amd64 写法都要认（cli 不受影响）',
    platform: 'linux',
    arch: 'x64',
    names: [
      'github-desktop-zh-cn-gui-v0.2.0-linux-x86_64.AppImage',
      'github-desktop-zh-cn-gui-v0.2.0-linux-amd64.deb',
      'github-desktop-zh-cn-cli-v0.2.0-linux-x64.bin',
      'SHA256SUMS',
    ],
    want: 'github-desktop-zh-cn-cli-v0.2.0-linux-x64.bin',
    wantGui: 'github-desktop-zh-cn-gui-v0.2.0-linux-x86_64.AppImage',
  },
  {
    // 反向用例：本平台确实没有产物时必须是 null，不能随手抓一个别的平台的回来
    title: 'linux-arm64：本平台没有产物时返回 null（不许抓别的平台的）',
    platform: 'linux',
    arch: 'arm64',
    names: ['github-desktop-zh-cn-cli-v0.2.0-linux-x64.bin', 'github-desktop-zh-cn-gui-v0.2.0-darwin-arm64.dmg'],
    want: null,
    wantGui: null,
  },
  {
    // 反向用例：列表里只有 cli 产物时，pickGuiAsset 不能把 cli 当安装包
    title: 'win32-x64：列表里只有 cli 产物时，pickGuiAsset 不能把 cli 当安装包',
    platform: 'win32',
    arch: 'x64',
    names: ['github-desktop-zh-cn-cli-v0.2.0-win32-x64.exe'],
    want: 'github-desktop-zh-cn-cli-v0.2.0-win32-x64.exe',
    wantGui: null,
  },
];

for (const c of CASES) {
  test(`pickAsset / pickGuiAsset：${c.title}`, () => {
    const list = assets(c.names);
    const gotCli = on(c.platform, c.arch, () => pickAsset(list));
    const gotGui = on(c.platform, c.arch, () => pickGuiAsset(list));

    assert.strictEqual(gotCli && gotCli.name, c.want, `cli 通道应挑 ${c.want}，实得 ${gotCli && gotCli.name}`);
    assert.strictEqual(gotGui && gotGui.name, c.wantGui, `gui 通道应挑 ${c.wantGui}，实得 ${gotGui && gotGui.name}`);
    // Gitee 的资产对象没有 url，两个函数都要把 browser_download_url 补进去
    if (gotCli) assert.ok(gotCli.url, 'cli 资产的 url 没补上');
    if (gotGui) assert.ok(gotGui.url, 'gui 资产的 url 没补上');
  });
}
