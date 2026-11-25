// 视频录制的纯逻辑：音频组合、容器选择、裁切几何、时长/体积上限与会话状态机。
// 不依赖 Electron、DOM 或真实设备，测试全部用合成数据跑。

export const VIDEO_LIMITS = {
  MAX_DURATION_MS: 60_000,        // 一次录制的时长上限
  MAX_BYTES: 512 * 1024 * 1024,   // 产物体积上限
  MAX_EDGE: 4096,                 // 单边上限
  MAX_PIXELS: 3840 * 2160,        // 总像素上限
};

export const AUDIO_MODES = {
  NONE: 'none',
  SYSTEM: 'system',
  MICROPHONE: 'microphone',
  BOTH: 'both',
};

// 两个独立开关 → 本轮实际要采集的音源。两路都要时必须混成一条轨。
export function planAudio({ systemAudio = false, microphone = false } = {}) {
  const wantSystem = systemAudio === true;
  const wantMicrophone = microphone === true;
  const mode = wantSystem && wantMicrophone ? AUDIO_MODES.BOTH
    : wantSystem ? AUDIO_MODES.SYSTEM
      : wantMicrophone ? AUDIO_MODES.MICROPHONE : AUDIO_MODES.NONE;
  return { mode, wantSystem, wantMicrophone, mix: mode === AUDIO_MODES.BOTH };
}

// 显式请求已探测的 AVC；不能用通用 MP4，因为可能实际编码为 VP9。
export function chooseContainer({ isTypeSupported, hasAudio = false, allowMp4 = true } = {}) {
  if (typeof isTypeSupported !== 'function') throw new Error('缺少容器能力探测');
  const mp4 = `video/mp4;codecs=avc1.42001f${hasAudio ? ',mp4a.40.2' : ''}`;
  if (allowMp4 && isTypeSupported(mp4)) return { mimeType: mp4, container: 'mp4', extension: 'mp4' };
  for (const mimeType of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) {
    if (isTypeSupported(mimeType)) return { mimeType, container: 'webm', extension: 'webm' };
  }
  throw new Error('这台机器不支持可用的视频容器');
}

export function mp4CanvasSize(crop, limits = VIDEO_LIMITS) {
  const width = crop.width + crop.width % 2, height = crop.height + crop.height % 2;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 2 ||
      width > limits.MAX_EDGE || height > limits.MAX_EDGE || width * height > limits.MAX_PIXELS) return null;
  return { width, height };
}

// 容器体检：签名对不对、里面有没有真实画面数据。
// 只有文件头的产物（录了 0 字节内容）必须被拒掉。
export function inspectContainer(bytes, extension) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  if (extension === 'webm') {
    const signature = data.length >= 4 && data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3;
    let cluster = false;
    for (let i = 0; i + 3 < data.length; i += 1) {
      if (data[i] === 0x1f && data[i + 1] === 0x43 && data[i + 2] === 0xb6 && data[i + 3] === 0x75) { cluster = true; break; }
    }
    return { signature, hasContent: cluster };
  }
  if (extension === 'mp4') {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 0, count = 0, signature = false, moov = false, mdat = false;
    while (offset < data.length && count++ < 100000) {
      if (data.length - offset < 8) return { signature: false, hasContent: false };
      let size = view.getUint32(offset), header = 8;
      const tag = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
      if (size === 1) {
        if (data.length - offset < 16) return { signature: false, hasContent: false };
        const big = view.getBigUint64(offset + 8);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) return { signature: false, hasContent: false };
        size = Number(big); header = 16;
      } else if (size === 0) size = data.length - offset;
      if (size < header || size > data.length - offset) return { signature: false, hasContent: false };
      if (offset === 0 && tag === 'ftyp' && size >= header + 8) signature = true;
      if (tag === 'moov' && size > header) moov = true;
      if (tag === 'mdat' && size > header) mdat = true;
      offset += size;
    }
    return { signature: signature && offset === data.length, hasContent: moov && mdat && offset === data.length };
  }
  return { signature: false, hasContent: false };
}

