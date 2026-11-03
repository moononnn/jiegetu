'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function harness(platform = 'win32') {
  let api, accept = true, resolveBegin;
  const calls = [], listeners = new Map();
  const electron = { contextBridge: { exposeInMainWorld(_name, value) { api = value; } }, ipcRenderer: {
    on(name, listener) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(listener); },
    removeListener(name, listener) { listeners.set(name, (listeners.get(name) || []).filter(item => item !== listener)); },
    invoke(name, ...args) {
      calls.push({ name, args });
      if (name === 'shot:init') return Promise.resolve({ diagnosticEnabled: false });
      if (name === 'shot:scroll-begin') return new Promise(resolve => { resolveBegin = resolve; });
      return Promise.resolve(accept);
    }
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main/selection-preload.cjs'), 'utf8'), {
    process: { platform },
    require: name => { assert.equal(name, 'electron'); return electron; }
  });
  const activate = () => { for (const listener of [...(listeners.get('shot:activate') || [])]) listener({}, true); };
  return { api, calls, activate, finish: () => resolveBegin({ started: true }), rejectRecords: () => { accept = false; },
    emit: (name, value) => { for (const listener of [...(listeners.get(name) || [])]) listener({}, value); } };
}
test('Windows 同步标明原生源，原生帧请求只透传本轮token', async () => {
  const h = harness(); assert.equal(h.api.captureMode, 'windows-native'); await h.api.nativeFrame('owned-token');
  assert.equal(h.calls[0].name, 'shot:scroll-frame'); assert.deepEqual(Array.from(h.calls[0].args), ['owned-token']);
  assert.equal(harness('linux').api.captureMode, 'media');
});
test('原图预览只透传当前长图token，不扩大文件读取入口', async () => {
  const h = harness(); await h.api.previewImage('long-token');
  assert.equal(h.calls[0].name, 'shot:preview-image'); assert.deepEqual(Array.from(h.calls[0].args), ['long-token']);
});
test('预载页：未收到 activate 前 init 不发 shot:init；激活后才发且只发一次', async () => {
  const h = harness();
  let settled = false;
  const pending = h.api.init().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'init 卡在激活门槛');
  assert.equal(h.calls.some(call => call.name === 'shot:init'), false, '未激活不 invoke');
  await assert.rejects(h.api.init(), /已开始初始化/, '重复 init 立即拒绝，不排队也不 invoke');
  assert.equal(h.calls.some(call => call.name === 'shot:init'), false);
  h.activate();
  await pending;
  assert.equal(h.calls.filter(call => call.name === 'shot:init').length, 1);
  // 重复 activate 无影响；重复 init 明确拒绝且不再 invoke（不缓存 payload/promise）。
  h.activate(); h.activate();
  await assert.rejects(h.api.init(), /已开始初始化.*不能重复调用/);
  assert.equal(h.calls.filter(call => call.name === 'shot:init').length, 1, '重复 init 不再发 IPC');
  assert.equal(h.api.activate, undefined, '不暴露激活入口');
  assert.equal(h.api.invoke, undefined, '不暴露任意 IPC');
});
test('激活事件先于 init：init 直接发一次 shot:init', async () => {
  const h = harness();
  h.activate();
  await h.api.init();
  assert.equal(h.calls.filter(call => call.name === 'shot:init').length, 1);
});

test('普通截图不发送排查事件；正常长截图IPC尚未返回时已允许worker记录', async () => {
  const h = harness(); h.activate(); await h.api.init();
  assert.equal(await h.api.diagnostic('wheel', { inside: true }), false);
  assert.equal(h.calls.some(call => call.name === 'shot:diagnostic'), false);
  const begin = h.api.beginScroll({ x: 1, y: 2, width: 100, height: 200 });
  assert.equal(await h.api.diagnostic('worker-start', {}), true);
  assert.equal(await h.api.diagnostic('media-request', {}), true);
  h.finish(); await begin;
  h.rejectRecords(); assert.equal(await h.api.diagnostic('sample', {}), false);
  const before = h.calls.length; await h.api.diagnostic('sample', {}); assert.equal(h.calls.length, before);
  const next = h.api.beginScroll({ width: 100, height: 200 });
  await h.api.diagnostic('worker-start', {}); assert.ok(h.calls.length > before + 1);
  h.finish(); await next;
});
test('编辑桥接仅暴露来源和会话操作，完整PNG作为第四参透传',async()=>{
  const h=harness(),rect={x:1,y:2,width:100,height:200},edited={token:'owned-edit',png:Uint8Array.of(137,80,78,71)};
  await h.api.editSource(rect,'long-owned','仅保留已接部分');await h.api.editState('owned-edit','close');await h.api.commit(rect,'copy','long-owned',edited);
  assert.deepEqual(h.calls.map(item=>item.name),['shot:edit-source','shot:edit-state','shot:commit']);
  assert.equal(h.calls[0].args[0],rect);assert.equal(h.calls[0].args[1],'long-owned');assert.equal(h.calls[0].args[2],'仅保留已接部分','长图警告原样透传');assert.equal(h.calls[2].args[3],edited);
  assert.equal(h.api.readFile,undefined);assert.equal(h.api.invoke,undefined);
});

