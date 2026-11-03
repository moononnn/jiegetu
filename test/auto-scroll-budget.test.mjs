import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createAutoScrollSession, ANALYSIS_BUDGET_MS } from '../core/auto-scroll-session.mjs';
import { createScene } from './fixtures/auto-scenes.mjs';

const STAGES = new Set(['learn-components', 'learn-template', 'learn-mask', 'present', 'ring-matches', 'mark-repair', 'repair-copy']);
const overlay = (image, rect, color) => {
  const out = { ...image, data: new Uint8ClampedArray(image.data) };
  for (let y = rect.top; y < rect.bottom; y++) for (let x = rect.left; x < rect.right; x++) out.data.set([...color, 255], (y * image.width + x) * 4);
  return out;
};
// 屏幕固定的多个控件：让 learn/components/template 与收尾修补真正有活干。

test('生产预算常量固定为4秒并只由 Worker 注入，core 默认不因真实时钟波动改变结论', () => {
  assert.equal(ANALYSIS_BUDGET_MS, 4000, '生产预算必须低于渲染端 10 秒看门狗');
  const worker = fs.readFileSync(new URL('../renderer/scroll-match-worker.mjs', import.meta.url), 'utf8');
  assert.match(worker, /ANALYSIS_BUDGET_MS/);
  assert.match(worker, /analysisBudgetMs:\s*ANALYSIS_BUDGET_MS/);
  // 未显式给预算时（纯算法/性能测试）注入任意时钟都不应触发预算错误。
  const scene = createScene();
  const session = createAutoScrollSession(scene.seedFrame, { now: () => 1e9 });
  let time = 0;
  for (const frame of scene.frames) session.accept(frame.image, time += 50);
  const output = session.finish();
  assert.equal(output.complete, true, output.warning);
  assert.throws(() => createAutoScrollSession(scene.seedFrame, { analysisBudgetMs: 0 }), /预算无效/);
});

test('注入时钟确定性触发预算错误：固定 code/stage，不返回 complete，先前检查点不被改写', () => {
  const scene = createScene({ offsets: [0, 16, 32, 48, 64, 80] });
  // 注入时钟只在“加速”后跳步，让预算在 check 点上确定地落到 4 秒之外。
  let fast = false, clock = 0;
  const now = () => { if (fast) clock += 10_000; return clock; };
  const session = createAutoScrollSession(scene.seedFrame, { analysisBudgetMs: ANALYSIS_BUDGET_MS, now });
  let time = 0;
  for (const frame of scene.frames.slice(0, 4)) session.accept(frame.image, time += 50);
  const checkpoint = session.checkpoint();
  assert.ok(checkpoint, '触发前必须已经有可信检查点');
  const before = checkpoint.data.slice(), height = checkpoint.height;
  fast = true;
  assert.throws(() => session.accept(scene.frames[4].image, time += 50), error => {
    assert.equal(error.name, 'RangeError');
    assert.equal(error.code, 'analysis-budget');
    assert.equal(error.message, '遮挡分析超出预算');
    assert.ok(STAGES.has(error.stage), `未登记的阶段：${error.stage}`);
    return true;
  });
  assert.deepEqual(checkpoint.data, before, '预算中断不得改写已交给调用方的检查点');
  assert.equal(checkpoint.height, height);
  assert.equal(session.checkpoint(), null, '预算中断后不能凭半截状态给出新的可信快照');
  const output = session.finish();
  assert.equal(output.complete, false, '预算耗尽的帧不能标成完成');
  assert.match(output.warning, /预算/);
});

test('新增遮挡证据在预算错误抛出前即时回调，版本号只递增', () => {
  // 固定控件让 learn 真的新增掩码证据：证据回调必须在本次 accept 抛出预算错误之前就发出。
  const rects = [
    { left: 4, right: 22, top: 40, bottom: 54, color: [252, 248, 240] },
    { left: 40, right: 62, top: 92, bottom: 104, color: [16, 84, 120] },
    { left: 6, right: 58, top: 150, bottom: 160, color: [230, 90, 40] },
  ];
  const paint = image => rects.reduce((out, { color, ...rect }) => overlay(out, rect, color), image);
  const base = createScene({ offsets: [0, 8, 16, 24, 32, 40, 48] });
  const scene = { ...base, seedFrame: paint(base.seedFrame), frames: base.frames.map(frame => ({ ...frame, image: paint(frame.image) })) };
  let fast = false, clock = 0;
  const now = () => { if (fast) clock += 10_000; return clock; };
  const journal = [];
  const session = createAutoScrollSession(scene.seedFrame, { analysisBudgetMs: ANALYSIS_BUDGET_MS, now,
    onEvidence: (revision, reason) => journal.push({ type: 'evidence', revision, reason }) });
  let time = 0;
  for (const frame of scene.frames.slice(0, 6)) session.accept(frame.image, time += 50);
  const evidence = journal.slice();
  assert.ok(evidence.length > 0, '新增固定控件必须产生证据回调');
  for (const row of evidence) {
    assert.equal(row.type, 'evidence');
    assert.ok(Number.isInteger(row.revision) && row.revision > 0, '版本号必须是非负递增计数（从 1 开始）');
    assert.ok(['mask', 'unknown'].includes(row.reason), `未登记的证据原因：${row.reason}`);
  }
  const revisions = evidence.map(row => row.revision);
  assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b));
  assert.equal(revisions.at(-1), session.counters().evidenceRevision);
  fast = true;
  assert.throws(() => session.accept(scene.frames[6].image, time += 50), error => {
    journal.push({ type: 'error', code: error.code });
    return error.code === 'analysis-budget';
  });
  assert.equal(journal.at(-1).type, 'error', '预算错误必须是最后发生的事件');
  assert.ok(journal.findIndex(row => row.type === 'evidence') < journal.findIndex(row => row.type === 'error'),
    '外部必须先收到证据失效，再看到失败：不能等 accept 返回才补发');
});

