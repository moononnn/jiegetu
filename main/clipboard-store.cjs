/* 主进程侧的剪贴板存储客户端：只发窄请求，不碰 SQLite。
   DB/图像长任务都在 worker 线程里串行执行，不阻塞主进程事件循环。 */
'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

function createClipboardStore({ root, workerFile = path.join(__dirname, 'clipboard-store-worker.cjs'),
  maxStorageBytes = 2 * 1024 * 1024 * 1024, timeoutMs = 15000, workerFactory } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('剪贴板库目录必须为主进程私有绝对路径');
  let worker;
  let sequence = 0;
  let disposed = false;
  const pending = new Map();
  let waiters = [];

  function failAll(message) {
    for (const [id, entry] of pending) { clearTimeout(entry.timer); entry.reject(new Error(message)); pending.delete(id); }
    for (const waiter of waiters) waiter.reject(new Error(message));
    waiters = [];
  }

  function onMessage(message) {
    if (!message || typeof message.id !== 'number') return;
    if (message.id === 0) {
      if (message.ready) for (const waiter of waiters) waiter.resolve(true);
      waiters = [];
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok === true) entry.resolve(deserialize(message.result));
    else {
      const error = new Error(message.error?.message || '存储失败');
      error.code = message.error?.code || 'STORE_ERROR';
      entry.reject(error);
    }
  }

  function spawn() {
    if (worker) return worker;
    if (disposed) throw new Error('存储已关闭');
    worker = (workerFactory || (() => new Worker(workerFile, { workerData: { root, maxStorageBytes }, stdout: false, stderr: false })))();
    worker.on('message', onMessage);
    worker.on('error', error => { failAll(`剪贴板存储中断：${error?.message || error}`); });
    worker.on('exit', code => { if (!disposed && code !== 0) failAll('剪贴板存储已停止，历史暂时不可用'); });
    return worker;
  }

  function request(method, params = []) {
    if (disposed) return Promise.reject(new Error('存储已关闭'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('剪贴板存储响应超时'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { spawn().postMessage({ id, method, params }); }
      catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }

  // 等 worker 的 ready；调用方在拿到 ready 前不该发业务请求。
  function open() {
    if (disposed) return Promise.reject(new Error('存储已关闭'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('剪贴板存储启动超时')), timeoutMs);
      waiters.push({ resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      try { spawn(); } catch (error) { clearTimeout(timer); reject(error); }
    });
  }

  // 关闭：先不再接新请求，再有界等在途请求落定（退出时别丢尾），最后终止 worker。
  async function close({ timeout = 3000 } = {}) {
    if (disposed) return Promise.resolve();
    disposed = true;
    const deadline = Date.now() + timeout;
    while (pending.size > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    failAll('存储已关闭');
    const current = worker;
    worker = undefined;
    if (!current) return Promise.resolve();
    return current.terminate().catch(() => {}).then(() => {});
  }

  return {
    root, open, close,
    // 窄方法：renderer 永远拿不到这些名字以外的能力。
    addEntry: payload => request('addEntry', [payload]),
    list: payload => request('list', [payload]),
    get: id => request('get', [id]),
    contentOf: id => request('contentOf', [id]),
    setFavorite: (id, value) => request('setFavorite', [id, value]),
    setPinned: (id, value) => request('setPinned', [id, value]),
    setNote: (id, text) => request('setNote', [id, text]),
    setTags: (id, names) => request('setTags', [id, names]),
    touch: id => request('touch', [id]),
    removeHistory: id => request('removeHistory', [id]),
    pin: (owner, hash, reason) => request('pin', [owner, hash, reason]),
    release: owner => request('release', [owner]),
    stats: () => request('stats', []),
    cleanup: payload => request('cleanup', [payload]),
    saveGroup: payload => request('saveGroup', [payload]),
    getGroup: id => request('getGroup', [id]),
    listGroups: () => request('listGroups', []),
    deleteGroup: id => request('deleteGroup', [id]),
    groupAssetHashes: id => request('groupAssetHashes', [id]),
    assetSize: hash => request('assetSize', [hash]),
    assetSizes: hashes => request('assetSizes', [hashes]),
    readBlob: hash => request('readBlob', [hash]),
    writeBlob: (hash, bytes) => request('writeBlob', [hash, bytes]),
    pngSize: bytes => request('pngSize', [bytes]),
    setQuota: value => request('setQuota', [value]),
    getQuota: () => request('getQuota', []),
    // 只有测试/诊断需要看 worker 引用；正常路径不暴露。
    isAlive: () => Boolean(worker)
  };
}

function deserialize(value) {
  if (value && typeof value === 'object' && value.__bytes instanceof ArrayBuffer) return Buffer.from(value.__bytes);
  if (Array.isArray(value)) return value.map(deserialize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = deserialize(item);
    return out;
  }
  return value;
}

module.exports = { createClipboardStore, deserialize };
