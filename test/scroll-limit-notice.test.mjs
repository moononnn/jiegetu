import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CheckRegions = require('../core/check-regions.js');

// 浮条提醒与到限提示只跑逻辑层：用假的 OffscreenCanvas/图片数据走真实 renderer/scroll-capture.mjs，
// 不编码真 PNG、不采桌面、不写剪贴板。真实 Chromium 的解码/渲染另在 experiments 里验。
const source = fs.readFileSync(new URL('../renderer/scroll-capture.mjs', import.meta.url), 'utf8');

function boot() {
  const progress = [], traces = [], results = [], finishing = [], errors = [], packets = [];
  class FakeCanvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() { return { putImageData() {} }; }
    async convertToBlob() { return { size: this.width * this.height * 4, arrayBuffer: async () => new ArrayBuffer(24) }; }
  }
  class FakeImageData { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } }
  const selection = {
    onScrollStop() {}, onScrollAbort() {},
    scrollProgress: async (_, patch) => progress.push(patch),
    scrollFinishing: async token => finishing.push(token),
    scrollResult: async (token, buffer, warning, recovered, checkRegions) => results.push({ token, bytes: buffer.byteLength, warning, recovered, checkRegions }),
    scrollError: async (token, message, reason) => errors.push({ token, message, reason }),
    diagnostic: async (event, fields) => traces.push({ event, fields }),
  };
  const context = { window: { selection, CheckRegions }, performance: { now: () => 1000 }, clearTimeout() {}, clearInterval() {},
    setTimeout: () => 1, OffscreenCanvas: FakeCanvas, ImageData: FakeImageData, btoa: value => Buffer.from(value, 'binary').toString('base64') };
  vm.runInNewContext(`${source}
    globalThis.hook = {
      feed: (state, update) => { running = state; matched(state, update); },
      encode: (state, output, recovered) => { running = state; return encodedResult(state, output, recovered); },
      warn: (state, output, recovered) => resultWarning(state, output, recovered),
      pixels: MAX_CHECKPOINT_PIXELS,
    };`, context);
  return { hook: context.hook, progress, results, finishing, errors, traces, packets };
}

const OK_UPDATE = '已对齐 · 上下滚动继续接长';
function baseState(patch = {}) {
  return { config: { token: 't1', pixels: { width: 2220, height: 1000 } }, startedAt: 0, lastMotion: 0, failures: 0,
    height: 1000, chunks: 1, capturedHeight: 1000, capturedChunks: 1, sampleIndex: 0, inflight: { id: 7, atMs: 50 },
    queue: [], queueBytes: 0, matcherReady: false, lastProgress: 0, pendingWarning: '', evidenceRevision: 0,
    checkpointRevision: 0, referenceVersion: 0, previewVersion: 0, lastDroppedId: 0, lastProcessedId: 0,
    recoveryPending: false, encoding: false, analysisMetrics: {}, message: '', lastMessage: '', ...patch };
}
function update(id, height, patch = {}) {
  return { id, result: { auto: true, kind: 'forward', shift: 16 }, height, chunks: 10, added: 16,
    capturedHeight: height, capturedChunks: 10, capturedAdded: 16, complete: true, ...patch };
}
// 每帧都是一个新的在飞任务：先登记 inflight，再按真实回包喂进去。
function feed(hook, state, height, patch = {}) {
  const id = (state.lastProcessedId ?? 0) + 1;
  state.inflight = { id, atMs: 50 };
  hook.feed(state, update(id, height, patch));
  return id;
}

test('已确认高度到 85% 才提醒容量，不到不提醒；到限那一帧不再补提醒', () => {
  const { hook, progress } = boot();
  const state = baseState({ limitHeight: 14414 });
  feed(hook, state, 12000);                              // 83.2%
  assert.equal(state.message, OK_UPDATE);
  assert.doesNotMatch(progress.at(-1).message, /容量上限/);

  feed(hook, state, 12252);                              // 85.0%
  assert.match(state.message, /快到本次容量上限了，可以先完成/);
  assert.match(progress.at(-1).message, /快到本次容量上限了，可以先完成/);

  // 提醒只加一句，不重复叠加；后面的帧照样只带一句。
  feed(hook, state, 13000);
  assert.equal(state.message.split('快到本次容量上限了').length, 2);
});

test('提醒看已确认高度，不因为未确认像素凑到 85% 就提前喊', () => {
  const { hook } = boot();
  const state = baseState({ limitHeight: 14414 });
  feed(hook, state, 12000, { capturedHeight: 13000, capturedAdded: 1000, result: { auto: true, kind: 'occluded', shift: 16 } });
  assert.equal(state.height, 12000);
  assert.doesNotMatch(state.message, /容量上限/);
});

