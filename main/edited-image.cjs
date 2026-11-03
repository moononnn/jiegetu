'use strict';
// Only the finished image crosses this boundary; capture/scrolling never consumes editor data.
const MAX_EDIT_PIXELS = 16_000_000;
const MAX_EDIT_BYTES = 68 * 1024 * 1024;
function checkEditSize(size) {
  if (!size || !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) ||
      size.width < 1 || size.height < 1 || size.width > 30000 || size.height > 30000 ||
      size.width * size.height > MAX_EDIT_PIXELS) throw new Error('图片超出编辑容量，原图仍可直接保存或复制');
}
function decodeEditedImage(png, expected, nativeImage) {
  checkEditSize(expected);
  if (!ArrayBuffer.isView(png) || png.BYTES_PER_ELEMENT !== 1 || png.byteLength < 33 || png.byteLength > MAX_EDIT_BYTES) {
    throw new Error('编辑图片数据无效或过大，未输出原图');
  }
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      bytes.readUInt32BE(16) !== expected.width || bytes.readUInt32BE(20) !== expected.height) {
    throw new Error('编辑图片格式或尺寸不符，未输出原图');
  }
  const result = nativeImage.createFromBuffer(bytes);
  if (result.isEmpty() || result.getSize().width !== expected.width || result.getSize().height !== expected.height) {
    throw new Error('编辑图片未能完整解码，未输出原图');
  }
  return result;
}
// 复制时的说明区宽度底：窄图右侧补白，原图仍在 (0, 0)，不缩放。
const MIN_CLIPBOARD_WIDTH = 720;
// 附局部放大时，放大图两侧各留 20 像素白边，所以画布宽要多出 40。
const INSET_MARGIN = 20;
// 复制成图比原图多一块说明区：尺寸由页面声明，但必须在主进程这边重算出同一条尺寸，
// 不接受任意值（宽度必须正好是 max(原图宽, 720, 放大宽+40)，高度不得小于原图），再走同一套容量校验。
// insetWidth 是唯一可选字段（只有局部放大真的把画布撑宽时页面才带）：仍必须是安全正整数、
// 不超过原图宽度的 2 倍（放大固定 2×），且 width 要与它一起精确对上，不接受宽度区间。
function expectedClipboardSize(doc, size) {
  if (!doc || !Number.isSafeInteger(doc.width) || !Number.isSafeInteger(doc.height)) throw new Error('编辑图尺寸无效，未输出原图');
  if (!size || typeof size !== 'object' || !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height)) {
    throw new Error('复制尺寸声明无效，未输出原图');
  }
  const baseWidth = Math.max(doc.width, MIN_CLIPBOARD_WIDTH);
  if (size.insetWidth !== undefined) {
    if (!Number.isSafeInteger(size.insetWidth) || size.insetWidth < 1 || size.insetWidth > doc.width * 2) {
      throw new Error('局部放大宽度声明无效，未输出原图');
    }
  }
  const width = size.insetWidth === undefined ? baseWidth : Math.max(baseWidth, size.insetWidth + INSET_MARGIN * 2);
  if (size.width !== width) throw new Error('复制宽度与编辑图不符，未输出原图');
  if (size.height < doc.height) throw new Error('复制高度小于编辑图，未输出原图');
  const expected = { width: size.width, height: size.height };
  checkEditSize(expected);
  return expected;
}
// 裁切矩形：页面声明当前画面在源图里的绝对矩形，但主进程不能信任意 editedSize。
// 只允许安全整数、原点不为负、至少 1 像素、严格落在文档内（只裁小不放大）；无 crop 视为原尺寸。
function resolveEditCrop(doc, crop) {
  checkEditSize(doc);
  if (crop === undefined) return { width: doc.width, height: doc.height };
  if (!crop || typeof crop !== 'object' || Array.isArray(crop)) throw new Error('裁切范围无效，未输出原图');
  const { x, y, width, height } = crop;
  if (![x, y, width, height].every(Number.isSafeInteger)) throw new Error('裁切范围必须是整数像素，未输出原图');
  if (x < 0 || y < 0 || width < 1 || height < 1) throw new Error('裁切范围无效，未输出原图');
  if (x + width > doc.width || y + height > doc.height) throw new Error('裁切范围超出原图，未输出原图');
  const size = { width, height };
  checkEditSize(size);
  return size;
}
module.exports = { checkEditSize, decodeEditedImage, expectedClipboardSize, resolveEditCrop, MIN_CLIPBOARD_WIDTH, MAX_EDIT_BYTES };
