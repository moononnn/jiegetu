'use strict';
// 手绘批注的共享几何：只测纯函数与 Canvas 调用顺序，不跑编辑器、不采屏。
// 屏幕预览与复制成图共用这一份 helper，所以「确定性」和「端点朝向」都在这里守住。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'renderer', 'annotation-visuals.js'), 'utf8'), sandbox, { filename: 'annotation-visuals.js' });
const V = sandbox.window.AnnotationVisuals;

// 记录型假 Canvas：只收调用顺序与参数，不画像素；描边类调用顺带记下当时的颜色与线宽。
function context({ quadratic = false } = {}) {
  const calls = [];
  const ctx = { calls, lineWidth: 0, strokeStyle: '', fillStyle: '', lineCap: 'butt', lineJoin: 'miter' };
  const record = name => (...args) => calls.push({ name, args, style: ctx.strokeStyle, width: ctx.lineWidth });
  for (const name of ['save', 'restore', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'rect', 'fill', 'arc', 'strokeRect']) ctx[name] = record(name);
  if (quadratic) ctx.quadraticCurveTo = record('quadraticCurveTo');
  ctx.setLineDash = dashes => calls.push({ name: 'setLineDash', args: [Array.isArray(dashes) ? [...dashes] : dashes] });
  ctx.measureText = text => ({ width: [...String(text)].length * 12 });
  ctx.fillText = record('fillText');
  return ctx;
}
const pathPoints = calls => calls.flatMap(call => {
  if (call.name === 'moveTo' || call.name === 'lineTo') return [{ x: call.args[0], y: call.args[1] }];
  if (call.name === 'quadraticCurveTo') return [{ x: call.args[2], y: call.args[3] }];
  return [];
});
const near = (value, expected, tolerance = 0.001) => Math.abs(value - expected) <= tolerance;
// helper 跑在另一个 realm，比较前先落成本 realm 的普通对象。
const plain = value => JSON.parse(JSON.stringify(value));

test('成图里的框是一条直角细实线：两下 strokeRect（半透明晕 + 主色），不抖动不走曲线', () => {
  const ctx = context();
  const rect = { x: 10, y: 20, width: 100, height: 60 };
  V.strokeNoteBox(ctx, rect, { width: 2, color: '#244e43' });
  const strokes = ctx.calls.filter(call => call.name === 'strokeRect');
  assert.equal(strokes.length, 2, '一层细晕 + 一层主色线');
  for (const call of strokes) {
    assert.deepEqual(call.args.slice(0, 4), [10, 20, 100, 60], '几何就是目标矩形，四角不偏移');
  }
  assert.equal(ctx.calls.some(call => call.name === 'quadraticCurveTo' || call.name === 'arc'), false, '不再走手绘路径');
});

test('纸底不再是整层不透明：只留一圈 35% 透明的细晕，虚线画完复位', () => {
  const ctx = context();
  V.strokeNoteBox(ctx, { x: 0, y: 0, width: 40, height: 40 }, { width: 3, color: '#244e43', dashed: true });
  const dashes = ctx.calls.filter(call => call.name === 'setLineDash').map(call => call.args[0]);
  assert.ok(dashes.some(value => Array.isArray(value) && value.length === 2 && value[0] > 0), '草稿框用虚线');
  assert.deepEqual(dashes[dashes.length - 1], [], '画完把虚线复位，不污染后面的标记');
  const strokeStyles = ctx.calls.filter(call => call.name === 'strokeRect').map(call => call.style);
  const halo = strokeStyles.find(style => String(style).startsWith('rgba'));
  assert.ok(halo, '晕是半透明的');
  assert.ok(Number(String(halo).match(/[\d.]+\)$/)?.[0]?.replace(')', '')) < 1, '透明度小于 1，不把像素整层盖掉');
  const widths = ctx.calls.filter(call => call.name === 'strokeRect').map(call => call.width);
  assert.deepEqual(widths, [4, 3], '晕只比主线宽 1 像素');

  const dot = context();
  V.strokeNoteDot(dot, { x: 5, y: 5 }, 4, { width: 2 });
  assert.equal(dot.calls.filter(call => call.name === 'arc').length, 2, '点目标也是细晕 + 细圆环');
  assert.equal(dot.calls.some(call => call.name === 'quadraticCurveTo'), false, '点不再用十段抖动折线');
});

