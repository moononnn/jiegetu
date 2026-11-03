import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Worker } from 'node:worker_threads';
import { createAutoScrollSession } from '../core/auto-scroll-session.mjs';
import { createScene } from './fixtures/auto-scenes.mjs';
import { sanitize } from '../main/diagnostics.cjs';

// 本轮新增面：长截图收尾的固定 10 个诊断数字，从 core → Worker → renderer → 主进程白名单逐处接上。
// 只验“数字能读到、形态被限制、缺失不补 0”，不把任何像素、坐标、路径或异常原文带进诊断。

const NUMBERS = ['supportCalls', 'supportMs', 'changeDomainCalls', 'changeDomainMs',
  'backgroundObserveCalls', 'backgroundObserveMs', 'backgroundExtendCalls', 'backgroundExtendMs',
  'relocationBudgetGiveUps', 'backgroundExtensionFallbacks'];
const STAGE_KEYS = ['support', 'changeDomain', 'backgroundObserve', 'backgroundExtend'];

// renderer 是浏览器脚本：去掉 import 行后在 vm 里执行，直接测试它自己的数字挑选函数。
const rendererSource = fs.readFileSync(new URL('../renderer/scroll-capture.mjs', import.meta.url), 'utf8').replace(/^import[^\n]+\n/, '');
function rendererContext() {
  const noop = () => {};
  // 顶层会注册 onScrollStop/onScrollAbort：任何未声明的 selection 方法都用空实现兼容。
  const selection = new Proxy({}, { get: () => noop });
  const window = new Proxy({ selection }, {
    get: (target, key) => (key in target ? target[key] : noop),
    set: (target, key, value) => { target[key] = value; return true; },
  });
  const context = vm.createContext({
    window, navigator: { userActivation: { isActive: true } }, document: { addEventListener: noop, removeEventListener: noop },
    performance, setTimeout, clearTimeout, console, structuredClone, OffscreenCanvas: class {}, requestAnimationFrame: noop,
  });
  vm.runInContext(rendererSource, context, { filename: 'scroll-capture.mjs' });
  return context;
}

test('renderer 固定挑选函数：只收 10 个非负有限数字，嵌套对象与未知字段一律丢弃', () => {
  const context = rendererContext();
  const pick = context.analysisMetrics;
  assert.equal(typeof pick, 'function', 'renderer 必须自带数字挑选函数');
  const packet = {
    ...Object.fromEntries(NUMBERS.map(key => [key, 1.5])),
    stageTimings: { support: { calls: 1, durationMs: 2 } },
    added: 3, unknownField: 4, supportMsNaN: Number.NaN,
  };
  const picked = pick(packet);
  assert.deepEqual(Object.keys(picked).sort(), [...NUMBERS].sort(), '只保留固定 10 键');
  assert.equal('stageTimings' in picked, false, '不接受嵌套计时对象');
  assert.equal('added' in picked, false);
  assert.equal('unknownField' in picked, false, '未知字段不得透传');
  // 跨 realm 的对象原型不同，按 JSON 比较。
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(pick({ supportCalls: -1, supportMs: Infinity, changeDomainCalls: 2 })), { changeDomainCalls: 2 },
    '非法数值直接不写，不补 0');
  assert.deepEqual(plain(pick(null)), {});
  assert.deepEqual(plain(pick(undefined)), {});
});

test('renderer 源码：done 包在进入编码前落到本会话分析数字，且不跨会话补值', () => {
  const source = rendererSource;
  assert.ok(source.includes("state.analysisMetrics = analysisMetrics(packet)"), 'done 包必须先取一次数字快照');
  assert.ok(source.includes('analysisMetrics: {}'), '新会话从空值开始，不继承上一场');
  // 恢复路径没有 done 包：只有 worker-finishing 读 state.analysisMetrics，不能从旧 state 或 output 偷填。
  const traceAt = source.indexOf("trace('worker-finishing'");
  assert.ok(traceAt >= 0, 'worker-finishing 追踪必须存在');
  const traceBody = source.slice(traceAt, traceAt + 2400);
  assert.ok(traceBody.includes('...state.analysisMetrics'), '收尾追踪必须读取本会话数字');
  assert.equal(/analysisMetrics\s*=\s*output/.test(source), false, '不得从 output 反推数字');
});

