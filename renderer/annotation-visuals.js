/* 手绘批注的共享几何与画法：只做路径计算和 Canvas 调用，不碰 DOM、不读编辑器状态、不发请求。
   屏幕预览与复制成图共用这一份几何，保证「看到的」和「导出的」是同一条关系。
   所有偏移都由稳定字符串派生的伪随机数生成，同一份数据每帧画出来完全一样，不用 Math.random。
   坐标单位由调用方决定：屏幕层传源图像素（ctx 已含 zoom/origin 变换），导出行传投影后的像素。 */
(() => {
  'use strict';
  const PALETTE = Object.freeze({ ink: '#244e43', inkDeep: '#20382e', mint: '#5dae8e', pink: '#e89bb0', paper: '#f7faf6' });
  // 关系摘要只描述关系本身，不冒充用户写的补充文字。
  const RELATION_SUMMARY = Object.freeze({ move: '把A移到B', reference: '修改A，参考B（B不动）' });
  const RELATION_LABELS = Object.freeze({ move: ['原位置', '移到这里'], reference: ['要改', '参考'] });
  const RELATION_KINDS = Object.freeze(['move', 'reference']);

  function relationOf(value) {
    return value === 'move' || value === 'reference' ? value : 'same';
  }
  function isRelation(value) { return RELATION_KINDS.includes(value); }
  function relationSummary(value) {
    const kind = relationOf(value);
    return RELATION_SUMMARY[kind] || '';
  }
  // 目标旁的固定短标签：只对 move/reference 有意义，普通批注返回空串。
  function targetLabel(value, index) {
    const labels = RELATION_LABELS[relationOf(value)];
    return labels ? labels[index] || '' : '';
  }
  // 框颜色跟着关系走：参考关系 A 粉 B 绿，移动与普通批注用墨绿/薄荷。
  function boxColor(value, index) {
    const kind = relationOf(value);
    if (kind === 'reference') return index === 0 ? PALETTE.pink : PALETTE.mint;
    if (kind === 'move') return PALETTE.mint;
    return PALETTE.ink;
  }

  // —— 稳定伪随机：同一 seed+序号永远同一个偏移量 ——
  function hashSeed(text) {
    let hash = 2166136261;
    for (const char of String(text)) {
      hash ^= char.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }
  function noise(seed, index) {
    const value = Math.sin((hashSeed(seed) + index * 127.1) * 0.0001) * 43758.5453;
    return (value - Math.floor(value)) * 2 - 1;
  }

  // —— 目标几何 ——
  function targetCenter(target) {
    if (!target) return null;
    if (target.kind === 'point') return { x: target.point.x, y: target.point.y };
    const rect = target.rect;
    if (!rect) return null;
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }
  // 射线与框边界的交点：关系线只连框的外沿，不穿进框里。
  function edgeAnchor(rect, toward) {
    const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
    if (!toward) return { x: cx, y: cy };
    const dx = toward.x - cx, dy = toward.y - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const halfWidth = rect.width / 2, halfHeight = rect.height / 2;
    const scaleX = dx ? halfWidth / Math.abs(dx) : Infinity;
    const scaleY = dy ? halfHeight / Math.abs(dy) : Infinity;
    const step = Math.min(scaleX, scaleY);
    return { x: cx + dx * step, y: cy + dy * step };
  }
  function targetAnchor(target, toward) {
    if (!target) return null;
    if (target.kind === 'point') return { x: target.point.x, y: target.point.y };
    return edgeAnchor(target.rect, toward || targetCenter(target));
  }
  // 源目标清单里按字母下标找：只有 A(0)、B(1) 才参与关系。
  function relationEnds(note) {
    const targets = Array.isArray(note?.targets) ? note.targets : [];
    const at = index => targets.find(target => target && target.index === index) || null;
    return { a: at(0), b: at(1) };
  }
  // 关系有效且两端都在，才画方向线：缺一个端点就只画剩下的框，不谎报一条完整的移动/参考。
  function relationReady(note) {
    const kind = relationOf(note?.relation);
    if (kind === 'same') return false;
    const count = Number.isFinite(note?.targetCount) ? note.targetCount : note?.sourceCount;
    if (count !== undefined && count !== 2) return false;
    const { a, b } = relationEnds(note);
    return Boolean(a && b);
  }
  // 关系线几何：起点在 A 外沿、终点在 B 外沿，控制点垂直偏移成一条弯线。
  function relationCurve(note, bend = 0.18, steps = 18) {
    if (!relationReady(note)) return null;
    const { a, b } = relationEnds(note);
    const from = targetAnchor(a, targetCenter(b));
    const to = targetAnchor(b, targetCenter(a));
    if (!from || !to) return null;
    const dx = to.x - from.x, dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length < 0.5) return null;
    // 参考关系的弯度略大一点，移动关系更直，避免两条线在小图上糊在一起。
    const amount = relationOf(note.relation) === 'reference' ? bend * 1.25 : bend;
    const control = { x: (from.x + to.x) / 2 - dy * amount, y: (from.y + to.y) / 2 + dx * amount };
    const points = [];
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps, inv = 1 - t;
      points.push({ x: inv * inv * from.x + 2 * inv * t * control.x + t * t * to.x,
        y: inv * inv * from.y + 2 * inv * t * control.y + t * t * to.y });
    }
    return { from, to, control, points, kind: relationOf(note.relation) };
  }

  // 通用连接：用户从画布把手实际连过的分组，A → 每个关联目标一条指向线。
  // 与 move/reference 分开：这条线不声明「移动/参考/交换」，只表示「指着这里」。
  function linkReady(note) {
    if (note?.linked !== true) return false;
    const targets = Array.isArray(note?.targets) ? note.targets : [];
    const count = Number.isFinite(note?.targetCount) ? note.targetCount : note?.sourceCount;
    if (count !== undefined && count < 2) return false;
    if (!targets.some(target => target && target.index === 0)) return false;
    return targets.some(target => target && target.index !== 0);
  }
  // 每个关联目标一条曲线；缺主目标（裁掉 A）就整体不画，不拿 B 冒充 A。
  function linkCurves(note, bend = 0.1, steps = 16) {
    if (!linkReady(note)) return [];
    const targets = note.targets || [];
    const source = targets.find(target => target && target.index === 0) || null;
    if (!source) return [];
    const out = [];
    for (const target of targets) {
      if (!target || target.index === 0) continue;
      const from = targetAnchor(source, targetCenter(target));
      const to = targetAnchor(target, targetCenter(source));
      if (!from || !to) continue;
      const dx = to.x - from.x, dy = to.y - from.y;
      const length = Math.hypot(dx, dy);
      if (length < 0.5) continue;
      // 每条指向线弯向同一侧，多条线聚在一起也不互相冒充。
      const control = { x: (from.x + to.x) / 2 - dy * bend, y: (from.y + to.y) / 2 + dx * bend };
      const points = [];
      for (let i = 0; i <= steps; i += 1) {
        const t = i / steps, inv = 1 - t;
        points.push({ x: inv * inv * from.x + 2 * inv * t * control.x + t * t * to.x,
          y: inv * inv * from.y + 2 * inv * t * control.y + t * t * to.y });
      }
      out.push({ from, to, control, points, kind: 'link', index: target.index });
    }
    return out;
  }

  // —— 手绘矩形 ——
  // 每条边三等分采样，中间点垂直方向轻微起伏；角点也带一点偏移，看起来是手画的而不是印刷框。
  function roughRectPoints(rect, seed, wobble) {
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return [];
    const x = rect.x, y = rect.y, right = rect.x + rect.width, bottom = rect.y + rect.height;
    const corners = [[x, y], [right, y], [right, bottom], [x, bottom]];
    const points = [];
    let index = 0;
    for (let edge = 0; edge < 4; edge += 1) {
      const [ax, ay] = corners[edge], [bx, by] = corners[(edge + 1) % 4];
      const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy) || 1;
      const nx = -dy / length, ny = dx / length;
      for (let step = 0; step < 3; step += 1) {
        const t = step / 3;
        const offset = (step === 0 ? noise(seed, index) * 0.35 : noise(seed, index)) * wobble;
        index += 1;
        points.push({ x: ax + dx * t + nx * offset, y: ay + dy * t + ny * offset });
      }
    }
    return points;
  }
  // 折线/平滑曲线：真实 Canvas 用二次曲线，缺少这个 API 的宿主退回折线，画出来的仍是同一条路径。
  function strokeCurve(ctx, points, closed) {
    if (!points || points.length < 2) return;
    const list = closed ? points.concat([points[0]]) : points;
    ctx.beginPath();
    ctx.moveTo(list[0].x, list[0].y);
    if (typeof ctx.quadraticCurveTo === 'function' && list.length > 2) {
      for (let i = 1; i < list.length - 1; i += 1) {
        const cur = list[i], next = list[i + 1];
        ctx.quadraticCurveTo(cur.x, cur.y, (cur.x + next.x) / 2, (cur.y + next.y) / 2);
      }
      const last = list[list.length - 1];
      ctx.lineTo(last.x, last.y);
    } else {
      for (let i = 1; i < list.length; i += 1) ctx.lineTo(list[i].x, list[i].y);
    }
    ctx.stroke();
  }
  // 手绘框：先用纸色描一遍更粗的底，再叠主色线，双描让细线在深色截图上也能读清。
  function strokeNoteBox(ctx, rect, options = {}) {
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return;
    const width = Math.max(0.6, options.width || 2);
    const color = options.color || PALETTE.ink;
    const seed = options.seed || 'box';
    const smallest = Math.min(rect.width, rect.height);
    const wobble = Math.max(0.4, Math.min(width * 1.6, smallest * 0.02));
    const points = roughRectPoints(rect, seed, wobble);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (options.dashed && typeof ctx.setLineDash === 'function') {
      ctx.setLineDash([Math.max(3, width * 3), Math.max(2, width * 2)]);
    }
    ctx.strokeStyle = options.paper || PALETTE.paper;
    ctx.lineWidth = width + Math.max(1.2, width * 0.9);
    strokeCurve(ctx, points, true);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    strokeCurve(ctx, points, true);
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
    ctx.restore();
  }
  // 点目标的落点小圈：同样轻微不圆。
  function strokeNoteDot(ctx, point, radius, options = {}) {
    if (!point) return;
    const width = Math.max(0.6, options.width || 2);
    const color = options.color || PALETTE.ink;
    const wobble = Math.max(0.2, Math.min(width, radius * 0.12));
    const seed = options.seed || 'dot';
    const points = [];
    const steps = 10;
    for (let i = 0; i < steps; i += 1) {
      const angle = (Math.PI * 2 * i) / steps;
      const stretch = 1 + noise(seed, i) * (wobble / Math.max(1, radius));
      points.push({ x: point.x + Math.cos(angle) * radius * stretch, y: point.y + Math.sin(angle) * radius * stretch });
    }
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = options.paper || PALETTE.paper;
    ctx.lineWidth = width + Math.max(1.2, width * 0.9);
    strokeCurve(ctx, points, true);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    strokeCurve(ctx, points, true);
    ctx.restore();
  }

  // —— 关系线 ——
  function arrowHead(ctx, at, angle, size) {
    const spread = 0.42;
    ctx.beginPath();
    ctx.moveTo(at.x, at.y);
    ctx.lineTo(at.x - Math.cos(angle - spread) * size, at.y - Math.sin(angle - spread) * size);
    ctx.moveTo(at.x, at.y);
    ctx.lineTo(at.x - Math.cos(angle + spread) * size, at.y - Math.sin(angle + spread) * size);
    ctx.stroke();
  }
  function strokeRelationLine(ctx, curve, options = {}) {
    if (!curve || !curve.points || curve.points.length < 2) return;
    const width = Math.max(0.6, options.width || 2);
    const color = options.color || PALETTE.ink;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = options.paper || PALETTE.paper;
    ctx.lineWidth = width + Math.max(1.2, width * 0.9);
    strokeCurve(ctx, curve.points, false);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    strokeCurve(ctx, curve.points, false);
    // 箭头方向取最后一段的切向，尺寸有下限，小图上也能看出朝向。
    const last = curve.points[curve.points.length - 1];
    const before = curve.points[Math.max(0, curve.points.length - 3)];
    const angle = Math.atan2(last.y - before.y, last.x - before.x);
    arrowHead(ctx, last, angle, Math.max(6, width * 3.2));
    ctx.restore();
  }

  // —— 小标签（编号徽章 / 关系摘要 / 目标短标签）——
  function labelMetrics(ctx, text, fontSize) {
    const font = `${fontSize}px 'Microsoft YaHei UI','Microsoft YaHei','PingFang SC',system-ui,sans-serif`;
    ctx.font = font;
    const width = typeof ctx.measureText === 'function' ? ctx.measureText(String(text)).width : String(text).length * fontSize;
    return { font, width, height: Math.round(fontSize * 1.35) };
  }
  // 标签默认画在给定点上方居中；bounds 直接把标签夹在画面内，目标几何一根线都不动。
  function drawLabel(ctx, text, at, options = {}) {
    const value = String(text ?? '');
    if (!value) return null;
    const fontSize = Math.max(9, options.fontSize || 14);
    const metrics = labelMetrics(ctx, value, fontSize);
    const paddingX = Math.max(5, fontSize * 0.5), paddingY = Math.max(2, fontSize * 0.22);
    const width = metrics.width + paddingX * 2, height = metrics.height + paddingY * 2;
    let left = at.x - width / 2, top = at.y - height / 2;
    const bounds = options.bounds;
    if (bounds) {
      left = Math.min(Math.max(bounds.x + 1, left), Math.max(bounds.x + 1, bounds.x + bounds.width - width - 1));
      top = Math.min(Math.max(bounds.y + 1, top), Math.max(bounds.y + 1, bounds.y + bounds.height - height - 1));
    }
    ctx.save();
    ctx.fillStyle = options.background || PALETTE.paper;
    ctx.strokeStyle = options.border || PALETTE.ink;
    ctx.lineWidth = Math.max(0.6, (options.width || 2) * 0.7);
    ctx.beginPath();
    ctx.rect(left, top, width, height);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = options.color || PALETTE.inkDeep;
    ctx.font = metrics.font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(value, left + width / 2, top + height / 2);
    ctx.restore();
    return { left, top, width, height };
  }
  // 圆形编号徽章：复制成图上与下方说明的编号对齐，多目标带字母。
  function drawBadge(ctx, text, at, options = {}) {
    const value = String(text ?? '');
    if (!value) return null;
    const radius = Math.max(7, options.radius || 13);
    const fontSize = Math.max(10, Math.round(radius * 1.1));
    ctx.save();
    ctx.beginPath();
    ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = options.background || PALETTE.paper;
    ctx.fill();
    ctx.lineWidth = Math.max(1, radius / 6);
    ctx.strokeStyle = options.border || PALETTE.ink;
    ctx.stroke();
    ctx.fillStyle = options.color || PALETTE.inkDeep;
    ctx.font = `${fontSize}px 'Microsoft YaHei UI','Microsoft YaHei','PingFang SC',system-ui,sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(value, at.x, at.y);
    ctx.restore();
    return { x: at.x, y: at.y, radius };
  }
  // 徽章避开落点：往图内侧偏出去，贴边就向内收，和屏幕上的 DOM 编号用同一套规则。
  function badgeSpot(anchor, radius, bounds) {
    const gap = Math.max(2, radius * 0.45), distance = radius * 2 + gap;
    const sx = anchor.x - bounds.x <= bounds.x + bounds.width - anchor.x ? 1 : -1;
    const sy = anchor.y - bounds.y <= bounds.y + bounds.height - anchor.y ? 1 : -1;
    const clampAxis = (value, low, high) => high - low <= radius * 2
      ? (low + high) / 2 : Math.min(high - radius, Math.max(low + radius, value));
    let best = null;
    for (const [sideX, sideY] of [[sx, sy], [-sx, sy], [sx, -sy], [-sx, -sy]]) {
      const x = clampAxis(anchor.x + sideX * distance, bounds.x, bounds.x + bounds.width);
      const y = clampAxis(anchor.y + sideY * distance, bounds.y, bounds.y + bounds.height);
      const clear = Math.hypot(x - anchor.x, y - anchor.y) - radius * 2;
      const score = (clear >= gap * 0.5 ? 1000 : 0) - Math.abs(x - (anchor.x + sideX * distance)) - Math.abs(y - (anchor.y + sideY * distance));
      if (!best || score > best.score) best = { x, y, score };
    }
    return { x: best.x, y: best.y };
  }

  // —— 把手布局：显示与命中共用同一次计算 ——
  // 候选顺序按交接单：上方居中 → 下方居中 → 右侧居中 → 左侧居中，离框 12 CSS 像素。
  const HANDLE_GAP = 12, HANDLE_WIDTH = 76, HANDLE_HEIGHT = 30;
  function handlePlacement(box, area, candidates = ['top', 'bottom', 'right', 'left']) {
    const order = [...candidates, 'top', 'bottom', 'right', 'left'];
    for (const side of order) {
      let left = box.left + box.width / 2 - HANDLE_WIDTH / 2, top = box.top - HANDLE_GAP - HANDLE_HEIGHT;
      if (side === 'bottom') top = box.top + box.height + HANDLE_GAP;
      if (side === 'right') { left = box.left + box.width + HANDLE_GAP; top = box.top + box.height / 2 - HANDLE_HEIGHT / 2; }
      if (side === 'left') { left = box.left - HANDLE_GAP - HANDLE_WIDTH; top = box.top + box.height / 2 - HANDLE_HEIGHT / 2; }
      const inside = left >= area.left && top >= area.top &&
        left + HANDLE_WIDTH <= area.left + area.width && top + HANDLE_HEIGHT <= area.top + area.height;
      if (inside) return { side, left, top, width: HANDLE_WIDTH, height: HANDLE_HEIGHT };
    }
    // 四侧都放不下（框几乎占满可视区）：把上方候选夹进可视区，保证这个动作总是能点到。
    const left = Math.min(Math.max(area.left, box.left + box.width / 2 - HANDLE_WIDTH / 2), area.left + area.width - HANDLE_WIDTH);
    const top = Math.min(Math.max(area.top, box.top - HANDLE_GAP - HANDLE_HEIGHT), area.top + area.height - HANDLE_HEIGHT);
    return { side: 'clamped', left, top, width: HANDLE_WIDTH, height: HANDLE_HEIGHT, clamped: true };
  }
  function handleContains(box, at) {
    return Boolean(box) && at.x >= box.left && at.x <= box.left + box.width &&
      at.y >= box.top && at.y <= box.top + box.height;
  }
  // 拖动全量：B 用 A 的图像坐标加本次位移算，不把把手坐标当 B 的左上角。
  function movedRect(rect, dx, dy, view) {
    const round = value => Math.round(value * 100) / 100;
    let x = rect.x + dx, y = rect.y + dy;
    // 整体平移回图内，宽高保持不变；绝不在数据层静默夹取非法几何。
    if (x < view.x) x = view.x;
    if (y < view.y) y = view.y;
    if (x + rect.width > view.x + view.width) x = view.x + view.width - rect.width;
    if (y + rect.height > view.y + view.height) y = view.y + view.height - rect.height;
    return { x: round(x), y: round(y), width: rect.width, height: rect.height };
  }
  function sameRect(a, b) {
    return Boolean(a && b) && ['x', 'y', 'width', 'height'].every(key => a[key] === b[key]);
  }
  // 指针落在哪一个已提交目标上：取最后（最上层）命中的那个，只认它当前的可见几何。
  function targetAtPoint(list, at, tolerance = 4) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const target = list[i];
      if (!target) continue;
      if (target.kind === 'point') {
        if (Math.hypot(at.x - target.point.x, at.y - target.point.y) <= tolerance * 3) return target;
        continue;
      }
      const rect = target.rect;
      if (at.x >= rect.x - tolerance && at.x <= rect.x + rect.width + tolerance &&
          at.y >= rect.y - tolerance && at.y <= rect.y + rect.height + tolerance) return target;
    }
    return null;
  }

  window.AnnotationVisuals = Object.freeze({
    PALETTE, RELATION_SUMMARY, RELATION_LABELS, HANDLE_GAP, HANDLE_WIDTH, HANDLE_HEIGHT,
    relationOf, isRelation, relationSummary, targetLabel, boxColor,
    hashSeed, noise, targetCenter, targetAnchor, edgeAnchor, relationEnds, relationReady, relationCurve, linkReady, linkCurves,
    roughRectPoints, strokeCurve, strokeNoteBox, strokeNoteDot, strokeRelationLine,
    labelMetrics, drawLabel, drawBadge, badgeSpot,
    handlePlacement, handleContains, movedRect, sameRect, targetAtPoint
  });
})();
