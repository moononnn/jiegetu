import { createAutoScrollSession, ANALYSIS_BUDGET_MS } from '../core/auto-scroll-session.mjs';

let session, lastCheckpointRevision = -1;
// 只有诊断需要的少量计数，异常时随错误包回传；不含像素、文本或原始帧。
function counters() {
  try {
    const values = session?.counters?.() ?? {};
    const safe = {};
    for (const key of ['learnPasses', 'learnDuration', 'repairDuration']) {
      if (Number.isFinite(values[key])) safe[key] = values[key];
    }
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
      self.postMessage({ type: 'sample', id: packet.id, ...update, durationMs: performance.now() - started, ...(checkpoint ? { checkpoint } : {}) },
        checkpoint ? [checkpoint.data.buffer] : []);
    } else if (packet.type === 'finish') {
      if (!session) throw new Error('长截图计算未启动');
      const output = session.finish();
      session.clear(); session = undefined;
      self.postMessage({ type: 'done', output }, [output.data.buffer]);
    }
  } catch (error) {
    const detail = counters();
    session?.clear(); session = undefined;
    self.postMessage({ type: 'error', errorName: error.name, message: error.message,
      ...(error.code ? { code: error.code } : {}), ...(error.stage ? { stage: error.stage } : {}), ...detail });
  }
};
