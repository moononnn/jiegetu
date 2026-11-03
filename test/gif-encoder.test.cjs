'use strict';
// GIF 编码 worker 的定向测试：真跑 worker_threads + gifenc，测试自己写一个最小 GIF 块解析来断言结构，
// 不引第三方 decoder；不采屏、不建窗口、不写盘。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { createGifEncoder } = require('../main/gif-encoder.cjs');

const WORKER_FILE = path.join(__dirname, '..', 'main', 'gif-encoder-worker.cjs');

// —— 最小 GIF 结构解析（只读块头/时长/尺寸，不还原像素） ——
function parseGif(bytes) {
  assert.ok(bytes instanceof Uint8Array, 'finish 要交出 Uint8Array');
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(buf.toString('ascii', 0, 6), 'GIF89a', 'GIF89a 头');
  const screen = { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), gct: Boolean(buf[10] & 0x80) };
  let cursor = 13;
  if (screen.gct) cursor += 3 * (1 << ((buf[10] & 7) + 1));
  const frames = [];
  let loop = null, pendingGce = null, trailer = false;
  const skipSubBlocks = () => {
    while (cursor < buf.length) { const size = buf[cursor++]; if (!size) return; cursor += size; }
  };
  while (cursor < buf.length) {
    const marker = buf[cursor++];
    if (marker === 0x3b) { trailer = true; break; }
    if (marker === 0x21) {
      const label = buf[cursor++];
      if (label === 0xf9) {
        assert.equal(buf[cursor], 4, 'GCE 块长固定 4');
        const flags = buf[cursor + 1];
        pendingGce = { delayCs: buf.readUInt16LE(cursor + 2), disposal: (flags >> 2) & 7, transparent: Boolean(flags & 1) };
        cursor += 5;              // 1 块长 + 4 数据
        assert.equal(buf[cursor++], 0, 'GCE 终止符');
        continue;
      }
      const size = buf[cursor++];
      const id = buf.toString('ascii', cursor, cursor + size);
      cursor += size;
      const start = cursor;
      skipSubBlocks();
      const sub = buf.subarray(start, cursor);
      if (label === 0xff && id === 'NETSCAPE2.0' && sub[0] === 3 && sub[1] === 1) loop = sub.readUInt16LE(2);
      continue;
    }
    if (marker === 0x2c) {
      const frame = { x: buf.readUInt16LE(cursor), y: buf.readUInt16LE(cursor + 2),
        width: buf.readUInt16LE(cursor + 4), height: buf.readUInt16LE(cursor + 6),
        localTable: Boolean(buf[cursor + 8] & 0x80) };
      cursor += 9;
      if (frame.localTable) cursor += 3 * (1 << ((buf[cursor - 1] & 7) + 1));
      cursor += 1;                // LZW 最小码长
      skipSubBlocks();
      assert.ok(pendingGce, '每帧都要有 GCE');
      frames.push({ ...frame, ...pendingGce });
      pendingGce = null;
      continue;
    }
    throw new Error(`未知 GIF 块 0x${marker.toString(16)}（偏移 ${cursor - 1}）`);
  }
  return { ...screen, loop, frames, trailer, bytes: buf.length };
}

function rgba(width, height, color) {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    out[i * 4] = color[0]; out[i * 4 + 1] = color[1]; out[i * 4 + 2] = color[2]; out[i * 4 + 3] = 255;
  }
  return out;
}
const RED = [255, 0, 0], BLUE = [0, 0, 255];

function workerOnce(worker, message) {
  return new Promise((resolve, reject) => {
    const onMessage = value => { if (value && value.id === message.id) { done(); resolve(value); } };
    const onError = error => { done(); reject(error); };
    const done = () => { worker.off('message', onMessage); worker.off('error', onError); };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.postMessage(message);
  });
}

