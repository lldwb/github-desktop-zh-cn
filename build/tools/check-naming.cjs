// 探针：cli / gui 两套命名下，update.js 的 pickAsset 是否仍只挑中单文件（cli）产物
// 用假 assets 列表（GUI 附件排在前面，模拟真实 Release 的乱序），只调纯函数，不联网
'use strict';
const { pickAsset } = require('../../scripts/update.js');

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
  },
  {
    // 兼容：v0.1.x 的无后缀老产物（旧版本来更新时仍要挑得中）
    platform: 'darwin',
    arch: 'arm64',
    assets: ['github-desktop-zh-cn-gui-v0.2.0-darwin-arm64.dmg', 'github-desktop-zh-cn-v0.1.1-darwin-arm64'],
    want: 'github-desktop-zh-cn-v0.1.1-darwin-arm64',
  },
  {
    platform: 'linux',
    arch: 'x64',
    assets: [
      'github-desktop-zh-cn-gui-v0.2.0-linux-x86_64.AppImage',
      'github-desktop-zh-cn-gui-v0.2.0-linux-amd64.deb',
      'github-desktop-zh-cn-cli-v0.2.0-linux-x64.bin',
      'SHA256SUMS',
    ],
    want: 'github-desktop-zh-cn-cli-v0.2.0-linux-x64.bin',
  },
  {
    // 反向用例：本平台确实没有产物时必须是 null，不能随手抓一个别的平台的回来
    platform: 'linux',
    arch: 'arm64',
    assets: ['github-desktop-zh-cn-cli-v0.2.0-linux-x64.bin', 'github-desktop-zh-cn-gui-v0.2.0-darwin-arm64.dmg'],
    want: null,
  },
];

let failed = 0;
for (const c of cases) {
  const realPlatform = process.platform;
  const realArch = process.arch;
  Object.defineProperty(process, 'platform', { value: c.platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: c.arch, configurable: true });
  const got = pickAsset(c.assets.map((name) => ({ name })));
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  Object.defineProperty(process, 'arch', { value: realArch, configurable: true });

  const gotName = got ? got.name : null;
  const pass = gotName === c.want;
  if (!pass) failed++;
  console.log(`${pass ? '  ✓' : '  ✗'} ${c.platform}-${c.arch} → ${gotName}${pass ? '' : `（应为 ${c.want}）`}`);
}
console.log(failed ? `\n探针未通过：${failed} 项` : '\n探针通过');
process.exit(failed ? 1 : 0);
