// Lightweight displacement estimate from sparse local features.
//
// Only pixels that actually changed between the two frames are used as evidence, so a fixed
// wallpaper, a fixed bar or a static illustration neither votes nor vetoes. Every candidate shift
// accumulates support over the same feature set, normalised by the number of features still usable
// at that shift (boundary shifts cannot win by attrition). Near ties are kept and reported as
// ambiguous instead of picking a winner.
//
// Auxiliary candidate only: it estimates displacement, never permission to append pixels. The
// automatic session must still verify original-pixel support, loop closure, layout and occlusions.

const MAX_PIXELS = 16_000_000;
const MIN_WIDTH = 16;
const MIN_HEIGHT = 48;
const FEATURE_MIN_DIFF = 4;      // a pixel that did not change carries no motion evidence
const FEATURE_MIN_EDGE = 20;     // local structure worth matching
const BAND_COUNT = 10;
const MAX_FEATURES_PER_BAND = 14;
const MIN_USABLE_FRACTION = .5;  // a shift must keep enough usable features to be comparable
const BAND_KEEP_RATIO = .8;      // keep near-tie shifts inside a band, not only its winner
const MIN_BAND_SUPPORT = .25;
const MIN_BAND_VOTES = 3;
const MIN_PEAK_SUPPORT = .35;
const NEAR_TIE_RATIO = .75;      // global: shifts this close to the peak are ambiguous, not a winner
const MIN_BAND_AGREEMENT = .5;
const MIN_VOTING_BANDS = 3;      // count only bands supporting the final candidate
const MIN_VOTE_SPAN = .45;       // those supporting bands must span this much of the image height
const MIN_TOTAL_FEATURES = 24;  // actually matching features supporting that same candidate
const SHIFT_LIMIT = .65;

function assertFrame(frame, label) {
  if (!frame || typeof frame !== 'object') throw new RangeError(`${label} 不是有效画面`);
  const { data, width, height } = frame;
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new RangeError(`${label} 宽高必须是整数`);
  if (width < MIN_WIDTH || height < MIN_HEIGHT) throw new RangeError(`${label} 至少需要 ${MIN_WIDTH} × ${MIN_HEIGHT} 像素`);
  if (!Number.isSafeInteger(width * height) || width * height > MAX_PIXELS) throw new RangeError(`${label} 超过像素上限`);
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.length !== width * height * 4) {
    throw new RangeError(`${label} 像素缓冲长度不符`);
  }
}

function toGray(frame) {
  const { data, width, height } = frame;
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  return gray;
}

// High-pass detail: removes smooth wallpaper/paper blends so matching keys on stroke structure.
function highPass(gray, width, height) {
  const detail = new Int16Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      detail[i] = gray[i] - ((gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width]) >> 2);
    }
  }
  return detail;
}

// One feature per column bucket, strongest first, so votes spread across columns instead of a stripe.
function pickFeatures(grayA, grayB, detailB, width, height, y0, y1) {
  const bucket = Math.max(1, Math.floor(width / 16));
  const best = new Map();
  for (let y = y0 + 1; y < y1 - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (Math.abs(grayA[i] - grayB[i]) < FEATURE_MIN_DIFF) continue;
      const edge = Math.abs(detailB[i]) + Math.abs(detailB[i - 1]) + Math.abs(detailB[i + 1]);
      if (edge < FEATURE_MIN_EDGE) continue;
      const key = Math.floor(x / bucket);
      const current = best.get(key);
      if (!current || edge > current.edge) best.set(key, { x, y, edge });
    }
  }
  return [...best.values()].sort((p, q) => q.edge - p.edge).slice(0, MAX_FEATURES_PER_BAND);
}

const empty = { shift: 0, nearTies: [], votingBands: 0, bandAgreement: 0, featureCount: 0, support: 0 };

