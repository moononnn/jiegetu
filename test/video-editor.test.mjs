import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createRange, normalizeCuts, trimBounds, trimBoundary, retainedSpans, editedMs, planCut, applyCuts,
  toPayload, joinTarget, nextJoinMs, draftAt, formatTime, rulerLabel, rulerTicks, initVideoEditor,
  MAX_CUTS, DEFAULT_CUT_MS,
} from '../renderer/video-editor.mjs';

// —— 极简假 DOM：只实现本页真正用到的接口 ——
function fakeElement(id) {
  return {
    id, attributes: {}, style: {}, listeners: {}, children: [], dataset: {}, hidden: false, disabled: false,
    tabIndex: 0, textContent: '', className: '', title: '', pointerCapture: null,
    currentTime: 0, duration: 0, muted: false, paused: true, seeking: false,
    classList: { values: new Set(), toggle(name, on) { if (on) this.values.add(name); else this.values.delete(name); }, contains(name) { return this.values.has(name); } },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; },
    setPointerCapture(pointerId) { this.pointerCapture = pointerId; },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...nodes) { this.children = nodes.slice(); },
    getBoundingClientRect() {
      if (id === 'rail') return { left: 12, width: 1000, top: 0, height: 12, right: 1012, bottom: 12 };
      return { left: 0, width: 0, top: 0, height: 0, right: 0, bottom: 0 };
    },
    fire(type, event = {}) {
      for (const fn of this.listeners[type] || []) {
        fn({ clientX: 0, pointerId: 1, key: '', shiftKey: false, ctrlKey: false, preventDefault() {}, stopPropagation() {}, target: this, ...event });
      }
    },
  };
}

function fakeDocument() {
  const elements = new Map();
  const body = fakeElement('body');
  const doc = {
    body,
    listeners: {},
    defaultView: { addEventListener() {} },
    createElement(tag) { return fakeElement(`<${tag}>`); },
    addEventListener(type, fn) { (doc.listeners[type] ||= []).push(fn); },
    fire(type, event = {}) { for (const fn of doc.listeners[type] || []) fn({ key: '', target: body, preventDefault() {}, ...event }); },
    getElementById(id) { if (!elements.has(id)) elements.set(id, fakeElement(id)); return elements.get(id); },
  };
  return doc;
}
const tick = () => new Promise(resolve => setImmediate(resolve));
// 轨道左缘 12px、宽 1000px：比例 → 客户端 X。
const x = fraction => 12 + fraction * 1000;
const bridgeFor = (source = { bytes: new Uint8Array([1, 2]), mimeType: 'video/webm' }) => ({
  load: async () => source,
  saveOriginal: async () => ({ saved: false, canceled: true }),
  exportEdit: async () => ({ saved: false, canceled: false, message: '导出失败，原视频仍保留' }),
  close: async () => ({ canceled: true }),
});
async function mount({ durationMs = 10000, bridge, opts } = {}) {
  const doc = fakeDocument();
  const app = initVideoEditor(doc, bridge ?? bridgeFor(), opts);
  await app.ready;
  const video = doc.getElementById('video');
  if (durationMs !== null) { video.duration = durationMs / 1000; video.fire('loadedmetadata'); }
  return { doc, video, get: id => doc.getElementById(id) };
}
// 在轨道上单击/拖动定位（只定位，不产段）。
function seekToRatio(node, fraction) {
  node.fire('pointerdown', { clientX: x(fraction) });
  node.fire('pointerup', {});
}

test('时间范围与已剪段的纯模型：夹在首尾内、合并相邻、拒绝剪光', () => {
  assert.throws(() => createRange(0));
  let range = createRange(10000);
  assert.deepEqual(range, { durationMs: 10000, startMs: 0, endMs: 10000, cuts: [] });
  range = trimBoundary(range, 'startMs', 1000);
  range = trimBoundary(range, 'endMs', 9000);
  assert.deepEqual(range, { durationMs: 10000, startMs: 1000, endMs: 9000, cuts: [] });
  const first = planCut(range, { startMs: 3000, endMs: 4000 });
  assert.equal(first.ok, true);
  range = first.range;
  const second = planCut(range, { startMs: 6000, endMs: 7000 });
  assert.equal(second.ok, true);
  assert.deepEqual(second.range.cuts, [{ startMs: 3000, endMs: 4000 }, { startMs: 6000, endMs: 7000 }]);
  // 排序 + 重叠/相邻（±1ms）合并
  assert.deepEqual(normalizeCuts([{ startMs: 6000, endMs: 7000 }, { startMs: 4000, endMs: 5000 }], 10000),
    [{ startMs: 4000, endMs: 5000 }, { startMs: 6000, endMs: 7000 }]);
  assert.deepEqual(normalizeCuts([{ startMs: 4000, endMs: 5000 }, { startMs: 5001, endMs: 6000 }], 10000),
    [{ startMs: 4000, endMs: 6000 }]);
  assert.equal(planCut(second.range, { startMs: 6200, endMs: 6600 }).reason, 'noop', '已经在剪掉的范围里');
  // 首尾书立不能越过已剪的段
  assert.deepEqual(trimBounds(second.range, 'startMs'), [0, 2999]);
  assert.deepEqual(trimBounds(second.range, 'endMs'), [7001, 10000]);
  assert.equal(trimBoundary(second.range, 'startMs', 9000).startMs, 2999);
  assert.equal(trimBoundary(second.range, 'endMs', 0).endMs, 7001);
  // 剪光被明确拒绝，不偷偷修正
  assert.equal(planCut(range, { startMs: 0, endMs: 10000 }).reason, 'too-short');
  assert.equal(editedMs(second.range), 6000);
  assert.deepEqual(retainedSpans(second.range),
    [{ startMs: 1000, endMs: 3000 }, { startMs: 4000, endMs: 6000 }, { startMs: 7000, endMs: 9000 }]);
});

