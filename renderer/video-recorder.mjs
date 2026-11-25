import { computeCaptureCrop, checkAudioAcquired, chooseContainer, mp4CanvasSize, validateOutput } from '../core/video-session.mjs';
import { createFreezeObserver } from './video-freeze-observer.mjs';

export async function runVideoRecording(deps = {}) {
  const bridge = deps.bridge || globalThis.video;
  const media = deps.mediaDevices || navigator.mediaDevices;
  const Recorder = deps.MediaRecorder || globalThis.MediaRecorder;
  const Audio = deps.AudioContext || globalThis.AudioContext;
  const Stream = deps.MediaStream || globalThis.MediaStream;
  const config = deps.config || await bridge.config();
  const { plan, limits } = config;
  const sizeLimit = limits.maxBytes;
  const tracks = new Set();
  let audio, oscNodes = [], video, drawTimer, stopTimer, wallTimer, recorder, timeout, disposed = false, observer = null;
  const report = (state, message) => Promise.resolve().then(() => bridge.state?.({ state, ...(message ? { message } : {}) })).catch(() => {});
  const own = stream => {
    for (const t of stream.getTracks()) {
      if (disposed) t.stop(); else tracks.add(t);
    }
    if (disposed) throw new Error('录制已取消');
    return stream;
  };
  function release() {
    if (disposed) return;
    disposed = true;
    clearTimeout(stopTimer); clearTimeout(wallTimer); clearTimeout(timeout); clearInterval(drawTimer);
    if (observer) { observer.stop(); observer = null; }
    for (const t of tracks) { try { t.stop(); } catch {} }
    tracks.clear();
    if (video) { video.pause?.(); video.srcObject = null; }
    for (const node of oscNodes) { try { node.disconnect?.(); } catch {} }
    oscNodes = [];
    if (audio) { try { Promise.resolve(audio.close()).catch(() => {}); } catch {} }
    globalThis.window?.removeEventListener?.('pagehide', release);
  }
  globalThis.window?.addEventListener?.('pagehide', release, { once: true });
  try {
    // getDisplayMedia runs before yielding on this renderer's trusted start gesture.
    const displayPending = media.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: plan.wantSystem });
    if (plan.mix) { audio = new Audio(); }
    const resumed = audio ? Promise.resolve(audio.resume()).then(() => audio.state === 'running', () => false) : null;
    let display;
    try { display = own(await displayPending); }
    catch (error) {
      if (error?.name === 'NotAllowedError' || error?.message === 'Permission denied') throw new Error('屏幕采集未获授权，录制未开始');
      throw error;
    }
    const source = display.getVideoTracks()[0];
    if (!source) throw new Error('没有拿到屏幕轨道');
    const computer = plan.wantSystem ? display.getAudioTracks()[0] : null;
    let microphone;
    if (plan.wantMicrophone) {
      try { microphone = own(await media.getUserMedia({ audio: true, video: false })).getAudioTracks()[0]; }
      catch { throw new Error('麦克风未取到声音，请检查 Windows 麦克风权限和设备'); }
    }
    checkAudioAcquired(plan, { system: Boolean(computer), microphone: Boolean(microphone) });
    let sound = computer || microphone;
    if (audio) {
      if (!await resumed) throw new Error('无法启动两路声音的混音');
      const destination = audio.createMediaStreamDestination();
      for (const t of [computer, microphone]) {
        const node = audio.createMediaStreamSource(new Stream([t]));
        node.connect(destination); oscNodes.push(node);
      }
      sound = own(destination.stream).getAudioTracks()[0];
      if (!sound) throw new Error('无法得到混音轨道');
    }

    video = deps.videoElement || document.createElement('video');
    video.srcObject = display; video.muted = true;
    await video.play();
    const crop = computeCaptureCrop({ selection: config.selection, display: { physical: config.displayPhysical }, source: source.getSettings() });
    if (!deps.videoElement && (!(video.videoWidth > 0) || !(video.videoHeight > 0))) throw new Error('屏幕画面还未就绪');
    const supported = type => Recorder.isTypeSupported(type);
    const padded = mp4CanvasSize(crop);
    let container = chooseContainer({ isTypeSupported: supported, hasAudio: Boolean(sound), allowMp4: Boolean(padded) });
    const canvas = deps.createCanvas?.() || document.createElement('canvas');
    canvas.width = container.container === 'mp4' ? padded.width : crop.width;
    canvas.height = container.container === 'mp4' ? padded.height : crop.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法建立录制画布');
    const draw = () => {
      if (canvas.width !== crop.width || canvas.height !== crop.height) {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
      observer?.paint();
    };
    const outputVideo = own(canvas.captureStream(15)).getVideoTracks()[0];
    if (!outputVideo) throw new Error('未取得选区视频轨道');
    // DEV 观测（默认关）：只计数与时间差，不读像素。主进程没开 dev 开关时这段完全不执行。
    if (config.observe === true) {
      observer = createFreezeObserver({
        bridge, sourceTrack: source, outputTrack: outputVideo,
        createVideoElement: deps.createVideoElement, Stream,
      });
    }
    draw();
    const outputStream = new Stream([outputVideo, ...(sound ? [sound] : [])]);
    let chunks = [], bytes = 0, failure, encoderFailure, finished;
    const state = { stopped: false, failed: false, reason: '' };
    let settleStop, rejectStop;
    const stopped = new Promise((resolve, reject) => { settleStop = resolve; rejectStop = reject; });
    stopped.catch(() => {});
    const fail = error => {
      failure ||= error;
      state.failed = true; state.reason = failure.message;
      rejectStop(failure);
      finish().catch(() => {});
    };
    function attachRecorder() {
      recorder.onstop = settleStop;
      recorder.onerror = () => {
        encoderFailure ||= new Error('视频编码中断，录制可能不完整');
        finish().catch(() => {});
      };
      recorder.ondataavailable = ({ data }) => {
        if (!data?.size || failure) return;
        if (bytes + data.size > sizeLimit) { chunks = []; fail(new Error('录像超过体积上限，未保存')); return; }
        chunks.push(data); bytes += data.size;
      };
    }
    function finish() {
      if (finished) return finished;
      state.stopped = true;
      clearTimeout(stopTimer); clearInterval(drawTimer);
      finished = Promise.resolve().then(async () => {
        try {
          if (recorder.state !== 'inactive') recorder.stop();
          timeout = setTimeout(() => rejectStop(new Error('录像收尾超时，未保存')), 3500);
          await stopped;
          if (failure) throw failure;
        } finally { release(); }
        const data = new Uint8Array(await new Blob(chunks).arrayBuffer()); chunks = [];
        const mimeType = recorder.mimeType || (container.extension === 'webm' ? container.mimeType : '');
        try { validateOutput({ bytes: data, mimeType, extension: container.extension, hasAudio: Boolean(sound) }); }
        catch (error) { throw encoderFailure || error; }
        const saved = await bridge.result({ bytes: data, mimeType, extension: container.extension, ...(encoderFailure ? { encoderInterrupted: true } : {}) });
        return { saved, mimeType, extension: container.extension, ...(encoderFailure ? { warning: encoderFailure.message } : {}) };
      }).catch(async error => { await report('failed', error.message); throw error; });
      return finished;
    }
    for (const [t, description] of [[source, '屏幕采集'], [computer, '电脑声音'], [microphone, '麦克风']]) {
      t?.addEventListener?.('ended', () => fail(new Error(`${description}被系统收回`)), { once: true });
    }
    try {
      recorder = new Recorder(outputStream, { mimeType: container.mimeType, videoBitsPerSecond: 6_000_000 });
      attachRecorder();
      recorder.start(deps.timeslice || 250);
    } catch (error) {
      if (container.container !== 'mp4' || (recorder && recorder.state !== 'inactive') || chunks.length || finished) throw error;
      container = chooseContainer({ isTypeSupported: supported, hasAudio: Boolean(sound), allowMp4: false });
      recorder = new Recorder(outputStream, { mimeType: container.mimeType, videoBitsPerSecond: 6_000_000 });
      attachRecorder();
      recorder.start(deps.timeslice || 250);
    }
    drawTimer = setInterval(() => { try { draw(); } catch { fail(new Error('屏幕画面中断')); } }, 67);
    drawTimer.unref?.();
    let remaining = limits.maxDurationMs, segmentStart = Date.now();
    const armDuration = () => {
      segmentStart = Date.now();
      stopTimer = setTimeout(() => finish().catch(() => {}), remaining);
      stopTimer.unref?.();
    };
    armDuration();
    // Pauses do not count toward encoded duration, but may not hold devices indefinitely.
    wallTimer = setTimeout(() => finish().catch(() => {}), limits.maxDurationMs * 2);
    wallTimer.unref?.();
    bridge.onStop?.(() => finish().catch(() => {}));
    bridge.onPause?.(() => {
      if (recorder.state !== 'recording') return;
      try { recorder.pause(); clearTimeout(stopTimer); remaining = Math.max(0, remaining - (Date.now() - segmentStart)); report('paused'); } catch { fail(new Error('暂停失败，录制未保存')); }
    });
    bridge.onResume?.(() => {
      if (recorder.state !== 'paused') return;
      try { recorder.resume(); armDuration(); report('resumed'); } catch { fail(new Error('继续失败，录制未保存')); }
    });
    await report('recording');
    return { finish, state, recorder, container };
  } catch (error) { release(); throw error; }
}

if (typeof document !== 'undefined') {
  let booted = false;
  globalThis.startVideoRecording = config => {
    if (booted) return;
    booted = true;
    runVideoRecording({ config }).catch(error => {
      Promise.resolve().then(() => globalThis.video?.state?.({ state: 'failed', message: error.message })).catch(() => {});
    });
  };
}
