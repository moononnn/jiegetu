// 历史重定位的安全负例：真正的不重叠、不同参考给出不同绝对位置、缓存上限不被突破、
// 未建窗时不放行。正面路径由 auto-scroll-history-resume 负责，这里只钉住“不许放宽”的一侧。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAutoScrollSession} from '../core/auto-scroll-session.mjs';
import {chatFrame} from './fixtures/chat-background.mjs';
import {firstDifference} from './fixtures/auto-scenes.mjs';

// 900 行周期的滚动页：整页按文档行平移，没有固定背景。
// 周期 900 > 候选位移范围（约 .65 帧高），所以正常相邻帧只会给出一个局部位移，
// 但 120 与 1020 在像素上完全同形（1020-120=900），保留帧里必然同时存在两个可证明的绝对位置。
function periodicPage({period = 900, width = 343, height = 539} = {}) {
  const rows = [];
  for (let k = 0; k < period; k++) {
    const row = new Uint8ClampedArray(width * 4);
    for (let x = 0; x < width; x++) {
      const base = 110 + 60 * Math.sin(x / 37 + k / 41) + 30 * Math.cos(k / 17 + x / 71);
      const value = Math.max(0, Math.min(255, Math.round(base)));
      row[x * 4] = row[x * 4 + 1] = row[x * 4 + 2] = value; row[x * 4 + 3] = 255;
    }
    let seed = (k * 2654435761) >>> 0;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const blocks = 3 + Math.floor(rnd() * 4);
    for (let b = 0; b < blocks; b++) {
      const start = Math.floor(rnd() * (width - 6)), span = 1 + Math.floor(rnd() * 3);
      const sign = rnd() < .5 ? -1 : 1, delta = 90 + Math.floor(rnd() * 120);
      for (let x = start; x < start + span; x++) {
        const i = x * 4;
        row[i] = Math.max(0, Math.min(255, row[i] + sign * delta));
        row[i + 1] = Math.max(0, Math.min(255, row[i + 1] - sign * delta));
        row[i + 2] = Math.max(0, Math.min(255, row[i + 2] + sign * delta));
      }
    }
    rows.push(row);
  }
  return offset => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) data.set(rows[(offset + y) % period], y * width * 4);
    return {width, height, data};
  };
}

test('历史参考给出不同绝对位置时必须拒绝，不能 first-hit 接受错误回位', () => {
  const frame = periodicPage();
  const session = createAutoScrollSession(frame(0));
  let clock = 0;
  try {
    for (const offset of [0, 40, 80, 240, 400, 560, 720, 880, 1040, 1200, 1360, 1520]) {
      session.accept(frame(offset), clock += 80);
    }
    const before = session.finish();
    assert.equal(before.complete, true, before.warning);

    // 构造先自证：帧 120 与帧 1020 逐字节相同（相差整整一个 900 行周期），
    // 所以 120 与 1020 都是像素上成立的落点，历史候选必然互相矛盾。
    assert.equal(firstDifference(frame(120), frame(1020)), null);

    // 不看内部阶段字段：只看可观察行为。拒绝必须表现为不报 matched、不追加、anchor 不推进。
    const back = session.accept(frame(120), clock += 80);
    assert.equal(back.viewport?.matched, false, JSON.stringify(back.autoEvidence));
    assert.equal(back.capturedAdded, 0, '拒绝时不得追加片段');
    assert.equal(back.capturedHeight, before.height);
    assert.equal(back.height, before.height, '拒绝不得改动已确认高度');
    // 1520与620也同形，失定位后回1520同样有两个可证明位置，不能把快速回位当唯一性证明。
    const hold = session.accept(frame(1520), clock += 80);
    assert.equal(hold.viewport?.matched, false, JSON.stringify(hold.autoEvidence));
    assert.equal(hold.recoveredFrames, 0);assert.equal(hold.capturedAdded, 0);
    const after = session.finish();
    assert.equal(after.complete, false);
    assert.equal(after.height, before.height);
    assert.equal(firstDifference(after, before), null);
  } finally { session.clear(); }
});