test('点「裁剪」给出的待剪段：钉在播放头所在的保留画面，靠段尾就摆到左边', () => {
  assert.equal(DEFAULT_CUT_MS, 1000);
  const plain = createRange(10000);
  assert.deepEqual(draftAt(plain, 0).draft, { startMs: 0, endMs: 1000 }, '开头往后 1 秒');
  assert.deepEqual(draftAt(plain, 3000).draft, { startMs: 3000, endMs: 4000 });
  assert.deepEqual(draftAt(plain, 9500).draft, { startMs: 8500, endMs: 9500 }, '往后放不下就摆到播放头左边');
  assert.deepEqual(draftAt(plain, 10000).draft, { startMs: 9000, endMs: 10000 }, '在保留终点上贴着左边界');
  // 播放头落在已剪区间里：先落到后面最近的保留画面
  const cut = { ...plain, cuts: [{ startMs: 3000, endMs: 4000 }] };
  assert.deepEqual(draftAt(cut, 3200).draft, { startMs: 4000, endMs: 5000 });
  // 首尾裁剪也夹住
  const trimmed = { durationMs: 10000, startMs: 2000, endMs: 9000, cuts: [] };
  assert.deepEqual(draftAt(trimmed, 1500).draft, { startMs: 2000, endMs: 3000 });
  assert.deepEqual(draftAt(trimmed, 8900).draft, { startMs: 7900, endMs: 8900 });
  // 没有可剪的余量就明确拒绝
  assert.equal(draftAt(createRange(10), 0).reason, 'too-short');
  assert.equal(draftAt({ ...plain, startMs: 0, endMs: 0, cuts: [{ startMs: 0, endMs: 10000 }] }, 0).reason, 'empty');
  // 剪出来的段一定能过 planCut（默认 1 秒、余量不足时自动缩短）
  const tight = createRange(20);
  const tightDraft = draftAt(tight, 0).draft;
  assert.deepEqual(tightDraft, { startMs: 0, endMs: 10 });
  assert.equal(planCut(tight, tightDraft).ok, true);
});

test('最多 24 段：第 25 段被拒绝，撤销回 23 段', () => {
  let range = createRange(100000);
  for (let index = 0; index < MAX_CUTS; index += 1) {
    const from = index * 4000 + 100;
    const plan = planCut(range, { startMs: from, endMs: from + 1000 });
    assert.equal(plan.ok, true, `第 ${index + 1} 段应可以剪`);
    range = plan.range;
  }
  assert.equal(range.cuts.length, MAX_CUTS);
  assert.equal(planCut(range, { startMs: 98000, endMs: 99000 }).reason, 'too-many');
  assert.equal(toPayload(range).cuts.length, 24);
  assert.equal(applyCuts(range, range.cuts.slice(0, -1)).cuts.length, 23);
});

test('交给宿主的计划：整数、有序、已合并、夹在首尾内', () => {
  const range = {
    durationMs: 10000, startMs: 1000, endMs: 9000,
    cuts: [{ startMs: 6000, endMs: 7000 }, { startMs: 3000, endMs: 4000 }, { startMs: 3999, endMs: 5000 }, { startMs: 200, endMs: 900 }],
  };
  assert.deepEqual(toPayload(range), {
    durationMs: 10000, startMs: 1000, endMs: 9000,
    cuts: [{ startMs: 3000, endMs: 5000 }, { startMs: 6000, endMs: 7000 }],
  });
  assert.deepEqual(toPayload(createRange(3000)), { durationMs: 3000, startMs: 0, endMs: 3000, cuts: [] }, '没剪也要给空数组');
});

test('剪后连播的落脚点：越过接缝跳到下一段，到尾就停', () => {
  const range = { durationMs: 10000, startMs: 1000, endMs: 9000, cuts: [{ startMs: 3000, endMs: 4000 }, { startMs: 6000, endMs: 7000 }] };
  assert.deepEqual(joinTarget(range, 500), { seek: 1000 }, '起点之前先跳到保留起点');
  assert.equal(joinTarget(range, 2000), null, '保留段里就继续');
  assert.deepEqual(joinTarget(range, 3200), { seek: 4000 }, '第一段剪掉的区间跳到它的终点');
  assert.deepEqual(joinTarget(range, 6500), { seek: 7000 });
  assert.deepEqual(joinTarget(range, 9000), { stop: true, ms: 9000 }, '到保留终点就停');
  assert.equal(nextJoinMs(range, 2000), 3000);
  assert.equal(nextJoinMs(range, 6500), 7000);
  assert.equal(nextJoinMs(range, 8500), 9000);
  assert.equal(formatTime(61234), '01:01.234');
});

