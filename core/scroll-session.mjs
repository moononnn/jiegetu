import { fingerprint, detectShift, newRows, topRows, compose, MAX_HEIGHT, MAX_PIXELS } from './scroll.mjs';
import { createBackgroundModel, observeBackground, extendBackground, backgroundSummary } from './background-model.mjs';
import { renderPreview } from './scroll-preview.mjs';
const DEFAULTS = { maxFrames: 24, maxBytes: 16_777_216, maxAgeMs: 2500 };
// 固定背景额外保留历史模型、外侧带不可变首观察与上一帧，每次确认拼接都要扫整帧。
// 仍限制在100万像素以内；匹配门与采集队列不放宽，避免超大选区耗时和内存失控。
const BACKGROUND_PIXEL_LIMIT = 1_000_000;

function makeReference(image) {
  const sourceHeight = Math.min(Math.max(320, Math.ceil(image.width / 3)), image.height);
  const scale = Math.min(1, 960 / image.width, 320 / sourceHeight);
  const width = Math.max(1, Math.floor(image.width * scale));
  const height = Math.max(1, Math.floor(sourceHeight * scale));
  const data = new Uint8ClampedArray(width * height * 4);
  const top = image.height - sourceHeight;
  for (let y = 0; y < height; y++) {
    const sourceY = top + Math.min(sourceHeight - 1, Math.floor(y * sourceHeight / height));
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(image.width - 1, Math.floor(x * image.width / width));
      const from = (sourceY * image.width + sourceX) * 4;
      data.set(image.data.subarray ? image.data.subarray(from, from + 4) : image.data.slice(from, from + 4), (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

function copyReference(reference) {
  return { data: reference.data.slice(), width: reference.width, height: reference.height };
}

export function createScrollSession(seedImage, options = {}) {
  const { maxFrames = DEFAULTS.maxFrames, maxBytes = DEFAULTS.maxBytes, maxAgeMs = DEFAULTS.maxAgeMs,
    maxHeight = MAX_HEIGHT, preservePixels = false } = options ?? {};
  const detect = options?.detect ?? detectShift;
  if (!Number.isInteger(maxFrames) || maxFrames < 0 || !Number.isInteger(maxBytes) || maxBytes < 0 ||
      !Number.isFinite(maxAgeMs) || maxAgeMs < 0 || !Number.isInteger(maxHeight) || maxHeight < seedImage.height ||
      maxHeight > MAX_HEIGHT || typeof preservePixels !== 'boolean' || typeof detect !== 'function') {
    throw new RangeError('无效滚动会话选项');
  }

  let seed = { data: new Uint8ClampedArray(seedImage.data), width: seedImage.width, height: seedImage.height };
  let chunks = [{ data: seed.data, height: seed.height, docTop: 0, seed: true }];
  // ceiling 是向上已接的最远文档坐标（≤0），height 是正文总高度，两个方向都让它变大。
  let docOffset = 0, minOffset = 0, maxOffset = 0, frontierOffset = 0;
  let frontier = fingerprint(seed);
  let height = seed.height;
  let viewportMatched = false;
  const viewportSnapshot = matched => ({ top: Math.max(0, docOffset - minOffset), height: seed.height, matched: Boolean(matched) });
  const previewField = () => { if (!seed || !chunks.length) return {}; const preview = renderPreview(seed.width, chunks); return preview ? { preview } : {}; };
  let motionHistory = [{ frame: frontier, height }];
  let pending = [];
  let pendingBytes = 0;
  let pendingSequence = 0;
  let droppedFrames = 0;
  let replayChecks = 0;
  let seedReference = makeReference(seed);
  let lastReference = seedReference;
  let background = !preservePixels && seed.width * seed.height <= BACKGROUND_PIXEL_LIMIT ? createBackgroundModel(seed.width, seed.height) : null;
  let lastRaw = background ? { data: new Uint8ClampedArray(seed.data), width: seed.width, height: seed.height } : null;
  // 只有真检测到固定顶栏时才避让它，避开的高度取观测到的最大值。
  let topGuard = 2;
  let cleared = false;
  const noteTopGuard = result => {
    if (result?.fixedTop && Number.isInteger(result.headerRows)) topGuard = Math.max(topGuard, Math.min(seed.height - 4, result.headerRows));
  };

  const assertActive = () => {
    if (cleared) throw new Error('滚动会话已清除');
  };
  const historyFor = (excludeFrame) => {
    const item = motionHistory.findLast(entry => entry.height !== height && entry.frame !== excludeFrame);
    return item && { previous: item.frame, shift: item.height - height };
  };
  const rememberMotion = (frame, result, baseHeight) => {
    if (!(result.foreground || ['forward', 'reverse'].includes(result.kind)) || !Number.isInteger(result.shift) || result.shift === 0) {
      return { added: false, position: null };
    }
    const position = baseHeight + result.shift;
    const existing = motionHistory.findLast(entry => entry.frame === frame);
    if (existing) existing.height = position;
    else if (motionHistory.at(-1)?.height !== position) {
      motionHistory.push({ frame, height: position });
      if (motionHistory.length > 2) motionHistory.shift();
      return { added: true, position };
    }
    return { added: false, position };
  };
  const byCaptureTime = (a, b) => a.atMs - b.atMs || a.order - b.order;
  const removePending = (item, dropped = false) => {
    const index = pending.indexOf(item);
    if (index < 0) return;
    pending.splice(index, 1);
    pendingBytes -= item.bytes;
    if (dropped) droppedFrames++;
  };
  const clearPending = () => {
    droppedFrames += pending.length;
    pending = [];
    pendingBytes = 0;
  };
  const pruneExpired = atMs => {
    for (const item of [...pending]) if (atMs - item.atMs > maxAgeMs) removePending(item, true);
  };
  const cachePending = (image, frame, atMs, position) => {
    const bytes = image.data.byteLength ?? image.data.length;
    if (bytes > maxBytes || maxFrames === 0) { droppedFrames++; return null; }
    while (pending.length >= maxFrames || pendingBytes + bytes > maxBytes) removePending(pending[0], true);
    const copy = { data: new Uint8ClampedArray(image.data), width: image.width, height: image.height };
    const item = { image: copy, frame, atMs, bytes, position, order: pendingSequence++ };
    pending.push(item);
    pending.sort(byCaptureTime);
    pendingBytes += bytes;
    return item;
  };
  const canAppend = (image, shift) => {
    if (image.width !== seed.width || image.height !== seed.height || !Number.isInteger(shift) || shift === 0 || Math.abs(shift) >= image.height) {
      return { ok: false, limit: false };
    }
    const next = frontierOffset + shift;
    const top = Math.min(minOffset, next), bottom = Math.max(maxOffset, next);
    const nextHeight = seed.height + (bottom - top);
    if (nextHeight > maxHeight || nextHeight * image.width > MAX_PIXELS || chunks.length >= 1000) return { ok: false, limit: true };
    return { ok: true, limit: false };
  };
  const append = (image, frame, shift) => {
    // 基准帧只在向下接长时前移；reverse 仍相对最远帧，不能把基准换成反向帧。
    const next = frontierOffset + shift;
    const down = next - maxOffset, up = minOffset - next;
    const amount = down > 0 ? down : up;
    // 位移可信就跟着基准帧走，避免折返后累计位移超过可匹配重叠。
    if (amount <= 0) { docOffset = next; frontier = frame; frontierOffset = next; return 0; }
    if (amount >= image.height) { docOffset = next; return 0; }
    const part = down > 0 ? newRows(image, amount) : topRows(image, amount);
    if (background && lastRaw) {
      const start = down > 0 ? image.height - amount : 0;
      const mask = observeBackground(background, lastRaw, image, { start, rows: amount });
      if (mask) { part.mask = mask; part.sourceStart = start; }
      if (lastRaw.width === image.width && lastRaw.height === image.height) lastRaw.data.set(image.data);
      else lastRaw = { data: new Uint8ClampedArray(image.data), width: image.width, height: image.height };
    }
    if (down > 0) { part.docTop = height; chunks.push(part); maxOffset = next; }
    else { part.docTop = 0; chunks.unshift(part); minOffset = next; }
    docOffset = next; frontier = frame; frontierOffset = next;
    height += amount;
    lastReference = makeReference(image);
    return amount;
  };
  const snapshot = (result, added, recoveredFrames, limit, includeReference) => ({
    result,
    height,
    chunks: chunks.length,
    added,
    recoveredFrames,
    pendingFrames: pending.length,
    pendingBytes,
    droppedFrames,
    limit,
    ...(includeReference ? { reference: copyReference(lastReference) } : {}),
    ...(added > 0 || includeReference ? previewField() : {}),
    viewport: viewportSnapshot(viewportMatched)
  });

  if (seed.height > MAX_HEIGHT || seed.width * seed.height > MAX_PIXELS) throw new RangeError('长图已达到尺寸上限');

  return {
    accept(image, atMs) {
      assertActive();
      viewportMatched = false;
      if (!Number.isFinite(atMs)) throw new RangeError('采集时间必须是有限数字');
      pruneExpired(atMs);
      const current = fingerprint(image);
      const initial = detect(frontier, current, historyFor());
      // 内容与基准帧完全一致时，当前位置就是基准帧位置。
      if (initial.kind === 'still') docOffset = frontierOffset;
      noteTopGuard(initial);
      const motion = rememberMotion(current, initial, height);

      if (initial.kind === 'forward' || initial.kind === 'reverse') {
        const allowance = canAppend(image, initial.shift);
        if (!allowance.ok) return snapshot(initial, 0, 0, allowance.limit, false);
        const added = append(image, current, initial.shift);
        clearPending();
        viewportMatched = true;
        return snapshot(initial, added, 0, false, true);
      }

      const cacheableInitially = ['fixed', 'ambiguous', 'unmatched'].includes(initial.kind);
      const latestPending = cacheableInitially ? cachePending(image, current, atMs, motion.position) : null;
      const oldPending = pending.filter(item => item !== latestPending);
      const replayOrder = motion.added ? [...oldPending].sort((a, b) => {
        const distanceA = Number.isFinite(a.position) ? Math.abs(a.position - height) : Infinity;
        const distanceB = Number.isFinite(b.position) ? Math.abs(b.position - height) : Infinity;
        return distanceA - distanceB || byCaptureTime(a, b);
      }).slice(0, 4).sort(byCaptureTime) : [];
      const selected = new Set(replayOrder);
      const retained = oldPending.filter(item => !selected.has(item));
      if (latestPending) retained.push(latestPending);
      let added = 0, recoveredFrames = 0, limit = false, frontierAdvanced = false;

      for (const item of replayOrder) {
        replayChecks++;
        const replay = detect(frontier, item.frame, historyFor());
        if (replay.kind === 'forward' || replay.kind === 'reverse') {
          const allowance = canAppend(item.image, replay.shift);
          const gained = allowance.ok ? append(item.image, item.frame, replay.shift) : 0;
          if (gained > 0) { added += gained; recoveredFrames++; frontierAdvanced = true; continue; }
          if (!allowance.ok) limit ||= allowance.limit;
          droppedFrames++;
          continue;
        }
        if (['fixed', 'ambiguous', 'unmatched'].includes(replay.kind)) retained.push(item);
        else droppedFrames++;
      }

      pending = retained.sort(byCaptureTime);
      pendingBytes = pending.reduce((sum, item) => sum + item.bytes, 0);
      const result = frontierAdvanced ? detect(frontier, current, historyFor(current)) : initial;
      noteTopGuard(result);
      const finalMotion = frontierAdvanced ? rememberMotion(current, result, height) : motion;
      if (latestPending && Number.isFinite(finalMotion.position)) latestPending.position = finalMotion.position;
      if (result.kind === 'forward' || result.kind === 'reverse') {
        const allowance = canAppend(image, result.shift);
        const gained = allowance.ok ? append(image, current, result.shift) : 0;
        if (gained > 0) {
          added += gained;
          if (latestPending) removePending(latestPending);
          clearPending();
        } else {
          if (!allowance.ok) limit ||= allowance.limit;
          if (latestPending) removePending(latestPending, true);
        }
      } else if (latestPending && !['fixed', 'ambiguous', 'unmatched'].includes(result.kind)) {
        removePending(latestPending, true);
      } else if (!latestPending && !cacheableInitially && ['fixed', 'ambiguous', 'unmatched'].includes(result.kind)) {
        cachePending(image, current, atMs, finalMotion.position);
      }
      return snapshot(result, added, recoveredFrames, limit, added > 0);
    },

    preview(prefix, suffix) {
      assertActive();
      return renderPreview(seed.width, [prefix, ...chunks, suffix]);
    },

    finish() {
      assertActive();
      // 向上接长后首块不再是首屏；背景延展只从 docTop 为 0 的首屏正文开始，向上片段保持原像素。
      const seedIndex = chunks.findIndex(chunk => chunk.seed === true);
      const extended = extendBackground(seedIndex > 0 ? chunks.slice(seedIndex) : chunks, background, { seedHeight: seed.height, topGuard });
      const output = compose(chunks, seed.width);
      return { ...output, backgroundEvidence: backgroundSummary(background),
        ...(extended.active ? { background: { rows: extended.rows, pixels: extended.pixels } } : {}) };
    },

    clear() {
      if (cleared) return;
      chunks = [];
      frontier = null;
      motionHistory = [];
      pending = [];
      pendingBytes = 0;
      droppedFrames = 0;
      replayChecks = 0;
      pendingSequence = 0;
      seedReference = null;
      lastReference = null;
      background = null;
      lastRaw = null;
      seed = null;
      height = 0;
      docOffset = minOffset = maxOffset = 0;
      cleared = true;
    },

    stats() {
      const alive = Boolean(seed);
      return {
        height,
        chunks: chunks.length,
        pendingFrames: pending.length,
        pendingBytes,
        droppedFrames,
        replayChecks,
        backgroundValidPixels: background?.validCount ?? 0,
        backgroundBlockedPixels: background?.blockedCount ?? 0,
        ...previewField(),
        ...(alive ? { viewport: viewportSnapshot(viewportMatched) } : {}),
        ...(seedReference ? { reference: copyReference(seedReference) } : {})
      };
    }
  };
}
