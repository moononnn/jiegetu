import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateFeatureMotion } from '../core/feature-motion.mjs';
import { chatFrame } from './fixtures/chat-background.mjs';

// Own generators: no real screenshots, no messages.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Text-like scene: fixed wallpaper margin + fixed footer + a message box keyed on the document row.
// period > 0 makes the box repeat every `period` rows; a different seed gives unrelated text.
// scrollWallpaper makes the wallpaper travel with the content (whole-page scroll).
function textFrame(offset, { seed = 1, period = 0, width = 343, height = 539, footer = 40, scrollWallpaper = false } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const docRow = y + offset;
    const effective = period ? ((docRow % period) + period) % period : docRow;
    const rowRng = mulberry32(seed * 1000003 + effective * 7919);
    const wallpaperRow = scrollWallpaper ? docRow : y;
    for (let x = 0; x < width; x++) {
      let value;
      if (y >= height - footer) value = 118 + ((x * 7 + y * 13) % 44);
      else if (x > 18 && x < width - 18) {
        const base = 40 + (rowRng() * 210 | 0);
        value = ((x * 31 + effective * 17) % 7 < 4) ? base : 236 - ((base * .3) | 0);
      } else value = 196 + 18 * Math.sin(x / 37 + wallpaperRow / 53);
      const i = (y * width + x) * 4;
      data[i] = value; data[i + 1] = value; data[i + 2] = value; data[i + 3] = 255;
    }
  }
  return { data, width, height };
}
function noiseFrame(seed, width = 343, height = 539) {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state >>> 24; };
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { const v = next(); data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255; }
  return { data, width, height };
}
// Only one small block changes: a corner animation, not whole-page motion.
function blockFrame(base, { x = 12, y = 12, size = 40, seed = 77 } = {}) {
  const data = new Uint8ClampedArray(base.data);
  const rng = mulberry32(seed);
  for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) {
    const px = x + dx, py = y + dy;
    if (px >= base.width || py >= base.height) continue;
    const i = (py * base.width + px) * 4, value = 30 + (rng() * 200 | 0);
    data[i] = value; data[i + 1] = value; data[i + 2] = value; data[i + 3] = 255;
  }
  return { data, width: base.width, height: base.height };
}

const COMPLEX_ALPHA = { fixed: true, alpha: .52, footer: 40, outlinedWallpaper: true, illustratedWallpaper: true };
const complexFrames = [0, 4, 108, 140, 172].map(offset => ({ offset, image: chatFrame(offset, COMPLEX_ALPHA) }));
const complexAt = offset => complexFrames.find(frame => frame.offset === offset).image;

// ---------------------------------------------------------------- displacement

for (const [label, a, b, truth] of [
  ['复杂壁纸+半透 0→4', complexAt(0), complexAt(4), 4],
  ['复杂壁纸+半透 4→108', complexAt(4), complexAt(108), 104],
  ['复杂壁纸+半透 108→140', complexAt(108), complexAt(140), 32],
  ['复杂壁纸+半透 0→172', complexAt(0), complexAt(172), 172],
  ['复杂壁纸+半透 反向 140→108', complexAt(140), complexAt(108), -32],
  ['复杂壁纸+半透 反向 172→0', complexAt(172), complexAt(0), -172]
]) {
  test(`位移：${label} 应为 ${truth}`, () => {
    const result = estimateFeatureMotion(a, b);
    assert.equal(result.kind, 'motion', JSON.stringify(result));
    assert.equal(result.shift, truth, JSON.stringify(result));
  });
}

test('位移：整屏背景与正文一起滚，仍应给出真实位移', () => {
  const a = textFrame(0, { seed: 4, scrollWallpaper: true });
  const b = textFrame(48, { seed: 4, scrollWallpaper: true });
  const result = estimateFeatureMotion(a, b);
  assert.equal(result.kind, 'motion', JSON.stringify(result));
  assert.equal(result.shift, 48, JSON.stringify(result));
});

// ---------------------------------------------------------------- ambiguity

test('同图：逐像素相同应为 still', () => {
  const frame = textFrame(0, { seed: 9 });
  const result = estimateFeatureMotion(frame, frame);
  assert.equal(result.kind, 'still', JSON.stringify(result));
  assert.equal(result.shift, 0);
});

test('动画：两帧各自随机，不得报出位移', () => {
  const result = estimateFeatureMotion(noiseFrame(11), noiseFrame(12));
  assert.notEqual(result.kind, 'motion', JSON.stringify(result));
  assert.equal(result.shift, 0);
});