test('加载后是整段保留：没有草稿、没有已剪段，两份保存出口都在', async () => {
  const { get } = await mount();
  assert.match(get('video').src, /^blob:/);
  assert.equal(get('handle-start').getAttribute('aria-valuenow'), '0');
  assert.equal(get('handle-end').getAttribute('aria-valuenow'), '10000');
  assert.equal(get('keep').style.width, '100%');
  assert.equal(get('cuts').hidden, true);
  assert.equal(get('draft').hidden, true);
  assert.equal(get('draft-lane').hidden, true);
  assert.equal(get('confirm-cut').disabled, true, '没有待剪段时不能剪');
  assert.equal(get('undo').disabled, true);
  assert.equal(get('mode').disabled, false);
  assert.equal(get('mark-cuts').textContent, '未剪');
  assert.equal(get('meta').textContent, '00:10.000 · 整段保留');
  assert.equal(get('save').disabled, false);
  assert.equal(get('save').textContent, '保存视频', '没剪时只有一个保存口，写的就是存原片');
});

test('点「裁剪」立刻在播放头长出待剪块：两个书立可调，「剪掉这段」才生效', async () => {
  const { get, video } = await mount();
  seekToRatio(get('rail'), 0.3);
  assert.equal(video.currentTime, 3);
  get('mode').fire('click');
  assert.equal(get('draft').hidden, false, '不用拖轨道，点一下就出现待剪块');
  assert.equal(get('draft').style.left, '30%');
  assert.equal(get('draft').style.width, '10%');
  assert.equal(get('draft-lane').hidden, false);
  assert.equal(get('handle-draft-start').getAttribute('aria-valuenow'), '3000');
  assert.equal(get('handle-draft-end').getAttribute('aria-valuenow'), '4000');
  assert.equal(get('mark-draft').textContent, '待剪 00:03.000–00:04.000（未确认）');
  assert.equal(get('mark-cuts').textContent, '未剪', '草稿还没进已剪清单');
  assert.equal(get('cuts').children.length, 0);
  assert.equal(get('confirm-cut').disabled, false);
  assert.equal(get('discard-draft').hidden, false);
  get('confirm-cut').fire('click');
  assert.equal(get('draft').hidden, true, '确认后草稿收起，两端书立一起收起');
  assert.equal(get('draft-lane').hidden, true);
  assert.equal(get('mark-cuts').textContent, '已剪 1 段 · 00:03.000–00:04.000');
  assert.equal(get('cuts').children.length, 1);
  assert.equal(get('cuts').children[0].style.left, '30%');
  assert.equal(get('cuts').children[0].style.width, '10%');
  assert.equal(get('cuts').children[0].className, 'cut-block');
  assert.match(get('status').textContent, /已剪掉 00:03\.000–00:04\.000/);
  assert.equal(video.currentTime, 3, '确认这一刀不动播放头');
});

test('靠近段尾点「裁剪」时待剪块摆到播放头左边；再点一次换到播放头的新一段', async () => {
  const { get } = await mount();
  seekToRatio(get('rail'), 0.98);
  get('mode').fire('click');
  assert.equal(get('handle-draft-start').getAttribute('aria-valuenow'), '8800');
  assert.equal(get('handle-draft-end').getAttribute('aria-valuenow'), '9800');
  assert.equal(get('draft').style.left, '88%');
  // 再点一次：换到播放头处的新一段，草稿不叠加
  seekToRatio(get('rail'), 0.7);
  get('mode').fire('click');
  assert.equal(get('handle-draft-start').getAttribute('aria-valuenow'), '7000');
  assert.equal(get('handle-draft-end').getAttribute('aria-valuenow'), '8000');
  assert.equal(get('mark-cuts').textContent, '未剪');
});

test('连续剪两段互不相同的中间段，导出计划就是两段；撤销逐段退回', async () => {
  const calls = [];
  const { get } = await mount({ bridge: {
    load: async () => ({ bytes: new Uint8Array([1]), mimeType: 'video/webm' }),
    saveOriginal: async () => ({ saved: true }),
    exportEdit: async payload => { calls.push(payload); return { saved: true }; },
    close: async () => ({ canceled: true }),
  } });
  const rail = get('rail');
  seekToRatio(rail, 0.3);
  get('mode').fire('click');
  get('confirm-cut').fire('click');
  seekToRatio(rail, 0.6);
  get('mode').fire('click');
  assert.equal(get('draft').style.left, '60%', '第二段是新的草稿，不是改第一段');
  assert.equal(get('mark-draft').textContent, '待剪 00:06.000–00:07.000（未确认）');
  get('confirm-cut').fire('click');
  assert.equal(get('mark-cuts').textContent, '已剪 2 段 · 00:03.000–00:04.000、00:06.000–00:07.000');
  assert.equal(get('cuts').children.length, 2);
  assert.equal(get('save').textContent, '保存剪辑视频', '剪过之后同一个按钮改成存剪后版本');
  get('save').fire('click');
  await tick();
  assert.deepEqual(calls, [{
    durationMs: 10000, startMs: 0, endMs: 10000,
    cuts: [{ startMs: 3000, endMs: 4000 }, { startMs: 6000, endMs: 7000 }],
  }]);
  // 撤销像图片编辑那样一次退一步
  get('undo').fire('click');
  assert.equal(get('cuts').children.length, 1);
  assert.equal(get('mark-cuts').textContent, '已剪 1 段 · 00:03.000–00:04.000');
  get('undo').fire('click');
  assert.equal(get('cuts').hidden, true);
  assert.equal(get('mark-cuts').textContent, '未剪');
  assert.equal(get('undo').disabled, true, '没有可撤销的就禁掉');
  assert.match(get('status').textContent, /已撤销到未剪状态/);
});

