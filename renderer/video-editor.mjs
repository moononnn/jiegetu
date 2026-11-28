// Renderer-only editor. The host owns confirmation, the source file and all writes.
// One rail over the whole original recording: click/drag seeks, and in 裁剪 mode a drag
// picks a draft range that only 「剪掉这段」 turns into a committed cut. Committed cuts are
// drawn on the rail, skipped by playback and sent to the host as the edit payload.
// No frame-level precision is promised: joins are found from video frame callbacks plus a
// short timer, and both the status line and the button titles say so.
export function formatTime(ms) {
  ms = Math.max(0, Math.round(ms));
  const minutes = Math.floor(ms / 60000);
  return `${String(minutes).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}

// —— 时间标尺：刻度的位置只由真实毫秒算，标签按可用宽度稀疏取样 ——
const RULER_LADDER = [100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000];

export function rulerLabel(ms, stepMs) {
  const total = Math.max(0, Math.round(ms));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const tenths = stepMs < 1000 ? Math.round((total % 1000) / 100) : 0;
  return `${minutes}:${String(seconds).padStart(2, '0')}${tenths ? `.${tenths}` : ''}`;
}

export function rulerTicks(durationMs, widthPx) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return { stepMs: 0, minorMs: 0, ticks: [] };
  const width = Number.isFinite(widthPx) && widthPx > 0 ? widthPx : 360;
  const maxLabels = Math.max(2, Math.min(6, Math.floor(width / 96)));
  const stepMs = RULER_LADDER.find(step => step >= durationMs / maxLabels) || RULER_LADDER[RULER_LADDER.length - 1];
  const minorMs = stepMs >= 2000 ? stepMs / 2 : stepMs / 5;
  const ticks = [];
  for (let ms = 0; ms <= durationMs + 0.5 && ticks.length < 160; ms += minorMs) {
    const value = Math.round(ms);
    const major = Math.abs(value % stepMs) < 0.5;
    const ratio = value / durationMs;
    ticks.push({ ms: value, major, label: major ? rulerLabel(value, stepMs) : '',
      align: ratio < 0.06 ? 'start' : ratio > 0.94 ? 'end' : 'center' });
  }
  return { stepMs, minorMs, ticks };
}

// —— 剪辑模型：全部是整数毫秒的半开区间 [startMs,endMs) ——
// 与 core/video-edit.mjs 的导出契约同一口径：{durationMs,startMs,endMs,cuts:[{startMs,endMs}]}，
// 最多 MAX_CUTS 段内部删除，相邻/重叠的段合并，剪完至少留 MIN_KEEP_MS。
export const MAX_CUTS = 24;
export const MIN_KEEP_MS = 10;

export function createRange(durationMs) {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1) throw new Error('视频时长无效');
  return { durationMs, startMs: 0, endMs: durationMs, cuts: [] };
}

// 归一化：只留整数毫秒、夹到原片内、排序、合并重叠或相邻（±1ms 视为同一段）。
export function normalizeCuts(cuts, durationMs) {
  const list = [];
  for (const cut of Array.isArray(cuts) ? cuts : []) {
    if (!cut || !Number.isSafeInteger(cut.startMs) || !Number.isSafeInteger(cut.endMs)) continue;
    const from = Math.max(0, Math.min(cut.startMs, durationMs));
    const to = Math.max(0, Math.min(cut.endMs, durationMs));
    if (to <= from) continue;
    list.push({ startMs: from, endMs: to });
  }
  list.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged = [];
  for (const cut of list) {
    const last = merged[merged.length - 1];
    if (last && cut.startMs <= last.endMs + 1) last.endMs = Math.max(last.endMs, cut.endMs);
    else merged.push({ startMs: cut.startMs, endMs: cut.endMs });
  }
  return merged;
}

// 首尾书立能到的范围：起点不能越过第一段已剪段，终点不能越过最后一段。
export function trimBounds(range, key) {
  const first = range.cuts.length ? range.cuts[0].startMs : range.endMs;
  const last = range.cuts.length ? range.cuts[range.cuts.length - 1].endMs : range.startMs;
  return key === 'startMs' ? [0, Math.min(first, range.endMs) - 1] : [Math.max(last, range.startMs) + 1, range.durationMs];
}

export function trimBoundary(range, key, value) {
  if (!range || !Number.isFinite(value) || (key !== 'startMs' && key !== 'endMs')) return range;
  const [min, max] = trimBounds(range, key);
  const at = Math.max(min, Math.min(Math.round(value), max));
  if (range[key] === at) return range;
  return { ...range, cuts: range.cuts.map(cut => ({ ...cut })), [key]: at };
}

// 剪后仍然保留的片段（已按首尾裁剪夹好），播放与导出都用它。
export function retainedSpans(range) {
  if (!range) return [];
  const spans = [];
  let cursor = range.startMs;
  for (const cut of normalizeCuts(range.cuts, range.durationMs)) {
    const from = Math.max(cut.startMs, range.startMs);
    const to = Math.min(cut.endMs, range.endMs);
    if (to <= from) continue;
    if (from > cursor) spans.push({ startMs: cursor, endMs: from });
    cursor = Math.max(cursor, to);
  }
  if (cursor < range.endMs) spans.push({ startMs: cursor, endMs: range.endMs });
  return spans;
}

export function editedMs(range) {
  return retainedSpans(range).reduce((sum, span) => sum + span.endMs - span.startMs, 0);
}

function sameCuts(a, b) {
  return a.length === b.length && a.every((cut, index) => cut.startMs === b[index].startMs && cut.endMs === b[index].endMs);
}

// 把待剪段并入已剪段：越界先夹到保留范围，再合并；剪光或超上限一律明确拒绝，不偷偷修正。
export function planCut(range, draft) {
  if (!range) return { ok: false, reason: 'idle', message: '还没有可用的视频时长' };
  if (!draft || !Number.isSafeInteger(draft.startMs) || !Number.isSafeInteger(draft.endMs)) {
    return { ok: false, reason: 'empty', message: '先点「裁剪」在播放头处起一段' };
  }
  const from = Math.max(range.startMs, Math.min(draft.startMs, draft.endMs));
  const to = Math.min(range.endMs, Math.max(draft.startMs, draft.endMs));
  if (to - from < 1) return { ok: false, reason: 'empty', message: '这一段太短，换一下起止' };
  const cuts = normalizeCuts([...range.cuts, { startMs: from, endMs: to }], range.durationMs)
    .filter(cut => cut.endMs > range.startMs && cut.startMs < range.endMs)
    .map(cut => ({ startMs: Math.max(cut.startMs, range.startMs), endMs: Math.min(cut.endMs, range.endMs) }));
  if (sameCuts(cuts, range.cuts)) return { ok: false, reason: 'noop', message: '这一段已经在剪掉的范围里了' };
  if (cuts.length > MAX_CUTS) return { ok: false, reason: 'too-many', message: `一次最多剪 ${MAX_CUTS} 段，先撤销或合并相邻的段` };
  const next = { ...range, cuts };
  if (editedMs(next) < MIN_KEEP_MS) return { ok: false, reason: 'too-short', message: `剪完至少要留下 ${MIN_KEEP_MS} 毫秒画面` };
  return { ok: true, range: next, cut: { startMs: from, endMs: to } };
}

// 点「裁剪」时立刻给出的待剪段：钉在播放头所在的保留画面里，默认 DEFAULT_CUT_MS，
// 往后放不下就整段挪到播放头左边；播放头在已剪区间里时先落到后面最近的保留画面。
export const DEFAULT_CUT_MS = 1000;

export function draftAt(range, headMs, defaultMs = DEFAULT_CUT_MS) {
  if (!range) return { ok: false, reason: 'idle', message: '还没有可用的视频时长' };
  const spans = retainedSpans(range);
  if (!spans.length) return { ok: false, reason: 'empty', message: '已经没有可剪的画面了' };
  const head = Math.round(Number(headMs) || 0);
  let span = spans.find(item => head >= item.startMs && head < item.endMs);
  let anchor;
  if (span) anchor = head;
  else {
    span = spans.find(item => item.startMs >= head);
    if (span) anchor = span.startMs;
    else { span = spans[spans.length - 1]; anchor = span.endMs; }
  }
  const room = span.endMs - span.startMs;
  if (room < MIN_KEEP_MS + 1) return { ok: false, reason: 'too-short', message: '这一段剩下的画面太短，不能再剪' };
  const length = Math.max(1, Math.min(Math.round(defaultMs) || DEFAULT_CUT_MS, room - MIN_KEEP_MS));
  let startMs = anchor;
  let endMs = anchor + length;
  if (endMs > span.endMs) {
    // 靠近保留段末尾：整段放到播放头左边，播放头正好是它的终点（不含）。
    endMs = Math.max(span.startMs + 1, anchor);
    startMs = endMs - length;
    if (startMs < span.startMs) { startMs = span.startMs; endMs = startMs + length; }
  }
  return { ok: true, draft: { startMs, endMs }, span };
}

// 撤销：回到撤销前的那份已剪段清单；首尾保留范围保持用户当前看到的位置。
export function applyCuts(range, cuts) {
  const inside = normalizeCuts(cuts, range.durationMs)
    .filter(cut => cut.endMs > range.startMs && cut.startMs < range.endMs)
    .map(cut => ({ startMs: Math.max(cut.startMs, range.startMs), endMs: Math.min(cut.endMs, range.endMs) }));
  return { ...range, cuts: inside };
}

// 交给宿主的剪辑计划：整型、有序、已合并、夹在首尾之内，最多 MAX_CUTS 段。
export function toPayload(range) {
  const cuts = normalizeCuts(range.cuts, range.durationMs)
    .filter(cut => cut.startMs >= range.startMs && cut.endMs <= range.endMs)
    .map(cut => ({ startMs: cut.startMs, endMs: cut.endMs }));
  return { durationMs: range.durationMs, startMs: range.startMs, endMs: range.endMs, cuts };
}

// 剪后连播：null = 就在这里继续；{seek} = 跳到下一段保留画面；{stop} = 已经到剪后终点。
export function joinTarget(range, ms) {
  const spans = retainedSpans(range);
  if (!spans.length) return { stop: true, ms: range?.endMs ?? 0 };
  for (const span of spans) {
    if (ms < span.startMs) return { seek: span.startMs };
    if (ms < span.endMs) return null;
  }
  return { stop: true, ms: spans[spans.length - 1].endMs };
}

// 下一个可能要动的位置：所在保留段的接缝；不落在任何保留段里就算马上要处理。
export function nextJoinMs(range, ms) {
  for (const span of retainedSpans(range)) {
    if (ms < span.startMs) return Math.max(range.startMs, span.startMs);
    if (ms < span.endMs) return span.endMs;
  }
  return range.endMs;
}

const TRIM_HANDLES = [['handle-start', 'startMs'], ['handle-end', 'endMs']];
const DRAFT_HANDLES = [['handle-draft-start', 'draftStartMs'], ['handle-draft-end', 'draftEndMs']];
const JOIN_POLL_MS = 250;         // 帧回调之外的最长兜底间隔，接缝不追求逐帧精确
const RESUME_MS = 350;            // 接缝 seek 后等待恢复播放的有界时长；超时只做一次 pause→play

export function initVideoEditor(doc, bridge, opts = {}) {
  const el = id => doc.getElementById(id);
  const video = el('video');
  const rail = el('rail');
  // 测试可注入更短的看门狗时长；产品默认 RESUME_MS。
  const resumeMs = Number.isFinite(opts.resumeMs) && opts.resumeMs > 0 ? opts.resumeMs : RESUME_MS;
  let range = null, loaded = false, busy = false, warning = '', objectURL = null;
  let draft = null, history = [], dragging = null;
  let playing = false, rulerKey = '', cutsKey = '', cutNodes = [];
  let frameHandle = 0, joinTimer = 0, resumeTimer = 0;
  // 事务式 seek：同一时刻只允许一个真实 seek 在途；seekTargetMs 记“最新想到达的位置”（最新者胜），
  // seekGen 作废过期的帧回调/看门狗；internalPauses 计数区分“看门狗内部 pause”与“用户 pause”。
  let seekTargetMs = null, inFlightTargetMs = null, seekGen = 0, internalPauses = 0;
  doc.defaultView?.addEventListener?.('pagehide', () => { stopPlayback(); if (objectURL) URL.revokeObjectURL(objectURL); });
  // 窗口变宽变窄时重新取样标尺标签（刻度位置本来就是百分比，不用重算时间）。
  doc.defaultView?.addEventListener?.('resize', () => { rulerKey = ''; renderRuler(); });
  const status = message => { el('status').textContent = [message, warning].filter(Boolean).join(' · '); };
  const durationOf = () => range ? range.durationMs : 0;
  const currentMs = () => Math.max(0, Math.round((Number(video.currentTime) || 0) * 1000));
  const pct = ms => durationOf() > 0 ? Math.min(100, Math.max(0, ms / durationOf() * 100)) : 0;

  function render() {
    const total = durationOf();
    const head = currentMs();
    const cuts = range?.cuts ?? [];
    const seekable = loaded && !busy && Boolean(range);
    el('playhead').style.left = `${pct(head)}%`;
    rail.setAttribute('aria-valuemin', '0');
    rail.setAttribute('aria-valuemax', String(Math.round(video.duration * 1000) || total));
    rail.setAttribute('aria-valuenow', String(Math.min(head, Math.round(video.duration * 1000) || total)));
    rail.setAttribute('aria-valuetext', formatTime(head));
    el('keep').hidden = !range;
    if (range) {
      el('keep').style.left = `${pct(range.startMs)}%`;
      el('keep').style.width = `${pct(range.endMs) - pct(range.startMs)}%`;
    }
    syncCuts();
    el('draft').hidden = !draft;
    el('draft-lane').hidden = !draft;
    if (draft) {
      el('draft').style.left = `${pct(draft.startMs)}%`;
      el('draft').style.width = `${pct(draft.endMs) - pct(draft.startMs)}%`;
    }
    placeBoundaries();
    for (const [id, key] of TRIM_HANDLES) {
      const node = el(id);
      const active = Boolean(range);
      const value = active ? range[key] : 0;
      node.hidden = !active;
      if (active) node.style.left = `${pct(value)}%`;
      const [min, max] = active ? trimBounds(range, key) : [0, 0];
      node.setAttribute('aria-valuemin', String(min));
      node.setAttribute('aria-valuemax', String(max));
      node.setAttribute('aria-valuenow', String(value));
      node.setAttribute('aria-valuetext', formatTime(value));
      node.setAttribute('aria-disabled', String(!seekable || !active));
      node.tabIndex = active ? 0 : -1;
    }
    for (const [id, key] of DRAFT_HANDLES) {
      const node = el(id);
      const active = Boolean(range) && Boolean(draft);
      node.hidden = !active;
      const value = active ? (key === 'draftStartMs' ? draft.startMs : draft.endMs) : 0;
      if (active) node.style.left = `${pct(value)}%`;
      const [min, max] = !active ? [0, 0] : key === 'draftStartMs'
        ? [range.startMs, draft.endMs - 1] : [draft.startMs + 1, range.endMs];
      node.setAttribute('aria-valuemin', String(min));
      node.setAttribute('aria-valuemax', String(max));
      node.setAttribute('aria-valuenow', String(value));
      node.setAttribute('aria-valuetext', formatTime(value));
      node.setAttribute('aria-disabled', String(!seekable || !active));
      node.tabIndex = active ? 0 : -1;
    }
    el('mark-start').textContent = `起点 ${formatTime(range?.startMs ?? 0)}`;
    el('mark-end').textContent = `终点 ${formatTime(range?.endMs ?? 0)}`;
    el('mark-cuts').textContent = !cuts.length ? '未剪'
      : cuts.length <= 3 ? `已剪 ${cuts.length} 段 · ${cuts.map(cut => `${formatTime(cut.startMs)}–${formatTime(cut.endMs)}`).join('、')}`
      : `已剪 ${cuts.length} 段`;
    el('mark-draft').hidden = !draft;
    if (draft) el('mark-draft').textContent = `待剪 ${formatTime(draft.startMs)}–${formatTime(draft.endMs)}（未确认）`;
    el('clock').textContent = `${formatTime(head)} / ${formatTime(total)}`;
    el('meta').textContent = range ? `${formatTime(total)}${cuts.length ? ` · 已剪 ${cuts.length} 段` : ' · 整段保留'}` : (loaded ? '正在读取时长…' : '正在读取…');
    el('play').disabled = busy || !range;
    el('mute').disabled = busy || !loaded;
    el('mode').disabled = busy || !range;
    el('confirm-cut').disabled = busy || !draft;
    el('discard-draft').hidden = !draft;
    el('discard-draft').disabled = busy;
    el('undo').disabled = busy || !history.length;
    // 只有一个保存口：没剪就存原片，剪了就存剪后版本；文案跟着变，不让人猜存哪一份。
    el('save').disabled = busy || !loaded;
    el('save').textContent = cuts.length ? '保存剪辑视频' : '保存视频';
    el('save').title = cuts.length ? `保存剪掉这 ${cuts.length} 段之后的视频` : '保存这次录的原始视频';
    el('close').disabled = busy;
    el('play').setAttribute('aria-label', playing ? '暂停' : '播放');
    el('play').setAttribute('aria-pressed', String(playing));
    doc.body?.classList?.toggle('playing', playing);
    renderRuler();
  }

  // 已剪的段直接画在轨道上：段数变化才重建节点，位置每次都跟着时长重算。
  function syncCuts() {
    const host = el('cuts');
    const list = range?.cuts ?? [];
    host.hidden = !list.length;
    const key = list.map(cut => `${cut.startMs}-${cut.endMs}`).join('|');
    if (key !== cutsKey) {
      cutsKey = key;
      cutNodes = list.map((cut, index) => {
        const block = typeof doc.createElement === 'function' ? doc.createElement('span') : null;
        if (!block) return null;
        block.className = 'cut-block';
        block.dataset.index = String(index);
        block.title = `已剪 ${formatTime(cut.startMs)}–${formatTime(cut.endMs)}`;
        return block;
      }).filter(Boolean);
      if (typeof host.replaceChildren === 'function') host.replaceChildren(...cutNodes);
      else { host.textContent = ''; for (const node of cutNodes) host.appendChild(node); }
    }
    list.forEach((cut, index) => {
      const node = cutNodes[index];
      if (!node) return;
      node.style.left = `${pct(cut.startMs)}%`;
      node.style.width = `${Math.max(0, pct(cut.endMs) - pct(cut.startMs))}%`;
    });
  }

  // 边界线：与书立内缘同一条竖线，位置仍是真实时间戳。
  function placeBoundaries() {
    const place = (id, ms, visible) => {
      const node = el(id);
      node.hidden = !visible;
      if (visible) node.style.left = `${pct(ms)}%`;
    };
    place('bl-start', range?.startMs ?? 0, Boolean(range));
    place('bl-end', range?.endMs ?? 0, Boolean(range));
  }

  // 标尺：刻度按真实毫秒定位，标签数随可用宽度收敛；同一时长/宽度不重建。
  function renderRuler() {
    const node = el('ruler');
    const total = durationOf();
    if (!total) { node.hidden = true; rulerKey = ''; return; }
    node.hidden = false;
    let width = 0;
    try { width = Math.round(rail.getBoundingClientRect?.()?.width || 0); } catch { width = 0; }
    const key = `${total}:${Math.round(width / 24)}`;
    if (key === rulerKey) return;
    rulerKey = key;
    const built = rulerTicks(total, width || 360).ticks.map(tick => {
      const mark = doc.createElement?.('span');
      if (!mark) return null;
      mark.className = tick.major ? 'tick major' : 'tick';
      mark.dataset.ms = String(tick.ms);
      mark.style.left = `${tick.ms / total * 100}%`;
      if (tick.label) {
        const text = doc.createElement('span');
        text.className = `tick-label${tick.align === 'start' ? ' at-start' : tick.align === 'end' ? ' at-end' : ''}`;
        text.textContent = tick.label;
        mark.appendChild(text);
      }
      return mark;
    }).filter(Boolean);
    if (!built.length) return;
    if (typeof node.replaceChildren === 'function') node.replaceChildren(...built);
    else { node.textContent = ''; for (const mark of built) node.appendChild(mark); }
  }

  // 事务式定位：只记“最新想到达的位置”，真正的 seek 由 pumpSeek 串行发出；
  // 已在目标上（no-op）或已有 seek 在途时不再重复写 currentTime，避免 seek 抖动。
  function seekTo(ms) {
    if (!range) return;
    const total = Math.round((Number(video.duration) || 0) * 1000) || range.durationMs;
    seekTargetMs = Math.max(0, Math.min(total, Math.round(ms)));
    pumpSeek();
    render();
  }

  function pumpSeek() {
    if (seekTargetMs === null) return;
    // 同一目标已在途 → 不重复发（避免同目标 seek 抖动）；新目标照发，浏览器取代在途 seek（最新者胜）。
    if (video.seeking && seekTargetMs === inFlightTargetMs) return;
    const targetSec = seekTargetMs / 1000;
    if (!video.seeking && Math.abs((Number(video.currentTime) || 0) - targetSec) < 0.0005) { seekTargetMs = null; return; }
    inFlightTargetMs = seekTargetMs;
    seekGen += 1;
    video.currentTime = targetSec;
  }

  function stopPlayback() {
    if (joinTimer) { clearTimeout(joinTimer); joinTimer = 0; }
    if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = 0; }
    if (frameHandle) {
      try { video.cancelVideoFrameCallback?.(frameHandle); } catch { /* 下一帧回调会自己退出。 */ }
      frameHandle = 0;
    }
    seekTargetMs = null;
    inFlightTargetMs = null;
    seekGen += 1;                 // 作废所有在途帧回调/恢复看门狗
    if (playing) { playing = false; try { video.pause(); } catch { /* 已经停了。 */ } }
    render();
  }

  // —— 剪后连播：接缝用帧回调 + 短计时检查，一律按“原片时间”判断，不宣称逐帧精确 ——
  function checkJoin(ms) {
    if (!playing || !range || video.seeking) return false;
    const target = joinTarget(range, ms);
    if (!target) return false;
    if (target.stop) {
      stopPlayback();
      seekTo(target.ms);
      status('修剪后的视频播放结束');
      return true;
    }
    seekTo(target.seek);
    armAdvanceWatch(seekGen);   // 兼顾“seek 一直不完成”：到点查 seeking/推进
    return true;
  }

  function armJoinWatch() {
    if (joinTimer) { clearTimeout(joinTimer); joinTimer = 0; }
    if (!playing || !range || typeof setTimeout !== 'function') return;
    const at = currentMs();
    const wait = Math.max(40, Math.min(JOIN_POLL_MS, Math.round(nextJoinMs(range, at) - at)));
    joinTimer = setTimeout(() => {
      joinTimer = 0;
      if (!playing || !range) return;
      // 正在跳：等 seeked 再排，别在原地反复 seek。
      if (video.seeking) { armJoinWatch(); return; }
      if (!checkJoin(currentMs())) armJoinWatch();
    }, wait);
  }

  // seek 完成后：若仍在播放意图里就恢复播放（浏览器可能在 seek 后停住），并上“推进”看门狗。
  function resumeAfterSeek() {
    if (!playing) return;
    const gen = seekGen;
    Promise.resolve(video.play()).catch(() => { /* 由看门狗兜底 */ });
    watchFrames();
    armJoinWatch();
    armAdvanceWatch(gen);
  }

  // 有界“推进”看门狗：不看 paused 标志，只看 currentTime 是否在推进 / seek 是否卡在途。
  // 真实卡住往往是 paused=false 但画面不动（或 seeking 一直为 true），所以不能只查 paused。
  // 冻结/卡 seek 时只做一次有界 pause→play；再不行就停下并给可用状态，绝不复活用户已暂停的播放。
  function armAdvanceWatch(gen) {
    if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = 0; }
    if (!playing || typeof setTimeout !== 'function') return;
    const baseline = currentMs();
    resumeTimer = setTimeout(() => {
      resumeTimer = 0;
      if (!playing || gen !== seekGen) return;      // 用户已暂停 / 有了新动作 → 不复活
      if (!video.seeking && currentMs() > baseline) return; // 在推进且 seek 不卡 → 健康
      // 冻结（无论 paused 与否）或 seek 卡在途：只做一次有界 pause→play
      if (!video.paused) { internalPauses += 1; try { video.pause(); } catch { /* 已经停了。 */ } }
      Promise.resolve(video.play()).catch(() => { /* 下面再查一次 */ });
      const retryGen = seekGen;
      const retryBaseline = currentMs();
      resumeTimer = setTimeout(() => {
        resumeTimer = 0;
        if (!playing || retryGen !== seekGen) return;
        if (video.seeking || currentMs() <= retryBaseline) {
          stopPlayback();
          status('接缝处播放暂时卡住，已暂停；再点播放即可，原视频不受影响');
        }
      }, resumeMs);
    }, resumeMs);
  }

  function watchFrames() {
    if (typeof video.requestVideoFrameCallback !== 'function') return;
    if (frameHandle) {
      try { video.cancelVideoFrameCallback?.(frameHandle); } catch { /* 下一帧回调会自己退出。 */ }
      frameHandle = 0;
    }
    const onFrame = (_now, meta) => {
      frameHandle = 0;
      if (!playing || !range) return;
      // seek 在途时帧回调可能是旧位置；mediaTime 与当前播放头差太多也当作过期帧，都不据此再 seek。
      if (!video.seeking) {
        const mediaMs = Number(meta?.mediaTime);
        const headMs = currentMs();
        const stale = Number.isFinite(mediaMs) && Math.abs(Math.round(mediaMs * 1000) - headMs) > 250;
        if (!stale) checkJoin(headMs);
      }
      if (!playing || typeof video.requestVideoFrameCallback !== 'function') return;
      try { frameHandle = video.requestVideoFrameCallback(onFrame); } catch { frameHandle = 0; }
    };
    try { frameHandle = video.requestVideoFrameCallback(onFrame); } catch { frameHandle = 0; }
  }

  // —— 指针：轨道定位；裁剪模式下拖出待剪段；书立各自在车道里拖动 ——
  function msAt(clientX) {
    if (!range) return 0;
    const rect = typeof rail.getBoundingClientRect === 'function' ? rail.getBoundingClientRect() : null;
    if (!rect || !(rect.width > 0)) return 0;
    return ((clientX - rect.left) / rect.width) * range.durationMs;
  }
  function grab(node, kind, event) {
    if (!range || busy || !loaded) return false;
    if (kind !== 'rail' && node.getAttribute('aria-disabled') === 'true') return false;
    dragging = kind;
    stopPlayback();
    try { node.setPointerCapture?.(event.pointerId); } catch { /* 没有捕获能力也能拖。 */ }
    return true;
  }
  function release() { dragging = null; }

  // 点「裁剪」（或按 C / 轨道上 Enter）就在播放头处立刻长出待剪段，再自己调两端。
  function beginDraft() {
    if (!range || busy) return;
    stopPlayback();
    const plan = draftAt(range, currentMs());
    if (!plan.ok) { status(plan.message || '这段画面太短，不能再剪'); return; }
    draft = plan.draft;
    status(`已在播放头处裁出 ${formatTime(draft.startMs)}–${formatTime(draft.endMs)}，拖两端或用方向键调整`);
    render();
  }

  function moveTrim(key, ms) {
    if (!range) return;
    const next = trimBoundary(range, key, ms);
    if (next === range) { render(); return; }
    range = next;
    seekTo(range[key]);
  }

  function moveDraftEdge(key, ms) {
    if (!range || !draft) return;
    const at = Math.round(ms);
    draft = key === 'draftStartMs'
      ? { startMs: Math.max(range.startMs, Math.min(at, draft.endMs - 1)), endMs: draft.endMs }
      : { startMs: draft.startMs, endMs: Math.min(range.endMs, Math.max(at, draft.startMs + 1)) };
    seekTo(key === 'draftStartMs' ? draft.startMs : draft.endMs);
  }

  // 轨道只负责定位：单击、拖动、松手都只是把播放头挪过去，永远不自己长出一段。
  rail.addEventListener('pointerdown', event => {
    if (!grab(rail, 'rail', event)) return;
    event.preventDefault();
    seekTo(msAt(event.clientX));
  });
  rail.addEventListener('pointermove', event => {
    if (dragging !== 'rail') return;
    seekTo(msAt(event.clientX));
  });
  rail.addEventListener('pointerup', release);
  rail.addEventListener('pointercancel', release);
  rail.addEventListener('lostpointercapture', release);
  for (const [id, key] of [...TRIM_HANDLES, ...DRAFT_HANDLES]) {
    const node = el(id);
    node.addEventListener('pointerdown', event => {
      if (!grab(node, key, event)) return;
      event.preventDefault();
      event.stopPropagation();
    });
    node.addEventListener('pointermove', event => {
      if (dragging !== key) return;
      if (key.startsWith('draft')) moveDraftEdge(key, msAt(event.clientX));
      else moveTrim(key, msAt(event.clientX));
    });
    node.addEventListener('pointerup', release);
    node.addEventListener('pointercancel', release);
  }

  // —— 键盘：轨道定位、书立微调、待剪段 Enter 确认 / Backspace 放弃 ——
  const STEP = 100, BIG = 1000;
  function arrowStep(event) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') return -(event.shiftKey ? BIG : STEP);
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') return event.shiftKey ? BIG : STEP;
    if (event.key === 'PageDown') return -BIG;
    if (event.key === 'PageUp') return BIG;
    return null;
  }
  function boundaryKey(kind, event) {
    if (!range) return null;
    if (event.key === 'Home' || event.key === 'End') {
      const far = event.key === 'End';
      if (kind === 'startMs') return trimBounds(range, 'startMs')[far ? 1 : 0];
      if (kind === 'endMs') return trimBounds(range, 'endMs')[far ? 1 : 0];
      if (!draft) return null;
      if (kind === 'draftStartMs') return far ? draft.endMs - 1 : range.startMs;
      return far ? range.endMs : draft.startMs + 1;
    }
    const step = arrowStep(event);
    if (step === null) return null;
    if (kind === 'startMs') return range.startMs + step;
    if (kind === 'endMs') return range.endMs + step;
    if (!draft) return null;
    return kind === 'draftStartMs' ? draft.startMs + step : draft.endMs + step;
  }
  rail.addEventListener('keydown', event => {
    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      event.stopPropagation();
      void togglePlay();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      if (draft) commitCut(); else beginDraft();
      return;
    }
    if ((event.key === 'Backspace' || event.key === 'Delete') && draft) {
      event.preventDefault();
      event.stopPropagation();
      discardDraft();
      return;
    }
    if (!range) return;
    let next = null;
    const step = arrowStep(event);
    if (step !== null) next = currentMs() + step;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = Math.round(video.duration * 1000) || range.durationMs;
    if (next === null) return;
    event.preventDefault();
    stopPlayback();
    seekTo(next);
  });
  for (const [id, key] of [...TRIM_HANDLES, ...DRAFT_HANDLES]) {
    el(id).addEventListener('keydown', event => {
      const next = boundaryKey(key, event);
      if (next === null) return;
      event.preventDefault();
      stopPlayback();
      if (key === 'startMs' || key === 'endMs') moveTrim(key, next);
      else moveDraftEdge(key, next);
    });
  }

  // —— 播放 / 静音：播放的就是剪后成片，没有单独“预览”一档 ——
  async function togglePlay() {
    if (busy || !range || !loaded) return;
    if (playing) { stopPlayback(); status(''); return; }
    playing = true;
    seekGen += 1;
    render();
    const entry = joinTarget(range, currentMs());
    if (entry?.stop) seekTo(retainedSpans(range)[0]?.startMs ?? range.startMs);
    else if (entry?.seek !== undefined) seekTo(entry.seek);
    try {
      await video.play();
      if (!playing) return;
      status('按剪后顺序连播；接缝自动跳过，可能有极短误差');
      watchFrames();
      armJoinWatch();
      armAdvanceWatch(seekGen);
    } catch {
      playing = false; render(); status('播放失败，仍可保存原视频');
    }
  }
  el('play').addEventListener('click', () => { void togglePlay(); });
  video.addEventListener('click', () => { void togglePlay(); });
  const applyMute = () => {
    video.muted = !video.muted;
    el('mute').setAttribute('aria-pressed', String(video.muted === true));
    el('mute').setAttribute('aria-label', video.muted ? '取消静音' : '静音');
    doc.body?.classList?.toggle('muted', video.muted === true);
  };
  el('mute').addEventListener('click', applyMute);
  video.addEventListener('play', () => {
    if (!playing) { playing = true; render(); }
    watchFrames();
    armJoinWatch();
  });
  video.addEventListener('pause', () => {
    if (internalPauses > 0) { internalPauses -= 1; return; }  // 看门狗内部的 pause，不是用户暂停
    if (playing) { playing = false; render(); }
  });
  video.addEventListener('seeked', () => {
    // 事务收尾：不按 currentTime 精度重泵（帧舍入会让落点与目标差几毫秒，重泵会抖动）。
    // 更新的目标在 seekTo→pumpSeek 时已发出；这里只清在途标记并按播放意图恢复。
    inFlightTargetMs = null;
    seekTargetMs = null;
    if (playing && !video.seeking) resumeAfterSeek();
    else render();
  });
  video.addEventListener('ended', () => { stopPlayback(); status('播放结束'); });
  video.addEventListener('timeupdate', () => {
    if (playing && checkJoin(currentMs())) return;
    render();
  });

  // —— 裁剪：待剪段只是草稿，剪掉才进已剪清单；撤销一次退一段 ——
  function commitCut() {
    if (!range || busy || !draft) return;
    const plan = planCut(range, draft);
    if (!plan.ok) { status(plan.message); render(); return; }
    stopPlayback();
    history.push(range.cuts.map(cut => ({ ...cut })));
    range = plan.range;
    draft = null;
    status(`已剪掉 ${formatTime(plan.cut.startMs)}–${formatTime(plan.cut.endMs)}；可继续剪下一段或撤销`);
    render();
  }
  function discardDraft() {
    if (!draft) return;
    draft = null;
    status('已取消这次选择');
    render();
  }
  function undoCuts() {
    if (!range || busy || !history.length) return;
    stopPlayback();
    range = applyCuts(range, history.pop());
    draft = null;
    status(history.length ? `已撤销一段，还能再撤销 ${history.length} 次` : '已撤销到未剪状态');
    render();
  }
  el('mode').addEventListener('click', beginDraft);
  el('confirm-cut').addEventListener('click', commitCut);
  el('discard-draft').addEventListener('click', discardDraft);
  el('undo').addEventListener('click', undoCuts);

  async function action(method, payload) {
    if (busy) return;
    stopPlayback();
    busy = true; render();
    // 导出立刻给一句诚实状态：控件禁用期间用户知道在干什么；不加假进度，不改保存窗口顺序。
    if (method === 'exportEdit') status('正在导出剪辑… 导出完成后会打开保存窗口');
    try {
      const result = await (payload === undefined ? bridge[method]() : bridge[method](payload));
      if (method === 'close' || method === 'confirmDiscard') {
        if (result?.confirmationRequired && !el('close-confirm').open) el('close-confirm').showModal();
        if (result?.message) status(result.message);
      } else if (result?.saved) status(result.message || '已保存');
      else if (result?.canceled) status(result.message || '已取消保存');
      else status(result?.message || '保存失败，原视频仍保留');
    } catch (error) {
      status(`${method === 'close' ? '关闭' : '保存'}失败：${error?.message || '未知错误'}${method === 'exportEdit' ? '；原视频仍保留' : ''}`);
    } finally { busy = false; render(); }
  }
  el('save').addEventListener('click', () => {
    if (!loaded) return;
    // 剪过就交剪辑计划；没剪直接存原片字节，不白跑一趟重编码。
    if (range?.cuts?.length) void action('exportEdit', toPayload(range));
    else void action('saveOriginal');
  });
  el('close').addEventListener('click', () => void action('close'));
  bridge?.onCloseRequested?.(() => void action('close'));
  el('keep-editing').addEventListener('click', () => el('close-confirm').close());
  el('discard-video').addEventListener('click', () => {
    el('close-confirm').close();
    void action('confirmDiscard');
  });
  doc.addEventListener('keydown', event => {
    // 轨道/书立已经处理过的键不再重复动作（否则空格会在轨道和页面各触发一次）。
    if (event.defaultPrevented) return;
    if (el('close-confirm').open) return;
    if (event.key === 'Escape') { event.preventDefault(); void action('close'); return; }
    const tag = event.target?.tagName?.toLowerCase?.() || '';
    if (tag === 'button' || tag === 'input' || tag === 'textarea') return;
    if (event.key === ' ' || event.key === 'Spacebar') { event.preventDefault(); void togglePlay(); return; }
    if (event.key === 'm' || event.key === 'M') { event.preventDefault(); applyMute(); return; }
    if (event.key === 'c' || event.key === 'C') { event.preventDefault(); beginDraft(); return; }
    if ((event.ctrlKey || event.metaKey) && (event.key === 'z' || event.key === 'Z')) { event.preventDefault(); undoCuts(); return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (draft) commitCut(); else beginDraft();
      return;
    }
    if ((event.key === 'Backspace' || event.key === 'Delete') && draft) { event.preventDefault(); discardDraft(); }
  });

  video.addEventListener('loadedmetadata', () => {
    try {
      range = createRange(Math.round(video.duration * 1000));
      history = []; draft = null; cutsKey = '';
      status('拖动轨道定位；点「裁剪」在播放头处裁出一段，再调两端');
    } catch { range = null; status('无法读取视频时长，仍可保存原视频'); }
    render();
  });
  video.addEventListener('error', () => { stopPlayback(); range = null; status('视频预览失败，仍可保存原视频'); render(); });
  render();

  const ready = (async () => {
    try {
      if (!bridge || ['load', 'saveOriginal', 'exportEdit', 'close'].some(name => typeof bridge[name] !== 'function')) throw new Error('视频编辑宿主不可用');
      const source = await bridge.load();
      if (!(source.bytes instanceof Uint8Array) || !source.bytes.length || source.bytes.length > 512 * 1024 * 1024 ||
          typeof source.mimeType !== 'string' || !/^video\/(webm|mp4)(?:\s*;|\s*$)/i.test(source.mimeType)) throw new Error('视频数据无效');
      objectURL = URL.createObjectURL(new Blob([source.bytes], { type: source.mimeType }));
      warning = typeof source.warning === 'string' ? source.warning : '';
      loaded = true;
      video.src = objectURL;
      status('正在读取视频…');
    } catch (error) { status(`加载失败：${error?.message || '未知错误'}`); }
    render();
  })();
  return { ready };
}

if (typeof document !== 'undefined') initVideoEditor(document, window.videoEditor);
