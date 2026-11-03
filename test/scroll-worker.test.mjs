import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fingerprint, detectShift, newRows, compose, MAX_PIXELS, MAX_HEIGHT } from '../core/scroll.mjs';
import { chatFrame } from './fixtures/chat-background.mjs';
import { createScrollSession } from '../core/scroll-session.mjs';
import { createAutoScrollSession } from '../core/auto-scroll-session.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
// 渲染端在 vm 上下文里重建视图，跨 realm 的 typed array 不能直接 deepEqual；按字节比较。
const sameBytes = (a, b) => a.byteLength === b.byteLength &&
  Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;
// 固定壁纸允许重铺；首屏、正文（含整块半透明纸面）与alpha仍须逐字节保持。
function protectedChatPixel(y, x, width, seedHeight, options = {}) {
  if (y < seedHeight) return true;
  const left = Math.max(8, Math.round(width * (options.inset ?? .064))), right = Math.round(width * .933);
  const line = y % 160;
  return x >= left && x < right && line >= 8 && line < 145;
}
function assertChatContent(actual, expected, options = {}) {
  assert.equal(actual.data.length, expected.length);
  const seedHeight = options.height ?? 539;
  for (let y = 0; y < actual.height; y++) for (let x = 0; x < actual.width; x++) {
    const q = (y * actual.width + x) * 4, protectedPixel = protectedChatPixel(y, x, actual.width, seedHeight, options);
    for (let c = 0; c < 4; c++) if (protectedPixel || c === 3) assert.equal(actual.data[q + c], expected[q + c], `正文/首屏改变 y=${y} x=${x} c=${c}`);
  }
}
const source = fs.readFileSync(new URL('../renderer/scroll-capture.mjs', import.meta.url), 'utf8').replace(/^import[^\n]+\n/, '');
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function harness({ media, configGate, configError = false, diagnostic = false, fixedFooter = false, readyAccepted = true, chat = false, matcherPaused = false, staleSeed = false, freshVideo = false, frozenVideo = false, startupAction, native = false, nativeQuiet = false, nativeGate, nativeGateAt = 2, nativeBadSize = false, content, seedOffset = 0, autoMode = false, sampleReplace, checkpoint = false, preview = true, referenceOnly = false, encodeGate, frameWidth, frameHeight, finishBackground } = {}) {
  const width = frameWidth ?? (chat ? (chat.width ?? 343) : 100), height = frameHeight ?? (chat ? (chat.height ?? 539) : 120);
  // 帧尺寸可配；文档至少比视口高 400 行，大帧也不用生成整张长图。
  const documentPixels = new Uint8ClampedArray(width * Math.max(600, height + 400) * 4);
  let seed = 952;
  for (let i = 0; i < documentPixels.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    documentPixels[i] = documentPixels[i + 1] = documentPixels[i + 2] = seed >>> 24; documentPixels[i + 3] = 255;
  }
  const view = offset => {
    if (chat) return chatFrame(offset, { width, height, footer: fixedFooter ? 4 : 0, ...chat }).data;
    const data = documentPixels.slice(offset * width * 4, (offset + height) * width * 4);
    if (fixedFooter) data.set(documentPixels.subarray((height - 4) * width * 4, height * width * 4), (height - 4) * width * 4);
    return data;
  };
  let pixels = view(seedOffset), now = 0, interval, output, sampleError, matcher, captureReads = 0, renderingResult = false;
  const alarms = [], renders = [], encoded = [], samples = [];
  class Worker {
    constructor() { renderingResult = false; matcher = this; this.held = []; this.frames = 0; this.processed = 0; this.paused = matcherPaused; this.holdNext = false; this.holdFinish = false; this.errorNext = undefined; }
    postMessage(packet, transfer = []) {
      const copy = structuredClone(packet, { transfer });
      if (copy.type === 'frame') { this.frames++; if (this.paused || this.holdNext) { this.holdNext = false; this.held.push(copy); return; } }
      this.process(copy);
    }
    process(packet) {
      if (this.stopped) return;
      try {
        if (packet.type === 'init') { if (packet.content !== undefined) throw new Error('长截图已改为自动识别，不再接收手动正文范围'); this.session = autoMode ? createAutoScrollSession(packet.image) : createScrollSession(packet.image); const stats = this.session.stats(); if (!preview) { stats.preview = undefined; stats.reference = undefined; } else if (referenceOnly) stats.preview = undefined; this.onmessage({ data: { type: 'ready', ...stats } }); }
        else if (packet.type === 'frame') {
          if (this.errorNext) { const spec = this.errorNext; this.errorNext = undefined; this.onmessage({ data: { type: 'error', ...spec } }); return; }
          this.processed++; const update = sampleReplace ? sampleReplace(packet) : this.session.accept(packet.image, packet.atMs);
          const trusted = checkpoint && typeof this.session.checkpoint === 'function' && update.added > 0 && update.complete && update.height === update.capturedHeight ? this.session.checkpoint() : null;
          samples.push({ id: packet.id, added: update.added, complete: update.complete, height: update.height, capturedHeight: update.capturedHeight, checkpoint: Boolean(trusted) });
          const reply = referenceOnly ? { ...update, preview: undefined } : preview ? update : { ...update, preview: undefined, reference: undefined };
          this.onmessage({ data: { type: 'sample', id: packet.id, ...reply, durationMs: 1, ...(trusted ? { checkpoint: trusted } : {}) } });
        }
        else if (packet.type === 'finish') { if (this.holdFinish) { this.holdFinish = false; return; } const output = this.session.finish(); if (finishBackground !== undefined) { if (finishBackground === null) delete output.background; else output.background = finishBackground; } this.session.clear(); renderingResult = true; this.onmessage({ data: { type: 'done', output } }); }
      } catch (error) { this.onmessage({ data: { type: 'error', message: error.message } }); }
    }
    release() { this.paused = false; for (const packet of this.held.splice(0)) this.process(packet); }
    terminate() { this.stopped = true; this.held = []; this.session?.clear(); }
  }
  const events = {}, calls = [], results = [], errors = [], trackEvents = {}, traces = [], progress = [];
  const track = { stopped: false, stop() { this.stopped = true; }, addEventListener(name, callback) { trackEvents[name] = callback; } };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const video = { videoWidth: width, videoHeight: height, readyState: 2, play: async () => {} };
  if (freshVideo || frozenVideo) video.currentTime = 0;
  if (!freshVideo && !frozenVideo) {
    video.requestVideoFrameCallback = callback => { queueMicrotask(() => callback(0, { presentedFrames: 1 })); return 1; };
    video.cancelVideoFrameCallback = () => {};
  }
  const config = { token: 'worker-token', pixels: { x: 0, y: 0, width, height }, frame: { width, height }, seed: 'data:seed', ...(content !== undefined ? { content } : {}) };
  const selection = {
    scrollConfig: async () => { calls.push('config'); if (configError) throw new Error('配置已失效'); if (configGate) await configGate.promise; return config; },
    scrollReady: async () => { calls.push('ready'); return readyAccepted; }, scrollFinishing: async () => calls.push('finishing'),
    scrollProgress: async (token, state) => progress.push({ token, ...state }),
    scrollResult: async (token, png, warning, recovered) => results.push({ token, png, warning, recovered }),
    scrollError: async (token, message, reason) => errors.push({ token, message, reason }),
    onScrollStop: fn => { events.stop = fn; }, onScrollAbort: fn => { events.abort = fn; }
  };
  if (native) {
    selection.captureMode = 'windows-native';
    selection.nativeFrame = async token => {
      assert.equal(token, config.token); calls.push('native'); captureReads++;
      const image = { fresh: true, sequence: captureReads, width: nativeBadSize ? width + 1 : width, height, data: pixels.slice() };
      if (nativeGate && captureReads === nativeGateAt) await nativeGate.promise;
      if (sampleError) throw new Error(sampleError);
      return nativeQuiet && captureReads > 1 ? { fresh: false } : image;
    };
  }
  if (diagnostic) selection.diagnostic = (event, fields) => {
    if (diagnostic === 'throw') throw new Error('diagnostic unavailable');
    if (diagnostic === 'reject') return Promise.reject(new Error('diagnostic unavailable'));
    traces.push({ event, fields }); return Promise.resolve(true);
  };
  class Canvas {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() {
      let input;
      return { drawImage(value) { input = value; },
        getImageData: () => { if (input === video && sampleError) throw new Error(sampleError); if (input === video) captureReads++; return { data: input === video ? pixels.slice() : staleSeed ? new Uint8ClampedArray(width * height * 4).fill(127) : view(0) }; },
        putImageData: data => { this.image = data; if (data.width === width && data.height >= height) { renders.push(data); if (renderingResult) output = data; } } };
    }
    async convertToBlob() { encoded.push(this.image); if (encodeGate) await encodeGate.promise; return new Blob(['fake-png'], { type: 'image/png' }); }
  }
  class Image { naturalWidth = width; naturalHeight = height; async decode() {} }
  class ImageData { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } }
  const window = { selection };
  vm.runInNewContext(source, { window, navigator: { mediaDevices: { getDisplayMedia: () => { calls.push('media'); return media?.promise ?? Promise.resolve(stream); } } },
    document: { createElement: () => video }, Image, ImageData, OffscreenCanvas: Canvas, Worker, btoa,
    fingerprint, detectShift, newRows, compose, MAX_PIXELS, MAX_HEIGHT, performance: { now: () => now },
    setTimeout: (fn, ms) => { if (ms >= 10000) { alarms.push(fn); return alarms.length + 10; } queueMicrotask(() => {
      if (freshVideo || frozenVideo) { now += ms; if (freshVideo) video.currentTime += ms / 1000; }
      if (startupAction && ms === 150) startupAction({ events, trackEvents, video, config });
      fn();
    }); return 1; }, clearTimeout() {}, setInterval: fn => { interval = fn; return 2; }, clearInterval: () => { interval = undefined; } });
  return { window, calls, results, errors, track, stream, video, events, config, trackEvents, traces, progress, renders, encoded, samples,
    getMatcher: () => matcher, captureReads: () => captureReads, alarms,
    failSample: message => { sampleError = message; },
    sample(offset, time, topColor, bottomColor) { pixels = view(offset); if (topColor === 'fixed') pixels.set(view(0).subarray(0, width * 4 * 4), 0); else if (topColor !== undefined) pixels.fill(topColor, 0, width * 4 * 4); if (bottomColor === 'coincidence') pixels.set(view(0).subarray((height - 7) * width * 4, (height - 6) * width * 4), (height - 7) * width * 4); else if (bottomColor !== undefined) pixels.fill(bottomColor, (height - 16) * width * 4); now = time; interval?.(); }, getOutput: () => output,
    expected: h => documentPixels.slice(0, h * width * 4),
    expectedRange: (start, end) => documentPixels.slice(start * width * 4, end * width * 4) };
}