test('预算检查成本有界：整轮接长只读少量时钟，不逐像素取时', () => {
  const scene = createScene({ offsets: [0, 16, 32, 48, 64, 80, 96] });
  let reads = 0;
  const session = createAutoScrollSession(scene.seedFrame, { analysisBudgetMs: ANALYSIS_BUDGET_MS, now: () => { reads++; return 0; } });
  let time = 0;
  for (const frame of scene.frames) session.accept(frame.image, time += 50);
  session.finish();
  assert.ok(reads > 0, '预算必须真的被检查过');
  assert.ok(reads < 5000, `时钟读取次数必须有界，实际 ${reads}`);
});

test('收尾的遮挡修补重新起算预算：耗尽即抛错，不留半成品输出', () => {
  // 3 个屏幕固定控件 + 足够多的片段，使收尾修补真的会在检查点之间跨过 4 秒。
  const rects = [
    { left: 4, right: 22, top: 40, bottom: 54, color: [252, 248, 240] },
    { left: 40, right: 62, top: 92, bottom: 104, color: [16, 84, 120] },
    { left: 6, right: 58, top: 150, bottom: 160, color: [230, 90, 40] },
  ];
  const paint = image => rects.reduce((out, { color, ...rect }) => overlay(out, rect, color), image);
  const base = createScene({ offsets: Array.from({ length: 40 }, (_, index) => index * 8) });
  const scene = { ...base, seedFrame: paint(base.seedFrame), frames: base.frames.map(frame => ({ ...frame, image: paint(frame.image) })) };
  let fast = false, clock = 0, reads = 0;
  const now = () => { reads++; if (fast) clock += 10_000; return clock; };
  const session = createAutoScrollSession(scene.seedFrame, { analysisBudgetMs: ANALYSIS_BUDGET_MS, now });
  let time = 0;
  for (const frame of scene.frames) session.accept(frame.image, time += 50);
  assert.ok(session.stats().autoEvidence.maskCount > 0, '样本里必须真的有需要修补的固定控件');
  fast = true;
  let thrown;
  try { thrown = { output: session.finish() }; } catch (error) { thrown = { error }; }
  assert.ok(thrown.error, '收尾耗尽预算必须抛出，不能返回半成品');
  assert.equal(thrown.error.code, 'analysis-budget');
  assert.ok(['mark-repair', 'repair-copy'].includes(thrown.error.stage), `收尾阶段不符：${thrown.error.stage}`);
  assert.equal(thrown.output, undefined);
  assert.ok(reads > 0);
});

test('定向耗时探针：1632×2051 多静止控件合成样本，逐帧记录 accept 耗时', () => {
  const width = 1632, height = 2051, top = 32, bottom = 48, bodyHeight = height - top - bottom;
  const base = createScene({ top, bottom, bodyHeight, offsets: [0, 16, 32, 48, 64] });
  const expand = image => {
    const data = new Uint8ClampedArray(width * image.height * 4);
    for (let y = 0; y < image.height; y++) {
      const row = image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4);
      for (let x = 0; x < width; x += image.width) data.set(row.subarray(0, Math.min(image.width, width - x) * 4), (y * width + x) * 4);
    }
    return { width, height: image.height, data };
  };
  const rects = [
    { left: 40, right: 640, top: 120, bottom: 200, color: [248, 250, 252] },
    { left: 980, right: 1580, top: 300, bottom: 380, color: [24, 96, 132] },
    { left: 200, right: 760, top: 1600, bottom: 1680, color: [232, 96, 48] },
    { left: 1420, right: 1580, top: 1840, bottom: 1900, color: [60, 60, 72] },
  ];
  const paint = image => rects.reduce((out, { color, ...rect }) => overlay(out, rect, color), image);
  const scene = {
    width, height,
    seedFrame: paint(expand(base.seedFrame)),
    frames: base.frames.map(frame => ({ ...frame, image: paint(expand(frame.image)) })),
  };
  const session = createAutoScrollSession(scene.seedFrame, { maxBytes: scene.seedFrame.data.byteLength * 6 });
  const durations = [];
  let time = 0;
  for (const frame of scene.frames) {
    const started = performance.now();
    session.accept(frame.image, time += 50);
    durations.push(Math.round(performance.now() - started));
  }
  const finishStarted = performance.now();
  const output = session.finish();
  const finishMs = Math.round(performance.now() - finishStarted);
  console.log(`[1632x2051 多控件] accept=${durations.join('/')}ms finish=${finishMs}ms height=${output.height} complete=${output.complete} warning=${output.warning || '无'}`);
  assert.equal(output.width, width);
  assert.equal(output.data.length, output.width * output.height * 4);
  const worst = Math.max(...durations, finishMs);
  assert.ok(worst < 4000, `单帧/收尾耗时应低于生产预算，实际最慢 ${worst}ms`);
});
