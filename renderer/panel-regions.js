'use strict';

// A conservative fallback for visible, straight panel dividers in a downsampled frozen frame.
// Texture, text, and ordinary short edges should not become selectable panels.
(function () {
  function detectPanelRegions(rgba, width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 160 || height < 100 ||
        width > 768 || height > 768 || rgba?.length !== width * height * 4) return [];

    function cuts(vertical, from, to, acrossFrom, acrossTo) {
      const scores = [];
      const step = Math.max(1, Math.floor((acrossTo - acrossFrom) / 128));
      const stride = vertical ? 4 : width * 4;
      for (let pos = from; pos < to; pos++) {
        let strong = 0, samples = 0, strength = 0;
        for (let q = acrossFrom; q < acrossTo; q += step) {
          const at = (vertical ? q * width + pos : pos * width + q) * 4;
          const a = at - stride, b = at + stride;
          const delta = Math.max(Math.abs(rgba[a] - rgba[b]), Math.abs(rgba[a + 1] - rgba[b + 1]), Math.abs(rgba[a + 2] - rgba[b + 2]));
          if (delta >= 9) strong++;
          strength += Math.min(delta, 30);
          samples++;
        }
        if (samples && strong / samples >= (vertical ? 0.78 : 0.97)) scores.push({ pos, score: (strong * 30 + strength) / samples });
      }
      // A single thick border or gutter can generate adjacent peaks. Keep its strongest edge.
      const groups = [];
      for (const hit of scores) {
        let group = groups.at(-1);
        if (!group || hit.pos - group.end > (vertical ? 5 : 9)) groups.push(group = { end: hit.pos, best: hit });
        group.end = hit.pos;
        if (hit.score > group.best.score) group.best = hit;
      }
      return groups.map(group => group.best);
    }

    const insetY = Math.ceil(height * 0.035);
    const minCol = Math.max(38, Math.round(width * 0.11));
    const vertical = cuts(true, minCol, width - minCol, insetY, height - insetY);
    if (!vertical.length || vertical.length > 2) return [];
    const xs = [0, ...vertical.map(hit => hit.pos), width];
    for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] < minCol) return [];

    const panels = [];
    for (let i = 1; i < xs.length; i++) {
      const x = xs[i - 1], w = xs[i] - x;
      const pad = Math.max(2, Math.round(w * 0.02));
      const minRow = Math.max(36, Math.round(height * 0.19));
      // Only split smaller columns; a document header or table row in the main body is not a dock.
      const ys = w <= width * 0.42 ? cuts(false, minRow, height - minRow, x + pad, x + w - pad) : [];
      const y = ys.length ? ys.reduce((best, hit) => hit.score > best.score ? hit : best).pos : 0;
      panels.push({ x, y: 0, width: w, height });
      if (y) panels.push({ x, y: 0, width: w, height: y }, { x, y, width: w, height: height - y });
    }
    return panels;
  }
  if (typeof module === 'object' && module.exports) module.exports = { detectPanelRegions };
  else globalThis.detectPanelRegions = detectPanelRegions;
})();
