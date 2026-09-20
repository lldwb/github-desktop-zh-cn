// 组名推断（scripts/dict/dict-groups.js）单测
//
// 重点是 `parseMenuLabels`：它按引用关系解析官方菜单构建文件，一旦官方改了写法就会静默
// 退化成「全部落泛『菜单』组」——不报错、不影响替换，只有断言能发现。故用精简夹具把它
// 覆盖到的每条路径都钉住。
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const groups = require('../../scripts/dict/dict-groups');
const common = require('../../scripts/common');

// 夹具覆盖：内联对象、数组变量、元素变量、别名 push、__DARWIN__ 三元、声明后置
const MENU_SRC = `
const fileMenu = {
  label: '&File',
  submenu: [ { label: 'New &repository…' }, { label: '&Options…', submenu: [ { label: '&Appearance' } ] } ],
};

const fileItems = fileMenu.submenu;
fileItems.push({ label: 'E&xit' });

const editMenu: MenuItem = {
  label: '&Edit',
  submenu: [
    { label: '&Undo' },
    copyItem,
    { label: __DARWIN__ ? 'Preferences…' : '&Preferences…' },
  ],
};

const copyItem = { label: '&Copy' };

const appMenu = {
  label: 'GitHub Desktop',
  submenu: [ { label: __DARWIN__ ? 'About GitHub Desktop' : '&About GitHub Desktop' } ],
};

template.push(fileMenu);
template.push(editMenu);
template.push(appMenu);
`;

test('parseMenuLabels：三级传播把菜单项归到正确的父菜单', () => {
  const m = groups.parseMenuLabels(MENU_SRC);
  assert.strictEqual(m.get('&File'), '文件', '顶层菜单自身的 label 也算该菜单的条目');
  assert.strictEqual(m.get('New &repository…'), '文件');
  assert.strictEqual(m.get('E&xit'), '文件', '别名 fileItems 上 push 的项应属 fileMenu');
  assert.strictEqual(m.get('&Edit'), '编辑');
  assert.strictEqual(m.get('&Undo'), '编辑');
  assert.strictEqual(m.get('&Preferences…'), '编辑', '__DARWIN__ 三元应取 Windows 分支');
  assert.strictEqual(m.get('GitHub Desktop'), '应用');
  assert.strictEqual(m.get('&About GitHub Desktop'), '应用');
});

test('parseMenuLabels：不按源码位置归属——声明在后的 copyItem 仍属引用它的 editMenu', () => {
  const m = groups.parseMenuLabels(MENU_SRC);
  assert.strictEqual(m.get('&Copy'), '编辑');
  assert.ok(
    MENU_SRC.indexOf('const editMenu') < MENU_SRC.indexOf('const copyItem'),
    '夹具里 copyItem 必须声明在引用它的 editMenu 之后，否则本用例测不到东西',
  );
});

test('parseMenuLabels：内联 submenu 不被误认为顶层菜单，不产生自造父菜单', () => {
  const m = groups.parseMenuLabels(MENU_SRC);
  assert.ok(!m.has('&Appearance'), '子菜单的项当前不展开（父菜单只有一层），不应凭空出现在表里');
});

test('parseMenuLabels：写法不认识时退化为空表而非抛错（调用方据此降级为「菜单」组）', () => {
  assert.strictEqual(groups.parseMenuLabels('const x = 1;').size, 0);
  assert.strictEqual(groups.parseMenuLabels('').size, 0);
});

test('groupOfFile：按最长前缀匹配，子目录优先于父目录', () => {
  assert.strictEqual(groups.groupOfFile('ui/preferences/appearance.tsx'), '设置');
  assert.strictEqual(groups.groupOfFile('ui/welcome/start.tsx'), '开始页');
  assert.strictEqual(groups.groupOfFile('ui/copy-button.tsx'), '通用', 'ui/ 根下的复用件');
  assert.strictEqual(
    groups.groupOfFile('ui/dialog/header.tsx'),
    '通用',
    '未收录的 ui 子目录走 ui 兜底——分组只是参考，要单独成组在 DIR_GROUPS 加一行',
  );
  assert.strictEqual(groups.groupOfFile('lib/git/commit.ts'), '通用');
  assert.strictEqual(groups.groupOfFile('main-process/menu/build-default-menu.ts'), '菜单');
  assert.strictEqual(groups.groupOfFile('main-process/menu/build-spell-check-menu.ts'), '菜单', '用户可见的右键菜单');
  assert.strictEqual(
    groups.groupOfFile('main-process/menu/build-test-menu.ts'),
    '待分组',
    '开发调试用的测试菜单，其"菜单项"实为对话框标题，不算用户可见菜单',
  );
  assert.strictEqual(groups.groupOfFile('main-process/main.ts'), '主进程');
  assert.strictEqual(groups.groupOfFile('models/repository.ts'), '通用');
  assert.strictEqual(groups.groupOfFile('some-new-top-level/x.ts'), null, '未知顶层目录不猜');
});

test('infer：真实安装目录可用时，菜单分组覆盖到具体父菜单（无安装目录则跳过）', (t) => {
  let app;
  try {
    app = common.locateApp({});
  } catch {
    t.skip('本机无 GitHub Desktop 安装目录');
    return;
  }
  const r = groups.infer(app.version, {});
  const menuGroups = Object.keys(r.groups).filter((n) => n.startsWith('菜单-'));
  assert.ok(
    menuGroups.length >= 4,
    `应至少识别出 4 个具体父菜单，实得 ${menuGroups.length} 个：${menuGroups.join('、')}`,
  );
  for (const n of menuGroups) assert.ok(r.groups[n].length > 0, `${n} 不应为空组`);
});
