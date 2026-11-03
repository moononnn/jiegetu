import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createAutoScrollSession } from '../core/auto-scroll-session.mjs';
import { createScene } from './fixtures/auto-scenes.mjs';

// Worker 会先发轻量证据版本事件：harness 必须当元数据过滤，不能当成匹配回包（也不能丢后续真实回包）。
function channel(worker) {
  const queue = []; let wake;
  worker.on('message', value => {
    if (value?.type === 'evidence-invalidated') return;
    queue.push(value); wake?.();
  });
  return async packet => {
    worker.postMessage(packet, packet.image ? [packet.image.data.buffer] : []);
    while (!queue.length) await new Promise(resolve => { wake = resolve; });
    wake = undefined;
    return queue.shift();
  };
}

// 随机灰度文档：每行都有横向细节，但不含固定栏，便于构造向上/向下双向位移。
function document({ width = 64, height = 300, pad = 96, rows = 900, seed = 952 } = {}) {
  const data = new Uint8ClampedArray(width * (rows + pad) * 4);
  let state = seed;
  for (let i = 0; i < data.length; i += 4) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    data[i] = data[i + 1] = data[i + 2] = state >>> 24; data[i + 3] = 255;
  }
  return { data, width, height, pad, rows };
}
const view = (doc, offset) => ({ width: doc.width, height: doc.height,
  data: doc.data.slice((offset + doc.pad) * doc.width * 4, (offset + doc.pad + doc.height) * doc.width * 4) });
const expectedRows = (doc, start, height) => doc.data.slice((start + doc.pad) * doc.width * 4, (start + doc.pad + height) * doc.width * 4);

test('可信检查点：布局与可信跨度未确认时不给，确认后是独立原像素副本', () => {
  const scene = createScene({ offsets: [0, 16, 32, 48, 64, 80] });
  const session = createAutoScrollSession(scene.seedFrame);
  let time = 0;
  const checkpoints = [];
  for (const frame of scene.frames) {
    session.accept(frame.image, time += 50);
    checkpoints.push(session.checkpoint());
  }
  assert.equal(checkpoints[0], null, '学习期没有可信跨度，不能给检查点');
  assert.equal(checkpoints[1], null, '仍在学习期，不能拿首屏冒充接长');
  const first = checkpoints.at(-2), last = checkpoints.at(-1);
  assert.ok(first && last, '布局与跨度确认后必须给出检查点');
  // 尺寸与原像素来源：直接等于同高度的已确认文档，不做背景重铺、不裁高。
  assert.equal(last.width, scene.width);
  assert.equal(last.height, scene.expected.height);
  assert.equal(last.data.length, last.width * last.height * 4);
  assert.deepEqual(last.data, scene.expected.data);
  assert.deepEqual(first.data, scene.expected.data.slice(0, first.data.length));
  assert.notEqual(last.data.buffer, first.data.buffer, '每次检查点必须是独立缓冲区');
  // 拿到副本后继续调用不能改写它。
  const before = last.data.slice();
  session.accept(scene.lastFrame, time += 50);
  session.accept(scene.lastFrame, time += 50);
  assert.deepEqual(last.data, before, '后续帧处理不能改写已给出的副本');
});

test('可信检查点：向上接长同样是已确认原像素，可被调用方改写而不污染会话', () => {
  const doc = document(), offsets = [0, 24, 48, 72, 96, 72, 48, 24, -24];
  const session = createAutoScrollSession(view(doc, 0));
  let time = 0;
  for (const offset of offsets.slice(1)) session.accept(view(doc, offset), time += 50);
  const checkpoint = session.checkpoint();
  assert.ok(checkpoint, '上下都接过后必须给出检查点');
  const span = 96 - (-24);
  assert.equal(checkpoint.height, doc.height + span);
  assert.deepEqual(checkpoint.data, expectedRows(doc, -24, doc.height + span), '向上接长部分也必须来自原文档行');
  // 副本归调用方所有：改写它不能影响后续检查点与会话内部片段。
  checkpoint.data.fill(7);
  session.accept(view(doc, -48), time += 50);
  const next = session.checkpoint();
  assert.ok(next);
  assert.equal(next.height, doc.height + (96 + 48));
  assert.deepEqual(next.data, expectedRows(doc, -48, doc.height + 144));
  session.clear();
});

