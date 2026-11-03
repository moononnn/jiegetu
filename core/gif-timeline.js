/* Own-encoder GIF metadata only. No pixel/LZW decoding. */
(function (host) {
  'use strict';
  function parse(bytes) {
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 48 * 1024 * 1024) throw new Error('GIF 字节超过限制');
    let p = 0;
    const need = n => { if (p + n > bytes.length) throw new Error('GIF 结构截断'); };
    const u8 = () => { need(1); return bytes[p++]; };
    const u16 = () => u8() | (u8() << 8);
    const skip = n => { need(n); p += n; };
    const text = n => { let s = ''; while (n--) s += String.fromCharCode(u8()); return s; };
    const blocks = () => { let n; while ((n = u8())) skip(n); };
    if (!['GIF89a', 'GIF87a'].includes(text(6))) throw new Error('不是 GIF');
    const width = u16(), height = u16(), packed = u8();
    if (!width || !height || width > 4096 || height > 4096 || width * height > 4000000) throw new Error('GIF 尺寸超过限制');
    skip(2);
    if (packed & 128) skip(3 * (1 << ((packed & 7) + 1)));
    let delay = null, durationMs = 0, trailer = false;
    const frames = [];
    while (p < bytes.length) {
      const tag = u8();
      if (tag === 0x3b) { trailer = true; break; }
      if (tag === 0x21) {
        const label = u8();
        if (label === 0xf9) {
          if (delay !== null || u8() !== 4) throw new Error('无效 GCE');
          const flags = u8(); delay = u16() * 10; u8();
          if (flags !== 4 || delay < 10 || u8() !== 0) throw new Error('仅支持自家全幅不透明 GIF');
        } else if (label === 0xff) {
          if (u8() !== 11 || text(11) !== 'NETSCAPE2.0') throw new Error('不支持的 GIF 扩展');
          if (u8() !== 3 || u8() !== 1 || u16() !== 0 || u8() !== 0) throw new Error('无效 GIF 循环扩展');
        } else throw new Error('不支持的 GIF 扩展');
      } else if (tag === 0x2c) {
        const x = u16(), y = u16(), w = u16(), h = u16(), flags = u8();
        if (x || y || w !== width || h !== height || (flags & 0x78) || delay === null) throw new Error('仅支持自家全幅 GIF');
        if (flags & 128) skip(3 * (1 << ((flags & 7) + 1)));
        const codeSize = u8(); if (codeSize < 2 || codeSize > 8) throw new Error('无效 LZW 头');
        if (bytes[p] === 0) throw new Error('空 GIF 图像');
        blocks();
        frames.push({ index: frames.length, startMs: durationMs, durationMs: delay });
        durationMs += delay; delay = null;
        if (frames.length > 512 || durationMs > 31000) throw new Error('GIF 时间或帧数超过限制');
      } else throw new Error('无效 GIF 结构');
    }
    if (!trailer || p !== bytes.length || !frames.length || delay !== null) throw new Error('GIF 结构不完整');
    return { width, height, durationMs, frames };
  }
  function trim(timeline, startMs, endMs) {
    if (![startMs, endMs].every(n => Number.isSafeInteger(n) && n % 10 === 0) || startMs < 0 || endMs > timeline.durationMs || endMs <= startMs) throw new Error('首尾需为有效的 10ms 刻度');
    let elapsedMs = 0;
    return timeline.frames.flatMap(frame => {
      const durationMs = Math.min(endMs, frame.startMs + frame.durationMs) - Math.max(startMs, frame.startMs);
      if (durationMs <= 0) return [];
      // index 一律是原解码帧号：虚拟时间线（删段后）靠 sourceIndex 回落，导出才能对回真正的画面。
      const result = { index: frame.sourceIndex ?? frame.index, elapsedMs, durationMs }; elapsedMs += durationMs; return [result];
    });
  }
  // 删除 [startMs,endMs) 这一段：返回新的连续虚拟时间线，帧号重排、sourceIndex 指回原解码帧。
  // 不改传入的 timeline、不复制像素；切口落在一帧内部时两侧同源会按时长合并，不把一帧拆成两帧。
  function remove(timeline, startMs, endMs) {
    if (!timeline || typeof timeline !== 'object' || !Array.isArray(timeline.frames) || !timeline.frames.length ||
        !Number.isSafeInteger(timeline.durationMs) || timeline.durationMs < 10) throw new Error('GIF 时间线无效');
    if (![startMs, endMs].every(n => Number.isSafeInteger(n) && n % 10 === 0) || startMs < 0 || endMs > timeline.durationMs || endMs <= startMs) throw new Error('删除范围需为有效的 10ms 刻度');
    if (timeline.durationMs - (endMs - startMs) < 10) throw new Error('删除后必须至少保留 10ms');
    const frames = [];
    let durationMs = 0;
    for (const frame of timeline.frames) {
      const sourceIndex = frame.sourceIndex ?? frame.index;
      const from = frame.startMs, to = frame.startMs + frame.durationMs;
      const pieces = [[from, Math.min(to, startMs)], [Math.max(from, endMs), to]];
      for (const [left, right] of pieces) {
        const kept = right - left;
        if (kept <= 0) continue;
        const previous = frames[frames.length - 1];
        if (previous && previous.sourceIndex === sourceIndex) previous.durationMs += kept;
        else frames.push({ index: frames.length, sourceIndex, startMs: durationMs, durationMs: kept });
        durationMs += kept;
      }
    }
    if (!frames.length || durationMs < 10) throw new Error('删除后必须至少保留 10ms');
    return { width: timeline.width, height: timeline.height, durationMs, frames };
  }
  const api = Object.freeze({ parse, trim, remove });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else host.GifTimeline = api;
})(typeof window === 'object' ? window : globalThis);
