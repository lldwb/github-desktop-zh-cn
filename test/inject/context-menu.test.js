// 右键菜单汉化注入（scripts/inject/context-menu.js）单测
//
// 这段代码是**注入进产物**的：写错的代价不是「少译一句」，而是「GitHub Desktop 起不来」。
// 故把几条底线钉住：注入幂等、除注入块外原文逐字节不变、只用 ES5（这段字符串不转译，对面 Electron
// 的 Node 版本不可控）、标签与字典键必须逐字相同（差一个字就静默不译）。最后在 vm 里用一个假 Electron
// **真跑一遍注入后的代码**——表与角色是否对齐、分隔线会不会炸，只有跑起来才知道。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const contextMenu = require('../../scripts/inject/context-menu');
const updateControl = require('../../scripts/inject/update-control');
const {
  applyDictInStrings, scopedEntries, stringLiterals, checkSyntax, buildEntries, loadDict,
} = require('../../scripts/common');
// 目录名形态过滤常量统一定义在 test/fixtures/scratch.js（读真实 dictionaries/ 的测试都用它）
const { VERSION_RE } = require('../fixtures/scratch');

// 最小「产物」：末尾带打包器生成的 sourceMappingURL 注释，即真实注入锚点
const SOURCE = ';(function(){var x=1;console.log("Hello");})();\n\n//# sourceMappingURL=main.js.map\n';
// 带 checkForUpdates 的产物：更新管控要拿它当方法闸门锚点（要求全文件唯一）
const SOURCE_UPD = 'class A{async checkForUpdates(a){return a}}\n\n//# sourceMappingURL=main.js.map\n';

function blockOf(content) {
  const r = contextMenu.blockRange(content);
  assert.ok(r, '产物里应当能找到注入块');
  return content.slice(r.start, r.end);
}

function stripBlock(content) {
  const r = contextMenu.blockRange(content);
  assert.ok(r, '产物里应当能找到注入块');
  return content.slice(0, r.start) + content.slice(r.end);
}

test('inject：幂等——已注入过就原样返回，不叠第二份', () => {
  const once = contextMenu.inject(SOURCE, { darwin: false });
  assert.strictEqual(once.changed, true);
  const twice = contextMenu.inject(once.content, { darwin: false });
  assert.strictEqual(twice.changed, false);
  assert.strictEqual(twice.content, once.content);
});

test('inject：只加块，不碰原文——摘掉块后与原文逐字节相同', () => {
  const out = contextMenu.inject(SOURCE, { darwin: false });
  assert.strictEqual(stripBlock(out.content), SOURCE);
  // 块落在 sourceMappingURL 注释**之前**，即产物 IIFE 之外（那里 require 是原生 CommonJS）
  assert.ok(out.content.indexOf(contextMenu.BEGIN) < out.content.indexOf('//# sourceMappingURL='));
});

test('inject：结果与注入块自身都是合法 JS（vm 只解析不执行）', () => {
  const out = contextMenu.inject(SOURCE, { darwin: false });
  assert.deepStrictEqual(checkSyntax(out.content, 'main.js'), { ok: true, output: '' });
  assert.doesNotThrow(() => new vm.Script(blockOf(out.content)));
});

