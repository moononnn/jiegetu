import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScrollSession } from '../core/scroll-session.mjs';
import { detectShift } from '../core/scroll.mjs';
import { chatFrame } from './fixtures/chat-background.mjs';

function taggedFrame(tag, width = 32, height = 80) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i + 1] = data[i + 2] = tag;
    data[i + 3] = 255;
  }
  return { data, width, height };
}

function fingerprintTag(frame) {
  return frame.rows[0];
}

test('未来证据追回旧fixed，但最新帧仍unmatched；随后从可信frontier直接跨到新帧', () => {
  const seed = taggedFrame(1, 32, 200), old = taggedFrame(10, 32, 200), evidence = taggedFrame(20, 32, 200), later = taggedFrame(30, 32, 200);
  const detect = (a, b, history) => {
    const from = fingerprintTag(a), to = fingerprintTag(b), witness = history && fingerprintTag(history.previous);
    if (from === 1 && to === 10 && witness === 20) {
      assert.equal(history.shift, 80, 'pending旧帧应使用最新候选history重检');
      return { kind: 'forward', shift: 30 };
    }
    if (from === 1 && to === 10) return { kind: 'fixed', shift: 30, foreground: true };
    if (from === 1 && to === 20) {
      assert.equal(witness, 10, '新候选先看到上一条motionHistory');
      assert.equal(history.shift, 30);
      return { kind: 'fixed', shift: 80, foreground: true };
    }
    if (from === 10 && to === 20) return { kind: 'unmatched' };
    if (from === 10 && to === 30) return { kind: 'forward', shift: 110 };
    return { kind: 'unmatched' };
  };
  const session = createScrollSession(seed, { detect });
  const first = session.accept(old, 100);
  assert.equal(first.result.kind, 'fixed');
  assert.equal(first.pendingFrames, 1);

  const recovered = session.accept(evidence, 200);
  assert.equal(recovered.result.kind, 'unmatched', '保留最新重检结果，不能用旧帧的forward覆盖');
  assert.equal(recovered.added, 30);
  assert.equal(recovered.recoveredFrames, 1);
  assert.equal(recovered.height, seed.height + 30);
  assert.equal(recovered.chunks, 2);
  assert.equal(recovered.pendingFrames, 1, '最新unmatched仍留在pending');

  const next = session.accept(later, 300);
  assert.equal(next.result.kind, 'forward');
  assert.equal(next.added, 110, '只追加相对可信frontier的直接位移，不叠加相邻候选位移');
  assert.equal(next.height, seed.height + 140);
  assert.equal(next.pendingFrames, 0);
});

test('真算法匿名聊天帧集成：安全拼接原RGBA并返回末端预览', () => {
  const seed = chatFrame(0);
  const one = chatFrame(42);
  const two = chatFrame(98);
  const session = createScrollSession(seed);
  const initialReference = session.stats().reference;
  assert.ok(initialReference.width <= 960 && initialReference.height <= 320);

  const first = session.accept(one, 100);
  assert.equal(first.result.kind, 'forward');
  assert.equal(first.added, 42);
  assert.ok(first.reference.width <= 960 && first.reference.height <= 320);
  assert.notDeepEqual(first.reference.data, initialReference.data);

  const second = session.accept(two, 200);
  assert.equal(second.result.kind, 'forward');
  assert.equal(second.added, 56);
  const output = session.finish();
  const expected = new Uint8ClampedArray((seed.height + 98) * seed.width * 4);
  expected.set(seed.data);
  expected.set(one.data.subarray((one.height - 42) * one.width * 4), seed.data.length);
  expected.set(two.data.subarray((two.height - 56) * two.width * 4), seed.data.length + 42 * seed.width * 4);
  assert.deepEqual(output.data, expected, '拼接结果保留源帧RGBA字节');
});

