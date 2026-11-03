import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { createAutoScrollSession } from '../core/auto-scroll-session.mjs';
import { createScene } from './fixtures/auto-scenes.mjs';

// 第二批：四阶段计时与协作式预算轮询。这里只覆盖新增面，不改动既有匹配/恢复行为用例。

const NEW_STAGES = new Set(['support', 'change-domain', 'background-observe', 'background-extend']);
// 旧阶段（learn/修补等）同样会耗预算，扫描时会一并遇到；它们是既有契约的一部分。
const OLD_STAGES = new Set(['learn-components', 'learn-template', 'learn-mask', 'present', 'ring-matches', 'mark-repair', 'repair-copy']);
const SCENE = { offsets: [0, 16, 32, 48, 64, 80] };

const scene = () => createScene(SCENE);
function feed(session, frames) {
  const updates = [];
  let at = 0;
  for (const frame of frames) updates.push(session.accept(frame.image, at += 50));
  return updates;
}
// 前 limit 次读取返回 0，之后每次都比上一次大得多：每次 accept/finish 重起算预算也追不上，
// 耗尽点仍由读取序号确定。
function expiringClock(limit) {
  let reads = 0;
  return () => {
    reads += 1;
    return reads > limit ? 1e6 * reads : 0;
  };
}
function runToFailure(options, frames) {
  const session = createAutoScrollSession(frames[0].image, options);
  try {
    feed(session, frames);
    session.finish();
  } catch (error) {
    return error;
  }
  return null;
}
// 本轮行为变化：background-extend 超时改为退让（交未延展拼接图），其它阶段仍抛错。
// 这里需要同时拿到“抛错”与“退让输出”，因此单独留一个返回两种结果的入口。
function runToStop(options, frames) {
  const session = createAutoScrollSession(frames[0].image, options);
  try {
    feed(session, frames);
    return { output: session.finish() };
  } catch (error) {
    return { error };
  }
}
const isBackgroundFallback = output => output?.background?.active === false &&
  typeof output.warning === 'string' && output.warning.includes('背景处理超时');

test('四阶段计时只经 counters().stageTimings 导出，结构固定且不进入回包或背景返回值', () => {
  const source = scene();
  const session = createAutoScrollSession(source.seedFrame, { analysisBudgetMs: 4000, now: () => 0 });
  const updates = feed(session, source.frames);
  const output = session.finish();
  const counters = session.counters();
  assert.deepEqual(Object.keys(counters.stageTimings).sort(), ['backgroundExtend', 'backgroundObserve', 'changeDomain', 'support']);
  for (const [key, value] of Object.entries(counters.stageTimings)) {
    assert.deepEqual(Object.keys(value).sort(), ['calls', 'durationMs'], `${key} 结构不符`);
    assert.ok(Number.isInteger(value.calls) && value.calls > 0, `${key} 必须记录真实调用次数`);
    assert.ok(Number.isFinite(value.durationMs) && value.durationMs >= 0, `${key} 毫秒数必须有限非负`);
  }
  assert.ok(counters.stageTimings.support.calls >= 2, '一次完整流程里 support 会被调用多次');
  assert.equal('stageTimings' in output, false, '成图回包形状不变');
  assert.equal('stageTimings' in (output.backgroundEvidence?.extend ?? {}), false, '背景模型返回值不变');
  for (const update of updates) {
    assert.equal('stageTimings' in update, false, '单帧回包形状不变');
    assert.equal('stageTimings' in update.autoEvidence, false, 'autoEvidence 形状不变');
  }
});

test('四个新阶段都能确定触发 analysis-budget，stage 准确且 message/code 固定', () => {
  const frames = scene().frames;
  let reads = 0;
  const probe = createAutoScrollSession(frames[0].image, { analysisBudgetMs: 4000, now: () => { reads += 1; return 0; } });
  feed(probe, frames);
  probe.finish();
  assert.ok(reads > 8, `预算读取次数过少，无法定位阶段：${reads}`);
  const found = new Map();
  const legacy = new Set();
  for (let limit = 1; limit < reads; limit += 1) {
    const { error, output } = runToStop({ analysisBudgetMs: 4000, now: expiringClock(limit) }, frames);
    if (!error) {
      // 只有延展阶段允许以退让结束；其它阶段的预算耗尽不得静默变成“成功”。
      assert.ok(isBackgroundFallback(output), `limit=${limit} 既没抛错也不是延展退让：${output?.warning}`);
      if (!found.has('background-extend')) found.set('background-extend', limit);
      continue;
    }
    assert.equal(error.code, 'analysis-budget');
    assert.equal(error.message, '遮挡分析超出预算');
    assert.ok(NEW_STAGES.has(error.stage) || OLD_STAGES.has(error.stage), `未登记的阶段：${error.stage}`);
    if (!NEW_STAGES.has(error.stage)) { if (!legacy.has(error.stage)) legacy.add(error.stage); }
    if (!found.has(error.stage) && NEW_STAGES.has(error.stage)) found.set(error.stage, limit);
  }
  assert.deepEqual([...found.keys()].sort(), [...NEW_STAGES].sort(), `阶段覆盖不全：${JSON.stringify([...found])}`);
});