// 选区（物理像素）→ 采集流里的裁切矩形。采集源尺寸与屏幕不一致时按比例换算；
// 比例对不上就明确拒绝，不做猜着裁。
export function computeCaptureCrop({ selection, display, source } = {}) {
  const rect = selection || {}, physical = display?.physical || display?.bounds || {}, size = source || {};
  const dw = Number(physical.width), dh = Number(physical.height);
  const sw = Number(size.width), sh = Number(size.height);
  if (![dw, dh, sw, sh].every(value => Number.isFinite(value) && value > 0)) throw new Error('缺少屏幕或采集源尺寸');
  const width = Number(rect.width), height = Number(rect.height);
  if (![width, height].every(value => Number.isFinite(value) && value > 1)) throw new Error('选区太小');
  const originX = Number(physical.x) || 0, originY = Number(physical.y) || 0;
  const left = Math.max(0, Math.round(Number(rect.x) - originX));
  const top = Math.max(0, Math.round(Number(rect.y) - originY));
  const right = Math.min(dw, Math.round(Number(rect.x) + width - originX));
  const bottom = Math.min(dh, Math.round(Number(rect.y) + height - originY));
  if (right - left < 2 || bottom - top < 2) throw new Error('选区不在这一块屏幕上');
  const scaleX = sw / dw, scaleY = sh / dh;
  if (Math.abs(scaleX - scaleY) > 0.02) throw new Error('采集尺寸与屏幕不成比例，无法对齐选区');
  const crop = {
    x: Math.round(left * scaleX),
    y: Math.round(top * scaleY),
    width: Math.round((right - left) * scaleX),
    height: Math.round((bottom - top) * scaleY),
  };
  crop.width = Math.min(crop.width, sw - crop.x);
  crop.height = Math.min(crop.height, sh - crop.y);
  if (crop.width < 2 || crop.height < 2) throw new Error('裁切后没有可录的画面');
  if (crop.width > VIDEO_LIMITS.MAX_EDGE || crop.height > VIDEO_LIMITS.MAX_EDGE) throw new Error('录制的画面太大');
  if (crop.width * crop.height > VIDEO_LIMITS.MAX_PIXELS) throw new Error('录制的画面太大');
  return { ...crop, scale: scaleX, sourceWidth: sw, sourceHeight: sh };
}

// 录制指示条只能放在选区外：下、上、右、左四个候选位都放不下就明确拒绝，
// 绝不允许压进选区（否则会被自己的录屏拍进去）。
export function placeIndicator({ area, selection, size, gap = 8 } = {}) {
  const a = area || {}, s = selection || {}, box = size || {};
  const aw = Number(a.width), ah = Number(a.height);
  const sw = Number(box.width), sh = Number(box.height);
  if (![aw, ah, sw, sh].every(value => Number.isFinite(value) && value > 0)) return undefined;
  const left = Number(a.x) || 0, top = Number(a.y) || 0;
  const selLeft = Number(s.x) || 0, selTop = Number(s.y) || 0;
  const selRight = selLeft + (Number(s.width) || 0), selBottom = selTop + (Number(s.height) || 0);
  const overlaps = (x, y) => x < selRight && x + sw > selLeft && y < selBottom && y + sh > selTop;
  const candidates = [
    { x: selLeft, y: selBottom + gap },
    { x: selLeft, y: selTop - gap - sh },
    { x: selRight + gap, y: selTop },
    { x: selLeft - gap - sw, y: selTop },
  ];
  for (const spot of candidates) {
    const x = Math.round(spot.x), y = Math.round(spot.y);
    if (x < left || y < top || x + sw > left + aw || y + sh > top + ah) continue;
    if (overlaps(x, y)) continue;
    return { x, y, width: Math.round(sw), height: Math.round(sh) };
  }
  return undefined;
}

// 请求了哪条音轨就必须真的拿到哪条：拿不到就报错，不许悄悄换成别的源。
export function checkAudioAcquired(plan, acquired = {}) {
  if (plan.wantSystem && acquired.system !== true) throw new Error('没有拿到电脑声音轨道');
  if (plan.wantMicrophone && acquired.microphone !== true) throw new Error('没有拿到麦克风轨道');
  return true;
}

