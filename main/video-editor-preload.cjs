'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('videoEditor', {
  load: () => ipcRenderer.invoke('video-editor:load'),
  saveOriginal: () => ipcRenderer.invoke('video-editor:save-original'),
  exportEdit: range => ipcRenderer.invoke('video-editor:export', range),
  close: () => ipcRenderer.invoke('video-editor:close'),
  confirmDiscard: () => ipcRenderer.invoke('video-editor:close', true),
  onCloseRequested: fn => ipcRenderer.on('video-editor:close-requested', () => fn()),
});
