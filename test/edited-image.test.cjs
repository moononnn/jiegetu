'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkEditSize, decodeEditedImage, expectedClipboardSize, resolveEditCrop } = require('../main/edited-image.cjs');
test('裁切矩形严格校验：只允许安全整数、非负原点、至少 1 像素、严格落在文档内', () => {
  const doc = { width: 400, height: 300 };
  assert.deepEqual(resolveEditCrop(doc, undefined), { width: 400, height: 300 }, '无 crop 就是原尺寸');
  assert.deepEqual(resolveEditCrop(doc, { x: 0, y: 0, width: 400, height: 300 }), { width: 400, height: 300 }, '裁成原尺寸合法');
  assert.deepEqual(resolveEditCrop(doc, { x: 10, y: 20, width: 100, height: 80 }), { width: 100, height: 80 });
  assert.deepEqual(resolveEditCrop(doc, { x: 0, y: 0, width: 1, height: 1 }), { width: 1, height: 1 });
  assert.deepEqual(resolveEditCrop(doc, { x: 300, y: 220, width: 100, height: 80 }), { width: 100, height: 80 }, '恰好贴边合法');

  const bad = [null, 0, '', [], [10, 20, 100, 80], {}, { x: 0, y: 0, width: 0, height: 10 },
    { x: 0, y: 0, width: 10, height: 0 }, { x: -1, y: 0, width: 10, height: 10 },
    { x: 1.5, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 10.5, height: 10 },
    { x: 0, y: 0, width: '10', height: 10 }, { x: 0, y: 0, width: NaN, height: 10 },
    { x: 0, y: 0, width: 10, height: Infinity }, { x: 391, y: 0, width: 10, height: 10 },
    { x: 0, y: 291, width: 10, height: 10 }, { x: 0, y: 0, width: 401, height: 10 },
    { x: 0, y: 0, width: 10, height: 301 }, { x: Number.MAX_SAFE_INTEGER, y: 0, width: 1, height: 1 }];
  for (const crop of bad) assert.throws(() => resolveEditCrop(doc, crop), /未输出原图/, `应拒绝：${JSON.stringify(crop)}`);
  // 文档本身无效也不能靠裁切绕过容量守卫。
  assert.throws(() => resolveEditCrop({ width: 0, height: 10 }, undefined), /容量/);
  assert.throws(() => resolveEditCrop(undefined, { x: 0, y: 0, width: 1, height: 1 }), /容量/);
  // 裁后尺寸仍受编辑容量约束（4001×4000 超 1600 万）。
  assert.throws(() => resolveEditCrop({ width: 5000, height: 4000 }, { x: 0, y: 0, width: 4001, height: 4000 }), /容量/);
});
function header(width=20,height=30) {
  const bytes=Buffer.alloc(33);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(width,16);bytes.writeUInt32BE(height,20);return bytes;
}
test('编辑容量独立守界，不扩大截图原有额度',()=>{
  checkEditSize({width:4000,height:4000});checkEditSize({width:1,height:30000});
  for(const size of [undefined,{width:0,height:1},{width:NaN,height:2},{width:1.5,height:2},{width:1,height:30001},{width:4001,height:4000}])assert.throws(()=>checkEditSize(size),/容量/);
});
test('复制说明尺寸：只容许固定补白宽度，不缩短原图且不扩大容量',()=>{
  assert.deepEqual(expectedClipboardSize({width:200,height:150},{width:720,height:350}),{width:720,height:350});
  assert.deepEqual(expectedClipboardSize({width:900,height:600},{width:900,height:800}),{width:900,height:800});
  for(const size of [null,{}, {width:721,height:350},{width:720,height:149},{width:720,height:350.5}, {width:720,height:30001},{width:720,height:29000}]) {
    assert.throws(()=>expectedClipboardSize({width:200,height:150},size));
  }
});
test('复制说明尺寸：可选 insetWidth 只接受安全正整数且不超原图 2 倍，宽度必须精确对上', () => {
  const doc = { width: 600, height: 400 };
  // 旧规矩不变：没有 insetWidth 就必须正好是 max(600, 720)。
  assert.deepEqual(expectedClipboardSize(doc, { width: 720, height: 500 }), { width: 720, height: 500 });
  assert.throws(() => expectedClipboardSize(doc, { width: 1040, height: 500 }), /不符/);
  // 放大图 1000 宽 + 左右各 20。
  assert.deepEqual(expectedClipboardSize(doc, { width: 1040, height: 500, insetWidth: 1000 }), { width: 1040, height: 500 });
  // 声明了但没撑宽旧画布：宽度仍按旧规则，不接受任意加宽。
  assert.deepEqual(expectedClipboardSize(doc, { width: 720, height: 500, insetWidth: 680 }), { width: 720, height: 500 });
  assert.throws(() => expectedClipboardSize(doc, { width: 1040, height: 500, insetWidth: 999 }), /不符/);
  // 正好 2× 原图宽合法；再多 1 像素就拒。
  assert.deepEqual(expectedClipboardSize(doc, { width: 1240, height: 500, insetWidth: 1200 }), { width: 1240, height: 500 });
  for (const insetWidth of [0, -1, 1.5, '1000', NaN, Infinity, 1201, 600 * 2 + 1]) {
    assert.throws(() => expectedClipboardSize(doc, { width: 1240, height: 500, insetWidth }), /未输出原图/, `应拒绝 insetWidth=${insetWidth}`);
  }
  assert.throws(() => expectedClipboardSize(doc, { width: 1240, height: 399, insetWidth: 1200 }), /高度/, '高度仍不得小于原图');
  // 扩宽后的画布同样受编辑容量约束，不靠放大绕过。
  assert.throws(() => expectedClipboardSize(doc, { width: 1240, height: 30000, insetWidth: 1200 }), /容量/);
  // 文档本身无效时不能靠 insetWidth 得救。
  assert.throws(() => expectedClipboardSize(undefined, { width: 720, height: 500 }), /未输出原图/);
  assert.throws(() => expectedClipboardSize({ width: 600.5, height: 400 }, { width: 720, height: 500, insetWidth: 700 }), /未输出原图/);
});
test('编辑PNG可接受有偏移的字节视图，校验前不复制大缓冲',()=>{
  const padded=Buffer.concat([Buffer.alloc(9),header(),Buffer.alloc(7)]);let decoded;
  const result=decodeEditedImage(padded.subarray(9,-7),{width:20,height:30},{createFromBuffer:bytes=>{decoded=bytes;return{isEmpty:()=>false,getSize:()=>({width:20,height:30})};}});
  assert.equal(decoded.length,33);assert.equal(decoded.readUInt32BE(16),20);assert.equal(result.isEmpty(),false);
});
test('编辑PNG的头、类型、尺寸和真实解码均失败关闭，不返回原图',()=>{
  const expected={width:20,height:30}, image={createFromBuffer:()=>{throw new Error('not reached');}};
  const signature=header();signature[0]=0;const ihdr=header();ihdr.write('IDAT',12);
  for(const value of [undefined,{},new Array(33).fill(0),new Uint16Array(33),new DataView(new ArrayBuffer(33)),signature,ihdr,header(21,30)])assert.throws(()=>decodeEditedImage(value,expected,image),/未输出原图/);
  assert.throws(()=>decodeEditedImage(header(),expected,{createFromBuffer:()=>({isEmpty:()=>true})}),/未输出原图/);
  assert.throws(()=>decodeEditedImage(header(),expected,{createFromBuffer:()=>({isEmpty:()=>false,getSize:()=>({width:20,height:31})})}),/未输出原图/);
});