// 产物校验：非空、不超上限、类型与容器一致、而且真的有画面数据（只有文件头要拒）。
export function validateOutput({ bytes, mimeType, extension, hasAudio, limits = VIDEO_LIMITS } = {}) {
  const size = Number(bytes?.length ?? bytes);
  if (!Number.isFinite(size) || size <= 0) throw new Error('录制结果为空');
  if (size > limits.MAX_BYTES) throw new Error('录制结果超过体积上限');
  if (typeof mimeType !== 'string' || !mimeType.startsWith('video/')) throw new Error('录制结果类型不对');
  const expected = extension === 'mp4' ? 'video/mp4' : extension === 'webm' ? 'video/webm' : '';
  if (!expected || !new RegExp(`^${expected}(?:\\s*;|\\s*$)`, 'i').test(mimeType)) throw new Error('录制结果类型与容器不一致');
  if (extension === 'mp4') {
    const match = /(?:^|;)\s*codecs\s*=\s*"?([^";]+)"?/i.exec(mimeType);
    const codecs = match ? match[1].split(',').map(s => s.trim().toLowerCase()) : [];
    if (codecs.filter(c => /^avc1\.[0-9a-f]{6}$/.test(c)).length !== 1 ||
        codecs.some(c => !/^avc1\.[0-9a-f]{6}$/.test(c) && c !== 'mp4a.40.2') ||
        codecs.filter(c => c === 'mp4a.40.2').length > 1 ||
        (hasAudio !== undefined && codecs.includes('mp4a.40.2') !== hasAudio)) throw new Error('MP4 编码类型不对');
  }
  const container = inspectContainer(bytes, extension);
  if (!container.signature) throw new Error('录制结果不是有效的视频文件');
  if (!container.hasContent) throw new Error('录制结果只有文件头，没有画面数据');
  return { size, mimeType, extension };
}

// 录制会话状态机：只认显式的阶段推进，任何结束路径都会把采集到的轨道全部停掉。
export function createVideoSession({ limits = VIDEO_LIMITS, now = () => Date.now() } = {}) {
  let phase = 'idle';
  let startedAt = 0;
  let reason = '';
  const tracks = new Set();
  const cleanupLog = [];

  function stopTracks() {
    for (const track of tracks) {
      try {
        if (track && typeof track.stop === 'function') track.stop();
        cleanupLog.push('stopped');
      } catch {
        cleanupLog.push('failed');
      }
    }
    tracks.clear();
    return cleanupLog.length;
  }

  function move(next, why = '') {
    phase = next;
    if (why) reason = why;
    return phase;
  }

  return {
    get phase() { return phase; },
    get reason() { return reason; },
    get elapsedMs() { return phase === 'recording' ? Math.max(0, now() - startedAt) : 0; },
    get tracks() { return tracks.size; },
    get cleaned() { return cleanupLog.length; },
    // 允许的阶段推进：idle → preparing → recording → stopping → saving → done
    begin(config = {}) {
      if (phase !== 'idle') throw new Error('录制会话已经开始');
      const selection = config.selection || {};
      if (!(Number(selection.width) > 1 && Number(selection.height) > 1)) throw new Error('选区无效');
      if (!config.display) throw new Error('缺少屏幕信息');
      move('preparing');
      return phase;
    },
    start() {
      if (phase !== 'preparing') throw new Error('还没准备好就开始录制');
      startedAt = now();
      move('recording');
      return phase;
    },
    addTrack(track) {
      if (!track || typeof track.stop !== 'function') throw new Error('不是可停止的轨道');
      tracks.add(track);
      return tracks.size;
    },
    stop() {
      if (phase !== 'recording' && phase !== 'preparing') throw new Error('当前不在录制中');
      move('stopping');
      stopTracks();
      return phase;
    },
    saving() {
      if (phase !== 'stopping') throw new Error('还没停止就开始保存');
      move('saving');
      return phase;
    },
    finish() {
      if (phase !== 'saving') throw new Error('还没保存就结束');
      stopTracks();
      move('done');
      return phase;
    },
    fail(why = '录制失败') {
      if (phase === 'done' || phase === 'cancelled') return phase;
      stopTracks();
      move('failed', why);
      return phase;
    },
    cancel() {
      if (phase === 'done') return phase;
      stopTracks();
      move('cancelled', '用户取消');
      return phase;
    },
    // 到点自动停：超过时长上限就算失败并收干净。
    expired() {
      if (phase !== 'recording') return false;
      if (this.elapsedMs <= limits.MAX_DURATION_MS) return false;
      this.fail('超过录制时长上限');
      return true;
    },
  };
}