test('单帧静止 GIF：GIF89a/尺寸/无限循环/1 帧/时长按 finish 算准', async () => {
  const gif = createGifEncoder({ width: 2, height: 2 });
  await gif.frame(rgba(2, 2, RED), 0);
  const bytes = await gif.finish(500);
  const parsed = parseGif(bytes);
  assert.deepEqual([parsed.width, parsed.height], [2, 2], '逻辑屏幕就是传入尺寸');
  assert.equal(parsed.gct, true, '有全局调色板');
  assert.equal(parsed.loop, 0, 'repeat=0 无限循环');
  assert.equal(parsed.frames.length, 1, '静止只有一帧');
  assert.equal(parsed.frames[0].delayCs, 50, '500ms → 50 厘秒');
  assert.equal(parsed.frames[0].transparent, false, '不透明帧，不留透明空洞');
  assert.equal(parsed.frames[0].disposal, 1, '整幅帧：不处置（保留）');
  assert.deepEqual([parsed.frames[0].x, parsed.frames[0].y, parsed.frames[0].width, parsed.frames[0].height],
    [0, 0, 2, 2], '整幅贴 (0,0)');
  assert.equal(parsed.trailer, true, '有 0x3B 结束符');
});

test('变化帧：时长落在上一帧上，总时长等于 finish 时刻', async () => {
  const gif = createGifEncoder({ width: 4, height: 4 });
  await gif.frame(rgba(4, 4, RED), 0);
  await gif.frame(rgba(4, 4, BLUE), 300);
  const parsed = parseGif(await gif.finish(1000));
  assert.equal(parsed.frames.length, 2, '两个变化帧');
  assert.deepEqual(parsed.frames.map(frame => frame.delayCs), [30, 70], '红 300ms + 蓝 700ms');
  assert.equal(parsed.frames.reduce((sum, frame) => sum + frame.delayCs, 0), 100, '总时长 1000ms');
  assert.equal(parsed.frames[1].localTable, true, '非首帧自带局部调色板');
  assert.equal(parsed.loop, 0);
});

test('10FPS 连续变化：舍入误差不累积成加速或减速', async () => {
  const gif = createGifEncoder({ width: 4, height: 4 });
  for (let index = 0; index < 4; index += 1) {
    await gif.frame(rgba(4, 4, index % 2 ? BLUE : RED), index * 100);
  }
  const parsed = parseGif(await gif.finish(400));
  assert.deepEqual(parsed.frames.map(frame => frame.delayCs), [10, 10, 10, 10], '每帧都是 100ms，不越走越快');
  assert.equal(parsed.frames.reduce((sum, frame) => sum + frame.delayCs, 0), 40);
});

test('同一时刻的变化帧不会写出 0 延迟（0 会被当成 100ms）', async () => {
  const gif = createGifEncoder({ width: 2, height: 2 });
  await gif.frame(rgba(2, 2, RED), 0);
  await gif.frame(rgba(2, 2, BLUE), 0);
  const parsed = parseGif(await gif.finish(100));
  assert.deepEqual(parsed.frames.map(frame => frame.delayCs), [1, 9], '最小时长 1 厘秒，总量仍对得上');
  assert.equal(parsed.frames.reduce((sum, frame) => sum + frame.delayCs, 0), 10);
});

test('没有帧就 finish：明确失败，不产出空 GIF', async () => {
  const gif = createGifEncoder({ width: 2, height: 2 });
  try {
    await assert.rejects(gif.finish(100), error => error.code === 'NO_FRAMES' && /帧/.test(error.message));
  } finally { gif.cancel(); }
});

