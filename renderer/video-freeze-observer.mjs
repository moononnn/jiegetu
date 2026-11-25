// DEV 观测（默认关）：显式开始录制后的头几秒，统计“源帧交付 / 裁切绘制 / 输出轨道出帧”。
//
// 目的：把“录制开始后首秒冻结”分到两侧——源侧（屏幕采集轨有没有继续出帧）与
// 编码侧（画布轨有没有继续出帧）。只做计数与时间差：
//   - 帧交付用 requestVideoFrameCallback；不支持就不计，不退化到读像素；
//   - 不读像素、不留媒体/缩略图/哈希，只上报固定整数的指标；
//   - 观测窗有界（默认 4 秒），最多上报一次，结束时必然清理探针与定时器。
//
// 这个观测测不到“内容重复”：两帧内容完全一样也算一次正常交付。
// 源侧冻结 → 源帧计数停涨；编码侧冻结 → 源帧计数继续涨而输出帧计数停涨。
export const FREEZE_OBSERVE_WINDOW_MS = 4000;

// 上报用的固定整数指标名。主进程另有一份白名单，只放行这些键、只收有限非负整数。
export const FREEZE_OBSERVE_KEYS = Object.freeze([
  'windowMs', 'elapsedMs', 'sourceFrames', 'sourceGapMs', 'sourceSupported',
  'paintCount', 'paintGapMs', 'outputFrames', 'outputGapMs', 'outputSupported',
]);

const clock = () => (globalThis.performance && typeof globalThis.performance.now === 'function' ? globalThis.performance.now() : Date.now());

function makeCounter() {
  const state = { frames: 0, gapMs: 0, lastMs: 0, supported: false };
  return {
    state,
    hit(nowMs) {
      if (state.lastMs) { const gap = Math.round(nowMs - state.lastMs); if (gap > state.gapMs) state.gapMs = gap; }
      state.lastMs = nowMs; state.frames += 1;
    },
  };
}

// deps.bridge.observe(metrics) —— 上报一次即止。
// deps.sourceTrack / deps.outputTrack —— 被观测的两根视频轨。
// deps.createVideoElement / deps.Stream —— 造离屏探针元素用（测试可替换）。
export function createFreezeObserver({ bridge, sourceTrack, outputTrack, createVideoElement, Stream, windowMs = FREEZE_OBSERVE_WINDOW_MS } = {}) {
  const source = makeCounter(), output = makeCounter(), paint = makeCounter();
  const startedAt = clock();
  let timer = null, emitted = false, stopped = false, windowClosed = false;
  const probes = [];

  const emit = () => {
    if (emitted) return;
    emitted = true;
    const metrics = {
      windowMs: Math.round(windowMs),
      elapsedMs: Math.max(0, Math.round(clock() - startedAt)),
      sourceFrames: source.state.frames, sourceGapMs: source.state.gapMs, sourceSupported: source.state.supported ? 1 : 0,
      paintCount: paint.state.frames, paintGapMs: paint.state.gapMs,
      outputFrames: output.state.frames, outputGapMs: output.state.gapMs, outputSupported: output.state.supported ? 1 : 0,
    };
    try {
      const sent = bridge && typeof bridge.observe === 'function' ? bridge.observe(metrics) : undefined;
      if (sent && typeof sent.catch === 'function') sent.catch(() => {});
    } catch { /* 上报失败不挡录制。 */ }
  };

  const releaseProbe = probe => {
    try { probe.element.cancelVideoFrameCallback?.(probe.handle); } catch { /* 探针清理失败不挡录制。 */ }
    try { probe.element.pause?.(); } catch { /* 同上。 */ }
    try { probe.element.srcObject = null; } catch { /* 同上。 */ }
  };

  const stopProbes = () => {
    for (const probe of probes) releaseProbe(probe);
    probes.length = 0;
  };

  const attach = (track, sink) => {
    if (!track) return false;
    let element = null;
    try { element = typeof createVideoElement === 'function' ? createVideoElement() : (globalThis.document && globalThis.document.createElement ? globalThis.document.createElement('video') : null); }
    catch { return false; }
    if (!element || typeof element.requestVideoFrameCallback !== 'function') return false;
    // 先把探针登记进去：后面任何一步出错，结束时的清理也能把它拆掉（不留轨道引用）。
    let handle = null;
    const probe = { element, get handle() { return handle; } };
    probes.push(probe);
    try {
      element.muted = true;
      element.playsInline = true;
      element.srcObject = new Stream([track]);
      const started = element.play && element.play();
      if (started && typeof started.then === 'function') {
        // 播放失败：这个探针不会出帧，标记为“不支持”并当场拆掉（不留轨道引用）。
        started.then(() => {}, () => {
          sink.state.supported = false;
          const index = probes.indexOf(probe);
          if (index >= 0) probes.splice(index, 1);
          releaseProbe(probe);
        });
      }
    } catch {
      const index = probes.indexOf(probe);
      if (index >= 0) probes.splice(index, 1);
      releaseProbe(probe);
      return false;
    }
    const loop = now => { sink.hit(now); handle = element.requestVideoFrameCallback(loop); };
    try { handle = element.requestVideoFrameCallback(loop); }
    catch {
      const index = probes.indexOf(probe);
      if (index >= 0) probes.splice(index, 1);
      releaseProbe(probe);
      return false;
    }
    sink.state.supported = true;
    return true;
  };

  attach(sourceTrack, source);
  attach(outputTrack, output);

  timer = setTimeout(() => { timer = null; windowClosed = true; stopProbes(); emit(); }, windowMs);
  timer.unref?.();

  return {
    // 每画一帧裁切画面记一次（只记时间，不看内容）。
    paint() { if (!stopped && !windowClosed) paint.hit(clock()); },
    // 结束：拆探针、清定时器，若还没上报则补报一次部分数据。
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      windowClosed = true;
      stopProbes();
      emit();
    },
  };
}
