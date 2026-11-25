// 视频录制的纯逻辑用例：音频组合、容器、裁切几何、产物校验与会话生命周期。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIO_MODES, VIDEO_LIMITS, planAudio, chooseContainer, mp4CanvasSize, inspectContainer, computeCaptureCrop,
  checkAudioAcquired, validateOutput, createVideoSession, placeIndicator,
} from '../core/video-session.mjs';

test('两个音频开关互相独立，四种组合各自成立', () => {
  const cases = [
    [{}, AUDIO_MODES.NONE, false, false, false],
    [{ systemAudio: true }, AUDIO_MODES.SYSTEM, true, false, false],
    [{ microphone: true }, AUDIO_MODES.MICROPHONE, false, true, false],
    [{ systemAudio: true, microphone: true }, AUDIO_MODES.BOTH, true, true, true],
  ];
  for (const [input, mode, wantSystem, wantMicrophone, mix] of cases) {
    const plan = planAudio(input);
    assert.equal(plan.mode, mode);
    assert.equal(plan.wantSystem, wantSystem);
    assert.equal(plan.wantMicrophone, wantMicrophone);
    assert.equal(plan.mix, mix);
  }
  // 默认两个开关都是关的。
  assert.equal(planAudio().mode, AUDIO_MODES.NONE);
  assert.equal(planAudio({ systemAudio: false, microphone: false }).mode, AUDIO_MODES.NONE);
});

test('请求了哪条音轨就必须拿到哪条，拿不到就报错', () => {
  assert.equal(checkAudioAcquired(planAudio({ systemAudio: true }), { system: true }), true);
  assert.equal(checkAudioAcquired(planAudio({ microphone: true }), { microphone: true }), true);
  assert.equal(checkAudioAcquired(planAudio({ systemAudio: true, microphone: true }), { system: true, microphone: true }), true);
  // 少一条都不行：不能悄悄只录到一路。
  assert.throws(() => checkAudioAcquired(planAudio({ systemAudio: true }), { system: false }), /电脑声音/);
  assert.throws(() => checkAudioAcquired(planAudio({ microphone: true }), { system: true }), /麦克风/);
  assert.throws(() => checkAudioAcquired(planAudio({ systemAudio: true, microphone: true }), { system: true }), /麦克风/);
  assert.throws(() => checkAudioAcquired(planAudio({ systemAudio: true, microphone: true }), { microphone: true }), /电脑声音/);
});

test('优先显式 AVC，有音轨才请求 AAC，否则回退 WebM', () => {
  assert.equal(chooseContainer({ isTypeSupported: () => true }).mimeType, 'video/mp4;codecs=avc1.42001f');
  assert.equal(chooseContainer({ isTypeSupported: () => true, hasAudio: true }).mimeType, 'video/mp4;codecs=avc1.42001f,mp4a.40.2');
  assert.equal(chooseContainer({ isTypeSupported: t => t.startsWith('video/webm'), hasAudio: true }).container, 'webm');
  assert.equal(chooseContainer({ isTypeSupported: () => true, allowMp4: false }).container, 'webm');
  assert.throws(() => chooseContainer({ isTypeSupported: () => false }), /不支持/);
  assert.throws(() => chooseContainer({}), /容器/);
});

test('MP4 只向右下填一像素，超过边界则不能使用', () => {
  assert.deepEqual(mp4CanvasSize({width:161,height:121}), {width:162,height:122});
  assert.deepEqual(mp4CanvasSize({width:160,height:120}), {width:160,height:120});
  assert.equal(mp4CanvasSize({width:4095,height:2049}, {MAX_EDGE:4096, MAX_PIXELS:4095*2049}), null);
});

test('MP4 顶层盒子和实际 AVC/AAC MIME 必须完整一致', () => {
  const box = (tag, payload=[]) => Uint8Array.from([0,0,0,8+payload.length,...Buffer.from(tag),...payload]);
  const bytes = Buffer.concat([box('ftyp',[0,0,0,0,0,0,0,0]),box('moov',[1]),box('moof',[1]),box('mdat',[1])]);
  const check = (mimeType, hasAudio, data=bytes) => validateOutput({bytes:data,mimeType,extension:'mp4',hasAudio});
  assert.equal(check('video/mp4;codecs=avc1.420015,mp4a.40.2',true).size, bytes.length);
  assert.equal(check('video/mp4;codecs=avc1.420015',false).size, bytes.length);
  for (const mime of ['video/mp4', 'video/mp4;codecs=vp09,opus', 'video/mp4;codecs=avc1.420015,mp4a.40.2']) assert.throws(() => check(mime,false), /编码/);
  assert.throws(() => check('video/mp4;codecs=avc1.420015',true), /编码/);
  assert.throws(() => check('video/mp4;codecs=avc1.420015',false,Buffer.concat([box('ftyp',[0,0,0,0,0,0,0,0]),box('free',Buffer.from('moovmdat'))])), /文件头/);
  assert.throws(() => check('video/mp4;codecs=avc1.420015',false,bytes.subarray(0,bytes.length-1)), /有效/);
});