test('注入块只用 ES5（不转译直接进产物，对面 Node 版本不可控）', () => {
  for (const darwin of [false, true]) {
    const block = contextMenu.buildInjection({ darwin });
    assert.ok(!/=>|\bconst\b|\blet\b|`/.test(block), '不得出现箭头函数 / const / let / 模板字面量');
  }
});

test('标签表：darwin 与其余平台两套，role 键一律小写', () => {
  const win = contextMenu.labelsFor(false);
  const mac = contextMenu.labelsFor(true);
  assert.deepStrictEqual(Object.keys(win), Object.keys(mac));
  for (const r of Object.keys(win)) assert.strictEqual(r, r.toLowerCase());
  // macOS 上 & 不是助记符、会原样显示，故 mac 那套不带 &
  for (const [role, label] of Object.entries(mac)) assert.ok(!label.includes('&'), `${role} 不该带 &`);
  // 两套都要真的写进注入块（否则改表不改块，标签永远不生效）
  assert.ok(contextMenu.buildInjection({ darwin: false }).includes("'Select &all'"));
  assert.ok(contextMenu.buildInjection({ darwin: true }).includes("'Select All'"));
});

test('与更新管控共用锚点：两个块都能就位，互不干扰', () => {
  const withMenu = contextMenu.inject(SOURCE_UPD, { darwin: false }).content;
  const both = updateControl.inject(withMenu, { dictDir: 'X:/dict' });
  assert.strictEqual(both.changed, true);
  assert.ok(both.content.includes(contextMenu.BEGIN));
  assert.ok(both.content.includes(updateControl.BEGIN));
  assert.ok(stripBlock(both.content).includes(updateControl.BEGIN)); // 摘掉右键菜单块，更新管控块还在
  assert.deepStrictEqual(checkSyntax(both.content, 'main.js'), { ok: true, output: '' });
});

// 标签由**同一次字典替换**译掉。用夹具字典而不是真实字典，免得字典内容一变、用例跟着红。
const FIXTURE = {
  _meta: { version: '3.6.6', formatVersion: 2 },
  common: {
    '&Undo': '&撤销',
    '&Redo': '&重做',
    'Cu&t': '剪&切',
    '&Copy': '&复制',
    '&Paste': '&粘贴',
    'Select &all': '全&选',
    'main.js|Delete': '删除',
  },
  windows: {},
  macos: {},
  linux: {},
  groups: {},
};

// Electron 44 在 win32 上 editMenu 的展开形态（实测：role 名 + 分隔线，标签硬编码英文）
const EXPANSION = [
  { role: 'undo', label: 'Undo' },
  { role: 'redo', label: 'Redo' },
  { type: 'separator', label: '' },
  { role: 'cut', label: 'Cut' },
  { role: 'copy', label: 'Copy' },
  { role: 'paste', label: 'Paste' },
  { role: 'delete', label: 'Delete' },
  { type: 'separator', label: '' },
  { role: 'selectall', label: 'Select All' },
];

// 假 Electron：buildFromTemplate 遇 role: 'editMenu' 就给该项挂上展开项，其余照抄模板
// （子菜单数组按 Electron 的形态包成 { items }）。
// build-context-menu.ts 正是把展开项**逐个 append** 进最终菜单，故改了这些 item 的 label 即改了右键菜单。
function fakeElectron() {
  const build = (template) => ({
    items: template.map((t) => {
      if (!t) return t;
      const item = { ...t };
      if (String(t.role || '').toLowerCase() === 'editmenu') {
        item.submenu = { items: EXPANSION.map((e) => ({ ...e })) };
      } else if (Array.isArray(t.submenu)) {
        item.submenu = build(t.submenu);
      }
      return item;
    }),
  });
  return { Menu: { buildFromTemplate: (template) => build(template) } };
}

function runBlock(block) {
  // require('electron') 是**单例**（真实 Electron 亦如此，包装能生效正因为它每次返回同一个 Menu 对象）
  const electron = fakeElectron();
  const sandbox = {
    require: (name) => {
      if (name !== 'electron') throw new Error(`只该 require electron：${name}`);
      return electron;
    },
  };
  vm.createContext(sandbox);
  new vm.Script(block, { filename: 'block.js' }).runInContext(sandbox);
  return electron.Menu;
}

test('真跑注入块：展开项标签重打成译文，自带 label 的项与分隔线原样', () => {
  const entries = buildEntries(FIXTURE, '3.6.6', 'windows');
  const menuEntries = scopedEntries(entries, 'main.js');
  const injected = contextMenu.inject(SOURCE, { darwin: false }).content;
  const patchedBlock = applyDictInStrings(blockOf(injected), menuEntries).content;

  const Menu = runBlock(patchedBlock);
  const built = Menu.buildFromTemplate([{ role: 'editMenu' }]);
  assert.deepStrictEqual(
    built.items[0].submenu.items.map((i) => i.label),
    ['&撤销', '&重做', '', '剪&切', '&复制', '&粘贴', '删除', '', '全&选']
  );

  // 应用菜单（自带 label）不该被动：顶层没有 editMenu，整块跳过
  const app = Menu.buildFromTemplate([
    { label: '&Edit', submenu: [{ role: 'undo', label: '&编辑撤销' }] },
  ]);
  assert.strictEqual(app.items[0].label, '&Edit');
  assert.strictEqual(app.items[0].submenu.items[0].label, '&编辑撤销');

  // 空模板、editMenu 不在首位、以及包装本身不重复叠加
  assert.deepStrictEqual(Menu.buildFromTemplate([]).items, []);
  const shifted = Menu.buildFromTemplate([{ label: 'Copy' }, { role: 'editMenu' }]);
  assert.strictEqual(shifted.items[0].label, 'Copy');
  assert.strictEqual(shifted.items[1].submenu.items[0].label, '&撤销');
});

test('标签靠字典替换译掉；Delete 走作用域键，不误伤 renderer 的键盘映射', () => {
  const entries = buildEntries(FIXTURE, '3.6.6', 'windows');
  const menuEntries = scopedEntries(entries, 'main.js');
  const injected = contextMenu.inject(SOURCE, { darwin: false }).content;
  const { content, perKey } = applyDictInStrings(injected, menuEntries);

  // 逐个标签都译到了（块里的英文原文一个不剩）
  for (const label of Object.values(contextMenu.labelsFor(false))) {
    assert.ok(!content.includes(`'${label}'`), `${label} 未被替换`);
  }
  assert.strictEqual(perKey.get('Delete'), 1);
  // patch.js 的「其中右键菜单标签 N 处」就是这个口径：对块单独跑一次替换
  assert.strictEqual(applyDictInStrings(blockOf(injected), menuEntries).total, 7);

  // 作用域键只对 main.js 生效：renderer.js 里的 "Delete"（键盘映射表）不该被碰
  const renderer = 'var k={Delete:"Delete"};';
  const r = applyDictInStrings(renderer, scopedEntries(entries, 'renderer.js'));
  assert.strictEqual(r.content, renderer);
  assert.strictEqual(r.total, 0);
});

test('仓库里每个版本的字典都覆盖了注入的标签（缺了就静默保持英文）', () => {
  const versions = dictVersions();
  assert.ok(versions.length > 0, 'dictionaries/ 下应当有版本目录');
  for (const v of versions) {
    const entries = scopedEntries(loadDict(v, 'windows'), 'main.js');
    const miss = Object.values(contextMenu.labelsFor(false)).filter((l) => !entries.has(l));
    assert.deepStrictEqual(miss, [], `${v} 字典缺标签：${miss.join(' / ')}`);
  }
});

test('注入块里除标签外的字面量，不与任何版本字典的键相撞', () => {
  // 角色名被字典命中就会让查表落空（见 context-menu.js 里 buildInjection 的注释），
  // 这条把「块里只有标签该被替换」钉成断言：多出别的可命中字面量就会红。
  const labels = Object.values(contextMenu.labelsFor(false));
  const lits = stringLiterals(contextMenu.buildInjection({ darwin: false })).map((l) => l.content);
  for (const label of labels) {
    assert.strictEqual(lits.filter((l) => l === label).length, 1, `${label} 应恰好出现一次`);
  }
  for (const v of dictVersions()) {
    for (const platform of ['windows', 'macos', 'linux']) {
      const keys = new Set(loadDict(v, platform).keys());
      const hit = lits.filter((l) => !labels.includes(l) && keys.has(l));
      assert.deepStrictEqual(hit, [], `${v}/${platform} 里有非标签字面量会被替换：${hit.join(' / ')}`);
    }
  }
});

function dictVersions() {
  const root = path.join(__dirname, '..', '..', 'dictionaries');
  // 只认版本号形态的目录。dict-edit 的临时夹具（0.0.0-test）与真版本同住 dictionaries/，
  // 而 node --test 是**并行**跑各测试文件的：夹具存在的那几百毫秒里会被这里读到，它加载得到、
  // 只是没有菜单标签，撞上就红（CI 上 ubuntu / macos-15-intel 正是这么挂的，本机复现见
  // tmp/repro-race.cjs）。夹具名不是版本号形态，按形态过滤即可，不必与那个文件互相知道。
  return fs
    .readdirSync(root)
    .filter((v) => VERSION_RE.test(v) && fs.existsSync(path.join(root, v, 'zh-CN.json')));
}
