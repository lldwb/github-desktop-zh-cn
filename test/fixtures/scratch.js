// test/fixtures/scratch.js — 测试夹具的唯一约定源（重构契约 §4.4）
//
// 为什么夹具数据不放在本目录下：字典路径由生产侧 SSOT 决定
// （`common.dictFile(版本)` = `<数据根>/dictionaries/<版本>/zh-CN.json`），而 dict-edit 的公开
// API 只接受版本号、没有 root 参数——在不给生产代码新增参数或开关的前提下，夹具目录只能落在
// `dictionaries/<夹具版本>/`。故本文件提供的是「约定」而不是目录本身：唯一的夹具版本号、
// 按同一个 SSOT 推导出来的清理，以及读真实 `dictionaries/` 时必须用的形态过滤常量。
//
// 注意：`npm test`（= 裸 `node --test`）会把 `test/` 下**任意深度**的 .js 都当测试文件收集执行，
// 本文件因此会作为一条没有子用例的空跑条目出现在结果里（0 失败）。所以**不得引入任何顶层副作用**。
'use strict';

const fs = require('fs');
const path = require('path');

const common = require('../../scripts/common');

// 夹具版本号：全仓唯一一处定义（test/dict/** 与 test/inject/** 都从这里取）。
// 形态刻意不是 X.Y.Z——生产侧的 common.DICT_VERSION_RE 不会把它当真实版本，与之并行的
// 其它测试文件按形态过滤即可完全忽略它的存在窗口（见 `docs/agents/已知坑.md` 一条）。
// 例外：测试用例里作为**断言载荷**出现的同名字面量不算「定义」，其值受「断言不改」保护。
const FIXTURE_VERSION = '0.0.0-test';

// 目录名形态过滤：真实字典版本 = 三段数字。与生产侧同源（common.DICT_VERSION_RE），
// 测试侧不另写一份正则——夹具的「建」与「读」两半必须用同一套判据，分开写迟早漂移。
const VERSION_RE = common.DICT_VERSION_RE;

// 夹具目录的父目录 = <数据根>/dictionaries：仍由 SSOT 反推，不自行拼 __dirname。
function dictRoot() {
  return path.dirname(path.dirname(common.dictFile(FIXTURE_VERSION)));
}

// 门禁：算出删除目标，并要求它**必须是 dictionaries/ 的直接子目录、名字不是真实版本形态**。
// 挡的不是「多写了一个形参」，而是误传即毁数据的默认杀伤半径——
//   cleanup('3.6.6') → 真实字典目录；cleanup('') → 整个 dictionaries/；cleanup('..') → 仓库根。
// 判据只用生产侧既有常量（common.DICT_VERSION_RE），不新增任何生产 API。
function disposableDir(version) {
  const named = typeof version === 'string' && version !== '';
  const dir = named ? path.dirname(common.dictFile(version)) : '';
  const ok =
    named &&
    version === path.basename(dir) &&
    path.dirname(dir) === dictRoot() &&
    !VERSION_RE.test(version);
  if (!ok) {
    throw new Error(
      `夹具清理只许删非版本形态的目录：拒绝 "${String(version)}"` +
        (dir ? `（删除目标解析为 ${dir}）` : '') +
        `。真实版本形态（${VERSION_RE}）与空名、带路径分隔符的名字都不许删；` +
        `合法夹具名形如 ${FIXTURE_VERSION}。`
    );
  }
  return dir;
}

// 清理助手：删掉夹具版本对应的整个目录，幂等（不存在也不报错）。
// 删除目标一律先过 disposableDir() 门禁，路径本身仍来自 common.dictFile() 这个 SSOT。
function cleanup(version = FIXTURE_VERSION) {
  fs.rmSync(disposableDir(version), { recursive: true, force: true });
}

// 用例自带清理的登记方式：包成 t.after，断言失败也不会把夹具留在仓库里。
function isolate(t, version = FIXTURE_VERSION) {
  t.after(() => cleanup(version));
}

module.exports = {
  FIXTURE_VERSION,
  VERSION_RE,
  cleanup,
  isolate,
};
