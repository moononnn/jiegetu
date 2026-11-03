'use strict';
// 独立图片编辑窗口的预载：只暴露这一个宿主需要的通道，页面拿不到任意窗口/文件/剪贴板能力。
// 页面 → 主进程：就绪、打开失败、返回预览、提交、导出回包、离线识别；
// 主进程 → 页面：打开指令、导出请求、预览回执（关闭由页面自己收）。
const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel, callback) => {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, value) => { try { callback(value); } catch { /* 页面处理异常不影响其它消息。 */ } };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('editorHost', {
  onOpen: callback => subscribe('shot:editor-open', callback),
  onExitConfirmation: callback => subscribe('shot:exit-confirmation', callback),
  replyExitConfirmation: (id, choice) => ipcRenderer.invoke('shot:exit-confirmation-reply', id, choice),
  onExportRequest: callback => subscribe('shot:editor-export', callback),
  ready: token => ipcRenderer.invoke('shot:editor-ready', token),
  openFailed: (token, message) => ipcRenderer.invoke('shot:editor-open-failed', token, String(message || '')),
  close: payload => ipcRenderer.invoke('shot:editor-close', payload),
  // 预览态 Esc/右键：只申请退出（token+来源），确认面板与收尾全在会话层。
  requestExit: (token, source) => ipcRenderer.invoke('shot:editor-exit-request', token, source),
  commit: (action, edited) => ipcRenderer.invoke('shot:editor-commit', action, edited),
  exportReply: (id, ok, payload) => ipcRenderer.invoke('shot:editor-export-reply', id, ok, payload),
  // 识别只透传编辑器显式点击后算出的局部 PNG；主进程再核会话/文档/尺寸。
  recognizeText: payload => ipcRenderer.invoke('shot:recognize-text', payload)
});