test('关系线仍走曲线：缺 quadraticCurveTo 的宿主退回折线，形状不变', () => {
  const points = [{ x: 0, y: 0 }, { x: 10, y: 4 }, { x: 20, y: 0 }];
  const flat = context();
  V.strokeCurve(flat, points, false);
  const smooth = context({ quadratic: true });
  V.strokeCurve(smooth, points, false);
  assert.ok(flat.calls.some(call => call.name === 'lineTo'), '缺少曲线 API 时用折线');
  assert.equal(flat.calls.some(call => call.name === 'quadraticCurveTo'), false);
  assert.ok(smooth.calls.some(call => call.name === 'quadraticCurveTo'), '真实 Canvas 走二次曲线');
  const flatPoints = pathPoints(flat.calls);
  const smoothPoints = pathPoints(smooth.calls);
  assert.deepEqual(flatPoints.length > 0 && smoothPoints.length > 0, true);
  assert.ok(near(flatPoints[0].x, smoothPoints[0].x) && near(flatPoints[0].y, smoothPoints[0].y), '起点一致');
});

test('关系只有两端都在才算成立：same、缺端点、三个目标都不画方向线', () => {
  const rectA = { index: 0, kind: 'region', rect: { x: 0, y: 0, width: 40, height: 40 } };
  const rectB = { index: 1, kind: 'region', rect: { x: 100, y: 0, width: 40, height: 40 } };
  const move = { relation: 'move', targetCount: 2, targets: [rectA, rectB] };
  assert.equal(V.relationReady(move), true);
  assert.equal(V.relationReady({ ...move, relation: 'same' }), false, '普通多处同意见不画箭头');
  assert.equal(V.relationReady({ relation: 'move', targetCount: 2, targets: [rectA] }), false, '缺 B 就只画剩下的框');
  assert.equal(V.relationReady({ relation: 'reference', targetCount: 3, targets: [rectA, rectB, { ...rectB, index: 2 }] }), false, '三个目标已解除关系');
  assert.equal(V.relationReady({ relation: 'reference', targetCount: 2, targets: [rectB, rectA] }), true, '字母按 index 认，不靠数组顺序');
});

test('关系线从 A 外沿弯到 B 外沿，箭头落在 B 这一侧', () => {
  const note = { relation: 'move', targetCount: 2, targets: [
    { index: 0, kind: 'region', rect: { x: 0, y: 0, width: 40, height: 40 } },
    { index: 1, kind: 'region', rect: { x: 100, y: 0, width: 40, height: 40 } }] };
  const curve = V.relationCurve(note);
  assert.ok(curve);
  assert.equal(curve.points.length, 19, '默认 18 段采样');
  assert.ok(near(curve.from.x, 40) && near(curve.from.y, 20), '起点在 A 的右沿中点');
  assert.ok(near(curve.to.x, 100) && near(curve.to.y, 20), '终点在 B 的左沿中点');
  assert.deepEqual(plain(curve.points[0]), plain(curve.from));
  assert.deepEqual(plain(curve.points[curve.points.length - 1]), plain(curve.to));
  const mid = curve.points[9];
  assert.ok(mid.y > curve.from.y || mid.y < curve.from.y, '中间有偏移，是一条弯线而不是直连');
  // 参考关系弯度略大，避免两条线在小图上糊在一起。
  const reference = V.relationCurve({ ...note, relation: 'reference' });
  assert.ok(Math.abs(reference.control.y - 20) > Math.abs(curve.control.y - 20));
  // 点目标用中心锚点，不缩进。
  const withPoint = V.relationCurve({ relation: 'move', targetCount: 2, targets: [
    { index: 0, kind: 'point', point: { x: 20, y: 20 } }, { index: 1, kind: 'region', rect: { x: 100, y: 0, width: 40, height: 40 } }] });
  assert.deepEqual(plain(withPoint.from), { x: 20, y: 20 });
});

