// build/after-pack.js — electron-builder afterPack 钩子：打包后精简 Electron 运行时
//
// 删掉这三样，汉化工具都用不到（清单按 win-unpacked 实测选定，删后已实测：
// 窗口正常创建、进程稳定运行、汉化/还原/字典同步不受影响）：
//   vk_swiftshader.dll / vk_swiftshader_icd.json — Vulkan 软渲染，无 GPU 时的兜底渲染路径，
//     本应用界面是自绘 HTML，走系统默认渲染即可
//   dxcompiler.dll — DirectX Shader Compiler，WebGPU / ANGLE 编译 HLSL 用
// 共约 31 MB 未压缩（NSIS 里约 8 MB，LZMA 对这两个大 dll 的压缩率高于 zip）。
//
// 只处理 Windows：macOS / Linux 的对应组件语义与布局不同（如 libvk_swiftshader.so），
// 需在各自平台实测后再加，清单不照搬（三平台共用的 locales 裁剪在 electron-builder.yml 的
// electronLanguages，那份是官方配置，各平台均生效）。
'use strict';

// 相对 appOutDir（win-unpacked 根）的文件名；不存在的静默跳过——Electron 升级换了文件名时
// 这里应该「少删」而不是让构建失败，体积回涨由 check-gui-dist 的体积报告提示。
const REMOVE = ['vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'dxcompiler.dll'];

exports.default = async function (context) {
  if (process.platform !== 'win32') return;
  const fs = require('fs');
  const path = require('path');
  for (const name of REMOVE) {
    const p = path.join(context.appOutDir, name);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`afterPack: 已删除 ${name}`);
    }
  }
};
