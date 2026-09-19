// scripts/context-menu.js — 右键菜单汉化：注入「按 role 重打标签」的代码
//
// 现象：文本输入框（分支筛选框、提交摘要框等）右键弹出的菜单一直是英文，而界面其余部分已是中文。
//
// 定性：这不是字典漏收，而是**字典机制够不着**。该菜单由 main-process/menu/build-context-menu.ts 拼装
// （getEditMenuItems：`Menu.buildFromTemplate([{ role: 'editMenu' }])` 取展开项后逐个 append 进最终菜单），
// 展开项（撤销/重做/剪切/复制/粘贴/删除/全选）的标签由 **Electron 运行时**按 role 生成、硬编码英文，
// 产物里只有 role 名、没有标签字面量（实测 3.6.6 官方 main.js 里内容为 Delete 的字符串字面量 0 处），
// 而字典是按「字符串字面量整串相等」替换的，自然无从下手。
//
// 办法：注入一段代码包装 Menu.buildFromTemplate，模板里出现 role: 'editMenu' 时，把展开项的 label
// 按 role 重打成**英文标签**——产物里于是有了字面量，紧接着由**同一次字典替换**译成中文。
// 本模块只带英文原文、不带任何中文：翻译资产仍然只有字典一份（字典是唯一翻译资产）。
//
// 标签取哪一套：非 darwin 用 `&` 形态（'&Undo' / 'Cu&t' / 'Select &all'）——它与菜单栏 Edit 子菜单同源
// （build-default-menu.ts：`role: 'undo', label: __DARWIN__ ? 'Undo' : '&Undo'`），字典早已覆盖这批原文，
// 右键菜单沿用同一批即可直接复用译文；`&` 是助记符，与菜单栏行为一致（Windows 下按住 Alt 才显示下划线）。
// darwin 用不带 `&` 的形态（macOS 上 `&` 不是助记符、会原样显示），与 build-default-menu 的 mac 分支同形。
// 字典没覆盖到的（如 3.6.5 的 macos 段缺 Redo/Cut/Paste/Select All）保持英文原文——与 Electron 原生标签
// 同形，不会比现状更差。
'use strict';

const BEGIN = '/*__GDZC_CONTEXT_MENU_BEGIN__*/';
const END = '/*__GDZC_CONTEXT_MENU_END__*/';

// role → 重打后的标签（键为 Electron 的 role 名，小写）。**值必须与字典键逐字相同**，
// 否则替换落空、标签保持英文。Electron 的 editMenu 展开项实测为
// undo / redo / (分隔线) / cut / copy / paste / delete / (分隔线) / selectall（Electron 44，win32）。
// pasteAndMatchStyle 不收录：build-context-menu.ts 显式把它过滤掉了，收进来只会多一个永不生效的键。
const LABELS = {
  win32: {
    undo: '&Undo',
    redo: '&Redo',
    cut: 'Cu&t',
    copy: '&Copy',
    paste: '&Paste',
    delete: 'Delete',
    selectall: 'Select &all',
  },
  darwin: {
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    delete: 'Delete',
    selectall: 'Select All',
  },
};

// 该平台的标签表（darwin 之外的平台共用 win32 那套，与 build-default-menu 的 __DARWIN__ 三目一致）
function labelsFor(darwin) {
  return darwin ? LABELS.darwin : LABELS.win32;
}

// 生成注入块的源码。只用 ES5——这段字符串原样写进产物、不经过任何转译，用新语法等于赌对面 Electron 的
// Node 版本（注入位置在 webpack 编译范围之外，与 update-control.js 同一处）。
//
// 包装而不是替换：先调到 Electron 原实现拿到菜单，再按 role 改展开项的 label，其余一概不碰。
// 应用菜单（自带 label，如 '&Edit'/'&编辑撤销'）因此不受影响——实测注入后 appMenuUntouched 三项原样。
//
// 角色名与标签**分开摆放**不是为省事：标签必须是字面量（翻译就靠字典替换这些字面量），而角色名若也逐个
// 写成字面量，就同样落在字典的匹配范围里——哪天字典收了 'copy' / 'delete' 这样的键，角色表的键会被译成
// 中文，查表静默落空（标签保持英文、还不报错）。故角色名整体塞进一个字符串再 JSON.parse：这个字符串的
// 内容是 `["undo","redo",…]`，任何字典键都不会与它整串相等。
function buildInjection({ darwin = false } = {}) {
  const table = labelsFor(darwin);
  const roles = JSON.stringify(Object.keys(table));
  const labels = Object.values(table)
    .map((v) => `'${v}'`)
    .join(', ');
  return `${BEGIN}
;(function(){
  try{
    var M=require('electron').Menu;
    if(!M||M.__gdzcContextMenu)return;
    var R=JSON.parse('${roles}'),L=[${labels}];
    var orig=M.buildFromTemplate;
    M.buildFromTemplate=function(){
      var menu=orig.apply(this,arguments);
      try{
        var t=arguments[0];
        if(Array.isArray(t)){
          for(var i=0;i<t.length;i++){
            var tpl=t[i];
            if(!tpl||String(tpl.role||'').toLowerCase()!=='editmenu')continue;
            // 模板项与 menu.items 一一对应（Electron 不丢模板项）；取不到子菜单就放过这一项
            var built=menu.items[i];
            var sub=built&&built.submenu&&built.submenu.items;
            if(!sub)continue;
            for(var j=0;j<sub.length;j++){
              // 分隔线的 role 是 undefined，取到 -1，等于原样放过
              var k=R.indexOf(String(sub[j].role||'').toLowerCase());
              if(k>=0)sub[j].label=L[k];
            }
          }
        }
      }catch(e){}
      return menu;
    };
    M.__gdzcContextMenu=true;
  }catch(e){}
})();
${END}
`;
}

// 往 main.js 注入右键菜单汉化。返回 { content, changed, reason }
// 已注入过（首标记还在）则原样返回，changed=false——重复调用是安全的。
function inject(content, { darwin = false } = {}) {
  if (content.includes(BEGIN)) return { content, changed: false, reason: '已注入过（标记已存在）' };

  // 锚点与更新管控同处：文件末尾 sourceMappingURL 注释**之前**，也就是产物 IIFE 之外——
  // 那里 require 是原生 CommonJS，不受 webpack 运行时 __webpack_require__ 拦截。
  const block = buildInjection({ darwin });
  const marker = '\n//# sourceMappingURL=';
  const at = content.lastIndexOf(marker);
  const out =
    at >= 0 ? `${content.slice(0, at + 1)}${block}${content.slice(at + 1)}` : `${content}\n${block}`;
  return { content: out, changed: true, reason: '' };
}

// 注入块在产物里的区间，没注入过返回 null。区间含首尾标记与块尾的那个换行——也就是**注入真正加进去的
// 那几个字节**，摘掉它就能逐字节还原注入前的原文。
// 一头一尾两个用途：调用方按 start 摘块（还原），按整段单独跑一次字典替换（统计本轮译掉几个标签）。
function blockRange(content) {
  const start = content.indexOf(BEGIN);
  if (start < 0) return null;
  const end = content.indexOf(END, start);
  if (end < 0) return { start, end: content.length };
  const after = end + END.length;
  return { start, end: content[after] === '\n' ? after + 1 : after };
}

module.exports = { inject, buildInjection, labelsFor, blockRange, BEGIN, END };