test('旧的手动正文范围参数不再分派：renderer明确拒绝且不创建匹配任务',async()=>{
  const h=harness({native:true,content:{top:4,bottom:104}});
  await assert.rejects(h.window.startScrollCapture(),/不再接收手动正文范围/);
  assert.equal(h.getMatcher(),undefined);assert.equal(h.calls.includes('ready'),false);
  assert.equal(h.results.length,0);assert.equal(h.errors.length,1);
  assert.match(h.errors[0].message,/不再接收手动正文范围/);
});
test('Windows 原生首帧及后续帧同源，先隐藏框选，不申请带指针的媒体流', async () => {
  const h = harness({ native: true, diagnostic: true }); await h.window.startScrollCapture();
  assert.equal(h.calls.includes('media'), false); assert.ok(h.calls.indexOf('ready') < h.calls.indexOf('native'));
  h.sample(20, 100); await tick(); h.sample(40, 200); await tick(); h.events.stop(h.config.token); await tick();
  assert.equal(h.results.length, 1); assert.deepEqual(h.getOutput().data, h.expected(160));
  assert.equal(h.track.stopped, false); // Never opened this unrelated media source.
});
test('原生采集一帧未回时不再发请求，完成须等这一帧入队并排完', async () => {
  const gate = deferred(), h = harness({ native: true, nativeGate: gate }); await h.window.startScrollCapture();
  h.sample(20, 100); h.sample(40, 200); assert.equal(h.captureReads(), 2);
  h.events.stop(h.config.token); await tick(); assert.equal(h.results.length, 0);
  gate.resolve(); await tick(); await tick(); assert.equal(h.results.length, 1); assert.deepEqual(h.getOutput().data, h.expected(140));
});
test('取消原生采样后晚到画面不进入匹配器或输出', async () => {
  const gate = deferred(), h = harness({ native: true, nativeGate: gate }); await h.window.startScrollCapture();
  h.sample(20, 100); const worker = h.getMatcher(); h.events.abort(h.config.token); gate.resolve(); await tick();
  assert.equal(worker.stopped, true); assert.equal(worker.frames, 0); assert.equal(h.results.length, 0);
});
test('原生无新帧不冒充新图片，启动尺寸异常不回退到含指针流', async () => {
  const quiet = harness({ native: true, nativeQuiet: true }); await quiet.window.startScrollCapture();
  quiet.sample(20, 100); await tick(); assert.equal(quiet.getMatcher().frames, 0); quiet.events.abort(quiet.config.token);
  const bad = harness({ native: true, nativeBadSize: true }); await assert.rejects(bad.window.startScrollCapture(), /尺寸/);
  assert.equal(bad.calls.includes('media'), false); assert.equal(bad.getMatcher(), undefined);
});
test('完成时在途原生帧失败，保留已接正文并明确标注末帧缺失', async () => {
  const gate = deferred(), h = harness({ native: true, nativeGate: gate, nativeGateAt: 3 }); await h.window.startScrollCapture();
  h.sample(20, 100); await tick(); h.sample(40, 200); h.events.stop(h.config.token); h.failSample('fixture-capture-failed'); gate.resolve(); await tick(); await tick();
  assert.equal(h.results.length, 1); assert.deepEqual(h.getOutput().data, h.expected(140)); assert.match(h.results[0].warning, /fixture-capture-failed/);
});
test('启动底图与实时流不同：以遮罩隐藏后的实时首帧起步，不永久锁死在旧底图', async () => {
  const h = harness({ staleSeed: true, diagnostic: true }); await h.window.startScrollCapture();
  h.sample(0, 100); h.sample(20, 200); h.sample(40, 300);
  h.events.stop(h.config.token); await tick();
  assert.equal(h.results.length, 1);
  assert.equal(h.getOutput().height, 160);
  assert.deepEqual(h.getOutput().data, h.expected(160));
});

test('实时首帧等待新视频时间，静止流超时安全退出', async () => {
  const live = harness({ freshVideo: true }); await live.window.startScrollCapture();
  assert.ok(live.video.currentTime > 0); assert.equal(live.captureReads(), 1);
  live.events.abort(live.config.token);
  const frozen = harness({ frozenVideo: true });
  await assert.rejects(frozen.window.startScrollCapture(), /没有收到更新的屏幕帧/);
  assert.equal(frozen.track.stopped, true); assert.equal(frozen.captureReads(), 0);
  assert.equal(frozen.getMatcher(), undefined); assert.equal(frozen.results.length, 0);
});
for (const action of ['cancel', 'ended', 'stop']) test(`等实时首帧时${action}，不再创建匹配任务或输出`, async () => {
  const h = harness({ freshVideo: true, startupAction: ({ events, trackEvents, config }) => {
    if (action === 'cancel') events.abort(config.token);
    else if (action === 'stop') events.stop(config.token);
    else trackEvents.ended();
  } });
  await assert.rejects(h.window.startScrollCapture(), /取消|中断/);
  assert.equal(h.track.stopped, true); assert.equal(h.captureReads(), 0);
  assert.equal(h.getMatcher(), undefined); assert.equal(h.results.length, 0);
  assert.equal(h.errors.length, action === 'cancel' ? 0 : 1);
  if (action !== 'cancel') assert.equal(h.errors[0].reason, action === 'ended' ? 'media-ended' : 'no-growth');
});

