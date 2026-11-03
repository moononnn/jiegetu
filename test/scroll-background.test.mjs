import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, detectShift, newRows, compose } from '../core/scroll.mjs';
import { chatFrame } from './fixtures/chat-background.mjs';
const positions = [42, 98, 100, 167, 199, 286, 300, 332, 390, 400, 402, 451, 500, 521, 597, 602, 683];
function withFixedHeader(offset, footer = 0) {
  const image = chatFrame(offset, { width: 363, height: 559, inset: .18, footer });
  for (let y = 0; y < 30; y++) for (let x = 0; x < image.width; x++) {
    const i = (y * image.width + x) * 4;
    const value = ((Math.imul(x + 7, 17389) ^ Math.imul(y + 3, 31337)) >>> 4) & 255;
    image.data[i] = image.data[i + 1] = image.data[i + 2] = value;
  }
  return image;
}
test('前景顶部误拦基线：同一锚帧的已知前景位移不因顶部独自被拒绝', () => {
  const seed = withFixedHeader(0), anchor = fingerprint(seed); let history;
  for (const offset of [13, 34, 80, 121, 200]) {
    const image = withFixedHeader(offset), current = fingerprint(image), result = detectShift(anchor, current, history);
    assert.equal(result.kind, 'forward', `offset=${offset}: ${JSON.stringify(result)}`);
    assert.equal(result.shift, offset);
    assert.ok(image.height - result.shift >= 30, '固定顶部不能进入新增条');
    const part = newRows(image, result.shift);
    assert.deepEqual(part.data, image.data.slice((image.height - result.shift) * image.width * 4));
    assert.equal(compose([{ height: seed.height, data: seed.data }, part], seed.width).height, seed.height + offset);
    history = { previous: current, shift: result.shift };
  }
});
test('顶部修正按真实worker历史连续接长200行，顶部只保留首帧一次', () => {
  const seed = withFixedHeader(0); let frontier = fingerprint(seed), accepted = 0;
  const chunks = [{ height: seed.height, data: seed.data }], history = [{ frame: frontier, position: 0 }];
  for (const position of [13, 34, 80, 121, 200]) {
    const image = withFixedHeader(position), current = fingerprint(image), previous = history.findLast(item => item.position !== accepted);
    const result = detectShift(frontier, current, previous && { previous: previous.frame, shift: previous.position - accepted });
    if (result.foreground && Number.isInteger(result.shift)) {
      history.push({ frame: current, position: accepted + result.shift }); if (history.length > 2) history.shift();
    }
    assert.equal(result.kind, 'forward', `position=${position}: ${JSON.stringify(result)}`);
    assert.equal(result.shift, position - accepted); assert.ok(image.height - result.shift >= 30);
    chunks.push(newRows(image, result.shift)); accepted = position; frontier = current;
  }
  const output = compose(chunks, seed.width);
  assert.equal(output.height, seed.height + 200);
  assert.deepEqual(output.data.slice(0, 30 * seed.width * 4), seed.data.slice(0, 30 * seed.width * 4));
});
for (const footer of [1, 16, 120]) test(`顶部放行不能解除${footer}行真实底栏`, () => {
  const anchor = fingerprint(withFixedHeader(0, footer)); let history, bottomWitnesses = 0;
  for (const offset of [13, 34, 80, 121, 200]) {
    const current = fingerprint(withFixedHeader(offset, footer)), result = detectShift(anchor, current, history);
    assert.notEqual(result.kind, 'forward', `offset=${offset}: ${JSON.stringify(result)}`);
    if (result.kind === 'fixed' && result.edge === '底部' && result.foreground) bottomWitnesses++;
    if (result.foreground && Number.isInteger(result.shift)) history = { previous: current, shift: result.shift };
  }
  assert.ok(bottomWitnesses > 0, '必须实际命中前景底栏门，不能靠其他失配空过');
});
test('密集插画底纹与85%纸面：连续2040行无错位，原RGBA图片条逐字节保留', () => {
  const options = { width: 363, height: 559, inset: .18, alpha: .85, illustratedWallpaper: true };
  const first = chatFrame(0, options); let frontier = fingerprint(first), accepted = 0;
  const chunks = [{ height: first.height, data: first.data }], expected = [first.data], history = [{ frame: frontier, position: 0 }];
  for (let offset = 17; offset <= 2040; offset += 17) {
    const image = chatFrame(offset, options), current = fingerprint(image), previous = history.findLast(item => item.position !== accepted);
    const result = detectShift(frontier, current, previous && { previous: previous.frame, shift: previous.position - accepted });
    if ((result.foreground || ['forward', 'reverse'].includes(result.kind)) && Number.isInteger(result.shift) && result.shift && history.at(-1)?.position !== accepted + result.shift) {
      history.push({ frame: current, position: accepted + result.shift }); if (history.length > 2) history.shift();
    }
    assert.notEqual(result.kind, 'reverse', `只向前滚动不应误判回滚，offset=${offset}`);
    if (result.kind !== 'forward') continue;
    assert.equal(result.shift, offset - accepted, `不接受错误位移，offset=${offset}`);
    chunks.push(newRows(image, result.shift)); expected.push(image.data.slice((image.height - result.shift) * image.width * 4));
    accepted = offset; frontier = current;
  }
  assert.equal(accepted, 2040);
  const output = compose(chunks, first.width), pixels = new Uint8ClampedArray(output.data.length); let cursor = 0;
  for (const part of expected) { pixels.set(part, cursor); cursor += part.length; }
  assert.equal(output.height, first.height + 2040); assert.deepEqual(output.data, pixels);
});
for (const extra of [{ footer: 1 }, { footer: 16 }, { footer: 120 },
  { footer: 120, gradientFooter: true, softFooter: true, gradientRange: 16 },
  { footer: 120, gradientFooter: true, softFooter: true, gradientRange: 16, footerBlink: true }]) {
  test(`密集插画纸面仍拒绝真底栏 ${JSON.stringify(extra)}`, () => {
    const options = { width: 363, height: 559, inset: .18, alpha: .85, illustratedWallpaper: true, ...extra };
    const anchor = fingerprint(chatFrame(0, options)); let history, bottomWitnesses = 0;
    for (const offset of [17, 34, 51, 85, 121, 200]) {
      const current = fingerprint(chatFrame(offset, options)), result = detectShift(anchor, current, history);
      assert.notEqual(result.kind, 'forward', `offset=${offset}: ${JSON.stringify(result)}`);
      if (result.kind === 'fixed' && result.edge === '底部' && result.foreground) bottomWitnesses++;
      if (result.foreground && Number.isInteger(result.shift)) history = { previous: current, shift: result.shift };
    }
    assert.ok(bottomWitnesses > 0, '必须实际命中前景底栏门，不能靠失配空过');
  });
}
for (const alpha of [1, .85]) test(`密集插画周期消息${alpha}：不把周期别名认成唯一正向或反向`, () => {
  const options = { width: 363, height: 559, inset: .18, alpha, illustratedWallpaper: true, repeat: true };
  const anchor = fingerprint(chatFrame(0, options));
  for (const offset of [17, 160, 177, 320]) {
    const result = detectShift(anchor, fingerprint(chatFrame(offset, options)));
    assert.ok(!['forward', 'reverse'].includes(result.kind), `offset=${offset}: ${JSON.stringify(result)}`);
  }
});
test('密集插画采样邻域强边不能把不匹配中心诱骗成唯一运动', () => {
  const options = { width: 363, height: 559, inset: .18, alpha: .85, illustratedWallpaper: true };
  for (const center of [15, 70, 128]) {
    const a = chatFrame(0, options), b = chatFrame(0, options);
    for (let y = 17; y < options.height - 17; y += 3) for (let c = 11; c <= 43; c += 2) {
      for (let dy = -1; dy <= 1; dy++) for (let dc = -1; dc <= 1; dc++) {
        const x = Math.floor(options.width * (.06 + .88 * (c + dc + .5) / 48));
        const i = ((y + dy) * options.width + x) * 4, isCenter = dy === 0 && dc === 0;
        // 同坐标强邻边可抬高双方范围；中心单独变色，没有页面滚动。
        const value = isCenter ? 0 : (dy === -1 ? 0 : 255);
        a.data[i] = a.data[i + 1] = a.data[i + 2] = value;
        b.data[i] = b.data[i + 1] = b.data[i + 2] = isCenter ? center : value;
      }
    }
    const result = detectShift(fingerprint(a), fingerprint(b));
    // 15是静止对照；70/128已用只读影子计数确认进入patchError，不能靠still空过。
    if (center >= 70) assert.equal(result.kind, 'unmatched', `center=${center}必须走非still拒绝`);
    assert.ok(!['forward', 'reverse'].includes(result.kind), `center=${center}: ${JSON.stringify(result)}`);
  }
});
test('密集插画多处遮挡不冒充运动，也不污染随后真实滚动', () => {
  const options = { width: 363, height: 559, inset: .18, alpha: .85, illustratedWallpaper: true };
  let frontier = fingerprint(chatFrame(0, options)), accepted = 0;
  const history = [{ frame: frontier, position: 0 }];
  for (const phase of [0, 1, 2, 3, -1, ...Array.from({ length: 12 }, (_, i) => 17 * (i + 1))]) {
    const moving = phase >= 17, offset = moving ? phase : 0, image = chatFrame(offset, options);
    if (!moving && phase >= 0) for (const rx of [.22, .48, .75]) for (const ry of [.24, .45, .7]) {
      for (let y = Math.floor(image.height * ry); y < Math.floor(image.height * ry) + 20; y++) for (let x = Math.floor(image.width * rx); x < Math.floor(image.width * rx) + 24; x++) {
        const i = (y * image.width + x) * 4, value = ((x + y + phase) % 4 < 2) ? 0 : 255;
        image.data[i] = image.data[i + 1] = image.data[i + 2] = value;
      }
    }
    const current = fingerprint(image), previous = history.findLast(item => item.position !== accepted);
    const result = detectShift(frontier, current, previous && { previous: previous.frame, shift: previous.position - accepted });
    assert.notEqual(result.kind, 'reverse', `phase=${phase}`);
    if (!moving) assert.notEqual(result.kind, 'forward', `phase=${phase}`);
    if (result.foreground && Number.isInteger(result.shift) && result.shift && history.at(-1)?.position !== accepted + result.shift) {
      history.push({ frame: current, position: accepted + result.shift }); if (history.length > 2) history.shift();
    }
    if (result.kind === 'forward') { assert.equal(result.shift, offset - accepted); accepted = offset; frontier = current; }
  }
  assert.equal(accepted, 204);
});
test('密集底纹只有纸面透明度变化、无滚动时不追加', () => {
  const options = { width: 363, height: 559, inset: .18, illustratedWallpaper: true };
  const anchor = fingerprint(chatFrame(0, { ...options, alpha: .85 }));
  for (const alpha of [.7, .8, .9, 1]) assert.notEqual(detectShift(anchor, fingerprint(chatFrame(0, { ...options, alpha }))).kind, 'forward');
});

