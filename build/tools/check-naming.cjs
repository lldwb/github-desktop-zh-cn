// 探针：cli / gui 两套命名下，update.js 的 pickAsset 只挑中单文件（cli）产物、
// pickGuiAsset 只挑中图形界面（gui）产物
// 用假 assets 列表（GUI 附件排在前面，模拟真实 Release 的乱序），只调纯函数，不联网
'use strict';
const { pickAsset, pickGuiAsset } = require('../../scripts/update.js');

const cases = [
  {
    platform: 'win32',
    arch: 'x64',
    // GUI 排在前面：若后缀匹配不严，会先挑中图形界面产物
    assets: [
      'github-desktop-zh-cn-gui-v0.2.0-win32-x64.zip',
      'github-desktop-zh-cn-gui-v0.2.0-win32-x64-setup.exe',
      'github-desktop-zh-cn-cli-v0.2.0-win32-x64.exe',
      'SHA256SUMS',
    ],
    want: 'github-desktop-zh-cn-cli-v0.2.0-win32-x64.exe',
    wantGui: 'github-desktop-zh-cn-gui-v0.2.0-win32-x64-setup.exe',
  },
  {
    platform: 'darwin',
    arch: 'arm64',
    assets: [
      'github-desktop-zh-cn-gui-v0.2.0-darwin-arm64.dmg',
      'github-desktop-zh-cn-gui-v0.2.0-darwin-arm64.zip',
      'github-desktop-zh-cn-cli-v0.2.0-darwin-arm64.bin',
      'SHA256SUMS',
    ],
    want: 'github-desktop-zh-cn-cli-v0.2.0-darwin-arm64.bin',
    wantGui: 'github-desktop-zh-cn-gui-v0.2.0-darwin-arm64.dmg',
  },
  {
    // 兼容：v0.1.x 的无后缀老产物（旧版本来更新时仍要挑得中）
    platform: 'darwin',
    arch: 'arm64',
    assets: ['github-desktop-zh-cn-gui-v0.2.0-darwin-arm64.dmg', 'github-desktop-zh-cn-v0.1.1-darwin-arm64'],
    want: 'github-desktop-zh-cn-v0.1.1-darwin-arm64',
    wantGui: 'github-desktop-zh-cn-gui-v0.2.0-darwin-arm64.dmg',
  },
  {
    // Linux 的 GUI 产物用 x86_64 / amd64 而不是 Node 的 x64——三套写法都得认，
    // 否则 Linux 用户永远找不到自己的安装包（cli 产物是自己命名的，不受影响）
    platform: 'linux',
    arch: 'x64',
    assets: [
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
    platform: 'linux',
    arch: 'arm64',
    assets: ['github-desktop-zh-cn-cli-v0.2.0-linux-x64.bin', 'github-desktop-zh-cn-gui-v0.2.0-darwin-arm64.dmg'],
    want: null,
    wantGui: null,
  },
  {
    // 反向用例：列表里只有 cli 产物时，pickGuiAsset 不能把 cli 当安装包
    platform: 'win32',
    arch: 'x64',
    assets: ['github-desktop-zh-cn-cli-v0.2.0-win32-x64.exe'],
    want: 'github-desktop-zh-cn-cli-v0.2.0-win32-x64.exe',
    wantGui: null,
  },
];

let failed = 0;
for (const c of cases) {
  const realPlatform = process.platform;
  const realArch = process.arch;
  Object.defineProperty(process, 'platform', { value: c.platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: c.arch, configurable: true });
  // 模拟 Gitee 的资产对象（只有 name 与 browser_download_url，没有 url）——两个 pick 函数
  // 都要把直链补进 url 字段，否则下游 apply / 下载会拿到 undefined
  const assets = c.assets.map((name) => ({ name, browser_download_url: `https://example.invalid/${name}` }));
  const gotCli = pickAsset(assets);
  const gotGui = pickGuiAsset(assets);
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  Object.defineProperty(process, 'arch', { value: realArch, configurable: true });

  const cliName = gotCli ? gotCli.name : null;
  const guiName = gotGui ? gotGui.name : null;
  const okCli = cliName === c.want;
  const okGui = guiName === c.wantGui;
  if (!okCli) failed++;
  if (!okGui) failed++;
  console.log(`${c.platform}-${c.arch}`);
  console.log(`  ${okCli ? '✓' : '✗'} cli → ${cliName}${okCli ? '' : `（应为 ${c.want}）`}`);
  console.log(`  ${okGui ? '✓' : '✗'} gui → ${guiName}${okGui ? '' : `（应为 ${c.wantGui}）`}`);
  // Gitee 的资产对象没有 url，两个函数都要把 browser_download_url 补进去
  if (gotCli && !gotCli.url) { console.log('  ✗ cli 资产的 url 没补上'); failed++; }
  if (gotGui && !gotGui.url) { console.log('  ✗ gui 资产的 url 没补上'); failed++; }
}
console.log(failed ? `\n探针未通过：${failed} 项` : '\n探针通过');
process.exit(failed ? 1 : 0);