test('编辑窗回传预览只走订阅通道，不开放任意事件名', async () => {
  const h = harness();
  const seen = [];
  const off = h.api.onEditorPreview(payload => seen.push(payload));
  h.emit('shot:editor-preview', { token: 'owned-edit', thumbnail: 'data:image/png;base64,thumb', outputSize: { width: 10, height: 20 } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].token, 'owned-edit');
  off();
  h.emit('shot:editor-preview', { token: 'owned-edit' });
  assert.equal(seen.length, 1, '退订后不再收');
  assert.equal(h.api.on, undefined, '没有任意通道订阅入口');
});

test('识别桥只透传编辑器算好的局部 PNG，不开放磁盘或任意 IPC', async () => {
  const h = harness();
  const payload = { token: 'owned-edit', png: Uint8Array.of(137, 80, 78, 71), width: 200, height: 200 };
  await h.api.recognizeText(payload);
  assert.deepEqual(h.calls.map(item => item.name), ['shot:recognize-text']);
  assert.equal(h.calls[0].args[0], payload, 'payload 原样交给主进程，不由渲染层补字段');
  assert.equal(h.calls[0].args.length, 1);
  assert.equal(h.api.readFile, undefined);
  assert.equal(h.api.invoke, undefined);
});

test('选区预载不再暴露反馈发送桥：没有 feedback / feedbackTarget 入口', async () => {
  const h = harness();
  for (const name of ['feedback', 'feedbackTarget', 'sendMessage', 'readFile', 'invoke']) {
    assert.equal(name in h.api, false, `不应再暴露 ${name}`);
  }
  assert.equal(typeof h.api.recognizeText, 'function', '识别通道不受影响');
});

test('退出桥接只交文档 token 与来源，不开放任意通道或直接结束会话', async () => {
  const h = harness();
  await h.api.requestExit('owned-long', 'context-menu');
  assert.deepEqual(h.calls.map(item => item.name), ['shot:request-exit']);
  assert.deepEqual(Array.from(h.calls[0].args), ['owned-long', 'context-menu'], '两参原样透传，白名单由主进程裁决');
  assert.equal(h.api.requestExit.length, 2);
  assert.equal(h.api.invoke, undefined);
  assert.equal(h.api.exit, undefined, '不暴露不带确认的退出入口');
});

test('最小化桥只透传当前文档 token 到固定通道，不开放任意窗口操作', async () => {
  const h = harness();
  await h.api.minimizeEditor('owned-edit');
  assert.deepEqual(h.calls.map(item => item.name), ['shot:edit-minimize']);
  assert.deepEqual(Array.from(h.calls[0].args), ['owned-edit'], '只交 token，不夹带其它参数');
  assert.equal(h.api.invoke, undefined);
  assert.equal(h.api.minimize, undefined, '不暴露任意窗口控制');
});

test('长图结果第4参只把异常恢复标志原样透传，三参调用契约不变', async () => {
  const h = harness();
  await h.api.scrollResult('owned-token', new ArrayBuffer(4), '警告');
  assert.equal(h.calls.at(-1).name, 'shot:scroll-result');
  assert.deepEqual(Object.keys(h.calls.at(-1).args[1]).sort(), ['png', 'warning']);
  await h.api.scrollResult('owned-token', new ArrayBuffer(4), '警告', true);
  assert.deepEqual(h.calls.at(-1).args[1].recovered, true);
  for (const value of [false, 'true', 1, undefined, null]) {
    await h.api.scrollResult('owned-token', new ArrayBuffer(4), '警告', value);
    assert.equal('recovered' in h.calls.at(-1).args[1], false, `非布尔真值 ${String(value)} 不得放行`);
  }
});

test('录制桥接只透传本地选区矩形，复用固定 IPC，不开放任意通道', async () => {
  const h = harness(); h.activate();
  const rect = { x: 10, y: 20, width: 200, height: 100 };
  await h.api.beginRecord(rect);
  assert.equal(h.calls.at(-1).name, 'shot:record-begin');
  assert.equal(h.calls.at(-1).args.length, 1, '不夹带尺寸、token 或别的参数');
  assert.equal(h.calls.at(-1).args[0], rect);
  assert.equal(h.api.invoke, undefined);
  assert.equal(h.api.beginRecord.length, 1);
});
