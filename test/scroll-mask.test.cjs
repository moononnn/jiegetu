'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { outsideMask } = require('../core/coordinates.cjs');
const source = fs.readFileSync(path.join(__dirname, '../renderer/scroll-mask.js'), 'utf8');
const stylesOf = nodes => nodes.map(node => JSON.parse(JSON.stringify(node.style)));
const regionStyles = regions => regions.map(r => ({ left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` }));
// 提示页只收物理帧与像素范围，色块按它自己的视口投影：同一 layout 在不同视口下结果必须不同。
function render(layout, { width = 1000, height = 800, styles = true } = {}) {
  const nodes = [], window = {};
  vm.runInNewContext(source, { window, URLSearchParams, location: { search: `?layout=${encodeURIComponent(JSON.stringify(layout))}` },
    innerWidth: width, innerHeight: height,
    getComputedStyle: () => ({ position: styles ? 'fixed' : 'static' }),
    document: { createElement: () => ({ style: {} }), body: { replaceChildren: (...panels) => nodes.push(...panels) } } });
  return { ready: window.regionMaskReady, nodes };
}
test('按物理帧与像素范围生成四个框外色块，公式与 core.outsideMask 一致', () => {
  const frame = { width: 1000, height: 800 }, pixels = { x: 100, y: 100, width: 300, height: 400 };
  const expected = outsideMask(pixels, { width: 1000, height: 800 }, frame);
  const h = render({ frame, pixels });
  assert.equal(h.ready, true); assert.equal(h.nodes.length, 4);
  assert.deepEqual(stylesOf(h.nodes), regionStyles(expected));
  assert.ok(h.nodes.every(n => n.className === 'shade'));
  const css = fs.readFileSync(path.join(__dirname, '../renderer/scroll-mask.css'), 'utf8');
  assert.match(css, /background:transparent/); assert.match(css, /box-shadow:none/);
  assert.doesNotMatch(source, /drawImage|<img|data:image/);
});
test('遮罩页自身视口与选区页不同也照常映射，不假设两者相等', () => {
  // 125% 副屏现场：帧 1920×1080、页面 1536×864；遮罩页视口再换一种尺寸仍应各自投影。
  const frame = { width: 1920, height: 1080 }, pixels = { x: 125, y: 125, width: 1250, height: 750 };
  const wide = render({ frame, pixels }, { width: 1536, height: 864 });
  const narrow = render({ frame, pixels }, { width: 1200, height: 700 });
  assert.equal(wide.ready, true); assert.equal(narrow.ready, true);
  assert.deepEqual(stylesOf(wide.nodes), regionStyles(outsideMask(pixels, { width: 1536, height: 864 }, frame)));
  assert.deepEqual(stylesOf(narrow.nodes), regionStyles(outsideMask(pixels, { width: 1200, height: 700 }, frame)));
  assert.notDeepEqual(stylesOf(wide.nodes), stylesOf(narrow.nodes), '投影基准是各页自己的视口');
  assert.ok(stylesOf(narrow.nodes).every(style =>
    parseFloat(style.left) + parseFloat(style.width) <= 1200 && parseFloat(style.top) + parseFloat(style.height) <= 700), '色块不越出自身视口');
});
test('无效遮罩视口不允许用空色块列表冒充就绪', () => {
  const layout = { frame: { width: 1920, height: 1080 }, pixels: { x: 125, y: 125, width: 1250, height: 750 } };
  for (const options of [{ width: 0 }, { height: 0 }, { width: -1 }, { width: NaN }, { height: Infinity }, { width: '1536' }]) {
    assert.equal(render(layout, options).ready, false);
  }
});
test('极窄长选区照常映射：不按长宽比阈值拒绝', () => {
  const frame = { width: 1920, height: 1080 }, pixels = { x: 0, y: 0, width: 4, height: 1080 };
  const h = render({ frame, pixels }, { width: 1536, height: 864 });
  assert.equal(h.ready, true);
  assert.equal(h.nodes.length, 1);
});
for (const [name, layout, options] of [
  ['缺少物理帧', { pixels: { x: 0, y: 0, width: 10, height: 10 } }, {}],
  ['缺少像素范围', { frame: { width: 1000, height: 800 } }, {}],
  ['帧尺寸非正', { frame: { width: 0, height: 800 }, pixels: { x: 0, y: 0, width: 10, height: 10 } }, {}],
  ['像素越出帧', { frame: { width: 1000, height: 800 }, pixels: { x: 995, y: 0, width: 10, height: 10 } }, {}],
  ['坐标注入', { frame: { width: 1000, height: 800 }, pixels: { x: '0;position:fixed', y: 0, width: 2, height: 2 } }, {}],
  ['旧契约 width/height/regions', { width: 1000, height: 800, regions: [{ x: 0, y: 0, width: 10, height: 10 }] }, {}],
  ['样式未加载', { frame: { width: 1000, height: 800 }, pixels: { x: 0, y: 0, width: 2, height: 2 } }, { styles: false }]
]) test(`${name}不确认就绪，交给主进程失败收回`, () => assert.equal(render(layout, options).ready, false));