test('没拿到有效上限（旧回包）时不猜一个阈值乱提醒', () => {
  const { hook } = boot();
  const state = baseState();
  feed(hook, state, 29000);                              // 没有 limitHeight
  assert.doesNotMatch(state.message, /容量上限/);
});

test('到限收尾：预览只说到限与已截部分，不混入没有证据的缺口描述', () => {
  const { hook } = boot();
  const state = baseState({ finishReason: 'size-limit' });
  // finish 会把 LIMIT_WARNING 写进 extraWarning，这里按真实路径补上。
  const limitWarning = '已达到本次长图容量上限，仅保留已截部分；页面可能还没截完，可保存后分段继续截';
  state.extraWarning = limitWarning;
  const warning = hook.warn(state, { complete: false, missingRanges: [], warning: '已达到长图尺寸或片段上限' }, false);
  assert.equal(warning, limitWarning, 'missingRanges 为空时只说容量，不说未确认');

  // 仅有算法疑似区域不增加待检查事项。
  const withGap = hook.warn(state, { complete: false, missingRanges: [{ top: 10, bottom: 20 }], warning: 'x' }, false);
  assert.equal(withGap, limitWarning);

  // 末帧采集失败那条补充仍保留，但不重复容量那句。
  const extra = hook.warn({ ...state, extraWarning: `${limitWarning}；末帧采集未完成：超时` },
    { complete: false, missingRanges: [], warning: '' }, false);
  assert.equal(extra, `${limitWarning}；末帧采集未完成：超时`);
});

test('正常完成、缺区、恢复各自的原提示不被到限文案覆盖', () => {
  const { hook } = boot();
  const quiet = hook.warn(baseState(), { complete: true, missingRanges: [], warning: '' }, false);
  assert.equal(quiet, '', '正常完成不多说一句');
  assert.equal(hook.warn(baseState(), {complete:false,missingRanges:[{top:1,bottom:2}],warning:'有区域未确认'}, false), '', '算法置信不足不单独打扰');
  const dropped=hook.warn(baseState({lastDroppedId:4,lastProcessedId:3}), {complete:false}, false);
  assert.match(dropped,/最后一段采样未能保留.*建议重新截图/);

  const gap = hook.warn(baseState({ pendingWarning: '本帧未拼入' }), { complete: false, missingRanges: [{ top: 1, bottom: 2 }], warning: '' }, false);
  assert.match(gap, /最后一段未能接上.*建议重新截图/);
  assert.doesNotMatch(gap, /容量上限/);

  const recovered = hook.warn(baseState({ recoveryWarning: '计算中断，保留上次结果' }), { complete: false, missingRanges: [], warning: '' }, true);
  assert.equal(recovered, '计算中断，保留上次结果');
});

test('一次真实收尾路径：到限警告确实走到 scrollResult，且只交一张图', async () => {
  const { hook, results } = boot();
  const state = baseState({ finishReason: 'size-limit', height: 14000, capturedHeight: 14000,
    extraWarning: '已达到本次长图容量上限，仅保留已截部分；页面可能还没截完，可保存后分段继续截' });
  const output = { width: 2220, height: 14000, data: new Uint8ClampedArray(4), complete: false, missingRanges: [] };
  await hook.encode(state, output, false);
  await hook.encode(state, output, true);                 // 迟到回包不能再交一张
  assert.equal(results.length, 1);
  assert.match(results[0].warning, /已达到本次长图容量上限/);
  assert.equal(results[0].recovered, undefined);
  assert.equal(state.encoding, true);
});

test('外置恢复检查点与长图总预算同步，过 16M 的长图仍留得下保底', () => {
  const { hook } = boot();
  assert.equal(hook.pixels, 32_000_000);
});

test('缺区定位元数据：只有 core 真报缺区时才随第五参交给主进程，越界项不补造', async () => {
  const { hook, results } = boot();
  const state = baseState({ height: 1400, capturedHeight: 1400 });
  const output = { width: 200, height: 1400, data: new Uint8ClampedArray(8), complete: false,
    missingRanges: [{ top: 10, bottom: 40, left: 5, right: 60 }, { top: -5, bottom: 10, left: 0, right: 5 }] };
  await hook.encode(state, output, false);
  const meta = results[0].checkRegions;
  assert.equal(meta.total, 2, '计数保留，不因非法项被改写');
  assert.deepEqual(meta.rects, [{ top: 10, bottom: 40, left: 5, right: 60 }], '越界项不收');

  // 没有缺区的输出不携带这个字段，旧包形状完全不变。
  const clean = boot();
  const quietState = baseState({ height: 1400, capturedHeight: 1400 });
  await clean.hook.encode(quietState, { width: 200, height: 1400, data: new Uint8ClampedArray(8), complete: true, missingRanges: [] }, false);
  assert.equal(clean.results[0].checkRegions, undefined);
  assert.equal(clean.results[0].recovered, undefined, '元数据不占 recovered 布尔位');
});
