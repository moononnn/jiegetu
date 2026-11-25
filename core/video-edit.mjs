// Source-time edit plan, in integer milliseconds. All ranges are half-open [startMs,endMs).
// No rounding, clamping or frame/keyframe assumptions are made by this pure model.
//
// Contract (host IPC → exporter): { durationMs, startMs, endMs, cuts?: [{startMs,endMs}, ...] }
//   - cuts may be omitted or [] (nothing removed).
//   - at most MAX_CUTS interior cuts; the exporter turns them into at most MAX_CUTS+1 spans.
//   - the legacy single cut (remove) stays supported for older callers; sending both is rejected.
// Errors carry a fixed `code` from TIMELINE_CODES so callers never have to parse messages.

export const MAX_CUTS = 24;
export const TIMELINE_CODES = Object.freeze({
  invalid: 'timeline-invalid',
  tooManyCuts: 'timeline-too-many-cuts',
  tooShort: 'timeline-too-short',
});

function timelineError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function normalizeVideoEdit({ durationMs, startMs = 0, endMs = durationMs, cuts = null, remove = null, minSpanMs = 1 } = {}) {
  const integer = value => Number.isSafeInteger(value);
  if (!integer(durationMs) || durationMs < 1) throw timelineError(TIMELINE_CODES.invalid, '视频时长必须是正整数毫秒');
  if (!integer(minSpanMs) || minSpanMs < 1) throw timelineError(TIMELINE_CODES.invalid, '最短片段必须是正整数毫秒');
  if (!integer(startMs) || !integer(endMs) || startMs < 0 || endMs > durationMs || endMs <= startMs) {
    throw timelineError(TIMELINE_CODES.invalid, '保留范围无效');
  }
  const hasCuts = cuts !== null && cuts !== undefined;
  const hasRemove = remove !== null && remove !== undefined;
  if (hasCuts && hasRemove) throw timelineError(TIMELINE_CODES.invalid, '不能同时提交单段删除和删除列表');

  let requested;
  if (hasRemove) {
    // 旧契约：单段删除必须严格位于保留范围内部，行为与以前一致。
    if (!remove || typeof remove !== 'object' || Array.isArray(remove) ||
        !integer(remove.startMs) || !integer(remove.endMs) ||
        remove.startMs <= startMs || remove.endMs >= endMs || remove.endMs <= remove.startMs) {
      throw timelineError(TIMELINE_CODES.invalid, '删除范围必须位于保留范围内部');
    }
    requested = [{ startMs: remove.startMs, endMs: remove.endMs }];
  } else if (hasCuts) {
    if (!Array.isArray(cuts)) throw timelineError(TIMELINE_CODES.invalid, '删除区间必须是数组');
    if (cuts.length > MAX_CUTS) throw timelineError(TIMELINE_CODES.tooManyCuts, `一次最多删除 ${MAX_CUTS} 段，请合并相邻的删除区间`);
    requested = cuts.map(cut => {
      if (!cut || typeof cut !== 'object' || Array.isArray(cut) || !integer(cut.startMs) || !integer(cut.endMs) || cut.endMs <= cut.startMs) {
        throw timelineError(TIMELINE_CODES.invalid, '删除区间无效');
      }
      return { startMs: cut.startMs, endMs: cut.endMs };
    });
  } else {
    requested = [];
  }

  // 归一化：按起点排序 → 夹到保留范围内 → 合并重叠或相邻（相邻 1ms 内算同一段）。
  const merged = [];
  for (const cut of requested.slice().sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)) {
    const from = Math.max(cut.startMs, startMs);
    const to = Math.min(cut.endMs, endMs);
    if (to <= from) continue;
    const last = merged[merged.length - 1];
    if (last && from <= last.endMs + 1) last.endMs = Math.max(last.endMs, to);
    else merged.push({ startMs: from, endMs: to });
  }

  // 剩下的每一段就是保留片段；少于最短时长就明确拒绝，不偷偷修正。
  const spans = [];
  let cursor = startMs;
  for (const cut of merged) {
    if (cut.startMs > cursor) spans.push({ startMs: cursor, endMs: cut.startMs });
    cursor = Math.max(cursor, cut.endMs);
  }
  if (cursor < endMs) spans.push({ startMs: cursor, endMs });
  if (!spans.length) throw timelineError(TIMELINE_CODES.tooShort, '删除后没有保留任何画面，请减少或缩短删除区间');
  const short = spans.find(span => span.endMs - span.startMs < minSpanMs);
  if (short) throw timelineError(TIMELINE_CODES.tooShort, `有一个保留片段太短（至少需要 ${minSpanMs} 毫秒），请调整起止或删除区间`);
  if (spans.length > MAX_CUTS + 1) throw timelineError(TIMELINE_CODES.tooManyCuts, `一次最多删除 ${MAX_CUTS} 段`);

  const totalMs = spans.reduce((sum, span) => sum + span.endMs - span.startMs, 0);
  const noOp = spans.length === 1 && spans[0].startMs === 0 && spans[0].endMs === durationMs;
  return { durationMs, spans, totalMs, noOp };
}
