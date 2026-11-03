'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const EVENTS = new Set(['diagnostic-start', 'diagnostic-end', 'diagnostic-limited', 'commit-start', 'commit-end', 'capture-start', 'snapshot-ready', 'selection-ready',
  'selection-init', 'window-created', 'window-fitted', 'window-loaded',
  'selection-input', 'selection-dismiss', 'wheel', 'scroll-request', 'bar-ready', 'bar-omitted', 'mask-ready', 'capture-toggle', 'worker-call', 'worker-start', 'media-request',
  'media-source-request', 'media-source-granted', 'media-source-rejected', 'config-ready', 'media-ready', 'seed-ready', 'video-ready',
  'window-hidden', 'sampling-start', 'sample', 'worker-finishing', 'worker-recovering', 'png-ready', 'result-received', 'preview-sent', 'preview-dom-ready', 'escape-input',
  'scroll-failure', 'worker-error', 'renderer-error', 'capture-end', 'scroll-cleanup']);
const NUMBERS = new Set(['width', 'height', 'frameWidth', 'frameHeight', 'viewportWidth', 'viewportHeight', 'scaleFactor', 'elapsedMs', 'inflightId', 'pendingMs', 'learnPasses', 'learnDuration', 'repairDuration',
  'videoTime', 'readyState', 'motionAgeMs', 'sampleIndex', 'shift', 'added', 'barRaises', 'capturedHeight', 'capturedAdded', 'capturedChunks', 'unknownTop', 'unknownBottom', 'unknownLeft', 'unknownRight', 'score', 'failures', 'chunks', 'bytes', 'durationMs', 'coverage', 'movingRows', 'movingColumns', 'duplicateFrames', 'captureDurationMs', 'queueAgeMs', 'queueFrames', 'queueBytes', 'queueDropped', 'cachedFrames', 'cachedBytes', 'cacheDropped', 'replayedFrames', 'backgroundRows', 'backgroundPixels', 'backgroundValidPixels', 'backgroundBlockedPixels', 'backgroundEdgeColumns', 'backgroundChunks', 'backgroundInvalidChunks', 'backgroundMovingPixels', 'backgroundMaskPixels', 'backgroundTargetInvalidPixels', 'backgroundSourceInvalidPixels', 'backgroundColorMismatchPixels', 'contentTop', 'contentBottom', 'maskCount', 'missingRanges', 'motionSupport', 'motionCoverage', 'motionEligible', 'motionGood', 'motionRows', 'motionColumns', 'motionConflicts', 'motionDomainWidth', 'motionDomainColumns', 'motionProofVersion', 'fixedCandidates', 'fixedUnknown', 'fixedEdgeLeft', 'fixedEdgeRight', 'closureShift', 'closureExpected', 'evidenceRevision', 'displayId', 'screenCount']);
const BOOLEANS = new Set(['ready', 'drawing', 'committing', 'inside', 'hasRect', 'hasLongImage', 'hidden', 'focused',
  'paused', 'barProtected', 'protectedBar', 'escapeRegistered', 'cancelRegistered', 'noBar', 'diagnosticEnabled', 'accepted', 'partial', 'ok', 'canceled', 'uncertain', 'userActive', 'fixedTop', 'repeat', 'previewPending', 'foreground', 'pending', 'backgroundActive', 'backgroundEnabled', 'backgroundProcessed', 'autoMode', 'complete', 'fixedAnalysisSkipped', 'recovered', 'seeded', 'motionDomainUsed', 'motionDomainBuild']);
// 预算耗尽等内部阶段只接受固定枚举，不接受任意字符串。
const STAGES = new Set(['learn-components', 'learn-template', 'learn-mask', 'present', 'ring-matches', 'mark-repair', 'repair-copy']);
const VALUES = new Set(['new', 'move', 'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'live', 'ended', 'forward',
  'reverse', 'still', 'fixed', 'ambiguous', 'unmatched', 'invalid', 'learning', 'occluded', 'layout-changed', 'capturing', 'loading', 'selecting', 'saving',
  'scroll-starting', 'scrolling', 'scroll-finishing', 'idle', 'no-growth', 'size-limit', 'media-ended', 'resolution-changed',
  'sample-error', 'completed', 'failed', 'cancelled', 'capture-end', 'manual-stop', 'timeout', 'limit', 'app-quit', 'window-closed', 'no-space', 'unobserved', 'top', 'bottom', 'automatic', 'manual', 'manual-content', 'copy', 'save',
  'match-timeout', 'finish-timeout', 'matcher-start-timeout', 'reply-mismatch', 'analysis-budget', 'desktop']);
const FINAL_EVENTS = new Set(['diagnostic-end', 'diagnostic-limited', 'worker-finishing', 'png-ready', 'result-received',
  'preview-sent', 'preview-dom-ready', 'selection-dismiss', 'scroll-failure', 'worker-error', 'renderer-error', 'capture-end', 'scroll-cleanup', 'commit-start', 'commit-end']);
