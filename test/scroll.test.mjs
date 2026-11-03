import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, detectShift, newRows, compose, MAX_PIXELS } from '../core/scroll.mjs';

const width = 96, height = 180;
function page(w = width, h = 600) {
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 731;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const i = (y * w + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = seed >>> 24;
    data[i + 3] = 255;
  }
  return data;
}
const document = page();
const frame = offset => ({ width, height, data: document.slice(offset * width * 4, (offset + height) * width * 4) });

test('修复基线：固定顶部加可靠尾部重叠可以接长，双固定与薄底部不放行', () => {
  for (const footerRows of [0, 2, 12]) {
    const a = frame(0), b = frame(28);
    b.data.set(a.data.subarray(0, 8 * width * 4), 0);
    if (footerRows) b.data.set(a.data.subarray((height - footerRows) * width * 4), (height - footerRows) * width * 4);
    const result = detectShift(fingerprint(a), fingerprint(b));
    if (!footerRows) {
      assert.equal(result.kind, 'forward'); assert.equal(result.fixedTop, true); assert.equal(result.shift, 28);
    } else assert.notEqual(result.kind, 'forward');
  }
});

test('实机尺寸380×903与位移66：固定顶部完整像素连续，1–3行底栏不放行', () => {
  const w = 380, h = 903, source = page(w, 1800);
  for (const footer of [0, 1, 2, 3]) {
    const get = offset => {
      const data = source.slice(offset * w * 4, (offset + h) * w * 4);
      data.set(source.subarray(0, 8 * w * 4), 0);
      if (footer) data.set(source.subarray((h - footer) * w * 4, h * w * 4), (h - footer) * w * 4);
      return { width: w, height: h, data };
    };
    const a = get(0), b = get(66), result = detectShift(fingerprint(a), fingerprint(b));
    if (footer) assert.notEqual(result.kind, 'forward');
    else {
      assert.equal(result.shift, 66); assert.equal(result.fixedTop, true);
      const output = compose([{ data: a.data, height: h }, newRows(b, result.shift)], w);
      assert.equal(output.height, 969); assert.deepEqual(output.data, source.slice(0, 969 * w * 4));
    }
  }
});

test('厚顶栏延伸到新增片段时拒绝重复，不能只用顶部18%作为范围', () => {
  const w = 96, h = 903, shift = 520, data = page(w, 1800);
  const a = { width: w, height: h, data: data.slice(0, h * w * 4) };
  const b = { width: w, height: h, data: data.slice(shift * w * 4, (shift + h) * w * 4) };
  b.data.set(a.data.subarray(0, 500 * w * 4), 0);
  // 重叠尾部恰好重复顶部图案，不能凭尾部匹配宣称新增部分已在顶栏之下。
  for (let y = 8; y < h - shift; y++) a.data.set(b.data.subarray(y * w * 4, (y + 1) * w * 4), (y + shift) * w * 4);
  assert.notEqual(detectShift(fingerprint(a), fingerprint(b)).kind, 'forward');
});

test('低纹理厚顶栏测到正文边界后仍可安全接，完整像素不重顶栏', () => {
  const w = 96, h = 903, shift = 66, data = page(w, 1800), header = 240;
  const a = { width: w, height: h, data: data.slice(0, h * w * 4) };
  a.data.fill(255, 8 * w * 4, header * w * 4);
  const b = { width: w, height: h, data: data.slice(shift * w * 4, (shift + h) * w * 4) };
  b.data.set(a.data.subarray(0, header * w * 4), 0);
  const result = detectShift(fingerprint(a), fingerprint(b)); assert.equal(result.kind, 'forward');
  const output = compose([{ data: a.data, height: h }, newRows(b, result.shift)], w);
  const expected = data.slice(0, (h + shift) * w * 4); expected.set(a.data.subarray(0, header * w * 4));
  assert.deepEqual(output.data, expected);
});

