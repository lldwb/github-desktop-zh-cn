// scripts/update-control.js — 「更新管控」补丁组
// 往 GitHub Desktop 的 main.js 注入两件事：
//   1. 禁止自动更新：让 checkForUpdates 直接返回，不碰 autoUpdater
//   2. 没有字典就拦截：工具还没准备好更高版本的字典时，不放行更新检查
//
// 注入点选在产物 IIFE **之外**（CommonJS 模块顶层）——那里 require 是原生的，不受 webpack
// 运行时 __webpack_require__ 拦截（取证见 docs/dict-v2/tasks.md 第 8 组第一项）。
// 注入块用首尾标记包住，便于识别「是否已注入」。
'use strict';

const BEGIN = '/*__GDZC_UPDATE_CONTROL_BEGIN__*/';
const END = '/*__GDZC_UPDATE_CONTROL_END__*/';

// 生成注入的支撑代码。dictDir 写死进产物：运行时靠它扫「已支持版本上限」。
// 只用 ES5 语法——这段字符串原样写进产物，不经过任何转译，用新语法等于赌对面 Electron 的
// Node 版本（当前产物是 webpack 编译过的，注入位置在编译范围之外）。
//
// mode：
//   'guard'（默认）——**没有对应字典就不更新**：工具支持的上限高于当前版本才放行
//   'off'          ——**完全禁止自动更新**：一律不放行，连查都不查
// 两种模式共用同一套注入块，只有 __gdzcAllowUpdate 的返回不同——这样「切换模式」等价于
// 重新注入，而不是「撤掉再打另一套」，产物里永远只有一份更新管控代码。
//
// toolPath：工具可执行文件路径。给了才注入「更新后自动汉化」——**只有打包态才有意义**，
// 源码态下工具就是仓库本身，用户自己跑 npm run patch 即可，写死一个 node 路径进产物
// 反而会在换机器后指向不存在的东西。
function buildInjection(dictDir, { mode = 'guard', toolPath = null } = {}) {
  const allow =
    mode === 'off'
      ? 'return false;'
      : `var lim=limit();
      if(lim===null)return true;
      try{
        var cur=require('electron').app.getVersion().split('.');
        var v=[];for(var i=0;i<cur.length;i++)v.push(Number(cur[i]));
        return cmp(v,lim)<0;
      }catch(e){return true;}`;
  const autoPatch = toolPath
    ? `
    // —— 更新后自动汉化 ——
    // 工具已备好当前版本的字典、产物却还是英文时，调工具补打一次补丁。判据是记账文件里
    // 没有 i18n 组：它既是「打过没有」的权威记录，也避免了每次启动都白跑一次 patch。
    // 工具路径在注入时写死（打包态才有）。spawn 失败一律吞掉——这是锦上添花的一步，
    // 不能因为它让 GitHub Desktop 起不来。
    function autoPatch(){
      try{
        var v=require('electron').app.getVersion();
        if(!fs.existsSync(path.join(DICT_DIR,v,'zh-CN.json')))return;
        var raw={};
        try{raw=JSON.parse(fs.readFileSync(path.join(DICT_DIR,'..','tmp','patch-state.json'),'utf8'))||{};}catch(e){}
        var groups=(raw[v]&&raw[v].groups)||[];
        if(groups.indexOf('i18n')>=0)return;
        var TOOL=${JSON.stringify(toolPath)};
        if(!fs.existsSync(TOOL))return;
        var c=require('child_process').spawn(TOOL,['patch','--version',v],{detached:true,stdio:'ignore'});
        c.on('error',function(){});
        c.unref();
      }catch(e){}
    }
    autoPatch();`
    : '';
  return `${BEGIN}
;(function(){
  try{
    var fs=require('fs'),path=require('path');
    var DICT_DIR=${JSON.stringify(dictDir)};
    // 版本号比较，按段对齐（1.2 与 1.2.0 视为相等）
    function cmp(a,b){
      var n=Math.max(a.length,b.length);
      for(var i=0;i<n;i++){var x=a[i]||0,y=b[i]||0;if(x!==y)return x-y;}
      return 0;
    }
    // 已支持版本上限 = 字典目录里带 zh-CN.json 的最大版本号。
    // 扫不到（目录被移走 / 权限不足 / 无字典）返回 null——**判断不了就放行**：
    // 宁可让用户更新，也不要因为工具自己的问题把人锁死在旧版本上。
    function limit(){
      try{
        var names=fs.readdirSync(DICT_DIR),best=null;
        for(var i=0;i<names.length;i++){
          if(!fs.existsSync(path.join(DICT_DIR,names[i],'zh-CN.json')))continue;
          var parts=String(names[i]).split('.'),ok=parts.length>0;
          for(var j=0;j<parts.length;j++){if(!/^[0-9]+$/.test(parts[j])){ok=false;break;}}
          if(!ok)continue;
          var v=[];for(var k=0;k<parts.length;k++)v.push(Number(parts[k]));
          if(best===null||cmp(v,best)>0)best=v;
        }
        return best;
      }catch(e){return null;}
    }
    // guard 模式的放行条件：**工具支持的上限高于当前版本**——说明新版本的字典已经就位，
    // 更新过去还能是中文；相等或更低时拦截，因为工具还没跟上，更新过去就只剩英文界面了。
    globalThis.__gdzcAllowUpdate=function(){
      ${allow}
    };${autoPatch}
  }catch(e){}
})();
${END}
`;
}

