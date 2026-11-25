'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// 录制页与指示条共用这一个 preload：通道按发送方在主进程里再核一遍身份。
contextBridge.exposeInMainWorld('video', {
  config: () => ipcRenderer.invoke('video:config'),
  state: payload => ipcRenderer.invoke('video:state', payload),
  result: payload => ipcRenderer.invoke('video:result', payload),
  retrySave: () => ipcRenderer.invoke('video:retry-save'),
  observe: payload => ipcRenderer.invoke('video:observe', payload),
  action: (action, choices) => ipcRenderer.invoke('video:action', action, choices),
  onIndicator: fn => ipcRenderer.on('video:indicator', (_event, payload) => fn(payload)),
  onStop: fn => ipcRenderer.on('video:stop', () => fn()),
  onPause: fn => ipcRenderer.on('video:pause', () => fn()),
  onResume: fn => ipcRenderer.on('video:resume', () => fn()),
});
