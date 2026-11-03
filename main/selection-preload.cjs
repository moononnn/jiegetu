'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const subscribe = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
let diagnosticEnabled = false;
// 页面预载：主进程只在真正把这一窗用于本次截图时才发固定 activate 事件。
// 渲染层没有任何自行激活的入口；init 先等门槛，避免预载页提前 invoke shot:init。
let activated = false, resolveActivation;
const activation = new Promise(resolve => { resolveActivation = resolve; });
ipcRenderer.on('shot:activate', () => {
  if (activated) return;
  activated = true;
  resolveActivation();
});
// 同一页面只允许一次 init；不缓存 payload/promise，避免把约 33MB 的 BMP 强引用到窗口销毁。
let initStarted = false;
contextBridge.exposeInMainWorld('selection', {
  // Synchronous backend choice preserves the media user gesture on other platforms.
  captureMode: process.platform === 'win32' ? 'windows-native' : 'media',
  nativeFrame: token => ipcRenderer.invoke('shot:scroll-frame', token),
  init: () => {
    if (initStarted) return Promise.reject(new Error('选区页面已开始初始化，不能重复调用'));
    initStarted = true;
    return (async () => {
      await activation;
      const payload = await ipcRenderer.invoke('shot:init');
      diagnosticEnabled = payload.diagnosticEnabled === true;
      return payload;
    })();
  },
  diagnostic: (name, fields) => {
    if (!diagnosticEnabled) return Promise.resolve(false);
    return ipcRenderer.invoke('shot:diagnostic', name, fields).then(accepted => {
      if (!accepted) diagnosticEnabled = false;
      return accepted;
    });
  },
  ready: () => ipcRenderer.invoke('shot:ready'),
  commit: (rect, action, longToken, edited) => ipcRenderer.invoke('shot:commit', rect, action, longToken, edited),
  // 编辑源只回元数据：真正的原图由主进程交给独立的编辑窗口，本页不再创建编辑器。
  editSource: (rect, longToken, warning) => ipcRenderer.invoke('shot:edit-source', rect, longToken, warning),
  editState: (token, action) => ipcRenderer.invoke('shot:edit-state', token, action),
  // 编辑窗口返回预览后的缩略图/输出尺寸：只用于更新本页的预览小图，不重建草稿。
  onEditorPreview: callback => subscribe('shot:editor-preview', callback),
  // 成图退出申请：只交当前文档 token 与来源，确认与收尾全在主进程，渲染层无法自己结束会话。
  requestExit: (token, source) => ipcRenderer.invoke('shot:request-exit', token, source),
  onExitConfirmation: callback => subscribe('shot:exit-confirmation', callback),
  replyExitConfirmation: (id, choice) => ipcRenderer.invoke('shot:exit-confirmation-reply', id, choice),
  // 编辑页最小化：只传当前文档 token，主进程再核会话/编辑态，不开放任意窗口操作。
  minimizeEditor: token => ipcRenderer.invoke('shot:edit-minimize', token),
  // 只透传编辑器显式点击后算出的局部 PNG；不开放任意文件读取，也不缓存像素。
  recognizeText: payload => ipcRenderer.invoke('shot:recognize-text', payload),
  beginScroll: rect => {
    // 主进程会在本次长截图开始时建立后台记录，先放开桥接以接收启动阶段摘要。
    diagnosticEnabled = true;
    return ipcRenderer.invoke('shot:scroll-begin', rect);
  },
  // 录制 GIF：只传本地选区矩形，区域归属与尺寸合法性全由主进程裁决。
  beginRecord: rect => ipcRenderer.invoke('shot:record-begin', rect),
  scrollConfig: () => ipcRenderer.invoke('shot:scroll-config'),
  scrollReady: token => ipcRenderer.invoke('shot:scroll-ready', token),
  scrollFinishing: token => ipcRenderer.invoke('shot:scroll-finishing', token),
  scrollProgress: (token, state) => ipcRenderer.invoke('shot:scroll-progress', token, state),
  scrollResult: (token, png, warning, recovered) => ipcRenderer.invoke('shot:scroll-result', token,
    recovered === true ? { png, warning, recovered: true } : { png, warning }),
  scrollError: (token, message, reason) => ipcRenderer.invoke('shot:scroll-error', token, message, ['no-growth', 'resolution-changed', 'media-ended', 'sample-error', 'size-limit'].includes(reason) ? reason : 'failed'),
  previewReady: token => ipcRenderer.invoke('shot:preview-ready', token),
  previewImage: token => ipcRenderer.invoke('shot:preview-image', token),
  onScrollStop: callback => subscribe('shot:scroll-stop', callback),
  onScrollAbort: callback => subscribe('shot:scroll-abort', callback),
  onScrollComplete: callback => subscribe('shot:scroll-complete', callback),
  cancel: reason => ipcRenderer.invoke('shot:cancel', reason === 'failed' ? 'failed' : 'cancelled')
});
