'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectPanelRegions } = require('../renderer/panel-regions.js');
function image(w, h, shade) {
  const px = new Uint8ClampedArray(w*h*4);
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
    const i=(y*w+x)*4, c=shade(x,y); px[i]=px[i+1]=px[i+2]=c; px[i+3]=255;
  }
  return px;
}
for (const [w,h] of [[768,360],[420,260],[350,440]]) {
  test(`docked panel boundaries follow the image at ${w}x${h}`, () => {
    const left=Math.round(w*0.22), right=Math.round(w*0.8), split=Math.round(h*0.55);
    const boxes=detectPanelRegions(image(w,h,(x,y)=>(x<left?170:x<right?215:y<split?180:145)+(x*y%5)),w,h);
    assert.ok(boxes.some(b=>b.x===0&&Math.abs(b.width-left)<=1));
    assert.ok(boxes.some(b=>Math.abs(b.x-right)<=1&&Math.abs(b.y-split)<=1));
  });
}
test('uniform, gradient, many stripes or short line produce no panel', () => {
  for (const shade of [()=>200,(x,y)=>Math.floor((x+y)/8),x=>Math.floor(x/40)%2?180:230,
    (x,y)=>x>135&&x<138&&y>20&&y<80?40:220]) {
    assert.deepEqual(detectPanelRegions(image(480,280,shade),480,280),[]);
  }
  assert.deepEqual(detectPanelRegions([],480,280),[]);
});