test('匹配暂停时继续采集，单个在途任务与有界队列，不跨缺口猜接', async () => {
  const h = harness({ matcherPaused: true, diagnostic: true }); await h.window.startScrollCapture();
  for (let i = 1; i <= 30; i++) h.sample(i, i * 40);
  assert.equal(h.captureReads(), 31); assert.equal(h.getMatcher().frames, 1); assert.equal(h.getMatcher().processed, 0);
  assert.equal(h.results.length, 0); h.getMatcher().release();
  const samples = h.traces.filter(row => row.event === 'sample');
  assert.ok(samples.some(row => row.fields.queueDropped > 0));
  assert.ok(samples.every(row => row.fields.queueFrames <= 24 && row.fields.queueBytes <= 16 * 1024 * 1024));
  h.events.stop(h.config.token); await tick();
  assert.equal(h.getOutput().height, 150); assert.deepEqual(h.getOutput().data, h.expected(150));
});
test('完成时先排完已采队列，取消则立即清空，晚到回包不能输出', async () => {
  const h = harness({ matcherPaused: true }); await h.window.startScrollCapture();
  h.sample(20, 100); h.sample(40, 200); h.sample(60, 300); h.events.stop(h.config.token);
  assert.equal(h.results.length, 0); assert.equal(h.track.stopped, true);
  h.sample(60, 9000); // 已停止取图；收尾排队不能因计算等待而继续过期。
  h.getMatcher().release(); await tick();
  assert.equal(h.results.length, 1); assert.deepEqual(h.getOutput().data, h.expected(180));
  const canceled = harness({ matcherPaused: true }); await canceled.window.startScrollCapture();
  canceled.sample(20, 100); canceled.sample(40, 200); const worker = canceled.getMatcher(), late = worker.onmessage;
  canceled.events.abort(canceled.config.token); assert.equal(worker.stopped, true); assert.equal(worker.held.length, 0);
  late({ data: { type: 'sample', id: 1 } }); await tick(); assert.equal(canceled.results.length, 0);
});
test('失配保留最后可信参照，图片只走浮条状态，不进入诊断', async () => {
  const h = harness({ diagnostic: true }); await h.window.startScrollCapture(); await tick();
  assert.ok(h.progress.at(-1).reference); h.sample(20, 100); await tick();
  const reference = h.progress.at(-1).reference; h.sample(120, 200); await tick();
  assert.deepEqual(h.progress.at(-1).reference, reference); assert.match(h.progress.at(-1).message, /未接上/);
  for (const row of h.traces) assert.equal('reference' in row.fields, false);
  h.events.abort(h.config.token);
});
for (const mode of ['legacy', 'auto']) test(`从中间上下接长并折返，缩略图和位置只走本轮浮条（${mode}）`, async () => {
  const autoMode = mode === 'auto';
  const h = harness({ native: true, diagnostic: true, seedOffset: 80, autoMode });
  await h.window.startScrollCapture(); await tick();
  for (const [index, offset] of [60, 40, 20, 0, 20, 40, 60, 80, 100, 120, 140, 100, 60, 40, 20, 0].entries()) {
    h.sample(offset, (index + 1) * 300); await tick();
  }
  const state = h.progress.at(-1);
  assert.equal(state.height, 260, '已覆盖0..260，折返不应重复接入');
  assert.ok(state.preview?.dataUrl.startsWith('data:image/png;base64,'));
  assert.equal(state.preview.sourceHeight, state.height);
  assert.ok(state.preview.width <= 240 && state.preview.height <= 480);
  assert.equal(state.viewport.matched, true);
  // 自动模式的位置框标记正文，不含自动识别出的首栏；legacy标记整帧。
  const bodyTop = autoMode ? h.traces.filter(row => row.event === 'sample').at(-1).fields.contentTop : 0;
  assert.equal(state.viewport.top, bodyTop);
  assert.ok(state.viewport.top + state.viewport.height <= state.height);
  for (const row of h.traces) {
    assert.equal('preview' in row.fields, false); assert.equal('viewport' in row.fields, false);
    assert.ok(!JSON.stringify(row.fields).includes('data:image'));
  }
  h.events.stop(h.config.token); await tick();
  assert.equal(h.results.length, 1); assert.equal(h.getOutput().height, 260);
  let expected = h.expectedRange(0, 260);
  assert.deepEqual(h.getOutput().data, expected);
});

test('计算任务超时安全收回，不假装已经匹配或保存', async () => {
  const h = harness({ matcherPaused: true }); await h.window.startScrollCapture();
  h.sample(20, 100); h.alarms.at(-1)(); await tick();
  assert.equal(h.track.stopped, true); assert.equal(h.getMatcher().stopped, true); assert.equal(h.results.length, 0);
  assert.equal(h.errors.at(-1).reason, 'sample-error');
});

test('失配恢复反馈基线：未接上立即显示，持续失配保持指引，恢复后明确反馈', async () => {
  const h = harness({ diagnostic: true }); await h.window.startScrollCapture();
  h.sample(20, 300); h.sample(120, 600);
  assert.match(h.progress.at(-1).message, /未接上|暂未接上/);
  assert.match(h.progress.at(-1).message, /回滚|往回/);
  h.sample(130, 1000); assert.match(h.progress.at(-1).message, /未接上/);
  h.sample(40, 1300); assert.match(h.progress.at(-1).message, /已恢复/);
  assert.equal(h.progress.at(-1).height, 160);
  h.events.stop(h.config.token); await tick();
  assert.equal(h.results[0].warning, ''); assert.deepEqual(h.getOutput().data, h.expected(160));
});
test('回滚恢复基线：失配后回到前沿之前，再向下接长也显示恢复', async () => {
  const h = harness(); await h.window.startScrollCapture();
  h.sample(40, 300); h.sample(130, 600); h.sample(20, 900);
  assert.match(h.progress.at(-1).message, /回看|回滚/);
  h.sample(60, 1200); assert.match(h.progress.at(-1).message, /已恢复/);
  h.events.stop(h.config.token); await tick(); assert.equal(h.results[0].warning, '');
  assert.deepEqual(h.getOutput().data, h.expected(180));
});
test('审查基线：失配后回滚或回到前沿就完成，未重新接长仍保留提醒', async () => {
  for (const offset of [10, 20]) {
    const h = harness(); await h.window.startScrollCapture();
    h.sample(20, 300); h.sample(120, 600); h.sample(offset, 900);
    h.events.stop(h.config.token); await tick();
    assert.match(h.results[0].warning, /尚未重新接长/);
    assert.match(h.results[0].warning, /已确认连续/);
    assert.deepEqual(h.getOutput().data, h.expected(140));
  }
});
test('审查基线：失配与安全停止警告合并，最后没有新帧也记录重复计数', async () => {
  const h = harness({ diagnostic: true }); await h.window.startScrollCapture();
  h.video.currentTime = 1; h.sample(20, 300);
  h.video.currentTime = 2; h.sample(120, 600); h.sample(120, 900);
  h.trackEvents.ended(); await tick();
  assert.match(h.results[0].warning, /屏幕流已中断/);
  assert.match(h.results[0].warning, /末段未接上/);
  assert.equal(h.traces.find(row => row.event === 'worker-finishing').fields.duplicateFrames, 1);
  assert.deepEqual(h.getOutput().data, h.expected(140));
});
test('长异常原因不挤掉连续性提醒，两类信息均在240字预览范围内', async () => {
  const h = harness(); await h.window.startScrollCapture();
  h.sample(20, 300); h.sample(120, 600);
  h.failSample('超长采样错误'.repeat(100)); h.sample(40, 900); await tick();
  assert.match(h.results[0].warning, /^末段未接上/);
  assert.match(h.results[0].warning, /采样中断/);
  assert.ok(h.results[0].warning.length <= 240);
  assert.deepEqual(h.getOutput().data, h.expected(140));
});
test('末段失配基线：手动完成明确仅保留可信部分，不跨缺口', async () => {
  const h = harness(); await h.window.startScrollCapture();
  h.sample(20, 300); h.sample(120, 600); h.events.stop(h.config.token); await tick();
  assert.match(h.results[0].warning, /末段未接上/);
  assert.match(h.results[0].warning, /已确认连续/);
  assert.deepEqual(h.getOutput().data, h.expected(140));
});
test('采样基线：相同视频时间不反复计算和累计失败，新帧仍能恢复', async () => {
  const h = harness({ diagnostic: true }); await h.window.startScrollCapture();
  h.video.currentTime = 1; h.sample(20, 300);
  h.sample(120, 600); h.sample(120, 900);
  assert.equal(h.traces.filter(row => row.event === 'sample').length, 1);
  h.video.currentTime = 2; h.sample(120, 1200);
  h.video.currentTime = 3; h.sample(40, 1500);
  assert.match(h.progress.at(-1).message, /已恢复/);
  assert.equal(h.traces.filter(row => row.event === 'sample').at(-1).fields.duplicateFrames, 2);
  h.events.stop(h.config.token); await tick();
  assert.deepEqual(h.getOutput().data, h.expected(160));
});