test('轨道只负责定位：单击、拖动都只是挪播放头，永远不会自己长出待剪块', async () => {
  const { get, video } = await mount();
  const rail = get('rail');
  rail.fire('pointerdown', { clientX: x(0.25) });
  assert.equal(video.currentTime, 2.5);
  rail.fire('pointermove', { clientX: x(0.5) });
  assert.equal(video.currentTime, 5);
  assert.equal(get('draft').hidden, true, '拖动轨道不产段');
  rail.fire('pointerup', {});
  rail.fire('pointermove', { clientX: x(0.1) });
  assert.equal(video.currentTime, 5, '松手后轨道不再吃移动');
  assert.equal(get('rail').getAttribute('aria-valuenow'), '5000');
  // 已经有待剪块时，点轨道只挪播放头，不改草稿
  get('mode').fire('click');
  assert.equal(get('handle-draft-start').getAttribute('aria-valuenow'), '5000');
  seekToRatio(rail, 0.1);
  assert.equal(video.currentTime, 1);
  assert.equal(get('handle-draft-start').getAttribute('aria-valuenow'), '5000', '草稿没被动过');
});

test('播放就是剪后成片：跳过每一段已剪区间，也停在保留终点', async () => {
  const { get, video } = await mount();
  let plays = 0;
  video.play = async () => { plays += 1; video.paused = false; };
  video.pause = () => { video.paused = true; };
  const rail = get('rail');
  // 首尾各裁一点，中间剪两段
  get('handle-start').fire('pointerdown', { clientX: x(0) });
  get('handle-start').fire('pointermove', { clientX: x(0.1) });
  get('handle-start').fire('pointerup', {});
  get('handle-end').fire('pointerdown', { clientX: x(1) });
  get('handle-end').fire('pointermove', { clientX: x(0.9) });
  get('handle-end').fire('pointerup', {});
  seekToRatio(rail, 0.3);
  get('mode').fire('click');
  get('confirm-cut').fire('click');
  seekToRatio(rail, 0.6);
  get('mode').fire('click');
  get('confirm-cut').fire('click');
  assert.equal(get('mark-start').textContent, '起点 00:01.000');
  assert.equal(get('mark-end').textContent, '终点 00:09.000');
  assert.equal(get('mark-cuts').textContent, '已剪 2 段 · 00:03.000–00:04.000、00:06.000–00:07.000');

  get('play').fire('click');
  await tick();
  assert.equal(plays, 1);
  assert.equal(get('play').getAttribute('aria-pressed'), 'true');
  assert.match(get('status').textContent, /接缝/, '明确说明接缝不是逐帧精确');
  video.currentTime = 0.5; video.fire('timeupdate');
  assert.equal(video.currentTime, 1, '起点之前先落到保留起点');
  video.currentTime = 3.2; video.fire('timeupdate');
  assert.equal(video.currentTime, 4, '越过第一段剪掉的区间');
  video.currentTime = 6.5; video.fire('timeupdate');
  assert.equal(video.currentTime, 7, '越过第二段剪掉的区间');
  video.currentTime = 9; video.fire('timeupdate');
  assert.equal(get('play').getAttribute('aria-pressed'), 'false', '到保留终点就停');
  assert.match(get('status').textContent, /修剪后的视频播放结束/);
  // 再按播放从头（保留起点）重放，不会卡在终点
  get('play').fire('click');
  await tick();
  assert.equal(Math.round(video.currentTime * 1000), 1000);
  get('play').fire('click');
  assert.equal(get('play').getAttribute('aria-pressed'), 'false');
});

test('待剪块两端书立与键盘：方向键微调、Enter 确认、Backspace 放弃、Ctrl+Z 撤销', async () => {
  const { doc, get, video } = await mount();
  seekToRatio(get('rail'), 0.2);
  get('mode').fire('click');
  assert.equal(get('handle-draft-start').getAttribute('aria-valuenow'), '2000');
  get('handle-draft-end').fire('keydown', { key: 'ArrowRight' });
  assert.equal(get('handle-draft-end').getAttribute('aria-valuenow'), '3100');
  get('handle-draft-start').fire('keydown', { key: 'ArrowRight', shiftKey: true });
  assert.equal(get('handle-draft-start').getAttribute('aria-valuenow'), '3000');
  assert.equal(video.currentTime, 3, '调书立时画面跟着走');
  // 剪光会被拒绝，草稿留着继续调
  get('handle-draft-start').fire('keydown', { key: 'Home' });
  assert.equal(get('handle-draft-start').getAttribute('aria-valuenow'), '0');
  get('handle-draft-end').fire('keydown', { key: 'End' });
  assert.equal(get('handle-draft-end').getAttribute('aria-valuenow'), '10000');
  get('rail').fire('keydown', { key: 'Enter' });
  assert.match(get('status').textContent, /至少要留下/);
  assert.equal(get('draft').hidden, false);
  // 调到 1100–9000 再确认
  get('handle-draft-start').fire('keydown', { key: 'ArrowRight' });
  get('handle-draft-start').fire('keydown', { key: 'ArrowRight', shiftKey: true });
  assert.equal(get('handle-draft-start').getAttribute('aria-valuenow'), '1100');
  get('handle-draft-end').fire('keydown', { key: 'ArrowLeft', shiftKey: true });
  assert.equal(get('handle-draft-end').getAttribute('aria-valuenow'), '9000');
  get('rail').fire('keydown', { key: 'Enter' });
  assert.equal(get('mark-cuts').textContent, '已剪 1 段 · 00:01.100–00:09.000');
  doc.fire('keydown', { key: 'z', ctrlKey: true });
  assert.equal(get('mark-cuts').textContent, '未剪', 'Ctrl+Z 撤销刚剪的一段');
  // C 起一段、Backspace 放弃
  seekToRatio(get('rail'), 0.5);
  doc.fire('keydown', { key: 'c' });
  assert.equal(get('draft').hidden, false);
  assert.equal(get('handle-draft-start').getAttribute('aria-valuenow'), '5000');
  doc.fire('keydown', { key: 'Backspace' });
  assert.equal(get('draft').hidden, true);
  assert.match(get('status').textContent, /已取消这次选择/);
});

