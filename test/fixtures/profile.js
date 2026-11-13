// test/fixtures/profile.js — 替换逻辑档案（dictionaries/<版本>/patch.json）的测试夹具
//
// patch / restore / verify 的用例都要让引擎吃到一份与夹具产物形态匹配的档案：档案决定
// 「注入到哪、按哪套标签注入、锚点期望几次」，夹具产物则是最小合成替身（见各测试文件里的
// MAIN_EN / MAIN_UPD）。本文件只提供**造档案**的纯函数与落盘助手，不读写真实版本目录。
//
// 版本名一律由用例传入，且都是非三段数字形态的夹具名（与 test/fixtures/scratch.js 的约定
// 一致）。`node --test` 会把 test/ 下所有 .js 当测试文件收集执行，本文件因此会作为一条
// 没有子用例的空跑条目出现（0 失败）——不得有顶层副作用（同 scratch.js）。
'use strict';

const fs = require('fs');
const path = require('path');

const common = require('../../scripts/common');
const versionProfile = require('../../scripts/version-profile');

// 默认注入点锚点：与夹具产物末尾的 `//# sourceMappingURL=` 注释一致（前面带换行，是锚点的
// 一部分——行首定位，避免命中别的注释）。
const DEFAULT_MARKER = '\n//# sourceMappingURL=';
// 默认方法锚点：夹具产物里的 `async checkForUpdates(` 方法（只有需要更新管控的用例才带）。
const DEFAULT_ANCHOR = 'async checkForUpdates(';

// 两平台标签表：与 Electron editMenu 展开项同形（win32 带 & 助记符、macos 不带）。
// 用例关心的是「标签表来自档案」而不是具体文案，故取当前最新版实测值即可。
const DEFAULT_LABELS = {
  windows: {
    undo: '&Undo',
    redo: '&Redo',
    cut: 'Cu&t',
    copy: '&Copy',
    paste: '&Paste',
    delete: 'Delete',
    selectall: 'Select &all',
  },
  macos: {
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    delete: 'Delete',
    selectall: 'Select All',
  },
};

// 造一份档案对象（不落盘）。选项：
//   updateControl  是否声明并启用更新管控（服务该组件的夹具产物需含 async checkForUpdates( 方法）
//   contextMenu    是否启用右键菜单注入（默认 true）
//   marker/anchor  覆盖锚点文本（用来证明参数确实来自档案，而不是注入器写死的默认值）
//   labels         覆盖标签表
function make(version, options = {}) {
  const marker = options.marker || DEFAULT_MARKER;
  const anchor = options.anchor || DEFAULT_ANCHOR;
  const anchors = {
    injectionPoint: { text: marker, file: 'main.js', placement: 'before-last', expected: 1 },
  };
  const injections = {};
  if (options.contextMenu !== false) {
    injections['context-menu'] = {
      enabled: true,
      injectionPoint: 'injectionPoint',
      // 深拷贝：用例会改返回对象（构造非法档案），共享默认表被改会污染同一进程里的后续用例
      labels: JSON.parse(JSON.stringify(options.labels || DEFAULT_LABELS)),
    };
  }
  if (options.updateControl) {
    anchors.checkForUpdates = { text: anchor, file: 'main.js', placement: 'unique', expected: 1 };
    injections['update-control'] = {
      enabled: true,
      injectionPoint: 'injectionPoint',
      methodAnchor: 'checkForUpdates',
    };
  } else {
    // 默认不启用更新管控：多数夹具产物是「没有 checkForUpdates 方法」的最小替身；需要该组的
    // 用例显式打开。disabled 也带 injectionPoint 引用是允许的（validateInjection 只在启用时校验）。
    injections['update-control'] = {
      enabled: false,
      injectionPoint: 'injectionPoint',
      reason: '夹具产物没有更新管控锚点（测试默认不启用）',
    };
  }
  return {
    schemaVersion: versionProfile.SCHEMA_VERSION,
    version,
    generator: 'test/fixtures/profile.js',
    targets: [...common.TARGETS],
    anchors,
    injections,
  };
}

// 直接落盘（**不校验**）：用于「结构非法 / 未知策略」这类要让引擎自己去拒绝的用例。
function writeRaw(version, profile) {
  const file = versionProfile.profileFile(version);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  return file;
}

// make → 生产写入口 writeProfile（顺带覆盖「写入即校验」这条契约）。overwrite 恒开：
// 用例的清理由 test/fixtures/scratch.js 的 isolate/cleanup 负责。
function write(version, options = {}) {
  return versionProfile.writeProfile(version, make(version, options), { overwrite: true });
}

module.exports = { make, write, writeRaw, DEFAULT_LABELS, DEFAULT_MARKER, DEFAULT_ANCHOR };
