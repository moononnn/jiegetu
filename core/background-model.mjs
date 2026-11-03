/**
 * 视口固定背景层（壁纸不随内容滚动）。
 *
 * 新增条永远来自视口底部，所以固定壁纸会被切成几十像素一条的碎片反复贴进长图，
 * 成图上就是「同一块背景被撕开重贴」的拼接感。这里把两次滚动之间完全没有变化的像素
 * 认作固定背景层收集起来，收尾时按帧高做镜像延展，把整条背景接成一条连续画面。
 *
 * 历史背景颜色和当前可写区域分开：移动遮挡不清空历史；静止异色冲突则停用。
 * 逐点路径要求邻域静止、多尺度纹理、连续观测及目标原色核对，排除占多数的纸面色。
 * 连续外侧带另要求每一接受帧的整列都静止、与首观察色一致，且无强竖向文字边缘；
 * 左右分布、至少三次确认、各不超过画幅20%；任一点有移动的列整轮不再重铺。
 * 这能改善背景覆盖，但不能把任意静止像素等同于壁纸，更不承诺任意界面全文保真。
 */
export const STATIC_TOLERANCE = 3;
export const AGREE_TOLERANCE = 6;
export const CONFIRMATIONS = 3;
export const TEXTURE_FLOOR = 4;
export const MIN_VALID_RATIO = .02;

/** 同时看近邻与四像素范围：保留柔和纹理，仍不把完全平坦的纸面当壁纸。 */
function texture(data, x, y, width, height) {
  const q = (y * width + x) * 4;
  let near = 0, wide = 0;
  for (let distance = 1; distance <= 4; distance += 3) {
    const right = (y * width + Math.min(width - 1, x + distance)) * 4;
    const down = (Math.min(height - 1, y + distance) * width + x) * 4;
    let best = 0;
    for (let c = 0; c < 3; c++) best = Math.max(best, Math.abs(data[q + c] - data[right + c]), Math.abs(data[q + c] - data[down + c]));
    if (distance === 1) near = best;
    wide = Math.max(wide, best);
  }
  return near >= 1 && wide >= TEXTURE_FLOOR;
}

export function createBackgroundModel(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError('无效背景模型尺寸');
  const pixels = width * height;
  return { width, height, data: new Uint8ClampedArray(pixels * 4), valid: new Uint8Array(pixels), streak: new Uint8Array(pixels), blocked: new Uint8Array(pixels), validCount: 0, blockedCount: 0,
    observations: 0, edgeData: null, movingColumns: new Uint8Array(width), edgeColumns: new Uint8Array(width).fill(1) };
}

/**
 * 用一对相邻采集帧更新背景层，并返回本次新增条（band）里「可以换成连续背景」的掩码。
 * 调用方只在确认滚动后调用；同坐标不动仅是候选，还需邻域、颜色和历史核对。
 * 掩码只表示当时的候选，不能单独授权覆盖；外侧整列由更强的跨全部观察证据控制。
 */