test('通用连接：只有画布实际连过才画，A 变多目标就是星形；缺 A 不拿 B 冒充', () => {
  const rectA = { index: 0, kind: 'region', rect: { x: 0, y: 0, width: 40, height: 40 } };
  const pointB = { index: 1, kind: 'point', point: { x: 160, y: 120 } };
  const rectC = { index: 2, kind: 'region', rect: { x: 100, y: 160, width: 40, height: 40 } };

  // 旧 same 多目标记录没有 linked：一根线都不画。
  assert.equal(V.linkReady({ targetCount: 2, targets: [rectA, pointB] }), false);
  assert.deepEqual(plain(V.linkCurves({ targetCount: 2, targets: [rectA, pointB] })), []);

  const note = { linked: true, targetCount: 3, targets: [rectA, pointB, rectC] };
  assert.equal(V.linkReady(note), true);
  const curves = V.linkCurves(note);
  assert.equal(curves.length, 2, 'A 到每个关联目标各一条');
  assert.deepEqual(plain(curves.map(curve => curve.index)), [1, 2]);
  assert.ok(curves.every(curve => curve.points.length === 17), '默认 16 段采样');
  assert.ok(curves.every(curve => curve.kind === 'link'), '不冒充 move/reference');
  // 每条都从 A 的边沿出发，不穿进框里。
  const [toB] = curves;
  assert.ok(toB.from.x >= 40 || toB.from.y >= 40, `起点在 A 的边缘：${JSON.stringify(toB.from)}`);
  assert.deepEqual(plain(toB.to), { x: 160, y: 120 }, '点目标用它的中心');

  // 裁掉主目标 A：整组不画，不把 B 当新的 A。
  assert.equal(V.linkReady({ linked: true, targetCount: 3, targets: [pointB, rectC] }), false);
  assert.deepEqual(plain(V.linkCurves({ linked: true, targetCount: 3, targets: [pointB, rectC] })), []);
  // 只剩一个目标也没有线可画。
  assert.equal(V.linkReady({ linked: true, targetCount: 1, targets: [rectA] }), false);
});

test('拖影几何：越界只整体平移回图内，宽高和精度都不变', () => {
  const rect = { x: 40, y: 40, width: 80, height: 80 };
  const view = { x: 0, y: 0, width: 400, height: 300 };
  assert.deepEqual(plain(V.movedRect(rect, 100, 60, view)), { x: 140, y: 100, width: 80, height: 80 });
  assert.deepEqual(plain(V.movedRect(rect, -400, -400, view)), { x: 0, y: 0, width: 80, height: 80 }, '左上越界贴回原点');
  assert.deepEqual(plain(V.movedRect(rect, 1000, 1000, view)), { x: 320, y: 220, width: 80, height: 80 }, '右下越界整体回收');
  const cropped = V.movedRect(rect, 0, 0, { x: 100, y: 120, width: 200, height: 100 });
  assert.deepEqual(plain(cropped), { x: 100, y: 120, width: 80, height: 80 }, '裁后视窗从非零原点算');
  const fractional = V.movedRect({ x: 0, y: 0, width: 10, height: 10 }, 1 / 3, 1 / 7, view);
  assert.equal(fractional.x, 0.33);
  assert.equal(fractional.y, 0.14);
});

