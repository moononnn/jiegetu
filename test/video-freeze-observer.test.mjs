// DEV 观测（录制开始后首秒冻结定位）：全部用合成源（假屏幕流、假画布、假 rVFC 元素），
// 不碰真实桌面、不采集屏幕/音频，也不假装验过真实音视频。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runVideoRecording } from '../renderer/video-recorder.mjs';
import { createFreezeObserver, FREEZE_OBSERVE_KEYS } from '../renderer/video-freeze-observer.mjs';

function fakeTrack(kind = 'video') {
  const listeners = new Map();
  return {
    kind, stopped: false,
    getSettings: () => ({ width: 1920, height: 1080 }),
    stop() { this.stopped = true; },
    addEventListener(type, fn) { listeners.set(type, fn); },
    emit(type) { listeners.get(type)?.(); },
  };
}

function fakeStream(tracks) {
  return { getTracks: () => tracks, getVideoTracks: () => tracks.filter(t => t.kind === 'video'), getAudioTracks: () => tracks.filter(t => t.kind === 'audio') };
}

// 假的 rVFC 元素：只数回调，不搬像素。
function fakeFrameElement() {
  const pending = new Map();
  let seq = 0;
  const element = {
    muted: false, playsInline: false, srcObject: null, paused: true, cancelled: 0,
    play: async () => { element.paused = false; },
    pause: () => { element.paused = true; },
    requestVideoFrameCallback(fn) { const handle = ++seq; pending.set(handle, fn); return handle; },
    cancelVideoFrameCallback(handle) { element.cancelled++; pending.delete(handle); },
    // 浏览器在回调触发后就不再保留该回调。
    deliver(now) { for (const [handle, fn] of [...pending.entries()]) { pending.delete(handle); fn(now, { mediaTime: 0 }); } },
    get pendingCount() { return pending.size; },
  };
  return element;
}

// 假的 WebM 片段：EBML 头 + 一个簇，够过容器体检。
function webmBytes() {
  const bytes = new Uint8Array(4096);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  bytes.set([0x1f, 0x43, 0xb6, 0x75], 24);
  return bytes;
}

class FakeMediaRecorder {
  static supported = new Set(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']);
  static isTypeSupported(type) { return FakeMediaRecorder.supported.has(type); }
  constructor(stream, options) { this.stream = stream; this.options = options; this.state = 'inactive'; this.chunks = []; }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob([webmBytes()], { type: 'video/webm' }) }); this.onstop?.(); }
}

function harness({ observe = false, browserDefaultStream = false } = {}) {
  const calls = { observe: [], state: [], result: [], display: [] };
  const displayTrack = fakeTrack('video');
  const canvasTrack = fakeTrack('video');
  const elements = [];
  const mediaDevices = { async getDisplayMedia(options) { calls.display.push(options); return fakeStream([displayTrack]); } };
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }), captureStream: () => fakeStream([canvasTrack]) };
  const bridge = {
    config: async () => ({
      selection: { x: 100, y: 50, width: 400, height: 200 },
      displayPhysical: { x: 0, y: 0, width: 1920, height: 1080 },
      plan: { wantSystem: false, wantMicrophone: false, mix: false },
      limits: { maxDurationMs: 60000, maxBytes: 1024 * 1024 },
      ...(observe ? { observe: true } : {}),
    }),
    state: payload => calls.state.push(payload),
    result: async payload => { calls.result.push(payload); return { saved: true }; },
    observe: metrics => calls.observe.push(metrics),
    onStop: () => {},
  };
  const deps = {
    bridge, mediaDevices, MediaRecorder: FakeMediaRecorder,
    createCanvas: () => canvas, videoElement: { srcObject: null, muted: true, play: async () => {} },
    createVideoElement: () => { const element = fakeFrameElement(); elements.push(element); return element; },
  };
  // 浏览器默认：页面自己就有 MediaStream，代码不显式传。
  if (browserDefaultStream) {
    deps.MediaStream = undefined;
    globalThis.MediaStream = fakeStream;
  } else {
    deps.MediaStream = fakeStream;
  }
  return { deps, calls, elements, displayTrack, canvasTrack };
}

test('默认路径不变：没开观测就不建探针、不上报', async () => {
  const h = harness();
  const run = await runVideoRecording(h.deps);
  await run.finish();
  assert.equal(h.elements.length, 0, '默认路径不得创建任何观测探针');
  assert.equal(h.calls.observe.length, 0, '默认路径不得上报');
  assert.equal(h.calls.result.length, 1, '默认路径照常出产物');
});

test('浏览器默认（不显式传 MediaStream）：两处探针都要真的数到帧', async () => {
  const h = harness({ observe: true, browserDefaultStream: true });
  try {
    const run = await runVideoRecording(h.deps);
    assert.equal(h.elements.length, 2, '源轨与输出轨各一个探针');
    h.elements[0].deliver(100);
    h.elements[1].deliver(140);
    await run.finish();
    assert.equal(h.calls.observe.length, 1);
    const metrics = h.calls.observe[0];
    assert.equal(metrics.sourceSupported, 1, '源轨探针必须真的能用');
    assert.equal(metrics.outputSupported, 1, '输出轨探针必须真的能用');
    assert.equal(metrics.sourceFrames, 1);
    assert.equal(metrics.outputFrames, 1);
    assert.equal(metrics.sourceGapMs, 0);
  } finally { delete globalThis.MediaStream; }
});