test('固定壁纸工作页：同帧不重复增长，回滚恢复后首屏和正文保留原RGBA', async () => {
  const h = harness({ chat: {}, diagnostic: true }); await h.window.startScrollCapture();
  h.sample(42, 100); h.sample(42, 31000); await tick();
  assert.equal(h.results.length, 0);
  assert.equal(h.traces.filter(row => row.event === 'sample').at(-1).fields.kind, 'still');
  const parts = [chatFrame(0).data, chatFrame(42).data.slice((539 - 42) * 343 * 4)]; let accepted = 42, clock = 32000;
  for (const offset of [98, 100, 167, 199, 286, 300, 332, 390, 400, 402, 451, 500, 521, 597, 602, 683, 650, 683, 710]) {
    h.sample(offset, clock += 300);
    const sample = h.traces.filter(row => row.event === 'sample').at(-1).fields;
    if (sample.kind === 'forward') {
      const added = Math.max(0, offset - accepted);
      assert.equal(sample.added, added, '已覆盖区间回看不应重复接入');
      if (added) parts.push(chatFrame(offset).data.slice((539 - added) * 343 * 4));
      accepted = Math.max(accepted, offset);
    }
    assert.equal(h.results.length, 0);
  }
  assert.equal(accepted, 710);
  h.sample(710, 90000); assert.equal(h.results.length, 0);
  h.events.stop(h.config.token); await tick();
  assert.equal(h.results.length, 1); assert.equal(h.results[0].warning, ''); assert.equal(h.track.stopped, true);
  assert.equal(h.getOutput().height, 539 + 710);
  const expected = new Uint8ClampedArray((539 + 710) * 343 * 4); let cursor = 0;
  for (const part of parts) { expected.set(part, cursor); cursor += part.length; }
  assertChatContent(h.getOutput(), expected);
  assert.equal(h.traces.find(row => row.event === 'worker-finishing').fields.backgroundActive, true, '必须经过背景重铺而非空过正文检查');
  for (const row of h.traces) for (const value of Object.values(row.fields)) assert.ok(value == null || ['number', 'boolean', 'string'].includes(typeof value));
});
test('背景是否启用只看 pixels：空对象与零像素旧输出不算，正像素才算', async () => {
  for (const [background, expected] of [[null, false], [{}, false], [{ rows: 0, pixels: 0 }, false], [{ rows: 12, pixels: 900 }, true]]) {
    const h = harness({ diagnostic: true, finishBackground: background }); await h.window.startScrollCapture();
    h.sample(20, 100); h.sample(60, 400); h.events.stop(h.config.token); await tick();
    assert.equal(h.results.length, 1, JSON.stringify(background));
    const fields = h.traces.find(row => row.event === 'worker-finishing').fields;
    assert.equal(fields.backgroundActive, expected, JSON.stringify(background));
    assert.equal(fields.backgroundPixels, background?.pixels ?? 0);
    for (const value of Object.values(fields)) assert.ok(value == null || ['number', 'boolean', 'string'].includes(typeof value), '只摊平标量');
    assert.equal(typeof fields.backgroundProcessed, 'boolean');
    for (const key of ['backgroundChunks', 'backgroundInvalidChunks', 'backgroundMovingPixels', 'backgroundMaskPixels',
      'backgroundTargetInvalidPixels', 'backgroundSourceInvalidPixels', 'backgroundColorMismatchPixels']) assert.equal(typeof fields[key], 'number', key);
  }
});
test('线条壁纸与内缩半透明纸面工作页：接过2040像素、回滚再恢复，纸面原RGBA完整输出', async () => {
  const options = { inset: .18, outlinedWallpaper: true, alpha: .85 };
  const h = harness({ chat: options, diagnostic: true }); await h.window.startScrollCapture();
  const parts = [chatFrame(0, options).data]; let accepted = 0, clock = 0;
  for (const offset of [17, 34, 51, 128, 200, 258, 300, 332, 390, 451, 500, 597, 683, 750, 817, 910,
    1020, 1207, 1400, 1600, 1840, 2040, 1960, 2040, 2100]) {
    h.sample(offset, clock += 300);
    const sample = h.traces.filter(row => row.event === 'sample').at(-1).fields;
    if (sample.kind === 'forward') {
      const added = Math.max(0, offset - accepted);
      assert.equal(sample.added, added, '运动位移与新增行数分开核对');
      if (added) parts.push(chatFrame(offset, options).data.slice((539 - added) * 343 * 4));
      accepted = Math.max(accepted, offset);
    }
    assert.equal(h.results.length, 0);
  }
  assert.equal(accepted, 2100); h.events.stop(h.config.token); await tick();
  assert.equal(h.results.length, 1); assert.equal(h.results[0].warning, ''); assert.equal(h.errors.length, 0);
  assert.equal(h.getOutput().height, 539 + 2100); assert.equal(h.track.stopped, true);
  const expected = new Uint8ClampedArray((539 + 2100) * 343 * 4); let cursor = 0;
  for (const part of parts) { expected.set(part, cursor); cursor += part.length; }
  assertChatContent(h.getOutput(), expected, options);
  for (const row of h.traces) for (const value of Object.values(row.fields)) assert.ok(value == null || ['number', 'boolean', 'string'].includes(typeof value));
});
test('密集插画真实worker：纸面变化不增高，连续接长、回滚与恢复保留正文原RGBA', async () => {
  const options = { width: 363, height: 559, inset: .18, illustratedWallpaper: true, alpha: .85 };
  const h = harness({ chat: options, diagnostic: true }); await h.window.startScrollCapture();
  const seedPixels = chatFrame(0, options).data, captured = new Map(); let accepted = 0, clock = 0, reverseSeen = false, replaySeen = false;
  for (const alpha of [.2, 1, .35, .85]) {
    options.alpha = alpha; h.sample(0, clock += 300);
    const sample = h.traces.filter(row => row.event === 'sample').at(-1).fields;
    assert.ok(!['forward', 'reverse'].includes(sample.kind), JSON.stringify(sample));
  }
  for (const offset of [...Array.from({ length: 120 }, (_, i) => 17 * (i + 1)), 1960, 2023, 2040,
    ...Array.from({ length: 12 }, (_, i) => 2040 + 17 * (i + 1))]) {
    captured.set(offset, chatFrame(offset, options).data); h.sample(offset, clock += 300);
    const sample = h.traces.filter(row => row.event === 'sample').at(-1).fields;
    assert.equal(sample.height, options.height + accepted, '本次记录从真实可信前沿开始');
    const nextAccepted = accepted + sample.added;
    if (sample.replayedFrames > 0) replaySeen = true;
    // -80在该合成背景下覆盖率仅.761，保留安全拒绝，不为回滚控制降低门槛；另以-17核真实方向。
    if (offset === 1960) { assert.equal(sample.kind, 'unmatched'); assert.equal(sample.height, options.height + 2040); }
    if (offset < nextAccepted && sample.kind === 'reverse') { assert.equal(sample.shift, offset - nextAccepted); reverseSeen = true; }
    else assert.notEqual(sample.kind, 'reverse', `offset=${offset}`);
    if (sample.kind === 'forward') {
      assert.equal(nextAccepted, Math.max(accepted, offset), `offset=${offset}`);
      assert.ok(sample.shift > 0, '已覆盖区间向下回看也会报告正位移，不能当成新增高度');
    }
    accepted = nextAccepted;
    assert.equal(h.results.length, 0);
  }
  assert.equal(accepted, 2244); assert.ok(reverseSeen, '必须实际识别真实回滚'); assert.ok(replaySeen, '必须实际触发缓存回放');
  h.sample(accepted, clock += 300); h.events.stop(h.config.token); await tick();
  assert.equal(h.results.length, 1); assert.equal(h.results[0].warning, ''); assert.equal(h.errors.length, 0);
  assert.equal(h.getOutput().height, options.height + accepted); assert.equal(h.track.stopped, true);
  const output = h.getOutput().data, rowBytes = options.width * 4;
  assert.deepEqual(output.subarray(0, seedPixels.length), seedPixels);
  // 回放可能追加旧源帧，不能再把最新帧假定为唯一来源。
  // 每个新增行的正文/纸面须同属某张已采原图的正确文档行；背景可重铺，alpha仍核对。
  for (let y = options.height; y < options.height + accepted; y++) {
    const row = output.subarray(y * rowBytes, (y + 1) * rowBytes);
    assert.ok([...captured].some(([offset, pixels]) => offset <= y && y < offset + options.height &&
      row.every((value, byte) => (byte % 4 !== 3 && !protectedChatPixel(y, Math.floor(byte / 4), options.width, options.height, options)) ||
        value === pixels[(y - offset) * rowBytes + byte])), `输出第${y}行正文必须来自正确文档位置的同一原始行`);
  }
});
test('密集插画周期工作页：正滚回滚的周期别名都不能污染运动历史', async () => {
  const h = harness({ chat: { width: 363, height: 559, inset: .18, alpha: .85, illustratedWallpaper: true, repeat: true }, diagnostic: true });
  await h.window.startScrollCapture();
  for (const [index, offset] of [17, 34, 177, 194, 160, 0, 17, 320].entries()) {
    h.sample(offset, (index + 1) * 300);
    const sample = h.traces.filter(row => row.event === 'sample').at(-1).fields;
    assert.ok(!['forward', 'reverse'].includes(sample.kind), `offset=${offset}: ${JSON.stringify(sample)}`);
    assert.equal(sample.height, 559);
  }
  assert.ok(h.traces.some(row => row.event === 'sample' && row.fields.foreground), '必须经过前景候选判定，不靠原灰度路径空过');
  h.events.stop(h.config.token); await tick();
  assert.equal(h.results.length, 0); assert.equal(h.errors.at(-1).reason, 'no-growth');
});
test('密集插画工作页伴真实软底栏不输出伪长图', async () => {
  const h = harness({ chat: { width: 363, height: 559, inset: .18, alpha: .85, illustratedWallpaper: true,
    footer: 120, gradientFooter: true, softFooter: true, gradientRange: 16 }, diagnostic: true });
  await h.window.startScrollCapture();
  for (const [index, offset] of [17, 34, 51, 85, 121, 200].entries()) h.sample(offset, (index + 1) * 300);
  const samples = h.traces.filter(row => row.event === 'sample').map(row => row.fields);
  assert.ok(samples.every(row => row.kind !== 'forward')); assert.ok(samples.some(row => row.kind === 'fixed' && row.edge === 'bottom'));
  h.events.stop(h.config.token); await tick();
  assert.equal(h.results.length, 0); assert.equal(h.getOutput(), undefined); assert.equal(h.errors.at(-1).reason, 'no-growth');
});
test('线条壁纸伴低对比度软底栏：工作页不追加，手动完成不导出伪长图', async () => {
  const h = harness({ chat: { inset: .18, outlinedWallpaper: true, footer: 200, gradientFooter: true,
    softFooter: true, gradientRange: 16 }, diagnostic: true }); await h.window.startScrollCapture();
  for (const [index, offset] of [17, 34, 51, 128, 200, 258].entries()) h.sample(offset, (index + 1) * 300);
  for (const row of h.traces.filter(row => row.event === 'sample')) assert.notEqual(row.fields.kind, 'forward');
  h.events.stop(h.config.token); await tick();
  assert.equal(h.results.length, 0); assert.equal(h.errors.at(-1).reason, 'no-growth'); assert.equal(h.track.stopped, true);
});
test('固定壁纸工作页：偶然同屏行先核对，同帧重复不确认，新运动解除后才追加', async () => {
  const h = harness({ chat: {}, diagnostic: true }); await h.window.startScrollCapture();
  h.sample(42, 100, undefined, 'coincidence'); h.sample(42, 31000, undefined, 'coincidence');
  assert.equal(h.traces.filter(row => row.event === 'sample').at(-1).fields.pending, true);
  assert.equal(h.results.length, 0);
  h.sample(98, 32000); h.events.stop(h.config.token); await tick();
  assert.equal(h.results.length, 1); assert.equal(h.getOutput().height, 539 + 98);
  assert.equal(h.track.stopped, true);
});
test('固定壁纸加一行真底栏：多次不同位置也不追加，手动完成不输出伪长图', async () => {
  const h = harness({ chat: { footer: 1 }, diagnostic: true }); await h.window.startScrollCapture();
  for (const offset of [42, 98, 100, 167, 199, 286, 300]) h.sample(offset, offset * 10);
  h.events.stop(h.config.token); await tick();
  assert.equal(h.results.length, 0); assert.equal(h.getOutput(), undefined);
  assert.equal(h.errors[0].reason, 'no-growth'); assert.equal(h.track.stopped, true);
  assert.ok(h.traces.some(row => row.event === 'sample' && row.fields.foreground && row.fields.pending === false));
});