test('把手布局：优先框上方，放不下换下/右/左，四侧都不行就夹进可视区', () => {
  const area = { left: 0, top: 0, width: 400, height: 300 };
  const top = V.handlePlacement({ left: 100, top: 100, width: 100, height: 80 }, area);
  assert.equal(top.side, 'top');
  assert.equal(top.left, 100 + 50 - V.HANDLE_WIDTH / 2);
  assert.equal(top.top, 100 - V.HANDLE_GAP - V.HANDLE_HEIGHT);

  const bottom = V.handlePlacement({ left: 100, top: 0, width: 100, height: 80 }, area);
  assert.equal(bottom.side, 'bottom', '上方放不下就翻到下方');
  assert.equal(bottom.top, 0 + 80 + V.HANDLE_GAP);

  const right = V.handlePlacement({ left: 2, top: 4, width: 396, height: 290 }, area);
  assert.equal(right.side, 'clamped', '四侧都放不下时夹进可视区，动作总能点到');
  assert.ok(right.left >= area.left && right.left + right.width <= area.left + area.width);
  assert.ok(right.top >= area.top && right.top + right.height <= area.top + area.height);

  assert.equal(V.handleContains(top, { x: top.left + 1, y: top.top + 1 }), true);
  assert.equal(V.handleContains(top, { x: top.left - 1, y: top.top + 1 }), false);
});

test('吸附只认指针落点最上层的那一个目标，点目标有自己的容差', () => {
  const list = [
    { kind: 'region', rect: { x: 0, y: 0, width: 100, height: 100 } },
    { kind: 'region', rect: { x: 50, y: 50, width: 100, height: 100 } },
    { kind: 'point', point: { x: 300, y: 300 } }
  ];
  assert.equal(V.targetAtPoint(list, { x: 80, y: 80 }).rect.x, 50, '重叠处取最后画的那个');
  assert.equal(V.targetAtPoint(list, { x: 20, y: 20 }).rect.x, 0);
  assert.equal(V.targetAtPoint(list, { x: 401, y: 401 }), null, '空白落点不吸');
  assert.equal(V.targetAtPoint(list, { x: 303, y: 303 }).kind, 'point', '点在容差内');
  assert.equal(V.targetAtPoint(list, { x: 340, y: 340 }), null, '点外面不算');
  assert.equal(V.targetAtPoint(list, { x: -2, y: 20 }, 4).rect.x, 0, '容差允许贴边细缝');
});

test('编号徽章不盖住落点，也不越出画面', () => {
  const bounds = { x: 0, y: 0, width: 400, height: 300 };
  const spot = V.badgeSpot({ x: 100, y: 100 }, 13, bounds);
  assert.ok(Math.hypot(spot.x - 100, spot.y - 100) > 13, '偏离落点');
  const corner = V.badgeSpot({ x: 0, y: 0 }, 13, bounds);
  assert.ok(corner.x - 13 >= bounds.x - 0.001 && corner.y - 13 >= bounds.y - 0.001, '贴角也留在画面内');
  const edge = V.badgeSpot({ x: 399, y: 299 }, 13, bounds);
  assert.ok(edge.x <= bounds.width && edge.y <= bounds.height);
});

test('关系摘要与短标签：固定语义只由关系类型生成，不冒充用户写的字', () => {
  assert.equal(V.relationSummary('move'), '把A移到B');
  assert.equal(V.relationSummary('reference'), '修改A，参考B（B不动）');
  assert.equal(V.relationSummary('same'), '');
  assert.deepEqual([V.targetLabel('move', 0), V.targetLabel('move', 1)], ['原位置', '移到这里']);
  assert.deepEqual([V.targetLabel('reference', 0), V.targetLabel('reference', 1)], ['要改', '参考']);
  assert.equal(V.targetLabel('same', 0), '');
  assert.equal(V.boxColor('reference', 0), V.PALETTE.pink, '参考关系 A 粉');
  assert.equal(V.boxColor('reference', 1), V.PALETTE.mint, '参考关系 B 绿');
  assert.equal(V.boxColor('same', 0), V.PALETTE.ink);
  assert.equal(V.relationOf('whatever'), 'same', '未知值一律回到普通多处同意见');
});
