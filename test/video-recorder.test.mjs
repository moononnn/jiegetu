// 视频录制页的用例：全部用合成源（假屏幕流、假麦克风、假 MediaRecorder），
// 不碰真实桌面、不碰真实麦克风，也不假装验过真实音视频。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runVideoRecording } from '../renderer/video-recorder.mjs';

function fakeTrack(kind, extra = {}) {
  const listeners = new Map();
  return {
    kind, label: extra.label || kind, stopped: false,
    getSettings: () => ({ width: extra.width || 1920, height: extra.height || 1080 }),
    stop() { this.stopped = true; },
    addEventListener(type, fn) { listeners.set(type, fn); },
    emit(type) { listeners.get(type)?.(); },
  };
}

function fakeStream(tracks) { return { getTracks: () => tracks, getVideoTracks: () => tracks.filter(t => t.kind === 'video'), getAudioTracks: () => tracks.filter(t => t.kind === 'audio') }; }

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

function harness({ plan = { wantSystem: false, wantMicrophone: false, mix: false }, systemAudio = true, micDenied = false, displayFails = false } = {}) {
  const calls = { display: [], user: [], state: [], result: [], stop: [] };
  const displayTrack = fakeTrack('video', { width: 1920, height: 1080 });
  const systemTrack = fakeTrack('audio', { label: 'system' });
  const mic = fakeTrack('audio', { label: 'mic' });
  const mediaDevices = {
    async getDisplayMedia(options) {
      calls.display.push(options);
      if (displayFails) throw new Error('用户拒绝了屏幕采集');
      return fakeStream([displayTrack, ...(options.audio && systemAudio ? [systemTrack] : [])]);
    },
    async getUserMedia(options) {
      calls.user.push(options);
      if (micDenied) throw new Error('用户拒绝了麦克风');
      return fakeStream([mic]);
    },
  };
  const canvasTrack = fakeTrack('video');
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }), captureStream: () => fakeStream([canvasTrack]) };
  const bridge = {
    config: async () => ({
      selection: { x: 100, y: 50, width: 400, height: 200 },
      displayPhysical: { x: 0, y: 0, width: 1920, height: 1080 },
      plan, limits: { maxDurationMs: 60000, maxBytes: 1024 * 1024 },
    }),
    state: payload => calls.state.push(payload),
    result: async payload => { calls.result.push(payload); return { saved: true }; },
    onStop: fn => calls.stop.push(fn),
  };
  const deps = {
    bridge, mediaDevices, MediaRecorder: FakeMediaRecorder, MediaStream: fakeStream,
    createCanvas: () => canvas, videoElement: { srcObject: null, muted: true, play: async () => {} },
    AudioContext: class {
      constructor() { this.state = 'running'; this.destination = { stream: fakeStream([fakeTrack('audio', { label: 'mixed' })]) }; }
      createMediaStreamSource() { return { connect() {} }; }
      createMediaStreamDestination() { return this.destination; }
      resume() {}
      close() { this.closed = true; }
    },
  };
  return { deps, calls, displayTrack, systemTrack, mic, canvasTrack, canvas };
}

test('MP4 奇数选区填充且不扩大源裁切', async () => {
  const h = harness(); const config = await h.deps.bridge.config(); config.selection.width = 401; config.selection.height = 201; h.deps.config = config;
  const calls = []; h.canvas.getContext = () => ({ fillRect: (...a) => calls.push(['fill',...a]), drawImage: (...a) => calls.push(['draw',...a.slice(1)]) });
  class MP4 extends FakeMediaRecorder { static isTypeSupported() { return true; } }
  h.deps.MediaRecorder = MP4;
  const run = await runVideoRecording(h.deps);
  assert.equal(run.container.extension,'mp4'); assert.equal(h.canvas.width,402); assert.equal(h.canvas.height,202);
  assert.deepEqual(calls[0],['fill',0,0,402,202]); assert.deepEqual(calls[1],['draw',100,50,401,201,0,0,401,201]);
  // Fake recorder emits WebM: never accept it as MP4.
  await assert.rejects(run.finish()); assert.equal(h.calls.result.length,0);
});

test('同步启动 MP4 失败才回退 WebM', async () => {
  const h = harness();
  class StartFail extends FakeMediaRecorder {
    static isTypeSupported() { return true; }
    start() { if (this.options.mimeType.startsWith('video/mp4')) throw Error('encoder unavailable'); super.start(); }
  }
  h.deps.MediaRecorder = StartFail; const run = await runVideoRecording(h.deps);
  assert.equal(run.container.extension,'webm'); await run.finish(); assert.equal(h.calls.result.length,1);
});