export function observeBackground(model, previous, current, band = null, checkBudget = null) {
  if (!model || !previous || !current) return null;
  const { width, height } = model;
  if (previous.width !== width || previous.height !== height || current.width !== width || current.height !== height) return null;
  const pixels = width * height;
  if (previous.data.length !== pixels * 4 || current.data.length !== pixels * 4) return null;
  const start = Number.isInteger(band?.start) ? Math.max(0, Math.min(height, band.start)) : 0;
  const rows = Number.isInteger(band?.rows) ? Math.max(0, Math.min(height - start, band.rows)) : 0;
  const mask = rows > 0 ? new Uint8Array(rows * width) : null;
  const prev = previous.data, cur = current.data, data = model.data, valid = model.valid, streak = model.streak;
  if (model.observations === 0) {
    model.data.set(previous.data);
    model.edgeData = new Uint8ClampedArray(previous.data);
  }
  model.observations++;
  // 协作式预算：入场、每 32 行像素/每 32 列/出口各查一次，不在逐像素热循环里调回调。
  checkBudget?.('background-observe');
  const stable = new Uint8Array(pixels), counts = new Uint32Array(4096);
  const colorBin = q => (cur[q] >> 4) * 256 + (cur[q + 1] >> 4) * 16 + (cur[q + 2] >> 4);
  const rowBlock = Math.max(1, width * 32);
  let nextCheck = rowBlock;
  for (let i = 0; i < pixels; i++) {
    if (i >= nextCheck) { checkBudget?.('background-observe'); nextCheck += rowBlock; }
    const q = i * 4;
    stable[i] = Math.abs(prev[q] - cur[q]) <= STATIC_TOLERANCE &&
      Math.abs(prev[q + 1] - cur[q + 1]) <= STATIC_TOLERANCE && Math.abs(prev[q + 2] - cur[q + 2]) <= STATIC_TOLERANCE;
    if (!stable[i]) model.movingColumns[i % width] = 1;
  }
  // 整列始终静止的外侧连续带，比单个纹理点有更强证据；中途出现内容即永久退出。
  for (let x = 0; x < width; x++) {
    if ((x & 31) === 0) checkBudget?.('background-observe');
    if (!model.edgeColumns[x]) continue;
    let min = 255, max = 0;
    for (let y = 0; y < height; y++) {
      const i = y * width + x, q = i * 4;
      if (!stable[i] || Math.abs(cur[q] - model.edgeData[q]) > AGREE_TOLERANCE ||
          Math.abs(cur[q + 1] - model.edgeData[q + 1]) > AGREE_TOLERANCE || Math.abs(cur[q + 2] - model.edgeData[q + 2]) > AGREE_TOLERANCE) {
        model.edgeColumns[x] = 0; break;
      }
      for (let c = 0; c < 3; c++) {
        min = Math.min(min, cur[q + c]); max = Math.max(max, cur[q + c]);
        if (y > 0 && Math.abs(cur[q + c] - cur[q - width * 4 + c]) > 24) model.edgeColumns[x] = 0;
      }
      if (!model.edgeColumns[x]) break;
    }
    // 完全平色无需重铺；强文字边缘也不纳入连续带。
    if (max - min < 8) model.edgeColumns[x] = 0;
  }
  for (let y = 0; y < height; y++) {
    if ((y & 31) === 0) checkBudget?.('background-observe');
    const inBand = mask && y >= start && y < start + rows;
    counts.fill(0);
    for (let x = 0; x < width; x++) counts[colorBin((y * width + x) * 4)]++;
    for (let x = 0; x < width; x++) {
      const i = y * width + x, q = i * 4;
      let still = Boolean(stable[i]);
      // 单点碰巧相等不能证明字形或气泡边缘静止，邻域也必须不动。
      for (let ny = Math.max(0, y - 1); still && ny <= Math.min(height - 1, y + 1); ny++) {
        for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
          if (!stable[ny * width + nx]) { still = false; break; }
        }
      }
      if (!still || model.blocked[i] || counts[colorBin(q)] > width / 2 || !texture(cur, x, y, width, height)) {
        // 移动遮挡只结束本次可见性，不抹掉先前学到的背景颜色。
        streak[i] = 0;
        continue;
      }
      const agree = (valid[i] || streak[i] > 0) && Math.abs(data[q] - cur[q]) <= AGREE_TOLERANCE &&
        Math.abs(data[q + 1] - cur[q + 1]) <= AGREE_TOLERANCE && Math.abs(data[q + 2] - cur[q + 2]) <= AGREE_TOLERANCE;
      if (valid[i] && !agree) {
        // 新的静止异色有歧义：本会话停用此点，不能让经过的气泡逐渐接管壁纸。
        valid[i] = 0; model.validCount--; model.blocked[i] = 1; model.blockedCount++; streak[i] = 0;
        continue;
      }
      if (inBand) mask[(y - start) * width + x] = 1;
      if (valid[i]) streak[i] = Math.min(255, streak[i] + 1);
      else if (agree) {
        streak[i] = Math.min(255, streak[i] + 1);
        if (streak[i] >= CONFIRMATIONS) { valid[i] = 1; model.validCount++; }
      } else {
        streak[i] = 1; data[q] = cur[q]; data[q + 1] = cur[q + 1]; data[q + 2] = cur[q + 2];
      }
    }
  }
  checkBudget?.('background-observe');
  return mask;
}

function continuousEdges(model) {
  const { width, edgeColumns, observations } = model;
  const cap = Math.floor(width * .2);
  let left = 0, right = 0;
  if (observations < CONFIRMATIONS) return { left, right, ready: false };
  while (left < cap && edgeColumns[left]) left++;
  while (right < cap && edgeColumns[width - 1 - right]) right++;
  return { left, right, ready: left >= 2 && right >= 2 && left + right >= Math.max(4, Math.floor(width * .03)) };
}

export function backgroundSummary(model) {
  const edges = model ? continuousEdges(model) : { ready: false, left: 0, right: 0 };
  return { enabled: Boolean(model), validPixels: model?.validCount ?? 0, blockedPixels: model?.blockedCount ?? 0,
    edgeColumns: edges.ready ? edges.left + edges.right : 0, extend: model?.extend ?? null };
}

export function backgroundReady(model) {
  if (!model) return false;
  if (continuousEdges(model).ready) return true;
  const { width, height, valid } = model;
  if (model.validCount < Math.max(64, Math.floor(width * height * MIN_VALID_RATIO))) return false;
  // 背景层得铺在整帧上：只有某个角落一块静止内容不算固定壁纸，不能拿来延展。
  const rowFloor = Math.max(2, Math.floor(width * .08));
  let rows = 0;
  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let x = 0; x < width; x++) if (valid[y * width + x]) count++;
    if (count >= rowFloor) rows++;
  }
  return rows >= Math.floor(height * .5);
}