test('core counters：两个放弃计数是独立整数，嵌套 stageTimings 不随输出外传', () => {
  const scene = createScene({ offsets: [0, 16, 32, 48, 64] });
  const session = createAutoScrollSession(scene.seedFrame, { analysisBudgetMs: Infinity });
  let at = 0;
  for (const frame of scene.frames) session.accept(frame.image, at += 50);
  const output = session.finish();
  const counters = session.counters();
  assert.equal(counters.relocationBudgetGiveUps, 0, '正常路径不放弃重定位');
  assert.equal(counters.backgroundExtensionFallbacks, 0, '正常路径不退让');
  for (const key of STAGE_KEYS) assert.deepEqual(Object.keys(counters.stageTimings[key]).sort(), ['calls', 'durationMs']);
  assert.equal('stageTimings' in output, false, '成图输出不带嵌套计时');
  assert.equal('relocationBudgetGiveUps' in output, false);
  assert.equal('backgroundExtensionFallbacks' in output, false);
});

function channel(worker) {
  const waiting = [];
  worker.on('message', value => { if (value?.type === 'evidence-invalidated') return; waiting.shift()?.(value); });
  return packet => new Promise(resolve => { waiting.push(resolve); worker.postMessage(packet, packet.image ? [packet.image.data.buffer] : []); });
}
async function transport(prefix) {
  const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(`
 import { parentPort } from 'node:worker_threads';
 ${prefix}
 globalThis.self = { postMessage: (packet, transfer) => parentPort.postMessage(packet, transfer) };
 await import(${JSON.stringify(new URL('../renderer/scroll-match-worker.mjs', import.meta.url).href)});
 parentPort.on('message', data => self.onmessage({ data }));`)), { type: 'module' });
  return { worker, send: channel(worker) };
}
const assertOnlyNumbers = (packet, where) => {
  for (const key of NUMBERS) {
    if (!(key in packet)) continue;
    assert.ok(Number.isFinite(packet[key]) && packet[key] >= 0, `${where} 的 ${key} 必须是非负有限数字：${packet[key]}`);
  }
  assert.equal('stageTimings' in packet, false, `${where} 不得带嵌套计时对象`);
  assert.equal('analysisMetrics' in packet, false, `${where} 不得整包透传`);
};

