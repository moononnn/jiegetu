// 有界缩略预览：直接从已拼接的片段降采样，不复制整图、不调用 compose。
// 一次采样只读取目标网格需要的行与列，成本与累计高度无关。
export const PREVIEW_WIDTH = 240;
export const PREVIEW_HEIGHT = 480;
export const PREVIEW_MAX_BYTES = PREVIEW_WIDTH * PREVIEW_HEIGHT * 4;

/** 目标尺寸：宽不超过 maxWidth，高按整体比例缩放并受 maxHeight 限制。 */
export function previewSize(width, total, maxWidth = PREVIEW_WIDTH, maxHeight = PREVIEW_HEIGHT) {
  if (!Number.isInteger(width) || width < 1 || !Number.isFinite(total) || total < 1 ||
      !Number.isInteger(maxWidth) || maxWidth < 1 || !Number.isInteger(maxHeight) || maxHeight < 1) return null;
  const scale = Math.min(1, maxWidth / width, maxHeight / total);
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(total * scale)) };
}

/**
 * 把按文档顺序排列的片段画成一张小图。
 * parts 每项需要 {data, height}，宽度由调用方给出，必须与片段一致。
 * 返回 {data, width, height}；没有可用片段时返回 null。
 */
export function renderPreview(width, parts, { maxWidth = PREVIEW_WIDTH, maxHeight = PREVIEW_HEIGHT } = {}) {
  if (!Number.isInteger(width) || width < 1 || !Array.isArray(parts)) return null;
  const list = parts.filter(part => part && part.data && Number.isInteger(part.height) && part.height > 0 &&
    part.data.length >= part.height * width * 4);
  if (!list.length) return null;
  const total = list.reduce((sum, part) => sum + part.height, 0);
  const size = previewSize(width, total, maxWidth, maxHeight);
  if (!size) return null;
  const { width: outWidth, height: outHeight } = size;
  const data = new Uint8ClampedArray(outWidth * outHeight * 4);
  const columns = new Int32Array(outWidth);
  for (let x = 0; x < outWidth; x++) columns[x] = Math.min(width - 1, Math.floor(x * width / outWidth));
  let part = 0, partTop = 0, partBottom = list[0].height;
  for (let y = 0; y < outHeight; y++) {
    const sourceY = Math.min(total - 1, Math.floor(y * total / outHeight));
    while (sourceY >= partBottom && part + 1 < list.length) {
      part++; partTop = partBottom; partBottom = partTop + list[part].height;
    }
    const source = list[part].data, rowStart = (sourceY - partTop) * width * 4, target = y * outWidth * 4;
    for (let x = 0; x < outWidth; x++) {
      const from = rowStart + columns[x] * 4, to = target + x * 4;
      data[to] = source[from]; data[to + 1] = source[from + 1];
      data[to + 2] = source[from + 2]; data[to + 3] = source[from + 3];
    }
  }
  return { data, width: outWidth, height: outHeight, sourceHeight: total };
}