test('只用键盘也能起一段：轨道 Enter 拿 1 秒草稿，调完再 Enter 剪掉', async () => {
  const { get } = await mount();
  get('rail').fire('keydown', { key: 'ArrowRight', shiftKey: true });
  assert.equal(get('video').currentTime, 1, '先把播放头挪到 1 秒');
  get('rail').fire('keydown', { key: 'Enter' });
  assert.equal(get('draft').hidden, false, '轨道 Enter 从播放头起一段草稿');
  assert.equal(get('handle-draft-start').getAttribute('aria-valuenow'), '1000');
  assert.equal(get('handle-draft-end').getAttribute('aria-valuenow'), '2000');
  get('handle-draft-end').fire('keydown', { key: 'ArrowRight' });
  assert.equal(get('handle-draft-end').getAttribute('aria-valuenow'), '2100');
  get('rail').fire('keydown', { key: 'Enter' });
  assert.equal(get('mark-cuts').textContent, '已剪 1 段 · 00:01.000–00:02.100');
});

test('首尾书立仍可键盘/拖动微调，且不能越过已剪的那一段', async () => {
  const { get } = await mount();
  seekToRatio(get('rail'), 0.3);
  get('mode').fire('click');
  get('confirm-cut').fire('click');
  get('handle-start').fire('keydown', { key: 'End' });
  assert.equal(get('handle-start').getAttribute('aria-valuenow'), '2999', '起点止步在第一段之前');
  get('handle-end').fire('keydown', { key: 'Home' });
  assert.equal(get('handle-end').getAttribute('aria-valuenow'), '4001', '终点止步在最后一段之后');
  get('handle-start').fire('pointerdown', { clientX: x(0) });
  get('handle-start').fire('pointermove', { clientX: x(0.9) });
  get('handle-start').fire('pointerup', {});
  assert.equal(get('handle-start').getAttribute('aria-valuenow'), '2999');
  assert.equal(get('bl-start').style.left, '29.99%');
});

test('「取消选择」丢掉待剪块，已剪的段不受影响', async () => {
  const { get } = await mount();
  seekToRatio(get('rail'), 0.3);
  get('mode').fire('click');
  get('confirm-cut').fire('click');
  seekToRatio(get('rail'), 0.6);
  get('mode').fire('click');
  assert.equal(get('draft').hidden, false);
  get('discard-draft').fire('click');
  assert.equal(get('draft').hidden, true);
  assert.equal(get('mark-cuts').textContent, '已剪 1 段 · 00:03.000–00:04.000', '已剪的段不动');
  assert.match(get('status').textContent, /已取消这次选择/);
});

test('无法读取时长时不猜范围，原视频仍可保存', async () => {
  const { get } = await mount({ durationMs: null });
  get('video').duration = Infinity;
  get('video').fire('loadedmetadata');
  assert.equal(get('save').disabled, false, '读不到时长也能存原片');
  assert.equal(get('save').textContent, '保存视频');
  assert.equal(get('mode').disabled, true);
  assert.equal(get('handle-start').getAttribute('aria-disabled'), 'true');
  assert.match(get('status').textContent, /无法读取视频时长/);
});

test('Esc 走关闭确认，导出失败不会静默丢弃原片', async () => {
  const doc = fakeDocument();
  const calls = [];
  const app = initVideoEditor(doc, {
    load: async () => ({ bytes: new Uint8Array([1]), mimeType: 'video/webm' }),
    saveOriginal: async () => { calls.push('original'); return { saved: false, canceled: true }; },
    exportEdit: async payload => { calls.push(['export', payload]); return { saved: false, canceled: false, message: '剪辑导出失败，原视频仍保留' }; },
    close: async () => { calls.push('close'); return { canceled: true }; },
  });
  await app.ready;
  const video = doc.getElementById('video');
  video.duration = 10; video.fire('loadedmetadata');
  doc.fire('keydown', { key: 'Escape' });
  await tick();
  assert.deepEqual(calls, ['close']);
  // 先剪一段：同一个保存钮此时才交剪辑计划；没剪之前它存的是原片。
  seekToRatio(doc.getElementById('rail'), 0.3);
  doc.getElementById('mode').fire('click');
  doc.getElementById('confirm-cut').fire('click');
  doc.getElementById('save').fire('click');
  await tick();
  assert.deepEqual(calls[1], ['export', { durationMs: 10000, startMs: 0, endMs: 10000, cuts: [{ startMs: 3000, endMs: 4000 }] }]);
  assert.match(doc.getElementById('status').textContent, /原视频仍保留/);
});