for (const fixed of [false, true]) test(`背景${fixed ? '固定' : '随正文滚动'}：只按移动消息接长，不在半路永久失配`, () => {
  const first = chatFrame(0, { fixed }); let frontier = fingerprint(first), accepted = 0;
  const chunks = [{ data: first.data, height: first.height }], expected = [first.data];
  const history = [{ frame: frontier, position: 0 }];
  for (const offset of positions) {
    const previous = history.findLast(item => item.position !== accepted);
    const frame = chatFrame(offset, { fixed }), current = fingerprint(frame), result = detectShift(frontier, current,
      previous && { previous: previous.frame, shift: previous.position - accepted });
    if (result.foreground || result.kind === 'forward') {
      history.push({ frame: current, position: accepted + result.shift }); if (history.length > 2) history.shift();
    }
    if (result.kind !== 'forward') { assert.equal(result.kind, 'fixed', `offset=${offset}: ${JSON.stringify(result)}`); continue; }
    assert.equal(result.shift, offset - accepted);
    chunks.push(newRows(frame, result.shift)); expected.push(frame.data.slice((frame.height - result.shift) * frame.width * 4));
    frontier = current; accepted = offset;
  }
  const output = compose(chunks, first.width);
  assert.equal(accepted, 683, '临时核对不能变成永久停接');
  assert.equal(output.height, first.height + 683);
  const pixels = new Uint8ClampedArray(output.data.length); let cursor = 0;
  for (const part of expected) { pixels.set(part, cursor); cursor += part.length; }
  assert.deepEqual(output.data, pixels); // 输出保持每段原RGBA，不重绘或隐去壁纸。
});
for (const footer of [1, 2, 3, 16, 40, 120, 200]) for (const gradientFooter of [false, true]) test(`固定壁纸伴随${footer}行${gradientFooter ? '渐变' : '纹理'}真底栏仍拒绝重复拼入`, () => {
  const options = { footer, gradientFooter }, frontier = fingerprint(chatFrame(0, options));
  let previous = frontier, previousShift = 0, foreground = 0;
  for (const offset of [42, 98, 100, 167, 199, 286, 300]) {
    const current = fingerprint(chatFrame(offset, options));
    const result = detectShift(frontier, current, { previous, shift: previousShift });
    assert.notEqual(result.kind, 'forward', `offset=${offset}, footer=${footer}: ${JSON.stringify(result)}`);
    if (result.foreground && Number.isInteger(result.shift)) { foreground++; previous = current; previousShift = result.shift; }
  }
  assert.ok(foreground >= 2, '必须实际经过多帧前景路径，不能靠不启用新路径让底栏测试空过');
});
for (const options of [{ footer: 200, gradientFooter: true, softFooter: true }, { footer: 1, footerBlink: true },
  { footer: 200, gradientFooter: true, softFooter: true, footerBlink: true }]) test(`审查反例：${options.softFooter ? '柔和渐变底栏' : '真底栏'}${options.footerBlink ? '＋同行闪烁' : ''}不能被时序确认解除`, () => {
  const frontier = fingerprint(chatFrame(0, options)); let previous = frontier, shift = 0;
  for (const offset of [42, 98, 100, 167, 199, 286, 300]) {
    const current = fingerprint(chatFrame(offset, options));
    const result = detectShift(frontier, current, { previous, shift });
    assert.notEqual(result.kind, 'forward', `offset=${offset}: ${JSON.stringify(result)}`);
    if (result.foreground && Number.isInteger(result.shift)) { previous = current; shift = result.shift; }
  }
});
test('固定背景：重复同帧、同一位移或首帧本身不能冒充第三个运动位置', () => {
  const seed = chatFrame(0), changed = chatFrame(42), row = seed.height - 7, stride = seed.width * 4;
  changed.data.set(seed.data.subarray(row * stride, (row + 1) * stride), row * stride);
  const a = fingerprint(seed), b = fingerprint(changed);
  const pending = detectShift(a, b);
  assert.equal(pending.kind, 'fixed'); assert.equal(pending.pending, true);
  assert.equal(detectShift(a, b, { previous: a, shift: 0 }).kind, 'fixed');
  assert.equal(detectShift(a, b, { previous: b, shift: 42 }).kind, 'fixed');
  const next = detectShift(a, fingerprint(chatFrame(98)), { previous: b, shift: 42 });
  assert.equal(next.kind, 'forward'); assert.equal(next.shift, 98);
});
test('历史见证仅窄列移动不算独立整页运动，不能解除固定结构核对', () => {
  const seed = chatFrame(0), changed = chatFrame(42), moving = chatFrame(98), narrow = chatFrame(0);
  const row = seed.height - 7, stride = seed.width * 4;
  changed.data.set(seed.data.subarray(row * stride, (row + 1) * stride), row * stride);
  // 只有一小条纵向内容移动；旧宽松见证可得39个匹配、35行，但仅2列、1个列组。
  for (let y = 0; y < seed.height; y++) {
    const start = (y * seed.width + 150) * 4;
    narrow.data.set(moving.data.subarray(start, start + 56 * 4), start);
  }
  const result = detectShift(fingerprint(seed), fingerprint(changed), { previous: fingerprint(narrow), shift: 98 });
  assert.equal(result.kind, 'fixed'); assert.equal(result.pending, true);
});
test('固定背景：周期正文有多个同分前景位移时拒绝，不能退回小位移灰度答案', () => {
  const a = fingerprint(chatFrame(0, { repeat: true })), b = fingerprint(chatFrame(161, { repeat: true }));
  const result = detectShift(a, b);
  assert.notEqual(result.kind, 'forward');
});
test('半透明消息和小幅采样误差：仍按真实前景位移，不把壁纸亮度差当成字形', () => {
  const frame = offset => {
    const image = chatFrame(offset, { alpha: .85 });
    for (let i = 0; i < image.data.length; i += 4) {
      const noise = ((Math.imul(i + 7, 17389) ^ Math.imul(offset + 1, 31337)) >>> 8) % 3 - 1;
      for (let c = 0; c < 3; c++) image.data[i + c] += noise;
    }
    return fingerprint(image);
  };
  let frontier = frame(0), accepted = 0;
  const history = [{ frame: frontier, position: 0 }];
  for (const offset of [1, 2, 3, 7, 16, 42, 98, 167, 199, 286, 300, 390, 451, 500, 597, 683]) {
    const previous = history.findLast(item => item.position !== accepted), current = frame(offset);
    const result = detectShift(frontier, current, previous && { previous: previous.frame, shift: previous.position - accepted });
    if (result.foreground && Number.isInteger(result.shift) || ['forward', 'reverse'].includes(result.kind)) {
      history.push({ frame: current, position: accepted + result.shift }); if (history.length > 2) history.shift();
    }
    if (result.kind === 'forward') {
      assert.equal(result.shift, offset - accepted, `offset=${offset}: ${JSON.stringify(result)}`);
      frontier = current; accepted = offset;
    }
  }
  assert.equal(accepted, 683);
});
for (const alpha of [1, .85]) test(`线条壁纸与内缩消息，不透明度${alpha}：不能把永久可见装饰或纸面当固定栏`, () => {
  const options = { width: 332, height: 506, inset: .18, outlinedWallpaper: true, alpha };
  let frontier = fingerprint(chatFrame(0, options)), accepted = 0;
  const history = [{ frame: frontier, position: 0 }];
  for (const offset of [17, 34, 51, 128, 200, 258, 300, 332, 390, 451, 500, 597, 683, 750, 817, 910, 1020, 1207, 1400, 1600, 1840, 2040]) {
    const previous = history.findLast(item => item.position !== accepted), current = fingerprint(chatFrame(offset, options));
    const result = detectShift(frontier, current, previous && { previous: previous.frame, shift: previous.position - accepted });
    if (result.foreground && Number.isInteger(result.shift)) {
      history.push({ frame: current, position: accepted + result.shift }); if (history.length > 2) history.shift();
    }
    if (result.kind === 'forward') { assert.equal(result.shift, offset - accepted); frontier = current; accepted = offset; }
  }
  assert.equal(accepted, 2040, '消息位移可辨识，壁纸留边或半透明纸面不应永久锁住前沿');
});
test('线条壁纸的消息留边处理仍不能放行真正的宽底栏', () => {
  for (const footer of [1, 3, 40, 200]) for (const gradientFooter of [false, true]) {
    const options = { width: 332, height: 506, inset: .18, outlinedWallpaper: true, footer, gradientFooter };
    const frontier = fingerprint(chatFrame(0, options)); let previous = frontier, shift = 0;
    for (const offset of [21, 128, 200, 258]) {
      const current = fingerprint(chatFrame(offset, options)), result = detectShift(frontier, current, { previous, shift });
      assert.notEqual(result.kind, 'forward', JSON.stringify({ footer, gradientFooter, offset, result }));
      if (result.foreground && Number.isInteger(result.shift)) { previous = current; shift = result.shift; }
    }
  }
});
test('去掉留边误判时，低对比度柔和底栏也不能漏成新增内容', () => {
  for (const gradientRange of [16, 20, 32]) {
    const options = { width: 332, height: 506, inset: .18, outlinedWallpaper: true,
      footer: 200, gradientFooter: true, softFooter: true, gradientRange };
    const frontier = fingerprint(chatFrame(0, options)); let previous = frontier, shift = 0;
    for (const offset of [17, 34, 51, 128, 200, 258]) {
      const current = fingerprint(chatFrame(offset, options)), result = detectShift(frontier, current, { previous, shift });
      assert.notEqual(result.kind, 'forward', JSON.stringify({ gradientRange, offset, result }));
      if (result.foreground && Number.isInteger(result.shift)) { previous = current; shift = result.shift; }
    }
  }
});
test('平坦壁纸末端加窄竖纹饰不能借46列空白冒充宽固定栏', () => {
  const options = { width: 332, height: 506, inset: .18, outlinedWallpaper: true, emptyWallpaperTail: 32 };
  let frontier = fingerprint(chatFrame(0, options)), accepted = 0;
  const history = [{ frame: frontier, position: 0 }];
  for (const offset of [17, 34, 51, 128, 200, 258, 300, 332, 390, 451, 500, 597, 683]) {
    const previous = history.findLast(item => item.position !== accepted), current = fingerprint(chatFrame(offset, options));
    const result = detectShift(frontier, current, previous && { previous: previous.frame, shift: previous.position - accepted });
    if (result.foreground && Number.isInteger(result.shift)) {
      history.push({ frame: current, position: accepted + result.shift }); if (history.length > 2) history.shift();
    }
    if (result.kind === 'forward') { assert.equal(result.shift, offset - accepted); frontier = current; accepted = offset; }
  }
  assert.equal(accepted, 683);
});
test('连续宽剖面的历史确认必须覆盖16行，只有末行重合不能冒充整段固定', () => {
  const options = { inset: .18, outlinedWallpaper: true }, a = chatFrame(0, options), b = chatFrame(17, options), previous = chatFrame(34, options);
  for (const image of [a, b]) for (let y = image.height - 32; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const i = (y * image.width + x) * 4, value = 110 + 16 * x / image.width;
    image.data[i] = image.data[i + 1] = image.data[i + 2] = value;
  }
  const start = (a.height - 1) * a.width * 4;
  previous.data.set(b.data.subarray(start), start);
  const seed = fingerprint(a), current = fingerprint(b);
  const pending = detectShift(seed, current); assert.equal(pending.kind, 'fixed'); assert.equal(pending.pending, true);
  const result = detectShift(seed, current, { previous: fingerprint(previous), shift: 34 });
  assert.equal(result.kind, 'forward'); assert.equal(result.shift, 17);
});
test('固定侧栏不因有移动消息就直接当成背景放行', () => {
  const a = fingerprint(chatFrame(0, { sidebar: true }));
  for (const offset of [42, 98, 167]) assert.notEqual(detectShift(a, fingerprint(chatFrame(offset, { sidebar: true }))).kind, 'forward');
});
test('固定背景：停住不增高，反向不改前沿，超过旧前沿才追加', () => {
  const first = fingerprint(chatFrame(199));
  assert.equal(detectShift(first, fingerprint(chatFrame(199))).kind, 'still');
  const back = detectShift(first, fingerprint(chatFrame(100)));
  assert.equal(back.kind, 'reverse'); assert.equal(back.shift, -99);
  const next = detectShift(first, fingerprint(chatFrame(286)), { previous: fingerprint(chatFrame(100)), shift: -99 });
  assert.equal(next.kind, 'forward'); assert.equal(next.shift, 87);
});
