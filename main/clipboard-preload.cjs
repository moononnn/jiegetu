/* 剪贴板历史窗的 preload：只暴露窄方法，不暴露 fs/任意 ipc/URL。 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

let token = '';
ipcRenderer.on('clip:token', (event, value) => { if (typeof value === 'string') token = value; });
const invoke = (name, payload = {}) => ipcRenderer.invoke(name, { ...payload, token });

contextBridge.exposeInMainWorld('clipboardHost', {
  onState: callback => ipcRenderer.on('clip:state', (event, state) => { if (typeof callback === 'function') callback(state); }),
  // 窗口每次被呼出时通知页面：用来清掉上一次的大图预览。
  onShown: callback => ipcRenderer.on('clip:shown', () => { if (typeof callback === 'function') callback(); }),
  // 窗口被请求关闭（标题栏×/Alt+F4 都会走到这里）：页面先决定是否只关预览，
  // 并用 ackCloseRequest 回执（带请求号）；不回执时主进程会超时安全收起。
  onCloseRequest: callback => ipcRenderer.on('clip:close-request', (event, id) => {
    if (typeof callback === 'function') callback(id);
  }),
  ackCloseRequest: (id, action) => invoke('clip:close-ack', { id, action }),
  // 窗口收起时通知：作废在途的大图请求，不在看不到的时候把预览打开。
  onHidden: callback => ipcRenderer.on('clip:hidden', () => { if (typeof callback === 'function') callback(); }),
  state: () => invoke('clip:state'),
  list: payload => invoke('clip:list', payload),
  get: id => invoke('clip:get', { id }),
  thumb: id => invoke('clip:thumb', { id }),
  image: id => invoke('clip:image', { id }),
  imageFull: id => invoke('clip:image-full', { id }),
  copy: id => invoke('clip:copy', { id }),
  copyMany: (ids, options) => invoke('clip:copy-many', { ids, paste: options?.paste === true }),
  paste: id => invoke('clip:paste', { id }),
  favorite: (id, value) => invoke('clip:favorite', { id, value }),
  pinned: (id, value) => invoke('clip:pinned', { id, value }),
  note: (id, text) => invoke('clip:note', { id, text }),
  tags: (id, tags) => invoke('clip:tags', { id, tags }),
  remove: id => invoke('clip:remove', { id }),
  stats: () => invoke('clip:stats'),
  cleanupPreview: () => invoke('clip:cleanup-preview'),
  cleanup: () => invoke('clip:cleanup'),
  updateClipboard: patch => invoke('clip:update-clipboard', { patch }),
  setEnabled: enabled => invoke('clip:set-enabled', { enabled }),
  setPaused: paused => invoke('clip:set-paused', { paused }),
  openWorkspace: ids => invoke('clip:open-workspace', { ids }),
  openEditor: id => invoke('clip:open-editor', { id }),
  groups: () => invoke('clip:groups'),
  openGroup: groupId => invoke('clip:open-group', { groupId }),
  hide: () => invoke('clip:hide')
});
