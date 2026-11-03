export function meanRgb(rgba) {
  if (!rgba.length || rgba.length % 4) throw new RangeError('无效采样数据');
  const sum = [0, 0, 0];
  for (let i = 0; i < rgba.length; i += 4) {
    for (let c = 0; c < 3; c++) sum[c] += rgba[i + c];
  }
  return sum.map(value => Math.round(value / (rgba.length / 4)));
}

export function assess(phases) {
  const near = (rgb, expected) => Array.isArray(rgb) && rgb.length === 3 &&
    rgb.every((value, i) => Number.isFinite(value) && Math.abs(value - expected[i]) <= 25);
  const matches = (phase, expected) => Array.isArray(phases[phase]) && phases[phase].length === 3 &&
    phases[phase].every(sample => near(sample.rgb, expected));
  const all = ['hidden', 'visible', 'protected'].flatMap(phase => phases[phase] || []);
  // 静止桌面允许重复呈现同一帧；阶段切换必须有新时间与对应的新颜色。
  // 此检查只证明三个阶段更新过，持续滚动的捕获能力另做实测。
  const fresh = all.length === 9 && all.every((sample, index) =>
    Number.isFinite(sample.time) && sample.time >= 0 &&
    (index === 0 || (index % 3 === 0 ? sample.time > all[index - 1].time : sample.time >= all[index - 1].time)));
  const baseline = matches('hidden', [40, 125, 114]);
  const positiveControl = matches('visible', [232, 155, 176]);
  const excluded = matches('protected', [40, 125, 114]);
  return { pass: fresh && baseline && positiveControl && excluded, fresh, baseline, positiveControl, excluded };
}
