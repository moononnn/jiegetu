/**
 * 文档环证据（第一阶段）：只产出「支持性证据」，不授权任何写入、不参与修补门禁。
 *
 * 环 = 待修补框外侧一圈采样点。每个点先分类：
 * - document：同一屏幕位置跨帧确有变化（不是屏幕固定层），且至少另一个不同 offset 的原帧在
 *   文档位移处 RGBA 完全一致（证明该点随文档滚动）。只有这一类进入分母。
 * - fixed：所有保留帧在同一屏幕坐标完全一致——只是静态/屏幕固定候选，不能证明 document。
 * - unknown：其余（证据不足、越界、被遮挡、文档处不一致）。
 *
 * 判定要求：
 * - 保留集必须是有效、与 target 同尺寸的原帧；否则直接 invalid-input（不做半途解引用）。
 * - 第三方见证必须同时不同于 target 与 source 的 offset；复制一份同 offset 的帧不能冒充。
 * - 环上 target / source / 见证点被已知遮挡盖住就记 unknown。
 * - 零容忍：本阶段任何 unknown 都让证据作废（reason='unknown-evidence'），不造可调比例。
 * - document 样本 ≥ 12、与来源逐通道（含 alpha）一致的比例 ≥ 95%、x/y 两方向都有分布、
 *   ≥ 4 个纹理点；再显式跑 ±1、±8 错位对照，任意对照也达到同一门槛即拒为 ambiguous。
 * - 采样有界：每边向上取整到最多 12 个位置，总数 ≤ 48。
 * 不启用共模补偿；只读调用方传入的现有原帧对象，不分配全帧位图、不读任何夹具常量、不改像素。
 */
export const RING_MIN_SAMPLES = 12;
export const RING_MIN_MATCH = .95;
export const RING_MIN_DETAILED = 4;
export const RING_CONTROLS = Object.freeze([-8, -1, 1, 8]);
// 每条边最多 12 个采样位置：与既有 ringMatches 同阶，总量有界（≤48 点）。
const SAMPLES_PER_SIDE = 12;
// 纹理点门槛与既有 ringMatches 的 detailed 判据一致。
const TEXTURE_STEP = 12;

const isRecord = value => Boolean(value) && Number.isInteger(value.offset) && Boolean(value.image) &&
  Number.isInteger(value.image.width) && Number.isInteger(value.image.height) &&
  value.image.width > 0 && value.image.height > 0 && ArrayBuffer.isView(value.image.data) &&
  value.image.data.length === value.image.width * value.image.height * 4;
const isBox = box => Boolean(box) && ['top', 'bottom', 'left', 'right'].every(key => Number.isInteger(box[key])) &&
  box.bottom > box.top && box.right > box.left;
const gray = (data, width, x, y) => { const i = (y * width + x) * 4; return (data[i] + data[i + 1] + data[i + 2]) / 3; };
function textured(data, width, height, x, y) {
  const value = gray(data, width, x, y);
  return Math.max(Math.abs(value - gray(data, width, Math.max(0, x - 1), y)),
    Math.abs(value - gray(data, width, x, Math.max(0, y - 1)))) >= TEXTURE_STEP;
}
const equal = (a, i, b, j) => a[i] === b[j] && a[i + 1] === b[j + 1] && a[i + 2] === b[j + 2] && a[i + 3] === b[j + 3];

