// gui/preload.js — 渲染进程访问主进程的唯一入口
// contextIsolation + sandbox 下渲染进程没有 Node：这里显式列出的方法就是它能做的全部事情，
// 文件系统 / 进程 / 网络能力一个都不暴露（字典写盘通道在 GUI 中不存在）。
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 只读：当前状态与字典内容
  state: () => ipcRenderer.invoke('state'),
  dictEntries: () => ipcRenderer.invoke('dictEntries'),

  // 操作：确认框在主进程内弹（渲染进程无法伪造确认）
  patch: () => ipcRenderer.invoke('patch'),
  restore: () => ipcRenderer.invoke('restore'),
  pickPath: () => ipcRenderer.invoke('pickPath'),
  update: () => ipcRenderer.invoke('update'),

  // 主进程推进度（「正在汉化 …」）；返回反注册函数，界面重载时不会留下重复监听
  onBusy: (fn) => {
    const listener = (_event, payload) => fn(payload);
    ipcRenderer.on('busy', listener);
    return () => ipcRenderer.removeListener('busy', listener);
  },
});