const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError',
  'AggregateError', 'DOMException', 'NotAllowedError', 'NotFoundError', 'NotReadableError', 'AbortError', 'InvalidStateError',
  'OverconstrainedError', 'SecurityError', 'TimeoutError', 'UnknownError', 'OperationError', 'NetworkError', 'DataError',
  'QuotaExceededError', 'EncodingError', 'OtherError']);
const ERROR_SIGNATURES = [
  ['未能取得鼠标所在屏幕', 'snapshot-unavailable'], ['屏幕快照尺寸不完整', 'snapshot-size-mismatch'],
  ['跨屏范围', 'desktop-size-limit'],
  ['显示器配置发生变化', 'display-changed'], ['选区窗口未能覆盖', 'selection-size-mismatch'],
  ['无效选区', 'selection-invalid'], ['长截图选区至少', 'selection-too-small-or-large'],
  ['长截图已改为自动识别，不再接收手动正文范围', 'manual-content-rejected'],
  ['屏幕流准备超时', 'startup-timeout'], ['无效长截图请求', 'config-invalid'], ['配置已失效', 'config-invalid'],
  ['长截图已失效', 'scroll-stale'], ['长截图没有开始', 'scroll-not-started'], ['长截图仍在进行', 'scroll-already-active'],
  ['屏幕流没有送来有效画面', 'video-no-frame'], ['屏幕流尺寸不匹配', 'video-size-mismatch'],
  ['首帧尺寸不一致', 'seed-size-mismatch'], ['长图尺寸无效', 'result-size-invalid'], ['长图编码无效', 'png-invalid'],
  ['全屏长截图快捷键未能注册', 'scroll-shortcut-unavailable'],
  ['长截图浮条排除不可用', 'bar-protection-unavailable'], ['长截图浮条排除状态或位置异常', 'bar-protection-invalid'],
  ['长截图浮条排除已失效', 'bar-protection-lost'], ['长截图浮条已隐藏', 'bar-hidden'],
  ['自动识别选区过大或缓存不足', 'auto-cache-limit'],
  ['图片匹配进程启动超时', 'matcher-start-timeout'], ['图片匹配超时', 'match-timeout'],
  ['长图计算收尾超时', 'finish-timeout'], ['图片匹配回包不对应当前任务', 'reply-mismatch'],
  ['遮挡分析超出预算', 'analysis-budget'],
  ['长截图已取消', 'cancelled'], ['长截图浮条异常', 'bar-renderer-gone'],
  ['采集范围提示未就绪', 'region-mask-not-ready'], ['采集范围提示准备超时', 'region-mask-timeout'], ['采集范围提示窗口尺寸不符', 'region-mask-size-mismatch'], ['采集范围提示异常', 'region-mask-gone'], ['采集范围提示未显示', 'region-mask-not-visible'], ['采集范围提示已隐藏', 'region-mask-hidden']
];
const ERROR_CODES = new Set(['unclassified', 'selection-init', 'image-decode', 'selection-ready', 'selection-viewport', 'selection-viewport-stale', 'selection-renderer-gone', 'desktop-window-mismatch', 'preview-decode', 'preview-layout',
  ...ERROR_SIGNATURES.map(([, code]) => code)]);