export function inspectDocumentRing({ target, source, retained, rect, layout, blocked, guard } = {}) {
  const stats = { sampled: 0, samples: 0, fixedSamples: 0, unknownSamples: 0, matched: 0, detailed: 0 };
  // reason 只供调用方分支，不进诊断、不写日志。
  const done = (reason, supported = false) => ({ supported, ...stats, reason });
  if (!isRecord(target) || !isRecord(source) || !Array.isArray(retained) || !isBox(rect) || !isBox(layout)) return done('invalid-input');
  if (!retained.includes(target) || !retained.includes(source)) return done('retained-missing');
  // 保留集必须全是有效且与 target 同几何的原帧；不能先 filter 计数、后面再解引用。
  for (const record of retained) {
    if (!isRecord(record) || record.image.width !== target.image.width || record.image.height !== target.image.height) return done('invalid-input');
  }
  if (new Set(retained.map(record => record.offset)).size < 3) return done('offset-count');
  const width = target.image.width, height = target.image.height;
  const sourceWidth = source.image.width, sourceHeight = source.image.height;
  const boxHeight = rect.bottom - rect.top, boxWidth = rect.right - rect.left;
  // 干净来源的定义：同一块正文在屏幕上完全错开。
  const dy = target.offset - source.offset;
  if (Math.abs(dy) < boxHeight + 2) return done('offset-closer');
  const sourceTop = rect.top + dy;
  if (rect.left < layout.left || rect.right > layout.right || sourceTop < layout.top || sourceTop + boxHeight > layout.bottom) return done('source-outside');
  if (rect.top < 0 || rect.bottom > height || rect.left < 0 || rect.right > width ||
      sourceTop < 0 || sourceTop + boxHeight > sourceHeight || rect.right > sourceWidth) return done('source-outside');
  // 来源整框任何一处被已知遮挡覆盖就整块拒，不做逐像素修补判断。
  if (typeof blocked === 'function' && blocked(source, { top: sourceTop, bottom: sourceTop + boxHeight, left: rect.left, right: rect.right })) return done('blocked-source');

  // 采样有界：向上取整保证每条边最多 12 个位置，总数最多 48（宽 23 这类不能退化成 23 个）。
  const targetData = target.image.data, sourceData = source.image.data;
  const points = [];
  const stepX = Math.max(1, Math.ceil(boxWidth / SAMPLES_PER_SIDE)), stepY = Math.max(1, Math.ceil(boxHeight / SAMPLES_PER_SIDE));
  for (let x = rect.left; x < rect.right; x += stepX) { points.push([x, rect.top - 2]); points.push([x, rect.bottom + 1]); }
  for (let y = rect.top; y < rect.bottom; y += stepY) { points.push([rect.left - 2, y]); points.push([rect.right + 1, y]); }
  stats.sampled = points.length;

  const spreadX = new Set(), spreadY = new Set(), documents = [];
  for (const [x, y] of points) {
    guard?.('ring-matches');
    const sourceY = y + dy;
    if (x < layout.left || x >= layout.right || y < layout.top || y >= layout.bottom ||
        x < 0 || x >= width || y < 0 || y >= height || x >= sourceWidth || sourceY < layout.top || sourceY >= layout.bottom || sourceY < 0 || sourceY >= sourceHeight) { stats.unknownSamples++; continue; }
    // 环上的 target / source 点自己也得没被已知遮挡盖住，否则证据算 unknown。
    if (typeof blocked === 'function' &&
        (blocked(target, { top: y, bottom: y + 1, left: x, right: x + 1 }) ||
         blocked(source, { top: sourceY, bottom: sourceY + 1, left: x, right: x + 1 }))) { stats.unknownSamples++; continue; }
    const ti = (y * width + x) * 4;
    let moved = false, still = true, document = false;
    for (const frame of retained) {
      if (frame === target) continue;
      guard?.('ring-matches');
      const fw = frame.image.width, fh = frame.image.height, data = frame.image.data;
      if (x >= fw || y >= fh) { still = false; continue; }
      const fi = (y * fw + x) * 4;
      if (!equal(data, fi, targetData, ti)) { moved = true; still = false; }
      // 第三方见证必须同时不同于 target 与 source 的 offset：复制一份同 offset 的对象不能冒充。
      // 被遮挡的原帧也不算见证。
      if (frame.offset === target.offset || frame.offset === source.offset) continue;
      const frameY = y + (target.offset - frame.offset);
      if (frameY < layout.top || frameY >= layout.bottom || frameY < 0 || frameY >= fh || x >= fw) continue;
      if (typeof blocked === 'function' && blocked(frame, { top: frameY, bottom: frameY + 1, left: x, right: x + 1 })) continue;
      if (equal(data, (frameY * fw + x) * 4, targetData, ti)) document = true;
    }
    // 同屏跨帧完全一致：只能算静态候选，既不能证明 document，也不能靠排除 unknown 自证。
    if (!moved) { if (still) stats.fixedSamples++; else stats.unknownSamples++; continue; }
    if (!document) { stats.unknownSamples++; continue; }
    stats.samples++;
    documents.push([x, sourceY, ti]);
    if (equal(sourceData, (sourceY * sourceWidth + x) * 4, targetData, ti)) {
      stats.matched++; spreadX.add(x); spreadY.add(y);
      if (textured(sourceData, sourceWidth, sourceHeight, x, sourceY)) stats.detailed++;
    }
  }
  // 零容忍：本阶段任何未能分类的采样点都让证据作废（不做可调比例）。
  if (stats.unknownSamples > 0) return done('unknown-evidence');
  if (stats.samples < RING_MIN_SAMPLES || stats.matched < RING_MIN_SAMPLES) return done('insufficient-samples');
  if (stats.matched / stats.samples < RING_MIN_MATCH) return done('match-rate');
  if (spreadX.size < 2 || spreadY.size < 2) return done('distribution');
  if (stats.detailed < RING_MIN_DETAILED) return done('texture');
  // 错位对照：越界一律算不一致，不能靠把样本移出画面换来 100%。
  for (const delta of RING_CONTROLS) {
    let hits = 0;
    for (const [x, sourceY, ti] of documents) {
      guard?.('ring-matches');
      const shifted = sourceY + delta;
      if (shifted < layout.top || shifted >= layout.bottom || shifted < 0 || shifted >= sourceHeight || x >= sourceWidth) continue;
      if (equal(sourceData, (shifted * sourceWidth + x) * 4, targetData, ti)) hits++;
    }
    if (hits / documents.length >= RING_MIN_MATCH) return done('ambiguous');
  }
  return done('ok', true);
}