// 长图统一编码的容量底线：长截图上限 1600 万像素、高 ≤ 30000，未编辑直出也走同一套解码校验。
// 按 PNG 规范算最坏体积（不做压缩假设）：16M RGBA = 64,000,000 字节 + 30,000 行扫描线 filter，
// zlib stored 块最坏 ≈ 64.06MB，低于 68MiB（71,303,168 字节）；Canvas 重编码也不会携入外来 metadata。
test('长图最坏 PNG 体积仍小于 68MiB 编辑上限：不缩减未编辑长图导出', () => {
  const { MAX_EDIT_BYTES } = require('../main/edited-image.cjs');
  const pixels = 16_000_000;
  const height = 30_000;                       // scrolling.cjs 的 MAX_HEIGHT
  const scanline = height;                     // 每行 1 字节 filter
  const raw = pixels * 4 + scanline;
  const blocks = Math.ceil(raw / 65535);       // zlib stored 块最坏 5 字节/块
  const worst = raw + blocks * 5 + 2 + 4 + 25 + 12 + 12;
  assert.equal(raw, 64_030_000, '16M RGBA + 扫描线');
  assert.ok(worst < 64.1 * 1024 * 1024, `最坏体积 ${worst} 应在 64.1MiB 以内`);
  assert.equal(MAX_EDIT_BYTES, 68 * 1024 * 1024, '守卫保持 68MiB，不放大');
  assert.ok(MAX_EDIT_BYTES - worst > 6 * 1024 * 1024, '留出至少 6MiB 余量');
  // 真的超过上限时仍然明确拒绝，不静默降级。
  const oversized = new Uint8Array(MAX_EDIT_BYTES + 1);
  assert.throws(() => decodeEditedImage(oversized, { width: 20, height: 30 }, { createFromBuffer: () => { throw new Error('不应解码'); } }), /过大/);
});
