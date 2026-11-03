let running;
const MAX_QUEUE_FRAMES = 24, MAX_QUEUE_AGE = 2500;
// 队列字节预算按实际帧大小自适应：16MiB 兜底，最多 64MiB 或 4 帧；典型 12MB 帧不再只剩 1 帧。
const MIN_QUEUE_BYTES = 16 * 1024 * 1024, MAX_QUEUE_BYTES = 64 * 1024 * 1024, QUEUE_FRAME_BUDGET = 4;
const queueByteCap = frameBytes => Math.min(MAX_QUEUE_BYTES, Math.max(MIN_QUEUE_BYTES, frameBytes * QUEUE_FRAME_BUDGET));
const LEARNING_HINT = '正在确认滚动范围 · 再小幅滚动一下，确认后再完成';
const LEARNING_PENDING = '滚动范围尚未确认，本帧未拼入';
// 异常恢复只交出外置可信副本；正常手动结束仍走原有 no-growth 语义。
const MAX_CHECKPOINT_PIXELS = 16_000_000;
const RECOVERY_NOTE = '计算中断，保留上次结果，后续未拼入；固定遮挡核对未完成，局部可能重复或被遮挡';
// 没有可用长图时只能交首屏原图：不宣称滚动部分或遮挡已确认。
const RECOVERY_SEED_NOTE = '计算中断，仅保留首屏原图，滚动部分未确认';
const RECOVERY_LABELS = { 'match-timeout': '匹配超时', 'finish-timeout': '收尾超时', 'analysis-budget': '分析超出预算', 'reply-mismatch': '回包错位', 'matcher-start-timeout': '启动超时' };
function trace(name, fields = {}) {
  try { window.selection.diagnostic?.(name, fields)?.catch?.(() => {}); } catch { /* 摘要失败不影响采集。 */ }
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function failure(code, message) { const error = new Error(message); error.code = code; return error; }
// 诊断只用固定 10 个扁平数字，三个出口（sample/done/error）共用同一份白名单。
// 不接受 stageTimings 嵌套对象或任意未知字段，缺失就直接不写（不把“没收到数据”补成 0）。
const ANALYSIS_NUMBERS = ['supportCalls', 'supportMs', 'changeDomainCalls', 'changeDomainMs',
  'backgroundObserveCalls', 'backgroundObserveMs', 'backgroundExtendCalls', 'backgroundExtendMs',
  'relocationBudgetGiveUps', 'backgroundExtensionFallbacks'];
function analysisMetrics(packet) {
  const picked = {};
  if (!packet || typeof packet !== 'object') return picked;
  for (const key of ANALYSIS_NUMBERS) {
    const value = packet[key];
    if (Number.isFinite(value) && value >= 0) picked[key] = value;
  }
  return picked;
}
// Worker 只用固定 code/stage 与少量计数表达异常；原始 message 仅供界面显示，诊断端另按白名单归类。
function workerFailure(packet) {
  const error = failure(typeof packet?.code === 'string' ? packet.code : 'failed', packet?.message || '图片匹配进程异常');
  if (typeof packet?.stage === 'string') error.stage = packet.stage;
  for (const key of ['learnPasses', 'learnDuration', 'repairDuration']) if (Number.isFinite(packet?.[key])) error[key] = packet[key];
  Object.assign(error, analysisMetrics(packet));
  return error;
}
// 首屏保底：必须在把 data.buffer 转给 Worker 之前拷一份；超出上限就不留，不冒充有保底。
function boundedCheckpoint(image) {
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height)) return undefined;
  if (image.width < 16 || image.height < 48 || image.width * image.height > MAX_CHECKPOINT_PIXELS) return undefined;
  if (!ArrayBuffer.isView(image.data) || image.data.byteLength !== image.width * image.height * 4) return undefined;
  return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
}
function validCheckpoint(checkpoint, pixels) {
  if (!checkpoint || typeof checkpoint !== 'object' || !pixels) return false;
  const { width, height, data } = checkpoint;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 48) return false;
  if (width !== pixels.width || height < pixels.height || width * height > MAX_CHECKPOINT_PIXELS) return false;
  return ArrayBuffer.isView(data) && data.BYTES_PER_ELEMENT === 1 && data.byteLength === width * height * 4;
}
function canvasPixels(checkpoint) {
  const { width, height, data } = checkpoint;
  if (!ArrayBuffer.isView(data) || data.BYTES_PER_ELEMENT !== 1 || data.byteLength !== width * height * 4) return undefined;
  return new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
}
// 只接受与本次选区尺寸一致、且与回包高度一致的有界快照；不合规就不替换上一份检查点。
// 检查点自带证据版本：已知更新的证据（新增掩码/未知区）到达后，旧快照立即失效。
// 同一帧的 autoEvidence 与检查点版本必须一致；检查点不能比已知失效的版本旧，也不能比本帧证据新。
function rememberCheckpoint(state, checkpoint, update) {
  if (!validCheckpoint(checkpoint, state.config?.pixels)) return;
  if (update && update.height !== checkpoint.height) return;
  const frameRevision = update?.autoEvidence?.evidenceRevision;
  const revision = Number.isInteger(checkpoint.evidenceRevision) ? checkpoint.evidenceRevision
    : Number.isInteger(frameRevision) ? frameRevision : 0;
  if (Number.isInteger(frameRevision) && frameRevision !== revision) return;
  if (revision < (state.evidenceRevision ?? 0)) return;
  state.checkpoint = { width: checkpoint.width, height: checkpoint.height, data: canvasPixels(checkpoint) };
  state.checkpointRevision = revision;
}
// 新增遮挡证据会让之前“已确认”的像素重新可疑；不丢像素，只丢不再可信的快照。
// 只认非负递增版本号（幂等），保留 seed 保底，也不动正在跑的匹配/收尾计时器。
function rememberEvidence(state, revision) {
  if (!Number.isInteger(revision) || revision < 0 || revision <= (state.evidenceRevision ?? 0)) return;
  state.evidenceRevision = revision;
  if (state.checkpoint && revision > (state.checkpointRevision ?? 0)) state.checkpoint = undefined;
}
function stopMedia(state) {
  clearInterval(state.timer);
  state.stream?.getTracks().forEach(track => track.stop());
  if (state.video) state.video.srcObject = null;
}
function abort(state) {
  if (!state) return;
  state.aborted = true; state.finishing = true;
  stopMedia(state); clearTimeout(state.jobTimer); clearTimeout(state.readyTimer);
  state.matcher?.terminate(); state.matcher = undefined; state.matcherReady = false;
  state.queue = []; state.queueBytes = 0; state.inflight = undefined; state.reference = undefined;
  state.preview = undefined; state.viewport = undefined; state.checkpoint = undefined; state.seedCheckpoint = undefined;
  state.rejectReady?.(new Error('长截图已取消')); state.rejectReady = undefined;
  if (running === state) running = undefined;
}
function pendingInfo(state) {
  const job = state.inflight;
  return job && state.startedAt !== undefined ? { inflightId: job.id, pendingMs: performance.now() - state.startedAt - job.atMs } : {};
}
// 匹配/收尾超时与 Worker 异常：先停采样、丢队列、终止计算，再用外置检查点副本（最后一次确认，不是完整性担保）走原有预览出口。
// 尚未收到任何有效匹配回包时沿用安全停止；不把首次计算失败冒充已接长。
function recover(state, error) {
  if (running !== state || state.aborted || state.recovering || !state.config) return false;
  if (state.startedAt === undefined || state.lastProcessedId <= 0) return false;
  const trusted = state.checkpoint && (state.checkpointRevision ?? 0) >= (state.evidenceRevision ?? 0) &&
    validCheckpoint(state.checkpoint, state.config.pixels) ? state.checkpoint : undefined;
  const seed = !trusted && validCheckpoint(state.seedCheckpoint, state.config.pixels) ? state.seedCheckpoint : undefined;
  const checkpoint = trusted ?? seed;
  if (!checkpoint) return false;
  const reason = typeof error.code === 'string' ? error.code : 'failed';
  state.recovering = true; state.finishing = true;
  state.finishAt = performance.now() - state.startedAt; state.finishReason = reason;
  state.recoveryWarning = `${trusted ? RECOVERY_NOTE : RECOVERY_SEED_NOTE}${RECOVERY_LABELS[reason] ? `（${RECOVERY_LABELS[reason]}）` : ''}`;
  stopMedia(state); clearTimeout(state.jobTimer); clearTimeout(state.readyTimer);
  state.matcher?.terminate(); state.matcher = undefined; state.matcherReady = false;
  state.queue = []; state.queueBytes = 0; state.inflight = undefined;
  trace('worker-recovering', { reason, height: checkpoint.height, seeded: !trusted, chunks: state.chunks, capturedHeight: state.capturedHeight, evidenceRevision: state.evidenceRevision });
  encodedResult(state, { width: checkpoint.width, height: checkpoint.height, data: checkpoint.data, complete: false, missingRanges: [], warning: state.recoveryWarning }, true);
  return true;
}
function fail(state, error) {
  // 恢复已接手时忽略重复错误/迟到超时：正在编码的恢复图不能被第二次 abort 打断。
  if (running !== state || state.aborted || state.recovering || state.encoding) return;
  const fields = { errorName: error.name, errorMessage: error.message };
  if (typeof error.code === 'string') fields.errorCode = error.code;
  if (typeof error.stage === 'string') fields.stage = error.stage;
  for (const key of ['learnPasses', 'learnDuration', 'repairDuration']) if (Number.isFinite(error[key])) fields[key] = error[key];
  Object.assign(fields, analysisMetrics(error));
  Object.assign(fields, pendingInfo(state));
  trace('worker-error', fields);
  if (recover(state, error)) return;
  const token = state.config?.token; abort(state);
  if (token) window.selection.scrollError(token, `采集计算中断：${error.message}`, 'sample-error').catch(() => {});
}
function progress(state, force = false) {
  if (running !== state || state.finishing) return;
  const now = performance.now();
  // 60ms 节流：已核实的视口不必等 PNG 编码完成或 250ms 窗口，仍只下发真实匹配位置。
  if (force || state.message !== state.lastMessage || now - state.lastProgress >= 60) {
    state.lastProgress = now; state.lastMessage = state.message;
    window.selection.scrollProgress(state.config.token, { height: state.capturedHeight ?? state.height, message: state.message,
      reference: state.reference, preview: state.preview, viewport: state.viewport }).catch(() => abort(state));
  }
}
async function referencePreview(state, reference) {
  if (!reference || !reference.width || !reference.height) return;
  const version = ++state.referenceVersion;
  try {
    const canvas = new OffscreenCanvas(reference.width, reference.height);
    canvas.getContext('2d').putImageData(new ImageData(reference.data, reference.width, reference.height), 0, 0);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    if (running !== state || state.finishing || version !== state.referenceVersion) return;
    state.reference = { dataUrl: `data:image/png;base64,${btoa(binary)}`, width: reference.width, height: reference.height };
    progress(state, true);
  } catch { /* 参照编码失败不改变可信图片或阻断采集。 */ }
}
async function mapPreview(state, image, sourceHeight) {
  if (!image || !Number.isInteger(image.width) || image.width < 1 || image.width > 240 ||
      !Number.isInteger(image.height) || image.height < 1 || image.height > 480 ||
      !image.data || image.data.length !== image.width * image.height * 4 || !Number.isInteger(sourceHeight) || sourceHeight < 1) return;
  const version = ++state.previewVersion;
  try {
    const canvas = new OffscreenCanvas(image.width, image.height);
    canvas.getContext('2d').putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    if (running !== state || state.finishing || version !== state.previewVersion || sourceHeight !== (state.capturedHeight ?? state.height)) return;
    let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    state.preview = { dataUrl: `data:image/png;base64,${btoa(binary)}`, width: image.width, height: image.height, sourceHeight };
    progress(state, true);
  } catch { /* 缩略图失败不阻断原始像素拼接；不冒充已刷新。 */ }
}
function pruneQueue(state) {
  const age = state.finishing ? state.finishAt : performance.now() - state.startedAt;
  while (state.queue.length && (state.queue.length > MAX_QUEUE_FRAMES || state.queueBytes > state.queueCap || age - state.queue[0].atMs > MAX_QUEUE_AGE)) {
    const dropped = state.queue.shift(); state.queueBytes -= dropped.image.data.byteLength;
    state.queueDropped++; state.lastDroppedId = dropped.id;
  }
}
function dispatch(state, packet) {
  if (running !== state || state.aborted || state.recovering) return;
  state.inflight = { id: packet.id, atMs: packet.atMs, captureDurationMs: packet.captureDurationMs };
  state.jobTimer = setTimeout(() => {
    if (running === state && state.inflight?.id === packet.id) fail(state, failure('match-timeout', '图片匹配超时，未确认部分没有拼入'));
  }, 10000);
  state.matcher.postMessage({ type: 'frame', ...packet }, [packet.image.data.buffer]);
}
function pump(state) {
  if (running !== state || state.aborted || state.recovering || state.inflight || !state.matcherReady) return;
  pruneQueue(state);
  const packet = state.queue.shift();
  if (packet) { state.queueBytes -= packet.image.data.byteLength; dispatch(state, packet); }
  else if (state.finishing && state.readyToFinish && !state.finishSent) {
    state.finishSent = true;
    state.jobTimer = setTimeout(() => { if (running === state) fail(state, failure('finish-timeout', '长图计算收尾超时')); }, 10000);
    state.matcher.postMessage({ type: 'finish' });
  }
}
async function finish(state, warning = '', reason = warning ? 'failed' : 'completed') {
  if (state.finishing || running !== state) return;
  if (!state.matcherReady) {
    const token = state.config?.token;
    abort(state);
    if (token) await window.selection.scrollError(token, warning || '没有新增内容', warning ? reason : 'no-growth').catch(() => {});
    return;
  }
  state.finishing = true; state.finishAt = performance.now() - state.startedAt; state.finishReason = reason; state.extraWarning = warning;
  stopMedia(state);
  try {
    // A native request already made before stop still belongs to this capture; drain it before finishing the matcher.
    if (state.capturePending) await state.capturePending;
    if (running !== state) return;
    if ((state.capturedChunks ?? state.chunks) > 1) await window.selection.scrollFinishing(state.config.token);
    if (running !== state) return;
    state.readyToFinish = true; pump(state);
  } catch (error) { fail(state, error); }
}
async function encodedResult(state, output, recovered = false) {
  // 同一场只能交一次图：重复 done、恢复与迟到回包都不能再编第二张。
  if (state.encoding) return;
  state.encoding = true;
  try {
    const recovery = recovered ? (state.recoveryWarning || RECOVERY_NOTE) : '';
    const partial = recovered ? '' : output.missingRanges?.length ? (state.pendingWarning || '已保留原像素接长，有区域未确认，请检查可能重复或缺失处') :
      state.pendingWarning ? `末段未接上，仅保留已确认连续的内容：${state.pendingWarning}` :
      state.recoveryPending ? '曾有画面未接上，尚未重新接长；仅保留已确认连续的内容' :
      state.lastDroppedId > state.lastProcessedId ? '末段采样未能保留，仅输出已确认连续的内容' : '';
    const warning = recovery || [partial, output.complete === false ? (output.warning || '自动适配仍有未确认区域，已保留原像素，请检查可能重复或缺失处').slice(0,120) : '', (state.extraWarning || '').slice(0, 120)].filter(Boolean).join('；');
    trace('worker-finishing', { reason: state.finishReason, height: state.height, chunks: state.chunks, capturedHeight: state.capturedHeight, capturedChunks: state.capturedChunks, duplicateFrames: state.duplicateFrames, queueDropped: state.queueDropped, recovered: Boolean(recovered),
      autoMode: output.complete !== undefined, complete: output.complete, missingRanges: output.missingRanges?.length ?? 0,
      backgroundActive: Number(output.background?.pixels) > 0, backgroundRows: output.background?.rows ?? 0, backgroundPixels: output.background?.pixels ?? 0,
      backgroundEnabled: Boolean(output.backgroundEvidence?.enabled), backgroundValidPixels: output.backgroundEvidence?.validPixels ?? 0,
      backgroundBlockedPixels: output.backgroundEvidence?.blockedPixels ?? 0, backgroundEdgeColumns: output.backgroundEvidence?.edgeColumns ?? 0,
      // 只把重铺的纯计数与“是否到过像素阶段”摊平输出；不出图像、颜色、坐标。
      backgroundProcessed: Boolean(output.backgroundEvidence?.extend?.processed), backgroundChunks: output.backgroundEvidence?.extend?.chunks ?? 0,
      backgroundInvalidChunks: output.backgroundEvidence?.extend?.invalidChunks ?? 0, backgroundMovingPixels: output.backgroundEvidence?.extend?.movingPixels ?? 0,
      backgroundMaskPixels: output.backgroundEvidence?.extend?.maskPixels ?? 0, backgroundTargetInvalidPixels: output.backgroundEvidence?.extend?.targetInvalidPixels ?? 0,
      backgroundSourceInvalidPixels: output.backgroundEvidence?.extend?.sourceInvalidPixels ?? 0, backgroundColorMismatchPixels: output.backgroundEvidence?.extend?.colorMismatchPixels ?? 0,
      ...state.analysisMetrics });
    if (!recovered && output.height <= state.config.pixels.height) {
      // 中断类停止沿用原原因与具体说明；只有用户主动结束且首屏范围未确认时，才如实说“本次仅保留首屏”。
      const stopped = !['manual-stop', 'completed'].includes(state.finishReason);
      const reason = stopped ? state.finishReason : 'no-growth';
      const coreMessage = typeof output.warning === 'string' ? output.warning.slice(0, 240) : '';
      const detail = state.pendingWarning && state.pendingWarning !== LEARNING_PENDING ? state.pendingWarning : '';
      const unconfirmed = [coreMessage || '首屏滚动范围尚未确认，本次仅保留首屏，没有拼入新增内容', detail, state.extraWarning,
        /小幅滚动/.test(coreMessage) ? '' : '再小幅滚动一下，确认后再完成'].filter(Boolean).join('；');
      await window.selection.scrollError(state.config.token, stopped || state.layoutEstablished ? warning || '没有新增内容' : unconfirmed, reason); return;
    }
    const canvas = new OffscreenCanvas(output.width, output.height);
    canvas.getContext('2d').putImageData(new ImageData(output.data, output.width, output.height), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    if (running !== state || state.aborted) return;
    trace('png-ready', { width: output.width, height: output.height, bytes: blob.size });
    const buffer = await blob.arrayBuffer();
    if (running !== state || state.aborted) return;
    // 只有异常恢复才带第四参；主进程仅在 recovered===true 且 warning 非空时放行首屏高度。
    if (recovered) await window.selection.scrollResult(state.config.token, buffer, warning, true);
    else await window.selection.scrollResult(state.config.token, buffer, warning);
  } catch (error) {
    trace('worker-error', { errorName: error.name, errorMessage: error.message });
    if (running === state && !state.aborted) await window.selection.scrollError(state.config.token, error.message).catch(() => {});
  } finally { state.checkpoint = undefined; state.seedCheckpoint = undefined; if (running === state) abort(state); else state.matcher = undefined; }
}
function matched(state, update) {
  const job = state.inflight;
  if (!job || job.id !== update.id) throw failure('reply-mismatch', '图片匹配回包不对应当前任务');
  clearTimeout(state.jobTimer); state.inflight = undefined; state.lastProcessedId = update.id;
  // 先吸收本帧的证据版本（新增掩码/未知区会让旧快照失效），再收本帧可能带来的新快照。
  if (Number.isInteger(update.autoEvidence?.evidenceRevision)) rememberEvidence(state, update.autoEvidence.evidenceRevision);
  if (update.checkpoint !== undefined) rememberCheckpoint(state, update.checkpoint, update);
  // 本会话的诊断数字只从当前帧回包重新取，不跨会话缓存；done 包到达时会再覆盖成收尾快照。
  state.analysisMetrics = analysisMetrics(update);
  const result = update.result, now = performance.now(), wasUnmatched = Boolean(state.pendingWarning);
  trace('sample', { sampleIndex: ++state.sampleIndex, kind: result.kind, shift: result.shift, added: update.added, capturedHeight: update.capturedHeight, capturedAdded: update.capturedAdded, score: result.error,
    duplicateFrames: state.duplicateFrames, height: state.height, failures: state.failures, chunks: state.chunks, capturedChunks: update.capturedChunks,
    elapsedMs: now - state.startedAt, motionAgeMs: now - state.lastMotion, uncertain: result.uncertain,
    edge: result.edge === '顶部' ? 'top' : result.edge === '底部' ? 'bottom' : undefined, fixedTop: result.fixedTop,
    foreground: result.foreground, pending: result.pending, coverage: result.coverage, movingRows: result.movingRows, movingColumns: result.movingColumns,
    autoMode: Boolean(result.auto), contentTop: result.content?.top, contentBottom: result.content?.bottom, maskCount: update.autoEvidence?.maskCount,
    analysisStage: update.autoEvidence?.analysisStage, motionMethod: update.autoEvidence?.motionMethod, evidenceRevision: update.autoEvidence?.evidenceRevision,
    motionSupport: update.autoEvidence?.motionSupport, motionCoverage: update.autoEvidence?.motionCoverage,
    motionEligible: update.autoEvidence?.motionEligible, motionGood: update.autoEvidence?.motionGood, motionRows: update.autoEvidence?.motionRows,
    motionColumns: update.autoEvidence?.motionColumns, motionConflicts: update.autoEvidence?.motionConflicts,
  motionDomainWidth: update.autoEvidence?.motionDomainWidth, motionDomainColumns: update.autoEvidence?.motionDomainColumns,
  motionDomainUsed: update.autoEvidence?.motionDomainUsed, motionDomainBuild: update.autoEvidence?.motionDomainBuild, motionProofVersion: update.autoEvidence?.motionProofVersion,
    closureShift: update.autoEvidence?.closureShift, closureExpected: update.autoEvidence?.closureExpected,
    fixedCandidates: update.autoEvidence?.fixedCandidates, fixedUnknown: update.autoEvidence?.fixedUnknown, fixedAnalysisSkipped: update.autoEvidence?.fixedAnalysisSkipped,
    unknownTop: update.autoEvidence?.unknownTop, unknownBottom: update.autoEvidence?.unknownBottom, unknownLeft: update.autoEvidence?.unknownLeft, unknownRight: update.autoEvidence?.unknownRight,
    fixedEdgeLeft: update.autoEvidence?.fixedEdgeLeft, fixedEdgeRight: update.autoEvidence?.fixedEdgeRight, fixedStopReason: update.autoEvidence?.fixedStopReason,
    durationMs: update.durationMs, captureDurationMs: job.captureDurationMs, queueAgeMs: now - state.startedAt - job.atMs,
    queueFrames: state.queue.length, queueBytes: state.queueBytes, queueDropped: state.queueDropped,
    cachedFrames: update.pendingFrames, cachedBytes: update.pendingBytes, cacheDropped: update.droppedFrames, replayedFrames: update.recoveredFrames,
    videoTime: state.video?.currentTime, readyState: state.video?.readyState, trackState: state.stream?.getVideoTracks?.()[0]?.readyState, ...state.analysisMetrics });
  state.height = update.height; state.chunks = update.chunks;
  state.capturedHeight = update.capturedHeight; state.capturedChunks = update.capturedChunks;
  state.viewport = update.viewport;
  if (update.preview) mapPreview(state, update.preview, update.capturedHeight ?? update.height);
  // 浮条已有完整长图预览时不再每帧编码一张无用的底部参照图；旧 legacy 无 preview 时仍靠它。
  if (update.reference && !state.preview) referencePreview(state, update.reference);
  if ((update.capturedAdded ?? update.added) > 0) state.lastMotion = now;
  if (result.content) state.layoutEstablished = true;
  if (result.kind === 'learning') {
    state.failures = 0; state.pendingWarning = LEARNING_PENDING;
    state.message = LEARNING_HINT;
  } else if (result.kind === 'occluded') {
    state.recoveryPending = true; state.pendingWarning = '已保留原像素接长，有区域未确认，可能重复或缺失';
    state.message = '正在接长 · 有区域未确认，原像素保留，完成后请检查';
  } else if (result.kind === 'forward') {
    state.failures = 0; state.pendingWarning = '';
    if (state.recoveryPending || update.recoveredFrames) state.recoveredUntil = now + 1500;
    state.recoveryPending = false;
    state.message = now < state.recoveredUntil ? '已恢复拼接 · 可以继续上下滚动' : '已对齐 · 上下滚动继续接长';
  } else if (result.kind === 'reverse') {
    state.failures = 0; state.pendingWarning = ''; state.recoveredUntil = 0;
    state.message = (update.capturedAdded ?? update.added) > 0 ? '已向上接长 · 上下滚动继续接长' : '正在回看 · 已截内容保留，越过两端继续接长';
  } else if (result.kind === 'layout-changed') {
    // 自动识别暂停：只说明当前保留了什么，不再提示手动重标或重新划范围。
    state.recoveryPending = true; state.failures++;
    state.pendingWarning = result.message || '固定区域或页面布局发生变化，后续未拼入';
    state.message = '已暂停 · 固定区域暂时分不清，点完成仅保留已确认部分 · 回到浮条所示内容附近，等布局稳定后继续';
  } else if (result.kind === 'fixed') {
    state.recoveryPending = true; state.failures++;
    state.pendingWarning = result.pending ? '正在核对固定背景与消息位移，本帧暂未拼入' : result.foreground ? '仍有固定结构无法排除，本帧未拼入' : result.uncertain ? '底部留白或固定内容无法可靠判断，本帧未拼入' : `疑似${result.edge}固定内容，本帧未拼入`;
    state.recoveredUntil = 0;
    state.message = result.pending && state.failures < 3 ? '暂未接上 · 正在核对固定背景，缓慢滚动一小步' : '未接上 · 对照浮条里的内容，往回滚到这段附近再继续';
  } else if (result.kind === 'still') {
    state.failures = 0; state.pendingWarning = '';
    state.message = wasUnmatched ? '已回到接上的位置 · 可以继续上下滚动' : now < state.recoveredUntil ? '已恢复拼接 · 可以继续滚动或点完成' : '已对齐 · 上下滚动继续接长';
  } else {
    // 区分“证据还不够”与“已建布局后核验失配”：前者不该被说成重复内容，后者是运动/重排未通过。
    const stage = update.autoEvidence?.analysisStage, building = !result.content;
    const insufficient = ['collecting', 'closure', 'initial-proof'].includes(stage) || (stage === 'pixel-proof' && building);
    if (insufficient) {
      state.failures = 0; state.recoveryPending = false;
      state.pendingWarning = LEARNING_PENDING;
      state.message = stage === 'collecting' ? LEARNING_HINT : '正在确认首屏与当前画面的对应 · 再小幅滚动一下，确认后再完成';
    } else {
      state.recoveryPending = true; state.failures++; state.recoveredUntil = 0;
      if (result.kind === 'ambiguous' && stage === 'pixel-proof') {
        state.pendingWarning = '画面有未确认的运动或重排，本帧未拼入';
        state.message = '未接上 · 画面有未确认的运动或重排，放慢一点再小幅滚动，或点完成保留已接部分';
      } else {
        state.pendingWarning = result.kind === 'ambiguous' ? '重复内容暂时无法可靠对齐，当前帧未拼入' : '重叠不足或画面变化较大，当前帧未拼入';
        state.message = '未接上 · 对照浮条里的内容，往回滚到这段附近再继续，或点完成保留已接部分';
      }
    }
  }
  if (update.added > 0 && result.kind !== 'forward') state.message = `已补接部分 · ${state.message}`;
  if (update.limit) finish(state, '已达到本次长图尺寸上限', 'size-limit');
  progress(state); pump(state);
}
function startMatcher(state, image) {
  return new Promise((resolve, reject) => {
    state.rejectReady = reject;
    state.matcher = new Worker('./scroll-match-worker.mjs', { type: 'module' });
    state.matcher.onerror = event => { event.preventDefault?.(); fail(state, new Error(event.message || '图片匹配进程异常')); };
    state.matcher.onmessage = ({ data: packet }) => {
      if (running !== state || state.aborted || state.recovering || state.encoding) return;
      try {
        if (packet.type === 'ready') {
          clearTimeout(state.readyTimer); state.rejectReady = undefined; state.matcherReady = true;
          state.height = packet.height; state.chunks = packet.chunks;
          state.capturedHeight = packet.capturedHeight; state.capturedChunks = packet.capturedChunks;
          state.viewport = packet.viewport;
          if (packet.preview) mapPreview(state, packet.preview, packet.capturedHeight ?? packet.height);
          referencePreview(state, packet.reference); resolve();
        } else if (packet.type === 'sample') matched(state, packet);
        else if (packet.type === 'evidence-invalidated') rememberEvidence(state, packet.revision);
        else if (packet.type === 'done') { clearTimeout(state.jobTimer); state.analysisMetrics = analysisMetrics(packet); encodedResult(state, packet.output); }
        else if (packet.type === 'error') fail(state, workerFailure(packet));
      } catch (error) { fail(state, error); }
    };
    state.readyTimer = setTimeout(() => { if (running === state && !state.matcherReady) fail(state, failure('matcher-start-timeout', '图片匹配进程启动超时')); }, 10000);
    state.matcher.postMessage({ type: 'init', image }, [image.data.buffer]);
  });
}
function nativeImage(state, frame) {
  const { width, height } = state.config.pixels;
  if (frame?.fresh !== true || frame.width !== width || frame.height !== height || !ArrayBuffer.isView(frame.data) ||
      frame.data.BYTES_PER_ELEMENT !== 1 || frame.data.byteLength !== width * height * 4) throw new Error('原生画面尺寸或像素不匹配，未缩放拼接');
  return { width, height, data: new Uint8ClampedArray(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength) };
}
async function captureNativePacket(state) {
  const started = performance.now();
  try {
    const frame = await window.selection.nativeFrame(state.config.token);
    if (running !== state || state.aborted) return;
    if (frame?.fresh === false) { state.duplicateFrames++; progress(state); return; }
    const image = nativeImage(state, frame), id = ++state.captureIndex, atMs = started - state.startedAt, bytes = image.data.byteLength;
    const packet = { id, atMs, image, captureDurationMs: performance.now() - started };
    if (bytes > state.queueCap) dispatch(state, packet);
    else { state.queue.push(packet); state.queueBytes += bytes; pruneQueue(state); pump(state); }
  } catch (error) {
    if (running !== state || state.aborted) return;
    trace('worker-error', { errorName: error.name, errorMessage: error.message });
    if (state.finishing) state.extraWarning = [state.extraWarning, `末帧采集未完成：${error.message}`].filter(Boolean).join('；');
    else finish(state, `采样中断：${error.message}`, 'sample-error');
  }
}
function sampleNative(state) {
  if (state.finishing || state.recovering || running !== state || state.capturePending) return;
  if (state.config.pixels.width * state.config.pixels.height * 4 > state.queueCap && state.inflight) {
    state.queueDropped++; state.lastDroppedId = ++state.captureIndex; return;
  }
  const task = captureNativePacket(state); state.capturePending = task;
  task.then(() => { if (state.capturePending === task) state.capturePending = undefined; });
}
function sample(state) {
  if (state.finishing || state.recovering || running !== state) return;
  try {
    const started = performance.now(), { pixels, frame } = state.config;
    if (state.video.videoWidth !== frame.width || state.video.videoHeight !== frame.height) return void finish(state, '显示器分辨率发生变化，后续内容没有拼入', 'resolution-changed');
    const videoTime = state.video.currentTime;
    if (Number.isFinite(videoTime)) {
      if (videoTime === state.lastVideoTime) { state.duplicateFrames++; return; }
      state.lastVideoTime = videoTime;
    }
    const id = ++state.captureIndex, atMs = started - state.startedAt, bytes = pixels.width * pixels.height * 4;
    if (bytes > state.queueCap && state.inflight) { state.queueDropped++; state.lastDroppedId = id; return; }
    state.context.drawImage(state.video, pixels.x, pixels.y, pixels.width, pixels.height, 0, 0, pixels.width, pixels.height);
    const data = state.context.getImageData(0, 0, pixels.width, pixels.height).data;
    const packet = { id, atMs, image: { data, width: pixels.width, height: pixels.height }, captureDurationMs: performance.now() - started };
    if (bytes > state.queueCap) dispatch(state, packet);
    else { state.queue.push(packet); state.queueBytes += bytes; pruneQueue(state); pump(state); }
  } catch (error) {
    trace('worker-error', { errorName: error.name, errorMessage: error.message });
    finish(state, `采样中断：${error.message}`, 'sample-error');
  }
}
window.startScrollCapture = async () => {
  if (running) throw new Error('长截图仍在进行');
  const state = { queue: [], queueBytes: 0, queueDropped: 0, captureIndex: 0, lastDroppedId: 0, lastProcessedId: 0,
    chunks: 1, failures: 0, lastProgress: 0, sampleIndex: 0, duplicateFrames: 0, recoveredUntil: 0, recoveryPending: false, queueCap: MIN_QUEUE_BYTES,
    recovering: false, encoding: false, checkpoint: undefined, seedCheckpoint: undefined, evidenceRevision: 0, checkpointRevision: 0,
    layoutEstablished: false, referenceVersion: 0, previewVersion: 0, message: '已对齐 · 上下滚动继续接长', analysisMetrics: {} };
  running = state;
  let streamPromise;
  try {
    trace('worker-start');
    const useNative = window.selection.captureMode === 'windows-native';
    if (!useNative) {
      trace('media-request', { userActive: navigator.userActivation?.isActive });
      // 非 Windows 路径仍在第一个 await 之前请求媒体，保留瞬时手势。
      streamPromise = navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false });
      streamPromise.catch(() => {});
    }
    const config = await window.selection.scrollConfig(); state.config = config; state.height = config.pixels.height;
    state.queueCap = queueByteCap(config.pixels.width * config.pixels.height * 4);
    if (state.pendingAborts?.has(config.token)) abort(state);
    state.pendingAborts = undefined;
    // 手动正文范围已从生产入口撤除；旧主进程若仍下发 content，明确拒绝而不是静默忽略。
    if (config.content !== undefined) throw new Error('长截图已改为自动识别，不再接收手动正文范围');
    state.message = LEARNING_HINT;
    if (running !== state) throw new Error('长截图已取消');
    trace('config-ready', { width: config.pixels.width, height: config.pixels.height, frameWidth: config.frame.width, frameHeight: config.frame.height });
    if (useNative) {
      if (await window.selection.scrollReady(config.token) !== true) throw new Error('采集范围提示未显示');
      if (running !== state) throw new Error('长截图已取消');
      await wait(150); if (running !== state) throw new Error('长截图已取消');
      // Helper/session is first created after the selection hides. Seed and samples use exactly the same cursor-excluded source.
      const frame = await window.selection.nativeFrame(config.token);
      if (running !== state) throw new Error('长截图已取消');
      const image = nativeImage(state, frame);
      trace('seed-ready', { width: image.width, height: image.height });
      state.seedCheckpoint = boundedCheckpoint(image);
      await startMatcher(state, image);
      if (running !== state) throw new Error('长截图已取消');
      state.startedAt = state.lastMotion = performance.now();
      trace('sampling-start', { width: config.pixels.width, height: config.pixels.height, frameWidth: config.frame.width, frameHeight: config.frame.height });
      state.timer = setInterval(() => sampleNative(state), 50); progress(state, true);
      return true;
    }
    state.stream = await streamPromise; trace('media-ready', { trackState: state.stream.getVideoTracks()[0]?.readyState });
    if (running !== state) { stopMedia(state); throw new Error('长截图已取消'); }
    const canvas = new OffscreenCanvas(config.pixels.width, config.pixels.height);
    state.context = canvas.getContext('2d', { willReadFrequently: true });
    state.video = document.createElement('video'); state.video.muted = true; state.video.playsInline = true; state.video.srcObject = state.stream;
    await state.video.play();
    const deadline = performance.now() + 10000;
    while (!state.video.videoWidth || state.video.readyState < 2) {
      if (running !== state || performance.now() > deadline) throw new Error('屏幕流没有送来有效画面');
      await wait(100);
    }
    if (state.video.videoWidth !== config.frame.width || state.video.videoHeight !== config.frame.height) throw new Error('屏幕流尺寸不匹配，未缩放拼接');
    trace('video-ready', { width: state.video.videoWidth, height: state.video.videoHeight, readyState: state.video.readyState });
    state.stream.getVideoTracks()[0].addEventListener('ended', () => {
      if (state.finishing) return;
      finish(state, '屏幕流已中断', 'media-ended');
    });
    if (await window.selection.scrollReady(config.token) !== true) throw new Error('采集范围提示未显示');
    if (running !== state) throw new Error('长截图已取消');
    await wait(150); if (running !== state) throw new Error('长截图已取消');
    // 等解码新帧，不以“内容必须变化”作为启动条件；静止页面的新帧也有效。
    const afterHideTime = state.video.currentTime, freshDeadline = performance.now() + 10000;
    let fresh = false, frameCallback;
    if (typeof state.video.requestVideoFrameCallback === 'function') {
      frameCallback = state.video.requestVideoFrameCallback(() => { fresh = true; });
    }
    try {
      while (!fresh && !(frameCallback === undefined && Number.isFinite(afterHideTime) && state.video.currentTime > afterHideTime)) {
        if (running !== state) throw new Error('长截图已取消');
        if (performance.now() > freshDeadline) throw new Error('选区隐藏后没有收到更新的屏幕帧，请重新框选');
        await wait(50);
      }
    } finally {
      if (frameCallback !== undefined) state.video.cancelVideoFrameCallback?.(frameCallback);
    }
    if (running !== state) throw new Error('长截图已取消');
    // 框选底图仅用于框选；长图首帧和后续帧必须来自同一实时流，且在选区页隐藏后取。
    const { pixels } = config;
    if (state.video.videoWidth !== config.frame.width || state.video.videoHeight !== config.frame.height) throw new Error('屏幕流尺寸不匹配，未缩放拼接');
    state.context.drawImage(state.video, pixels.x, pixels.y, pixels.width, pixels.height, 0, 0, pixels.width, pixels.height);
    const image = { data: state.context.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height };
    trace('seed-ready', { width: image.width, height: image.height });
    state.seedCheckpoint = boundedCheckpoint(image);
    await startMatcher(state, image);
    if (running !== state) throw new Error('长截图已取消');
    state.lastVideoTime = state.video.currentTime;
    state.startedAt = state.lastMotion = performance.now();
    trace('sampling-start', { width: config.pixels.width, height: config.pixels.height, frameWidth: config.frame.width, frameHeight: config.frame.height });
    state.timer = setInterval(() => sample(state), 50); progress(state, true);
    return true;
  } catch (error) {
    const report = running === state;
    if (report) trace('worker-error', { errorName: error.name, errorMessage: error.message });
    abort(state);
    streamPromise?.then(stream => stream.getTracks().forEach(track => track.stop())).catch(() => {});
    if (report && state.config) await window.selection.scrollError(state.config.token, error.message).catch(() => {});
    throw error;
  }
};
window.selection.onScrollStop(token => { if (running?.config?.token === token) finish(running, '', 'manual-stop'); });
window.selection.onScrollAbort(token => {
  if (!running || typeof token !== 'string') return;
  if (running.config) { if (running.config.token === token) abort(running); }
  // 配置未回时先记token，拿到本轮身份再核对，旧会话迟到取消不能杀掉新启动。
  else (running.pendingAborts ??= new Set()).add(token);
});
