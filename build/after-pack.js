// build/after-pack.js — electron-builder afterPack 钩子：打包后精简 Electron 运行时
//
// 删的都是「无 GPU 时的软渲染 / 着色器编译」路径——本应用界面是自绘 HTML，走系统默认渲染即可。
// 清单按各平台官方发行包实测选定（文件名与体积来自中央目录，未压缩 / 压缩后）：
//   Windows  vk_swiftshader.dll      5.3 / 2.1 MB   Vulkan 软渲染
//            vk_swiftshader_icd.json  ~0           它的 ICD 注册文件
//            dxcompiler.dll          24.6 / 9.7 MB  DirectX Shader Compiler（WebGPU / ANGLE 编 HLSL）
//   macOS    Libraries/libvk_swiftshader.dylib  15.8 / 6.3 MB（各平台里最大的一块软渲染）
//            Libraries/vk_swiftshader_icd.json
//   Linux    libvk_swiftshader.so    4.4 / 1.7 MB
//            vk_swiftshader_icd.json
// macOS 除软渲染外没有 dxcompiler（DirectX 专属，发行包里本就不存在）。
//
// 删掉后能不能起，靠两道验证：CI 四平台 runner **都没有 GPU**，正好打在「软渲染没了还有没有
// 回退路径」这条风险链上（gui/main.js 的 --smoke-test，见 .github/workflows/build.yml 的冒烟
// 步骤）；Windows 另有本机实机验证（窗口正常创建、进程稳定、汉化 / 还原 / 字典同步不受影响）。
//
// 刻意不动的：
//   ffmpeg（ffmpeg.dll / libffmpeg.so / libffmpeg.dylib）——音视频解码，收益小且语义上不该碰；
//   Linux 的 libvulkan.so.1——Vulkan loader（0.6 MB），删它影响面比删实现大，不值。
//
// 文件名按「目标平台」取（context.electronPlatformName），不是宿主：本仓库不做交叉构建，
// 但按目标平台判定语义更对。文件不存在时静默跳过——Electron 升级换了文件名时应是「少删」
// 而不是让构建失败，体积回涨由 check-gui-dist 的体积报告提示。
'use strict';

const REMOVE = {
  win32: ['vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'dxcompiler.dll'],
  darwin: [
    'Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libvk_swiftshader.dylib',
    'Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/vk_swiftshader_icd.json',
  ],
  linux: ['libvk_swiftshader.so', 'vk_swiftshader_icd.json'],
};

exports.default = async function (context) {
  const fs = require('fs');
  const path = require('path');
  const list = REMOVE[context.electronPlatformName] || [];
  if (!list.length) return;

  // macOS 的文件在 .app 包内，Windows / Linux 的直接在 appOutDir 根。
  // .app 的名字**扫出来**而不是拼 productName——本仓库设了 executableName，mac 产物的包名
  // 是 GitHubDesktopZhTool.app（CI 实测），拼 productName 会拼出中文名找不到目录。
  let prefix = '';
  if (context.electronPlatformName === 'darwin') {
    const appEntry = fs.readdirSync(context.appOutDir).find((f) => f.endsWith('.app'));
    if (!appEntry) {
      console.log('afterPack: 没找到 .app，跳过运行时裁剪');
      return;
    }
    prefix = appEntry;
  }

  for (const rel of list) {
    const p = path.join(context.appOutDir, prefix, rel);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`afterPack: 已删除 ${rel}`);
    }
  }
};