for(const variant of [
  {name:'全帧exact',offset:620},
  {name:'正文exact而顶栏变化',offset:620,header:true},
  {name:'正常局部位移也有周期别名',offset:600},
])test(`失定位后的${variant.name}也必须拒绝历史绝对位置冲突`,()=>{
  const frame=periodicPage(),session=createAutoScrollSession(frame(0));let clock=0;
  try{
    for(const offset of [0,40,80,240,400,560,720,880,1040,1200,1360,1520])session.accept(frame(offset),clock+=80);
    const before=session.finish();assert.equal(before.complete,true,before.warning);
    // 已定位时的相同帧仍走旧快速路径；只有丢定位后才要求历史一致性。
    assert.equal(session.accept(frame(1520),clock+=80).viewport?.matched,true);
    const count=session.stats().pendingFrames;
    const white={width:343,height:539,data:new Uint8ClampedArray(343*539*4).fill(255)};
    assert.equal(session.accept(white,clock+=80).viewport?.matched,false);
    const image=frame(variant.offset);if(variant.header)image.data[0]^=1;
    const update=session.accept(image,clock+=80);
    assert.equal(update.viewport?.matched,false,'不能把相差900行的两个原帧证明猜成一个位置');
    assert.equal(update.recoveredFrames,0);assert.equal(update.capturedAdded,0);
    assert.equal(update.pendingFrames,count,'拒绝不能提交anchor或扩大缓存');
    const output=session.finish();assert.equal(output.complete,false);
    assert.equal(output.height,before.height);assert.equal(firstDifference(output,before),null);
  }finally{session.clear();}
});

test('没有任何重叠的远跳不自造片段，也不推进 anchor', () => {
  const options = {fixed: false};
  const session = createAutoScrollSession(chatFrame(0, options));
  let clock = 0;
  const accept = offset => session.accept(chatFrame(offset, options), clock += 80);
  try {
    for (const offset of [0, 40, 80, 240, 400, 560]) accept(offset);
    const before = session.finish();
    assert.equal(before.complete, true, before.warning);
    const frames = session.stats().pendingFrames, bytes = session.stats().pendingBytes;

    const lost = accept(3000);
    assert.notEqual(lost.viewport?.matched, true);
    assert.equal(lost.capturedAdded, 0);
    assert.equal(lost.capturedHeight, before.height);
    assert.equal(lost.pendingFrames, frames, '失配帧不进入原帧缓存');
    assert.equal(lost.pendingBytes, bytes);
    assert.equal(lost.recoveredFrames, 0, '失配不报恢复事件');

    // 仍能按原流程回到真实重叠位置，说明拒绝没把会话搞坏；本帧要报一次恢复事件。
    const back = accept(400);
    assert.equal(back.viewport.matched, true);
    assert.equal(back.capturedAdded, 0);
    assert.equal(back.recoveredFrames, 1, '从失配位置对回来要报恢复');
    assert.equal(session.finish().height, before.height);
  } finally { session.clear(); }
});

test('历史重定位不突破 maxFrames/maxBytes，也不额外复制原图', () => {
  const options = {fixed: false};
  const seed = chatFrame(0, options), frameBytes = seed.data.byteLength;
  const session = createAutoScrollSession(seed, {maxFrames: 3, maxBytes: frameBytes * 3});
  let clock = 0;
  const accept = offset => {
    const result = session.accept(chatFrame(offset, options), clock += 80);
    assert.ok(result.pendingFrames <= 3, `pendingFrames=${result.pendingFrames}`);
    assert.ok(result.pendingBytes <= frameBytes * 3, `pendingBytes=${result.pendingBytes}`);
    return result;
  };
  try {
    for (const offset of [0, 40, 80, 240]) accept(offset);
    const before = session.finish();
    accept(1900);
    const back = accept(80);
    // 3 帧上限里 initial 与最近帧仍够证明 80；即便证明不成也不许复制原图或扩缓存。
    assert.ok(back.pendingFrames <= 3);
    assert.ok(back.pendingBytes <= frameBytes * 3);
    assert.equal(back.capturedAdded, 0);
    assert.equal(session.finish().height, before.height);
    for (const offset of [240, 400]) accept(offset);
    assert.equal(session.stats().pendingFrames <= 3, true);
  } finally { session.clear(); }
});

test('未建窗时不做历史重定位，也不把首屏标成已定位', () => {
  const options = {fixed: false};
  const session = createAutoScrollSession(chatFrame(0, options));
  let clock = 0;
  try {
    session.accept(chatFrame(0, options), clock += 80);
    const third = session.accept(chatFrame(40, options), clock += 80);
    assert.equal(third.result.content, undefined, '两帧不同位置还不该建窗');
    assert.notEqual(third.viewport?.matched, true);
    // 未建窗时即便有“历史位置”的候选也只能给学习态，不给 matched、不追加。
    const jump = session.accept(chatFrame(400, options), clock += 80);
    assert.notEqual(jump.viewport?.matched, true);
    assert.equal(jump.capturedAdded, 0);
    assert.equal(jump.height, 539);
  } finally { session.clear(); }
});