test('只有文件头的产物要被拒掉', () => {
  const ebmlHeader = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);
  const real = new Uint8Array(64);
  real.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  real.set([0x1f, 0x43, 0xb6, 0x75], 20);
  assert.deepEqual(inspectContainer(ebmlHeader, 'webm'), { signature: true, hasContent: false });
  assert.deepEqual(inspectContainer(real, 'webm'), { signature: true, hasContent: true });
  // 有签名但没有簇：只有头，拒。
  assert.throws(() => validateOutput({ bytes: ebmlHeader, mimeType: 'video/webm', extension: 'webm' }), /只有文件头/);
  // 有真实内容：通过。
  assert.equal(validateOutput({ bytes: real, mimeType: 'video/webm', extension: 'webm' }).size, 64);
  // 签名不对：拒。
  assert.throws(() => validateOutput({ bytes: new Uint8Array(64), mimeType: 'video/webm', extension: 'webm' }), /不是有效/);
});

test('选区按采集源尺寸换算，比例对不上就拒绝', () => {
  const display = { physical: { x: 0, y: 0, width: 1920, height: 1080 } };
  // 采集源与屏幕同尺寸：像素直接对上。
  const same = computeCaptureCrop({ selection: { x: 100, y: 50, width: 400, height: 200 }, display,
    source: { width: 1920, height: 1080 } });
  assert.deepEqual({ x: same.x, y: same.y, width: same.width, height: same.height }, { x: 100, y: 50, width: 400, height: 200 });
  // 采集源是半尺寸：按比例缩一半。
  const half = computeCaptureCrop({ selection: { x: 100, y: 50, width: 400, height: 200 }, display,
    source: { width: 960, height: 540 } });
  assert.deepEqual({ x: half.x, y: half.y, width: half.width, height: half.height }, { x: 50, y: 25, width: 200, height: 100 });
  // 采集源比例与屏幕不一致：明确拒绝，不猜。
  assert.throws(() => computeCaptureCrop({ selection: { x: 0, y: 0, width: 100, height: 100 }, display,
    source: { width: 1600, height: 1200 } }), /不成比例/);
  // 选区跑到屏幕外：按屏幕裁到可用范围，裁空就拒绝。
  const clipped = computeCaptureCrop({ selection: { x: 1800, y: 1000, width: 400, height: 200 }, display,
    source: { width: 1920, height: 1080 } });
  assert.equal(clipped.width, 120);
  assert.equal(clipped.height, 80);
  assert.throws(() => computeCaptureCrop({ selection: { x: 3000, y: 0, width: 100, height: 100 }, display,
    source: { width: 1920, height: 1080 } }), /不在这一块屏幕/);
  assert.throws(() => computeCaptureCrop({ selection: { x: 0, y: 0, width: 1, height: 1 }, display,
    source: { width: 1920, height: 1080 } }), /太小/);
});

test('产物校验：非空、不超上限、类型与容器一致、要有真实数据', () => {
  const bytes = new Uint8Array(1024);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  bytes.set([0x1f, 0x43, 0xb6, 0x75], 40);
  assert.deepEqual(validateOutput({ bytes, mimeType: 'video/webm', extension: 'webm' }),
    { size: 1024, mimeType: 'video/webm', extension: 'webm' });
  assert.throws(() => validateOutput({ bytes: new Uint8Array(0), mimeType: 'video/webm', extension: 'webm' }), /为空/);
  assert.throws(() => validateOutput({ bytes, mimeType: 'video/webm', extension: 'mp4' }), /不一致/);
  assert.throws(() => validateOutput({ bytes, mimeType: 'application/octet-stream', extension: 'webm' }), /类型不对/);
  assert.throws(() => validateOutput({ bytes, mimeType: 'video/webm', extension: 'webm', limits: { ...VIDEO_LIMITS, MAX_BYTES: 10 } }), /体积上限/);
});