test('真实固定底栏与周期正文均不得放行', () => {
  const footerSeed = chatFrame(0, { footer: 16 });
  const footerSession = createScrollSession(footerSeed, { detect: detectShift });
  const footer = footerSession.accept(chatFrame(42, { footer: 16 }), 100);
  assert.notEqual(footer.result.kind, 'forward');
  assert.equal(footer.height, footerSeed.height);

  const periodicSeed = chatFrame(0, { repeat: true });
  const periodicSession = createScrollSession(periodicSeed, { detect: detectShift });
  const periodic = periodicSession.accept(chatFrame(160, { repeat: true }), 100);
  assert.notEqual(periodic.result.kind, 'forward');
  assert.equal(periodic.height, periodicSeed.height);
});

test('pending严格遵守帧数、字节数与采集时间年龄上限', () => {
  const seed = taggedFrame(1), bytes = seed.data.byteLength;
  const unmatched = () => ({ kind: 'unmatched' });
  const capped = createScrollSession(seed, { detect: unmatched, maxFrames: 2, maxBytes: bytes * 10, maxAgeMs: 2500 });
  const noProgress = capped.accept(taggedFrame(10), 0);
  assert.equal(Object.hasOwn(noProgress, 'reference'), false, '没有新增内容时不返回预览');
  capped.accept(taggedFrame(20), 10);
  const byFrames = capped.accept(taggedFrame(30), 20);
  assert.equal(byFrames.pendingFrames, 2);
  assert.equal(byFrames.pendingBytes, bytes * 2);
  assert.equal(byFrames.droppedFrames, 1);

  const byBytes = createScrollSession(seed, { detect: unmatched, maxFrames: 5, maxBytes: bytes * 2 - 1 });
  byBytes.accept(taggedFrame(10), 0);
  const byteResult = byBytes.accept(taggedFrame(20), 1);
  assert.equal(byteResult.pendingFrames, 1);
  assert.equal(byteResult.pendingBytes, bytes);
  assert.equal(byteResult.droppedFrames, 1);

  const oversized = createScrollSession(seed, { detect: unmatched, maxBytes: bytes - 1 });
  const oversizedResult = oversized.accept(taggedFrame(10), 0);
  assert.equal(oversizedResult.pendingFrames, 0);
  assert.equal(oversizedResult.pendingBytes, 0);
  assert.equal(oversizedResult.droppedFrames, 1);

  const aged = createScrollSession(seed, { detect: unmatched, maxFrames: 5, maxBytes: bytes * 10, maxAgeMs: 2500 });
  aged.accept(taggedFrame(10), 0);
  const ageResult = aged.accept(taggedFrame(20), 2501);
  assert.equal(ageResult.pendingFrames, 1);
  assert.equal(ageResult.pendingBytes, bytes);
  assert.equal(ageResult.droppedFrames, 1);
});

test('只在新增motionHistory时回放，单次至多4张并按采集时间前进', () => {
  const seed = taggedFrame(1, 32, 200), calls = new Map(), replayed = [];
  const detect = (a, b) => {
    const tag = fingerprintTag(b);
    if (tag === 99) return { kind: 'unmatched' };
    const count = calls.get(tag) ?? 0;
    calls.set(tag, count + 1);
    if (count === 0) return { kind: 'fixed', shift: tag, foreground: true };
    replayed.push(tag);
    return { kind: 'unmatched' };
  };
  const session = createScrollSession(seed, { detect, maxFrames: 10, maxBytes: seed.data.byteLength * 10 });
  for (let tag = 10; tag <= 15; tag++) {
    const before = session.stats().replayChecks;
    session.accept(taggedFrame(tag, 32, 200), tag);
    const checked = session.stats().replayChecks - before;
    assert.ok(checked <= 4, `tag=${tag}, replayChecks=${checked}`);
    if (tag === 15) assert.equal(checked, 4);
  }
  assert.deepEqual(replayed.slice(-4), [10, 11, 12, 13], '优先选择靠近frontier的旧帧，检查顺序仍按时间递增');
  const beforeUnwitnessed = session.stats().replayChecks;
  const unwitnessed = session.accept(taggedFrame(99, 32, 200), 99);
  assert.equal(unwitnessed.result.kind, 'unmatched');
  assert.equal(session.stats().replayChecks, beforeUnwitnessed, '没有新增有效history时不重复搜索');
});

