'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('scrollBar', {
  state: () => ipcRenderer.invoke('scroll-bar:state'),
  toggleCapture: () => ipcRenderer.invoke('scroll-bar:toggle-capture'),
  finish: () => ipcRenderer.invoke('scroll-bar:finish'),
  cancel: () => ipcRenderer.invoke('scroll-bar:cancel'),
  onStatus: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('scroll-bar:status', listener);
    return () => ipcRenderer.removeListener('scroll-bar:status', listener);
  }
});