test('异步编码错误仍保留有效收尾数据，不回退或丢弃', async () => {
  const h = harness(); const run = await runVideoRecording(h.deps);
  run.recorder.onerror(); const result = await run.finish();
  assert.match(result.warning,/编码中断/); assert.equal(h.calls.result.length,1); assert.equal(h.calls.result[0].encoderInterrupted,true);
  assert.equal(h.calls.state.some(s => s.state === 'failed'),false);
});

test('没有打开任何音频开关时：不申请麦克风，也不混音', async () => {
  const { deps, calls } = harness({ plan: { wantSystem: false, wantMicrophone: false, mix: false } });
  const run = await runVideoRecording(deps);
  assert.equal(calls.display.length, 1);
  assert.equal(calls.display[0].audio, false, '不要系统声音就不要向屏幕流要音频');
  assert.equal(calls.user.length, 0, '没打开麦克风就不申请麦克风');
  await run.finish();
});

test('只开电脑声音：向屏幕流要音频，不申请麦克风', async () => {
  const { deps, calls } = harness({ plan: { wantSystem: true, wantMicrophone: false, mix: false } });
  const run = await runVideoRecording(deps);
  assert.equal(calls.display[0].audio, true);
  assert.equal(calls.user.length, 0, '没打开麦克风就不申请麦克风');
  await run.finish();
});

test('只开麦克风：不向屏幕流要音频，另外申请一条纯音频轨', async () => {
  const { deps, calls } = harness({ plan: { wantSystem: false, wantMicrophone: true, mix: false } });
  const run = await runVideoRecording(deps);
  assert.equal(calls.display[0].audio, false);
  assert.equal(calls.user.length, 1);
  assert.deepEqual(calls.user[0], { audio: true, video: false }, '麦克风只申请音频，不要摄像头');
  await run.finish();
});

test('两个都开：两路音频混成一条轨', async () => {
  const { deps, calls } = harness({ plan: { wantSystem: true, wantMicrophone: true, mix: true } });
  const run = await runVideoRecording(deps);
  assert.equal(calls.display[0].audio, true);
  assert.equal(calls.user.length, 1);
  // 混音后录制流里只有一条音频轨。
  assert.equal(run.recorder.stream.getAudioTracks().length, 1);
  await run.finish();
});

test('请求了电脑声音但没拿到轨道：明确失败，不静默改录别的', async () => {
  const { deps } = harness({ plan: { wantSystem: true, wantMicrophone: false, mix: false }, systemAudio: false });
  await assert.rejects(() => runVideoRecording(deps), /电脑声音/);
});

test('麦克风被拒绝：明确失败，并把已经拿到的轨道停掉', async () => {
  const { deps, displayTrack } = harness({ plan: { wantSystem: false, wantMicrophone: true, mix: false }, micDenied: true });
  await assert.rejects(() => runVideoRecording(deps), /麦克风/);
  assert.equal(displayTrack.stopped, true, '失败也要把屏幕轨停掉');
});

test('屏幕采集被拒：明确失败', async () => {
  const { deps } = harness({ displayFails: true });
  await assert.rejects(() => runVideoRecording(deps), /屏幕采集/);
});

test('录制结束后：产物按真实容器上交，扩展名不撒谎', async () => {
  const { deps, calls } = harness();
  const run = await runVideoRecording(deps);
  await run.finish();
  assert.equal(calls.result.length, 1);
  const payload = calls.result[0];
  assert.equal(payload.extension, 'webm');
  assert.match(payload.mimeType, /^video\/webm/);
  assert.ok(payload.bytes.length > 0);
});

test('停止后所有采集到的轨道都被停掉', async () => {
  const { deps, displayTrack, canvasTrack } = harness({ plan: { wantSystem: true, wantMicrophone: true, mix: true } });
  const run = await runVideoRecording(deps);
  await run.finish();
  assert.equal(displayTrack.stopped, true);
  assert.equal(canvasTrack.stopped, true);
});

test('设备被系统收回：明确报失败', async () => {
  const { deps, calls, displayTrack } = harness();
  const run = await runVideoRecording(deps);
  displayTrack.emit('ended');
  await assert.rejects(run.finish(), /屏幕采集被系统收回/);
  assert.deepEqual(calls.state.at(-1), { state: 'failed', message: '屏幕采集被系统收回' });
  assert.equal(displayTrack.stopped, true);
  assert.equal(calls.result.length, 0);
});
