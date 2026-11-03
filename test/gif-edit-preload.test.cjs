'use strict';
// 固定桥接能力测试；不启动 Electron，也不暴露任意 channel / ipcRenderer。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function bridge() {
  let api;
  const calls = [];
  const listeners = new Map();
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../main/gif-preload.cjs'), 'utf8'), {
    require: name => {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (key, value) => { assert.equal(key, 'gifRecorder'); api = value; } },
        ipcRenderer: {
          invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); },
          on: (channel, listener) => listeners.set(channel, listener),
          removeListener: (channel, listener) => { assert.equal(listeners.get(channel), listener); listeners.delete(channel); }
        }
      };
    }
  });
  return { api, calls, listeners };
}

test('GIF 编辑 preload：只有固定 gif:edit 四动作，未知 action 不触发 IPC', async () => {
  const { api, calls } = bridge();
  assert.deepEqual(Object.keys(api).sort(), ['action', 'edit', 'onPreview', 'onStatus', 'ready']);
  const payload = { sourceId: 'opaque', width: 2, height: 3 };
  for (const action of ['begin', 'frame', 'finish', 'abort']) {
    await api.edit(action, payload);
    assert.deepEqual(calls.at(-1), ['gif:edit', action, payload]);
  }
  for (const action of ['gif:edit', 'save', 'arbitrary:channel', null, {}]) {
    await assert.rejects(api.edit(action, payload), /不支持/);
  }
  assert.equal(calls.length, 4);
});

test('GIF 编辑 preload：窗口动作兼容旧白名单，新增 edit/edit-close 而不开放 channel', async () => {
  const { api, calls } = bridge();
  for (const action of ['stop', 'cancel', 'retry', 'save', 'save-quick', 'copy', 'edit', 'edit-close']) {
    await api.action(action);
    assert.deepEqual(calls.at(-1), ['gif:action', action]);
  }
  await assert.rejects(api.action('gif:edit'), /不支持/);
  await assert.rejects(api.action('shot:commit'), /不支持/);
  assert.equal(calls.length, 8);
  await api.ready();
  assert.deepEqual(calls.at(-1), ['gif:ready']);
});

test('GIF 编辑 preload：sourceId/字节预览原样传递且可退订', () => {
  const { api, listeners } = bridge();
  const value = { sourceId: 'opaque-source', bytes: new Uint8Array([71, 73, 70]), width: 2, height: 3, elapsedMs: 20 };
  let received;
  const unsubscribe = api.onPreview(preview => { received = preview; });
  listeners.get('gif:preview')({}, value);
  assert.equal(received, value);
  unsubscribe();
  assert.equal(listeners.has('gif:preview'), false);
});