test('构造期尺寸与 maxBytes 校验；4096/400 万像素边界', async () => {
  for (const options of [{ width: 0, height: 2 }, { width: 2, height: 0 }, { width: -2, height: 2 },
    { width: 1.5, height: 2 }, { width: '2', height: 2 }, { width: NaN, height: 2 },
    { width: undefined, height: undefined },
    { width: 4097, height: 1 }, { width: 1, height: 4097 }, { width: 4096, height: 4097 },
    { width: 2000, height: 2001 }, { width: 2048, height: 2048 }]) {
    assert.throws(() => createGifEncoder(options), error => error.code === 'BAD_SIZE', `应拒绝 ${JSON.stringify(options)}`);
  }
  for (const maxBytes of [0, -1, 1.5, '1024', NaN]) {
    assert.throws(() => createGifEncoder({ width: 2, height: 2, maxBytes }), error => error.code === 'BAD_MAX_BYTES');
  }
  // 4096 边长、恰好 4,000,000 像素（2000×2000）都合法；拿到就走，不留线程。
  const max = createGifEncoder({ width: 4096, height: 976 });
  max.cancel();
  const square = createGifEncoder({ width: 2000, height: 2000 });
  square.cancel();
});

test('帧数据必须是恰好 w*h*4 的 Uint8Array/Uint8ClampedArray', async () => {
  const gif = createGifEncoder({ width: 2, height: 2 });
  try {
    for (const bad of [new Uint8Array(15), new Uint8Array(17), [0, 0, 0, 255], 'rgba', null, undefined,
      new Uint16Array(8), new DataView(new ArrayBuffer(16))]) {
      await assert.rejects(gif.frame(bad, 0), error => error.code === 'BAD_FRAME', `应拒绝 ${String(bad)}`);
    }
    await gif.frame(new Uint8ClampedArray(16), 0);   // 合法：ClampedArray 也收
    await gif.frame(Buffer.alloc(16, 9), 100);        // 合法：Buffer 也是 Uint8Array
    const parsed = parseGif(await gif.finish(200));
    assert.equal(parsed.frames.length, 2);
  } finally { gif.cancel(); }
});

test('池化 Buffer / byteOffset 视图：只送那 w*h*4 字节，也不 detach 调用方缓冲', async () => {
  const gif = createGifEncoder({ width: 2, height: 2 });
  const big = new Uint8Array(64);
  big.fill(3);
  const view = big.subarray(16, 32);   // 帧只有 16 字节，前面还垫着 16 字节
  view.fill(200);
  await gif.frame(view, 0);
  assert.equal(big.byteLength, 64, '调用方的 ArrayBuffer 没被 transfer 拿走');
  assert.equal(big[16], 200, '调用方数据原样还在');
  const pooled = Buffer.allocUnsafe(16);  // 小 Buffer 通常来自共享池，byteOffset 不为 0
  pooled.fill(120);
  await gif.frame(pooled, 100);
  assert.equal(pooled.byteLength, 16);
  const parsed = parseGif(await gif.finish(200));
  assert.equal(parsed.frames.length, 2, '视图与池化 Buffer 都按整帧编码');
  assert.equal(parsed.width, 2);
});

test('时间必须单调、非负、不超帧界；finish 硬界 31000ms', async () => {
  const gif = createGifEncoder({ width: 2, height: 2 });
  try {
    await gif.frame(rgba(2, 2, RED), 100);
    for (const [value, pattern] of [[99, /回退/], [-1, /0\.\.30000/], [30001, /30000/],
      [NaN, /有限数值/], [Infinity, /有限数值/], ['200', /有限数值/], [undefined, /有限数值/]]) {
      await assert.rejects(gif.frame(rgba(2, 2, BLUE), value), pattern, `应拒绝 ${String(value)}`);
    }
    await assert.rejects(gif.finish(31001), /31000/, 'finish 允许到 31000，再多就拒');
    await assert.rejects(gif.finish(99), /回退/);
    const parsed = parseGif(await gif.finish(31000));
    assert.equal(parsed.frames.length, 1);
    // 首帧在 GIF 时间里从 0 起算，所以这张唯一的帧一直停到 31000ms。
    assert.equal(parsed.frames[0].delayCs, 3100, '0 → 31000ms 的停留时长');
  } finally { gif.cancel(); }
});

