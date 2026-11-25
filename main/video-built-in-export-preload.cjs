'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('videoBuiltInExport', {
  load: () => ipcRenderer.invoke('video-offline:load'),
  complete: result => ipcRenderer.invoke('video-offline:complete', result),
  fail: code => ipcRenderer.invoke('video-offline:fail', code),
});