test('新分块轮询不受 64 次节流限制：一次强制检查就能发现耗尽', () => {
  const frames = scene().frames;
  // 第 1 次读取（首个 accept 的 startBudget）为 0；之后持续放大，完备一次 accept 也追不上。
  let reads = 0;
  const clock = () => { reads += 1; return reads === 1 ? 0 : 1e6 * reads; };
  const error = runToFailure({ analysisBudgetMs: 1, now: clock }, frames);
  assert.ok(error, '1ms 预算必须在下一块边界耗尽');
  assert.equal(error.code, 'analysis-budget');
  assert.ok(NEW_STAGES.has(error.stage), `未登记的阶段：${error.stage}`);
  assert.ok(reads <= 5, `必须靠强制检查立即发现，不能等 64 次节流：reads=${reads}`);
});

test('无限预算既不触发也不靠预算时钟做决定：像素与默认一致', () => {
  const source = scene();
  const session = createAutoScrollSession(source.seedFrame, { now: () => 1e9 });
  feed(session, source.frames);
  const output = session.finish();
  assert.equal(output.complete, true, output.warning);
  const reference = createAutoScrollSession(source.seedFrame, {});
  feed(reference, source.frames);
  const plain = reference.finish();
  assert.deepEqual(output.data, plain.data, '无限预算下像素必须与默认一致');
  assert.deepEqual(output.background, plain.background);
  // 强制检查分支必须先在 budgetEnd===Infinity 处返回，不能先读预算时钟。
  // （learnDuration/repairDuration 本来就用 options.now，不计入这条约束。）
  const core = readFileSync(new URL('../core/auto-scroll-session.mjs', import.meta.url), 'utf8');
  const guard = core.slice(core.indexOf('const guard=(stage,force)=>'), core.indexOf('const checkBudget='));
  assert.ok(guard.length > 0, '未找到 guard 实现');
  assert.ok(guard.indexOf('budgetEnd===Infinity') >= 0, 'guard 必须判断无限预算');
  assert.ok(guard.indexOf('budgetEnd===Infinity') < guard.indexOf('nowMs()'), '无限预算必须先返回再读时钟');
});

test('调用点覆盖：5 处 support 与 2 处 changeDomain 都传了阶段感知回调', () => {
  const source = readFileSync(new URL('../core/auto-scroll-session.mjs', import.meta.url), 'utf8').split('\n');
  const calls = name => source.filter(line => line.includes(`${name}(`) && !line.includes(`function ${name}(`) && !line.trimStart().startsWith('//'));
  for (const name of ['support', 'changeDomain']) {
    const sites = calls(name);
    assert.ok(sites.length > 0, `${name} 未找到调用点`);
    for (const line of sites) assert.match(line, /checkBudget/, `${name} 的调用点缺少阶段回调：${line.trim()}`);
  }
  assert.equal(calls('support').length, 5, 'support 的 5 处调用点：常规核验、重定位、closure、逐对核验、窄域备用');
  assert.equal(calls('changeDomain').length, 2, 'changeDomain 的 2 处调用点：resolveDomain 与建窗逐对');
  // 背景函数：掩码观察与收尾延展也必须在生产调用点传入回调。
  const observe = calls('observeBackground');
  const extend = calls('extendBackground');
  assert.equal(observe.length, 1);
  assert.equal(extend.length, 1);
  assert.match(observe[0], /checkBudget/);
  assert.match(extend[0], /checkBudget/);
});

function channel(worker) {
  const waiting = [];
  worker.on('message', value => { if (value?.type === 'evidence-invalidated') return; waiting.shift()?.(value); });
  return packet => new Promise(resolve => {
    waiting.push(resolve);
    worker.postMessage(packet, packet.image ? [packet.image.data.buffer] : []);
  });
}

test('真实 Worker：新增阶段预算错误原样回传，回包里不出现细分计时', async () => {
  const url = new URL('../renderer/scroll-match-worker.mjs', import.meta.url).href;
  const source = scene();
  const seen = new Set();
  for (let limit = 1; limit <= 60; limit += 1) {
    const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(`
 import {parentPort} from 'node:worker_threads';
 let reads = 0;
 performance.now = () => { reads += 1; return reads > ${limit} ? 1e6 : 0; };
 globalThis.self={postMessage:(packet,transfer)=>parentPort.postMessage(packet,transfer)};
 await import(${JSON.stringify(url)});
 parentPort.on('message',data=>self.onmessage({data}));`)), { type: 'module' });
    try {
      const send = channel(worker);
      const ready = await send({ type: 'init', image: structuredClone(source.seedFrame) });
      assert.equal(ready.type, 'ready');
      let failure = null;
      for (let index = 1; index < source.frames.length && !failure; index += 1) {
        const packet = await send({ type: 'frame', id: index, image: structuredClone(source.frames[index].image), atMs: index * 50 });
        if (packet.type === 'error') failure = packet;
        else assert.equal('stageTimings' in packet, false, '生产回包不新增细分计时');
      }
      if (!failure) {
        const packet = await send({ type: 'finish' });
        if (packet.type === 'error') failure = packet;
      }
      if (!failure) continue;
      assert.equal(failure.code, 'analysis-budget');
      assert.ok(NEW_STAGES.has(failure.stage), `Worker 侧未登记的阶段：${failure.stage}`);
      assert.equal('stageTimings' in failure, false, '错误包也不带细分计时');
      assert.equal(typeof failure.learnPasses, 'number', '既有诊断字段保持不变');
      seen.add(failure.stage);
      if ([...NEW_STAGES].every(name => seen.has(name))) break;
    } finally {
      await worker.terminate();
    }
  }
  assert.ok(seen.size > 0, '真实 Worker 至少要传播一个新阶段');
});