export function estimateFeatureMotion(a, b) {
  assertFrame(a, '画面 A');
  assertFrame(b, '画面 B');
  if (a.width !== b.width || a.height !== b.height) return { ...empty, kind: 'invalid' };
  const width = a.width, height = a.height;
  const grayA = toGray(a), grayB = toGray(b);
  let differing = 0;
  for (let i = 0; i < grayA.length; i++) if (Math.abs(grayA[i] - grayB[i]) > FEATURE_MIN_DIFF) differing++;
  if (!differing) return { ...empty, kind: 'still' };

  const detailA = highPass(grayA, width, height), detailB = highPass(grayB, width, height);
  const limit = Math.floor(height * SHIFT_LIMIT);
  const bandHeight = Math.max(1, Math.floor(height / BAND_COUNT));
  const curve = new Float64Array(2 * limit + 1);
  const bandKept = [];
  let featureCount = 0;

  for (let band = 0; band < BAND_COUNT; band++) {
    const y0 = band * bandHeight;
    const y1 = band === BAND_COUNT - 1 ? height : y0 + bandHeight;
    if (y1 - y0 < 3) continue;
    const features = pickFeatures(grayA, grayB, detailB, width, height, y0, y1);
    featureCount += features.length;
    if (!features.length) continue;
    const matches = new Int32Array(2 * limit + 1), usable = new Int32Array(2 * limit + 1);
    for (const feature of features) {
      const b0 = feature.y * width + feature.x;
      const tolerance = Math.max(20, .5 * Math.abs(detailB[b0]));
      for (let d = -limit; d <= limit; d++) {
        const ay = feature.y + d;
        if (ay < 1 || ay >= height - 1) continue;
        usable[d + limit]++;
        const a0 = ay * width + feature.x;
        const error = Math.abs(detailA[a0] - detailB[b0]) + Math.abs(detailA[a0 - 1] - detailB[b0 - 1]) +
          Math.abs(detailA[a0 + 1] - detailB[b0 + 1]);
        if (error <= tolerance) matches[d + limit]++;
      }
    }
    const support = new Float64Array(2 * limit + 1);
    const minUsable = Math.max(MIN_BAND_VOTES, Math.ceil(features.length * MIN_USABLE_FRACTION));
    let peakSupport = 0, peakIndex = -1;
    for (let i = 0; i < support.length; i++) {
      if (usable[i] < minUsable) continue;
      support[i] = matches[i] / usable[i];
      if (support[i] > peakSupport) { peakSupport = support[i]; peakIndex = i; }
    }
    if (peakIndex < 0 || peakSupport < MIN_BAND_SUPPORT || matches[peakIndex] < MIN_BAND_VOTES) continue;
    const kept = [];
    for (let i = 0; i < support.length; i++) {
      if (support[i] > 0 && support[i] >= peakSupport * BAND_KEEP_RATIO) { curve[i] += support[i]; kept.push(i - limit); }
    }
    if (kept.length) bandKept.push({ band, kept, matches });
  }

  const votingBands = bandKept.length;
  const ranked = [];
  for (let i = 0; i < curve.length; i++) {
    if (curve[i] > 0) ranked.push({ shift: i - limit, support: curve[i] / Math.max(1, votingBands) });
  }
  ranked.sort((x, y) => y.support - x.support);
  const peak = ranked[0];
  if (!peak) return { ...empty, kind: 'unmatched', featureCount, votingBands };
  const nearTies = ranked.filter(item => item.support >= peak.support * NEAR_TIE_RATIO).map(item => item.shift);
  const supporting = bandKept.filter(item => item.kept.includes(peak.shift));
  const bandAgreement = supporting.length / votingBands;
  const votedSpan = supporting.length ? (Math.max(...supporting.map(item => item.band)) - Math.min(...supporting.map(item => item.band)) + 1) / BAND_COUNT : 0;
  const supportedFeatures = supporting.reduce((sum,item)=>sum+item.matches[peak.shift+limit],0);
  const report = { shift: 0, nearTies, votingBands, bandAgreement: +bandAgreement.toFixed(3), featureCount,
    support: +peak.support.toFixed(3) };

  // Distribution floor: one small animated corner must not become whole-page motion.
  if (supportedFeatures < MIN_TOTAL_FEATURES || supporting.length < MIN_VOTING_BANDS || votedSpan < MIN_VOTE_SPAN) {
    return { ...report, kind: 'unmatched' };
  }
  if (peak.shift === 0) return { ...report, kind: 'still' };
  if (peak.support < MIN_PEAK_SUPPORT || nearTies.length > 1 || bandAgreement < MIN_BAND_AGREEMENT) {
    return { ...report, kind: 'ambiguous' };
  }
  return { ...report, kind: 'motion', shift: peak.shift };
}