test('检查点契约：清除后拒绝使用，且不影响收尾输出的既有语义', () => {
  const scene = createScene();
  const session = createAutoScrollSession(scene.seedFrame);
  let time = 0;
  for (const frame of scene.frames) session.accept(frame.image, time += 50);
  const output = session.finish();
  assert.equal(output.complete, true, output.warning);
  assert.deepEqual(output.data, scene.expected.data, '检查点不引入额外背景重铺');
  session.clear();
  assert.throws(() => session.checkpoint(), /清除/);
});

async function workerRun(scene, inspect = () => {}) {
  const url = new URL('../renderer/scroll-match-worker.mjs', import.meta.url).href;
  const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(`
 import {parentPort} from 'node:worker_threads';
 globalThis.self={postMessage:(packet,transfer)=>parentPort.postMessage(packet,transfer)};
 await import(${JSON.stringify(url)});
 parentPort.on('message',data=>self.onmessage({data}));`)), { type: 'module' });
  const send = channel(worker);
  try {
    const ready = await send({ type: 'init', image: structuredClone(scene.seedFrame) });
    assert.equal(ready.type, 'ready');
    for (let index = 1; index < scene.frames.length; index++) {
      const sample = await send({ type: 'frame', id: index, image: structuredClone(scene.frames[index].image), atMs: index * 50 });
      assert.equal(sample.type, 'sample');
      assert.equal(sample.id, index);
      inspect(sample, index);
    }
    const done = await send({ type: 'finish' });
    assert.equal(done.type, 'done');
    return done.output;
  } finally { await worker.terminate(); }
}

test('真实Worker：只随已确认完整回包附检查点，尺寸正确且逐像素来自已确认文档', async () => {
  const scene = createScene();
  const seen = [];
  const output = await workerRun(scene, sample => {
    const carries = sample.checkpoint !== undefined;
    assert.equal(carries, sample.added > 0 && sample.complete && sample.height === sample.capturedHeight, '检查点只在完整回包上出现');
    if (!carries) return;
    const { width, height, data } = sample.checkpoint;
    assert.equal(width, scene.width); assert.equal(height, sample.height);
    assert.ok(ArrayBuffer.isView(data)); assert.equal(data.byteLength, width * height * 4);
    assert.deepEqual(data, scene.expected.data.slice(0, data.byteLength), '检查点必须是同高度已确认原像素');
    seen.push(height);
  });
  assert.ok(seen.length > 0, '多次确认接长后必须至少带回一份检查点');
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), '高度只能随确认增长，不回退');
  assert.equal(output.complete, true, output.warning);
  assert.deepEqual(output.data, scene.expected.data);
});

test('真实Worker：转移检查点不搬走会话或原帧，接受方改写副本也不影响收尾', async () => {
  const doc = document(), offsets = [0, 24, 48, 72, 96, 72, 48, 24, -24];
  const scene = { width: doc.width, height: doc.height, seedFrame: view(doc, 0), frames: offsets.map(offset => ({ offset, image: view(doc, offset) })) };
  const url = new URL('../renderer/scroll-match-worker.mjs', import.meta.url).href;
  const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(`
 import {parentPort} from 'node:worker_threads';
 globalThis.self={postMessage:(packet,transfer)=>parentPort.postMessage(packet,transfer)};
 await import(${JSON.stringify(url)});
 parentPort.on('message',data=>self.onmessage({data}));`)), { type: 'module' });
  const send = channel(worker);
  try {
    assert.equal((await send({ type: 'init', image: structuredClone(scene.seedFrame) })).type, 'ready');
    let last;
    for (let index = 1; index < scene.frames.length; index++) {
      const sample = await send({ type: 'frame', id: index, image: structuredClone(scene.frames[index].image), atMs: index * 50 });
      assert.equal(sample.type, 'sample');
      if (sample.checkpoint) last = sample.checkpoint;
    }
    assert.ok(last, '向上接长确认后也应带回检查点');
    const span = 96 - (-24);
    assert.equal(last.height, doc.height + span);
    assert.deepEqual(last.data, expectedRows(doc, -24, doc.height + span));
    // 调用方立刻改写自己收到的副本：会话与被转移的原帧都不受影响。
    last.data.fill(0);
    const done = await send({ type: 'finish' });
    assert.equal(done.type, 'done');
    assert.equal(done.output.height, doc.height + span);
    assert.deepEqual(done.output.data.slice(0, doc.height * doc.width * 4), expectedRows(doc, -24, doc.height).slice(0, doc.height * doc.width * 4));
  } finally { await worker.terminate(); }
});