const IO_CODES = new Set(['EACCES', 'EPERM', 'ENOSPC', 'ENOENT', 'EIO', 'EROFS', 'EMFILE', 'ENFILE', 'EFBIG']);
// 异常消息仅用于匹配固定类别，绝不把任何原始片段写进报告。
function classifyError(message) {
  return ERROR_SIGNATURES.find(([signature]) => message.slice(0, 2048).includes(signature))?.[1] || 'unclassified';
}
function sanitize(fields) {
  const result = {};
  if (!fields || typeof fields !== 'object') return result;
  for (const [key, value] of Object.entries(fields)) {
    if (NUMBERS.has(key) && typeof value === 'number' && Number.isFinite(value)) result[key] = Math.round(value * 1000) / 1000;
    else if (BOOLEANS.has(key) && typeof value === 'boolean') result[key] = value;
    else if (['kind', 'phase', 'reason', 'trackState', 'mode', 'action', 'remoteVisibility', 'edge'].includes(key) && VALUES.has(value)) result[key] = value;
    else if (key === 'analysisStage' && ['candidate', 'pixel-proof', 'collecting', 'closure', 'initial-proof', 'fixed-analysis', 'composition', 'ready', 'identical', 'paused'].includes(value)) result[key] = value;
    else if (key === 'dismissSource' && ['retake', 'context-menu', 'pointer-cancel', 'tiny-selection', 'escape-key', 'window-close', 'renderer-cancel', 'control-cancel'].includes(value)) result[key] = value;
    else if (key === 'motionMethod' && ['rows', 'features'].includes(value)) result[key] = value;
    else if (key === 'fixedStopReason' && ['large-region', 'dense-regions', 'mask-budget'].includes(value)) result[key] = value;
    else if (key === 'stage' && STAGES.has(value)) result[key] = value;
    else if (['version', 'electron', 'chrome'].includes(key) && typeof value === 'string' && /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(value)) result[key] = value;
    else if (key === 'platform' && ['win32', 'linux', 'darwin'].includes(value)) result[key] = value;
    else if (key === 'errorName' && typeof value === 'string') result[key] = ERROR_NAMES.has(value) ? value : 'OtherError';
    else if (key === 'errorCode' && ERROR_CODES.has(value)) result[key] = value;
    else if (key === 'errorMessage' && typeof value === 'string' && !result.errorCode) result.errorCode = classifyError(value);
  }
  return result;
}
function createDiagnostics({ directory, onChange = () => {}, durationMs = 90000, maxEvents = 2000,
  maxAutomaticReports = 20, environment = {} }) {
  let active, lastFile, lastError = '', nextSlot = 0;
  const slots = Math.max(1, Math.min(100, Math.floor(maxAutomaticReports) || 20));
  let pending = Promise.resolve(), queued = 0;
  try {
    const files = fs.readdirSync(directory).filter(name => /^longshot-[\dTZ-]+-[a-f0-9]{8}\.jsonl$/.test(name) || /^auto-longshot-\d{2}\.jsonl$/.test(name))
      .map(name => ({ name, modified: fs.statSync(path.join(directory, name)).mtimeMs })).sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name));
    if (files.length) lastFile = path.join(directory, files.at(-1).name);
    const latestAuto = files.filter(file => /^auto-longshot-/.test(file.name)).at(-1);
    if (latestAuto) nextSlot = (Number(latestAuto.name.match(/(\d{2})\.jsonl$/)[1]) + 1) % slots;
  } catch { /* 首次使用无需已有目录。 */ }
  const state = () => ({ recording: Boolean(active), automaticRecording: Boolean(active?.automatic), limited: Boolean(active?.limited),
    hasReport: Boolean(lastFile), writing: queued > 0, error: lastError });
  function changed() { try { onChange(state()); } catch { /* UI 状态失败不影响捕获。 */ } }
  function enqueue(current, operation) {
    queued++;
    pending = pending.then(async () => {
      try { if (!current.failed) await operation(); }
      catch (error) {
        current.failed = true; clearTimeout(current.timer);
        if (active === current) active = undefined;
        if (lastFile === current.file) lastError = `诊断写入失败（${IO_CODES.has(error.code) ? error.code : 'UNKNOWN'}）`;
        changed();
      } finally { queued--; if (!active && queued === 0) changed(); }
    });
  }
  function limit(current, reason) {
    if (active !== current || current.limited) return;
    current.limited = true;
    clearTimeout(current.timer);
    record('diagnostic-limited', { reason });
    changed();
  }
  function record(event, fields = {}) {
    if (!active || !EVENTS.has(event)) return false;
    const current = active;
    // 达到采样上限后保留事务，预览/保存/复制/取消的结束证据仍可落盘。
    if (current.automatic && current.limited && !FINAL_EVENTS.has(event)) return true;
    if (current.automatic && current.count >= maxEvents + 32 && !['capture-end', 'diagnostic-end'].includes(event)) return true;
    const line = JSON.stringify({ schema: 1, time: new Date().toISOString(),
      atMs: Date.now() - current.startedAt, event, ...sanitize(fields) }) + '\n';
    enqueue(current, () => fs.promises.appendFile(current.file, line, 'utf8'));
    current.count++;
    if (current.count >= maxEvents && event !== 'diagnostic-end') {
      if (current.automatic) limit(current, 'limit'); else end('limit');
    }
    return true;
  }
  function end(reason = 'completed') {
    if (!active) return lastFile;
    clearTimeout(active.timer);
    record('diagnostic-end', { reason });
    active = undefined; changed();
    return lastFile;
  }
  function start(fields = {}, automatic = false) {
    if (active) throw new Error('诊断正在记录，请先结束当前记录');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, automatic ? `auto-longshot-${String(nextSlot).padStart(2, '0')}.jsonl` :
      `longshot-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.jsonl`);
    if (!automatic) fs.writeFileSync(file, '', { flag: 'wx' });
    const current = { file, startedAt: Date.now(), count: 0, automatic };
    active = current; lastFile = file; lastError = '';
    if (automatic) {
      nextSlot = (nextSlot + 1) % slots;
      // 只轮换新自动记录专用槽；既有手动报告不删不改。清空与追加共用队列防止跨轮串写。
      enqueue(current, () => fs.promises.writeFile(file, '', { flag: 'w' }));
    }
    current.timer = setTimeout(() => { if (active === current) { if (automatic) limit(current, 'timeout'); else end('timeout'); } }, durationMs);
    current.timer.unref?.();
    if (!record('diagnostic-start', { ...environment, ...fields, mode: automatic ? 'automatic' : 'manual', durationMs })) throw new Error(lastError || '诊断未能开始');
    changed(); return state();
  }
  function startAutomatic() {
    if (active) return state();
    try { return start({}, true); }
    catch (error) {
      lastError = `后台记录未开启（${IO_CODES.has(error.code) ? error.code : 'UNKNOWN'}），截图仍可继续`;
      changed(); return state();
    }
  }
  return { start, startAutomatic, record, end, state, getFile: () => lastFile, flush: () => pending };
}
module.exports = { createDiagnostics, sanitize };
