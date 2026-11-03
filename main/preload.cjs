'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('probe', {
  displays: () => ipcRenderer.invoke('probe:displays'),
  select: id => ipcRenderer.invoke('probe:select', id),
  prepare: () => ipcRenderer.invoke('probe:prepare'),
  phase: mode => ipcRenderer.invoke('probe:phase', mode),
  map: (rect, frame) => ipcRenderer.invoke('probe:map', rect, frame),
  finish: report => ipcRenderer.invoke('probe:finish', report),
  cancel: () => ipcRenderer.invoke('probe:cancel')
});
contextBridge.exposeInMainWorld('shot', {
  state: () => ipcRenderer.invoke('shot:state'),
  windowState: () => ipcRenderer.invoke('window:state'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  onWindowState: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('window:state', listener);
    return () => ipcRenderer.removeListener('window:state', listener);
  },
  start: () => ipcRenderer.invoke('shot:start'),
  startDesktop: () => ipcRenderer.invoke('shot:start-desktop'),
  retryHotkey: () => ipcRenderer.invoke('shot:retry-hotkey'),
  // 改键租约：开始录入 / 结束恢复 / 保存候选（token 由开始那一步发）；旧调用只传一个参数时行为不变。
  beginHotkeyEdit: () => ipcRenderer.invoke('shot:begin-hotkey-edit'),
  endHotkeyEdit: token => ipcRenderer.invoke('shot:end-hotkey-edit', token),
  setHotkey: (accelerator, token) => token === undefined
    ? ipcRenderer.invoke('shot:set-hotkey', accelerator)
    : ipcRenderer.invoke('shot:set-hotkey', accelerator, token),
  // 主题三态只交意图，白名单与持久化由主进程裁决。
  setTheme: source => ipcRenderer.invoke('shot:set-theme', source),
  chooseSaveFolder: () => ipcRenderer.invoke('shot:choose-save-folder'),
  setAutoLaunch: enabled => ipcRenderer.invoke('shot:set-auto-launch', enabled),
  openDirectory: () => ipcRenderer.invoke('shot:open-directory'),
  openLast: () => ipcRenderer.invoke('shot:open-last'),
  openDiagnostic: () => ipcRenderer.invoke('shot:diagnostic-open'),
  quit: () => ipcRenderer.invoke('shot:quit'),
  onStatus: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('shot:status', listener);
    return () => ipcRenderer.removeListener('shot:status', listener);
  },
  onFocusSection: callback => {
    const listener = (_event, section) => callback(section);
    ipcRenderer.on('shot:focus-section', listener);
    return () => ipcRenderer.removeListener('shot:focus-section', listener);
  },
  onFocusSettings: callback => {
    const listener = () => callback();
    ipcRenderer.on('shot:focus-settings', listener);
    return () => ipcRenderer.removeListener('shot:focus-settings', listener);
  }
});
