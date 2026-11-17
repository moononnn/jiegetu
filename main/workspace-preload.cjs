/* 跨图批注工作台的 preload：只暴露窄方法；不暴露 fs、任意 ipc 或任意 URL。 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 主进程用 additionalArguments 把 token 随渲染进程一起带进来：
// 页面初始化就会调 shot:workspace-state，等 ws:token 事件到达已经晚了（会报“工作台窗口已失效”）。
const fromArgv = (() => {
  try {
    const list = Array.isArray(process?.argv) ? process.argv : [];
    const hit = list.find(item => typeof item === 'string' && item.startsWith('--ws-token='));
    return hit ? hit.slice('--ws-token='.length) : '';
  } catch { return ''; }
})();

let token = fromArgv;
let markReady;
const ready = new Promise(resolve => { markReady = resolve; });
if (token) markReady();
ipcRenderer.on('ws:token', (event, value) => {
  if (typeof value !== 'string' || !value) return;
  token = value;
  markReady();
});

// 任何一次调用都先等 token：宁可慢一步，也不要拿空 token 去打主进程。
const invoke = async (name, payload = {}) => {
  if (!token) { try { await ready; } catch { /* 退化成空 token，让主进程给明确错误。 */ } }
  return ipcRenderer.invoke(name, { ...payload, token });
};

contextBridge.exposeInMainWorld('workspaceHost', {
  onState: callback => ipcRenderer.on('ws:state', (event, state) => { if (typeof callback === 'function') callback(state); }),
  onCloseRequest: callback => ipcRenderer.on('ws:close-request', () => { if (typeof callback === 'function') callback(); }),
  state: () => invoke('shot:workspace-state'),
  asset: assetHash => invoke('shot:workspace-asset', { assetHash }),
  save: (document, baseRevision) => invoke('shot:workspace-save', { document, baseRevision }),
  setDirty: dirty => invoke('shot:workspace-dirty', { dirty }),
  forceClose: () => invoke('shot:workspace-force-close'),
  hide: () => invoke('shot:workspace-hide'),
  exportBegin: kind => invoke('shot:workspace-export-begin', { kind }),
  exportPart: (batch, index, bytes) => invoke('shot:workspace-export-part', { batch, index, bytes }),
  exportDone: batch => invoke('shot:workspace-export-done', { batch }),
  exportAbort: batch => invoke('shot:workspace-export-abort', { batch }),
  copyNotes: () => invoke('shot:workspace-copy-notes')
});
