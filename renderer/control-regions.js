'use strict';

// A conservative detector for control-sized rectangular surfaces (inputs, cards) in an already
// downsampled frozen frame. It never reads text, fonts or names: it only looks for matching
// orthogonal border runs, so a card or input box becomes selectable even when no accessibility
// provider is available for that window.
//
// A rectangle is proposed by a pair of horizontal border runs with matching extent; the two
// vertical sides are then looked for next to the shared corners. Rounded corners and soft or
// broken borders are tolerated: a side only has to carry edge evidence over most of its length,
// and the corner pixels themselves may be missing.
(function () {
  const EDGE_STRENGTH = 6;      // a border that was filtered down is weaker than the original
  const RUN_GAP = 3;            // horizontal runs may lose up to this many pixels and stay one run
  const CORNER_SEARCH = 10;     // how far from the shared corner a vertical side may sit
  const CORNER_GAP = 3;         // pixels at a side end that may miss edge evidence
  const SIDE_MIN = 0.3;         // a single side needs at least this much edge coverage
  const SIDE_MEAN = 0.75;       // and the four sides together need at least this much
  const BUSY_MAX = 0.45;        // a control may hold a label, but not a text block or a picture
  const MIN_HEIGHT = 14;        // a control is taller than a text line
  const MAX_BOXES = 48;         // bounded candidate list per window
  const MAX_RUNS = 400;         // at most 79,800 pairs, before cheap geometric rejection

  function detectControlRegions(rgba, width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 ||
        width > 4096 || height > 4096 || !rgba || rgba.length !== width * height * 4) return [];

    const gray = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
      gray[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
    }
    const at = (x, y) => gray[y * width + x];

    // A border that was filtered down spreads over two rows or columns, so the gradient is the
    // strongest one within one pixel. Both directions are precomputed once.
    const hEdge = new Uint8Array(width * height);
    const vEdge = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      const rowBase = y * width;
      for (let x = 0; x < width; x += 1) {
        let bestH = 0;
        let bestV = 0;
        for (let d = -1; d <= 1; d += 1) {
          const row = y + d;
          if (row >= 0 && row + 1 < height) {
            const delta = Math.abs(gray[rowBase + x] - gray[(row + 1) * width + x]);
            if (delta > bestH) bestH = delta;
          }
          const col = x + d;
          if (col >= 0 && col + 1 < width) {
            const delta = Math.abs(gray[rowBase + col] - gray[rowBase + col + 1]);
            if (delta > bestV) bestV = delta;
          }
        }
        hEdge[rowBase + x] = bestH >= EDGE_STRENGTH ? 1 : 0;
        vEdge[rowBase + x] = bestV >= EDGE_STRENGTH ? 1 : 0;
      }
    }
    // Prefix sums turn a side coverage into a constant time lookup.
    const rowPrefix = new Uint16Array(width * height);
    const colPrefix = new Uint16Array(width * height);
    for (let y = 0; y < height; y += 1) {
      let rowRun = 0;
      const base = y * width;
      for (let x = 0; x < width; x += 1) {
        rowRun += hEdge[base + x];
        rowPrefix[base + x] = rowRun;
      }
    }
    for (let x = 0; x < width; x += 1) {
      let colRun = 0;
      for (let y = 0; y < height; y += 1) {
        colRun += vEdge[y * width + x];
        colPrefix[y * width + x] = colRun;
      }
    }
    const horizontalCoverage = (y, x0, x1) => {
      const from = Math.max(0, x0 + CORNER_GAP);
      const to = Math.min(width - 1, x1 - CORNER_GAP);
      if (to < from) return 0;
      const base = y * width;
      const strong = rowPrefix[base + to] - (from ? rowPrefix[base + from - 1] : 0);
      return strong / (to - from + 1);
    };
    const verticalCoverage = (x, y0, y1) => {
      const from = Math.max(0, y0 + CORNER_GAP);
      const to = Math.min(height - 1, y1 - CORNER_GAP);
      if (to < from) return 0;
      const strong = colPrefix[to * width + x] - (from ? colPrefix[(from - 1) * width + x] : 0);
      return strong / (to - from + 1);
    };

    const minSide = Math.max(24, Math.round(width * 0.05));
    const minHeight = Math.max(MIN_HEIGHT, Math.round(height * 0.033));
    const maxHeight = Math.max(minHeight, Math.round(height * 0.55));

    // Horizontal border runs: long straight edges that a control draws.
    const runs = [];
    for (let y = 0; y < height; y += 1) {
      let start = -1;
      let lastStrong = -1;
      const base = y * width;
      for (let x = 0; x < width; x += 1) {
        if (hEdge[base + x]) {
          if (start < 0) start = x;
          lastStrong = x;
        } else if (start >= 0 && x - lastStrong > RUN_GAP) {
          if (lastStrong - start + 1 >= minSide) runs.push({ y, x0: start, x1: lastStrong });
          start = -1;
          lastStrong = -1;
        }
      }
      if (start >= 0 && lastStrong - start + 1 >= minSide) runs.push({ y, x0: start, x1: lastStrong });
    }
    if (runs.length < 2) return [];
    runs.sort((a, b) => (b.x1 - b.x0) - (a.x1 - a.x0) || a.y - b.y);
    // Keep the longest runs when there are too many: a long border is the interesting one.
    const kept = runs.length > MAX_RUNS ? runs.slice(0, MAX_RUNS) : runs;
    kept.sort((a, b) => a.y - b.y || a.x0 - b.x0);
    const capped = kept;

    const boxes = [];
    for (let i = 0; i < capped.length; i += 1) {
      const top = capped[i];
      for (let j = i + 1; j < capped.length; j += 1) {
        const bottom = capped[j];
        const span = bottom.y - top.y;
        if (span < minHeight) continue;
        if (span > maxHeight) break;
        const overlapFrom = Math.max(top.x0, bottom.x0);
        const overlapTo = Math.min(top.x1, bottom.x1);
        if (overlapTo - overlapFrom < minSide) continue;
        if (overlapTo - overlapFrom < 0.5 * Math.min(top.x1 - top.x0, bottom.x1 - bottom.x0)) continue;
        // Cheap pre-filter: both runs must belong to the same surface, so they may not reach far
        // beyond the shared part. Otherwise a long separator pairs with unrelated borders.
        const overhangGuess = Math.max(6, Math.round((overlapTo - overlapFrom) * 0.08));
        if (top.x0 < overlapFrom - overhangGuess || top.x1 > overlapTo + overhangGuess) continue;
        if (bottom.x0 < overlapFrom - overhangGuess || bottom.x1 > overlapTo + overhangGuess) continue;
        // Do not short-circuit on the number of rejected pairs: that starves lower controls.
        // The vertical sides sit next to the shared corners of the two runs.
        let leftX = -1;
        let leftScore = 0;
        for (let x = Math.max(0, overlapFrom - CORNER_SEARCH); x <= Math.min(width - 1, overlapFrom + CORNER_SEARCH); x += 1) {
          const score = verticalCoverage(x, top.y, bottom.y);
          if (score > leftScore) { leftScore = score; leftX = x; }
        }
        let rightX = -1;
        let rightScore = 0;
        for (let x = Math.max(0, overlapTo - CORNER_SEARCH); x <= Math.min(width - 1, overlapTo + CORNER_SEARCH); x += 1) {
          const score = verticalCoverage(x, top.y, bottom.y);
          if (score > rightScore) { rightScore = score; rightX = x; }
        }
        if (leftX < 0 || rightX < 0 || rightX - leftX < minSide) continue;

        const topSide = horizontalCoverage(top.y, leftX, rightX);
        const bottomSide = horizontalCoverage(bottom.y, leftX, rightX);
        const leftSide = verticalCoverage(leftX, top.y, bottom.y);
        const rightSide = verticalCoverage(rightX, top.y, bottom.y);
        const mean = (topSide + bottomSide + leftSide + rightSide) / 4;
        if (Math.min(topSide, bottomSide, leftSide, rightSide) < SIDE_MIN || mean < SIDE_MEAN) continue;
        // Aligned controls can have the same x edges. Never bridge the gap between them.
        if (!continuousSide(leftX, top.y, bottom.y) || !continuousSide(rightX, top.y, bottom.y)) continue;
        // Both horizontal runs must belong to this surface: they may not reach far beyond the
        // sides, otherwise a long separator crossing the window pairs with unrelated borders.
        const overhang = Math.max(6, Math.round((rightX - leftX) * 0.08));
        if (top.x0 < leftX - overhang || top.x1 > rightX + overhang) continue;
        if (bottom.x0 < leftX - overhang || bottom.x1 > rightX + overhang) continue;

        const boxWidth = rightX - leftX + 1;
        const boxHeight = bottom.y - top.y + 1;
        if (boxWidth * boxHeight > 0.85 * width * height) continue;
        if (!flatEnough(leftX, top.y, rightX, bottom.y)) continue;

        // The same surface can be proposed with its last row one pixel off: keep one box.
        const duplicate = boxes.find(other => Math.abs(other.x - leftX) <= 3 && Math.abs(other.y - top.y) <= 3 &&
          Math.abs((other.x + other.width) - (rightX + 1)) <= 3 && Math.abs((other.y + other.height) - (bottom.y + 1)) <= 3);
        if (duplicate) {
          if (mean > duplicate.mean) { duplicate.x = leftX; duplicate.y = top.y; duplicate.width = boxWidth; duplicate.height = boxHeight; duplicate.mean = mean; }
          continue;
        }
        boxes.push({ x: leftX, y: top.y, width: boxWidth, height: boxHeight, mean });
      }
    }
    boxes.sort((a, b) => (b.mean - a.mean) || (b.width * b.height - a.width * a.height));
    return boxes.slice(0, MAX_BOXES).map(box => ({ x: box.x, y: box.y, width: box.width, height: box.height }));

    // A side has to be continuous over its whole length: a clean gap between two separate
    // borders is not one side. A chunk with a bit less evidence (a soft or filtered border) still
    // counts as continuous - that is what a real border looks like after downsampling.
    function continuousSide(x, y0, y1) {
      const run = Math.max(5, Math.round((y1 - y0) * 0.13));
      for (let y = y0 + CORNER_GAP; y + run <= y1 - CORNER_GAP; y += Math.max(2, run >> 1)) {
        const strong = colPrefix[(y + run - 1) * width + x] - colPrefix[(y - 1) * width + x];
        if (strong / run < 0.4) return false;
      }
      return true;
    }

    // A control may hold a label or a thumbnail; it must only not be a busy picture.
    function flatEnough(x0, y0, x1, y1) {
      const inset = 3;
      const left = x0 + inset;
      const right = x1 - inset;
      const topRow = y0 + inset;
      const bottomRow = y1 - inset;
      if (right - left < 4 || bottomRow - topRow < 4) return true;
      // Bounded sample of the interior: a big surface is sampled with a coarser grid.
      const step = Math.max(2, Math.ceil(Math.sqrt(((right - left) * (bottomRow - topRow)) / 4 / 4096)));
      const values = [];
      for (let y = topRow; y <= bottomRow; y += step) {
        for (let x = left; x <= right; x += step) values.push(at(x, y));
      }
      if (!values.length) return true;
      // The median from a histogram: the same value as sorting, without the sort cost.
      const histogram = new Uint32Array(256);
      for (const value of values) histogram[value] += 1;
      const half = Math.floor(values.length / 2);
      let seen = 0;
      let median = 0;
      for (let value = 0; value < 256; value += 1) {
        seen += histogram[value];
        if (seen > half) { median = value; break; }
      }
      let busy = 0;
      for (const value of values) if (Math.abs(value - median) > 22) busy += 1;
      return busy / values.length <= BUSY_MAX;
    }
  }
  if (typeof module === 'object' && module.exports) module.exports = { detectControlRegions };
  else globalThis.detectControlRegions = detectControlRegions;
})();