test('会话生命周期：任何结束路径都会把轨道停干净', () => {
  const stopped = [];
  const track = { stop() { stopped.push('a'); } };
  const session = createVideoSession();
  assert.equal(session.phase, 'idle');
  session.begin({ selection: { width: 100, height: 100 }, display: { physical: { width: 1920, height: 1080 } } });
  assert.equal(session.phase, 'preparing');
  session.addTrack(track);
  session.start();
  assert.equal(session.phase, 'recording');
  assert.equal(session.tracks, 1);
  session.stop();
  assert.equal(session.phase, 'stopping');
  assert.deepEqual(stopped, ['a']);
  assert.equal(session.tracks, 0);
  session.saving();
  session.finish();
  assert.equal(session.phase, 'done');
});

test('会话失败与取消同样收轨道，重复收尾不会重复停', () => {
  const stopped = [];
  const session = createVideoSession();
  session.begin({ selection: { width: 100, height: 100 }, display: { physical: { width: 1920, height: 1080 } } });
  session.addTrack({ stop() { stopped.push('x'); } });
  session.start();
  session.fail('设置里拒绝了麦克风');
  assert.equal(session.phase, 'failed');
  assert.match(session.reason, /麦克风/);
  assert.deepEqual(stopped, ['x']);
  session.fail('又失败一次');
  assert.deepEqual(stopped, ['x'], '失败后不再重复停轨道');

  const cancelled = createVideoSession();
  cancelled.begin({ selection: { width: 100, height: 100 }, display: { physical: { width: 1920, height: 1080 } } });
  cancelled.addTrack({ stop() { stopped.push('y'); } });
  cancelled.start();
  cancelled.cancel();
  assert.equal(cancelled.phase, 'cancelled');
  assert.deepEqual(stopped, ['x', 'y']);
});

test('超过时长上限自动失败并收尾', () => {
  let clock = 1000;
  const session = createVideoSession({ now: () => clock });
  session.begin({ selection: { width: 100, height: 100 }, display: { physical: { width: 1920, height: 1080 } } });
  const stopped = [];
  session.addTrack({ stop() { stopped.push('z'); } });
  session.start();
  clock += VIDEO_LIMITS.MAX_DURATION_MS + 1;
  assert.equal(session.expired(), true);
  assert.equal(session.phase, 'failed');
  assert.deepEqual(stopped, ['z']);
  clock += 1000;
  assert.equal(session.expired(), false, '失败后不再重复判定');
});

test('指示条只能放在选区外，放不下就明确拒绝', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1080 };
  const size = { width: 232, height: 56 };
  const below = placeIndicator({ area, selection: { x: 400, y: 200, width: 600, height: 400 }, size });
  assert.equal(below.y, 608);
  assert.equal(below.x, 400);
  // 默认先试下方；下方放不下才试上方。
  const belowSpot = placeIndicator({ area, selection: { x: 400, y: 200, width: 600, height: 400 }, size });
  assert.equal(belowSpot.y, 608);
  assert.equal(belowSpot.x, 400);
  // 选区贴着下边：改放上面。
  const above = placeIndicator({ area, selection: { x: 400, y: 900, width: 600, height: 150 }, size });
  assert.equal(above.y, 900 - 8 - 56);
  // 选区占满整块屏：没有安全位置，明确拒绝。
  assert.equal(placeIndicator({ area, selection: { x: 0, y: 0, width: 1920, height: 1080 }, size }), undefined);
  // 不变式：无论放哪，指示条都不压选区、也不出界。
  for (const selection of [{ x: 100, y: 100, width: 300, height: 300 }, { x: 0, y: 0, width: 1000, height: 1080 },
    { x: 900, y: 500, width: 1000, height: 560 }, { x: 10, y: 10, width: 20, height: 20 }]) {
    const spot = placeIndicator({ area, selection, size });
    if (!spot) continue;
    const overlaps = spot.x < selection.x + selection.width && spot.x + spot.width > selection.x &&
      spot.y < selection.y + selection.height && spot.y + spot.height > selection.y;
    assert.equal(overlaps, false, '指示条不能压住选区');
    assert.equal(spot.x >= area.x && spot.y >= area.y &&
      spot.x + spot.width <= area.x + area.width && spot.y + spot.height <= area.y + area.height, true, '指示条不能出界');
  }
});

test('阶段推进必须是显式的，跳步会被拒绝', () => {
  const session = createVideoSession();
  assert.throws(() => session.start(), /还没准备好/);
  assert.throws(() => session.finish(), /还没保存/);
  assert.throws(() => session.begin({ selection: { width: 0, height: 0 }, display: {} }), /选区无效/);
  assert.throws(() => session.begin({ selection: { width: 10, height: 10 } }), /屏幕/);
  session.begin({ selection: { width: 10, height: 10 }, display: { physical: { width: 100, height: 100 } } });
  assert.throws(() => session.begin({ selection: { width: 10, height: 10 }, display: { physical: { width: 100, height: 100 } } }), /已经开始/);
});