// 往 main.js 注入更新管控。返回 { content, changed, reason }
// 已注入过（标记还在）则原样返回，changed=false——重复调用是安全的。
// **换模式不在这里做**：要 guard ↔ off 互换，先还原成官方原文再按新模式打一遍，
// 这样产物里永远只有一份注入块，不会出现两套 __gdzcAllowUpdate 抢着赋值。
function inject(content, { dictDir, mode = 'guard', toolPath = null }) {
  if (content.includes(BEGIN)) return { content, changed: false, reason: '已注入过（标记已存在）' };

  // 支撑代码：锚点优先用文件末尾的 sourceMappingURL 注释（打包器生成的固定结构），
  // 没有就退回文件末尾——两处都在 IIFE 之外，等价。
  const block = buildInjection(dictDir, { mode, toolPath });
  const marker = '\n//# sourceMappingURL=';
  const at = content.lastIndexOf(marker);
  const withSupport =
    at >= 0 ? `${content.slice(0, at + 1)}${block}${content.slice(at + 1)}` : `${content}\n${block}`;

  // 方法闸门：锚点用 `async checkForUpdates(`。实测 3.6.6 正式版里 checkForUpdates 共出现
  // 3 次（方法名、方法体内调 autoUpdater、IPC 处理器），**只有方法名那处带 async 前缀**，
  // 所以这个锚点是唯一的。不唯一就宁可不动——插错地方会让应用起不来。
  const anchor = 'async checkForUpdates(';
  const occurrences = withSupport.split(anchor).length - 1;
  if (occurrences !== 1) {
    return { content, changed: false, reason: `锚点 ${JSON.stringify(anchor)} 出现 ${occurrences} 次（预期 1 次），产物结构可能变了` };
  }
  const mi = withSupport.indexOf(anchor);
  const braceAt = withSupport.indexOf('{', mi);
  if (braceAt < 0) return { content, changed: false, reason: 'checkForUpdates 之后没有方法体' };

  const gate = 'if(!globalThis.__gdzcAllowUpdate())return;';
  const out = `${withSupport.slice(0, braceAt + 1)}${gate}${withSupport.slice(braceAt + 1)}`;
  return { content: out, changed: true, reason: '' };
}

module.exports = { inject, buildInjection, BEGIN, END };