test('残留基线：配置尚未返回就取消，立即结束启动，迟到媒体流必须停止', async () => {
  const media = deferred(), configGate = deferred(), h = harness({ media, configGate });
  let status = 'pending';
  const pending = h.window.startScrollCapture().then(() => { status = 'ready'; }, () => { status = 'cancelled'; });
  h.events.abort(h.config.token); configGate.resolve(); await tick();
  assert.equal(status, 'cancelled');
  media.resolve(h.stream); await pending; await tick();
  assert.equal(h.track.stopped, true); assert.equal(h.calls.includes('ready'), false);
  assert.equal(h.results.length, 0);
});

test('配置未回时旧token的取消不影响新启动，本轮token仍可取消', async () => {
  const gate = deferred(), h = harness({ configGate: gate });
  const pending = h.window.startScrollCapture();
  h.events.abort('old-session-token'); gate.resolve(); await pending;
  assert.ok(h.getMatcher()); assert.equal(h.getMatcher().stopped, undefined);
  h.events.abort('old-session-token'); assert.equal(h.getMatcher().stopped, undefined);
  h.events.abort(h.config.token); assert.equal(h.getMatcher().stopped, true);
  assert.equal(h.results.length, 0);
});

test('范围提示被主进程拒绝显示时停止轨道，不采样、不提交图片', async () => {
  const h = harness({ readyAccepted: false });
  await assert.rejects(h.window.startScrollCapture(), /范围提示未显示/);
  h.sample(20, 100); await tick();
  assert.equal(h.track.stopped, true); assert.equal(h.results.length, 0);
  assert.equal(h.getOutput(), undefined);
});

test('修复基线：固定顶部只保留一次，首次滚动不收工，继续接长像素连续', async () => {
  const h = harness({ diagnostic: true }); await h.window.startScrollCapture();
  h.sample(20, 100, 'fixed'); await tick(); assert.equal(h.results.length, 0);
  h.sample(40, 200, 'fixed'); h.events.stop(h.config.token); await tick();
  assert.equal(h.getOutput().height, 160); assert.deepEqual(h.getOutput().data, h.expected(160));
});
test('修复基线：固定底部暂停不硬拼、不自动收工，零增长手动完成不输出伪长图', async () => {
  const h = harness({ fixedFooter: true }); await h.window.startScrollCapture();
  h.sample(20, 100, 'fixed'); h.sample(40, 200, 'fixed'); await tick();
  assert.equal(h.results.length, 0); h.events.stop(h.config.token); await tick();
  assert.equal(h.getOutput(), undefined); assert.equal(h.results.length, 0);
  assert.equal(h.errors[0].reason, 'no-growth'); assert.match(h.errors[0].message, /底部|固定/);
});
test('修复基线：长停顿及未增长不自动结束，手动完成才输出', async () => {
  const h = harness(); await h.window.startScrollCapture();
  h.sample(0, 31000); await tick(); assert.equal(h.results.length, 0);
  h.sample(20, 32000); h.sample(20, 45000); await tick(); assert.equal(h.results.length, 0);
  h.events.stop(h.config.token); await tick(); assert.equal(h.getOutput().height, 140);
});

test('对齐失败不收工，回滚到可信重叠区后恢复且没有缺行', async () => {
  const h = harness(); await h.window.startScrollCapture();
  h.sample(100, 100); h.sample(120, 200); h.sample(120, 300); await tick();
  assert.equal(h.results.length, 0); assert.equal(h.errors.length, 0);
  h.sample(20, 500); h.sample(40, 600); h.events.stop(h.config.token); await tick();
  assert.equal(h.results.length, 1); assert.equal(h.results[0].warning, '');
  assert.deepEqual(h.getOutput().data, h.expected(160));
});

for (const reason of ['media-ended', 'resolution-changed', 'sample-error']) test(`零增长安全停止保留${reason}原因，不出伪长图`, async () => {
  const h = harness(); await h.window.startScrollCapture();
  if (reason === 'media-ended') h.trackEvents.ended();
  else if (reason === 'resolution-changed') { h.config.frame.width++; h.sample(0, 100); }
  else h.sample(700, 100);
  await tick();
  assert.equal(h.errors[0].reason, reason); assert.equal(h.results.length, 0);
  assert.equal(h.getOutput(), undefined); assert.equal(h.track.stopped, true);
});

test('诊断覆盖媒体到编码的阶段，只发送标量摘要，不发送图片或指纹', async () => {
  const h = harness({ diagnostic: true }); await h.window.startScrollCapture();
  h.sample(20, 100); h.events.stop(h.config.token); await tick();
  const events = h.traces.map(row => row.event);
  for (const event of ['worker-start', 'media-request', 'media-ready', 'seed-ready', 'video-ready', 'sampling-start', 'sample', 'worker-finishing', 'png-ready']) assert.ok(events.includes(event), event);
  for (const row of h.traces) for (const value of Object.values(row.fields)) assert.ok(value == null || ['number', 'boolean', 'string'].includes(typeof value));
  assert.equal(h.traces.find(row => row.event === 'sample').fields.kind, 'forward');
  assert.equal(h.traces.find(row => row.event === 'worker-finishing').fields.reason, 'manual-stop');
  assert.equal(h.results.length, 1); assert.deepEqual(h.getOutput().data, h.expected(140));
});
for (const diagnostic of ['throw', 'reject']) test(`诊断 ${diagnostic} 失败不打断媒体手势或长图结果`, async () => {
  const h = harness({ diagnostic }); const start = h.window.startScrollCapture();
  assert.deepEqual(h.calls.slice(0, 2), ['media', 'config']); await start;
  h.sample(20, 100); h.events.stop(h.config.token); await tick();
  assert.equal(h.results.length, 1); assert.deepEqual(h.getOutput().data, h.expected(140));
});

