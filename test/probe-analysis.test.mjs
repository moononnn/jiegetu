import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meanRgb, assess } from '../core/probe-analysis.mjs';

function fixture() {
  let time = 0;
  return Object.fromEntries(['hidden', 'visible', 'protected'].map(phase => [phase,
    Array.from({ length: 3 }, () => ({ rgb: phase === 'visible' ? [232, 155, 176] : [40, 125, 114], time: ++time }))]));
}

test('颜色均值', () => {
  assert.deepEqual(meanRgb(new Uint8ClampedArray([20, 30, 40, 255, 40, 50, 60, 255])), [30, 40, 50]);
  assert.throws(() => meanRgb([]), RangeError);
});
test('三个阶段都匹配且画面更新才能通过', () => assert.equal(assess(fixture()).pass, true));
test('保护后出现黑块必须失败', () => {
  const phases = fixture();
  phases.protected[1].rgb = [0, 0, 0];
  assert.equal(assess(phases).pass, false);
});
test('未保护阶段也看不到遮罩，不能把无效实验当通过', () => {
  const phases = fixture();
  phases.visible.forEach(sample => { sample.rgb = [40, 125, 114]; });
  assert.equal(assess(phases).pass, false);
});
test('跨阶段仍使用同一时间的旧帧不能通过', () => {
  const phases = fixture();
  phases.protected[0].time = phases.visible[2].time;
  assert.equal(assess(phases).pass, false);
});
test('实机回归：保护阶段画面静止，最后两次采样相同时间可通过', () => {
  const phases = fixture();
  const times = [1.360147, 1.494531, 1.976048, 2.875202, 3.265712, 3.558269, 4.342727, 4.718597, 4.718597];
  Object.values(phases).flat().forEach((sample, i) => { sample.time = times[i]; });
  assert.equal(assess(phases).pass, true);
});
test('阶段内时间倒退仍须拒绝', () => {
  const phases = fixture();
  phases.protected[2].time = phases.protected[0].time;
  assert.equal(assess(phases).pass, false);
});
test('缺阶段与非数值颜色均不放行', () => {
  assert.equal(assess({}).pass, false);
  const phases = fixture();
  phases.hidden[0].rgb = [NaN, 125, 114];
  assert.equal(assess(phases).pass, false);
});