test('真实 Worker：sample 与 done 都带固定数字，done 在清理前取值', async () => {
  const scene = createScene({ offsets: [0, 16, 32, 48, 64] });
  const { worker, send } = await transport('');
  try {
    assert.equal((await send({ type: 'init', image: structuredClone(scene.seedFrame) })).type, 'ready');
    const samples = [];
    for (let index = 1; index < scene.frames.length; index += 1) {
      const packet = await send({ type: 'frame', id: index, image: structuredClone(scene.frames[index].image), atMs: index * 50 });
      assert.equal(packet.type, 'sample');
      assertOnlyNumbers(packet, `sample#${index}`);
      samples.push(packet);
    }
    const done = await send({ type: 'finish' });
    assert.equal(done.type, 'done');
    assertOnlyNumbers(done, 'done');
    for (const key of NUMBERS) assert.ok(key in done, `done 包必须带 ${key}（清理前快照）`);
    // 清理后再取只会得到空对象；这里用至少一个计数证明快照发生在 clear 之前。
    assert.ok(done.supportCalls > 0, `done 的 supportCalls 不应是清理后的空值：${done.supportCalls}`);
    const lastSample = samples.at(-1);
    assert.ok(done.supportCalls >= lastSample.supportCalls, 'done 的累计值不能小于最后一条 sample');
    assert.ok(done.supportMs >= 0 && done.backgroundObserveMs >= 0);
    // 背景延展阶段在 finish() 内执行：done 必须带上它的整数计数，并与同场景 core 完成后一致。
    const core = createAutoScrollSession(scene.seedFrame, { analysisBudgetMs: 4000 });
    for (let index = 1; index < scene.frames.length; index += 1) core.accept(scene.frames[index].image, index * 50);
    core.finish();
    const coreCounters = core.counters();
    for (const [key, stage] of [['supportCalls', 'support'], ['changeDomainCalls', 'changeDomain'], ['backgroundObserveCalls', 'backgroundObserve'], ['backgroundExtendCalls', 'backgroundExtend']]) {
      assert.equal(done[key], coreCounters.stageTimings[stage].calls, `done 的 ${key} 必须等于同场景 core 的 ${stage}.calls`);
    }
    assert.equal(done.backgroundExtendCalls, 1, `普通收尾必须真的计到一次延展阶段：${done.backgroundExtendCalls}`);
    assert.equal(done.relocationBudgetGiveUps, coreCounters.relocationBudgetGiveUps, '重定位放弃计数必须与核心一致');
    assert.equal(done.backgroundExtensionFallbacks, coreCounters.backgroundExtensionFallbacks, '延展退让计数必须与核心一致');
    assert.equal(done.backgroundExtensionFallbacks, 0, `未超时不得报退让：${done.backgroundExtensionFallbacks}`);
  } finally {
    await worker.terminate();
  }
});

test('真实 Worker：error 包沿用同一份数字白名单，不带嵌套计时', async () => {
  const scene = createScene({ offsets: [0, 16, 32, 48, 64] });
  // 第 1 次读取（init 后的 startBudget）返回 0，之后暴增：第一帧就在预算内停止。
  const prefix = `let reads = 0; performance.now = () => { reads += 1; return reads > 1 ? 1e6 * reads : 0; };`;
  const { worker, send } = await transport(prefix);
  try {
    assert.equal((await send({ type: 'init', image: structuredClone(scene.seedFrame) })).type, 'ready');
    let failure = null;
    for (let index = 1; index < scene.frames.length && !failure; index += 1) {
      const packet = await send({ type: 'frame', id: index, image: structuredClone(scene.frames[index].image), atMs: index * 50 });
      if (packet.type === 'error') failure = packet;
    }
    if (!failure) failure = await send({ type: 'finish' });
    assert.equal(failure.type, 'error');
    assert.equal(failure.code, 'analysis-budget');
    assertOnlyNumbers(failure, 'error');
    for (const key of ['supportCalls', 'supportMs', 'changeDomainMs', 'backgroundExtensionFallbacks']) {
      assert.ok(key in failure, `error 包必须带 ${key}`);
    }
  } finally {
    await worker.terminate();
  }
});

test('主进程白名单：接受固定 10 个数字，拒绝嵌套对象、未知字段与非有限值', () => {
  const accepted = sanitize(Object.fromEntries(NUMBERS.map(key => [key, 12.3456])));
  assert.deepEqual(Object.keys(accepted).sort(), [...NUMBERS].sort(), '固定 10 键必须全部接受');
  for (const key of NUMBERS) assert.equal(accepted[key], 12.346, '保留三位小数');
  assert.deepEqual(sanitize({ stageTimings: { support: { calls: 1 } } }), {}, '嵌套对象不得进入诊断');
  assert.deepEqual(sanitize({ supportCalls: Number.NaN, supportMs: Infinity }), {});
  assert.deepEqual(sanitize({ relocationBudgetGiveUps: 'many', backgroundExtensionFallbacks: true }), {});
  assert.deepEqual(sanitize({ mysteryMetric: 1 }), {}, '未知字段一律拒绝');
});
