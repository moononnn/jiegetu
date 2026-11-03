'use strict';
// 快捷菜单 preload：只暴露这扇小窗需要的四个固定通道，页面拿不到 ipcRenderer、窗口、文件或剪贴板能力。
// state / ready / dismiss 无参数；action 只接受主进程白名单里的七个动作，未知值在 preload 就拒绝。
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = Object.freeze({
  state: 'tray-menu:state',
  ready: 'tray-menu:ready',
  action: 'tray-menu:action',
  dismiss: 'tray-menu:dismiss'
});
const ACTIONS = Object.freeze(['capture', 'finish-scroll', 'open-folder', 'open-last', 'settings', 'help', 'quit']);
const ACTION_SET = new Set(ACTIONS);

const subscribe = (channel, callback) => {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, value) => { try { callback(value); } catch { /* 页面处理异常不影响主进程。 */ } };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('trayMenu', {
  state: () => ipcRenderer.invoke(CHANNELS.state),
  ready: () => ipcRenderer.invoke(CHANNELS.ready),
  onState: callback => subscribe(CHANNELS.state, callback),
  action: action => (ACTION_SET.has(action)
    ? ipcRenderer.invoke(CHANNELS.action, action)
    : Promise.reject(new Error('不支持的菜单动作'))),
  dismiss: () => ipcRenderer.invoke(CHANNELS.dismiss)
});