test('同布局不同内容：不得报出位移', () => {
  const result = estimateFeatureMotion(textFrame(108, { seed: 1 }), textFrame(140, { seed: 2 }));
  assert.notEqual(result.kind, 'motion', JSON.stringify(result));
  assert.equal(result.shift, 0);
});

test('仅角落小块变化：不得当成整页 motion', () => {
  const base = textFrame(0, { seed: 3 });
  const result = estimateFeatureMotion(base, blockFrame(base, { x: 8, y: 8, size: 40, seed: 91 }));
  assert.notEqual(result.kind, 'motion', JSON.stringify(result));
  assert.equal(result.shift, 0);
});

test('分布门：远处分带支持另一位移，不能替局部赢家凑全屏跨度',()=>{
 const width=343,height=539,source=noiseFrame(716,width,height+64);
 const frame=moving=>{
  const data=new Uint8ClampedArray(width*height*4);for(let p=0;p<data.length;p+=4){data[p]=data[p+1]=data[p+2]=245;data[p+3]=255;}
  for(const [top,bottom,shift] of [[0,106,8],[424,477,-17]])for(let y=top;y<bottom;y++)for(let x=20;x<323;x++){
   const q=((y+32+(moving?shift:0))*width+x)*4;data.set(source.data.subarray(q,q+4),(y*width+x)*4);
  }
  return {width,height,data};
 };
 const result=estimateFeatureMotion(frame(false),frame(true));assert.notEqual(result.kind,'motion',JSON.stringify(result));
});
for (const [label, period, expected] of [
  ['周期A 字形每 160 行', 0, 'ambiguous'],
  ['周期B 正文每 2 行', 2, 'still'],
  ['周期C 正文每 24 行', 24, 'ambiguous'],
  ['周期D 正文每 48 行', 48, 'ambiguous']
]) {
  test(`周期：${label} 应为 ${expected}，不得挑一个位移`, () => {
    const a = period ? textFrame(0, { seed: 5, period }) : chatFrame(0, { fixed: true, alpha: 1, footer: 40, repeat: true });
    const b = period ? textFrame(108, { seed: 5, period }) : chatFrame(108, { fixed: true, alpha: 1, footer: 40, repeat: true });
    const result = estimateFeatureMotion(a, b);
    assert.equal(result.kind, expected, JSON.stringify(result));
    assert.equal(result.shift, 0, '周期场景不得输出具体位移');
  });
}

// ---------------------------------------------------------------- input contract

test('非法输入：结构性错误必须抛出', () => {
  const frame = textFrame(0, { seed: 1 });
  assert.throws(() => estimateFeatureMotion(null, frame), /不是有效画面/);
  assert.throws(() => estimateFeatureMotion({ data: new Uint8ClampedArray(4), width: 15, height: 60 }, frame), /至少需要/);
  assert.throws(() => estimateFeatureMotion({ data: new Uint8ClampedArray(10), width: 20, height: 60 }, frame), /像素缓冲长度不符/);
  assert.throws(() => estimateFeatureMotion({ data: new Uint8ClampedArray(20 * 60 * 4), width: 20.5, height: 60 }, frame), /宽高必须是整数/);
  assert.throws(() => estimateFeatureMotion({ data: { length: 20 * 60 * 4 }, width: 20, height: 60 }, frame), /像素缓冲长度不符/);
  assert.throws(() => estimateFeatureMotion({ data: new Uint8Array(), width: 1000000, height: 1000000 }, frame), /像素上限/);
});

test('非法输入：两帧尺寸不一致返回 invalid', () => {
  const result = estimateFeatureMotion(textFrame(0, { seed: 1 }), textFrame(0, { seed: 1, width: 200, height: 400 }));
  assert.equal(result.kind, 'invalid');
  assert.equal(result.shift, 0);
});

test('窄图：没有可见正文变化时为 still，不把生成器参数当真实位移', () => {
  // At width 20 the fixture has no message body; both rendered images really are identical.
  const a = textFrame(0, { seed: 6, width: 20, height: 60, footer: 10 });
  const b = textFrame(24, { seed: 6, width: 20, height: 60, footer: 10 });
  assert.deepEqual(a.data,b.data);
  assert.equal(estimateFeatureMotion(a,b).kind,'still');
});
test('窄图：真实20像素宽随机文档滚动8行，候选必须正确', () => {
  const doc=noiseFrame(93,20,68),a={width:20,height:60,data:doc.data.slice(0,20*60*4)},b={...a,data:doc.data.slice(20*8*4)};
  const result=estimateFeatureMotion(a,b);
  assert.equal(result.kind,'motion',JSON.stringify(result));assert.equal(result.shift,8);
});
