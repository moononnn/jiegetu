'use strict';
// GIF 录制操作/预览页的桥：只暴露固定 IPC，任何 channel、ipcRenderer 或路径都不交给页面。
const { contextBridge, ipcRenderer } = require('electron');
const subscribe = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
const ACTIONS = new Set(['stop', 'cancel', 'retry', 'save', 'save-quick', 'copy', 'edit', 'edit-close']);
const EDIT_ACTIONS = new Set(['begin', 'frame', 'finish', 'abort']);
contextBridge.exposeInMainWorld('gifRecorder', {
  // 握手：页面挂载后拿一次当前状态；主进程若已有预览会顺带补发一次 gif:preview。
  ready: () => ipcRenderer.invoke('gif:ready'),
  action: action => ACTIONS.has(action)
    ? ipcRenderer.invoke('gif:action', action)
    : Promise.reject(new Error('不支持的录制操作')),
  edit: (action, payload) => EDIT_ACTIONS.has(action)
    ? ipcRenderer.invoke('gif:edit', action, payload)
    : Promise.reject(new Error('不支持的 GIF 编辑操作')),
  onStatus: callback => subscribe('gif:status', callback),
  onPreview: callback => subscribe('gif:preview', callback)
});