test('媒体请求在配置等待之前同步发起，保留瞬时手势', async () => {
  const h = harness();
  const start = h.window.startScrollCapture();
  assert.deepEqual(h.calls.slice(0, 2), ['media', 'config']);
  await start;
  h.events.abort(h.config.token);
  assert.equal(h.track.stopped, true);
});
test('启动中取消，迟到的屏幕流同样被释放', async () => {
  const media = deferred(), h = harness({ media });
  const start = h.window.startScrollCapture();
  await tick();
  h.events.abort(h.config.token);
  media.resolve(h.stream);
  await assert.rejects(start, /取消/);
  assert.equal(h.track.stopped, true);
  assert.equal(h.results.length, 0);
});
test('配置失败时，之后才返回的媒体流也不能泄漏', async () => {
  const media = deferred(), h = harness({ media, configError: true });
  await assert.rejects(h.window.startScrollCapture(), /配置已失效/);
  media.resolve(h.stream); await tick();
  assert.equal(h.track.stopped, true);
});
test('正滚、回滚、继续正滚后只合成一次且像素连续', async () => {
  const h = harness();
  await h.window.startScrollCapture();
  h.sample(20, 100); h.sample(40, 200); h.sample(25, 300); h.sample(55, 400);
  h.events.stop(h.config.token); h.events.stop(h.config.token);
  await tick();
  assert.equal(h.calls.filter(call => call === 'finishing').length, 1);
  assert.equal(h.results.length, 1);
  assert.equal(h.getOutput().height, 175);
  assert.deepEqual(h.getOutput().data, h.expected(175));
  assert.equal(h.track.stopped, true);
});
test('回滚或停住都保持采集，手动完成不重复内容', async () => {
  const h = harness(); await h.window.startScrollCapture();
  h.sample(40, 100); h.sample(20, 1100); h.sample(20, 2000);
  await tick(); assert.equal(h.results.length, 0);
  h.sample(20, 2400); await tick(); assert.equal(h.results.length, 0);
  h.events.stop(h.config.token); await tick();
  assert.equal(h.results.length, 1); assert.equal(h.getOutput().height, 160);
  assert.deepEqual(h.getOutput().data, h.expected(160));
});
test('回滚后尚未追上前沿时，手动完成只输出原可靠前沿', async () => {
  const h = harness(); await h.window.startScrollCapture();
  h.sample(60, 100); h.sample(20, 1100, undefined, 245);
  h.sample(40, 2400, undefined, 245);
  await tick(); assert.equal(h.results.length, 0);
  h.sample(40, 3700, undefined, 245); await tick(); assert.equal(h.results.length, 0);
  h.events.stop(h.config.token); await tick();
  assert.equal(h.results.length, 1); assert.equal(h.getOutput().height, 180);
  assert.deepEqual(h.getOutput().data, h.expected(180));
});
test('正文停止或边缘动画不自动收工，手动完成保留可靠像素', async () => {
  const h = harness(); await h.window.startScrollCapture();
  h.sample(20, 100);
  h.sample(20, 1500, 255);
  await tick(); assert.equal(h.results.length, 0);
  h.events.stop(h.config.token); await tick();
  assert.equal(h.results.length, 1);
  assert.equal(h.getOutput().height, 140);
});
test('增长前后都不按静止计时收工，最后手动结束', async () => {
  const h = harness();
  await h.window.startScrollCapture();
  h.sample(0, 2000); assert.equal(h.results.length, 0);
  h.sample(20, 2100); h.sample(20, 3500);
  await tick(); assert.equal(h.results.length, 0);
  h.events.stop(h.config.token); await tick();
  assert.equal(h.results.length, 1);
  assert.equal(h.getOutput().height, 140);
});

test('自动模式：首屏范围未确认就完成，如实说明仅首屏未确认，不冒充没滚动或重复内容', async () => {
  const h = harness({ native: true, autoMode: true }); await h.window.startScrollCapture();
  h.sample(20, 100); await tick();
  assert.match(h.progress.at(-1).message, /再小幅滚动一下，确认后再完成/);
  h.events.stop(h.config.token); await tick();
  assert.equal(h.results.length, 0); assert.equal(h.getOutput(), undefined);
  assert.equal(h.errors.at(-1).reason, 'no-growth');
  assert.match(h.errors.at(-1).message, /本次仅保留首屏/);
  assert.match(h.errors.at(-1).message, /小幅滚动/);
  assert.doesNotMatch(h.errors.at(-1).message, /重复/);
});
test('自动证据阶段区分证据不足与失配：未建布局不说重复，已建布局pixel-proof不冒充重复内容', async () => {
  const body = { top: 0, bottom: 120 }, reply = (stage, layout) => ({ result: { kind: 'ambiguous', auto: true, ...(layout ? { content: body } : {}) },
    autoEvidence: { analysisStage: stage, motionCoverage: .1 }, height: 120, chunks: 1, capturedHeight: 120, capturedChunks: 1, added: 0, capturedAdded: 0 });
  const replies = [reply('collecting'), reply('pixel-proof'), reply('pixel-proof', true), reply('initial-proof', true)];
  let index = 0;
  const h = harness({ native: true, autoMode: true, sampleReplace: () => replies[Math.min(index++, replies.length - 1)] });
  await h.window.startScrollCapture();
  h.sample(20, 100); await tick(); assert.match(h.progress.at(-1).message, /再小幅滚动一下，确认后再完成/);
  h.sample(40, 200); await tick(); assert.match(h.progress.at(-1).message, /再小幅滚动一下，确认后再完成/);
  h.sample(60, 300); await tick(); assert.match(h.progress.at(-1).message, /运动或重排/);
  h.sample(80, 400); await tick(); assert.match(h.progress.at(-1).message, /对应/);
  for (const state of h.progress) assert.doesNotMatch(state.message, /重复/);
  h.events.abort(h.config.token);
});

test('自动暂停提示只说已确认部分，不承诺自动对齐任意跨度，也不要求手动重标', async () => {
  const h = harness({ native: true, autoMode: true, sampleReplace: () => ({ result: { kind: 'layout-changed', auto: true, message: '原始来源缓存不足，停止追加' },
    autoEvidence: { analysisStage: 'paused' }, height: 120, chunks: 1, capturedHeight: 120, capturedChunks: 1, added: 0, capturedAdded: 0 }) });
  await h.window.startScrollCapture();
  h.sample(20, 100); await tick();
  const message = h.progress.at(-1).message;
  assert.match(message, /已确认部分/);
  assert.match(message, /回到浮条所示内容附近，等布局稳定后继续/);
  assert.doesNotMatch(message, /无缺口|重新标记|自动对齐/);
  h.events.abort(h.config.token);
});

test('看门狗超时：用外置检查点恢复已确认内容并给出明确警告，不丢成 scrollError', async () => {
  const h = harness({ checkpoint: true, preview: false, autoMode: true, diagnostic: true }); await h.window.startScrollCapture();
  h.sample(20, 100); h.sample(40, 200); h.sample(60, 300); await tick();
  assert.equal(h.encoded.length, 0, '还没到收尾，不应该编码任何成图');
  const worker = h.getMatcher(), before = worker.processed;
  worker.holdNext = true; h.sample(80, 400);
  assert.equal(worker.processed, before, '这一帧必须真的卡在计算里');
  const held = worker.held.at(-1);
  h.alarms.at(-1)(); await tick();
  assert.equal(h.results.length, 1, '超时也必须交付上次已确认内容');
  assert.equal(h.results[0].recovered, true);
  assert.match(h.results[0].warning, /计算中断/);
  assert.match(h.results[0].warning, /保留上次结果/);
  assert.match(h.results[0].warning, /固定遮挡核对未完成/);
  assert.match(h.results[0].warning, /后续未拼入/);
  assert.equal(h.errors.length, 0, '恢复路径不能把已确认内容报成错误丢掉');
  assert.equal(h.track.stopped, true); assert.equal(worker.stopped, true);
  const recovering = h.traces.filter(row => row.event === 'worker-recovering');
  assert.equal(recovering.length, 1);
  assert.equal(recovering[0].fields.reason, 'match-timeout');
  assert.equal(recovering[0].fields.seeded, false);
  const failure = h.traces.filter(row => row.event === 'worker-error').at(-1).fields;
  assert.equal(failure.errorCode, 'match-timeout');
  assert.equal(failure.inflightId, 4);
  assert.equal(typeof failure.pendingMs, 'number');
  const image = h.encoded.at(-1);
  assert.equal(image.height, 180, '预览高度必须等于最后一次确认的检查点');
  assert.ok(sameBytes(image.data, h.expected(180)), '恢复预览必须是已确认的原像素');
  // 恢复后迟到的回包不得再产出第二张预览，也不得重启采样
  worker.onmessage({ data: { type: 'sample', id: held.id, added: 20, complete: true, height: 200, capturedHeight: 200, capturedChunks: 4, chunks: 4, result: { kind: 'forward' } } });
  await tick(); assert.equal(h.results.length, 1); assert.equal(h.encoded.length, 1);
});