test('单飞：上一帧还在编码时新命令立刻被拒，不排队', async () => {
  const gif = createGifEncoder({ width: 64, height: 64 });
  try {
    const first = gif.frame(rgba(64, 64, RED), 0);
    await assert.rejects(gif.frame(rgba(64, 64, BLUE), 100), error => error.code === 'BUSY');
    await assert.rejects(gif.finish(200), error => error.code === 'BUSY');
    await first;
    const parsed = parseGif(await gif.finish(200));
    assert.equal(parsed.frames.length, 1, '被拒的命令没有偷偷改进状态');
  } finally { gif.cancel(); }
});

test('超过 maxBytes：明确失败并销毁线程，不伪造成功', async () => {
  const gif = createGifEncoder({ width: 2, height: 2, maxBytes: 64 });
  await gif.frame(rgba(2, 2, RED), 0);
  await assert.rejects(gif.finish(100), error => error.code === 'MAX_BYTES' && /64 字节上限/.test(error.message));
  // 线程已销毁：后续命令一律失败，不会给出半截 GIF。
  await assert.rejects(gif.frame(rgba(2, 2, BLUE), 200), error => error.code === 'MAX_BYTES');
  await assert.rejects(gif.finish(300), error => error.code === 'MAX_BYTES');
});

test('取消：在途命令被拒、随后一律拒、重复取消不抛也不留线程', async () => {
  const gif = createGifEncoder({ width: 2, height: 2 });
  const inflight = gif.frame(rgba(2, 2, RED), 0);
  gif.cancel();
  await assert.rejects(inflight, error => error.code === 'CANCELLED');
  gif.cancel();
  gif.cancel();
  await assert.rejects(gif.frame(rgba(2, 2, BLUE), 10), error => error.code === 'CANCELLED');
  await assert.rejects(gif.finish(20), error => error.code === 'CANCELLED');
});

test('finish 只交一次，线程收掉后不再接受帧', async () => {
  const gif = createGifEncoder({ width: 2, height: 2 });
  await gif.frame(rgba(2, 2, RED), 0);
  const bytes = await gif.finish(100);
  assert.ok(bytes.byteLength > 0);
  await assert.rejects(gif.finish(200), error => error.code === 'FINISHED');
  await assert.rejects(gif.frame(rgba(2, 2, BLUE), 300), error => error.code === 'FINISHED');
  gif.cancel(); // 结束后再取消是空操作
});

test('worker 自己独立校验：绕过宿主直接发坏 init/坏帧会被拒', async () => {
  const badInit = new Worker(WORKER_FILE);
  try {
    const rejected = await workerOnce(badInit, { type: 'init', id: 1, width: 5000, height: 2, maxBytes: 1024 });
    assert.equal(rejected.type, 'error');
    assert.equal(rejected.code, 'BAD_SIZE');
  } finally { await badInit.terminate(); }

  const worker = new Worker(WORKER_FILE);
  try {
    assert.equal((await workerOnce(worker, { type: 'init', id: 1, width: 2, height: 2, maxBytes: 1024 })).type, 'ready');
    const short = await workerOnce(worker, { type: 'frame', id: 2, elapsedMs: 0, buffer: new ArrayBuffer(15) });
    assert.equal(short.code, 'BAD_FRAME', '长度不符由线程自己发现');
    const notBuffer = await workerOnce(worker, { type: 'frame', id: 3, elapsedMs: 0, buffer: [1, 2, 3] });
    assert.equal(notBuffer.code, 'BAD_FRAME');
    const backwards = await workerOnce(worker, { type: 'frame', id: 4, elapsedMs: -5, buffer: new ArrayBuffer(16) });
    assert.equal(backwards.code, 'BAD_ELAPSED');
    assert.equal((await workerOnce(worker, { type: 'frame', id: 5, elapsedMs: 100, buffer: new ArrayBuffer(16) })).type, 'ok');
    const back = await workerOnce(worker, { type: 'frame', id: 6, elapsedMs: 50, buffer: new ArrayBuffer(16) });
    assert.equal(back.code, 'TIME_BACKWARDS', '线程自己挡回退的时间');
  } finally { await worker.terminate(); }
});