test('pending始终旧到新，容量淘汰与回放都按时间前进', () => {
  const seed = taggedFrame(1, 32, 200), calls = new Map(), replayed = [];
  const detect = (a, b) => {
    const tag = fingerprintTag(b), count = calls.get(tag) ?? 0;
    calls.set(tag, count + 1);
    if (count === 0) return { kind: 'fixed', shift: tag, foreground: true };
    replayed.push(tag);
    return { kind: 'unmatched' };
  };
  const session = createScrollSession(seed, { detect, maxFrames: 3, maxBytes: seed.data.byteLength * 4 });
  for (let tag = 10; tag <= 13; tag++) session.accept(taggedFrame(tag, 32, 200), tag);
  assert.equal(session.stats().pendingFrames, 3);
  assert.equal(session.stats().droppedFrames, 1, '先淘汰最旧的tag=10');
  let start = replayed.length;
  session.accept(taggedFrame(14, 32, 200), 14);
  assert.deepEqual(replayed.slice(start), [12, 13], '再超额时保留tag=12、13，并按时间回放');
  assert.equal(session.stats().pendingFrames, 3);
  assert.equal(session.stats().droppedFrames, 2, '第二次超额淘汰tag=11，而非最新帧');
});

test('reverse向上接长后，只按已覆盖区间推进可信高度', () => {
  const seed = taggedFrame(1), backwards = taggedFrame(10), forward = taggedFrame(20);
  const calls = [];
  const detect = (a, b) => {
    calls.push({ from: fingerprintTag(a), to: fingerprintTag(b) });
    if (fingerprintTag(b) === 10) return { kind: 'reverse', shift: -12 };
    return { kind: 'forward', shift: 18 };
  };
  const session = createScrollSession(seed, { detect });
  const reverse = session.accept(backwards, 10);
  assert.equal(reverse.result.kind, 'reverse');
  assert.equal(reverse.height, seed.height + 12, '向上接长 12 行');
  const next = session.accept(forward, 20);
  assert.deepEqual(calls.at(-1), { from: 10, to: 20 }, '基准随成功接长前移，失败帧不替换');
  assert.equal(next.result.kind, 'forward');
  assert.equal(next.height, seed.height + 12 + 6, '向下只补接超出旧覆盖范围的部分');
});

test('达到worker的1000块门槛时停止增加并保留可信长图', () => {
  const seed = taggedFrame(1);
  const session = createScrollSession(seed, { detect: () => ({ kind: 'forward', shift: 1 }) });
  for (let i = 0; i < 999; i++) session.accept(taggedFrame(i % 200 + 2), i);
  assert.equal(session.stats().chunks, 1000);
  const height = session.stats().height;
  const limited = session.accept(taggedFrame(250), 1000);
  assert.equal(limited.limit, true);
  assert.equal(limited.height, height);
  assert.equal(limited.chunks, 1000);
  assert.equal(session.finish().height, height);
});

test('MAX_HEIGHT达到后保留现有可信内容并返回limit', () => {
  const seed = taggedFrame(1, 16, 29_999);
  const session = createScrollSession(seed, { detect: () => ({ kind: 'forward', shift: 1 }) });
  const reached = session.accept(taggedFrame(2, 16, 29_999), 1);
  assert.equal(reached.height, 30_000);
  assert.equal(reached.limit, false);
  const blocked = session.accept(taggedFrame(3, 16, 29_999), 2);
  assert.equal(blocked.limit, true);
  assert.equal(blocked.height, 30_000);
  assert.equal(blocked.chunks, 2);
  assert.equal(session.finish().height, 30_000);
});

test('clear释放会话可见状态并禁止旧会话继续accept或finish', () => {
  const seed = taggedFrame(1);
  const session = createScrollSession(seed, { detect: () => ({ kind: 'unmatched' }) });
  session.accept(taggedFrame(10), 0);
  assert.ok(session.stats().reference);
  session.clear();
  assert.deepEqual(session.stats(), { height: 0, chunks: 0, pendingFrames: 0, pendingBytes: 0, droppedFrames: 0, replayChecks: 0, backgroundValidPixels: 0, backgroundBlockedPixels: 0 });
  assert.throws(() => session.accept(taggedFrame(20), 1), /已清除/);
  assert.throws(() => session.finish(), /已清除/);
});