/** 背景层源行：从视口底部继续往下，再折回来，接缝处只有一行重复，没有硬切。 */
export function mirrorSourceRow(docRow, height) {
  const period = Math.max(2, 2 * height - 2);
  const step = ((docRow - height) % period + period) % period;
  return step < height ? height - 1 - step : step - height + 1;
}

/**
 * 实际采样的源行：底部不避让，保证首屏下沿接得上；只在真检测到固定顶栏时
 * 才避开顶部那几行，免得把标题栏烤进背景。
 */
export function backgroundSourceRow(docRow, height, topGuard = 2) {
  const low = Math.max(1, Math.min(height - 4, Math.floor(Number.isFinite(topGuard) ? topGuard : 2)));
  const high = height - 2;
  return Math.max(low, Math.min(high, mirrorSourceRow(docRow, height)));
}

/**
 * 收尾前把新增条里的背景像素换成连续背景。只写掩码内、且模型确认可信的像素，
 * 正文、平滑区域与未确认的像素原样保留；源行避开上下边缘，防止把固定栏烤进背景。
 */
export function extendBackground(chunks, model, { seedHeight, topGuard = 2, checkBudget = null } = {}) {
  const list = Array.isArray(chunks) ? chunks : [];
  const result = { active: false, rows: 0, pixels: 0 };
  // 纯数值聚合：只为定位“为何没重铺”，不记图像、颜色、坐标或文件名，也不参与任何写入判断。
  const stats = { processed: false, chunks: list.length, invalidChunks: 0, movingPixels: 0, maskPixels: 0,
    targetInvalidPixels: 0, sourceInvalidPixels: 0, colorMismatchPixels: 0 };
  if (model) model.extend = stats;
  try {
    checkBudget?.('background-extend');
    if (!model || list.length < 2 || !Number.isInteger(seedHeight) || seedHeight !== model.height) return result;
    if (list[0]?.height !== seedHeight || !backgroundReady(model)) return result;
    const { width, height } = model;
    result.active = true; stats.processed = true;
    const data = model.data, valid = model.valid, edges = continuousEdges(model);
    let doc = seedHeight;
    for (let k = 1; k < list.length; k++) {
      checkBudget?.('background-extend');
      const chunk = list[k], mask = chunk.mask;
      if (!mask || !Number.isInteger(chunk.height) || chunk.height <= 0 || chunk.height > height ||
          !Number.isInteger(chunk.sourceStart) || chunk.sourceStart < 0 || chunk.sourceStart + chunk.height > height ||
          mask.length !== width * chunk.height || chunk.data.length !== width * chunk.height * 4) { stats.invalidChunks++; doc += chunk.height; continue; }
      for (let r = 0; r < chunk.height; r++, doc++) {
        if (((doc - seedHeight) & 31) === 0) checkBudget?.('background-extend');
        const local = backgroundSourceRow(doc, height, topGuard);
        const source = local * width, rowStart = r * width;
        let touched = 0;
        for (let x = 0; x < width; x++) {
          const target = (chunk.sourceStart + r) * width + x;
          const edge = edges.ready && (x < edges.left || x >= width - edges.right);
          // 某列曾承载移动内容，整列保留原像素；半透明纸面可能暂时静止，不能借此写回。
          if (model.movingColumns[x]) { stats.movingPixels++; continue; }
          if (!edge && (!mask[rowStart + x] || !valid[target] || !valid[source + x])) {
            if (!mask[rowStart + x]) stats.maskPixels++;
            else if (!valid[target]) stats.targetInvalidPixels++;
            else stats.sourceInvalidPixels++;
            continue;
          }
          const to = (rowStart + x) * 4, from = (source + x) * 4, expected = target * 4;
          const colors = edge ? model.edgeData : data;
          if (Math.abs(chunk.data[to] - colors[expected]) > AGREE_TOLERANCE ||
              Math.abs(chunk.data[to + 1] - colors[expected + 1]) > AGREE_TOLERANCE ||
              Math.abs(chunk.data[to + 2] - colors[expected + 2]) > AGREE_TOLERANCE) { stats.colorMismatchPixels++; continue; }
          chunk.data[to] = colors[from]; chunk.data[to + 1] = colors[from + 1]; chunk.data[to + 2] = colors[from + 2];
          touched++;
        }
        if (touched) { result.rows++; result.pixels += touched; }
      }
    }
    result.active = result.pixels > 0;
    checkBudget?.('background-extend');
    return result;
  } finally {
    for (const chunk of list) if (chunk.mask) chunk.mask = null;
  }
}

