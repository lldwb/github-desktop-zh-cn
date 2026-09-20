// gui/preload.js — 渲染进程访问主进程的唯一入口
// contextIsolation + sandbox 下渲染进程没有 Node：这里显式列出的方法就是它能做的全部事情，
// 文件系统 / 进程 / 网络能力一个都不暴露（字典写盘通道在 GUI 中不存在）。
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 只读：当前状态、字典内容、翻译提示词
  state: () => ipcRenderer.invoke('state'),
  dictEntries: () => ipcRenderer.invoke('dictEntries'),
  prompt: () => ipcRenderer.invoke('prompt'),

  // 操作：确认框在主进程内弹（渲染进程无法伪造确认）
  patch: () => ipcRenderer.invoke('patch'),
  restore: () => ipcRenderer.invoke('restore'),
  pickPath: () => ipcRenderer.invoke('pickPath'),
  // 切换要处理的 GitHub Desktop 版本：唯一入参是一个版本号字符串，
  // 主进程会拿它去**本机已安装列表**里反查路径，渲染进程给不了任意目录。
  setVersion: (version) => ipcRenderer.invoke('setVersion', version),
  // 可下载的版本（官方 Release）与「下载并安装」：同样只收版本号字符串；
  // 目标是官方安装根下的 app-<版本>，由主进程算，渲染进程给不了任何路径。
  downloadable: () => ipcRenderer.invoke('downloadable'),
  installVersion: (version) => ipcRenderer.invoke('installVersion', version),
  // 更新管控：模式选择也在主进程的对话框里做，这里同样只暴露「动作」不带参数
  updateControl: () => ipcRenderer.invoke('updateControl'),
  // 工具自更新：确认框与下载都在主进程做，渲染进程只发起
  toolUpdateInstall: () => ipcRenderer.invoke('toolUpdateInstall'),
  // 原先合在「检查更新」一个动作里的两件事，现在分开——「检查更新」只查工具自身，
  // 字典同步单独走 syncDict（两者都在「关于」窗口里）。
  checkToolUpdate: () => ipcRenderer.invoke('checkToolUpdate'),
  syncDict: () => ipcRenderer.invoke('syncDict'),
  // 打开项目地址：入参是白名单键（repo / mirror），不是任意 URL——
  // 渲染进程给不了 URL，也就不存在「把 shell.openExternal 当任意链接跳板」这条路。
  openUrl: (which) => ipcRenderer.invoke('openUrl', which),

  // 主进程推进度（「正在汉化 …」）；返回反注册函数，界面重载时不会留下重复监听
  onBusy: (fn) => {
    const listener = (_event, payload) => fn(payload);
    ipcRenderer.on('busy', listener);
    return () => ipcRenderer.removeListener('busy', listener);
  },
  // 启动后主进程自动检查到新版本时推过来（无新版不推）
  onToolUpdate: (fn) => {
    const listener = (_event, payload) => fn(payload);
    ipcRenderer.on('toolUpdate', listener);
    return () => ipcRenderer.removeListener('toolUpdate', listener);
  },
});