test('取消优先：取消后不恢复出预览，晚到检查点回包也不复活', async () => {
  const h = harness({ checkpoint: true, preview: false, autoMode: true }); await h.window.startScrollCapture();
  h.sample(20, 100); h.sample(40, 200); h.sample(60, 300); await tick();
  const worker = h.getMatcher(); worker.holdNext = true; h.sample(80, 400);
  const held = worker.held.at(-1);
  assert.ok(held, '这一帧必须真的卡在计算里');
  h.events.abort(h.config.token);
  h.alarms.at(-1)(); await tick();
  assert.equal(h.results.length, 0); assert.equal(h.encoded.length, 0); assert.equal(h.errors.length, 0);
  worker.onmessage({ data: { type: 'sample', id: held.id, added: 20, complete: true, height: 200, capturedHeight: 200, capturedChunks: 4, chunks: 4, result: { kind: 'forward' } } });
  await tick(); assert.equal(h.results.length, 0); assert.equal(h.encoded.length, 0);
});

test('收尾超时：同样用检查点恢复，原因归为收尾超时', async () => {
  const h = harness({ checkpoint: true, preview: false, autoMode: true }); await h.window.startScrollCapture();
  h.sample(20, 100); h.sample(40, 200); h.sample(60, 300); await tick();
  const worker = h.getMatcher(); worker.holdFinish = true;
  h.events.stop(h.config.token); await tick();
  assert.equal(h.results.length, 0, '收尾没有回包前不能先交付');
  h.alarms.at(-1)(); await tick();
  assert.equal(h.results.length, 1); assert.equal(h.results[0].recovered, true);
  assert.match(h.results[0].warning, /计算中断/); assert.match(h.results[0].warning, /收尾超时/);
  assert.equal(h.errors.length, 0);
  assert.equal(h.encoded.at(-1).height, 180); assert.ok(sameBytes(h.encoded.at(-1).data, h.expected(180)));
});

test('计算异常（预算耗尽）：检查点恢复并保留固定诊断类别与阶段', async () => {
  const h = harness({ checkpoint: true, preview: false, autoMode: true, diagnostic: true }); await h.window.startScrollCapture();
  h.sample(20, 100); h.sample(40, 200); h.sample(60, 300); await tick();
  h.getMatcher().errorNext = { code: 'analysis-budget', stage: 'mark-repair', message: '遮挡分析超出预算', learnPasses: 7, learnDuration: 12.5, repairDuration: 3 };
  h.sample(80, 400); await tick();
  assert.equal(h.results.length, 1); assert.match(h.results[0].warning, /计算中断/); assert.match(h.results[0].warning, /分析超出预算/);
  assert.equal(h.errors.length, 0);
  const failure = h.traces.filter(row => row.event === 'worker-error').at(-1).fields;
  assert.equal(failure.errorCode, 'analysis-budget');
  assert.equal(failure.stage, 'mark-repair');
  assert.equal(failure.learnPasses, 7); assert.equal(failure.learnDuration, 12.5); assert.equal(failure.repairDuration, 3);
  assert.equal(failure.inflightId, 4);
  assert.equal(typeof failure.pendingMs, 'number');
});

test('学习期超时只能恢复首屏：明说滚动部分未确认，不伪称长图', async () => {
  const h = harness({ checkpoint: true, preview: false, autoMode: true }); await h.window.startScrollCapture();
  h.sample(20, 100); await tick();
  h.getMatcher().holdNext = true; h.sample(40, 200);
  h.alarms.at(-1)(); await tick();
  assert.equal(h.results.length, 1);
  assert.match(h.results[0].warning, /计算中断/); assert.match(h.results[0].warning, /仅保留首屏/);
  assert.match(h.results[0].warning, /滚动部分未确认/);
  assert.equal(h.results[0].recovered, true);
  assert.equal(h.encoded.at(-1).height, h.config.pixels.height);
  assert.ok(sameBytes(h.encoded.at(-1).data, h.expected(h.config.pixels.height)));
});

test('首个匹配回包前失败沿用安全停止，不拿首屏冒充接长', async () => {
  const h = harness({ checkpoint: true, preview: false, autoMode: true, matcherPaused: true }); await h.window.startScrollCapture();
  h.sample(20, 100); h.alarms.at(-1)(); await tick();
  assert.equal(h.results.length, 0); assert.equal(h.encoded.length, 0);
  assert.equal(h.errors.at(-1).reason, 'sample-error');
});

test('新遮挡证据作废旧检查点：只能用首屏恢复，重复/递减版本号不改变结论', async () => {
  const h = harness({ checkpoint: true, preview: false, autoMode: true, diagnostic: true }); await h.window.startScrollCapture();
  h.sample(20, 100); h.sample(40, 200); h.sample(60, 300); await tick();
  const worker = h.getMatcher(); worker.holdNext = true; h.sample(80, 400);
  // Worker 在 accept 内部产新遮拦证据就会先发这轻事件：旧长图快照作废，seed 保底与在途计时器都不动。
  worker.onmessage({ data: { type: 'evidence-invalidated', revision: 2 } });
  worker.onmessage({ data: { type: 'evidence-invalidated', revision: 2 } });
  worker.onmessage({ data: { type: 'evidence-invalidated', revision: 1 } });
  worker.onmessage({ data: { type: 'evidence-invalidated', revision: -1 } });
  // 计时器没被证据事件拆除：超时仍能进入恢复，但只剩首屏。
  h.alarms.at(-1)(); await tick();
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].recovered, true);
  assert.match(h.results[0].warning, /计算中断/);
  assert.match(h.results[0].warning, /仅保留首屏原图/);
  assert.match(h.results[0].warning, /滚动部分未确认/);
  assert.doesNotMatch(h.results[0].warning, /可信|已确认|完整/);
  assert.equal(h.encoded.at(-1).height, h.config.pixels.height);
  assert.ok(sameBytes(h.encoded.at(-1).data, h.expected(h.config.pixels.height)));
  assert.equal(h.errors.length, 0);
  const recovering = h.traces.filter(row => row.event === 'worker-recovering');
  assert.equal(recovering.at(-1).fields.seeded, true);
  assert.equal(recovering.at(-1).fields.evidenceRevision, 2);
});

test('同一证据版本的新完整回包可以重新持有检查点，超时恢复长图而非首屏', async () => {
  const width = 100, viewHeight = 120, tall = 160;
  const replace = packet => {
    const revision = packet.id >= 5 ? 4 : 3;
    const data = new Uint8ClampedArray(width * tall * 4);
    for (let i = 0; i < data.length; i += 4) { data[i] = revision * 10; data[i + 1] = 1; data[i + 2] = 2; data[i + 3] = 255; }
    return { autoEvidence: { analysisStage: 'ready', evidenceRevision: revision },
      checkpoint: { width, height: tall, data, evidenceRevision: revision },
      height: tall, capturedHeight: tall, capturedChunks: 2, chunks: 2, added: 20, capturedAdded: 20, complete: true,
      result: { kind: 'forward', auto: true, content: { top: 0, bottom: viewHeight } } };
  };
  const h = harness({ autoMode: true, preview: false, sampleReplace: replace }); await h.window.startScrollCapture();
  for (let i = 1; i <= 4; i++) { h.sample(0, i * 100); await tick(); }
  const worker = h.getMatcher();
  // 新证据（版本4）到达：版本3 的检查点立即失效。
  worker.onmessage({ data: { type: 'evidence-invalidated', revision: 4 } });
  // 同一版本 4 的完整回包带新检查点，可以重新持有。
  h.sample(0, 500); await tick();
  worker.holdNext = true; h.sample(0, 600);
  h.alarms.at(-1)(); await tick();
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].recovered, true);
  assert.match(h.results[0].warning, /保留上次结果/);
  assert.doesNotMatch(h.results[0].warning, /首屏/);
  assert.equal(h.encoded.at(-1).height, tall);
  assert.equal(h.encoded.at(-1).data[0], 40, '恢复图必须是版本4 重新持有的检查点，不是版本3 或首屏');
});