test('没剪过时点保存直接存原片，不白跑一趟重编码', async () => {
  const calls = [];
  const bridge = {
    ...bridgeFor(),
    saveOriginal: async () => { calls.push('original'); return { saved: true, message: '已保存原视频' }; },
    exportEdit: async payload => { calls.push(['export', payload]); return { saved: true }; },
  };
  const { get } = await mount({ bridge });
  get('save').fire('click');
  await tick();
  assert.deepEqual(calls, ['original'], '没有剪辑就不要调导出');
  assert.equal(get('status').textContent, '已保存原视频');
});

test('标尺刻度按真实毫秒对齐，标签随可用宽度变稀疏', async () => {
  const wide = rulerTicks(3091, 792);
  assert.equal(wide.stepMs, 1000);
  const majors = wide.ticks.filter(t => t.major);
  assert.deepEqual(majors.map(t => t.ms), [0, 1000, 2000, 3000]);
  assert.deepEqual(majors.map(t => t.label), ['0:00', '0:01', '0:02', '0:03']);
  for (const tick of wide.ticks) assert.ok(tick.ms >= 0 && tick.ms <= 3091 && Number.isInteger(tick.ms));
  assert.ok(wide.ticks.every((t, i, all) => i === 0 || t.ms > all[i - 1].ms), '刻度必须递增');
  assert.ok(wide.ticks.length <= 160);
  assert.equal(majors[0].align, 'start', '端点标签向内贴边，刻度本身仍在 0');
  const long = rulerTicks(600000, 300);
  assert.ok(long.stepMs >= 60000, '窄窗长视频用更大的步长');
  assert.ok(long.ticks.filter(t => t.major).length <= 7);
  assert.equal(rulerTicks(0, 500).ticks.length, 0);
  assert.equal(rulerTicks(NaN, 500).ticks.length, 0);
  assert.equal(rulerLabel(90500, 1000), '1:30');
  assert.equal(rulerLabel(750, 500), '0:00.8');
});

test('边界线跟着书立走，已剪段的方块也画在轨道上', async () => {
  const { get } = await mount();
  assert.equal(get('bl-start').style.left, '0%');
  assert.equal(get('bl-end').style.left, '100%');
  get('handle-start').fire('pointerdown', { clientX: x(0.25) });
  get('handle-start').fire('pointermove', { clientX: x(0.25) });
  get('handle-start').fire('pointerup', {});
  assert.equal(get('bl-start').style.left, '25%', '边界线与书立同一条时间戳');
  seekToRatio(get('rail'), 0.5);
  get('mode').fire('click');
  get('handle-draft-end').fire('keydown', { key: 'End' });
  assert.equal(get('handle-draft-end').getAttribute('aria-valuenow'), '10000');
  get('confirm-cut').fire('click');
  assert.equal(get('cuts').hidden, false);
  assert.equal(get('cuts').children[0].style.left, '50%');
  assert.equal(get('cuts').children[0].style.width, '50%');
});

