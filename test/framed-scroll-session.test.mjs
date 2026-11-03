import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFramedScrollSession } from '../core/framed-scroll-session.mjs';
import { createScrollSession } from '../core/scroll-session.mjs';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
const width = 80, top = 24, bottom = 184, height = 220;
function frame(offset, marker = 0) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y >= top && y < bottom ? y - top + offset : y;
    const value = ((Math.imul(p + 17, 1103515245) ^ Math.imul(x + 7, 214013)) >>> 11) & 255;
    const i = (y * width + x) * 4;
    data[i] = value; data[i + 1] = (value * 7) & 255; data[i + 2] = 255 - value; data[i + 3] = 170 + value % 86;
  }
  data[bottom * width * 4] = marker; // 单个动态像素用于验证尾栏来源，不是布局变化。
  return { width, height, data };
}
function expected(offset, marker) {
  const first = frame(0), last = frame(offset, marker), data = new Uint8ClampedArray(width * (height + offset) * 4);
  data.set(first.data.slice(0, bottom * width * 4));
  for (let p = 0; p < offset; p++) {
    const source = frame(offset, marker), y = bottom - offset + p;
    data.set(source.data.slice(y * width * 4, (y + 1) * width * 4), (bottom + p) * width * 4);
  }
  data.set(last.data.slice(bottom * width * 4), (bottom + offset) * width * 4);
  return data;
}
test('生产worker不再接受显式范围：旧content参数明确拒绝，不退回自动识别', async () => {
  const url = new URL('../renderer/scroll-match-worker.mjs', import.meta.url).href;
  const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(`
    import { parentPort } from 'node:worker_threads';
    globalThis.self={postMessage:(packet,transfer)=>parentPort.postMessage(packet,transfer)};
    await import(${JSON.stringify(url)});
    parentPort.on('message',data=>self.onmessage({data}));
  `)), {type:'module'});
  const send = async packet => {const result=once(worker,'message');worker.postMessage(packet);return (await result)[0];};
  try {
    const rejected = await send({type:'init',image:frame(0),content:{top,bottom}});
    assert.equal(rejected.type,'error'); assert.match(rejected.message,/不再接收手动正文范围/);
    // 拒绝后没有建立任何会话，后续帧只能报未启动，而不是静默落到自动识别。
    const orphan = await send({type:'frame',id:1,image:frame(20,9),atMs:1});
    assert.equal(orphan.type,'error'); assert.match(orphan.message,/未启动/);
  } finally {await worker.terminate();}
});
test('旧整帧基线拒绝真底栏，新模式头尾各一次且RGBA不变', () => {
  const old = createScrollSession(frame(0), { preservePixels: true });
  assert.equal(old.accept(frame(12, 1), 1).added, 0); old.clear();
  const session = createFramedScrollSession(frame(0), { top, bottom });
  assert.equal(session.stats().height, height);
  assert.equal(session.accept(frame(12, 1), 1).added, 12);
  assert.equal(session.accept(frame(28, 2), 2).added, 16);
  const output = session.finish();
  assert.equal(output.height, height + 28); assert.equal(output.background, undefined);
  assert.deepEqual(output.data, expected(28, 2)); session.clear();
});
test('回滚、静止和失配帧不替换可信尾栏；禁用原像素pending', () => {
  const session = createFramedScrollSession(frame(0), { top, bottom });
  session.accept(frame(20, 11), 1);
  assert.equal(session.accept(frame(10, 22), 2).added, 0);
  assert.equal(session.accept(frame(20, 33), 3).added, 0);
  const bad = frame(400, 44); assert.equal(session.accept(bad, 4).added, 0);
  assert.equal(session.stats().pendingFrames, 0);
  assert.deepEqual(session.finish().data, expected(20, 11)); session.clear();
});
test('追加前预留头尾总高度预算，刚好到上限可以，超过不追加', () => {
  const session = createFramedScrollSession(frame(0), { top, bottom }, { maxHeight: 230 });
  assert.equal(session.accept(frame(10), 1).height, 230);
  const refused = session.accept(frame(20), 2);
  assert.equal(refused.limit, true); assert.equal(refused.added, 0);
  assert.equal(session.finish().height, 230); session.clear();
});
test('固定栏明显变化即锁住，恢复画面也不擅自续接', () => {
  const session = createFramedScrollSession(frame(0), { top, bottom });
  session.accept(frame(10), 1);
  const changed = frame(20); changed.data.fill(0, bottom * width * 4);
  assert.equal(session.accept(changed, 2).result.kind, 'layout-changed');
  assert.equal(session.accept(frame(30), 3).result.kind, 'layout-changed');
  assert.equal(session.finish().height, 230); session.clear();
});
test('允许单侧固定栏或零固定栏，范围和尺寸异常明确拒绝', () => {
  for (const content of [{top:0,bottom:184},{top:24,bottom:220},{top:0,bottom:220}]) {
    const s = createFramedScrollSession(frame(0), content); assert.equal(s.finish().height, height); s.clear();
  }
  for (const content of [{top:-1,bottom:184},{top:24.5,bottom:184},{top:200,bottom:220},{top:24,bottom:221}]) {
    assert.throws(() => createFramedScrollSession(frame(0), content), /范围/);
  }
  const s = createFramedScrollSession(frame(0), {top,bottom});
  assert.throws(() => s.accept({...frame(1),height:221},1), /尺寸/);s.clear();s.clear();
  assert.throws(() => s.finish(), /清除/);
});