test('全分辨率位移，含单像素、向前和反向', () => {
  const a = fingerprint(frame(50));
  for (const shift of [1, 4, 27, 100]) {
    const result = detectShift(a, fingerprint(frame(50 + shift)));
    assert.equal(result.kind, 'forward');
    assert.equal(result.shift, shift);
  }
  assert.equal(detectShift(a, fingerprint(frame(20))).shift, -30);
  assert.equal(detectShift(a, fingerprint(frame(50))).kind, 'still');
});
test('混合滚动以最后接受的前沿为基准，最终像素逐个一致', () => {
  let frontier = fingerprint(frame(0));
  const chunks = [{ data: frame(0).data, height }];
  let offset = 0;
  for (const position of [28, 75, 42, 95, 95, 130]) {
    const current = frame(position);
    const next = fingerprint(current);
    const result = detectShift(frontier, next);
    if (result.kind === 'forward') {
      chunks.push(newRows(current, result.shift)); frontier = next; offset = position;
    }
  }
  const output = compose(chunks, width);
  assert.equal(output.height, height + offset);
  assert.deepEqual(output.data, document.slice(0, output.height * width * 4));
});
test('超过重叠范围不得硬拼', () => {
  assert.notEqual(detectShift(fingerprint(frame(0)), fingerprint(frame(150))).kind, 'forward');
});
test('可识别的固定底栏必须停住，不能重复贴入', () => {
  const a = frame(0), b = frame(28);
  for (let y = height - 12; y < height; y++) {
    b.data.set(a.data.subarray(y * width * 4, (y + 1) * width * 4), y * width * 4);
  }
  const result = detectShift(fingerprint(a), fingerprint(b));
  assert.equal(result.kind, 'fixed');
  assert.equal(result.edge, '底部');
});
test('横向完全平坦的固定底栏也不能拼入新增条', () => {
  const a = frame(0), b = frame(28);
  for (const item of [a, b]) item.data.fill(245, (height - 18) * width * 4);
  assert.equal(detectShift(fingerprint(a), fingerprint(b)).kind, 'fixed');
});
test('相邻单像素位移近似同分也必须拒绝', () => {
  const doc = new Uint8ClampedArray(width * 600 * 4);
  for (let y = 0; y < 600; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    doc[i] = doc[i + 1] = doc[i + 2] = (x % 2 ? 50 : 20) + Math.floor(y / 3); doc[i + 3] = 255;
  }
  const get = offset => fingerprint({ width, height, data: doc.slice(offset * width * 4, (offset + height) * width * 4) });
  assert.equal(detectShift(get(0), get(20)).kind, 'ambiguous');
});
test('纯色内容不伪造运动，变化纯色不伪造匹配', () => {
  const a = { width, height, data: new Uint8ClampedArray(width * height * 4).fill(100) };
  const b = { ...a, data: new Uint8ClampedArray(a.data.length).fill(160) };
  assert.equal(detectShift(fingerprint(a), fingerprint(a)).kind, 'still');
  assert.equal(detectShift(fingerprint(a), fingerprint(b)).kind, 'unmatched');
});
test('稀疏文字形状与大段空白共存时，仍能找准逐像素位移', () => {
  const w = 200, h = 240;
  const content = new Uint8ClampedArray(w * 700 * 4).fill(255);
  for (let y = 0; y < 700; y++) for (let x = 8; x < 155; x++) {
    const glyphRow = y % 22;
    if (glyphRow < 3 || glyphRow > 10) continue;
    const col = Math.floor((x - 8) / 6), bit = (x - 8) % 6;
    if (bit === 5) continue;
    const code = Math.imul(Math.floor(y / 22) + 3, 17389) ^ Math.imul(col + 7, 31337) ^ Math.imul(glyphRow, 479);
    if ((code >>> bit) & 1) {
      const i = (y * w + x) * 4; content[i] = content[i + 1] = content[i + 2] = 35;
    }
  }
  const get = offset => fingerprint({ width: w, height: h, data: content.slice(offset * w * 4, (offset + h) * w * 4) });
  for (const shift of [1, 17, 63, 90]) {
    const match = detectShift(get(20), get(20 + shift));
    assert.equal(match.kind, 'forward'); assert.equal(match.shift, shift);
  }
});
test('拼图尺寸和片段校验', () => {
  assert.throws(() => compose([{ height: 30001, data: new Uint8ClampedArray(1) }], 96), /上限/);
  assert.throws(() => compose([{ height: 10, data: new Uint8ClampedArray(3) }], 96), /片段/);
  assert.throws(() => compose([{ height: 100, data: new Uint8ClampedArray(0) }], MAX_PIXELS), /上限/);
  assert.throws(() => newRows(frame(0), 0), /无效/);
});