test('开启观测：只在显式开始录制之后上报一次，指标全是固定整数', async () => {
  const h = harness({ observe: true });
  const run = await runVideoRecording(h.deps);
  assert.equal(h.elements.length, 2, '源轨与输出轨各一个探针');
  h.elements[0].deliver(100);
  h.elements[1].deliver(130);
  assert.equal(h.calls.observe.length, 0, '观测窗没到之前不上报');
  await new Promise(resolve => setTimeout(resolve, 90));
  await run.finish();
  assert.equal(h.calls.observe.length, 1, '整轮录制最多上报一次');
  const metrics = h.calls.observe[0];
  assert.deepEqual(Object.keys(metrics).sort(), [...FREEZE_OBSERVE_KEYS].sort(), '指标键必须固定');
  for (const value of Object.values(metrics)) assert.equal(Number.isInteger(value), true, `指标必须是整数：${JSON.stringify(metrics)}`);
  assert.equal(metrics.sourceFrames, 1, '源帧交付计数');
  assert.equal(metrics.outputFrames, 1, '输出轨道出帧计数');
  assert.equal(metrics.sourceSupported, 1);
  assert.equal(metrics.outputSupported, 1);
  assert.ok(metrics.paintCount >= 1, '裁切绘制要被计数');
  assert.ok(metrics.windowMs >= 4000, '观测窗长度固定');
});

test('结束必清理：探针回调被取消、轨道被放开', async () => {
  const h = harness({ observe: true });
  const run = await runVideoRecording(h.deps);
  h.elements[0].deliver(100);
  await run.finish();
  for (const element of h.elements) {
    assert.equal(element.pendingCount, 0, '探针回调必须被取消');
    assert.equal(element.srcObject, null, '探针必须放开轨道引用');
    assert.equal(element.paused, true, '探针必须暂停');
    assert.ok(element.cancelled >= 1, '取消回调要被调用');
  }
});

test('观测窗到期：自动上报一次并当场拆掉探针', async () => {
  const reported = [];
  const elements = [];
  const observer = createFreezeObserver({
    bridge: { observe: metrics => reported.push(metrics) },
    sourceTrack: fakeTrack('video'), outputTrack: fakeTrack('video'),
    createVideoElement: () => { const element = fakeFrameElement(); elements.push(element); return element; },
    Stream: fakeStream, windowMs: 20,
  });
  assert.equal(reported.length, 0, '观测窗没到之前不上报');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(reported.length, 1, '观测窗到期上报一次');
  assert.equal(reported[0].windowMs, 20);
  for (const element of elements) assert.equal(element.pendingCount, 0, '到期即拆探针');
  observer.stop();
  assert.equal(reported.length, 1, '到期之后再停止不重复上报');
});

test('停止即补报一次，重复停止不重复上报', () => {
  const reported = [];
  const observer = createFreezeObserver({
    bridge: { observe: metrics => reported.push(metrics) },
    sourceTrack: fakeTrack('video'), outputTrack: fakeTrack('video'),
    createVideoElement: () => fakeFrameElement(), Stream: fakeStream, windowMs: 4000,
  });
  assert.equal(reported.length, 0);
  observer.stop();
  assert.equal(reported.length, 1);
  observer.stop();
  assert.equal(reported.length, 1);
});

test('探针创建出错：不留下半截探针，也不拆掉已经好的那一个', () => {
  const reported = [];
  const elements = [];
  const observer = createFreezeObserver({
    bridge: { observe: metrics => reported.push(metrics) },
    sourceTrack: fakeTrack('video'), outputTrack: fakeTrack('video'),
    createVideoElement: () => {
      // 第二个元素在造的时候抛错：不能拖垮第一个探针，也不能留下没释放的轨道引用。
      if (elements.length === 1) throw new Error('probe-create-failed');
      const element = fakeFrameElement();
      elements.push(element);
      return element;
    },
    Stream: fakeStream, windowMs: 4000,
  });
  assert.equal(elements.length, 1, '第二个探针根本没造出来');
  const good = elements[0];
  good.deliver(100);
  observer.stop();
  assert.equal(reported.length, 1);
  assert.equal(reported[0].sourceSupported, 1, '好的探针照常计数');
  assert.equal(reported[0].outputSupported, 0, '坏的探针只是不计数');
  assert.equal(reported[0].sourceFrames, 1);
  assert.equal(good.pendingCount, 0, '好的探针照常被拆');
  assert.equal(good.srcObject, null);
});

test('探针的 play 抛错：一样不留下半截状态', async () => {
  const reported = [];
  const element = fakeFrameElement();
  element.play = async () => { throw new Error('play-failed'); };
  const observer = createFreezeObserver({
    bridge: { observe: metrics => reported.push(metrics) },
    sourceTrack: fakeTrack('video'), outputTrack: fakeTrack('video'),
    createVideoElement: () => element, Stream: fakeStream, windowMs: 4000,
  });
  await new Promise(resolve => setTimeout(resolve, 5));
  observer.stop();
  assert.equal(reported.length, 1);
  assert.equal(reported[0].sourceSupported, 0, '播放失败的探针不算支持');
  assert.equal(reported[0].sourceFrames, 0);
  assert.equal(element.srcObject, null, '出错的探针也要放开轨道引用');
});

test('不支持 rVFC 时只是不计数，不退化到别的观测手段', () => {
  const reported = [];
  const observer = createFreezeObserver({
    bridge: { observe: metrics => reported.push(metrics) },
    sourceTrack: fakeTrack('video'), outputTrack: fakeTrack('video'),
    createVideoElement: () => ({ muted: false, playsInline: false, srcObject: null, play: async () => {} }),
    Stream: fakeStream, windowMs: 4000,
  });
  observer.stop();
  assert.equal(reported.length, 1);
  assert.equal(reported[0].sourceSupported, 0);
  assert.equal(reported[0].outputSupported, 0);
  assert.equal(reported[0].sourceFrames, 0);
  assert.equal(reported[0].outputFrames, 0);
});
