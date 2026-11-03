import { createAutoScrollSession, ANALYSIS_BUDGET_MS } from '../core/auto-scroll-session.mjs';

let session, lastCheckpointRevision = -1;
// 诊断只走固定 10 个扁平数字：四阶段的次数/毫秒 + 两个放弃计数。
// 不展开任意 counters 键，不传 stageTimings 嵌套对象，也不带像素、坐标、路径或异常原文。
const STAGE_NUMBERS = [
  ['support', 'supportCalls', 'supportMs'],
  ['changeDomain', 'changeDomainCalls', 'changeDomainMs'],
  ['backgroundObserve', 'backgroundObserveCalls', 'backgroundObserveMs'],
  ['backgroundExtend', 'backgroundExtendCalls', 'backgroundExtendMs'],
];
const COUNTER_NUMBERS = ['relocationBudgetGiveUps', 'backgroundExtensionFallbacks'];
const LEGACY_NUMBERS = ['learnPasses', 'learnDuration', 'repairDuration'];
const nonNegativeInteger = value => Number.isInteger(value) && value >= 0;
const nonNegativeFinite = value => Number.isFinite(value) && value >= 0;
function counters() {
  try {
    const values = session?.counters?.() ?? {};
    const safe = {};
    for (const key of LEGACY_NUMBERS) if (Number.isFinite(values[key])) safe[key] = values[key];
    const stages = values.stageTimings ?? {};
    for (const [stage, callsKey, msKey] of STAGE_NUMBERS) {
      const row = stages[stage];
      if (nonNegativeInteger(row?.calls)) safe[callsKey] = row.calls;
      if (nonNegativeFinite(row?.durationMs)) safe[msKey] = row.durationMs;
    }
    for (const key of COUNTER_NUMBERS) if (nonNegativeInteger(values[key])) safe[key] = values[key];
    return safe;
  } catch { return {}; }
}
self.onmessage = ({ data: packet }) => {
  try {
    if (packet.type === 'init') {
      if (session) throw new Error('长截图计算已启动');
      // 手动正文范围已从生产入口撤除；旧调用方带来的参数必须显式失败，不能静默退回自动识别。
      if (packet.content !== undefined) throw new Error('长截图已改为自动识别，不再接收手动正文范围');
      lastCheckpointRevision = -1;
      session = createAutoScrollSession(packet.image, { analysisBudgetMs: ANALYSIS_BUDGET_MS,
        // 轻事件：新增遮挡证据（新掩码/未知区）时立刻告知外部丢弃旧检查点，不等本次 accept 返回。
        // 只带版本号，不带像素、不带矩形、不带宽高。
        onEvidence: revision => self.postMessage({ type: 'evidence-invalidated', revision }) });
      self.postMessage({ type: 'ready', ...session.stats() });
    } else if (packet.type === 'frame') {
      if (!session) throw new Error('长截图计算未启动');
      const started = performance.now();
      const update = session.accept(packet.image, packet.atMs);
      // 只在确认无误的完整回包里附一份独立的可信快照；checkpoint 的数据是新分配的，不动 session 内部片段或原帧。
      // 新证据可能在不增长高度的回看帧内完成修复，也须补回被作废的检查点；普通静止帧不重拷。
      const revisionChanged = update.autoEvidence?.evidenceRevision !== lastCheckpointRevision;
      const checkpoint = (update.added > 0 || revisionChanged) && update.complete && update.height === update.capturedHeight ? session.checkpoint() : null;
      if (checkpoint) lastCheckpointRevision = checkpoint.evidenceRevision;
      self.postMessage({ type: 'sample', id: packet.id, ...update, durationMs: performance.now() - started, ...counters(), ...(checkpoint ? { checkpoint } : {}) },
        checkpoint ? [checkpoint.data.buffer] : []);
    } else if (packet.type === 'finish') {
      if (!session) throw new Error('长截图计算未启动');
      // 必须在 finish 之后、clear 之前取快照：finish 内部还会跑背景延展等阶段并累加计数，
      // 提前取会把这些整数漏成 0；clear 后会话不可读，事后补 0 同样冒充“真的没发生”。
      const output = session.finish();
      const detail = counters();
      session.clear(); session = undefined;
      self.postMessage({ type: 'done', output, ...detail }, [output.data.buffer]);
    }
  } catch (error) {
    // 重复 init 时当前 session 是上一场的：不能把旧数字挂到这条错误包上。
    const detail = packet.type === 'init' ? {} : counters();
    session?.clear(); session = undefined;
    self.postMessage({ type: 'error', errorName: error.name, message: error.message,
      ...(error.code ? { code: error.code } : {}), ...(error.stage ? { stage: error.stage } : {}), ...detail });
  }
};