test('页面契约：点「裁剪」即出草稿（轨道只定位）、任务栏标题交给产品名、草稿与已剪段样式分开', async () => {
  const html = await readFile(new URL('../renderer/video-editor.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../renderer/video-editor.css', import.meta.url), 'utf8');
  const js = await readFile(new URL('../renderer/video-editor.mjs', import.meta.url), 'utf8');
  // 页面 title 固定产品名：窗口标题/图标由宿主决定，不用「视频剪辑」覆盖任务栏
  assert.match(html, /<title>截个图<\/title>/);
  assert.doesNotMatch(html, /<title>[^<]*视频剪辑/, '页面 title 不能覆盖宿主标题');
  assert.match(html, /class="titlebar-text">视频剪辑</, '页内标题保留');
  assert.match(html, /media-src blob:;/);
  assert.doesNotMatch(html, /<video[^>]*\scontrols/);
  assert.match(html, /class="titlebar"[\s\S]*id="close"/);
  assert.match(html, /id="handle-start"[\s\S]*role="slider"/);
  assert.doesNotMatch(html, /id="preview"/, '不再有独立的剪辑预览按钮');
  assert.match(html, /id="mode"[^>]*>裁剪</);
  assert.doesNotMatch(html, /id="mode"[^>]*aria-pressed/, '「裁剪」是动作，不是模式开关');
  assert.match(html, /id="confirm-cut"[^>]*>剪掉这段</);
  assert.doesNotMatch(html, /id="set-draft-(?:start|end)"/);
  assert.match(html, /id="undo"/);
  assert.match(html, /id="handle-draft-start"/);
  assert.match(html, /class="tray"[\s\S]*id="confirm-cut"/, '裁剪命令与时间轴在同一张托盘里');
  assert.match(html, /id="ruler"/);
  assert.match(html, /class="boundaries" id="boundaries"/);
  assert.match(css, /\.titlebar\{[^}]*-webkit-app-region:drag/);
  assert.match(css, /\.titlebar-action\{[^}]*-webkit-app-region:no-drag/);
  assert.match(css, /\.lane-trim\{top:0\}/);
  assert.match(css, /\.lane-draft\{bottom:0/);
  assert.match(css, /\.rail\{[^}]*touch-action:none/);
  assert.match(css, /\.handle\{[^}]*touch-action:none/);
  assert.doesNotMatch(css, /crosshair/, '轨道不再是选区光标');
  assert.doesNotMatch(css, /#mode\[aria-pressed/, '旧的裁剪模式按压态一起撤掉');
  assert.doesNotMatch(css, /\.preview/, '旧的预览按钮样式一起撤掉');
  assert.match(css, /--pink:#b2557a/);
  assert.match(css, /\.cut-block\{[^}]*repeating-linear-gradient\(135deg,#b2557a1f/, '已剪段用极淡斜纹区分');
  assert.match(css, /\.rail-draft\{[^}]*outline:1px dashed var\(--mint-deep\)/, '待剪块是薄荷虚线草稿');
  assert.match(css, /\.handle\.draft::before\{[^}]*border:1px dashed/, '待剪书立也是虚线的');
  assert.match(css, /\.bl\.trim\{top:-5px/, '保留边界线贯穿到书立内缘');
  // 轨道自身不许再长出待剪块：没有拖动选段的中间态
  assert.doesNotMatch(js, /railAnchor|DRAG_THRESHOLD_PX|cropMode/, '轨道上不再有拖动建段的路径');
  assert.match(js, /export const MAX_CUTS = 24/);
  assert.match(js, /export const DEFAULT_CUT_MS = 1000/);
  assert.match(js, /export function draftAt/);
  assert.match(js, /el\('mode'\)\.addEventListener\('click', beginDraft\)/);
  assert.match(js, /action\('exportEdit', toPayload\(range\)\)/, '导出用归一化后的计划');
  assert.match(js, /requestVideoFrameCallback/, '接缝优先用帧回调');
  assert.match(js, /video\.muted = !video\.muted/);
});

test('浮条样式只有一份，两页共用同一份文件', async () => {
  const css = await readFile(new URL('../renderer/video-indicator.css', import.meta.url), 'utf8');
  const html = await readFile(new URL('../renderer/video-indicator.html', import.meta.url), 'utf8');
  const surface = await readFile(new URL('../renderer/video-surface.html', import.meta.url), 'utf8');
  assert.match(html, /href="video-indicator\.css"/);
  assert.match(surface, /href="video-indicator\.css"/, '两页必须共用同一份样式');
  assert.match(css, /html,body\{[^}]*background:transparent/, '根节点透明，圆角才透得出来');
  assert.match(css, /\.bar\{[^}]*background:#f7faf6/, '卡片自己铺底色');
  assert.match(css, /\.bar\{[^}]*border-radius:10px/, '圆角由卡片自己画');
});

// ── 事务式接缝：真实 seek 模型与回归 ────────────────────────────────────────
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 用 UI 路径建好“首尾 1s/9s + 两处已剪 [3,4]/[6,7]”（此时还是简单 fake，不触发真实 seek）。
async function makeTwoCuts(get) {
  const rail = get('rail');
  get('handle-start').fire('pointerdown', { clientX: x(0) });
  get('handle-start').fire('pointermove', { clientX: x(0.1) });
  get('handle-start').fire('pointerup', {});
  get('handle-end').fire('pointerdown', { clientX: x(1) });
  get('handle-end').fire('pointermove', { clientX: x(0.9) });
  get('handle-end').fire('pointerup', {});
  seekToRatio(rail, 0.3); get('mode').fire('click'); get('confirm-cut').fire('click');
  seekToRatio(rail, 0.6); get('mode').fire('click'); get('confirm-cut').fire('click');
}

// 真实 seek 模型：把“播放位置”与“seek”分开，模拟浏览器 seek 后可能停住/冻结/卡 seek。
// stall: 'none' | 'paused'(seek 后 paused=true) | 'frozen'(paused=false 但不推进) | 'seekStuck'(首次 seek 永不完成)
function installSeekModel(video, { stall = 'none' } = {}) {
  const state = { pos: Number(video.currentTime) || 0, target: 0, frozen: false, pausedRecently: false, stuckUsed: false, seeks: [], plays: 0, pauses: 0 };
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get() { return video.seeking ? state.target : state.pos; },
    set(sec) {
      state.seeks.push(sec);
      state.target = sec;
      video.seeking = true;
      if (stall === 'seekStuck' && !state.stuckUsed) { state.stuckUsed = true; return; } // 首次 seek 永不完成
      queueMicrotask(() => {
        video.seeking = false;
        state.pos = sec;
        if (!video.paused && stall !== 'none') {
          if (stall === 'paused') video.paused = true;
          else if (stall === 'frozen') state.frozen = true;
        }
        video.fire('seeked');
      });
    },
  });
  video.play = async () => {
    state.plays += 1;
    if (state.frozen && state.pausedRecently) state.frozen = false;   // 只有 pause→play 才解冻
    state.pausedRecently = false;
    video.paused = false;
    video.fire('play');
  };
  video.pause = () => {
    state.pauses += 1;
    state.pausedRecently = true;
    video.paused = true;
    video.seeking = false;                                            // 中止卡住的 seek
    video.fire('pause');
  };
  video.advance = sec => { if (!state.frozen) { state.pos += sec; video.fire('timeupdate'); } };
  return state;
}

test('接缝后 paused=true 停住：seeked 即按播放意图 play 恢复，每处接缝只 seek 一次并越过两处', async () => {
  const { get, video } = await mount({ opts: { resumeMs: 30 } });
  await makeTwoCuts(get);
  const state = installSeekModel(video, { stall: 'paused' });
  video.currentTime = 1; await tick();
  state.seeks.length = 0; video.paused = true;
  get('play').fire('click'); await tick();
  assert.equal(video.paused, false);
  video.advance(1.9); await tick();
  video.advance(0.2); await tick();                 // 3.1 → seek 4，停住→seeked 恢复
  assert.equal(state.seeks.length, 1, '第一处接缝只 seek 一次');
  assert.equal(Math.round(video.currentTime * 1000), 4000);
  assert.equal(video.paused, false, 'seeked 后已恢复播放');
  video.advance(1.9); await tick();
  video.advance(0.2); await tick();                 // 6.1 → seek 7
  assert.equal(state.seeks.length, 2, '第二处接缝只 seek 一次');
  assert.equal(Math.round(video.currentTime * 1000), 7000);
  assert.equal(video.paused, false);
  video.advance(1.9); await tick();
  video.advance(0.2); await tick();                 // 9.1 → 保留终点，停
  assert.equal(get('play').getAttribute('aria-pressed'), 'false');
});

test('接缝后 paused=false 但画面冻结：看门狗按“不推进”判定，做一次 pause→play 恢复并越过两处接缝', async () => {
  const { get, video } = await mount({ opts: { resumeMs: 30 } });
  await makeTwoCuts(get);
  const state = installSeekModel(video, { stall: 'frozen' });
  video.currentTime = 1; await tick();
  state.seeks.length = 0; video.paused = true; state.frozen = false;
  get('play').fire('click'); await tick();
  video.advance(1.9); await tick();
  video.advance(0.2); await tick();                 // 3.1 → seek 4，冻结（paused 仍 false）
  assert.equal(state.seeks.length, 1);
  assert.equal(Math.round(video.currentTime * 1000), 4000);
  assert.equal(video.paused, false, '冻结时 paused 仍为 false（不能只查 paused）');
  assert.equal(state.frozen, true);
  await sleep(40);                                  // 看门狗 pause→play 解冻
  assert.equal(state.frozen, false, '看门狗按不推进判定并 pause→play 解冻');
  video.advance(0.5); await tick();                 // 在 retry 前推进，证明恢复
  await sleep(40);
  assert.equal(get('play').getAttribute('aria-pressed'), 'true', '恢复后仍在播放');
  video.advance(1.4); await tick();
  video.advance(0.2); await tick();                 // 6.1 → seek 7，再冻结
  assert.equal(state.seeks.length, 2, '每处接缝只 seek 一次，无重复 seek');
  await sleep(40);
  assert.equal(state.frozen, false);
  video.advance(0.5); await tick();
  await sleep(40);
  video.advance(1.4); await tick();
  video.advance(0.2); await tick();                 // 9.1 → 停
  assert.equal(get('play').getAttribute('aria-pressed'), 'false');
});

test('seek 永不完成（seeking 卡在途）：有界超时也会 pause→play 解卡，不会永远挂着', async () => {
  const { get, video } = await mount({ opts: { resumeMs: 30 } });
  await makeTwoCuts(get);
  const state = installSeekModel(video, { stall: 'seekStuck' });
  video.currentTime = 1; await tick();
  state.seeks.length = 0; video.paused = true;
  get('play').fire('click'); await tick();
  video.advance(1.9); await tick();
  video.advance(0.2); await tick();                 // 3.1 → seek 4 卡在途
  assert.equal(video.seeking, true, 'seek 卡在途');
  await sleep(45);                                  // 有界看门狗解卡
  assert.ok(state.pauses >= 1, '看门狗做了一次 pause');
  assert.equal(video.seeking, false, '卡住的 seek 被中止，不再永远 seeking');
});

test('同一接缝反复触发只产生一个真实 seek；用户暂停后看门狗绝不复活播放', async () => {
  const { get, video } = await mount({ opts: { resumeMs: 30 } });
  await makeTwoCuts(get);
  const state = installSeekModel(video, { stall: 'frozen' });
  video.currentTime = 1; await tick();
  state.seeks.length = 0; video.paused = true; state.frozen = false;
  get('play').fire('click'); await tick();
  video.advance(2.1); await tick();                 // 3.1 → seek 4
  video.fire('timeupdate'); video.fire('timeupdate'); await tick();  // 重复触发
  assert.equal(state.seeks.length, 1, '重复触发不产生第二个 seek');
  await sleep(40);                                  // 看门狗解冻
  video.advance(0.5); await tick();
  const playsBefore = state.plays;
  get('play').fire('click');                        // 用户暂停
  assert.equal(get('play').getAttribute('aria-pressed'), 'false');
  await sleep(80);                                  // 超过看门狗两段时间
  assert.equal(state.plays, playsBefore, '用户暂停后看门狗不再 play（不复活）');
  assert.equal(video.paused, true);
});

test('导出剪辑立刻给诚实状态，完成后才换结果文案（不改保存窗口顺序）', async () => {
  let resolveExport;
  const pending = new Promise(resolve => { resolveExport = resolve; });
  const bridge = { ...bridgeFor(), exportEdit: () => pending };
  const { get } = await mount({ bridge });
  seekToRatio(get('rail'), 0.3);
  get('mode').fire('click');
  get('confirm-cut').fire('click');
  get('save').fire('click');
  await tick();
  assert.equal(get('status').textContent, '正在导出剪辑… 导出完成后会打开保存窗口');
  assert.equal(get('save').disabled, true);
  resolveExport({ saved: true, message: '已导出剪辑：D:/edited.mp4' });
  await tick();
  assert.equal(get('status').textContent, '已导出剪辑：D:/edited.mp4');
  assert.equal(get('save').disabled, false);
});