/** 整框双源分支的像素上限：复用模板总点预算 262144，不抬高旧预算。 */
export const REPAIR_MAX_PIXELS = 262144;

// 同一文档坐标的两个整框逐字节比较（含 alpha）。按行与每 1024 点查预算，一旦超支直接抛。
function sameDocumentBox(a, aTop, b, bTop, rect, rows, guard) {
  const width = rect.right - rect.left, aw = a.image.width, bw = b.image.width;
  const ad = a.image.data, bd = b.image.data;
  for (let r = 0; r < rows; r++) {
    guard?.('ring-matches');
    const ai = ((aTop + r) * aw + rect.left) * 4, bi = ((bTop + r) * bw + rect.left) * 4;
    for (let c = 0; c < width; c++) {
      if ((c & 1023) === 0) guard?.('ring-matches');
      const p = ai + c * 4, q = bi + c * 4;
      if (ad[p] !== bd[q] || ad[p + 1] !== bd[q + 1] || ad[p + 2] !== bd[q + 2] || ad[p + 3] !== bd[q + 3]) return false;
    }
  }
  return true;
}

/**
 * 文档修补来源查询（只返回 retained 里的原始记录对象或 null；绝不返回新对象、绝不改像素）。
 *
 * 除了环证据（inspectDocumentRing 支持），还要求两张不同 offset、都与 target 完全错开、
 * 整框未被遮挡的现存原帧，在**同一文档坐标**的整框 RGBA 逐字节一致。
 * 但这只是**支持性条件，不能单独证明语义干净**：两张来源在不同屏幕行上各自压着同样的
 * 未识别固定 UI 时，整框字节也会一致（实测会被接受）。调用方不得把返回结果当作“已证干净”，
 * 会话侧会把这类实验性修补永久封死检查点。任何一方字节/alpha 不同就整份放弃，不做部分填入。
 * 整框面积超过 REPAIR_MAX_PIXELS 直接拒；比较过程中 guard 抛出原样上抛。
 */
export function findDocumentRepairSource({ target, retained, rect, layout, blocked, guard } = {}) {
  if (!isRecord(target) || !Array.isArray(retained) || !isBox(rect) || !isBox(layout)) return null;
  if (!retained.includes(target)) return null;
  const boxWidth = rect.right - rect.left, boxHeight = rect.bottom - rect.top;
  if (boxWidth * boxHeight > REPAIR_MAX_PIXELS) return null;
  if (rect.left < layout.left || rect.right > layout.right) return null;
  if (rect.top < 0 || rect.bottom > target.image.height) return null;
  const candidates = [];
  for (const record of retained) {
    if (record === target || !isRecord(record)) continue;
    if (record.image.width !== target.image.width || record.image.height !== target.image.height) continue;
    if (record.offset === target.offset) continue;
    if (Math.abs(target.offset - record.offset) < boxHeight + 2) continue;
    const top = rect.top + target.offset - record.offset;
    if (top < layout.top || top + boxHeight > layout.bottom) continue;
    if (top < 0 || top + boxHeight > record.image.height) continue;
    if (typeof blocked === 'function' && blocked(record, { top, bottom: top + boxHeight, left: rect.left, right: rect.right })) continue;
    candidates.push({ record, top });
  }
  for (const first of candidates) {
    if (!inspectDocumentRing({ target, source: first.record, retained, rect, layout, blocked, guard }).supported) continue;
    for (const second of candidates) {
      if (second.record === first.record || second.record.offset === first.record.offset) continue;
      if (!inspectDocumentRing({ target, source: second.record, retained, rect, layout, blocked, guard }).supported) continue;
      if (!sameDocumentBox(first.record, first.top, second.record, second.top, rect, boxHeight, guard)) continue;
      // 两张整框已逐字节证完才交出第一个来源；调用方只能拿它去写这张框。
      return first.record;
    }
  }
  return null;
}
