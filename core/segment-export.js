/* 分段导出的纯数学：不碰像素、不碰文件系统，main 与编辑页共用同一份规则。
   规则：每段最高 2400 像素；窄图按 2×图宽收窄；相邻重叠约 120 像素且不超过段高 10%；
   最后一段贴底，不重复整段前段；去重叠后按顺序拼接必须逐像素等于原图。 */
(function (host) {
  'use strict';
  const DEFAULT_SEGMENT_HEIGHT = 2400;
  const DEFAULT_OVERLAP = 120;
  // 单张图最多允许切这么多段：再窄的图不现实，宁可明确报错也不悄悄给出几百个文件。
  const MAX_SEGMENTS = 500;
  const positiveInt = value => Number.isInteger(value) && value > 0;

  function plan(width, height, options = {}) {
    if (!positiveInt(width) || !positiveInt(height)) throw new RangeError('分段尺寸无效');
    if (width > 30000 || height > 30000) throw new RangeError('分段尺寸超过限制');
    const requested = options.segmentHeight ?? DEFAULT_SEGMENT_HEIGHT;
    const overlapWanted = options.overlap ?? DEFAULT_OVERLAP;
    if (!positiveInt(requested)) throw new RangeError('分段高度无效');
    if (!Number.isInteger(overlapWanted) || overlapWanted < 0) throw new RangeError('分段重叠无效');
    // 窄图按 2×图宽收窄，避免一条细长图被切成几十片；至少 1 像素高。
    const segmentHeight = Math.max(1, Math.min(requested, Math.max(1, width * 2)));
    const overlap = Math.min(overlapWanted, Math.floor(segmentHeight * 0.1), Math.max(0, segmentHeight - 1));
    const step = segmentHeight - overlap;
    if (!positiveInt(step)) throw new RangeError('分段步长无效');
    if (height <= segmentHeight) return { width, height, segmentHeight, overlap, step, segments: [{ index: 0, top: 0, height }] };
    // 固定步长前进，第一段从 0 开始；最后一段只补到图底，它可以比段高矮，但不会重复整张前段。
    // 这样每一处相邻重叠都恰好等于 overlap，不会因为末段贴底而突然多重叠一大块。
    const segments = [];
    for (let top = 0; ; top += step) {
      if (segments.length >= MAX_SEGMENTS) throw new RangeError(`这张图会超过 ${MAX_SEGMENTS} 段上限；请缩窄长图或先裁切`);
      const remaining = height - top;
      if (remaining <= segmentHeight) { segments.push({ index: segments.length, top, height: remaining }); break; }
      segments.push({ index: segments.length, top, height: segmentHeight });
    }
    return { width, height, segmentHeight, overlap, step, segments };
  }

  // 文件名由主进程统一生成：序号零填充到「总段数」的位数，天然保持自然顺序。
  function fileName(index, total) {
    if (!Number.isInteger(index) || index < 0 || !positiveInt(total) || index >= total) throw new RangeError('分段序号无效');
    const digits = Math.max(2, String(total).length);
    return `${String(index + 1).padStart(digits, '0')}.png`;
  }

  const api = { plan, fileName, DEFAULT_SEGMENT_HEIGHT, DEFAULT_OVERLAP, MAX_SEGMENTS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else host.SegmentExport = api;
})(typeof window === 'object' ? window : globalThis);