test('恢复编码中重复错误与迟到 done 不打断，也不发第二张图', async () => {
  const gate = deferred();
  const h = harness({ checkpoint: true, preview: false, autoMode: true, diagnostic: true, encodeGate: gate }); await h.window.startScrollCapture();
  h.sample(20, 100); h.sample(40, 200); h.sample(60, 300); await tick();
  const worker = h.getMatcher(); worker.holdNext = true; h.sample(80, 400);
  h.alarms.at(-1)();
  assert.equal(h.encoded.length, 1, '恢复图已经开始编码');
  // 恢复编码中：第二个错误若没被挡住会 abort 掉正在进行的 PNG；迟到的 done 不能覆盖恢复图。
  worker.onmessage({ data: { type: 'error', code: 'match-timeout', message: '图片匹配超时' } });
  worker.onmessage({ data: { type: 'done', output: { width: h.config.pixels.width, height: 300, data: new Uint8ClampedArray(h.config.pixels.width * 300 * 4), complete: true, missingRanges: [] } } });
  worker.onmessage({ data: { type: 'error', code: 'analysis-budget', message: '遮挡分析超出预算' } });
  gate.resolve(); await tick(); await tick();
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].recovered, true);
  assert.equal(h.encoded.length, 1);
  assert.equal(h.errors.length, 0);
});

test('PNG 编码途中取消：不交付恢复图，也不报错', async () => {
  const gate = deferred();
  const h = harness({ checkpoint: true, preview: false, autoMode: true, encodeGate: gate }); await h.window.startScrollCapture();
  h.sample(20, 100); h.sample(40, 200); h.sample(60, 300); await tick();
  const worker = h.getMatcher(); worker.holdNext = true; h.sample(80, 400);
  h.alarms.at(-1)();
  assert.equal(h.encoded.length, 1, '恢复图已经开始编码');
  h.events.abort(h.config.token);
  gate.resolve(); await tick(); await tick();
  assert.equal(h.results.length, 0); assert.equal(h.errors.length, 0);
});

test('正常收尾只编码一次：重复 done 不再回第二张图', async () => {
  const gate = deferred();
  const h = harness({ autoMode: true, preview: false, encodeGate: gate }); await h.window.startScrollCapture();
  h.sample(20, 100); h.sample(40, 200); await tick();
  h.events.stop(h.config.token); await tick();
  assert.equal(h.encoded.length, 1, '正常成图已经进入编码');
  h.getMatcher().onmessage({ data: { type: 'done', output: { width: h.config.pixels.width, height: 160, data: h.expected(160), complete: true, missingRanges: [] } } });
  // 已有有效成图正在编码时，迟到 error 不得改走恢复或中断这张图。
  h.getMatcher().onmessage({data:{type:'error',code:'analysis-budget',message:'遮挡分析超出预算'}});
  gate.resolve(); await tick(); await tick();
  assert.equal(h.results.length, 1); assert.equal(h.encoded.length, 1);
  assert.equal(h.results[0].recovered,undefined);assert.equal(h.errors.length,0);
  assert.deepEqual(h.getOutput().data, h.expected(160));
});

// ---- 快滚跟随：队列预算、进度节流、参照编码 ----
test('典型大帧按帧字节自适应预算缓冲：多于1帧且不超过cap，始终只1个在途任务', async () => {
  const width = 1200, height = 1100, frameBytes = width * height * 4;
  const cap = Math.min(64 * 1024 * 1024, Math.max(16 * 1024 * 1024, frameBytes * 4));
  assert.ok(cap > 16 * 1024 * 1024, '典型大帧的预算必须高于旧16MiB一刀切');
  const reply = () => ({ result: { kind: 'forward' }, height, chunks: 1, capturedHeight: height, capturedChunks: 1, added: 10, capturedAdded: 10, complete: true });
  const h = harness({ frameWidth: width, frameHeight: height, matcherPaused: true, sampleReplace: reply, diagnostic: true });
  await h.window.startScrollCapture();
  for (let i = 0; i < 6; i++) h.sample(0, 100 + i * 40);
  assert.equal(h.getMatcher().frames, 1, '暂停时也只允许一个在途帧');
  h.getMatcher().release(); await tick();
  const rows = h.traces.filter(row => row.event === 'sample').map(row => row.fields);
  assert.equal(rows.length, 5, '6帧里1帧被容量的丢旧策略挤出去');
  assert.ok(rows.some(row => row.queueDropped > 0), '丢旧策略仍然生效');
  assert.ok(rows.some(row => row.queueFrames > 1), '大帧必须能缓冲多于1帧');
  assert.ok(rows.some(row => row.queueBytes > 16 * 1024 * 1024), '缓冲字节应超过旧的16MiB上限');
  assert.ok(rows.every(row => row.queueFrames <= 24 && row.queueBytes <= cap), '帧数与自适应字节预算共同收敛');
  h.events.abort(h.config.token);
});
test('队列按年龄收敛：超过2500ms的旧帧被丢弃，完成仍需排完剩余队列', async () => {
  const h = harness({ matcherPaused: true, diagnostic: true }); await h.window.startScrollCapture();
  h.sample(20, 100); h.sample(40, 2700); h.sample(60, 5400);
  assert.equal(h.getMatcher().held.length, 1, '只有1个在途帧，其余进队列');
  h.events.stop(h.config.token); await tick();
  assert.equal(h.results.length, 0, '完成必须先排完队列');
  h.getMatcher().release(); await tick();
  const rows = h.traces.filter(row => row.event === 'sample').map(row => row.fields);
  assert.ok(rows.some(row => row.queueDropped > 0), '超过2500ms的旧帧必须被丢弃');
  assert.ok(rows.every(row => row.queueFrames <= 24));
  assert.equal(h.results.length, 1);
  assert.equal(h.getOutput().height, 180);
  assert.deepEqual(h.getOutput().data, h.expected(180));
});
test('高帧频同一提示：纯视口进度按60ms更新，不等250ms窗口，也不在60ms内重复发', async () => {
  const h = harness({ preview: false }); await h.window.startScrollCapture(); await tick();
  h.sample(20, 100); await tick();
  const count = h.progress.length;
  assert.equal(h.progress.at(-1).height, 140);
  h.sample(40, 200); await tick();
  assert.equal(h.progress.length, count + 1, '100ms后同一提示的视口必须发出');
  assert.equal(h.progress.at(-1).height, 160);
  assert.equal(typeof h.progress.at(-1).viewport?.matched, 'boolean');
  h.sample(60, 230); await tick();
  assert.equal(h.progress.length, count + 1, '60ms内不重复发');
  h.sample(80, 330); await tick();
  assert.equal(h.progress.length, count + 2);
  h.events.abort(h.config.token);
});
test('完整长图预览已有时不再每帧编码底部参照，预览本身仍持续更新', async () => {
  const width = 400, height = 300;
  const h = harness({ frameWidth: width, frameHeight: height }); await h.window.startScrollCapture(); await tick();
  assert.ok(h.progress.at(-1).preview, '初始化即有完整预览');
  h.sample(20, 100); await tick(); h.sample(40, 200); await tick(); h.sample(60, 300); await tick();
  const references = h.encoded.filter(image => image.width === width && image.height === height);
  assert.equal(references.length, 1, '参照图只在初始化编码一次');
  assert.ok(h.encoded.filter(image => image.width < width).length >= 3, '完整预览仍随每帧更新');
  const state = h.progress.at(-1);
  assert.ok(state.preview?.dataUrl.startsWith('data:image/png;base64,'));
  assert.equal(state.preview.sourceHeight, state.height);
  h.events.abort(h.config.token);
});
test('旧legacy路径没有完整预览时，底部参照仍随帧更新', async () => {
  const width = 400, height = 300;
  const h = harness({ frameWidth: width, frameHeight: height, referenceOnly: true }); await h.window.startScrollCapture(); await tick();
  assert.equal(h.progress.at(-1).preview, undefined);
  assert.ok(h.progress.at(-1).reference, 'legacy 仍下发底部参照');
  h.sample(20, 100); await tick(); h.sample(40, 200); await tick();
  assert.ok(h.encoded.filter(image => image.width === width && image.height === height).length >= 2, '没有完整预览时参照继续按帧编码');
  assert.ok(h.progress.at(-1).reference);
  assert.equal(h.progress.at(-1).preview, undefined);
  h.events.abort(h.config.token);
});
