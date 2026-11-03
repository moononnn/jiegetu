'use strict';
// 批注（编号点/框）、原位气泡与单张 PNG 复制出口的定向测试。
// 用 test/fixtures/editor-dom.cjs 提供的最小 DOM 跑真实的 renderer/image-editor.js 与 annotations.js，
// 不走真实画布像素（也不采桌面），坐标/尺寸/scroll 全由夹具显式给定。
// 真实 Chromium 的命中测试与真实输入在 experiments/annotation-popover-check.cjs 里另验。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createEditorDom, HTMLElement } = require('./fixtures/editor-dom.cjs');

const ROOT = path.join(__dirname, '..');
const SOURCE_URL = 'data:image/png;base64,SOURCE-SECRET-BASE64';

function loadScripts(window, document, dom) {
  const sandbox = { window, document, HTMLElement, Image: dom.Image, createImageBitmap: dom.createImageBitmap,
    ResizeObserver: dom.ResizeObserver, requestAnimationFrame: dom.requestAnimationFrame,
    cancelAnimationFrame: dom.cancelAnimationFrame, setTimeout, clearTimeout, queueMicrotask, console };
  vm.createContext(sandbox);
  // 与 selection.html 相同的加载顺序：annotations.js 先，image-editor.js 后。
  for (const file of ['annotations.js', 'image-editor.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'renderer', file), 'utf8'), sandbox, { filename: file });
  }
  return sandbox;
}

function harness({ width = 400, height = 300, token = 'doc-1', dom: domOptions, recognizeText, animation = false } = {}) {
  const dom = createEditorDom(domOptions);
  const window = dom.window;
  loadScripts(window, dom.document, dom);
  dom.document.images.set(SOURCE_URL, { width, height });
  const calls = { feedback: 0, commit: [], close: 0, ocr: [] };
  const root = dom.root;
  const editor = window.createImageEditor({ root, animation,
    recognizeText: recognizeText ? payload => { calls.ocr.push(payload); return recognizeText(payload); } : undefined,
    onCommit: action => calls.commit.push(action),
    onClose: () => { calls.close += 1; },
    onFeedback: () => { calls.feedback += 1; } });
  dom.attachBoxes();
  const q = selector => root.querySelector(selector);
  const qa = selector => root.querySelectorAll(selector);
  const emit = (node, type, event = {}) => node.emit(type, event);
  const key = (target, values) => {
    const flags = { defaultPrevented: false, stopped: false };
    window.emit('keydown', { key: values.key, target, ctrlKey: Boolean(values.ctrlKey), shiftKey: Boolean(values.shiftKey),
      metaKey: Boolean(values.metaKey), isComposing: Boolean(values.isComposing), keyCode: values.keyCode,
      preventDefault() { flags.defaultPrevented = true; }, stopImmediatePropagation() { flags.stopped = true; } });
    return flags;
  };
  const pointerEvent = (type, x, y) => ({ clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0,
    buttons: type === 'pointerup' ? 0 : 1, preventDefault() {}, getCoalescedEvents: () => [] });
  const drag = (from, to) => {
    const scroller = q('.ie-scroll');
    emit(scroller, 'pointerdown', pointerEvent('pointerdown', from.x, from.y));
    if (to) emit(scroller, 'pointermove', pointerEvent('pointermove', to.x, to.y));
    emit(scroller, 'pointerup', pointerEvent('pointerup', to ? to.x : from.x, to ? to.y : from.y));
  };
  const click = node => { root.emit('click', { target: node }); };
  const tool = id => click(q(`[data-tool="${id}"]`));
  const open = async (next = {}) => {
    await editor.open({ token: next.token ?? token, dataUrl: SOURCE_URL, width: next.width ?? width, height: next.height ?? height });
    dom.flushFrames();
  };
  const bubble = () => q('.ie-note-bubble');
  const field = () => q('.ie-bubble-text');
  const type = value => {
    const node = field();
    node.value = value;
    root.emit('input', { target: node });
  };
  const save = () => click(q('[data-action="bubble-save"]'));
  const cancelBubble = () => click(q('[data-action="bubble-cancel"]'));
  const comment = () => q('.ie-comment');
  const typeComment = value => {
    const node = comment();
    node.value = value;
    root.emit('input', { target: node });
  };
  const markers = () => qa('.ie-marker').map(node => {
    const figure = node.closest('.ie-marker-figure');
    const ring = figure ? figure.querySelector('.ie-marker-ring') : null;
    const leader = figure ? figure.querySelector('.ie-marker-leader') : null;
    const px = value => Number(String(value).replace('px', ''));
    return { id: node.dataset.annotationId,
      draft: node.dataset.draft === 'true', label: node.getAttribute('aria-label') || '', title: node.title || '',
      text: node.textContent, size: px(node.style.width), fontSize: node.style.fontSize,
      left: px(node.style.left), top: px(node.style.top),
      // 落点：只有一个小空心圈，圈心就是真实坐标在屏幕上的位置。
      ringSize: ring ? px(ring.style.width) : 0,
      ringLeft: ring ? px(ring.style.left) : 0,
      ringTop: ring ? px(ring.style.top) : 0,
      // 引线：从圈外沿连到编号外沿，角度就是指向编号的角度。
      leader: leader ? { left: px(leader.style.left), top: px(leader.style.top), width: px(leader.style.width),
        hidden: leader.hidden,
        angle: Number(/rotate\(([-\d.]+)deg\)/.exec(leader.style.transform || '')?.[1] ?? 0) } : null };
  });
  const numbers = () => markers().filter(item => !item.draft)
    .map(item => Number(/第 (\d+) 条/.exec(item.label)?.[1]));
  // 复制出口是唯一的批注交付路径：说明区就是单张 PNG 下半部，按行读回来验内容。
  // 行宽是固定模型，软换行会插 \n，所以这里只承诺编号/主几何/文字内容可读；
  // 文本原样性（前后空格、超长、刚体换行）由 Annotations.prepare 的模型测试把关。
  const NOTE_HEAD = /^第 (\d+) 条 · (点|框) \(([^)]*)\)：([\s\S]*)$/;
  const PANEL_HEADERS = /^(【截图批注说明】|图像尺寸：|坐标原点|上方截图不含|局部放大 ·)/;
  const parsePanel = lines => {
    const annotations = [], commentLines = [];
    let current = null, inComment = false;
    for (const line of lines) {
      const head = NOTE_HEAD.exec(line);
      if (head) {
        const parts = head[3].split(',').map(value => Number(value.trim()));
        current = { number: Number(head[1]), kind: head[2] === '点' ? 'point' : 'region',
          ...(head[2] === '点' ? { point: { x: parts[0], y: parts[1] } }
            : { rect: { x: parts[0], y: parts[1], width: parts[2], height: parts[3] } }),
          text: head[4] };
        annotations.push(current); inComment = false; continue;
      }
      if (line.startsWith('总体说明：')) { inComment = true; commentLines.push(line.slice('总体说明：'.length)); current = null; continue; }
      if (PANEL_HEADERS.test(line)) { current = null; inComment = false; continue; }
      if (inComment) commentLines.push(line);
      else if (current) current.text += `\n${line}`;
    }
    // 编号在说明区里是唯一的身份线索；id 取同序标记上的 data-annotation-id（只给“点开哪一条”用）。
    const ids = [...new Set(markers().map(item => item.id))];
    annotations.forEach((note, index) => { note.id = ids[index] ?? null; });
    return { annotations, comment: commentLines.join('\n') };
  };
  // 一次复制 = 一张 PNG：png 是最终成图，lines 是下半部说明区实际画上去的字。
  const copy = async () => {
    const before = dom.canvases.length;
    const raw = await editor.exportClipboard();
    // png 是另一个 realm 的 Uint8Array：显式落成本 realm 的数组，签名字节才读得到。
    const result = { ...plain({ ...raw, png: null }), png: Array.from(raw.png) };
    const canvas = dom.canvases[before] || null;
    const lines = canvas ? canvas.context.calls.filter(call => call.name === 'fillText').map(call => String(call.args[0])) : [];
    return { result, canvas, lines, ...parsePanel(lines) };
  };
  // 没有可交付内容时（或导出被拒）返回空数组，与旧出口行为一致。
  const notes = async () => {
    try { return (await copy()).annotations; } catch { return []; }
  };
  // 画布当前一帧的变换：标记必须和它用同一套坐标（不靠测试里重算 origin）。
  const displayTransform = () => {
    const calls = q('.ie-display').context.calls;
    for (let index = calls.length - 1; index >= 0; index -= 1) if (calls[index].name === 'setTransform') return calls[index].args;
    return null;
  };
  return { dom, window, root, editor, calls, q, qa, emit, key, drag, click, tool, open,
    bubble, field, type, save, cancelBubble, comment, typeComment, markers, numbers, notes, copy, displayTransform,
    // 可选字段/关系的事件入口：select 与 checkbox 走真实 change，文本走 input。
    change: (node, value) => { if (value !== undefined) node.value = value; root.emit('change', { target: node }); },
    input: (node, value) => { node.value = value; root.emit('input', { target: node }); },
    tick: () => new Promise(resolve => setImmediate(resolve)) };
}

const PIXEL_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
const isPng = bytes => Boolean(bytes) && bytes.length >= 8 && PIXEL_SIGNATURE.every((value, index) => bytes[index] === value);
const json = value => JSON.stringify(value);
// 编辑器与批注模型跑在另一个 realm：比较前先落成本 realm 的普通数据。
const plain = value => JSON.parse(JSON.stringify(value));
const ZOOM = 0.92;                    // 400 宽的图在 400 宽的视口里：min(1,(400-32)/400)
const ORIGIN = 16;                    // 画布固定 16px 留白
const at = (x, y) => ({ x: ORIGIN + x * ZOOM, y: ORIGIN + y * ZOOM });
// 任何图片导出口都不该带批注浮层：裸数字（编号）、编号/空心圈的 arc、区域边框的 strokeRect。
// 马赛克胶囊也用 arc，所以带马赛克的场景要给出笔刷半径；成图里的笔迹矩形用 fillRect/strokeRect。
const annotationMarks = (calls, { brushRadius = null, rectStroke = true } = {}) => calls.filter(call => {
  if (call.name === 'fillText' && /^\d+$/.test(String(call.args[0]))) return true;
  if (rectStroke && call.name === 'strokeRect') return true;
  if (call.name === 'arc' && (brushRadius === null || call.args[2] !== brushRadius)) return true;
  return false;
});
// 导出的 clip 矩形用源坐标写，必须经过 ctx.translate/scale 后才刚好盖住整张输出（左上 = 0,0）。
// 按 canvas 变换组合算：先 translate 再 scale 时点映射为 (p + t) × s。
const clipDevice = calls => {
  // 取 compose 自己那个 rect（在 translate 之后）：导出外层可能还有别的矩形（复制画布铺白）。
  const translateAt = calls.findIndex(call => call.name === 'translate');
  const tail = translateAt >= 0 ? calls.slice(translateAt) : calls;
  const rect = tail.find(call => call.name === 'rect') || calls.find(call => call.name === 'rect');
  const translate = translateAt >= 0 ? calls[translateAt] : null;
  const scale = calls.find(call => call.name === 'scale');
  const [tx, ty] = translate ? translate.args : [0, 0];
  const [sx, sy] = scale ? scale.args : [1, 1];
  return { x: (rect.args[0] + tx) * sx, y: (rect.args[1] + ty) * sy,
    width: rect.args[2] * sx, height: rect.args[3] * sy };
};

test('独立编辑页按顺序加载批注模型与编辑器；选区页不再装编辑器', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer/image-editor-window.html'), 'utf8');
  const annotationsAt = html.indexOf('annotations.js');
  const editorAt = html.indexOf('image-editor.js');
  assert.ok(annotationsAt > -1 && editorAt > -1 && annotationsAt < editorAt, 'annotations.js 必须先于 image-editor.js 加载');
  assert.equal(html.includes('feedback.js'), false, '旧的反馈模型脚本不在页面里');
  assert.match(html, /href="image-editor\.css"/, '样式仍由编辑页加载');
  const selectionHtml = fs.readFileSync(path.join(ROOT, 'renderer/selection.html'), 'utf8');
  assert.equal(selectionHtml.includes('image-editor.js'), false, '选区页不再自己创建编辑器');
  assert.equal(selectionHtml.includes('editor-root'), false, '选区页不再留编辑器根节点');
  const editorCss = fs.readFileSync(path.join(ROOT, 'renderer/image-editor.css'), 'utf8');
  const ruleOf = selector => editorCss.match(new RegExp(`\\.image-editor \\.${selector}\\{[^}]*\\}`))?.[0] || '';
  // 停靠：工具条与缩放控件回到普通文档流，不再浮在画布上盖住图片/挡鼠标。
  assert.doesNotMatch(ruleOf('ie-toolbar'), /position:absolute|z-index/, '绘图工具不能是浮动层');
  assert.doesNotMatch(ruleOf('ie-view-actions'), /position:absolute|z-index|box-shadow/, '缩放控件不能是浮动卡片');
  assert.doesNotMatch(editorCss, /\.ie-grip/, '拖拽把手样工已移除');
  assert.match(editorCss, /grid-template-rows:auto auto auto minmax\(0,1fr\) auto/, '五行：header/工具条/警告/画布/底栏');
  assert.match(ruleOf('ie-toolbar'), /grid-row:2/, '工具条独占一行');
  assert.match(ruleOf('ie-toolbar'), /max-height:[^;]+;/, '工具区要有受控上限');
  assert.match(ruleOf('ie-toolbar'), /overflow:auto/, '超出时可滚动，不把画布挤为 0');
  assert.match(ruleOf('ie-main'), /grid-row:4/, '画布+右栏占剩下的一行');
  assert.match(ruleOf('ie-main'), /grid-template-columns:minmax\(0,1fr\) auto/, '右栏自己占一列，收起时列自动消失');
  assert.match(ruleOf('ie-panel'), /width:clamp\(/, '右栏宽度有上下限，窄窗也给画布留位置');  assert.match(ruleOf('ie-panel'), /overflow:auto/, '面板自己可滚');
  assert.match(ruleOf('ie-workspace'), /position:relative/, '画布容器仍是定位参考，但不再装浮层');

  const h = harness();
  assert.equal(h.q('[data-tool="point"]').textContent, '点批注');
  assert.equal(h.q('[data-tool="region"]').textContent, '框批注');
  assert.equal(h.q('[data-action="comment"]').textContent, '补充说明');
  assert.equal(h.q('[data-action="save"]').textContent, '保存', '保存 = 存到设置好的文件夹');
  assert.equal(h.q('[data-action="save-as"]').textContent, '另存…', '另存走新的 save 动作');
  assert.equal(h.q('[data-action="bubble-save"]').textContent, '完成批注');
  assert.equal(h.q('[data-action="feedback"]'), null, '外传按钮已从页头撤掉');
  assert.equal(h.q('[data-action="copy"]').textContent, '复制图片', '复制是唯一的出口，且是主按钮');
  assert.match(h.q('[data-action="copy"]').getAttribute('title'), /粘贴到其他应用/, '复制要把「复制后自己粘到别处」说清楚');
  assert.equal(h.q('.ie-feedback'), null, '右侧独立意见栏不能还在');
  assert.equal(h.q('[data-action="feedback-panel"]'), null, '折叠侧栏的按钮也不该还在');
  assert.ok(h.q('.ie-marker-layer'), '标记需要一个真实 DOM 层');
  assert.equal(h.bubble().hidden, true, '批注面板默认收起');
  assert.equal(h.q('.ie-panel').hidden, true, '右栏只在编辑时展开');
  assert.equal(h.q('.ie-comment-bubble').hidden, true, '补充说明默认收起');
  assert.equal(h.q('.ie-help').hidden, true, '帮助默认收起');
});

test('批注：单击不移动也立刻落草稿标记并在该点旁边弹气泡，保存后标记留下', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(100, 80));
  // 点下去就有：草稿标记 + 原位气泡 + 聚焦到这一条的 textarea。
  assert.equal(h.markers().length, 1);
  assert.equal(h.markers()[0].draft, true, '新点先是草稿标记');
  assert.equal(h.bubble().hidden, false);
  assert.equal(h.q('.ie-bubble-title').textContent, '第 1 条批注');
  assert.equal(h.dom.document.activeElement, h.field(), '自动聚焦这条的意见框');
  assert.equal(h.editor.hasEdits, false, '保存前不进 ops');
  // 落点只留小空心圈（圈心 = 真实坐标的屏幕位置），实心编号偏在一边，不盖住落点。
  const draft = h.markers()[0];
  const ringX = draft.ringLeft + draft.ringSize / 2, ringY = draft.ringTop + draft.ringSize / 2;
  const badgeX = draft.left + draft.size / 2, badgeY = draft.top + draft.size / 2;
  assert.ok(Math.abs(ringX - (at(100, 80).x)) <= 1, `空心圈要落在点的屏幕上：${ringX}`);
  assert.ok(Math.abs(ringY - (at(100, 80).y)) <= 1, `空心圈要落在点的屏幕上：${ringY}`);
  assert.ok(Math.hypot(badgeX - ringX, badgeY - ringY) > draft.size / 2 + draft.ringSize / 2,
    `编号不能盖住自己的落点：${json({ badgeX, badgeY, ringX, ringY })}`);
  assert.ok(draft.leader && draft.leader.width > 0, '落点和编号之间要有引线');
  // 表单在右栏，不再靠画布坐标避让：面板展开、画布保持自己的宽度。
  assert.equal(h.q('.ie-panel').hidden, false, '右栏展开');
  assert.equal(h.q('.ie-workspace').classList.contains('ie-markers-live'), true, '画布照旧接标记点击');

  h.type('这里字太小');
  h.save();
  assert.equal(h.bubble().hidden, true, '保存后气泡关掉');
  assert.equal(h.editor.hasEdits, true, '保存才进 ops');
  assert.deepEqual(h.markers().map(item => item.draft), [false], '草稿变成正式标记');
  assert.deepEqual(h.numbers(), [1]);
  const notes = await h.notes();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].text, '这里字太小');
  assert.equal(notes[0].kind, 'point');
});

test('连续两点：各自保存后编号 1、2，第二条不影响第一条', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(60, 60));
  h.type('第一条');
  h.save();
  h.drag(at(200, 140));
  assert.equal(h.markers().filter(item => item.draft).length, 1, '第二点先显示为草稿');
  assert.equal(h.q('.ie-bubble-title').textContent, '第 2 条批注');
  h.type('第二条');
  h.save();
  assert.deepEqual(h.numbers(), [1, 2]);
  const notes = await h.notes();
  assert.deepEqual(notes.map(item => item.text), ['第一条', '第二条']);
  assert.ok(Math.abs(notes[0].point.x - 60) < 2 && Math.abs(notes[1].point.x - 200) < 2, `坐标要分开：${json(notes)}`);
});

test('框批注仍可拖框（太小不建），用的是同一个原位气泡', async () => {
  const h = harness();
  await h.open();
  h.tool('region');
  h.drag(at(200, 160), at(120, 60));
  assert.equal(h.markers().length, 1, '反向拖框也要出草稿');
  assert.equal(h.bubble().hidden, false, '框批注用同一个气泡');
  h.type('这块被裁掉了');
  h.save();
  h.tool('region');
  h.drag(at(10, 10), at(10.5, 10.5));
  assert.equal(h.markers().length, 1, '过小的框不建批注');
  assert.match(h.q('.ie-status').textContent, /框太小/);

  // 贴到右/下边：x + width 必须在浮点上也严格不越界（数据模型与 core 都是严格比较）。
  h.drag(at(0.1, 240), at(400, 300));
  h.type('贴边框');
  h.save();
  const edge = (await h.notes())[1].rect;
  assert.ok(edge.x + edge.width <= 400, `贴边矩形不能越界：${json(edge)}`);
  assert.ok(edge.y + edge.height <= 300, `贴边矩形不能越界：${json(edge)}`);
});

test('取消新点：草稿和空条目都不留；空白保存被明确拒绝', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(80, 80));
  h.type('写了一半不要了');
  h.cancelBubble();
  assert.equal(h.bubble().hidden, true, '取消后气泡关掉');
  assert.equal(h.markers().length, 0, '取消不留空标记');
  assert.equal(h.editor.hasEdits, false, '取消不进 ops');
  const empty = await h.editor.exportClipboard();
  assert.ok(isPng(empty.png), '没有批注时复制仍是一张普通成图');
  assert.equal('clipboardSize' in empty, false, '没有批注就不加说明区');

  // 空白保存：明确提示，气泡保持打开，不产生空条目。
  h.drag(at(120, 120));
  h.save();
  assert.equal(h.bubble().hidden, false, '空文本保存被拒绝，气泡还在');
  assert.match(h.q('.ie-status').textContent, /先写一句再保存/);
  assert.equal(h.markers().length, 1);
  assert.equal(h.markers()[0].draft, true);
  h.type('   ');
  h.save();
  assert.equal(h.bubble().hidden, false, '只有空格也算没写');
  assert.equal(h.editor.hasEdits, false);
  h.cancelBubble();
  assert.equal(h.markers().length, 0);
});

test('点旧标记重开编辑：保存改文、取消保留原文、删除重排、撤销恢复', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(60, 60));
  h.type('甲');
  h.save();
  h.drag(at(140, 60));
  h.type('乙');
  h.save();
  h.drag(at(220, 60));
  h.type('丙');
  h.save();
  assert.deepEqual(h.numbers(), [1, 2, 3]);
  const [first, second] = await h.notes();

  // 点标记 → 重开这一条（文字是原文），改完保存。
  h.click(h.q(`.ie-marker[data-annotation-id="${first.id}"]`));
  assert.equal(h.bubble().hidden, false);
  assert.equal(h.field().value, '甲', '重开时带出原文');
  assert.equal(h.q('.ie-bubble-title').textContent, '第 1 条批注');
  h.type('甲改过了');
  h.save();
  assert.equal((await h.notes())[0].text, '甲改过了');
  assert.match(h.markers()[0].title, /甲改过了/, '改完保存后旧标记的 title 必须是新文字');

  // 再重开、改字、取消：原文保留。
  h.click(h.q(`.ie-marker[data-annotation-id="${first.id}"]`));
  h.type('这次不要了');
  h.cancelBubble();
  assert.deepEqual((await h.notes()).map(note => note.text), ['甲改过了', '乙', '丙'], '取消修改旧点要保留原文');

  // 删除第二条：编号立刻连续，撤销能恢复（含文字）。
  h.click(h.q(`.ie-marker[data-annotation-id="${second.id}"]`));
  h.click(h.q('[data-action="bubble-delete"]'));
  assert.deepEqual(h.numbers(), [1, 2]);
  assert.deepEqual((await h.notes()).map(note => note.text), ['甲改过了', '丙']);
  h.key(h.q('.ie-scroll'), { key: 'z', ctrlKey: true });
  assert.deepEqual((await h.notes()).map(note => note.text), ['甲改过了', '乙', '丙'], '撤销删除要连文字一起恢复');
  assert.equal(h.bubble().hidden, true, '撤销后气泡仍是收起的');
  assert.deepEqual(h.numbers(), [1, 2, 3], '撤销删除后标记和编号都回来了');

  // 再撤销一次撤掉第三条批注本身，重做恢复。
  h.key(h.q('.ie-scroll'), { key: 'z', ctrlKey: true });
  assert.deepEqual((await h.notes()).map(note => note.text), ['甲改过了', '乙']);
  h.key(h.q('.ie-scroll'), { key: 'y', ctrlKey: true });
  assert.deepEqual((await h.notes()).map(note => note.text), ['甲改过了', '乙', '丙']);
});

test('撤销把正在编辑的那条拿走时，气泡不会挂在已不存在的批注上', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(80, 80));
  h.type('会被撤销');
  h.save();
  const [note] = await h.notes();
  h.click(h.q(`.ie-marker[data-annotation-id="${note.id}"]`));
  assert.equal(h.bubble().hidden, false);
  h.key(h.q('.ie-scroll'), { key: 'z', ctrlKey: true });
  assert.equal(h.bubble().hidden, true, '批注被撤销后气泡必须收起');
  assert.equal(h.editor.hasEdits, false);
});

test('Esc 优先取消气泡：草稿丢掉、编辑器不关；再按一次才关编辑器', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(80, 80));
  h.type('还在写');
  const escape = h.key(h.field(), { key: 'Escape' });
  assert.equal(escape.defaultPrevented, true, 'Esc 仍要拦下');
  assert.equal(h.bubble().hidden, true, 'Esc 先取消气泡');
  assert.equal(h.editor.isOpen, true, 'Esc 不能连编辑器一起关掉');
  assert.equal(h.calls.close, 0);
  assert.equal(h.markers().length, 0, 'Esc 取消的草稿不留标记');
  assert.equal(h.editor.hasEdits, false);

  // 焦点不在输入框时，Esc 也是先取消气泡。
  h.drag(at(120, 120));
  h.type('再写一条');
  h.key(h.q('[data-action="bubble-save"]'), { key: 'Escape' });
  assert.equal(h.bubble().hidden, true);
  assert.equal(h.editor.isOpen, true);

  // 没有气泡时 Esc 才关编辑器。
  h.key(h.q('.ie-scroll'), { key: 'Escape' });
  assert.equal(h.calls.close, 1);
  assert.equal(h.editor.isOpen, false);
});

test('输入不被画布快捷键吞：Enter/空格/方向键/Ctrl+Z 留给输入框，Ctrl+Enter 保存，输入法不误判', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(80, 80));
  h.type('草稿');
  const node = h.field();
  for (const values of [{ key: 'Enter' }, { key: ' ' }, { key: 'ArrowLeft' }, { key: 'ArrowDown' }, { key: 'z', ctrlKey: true }]) {
    const flags = h.key(node, values);
    assert.equal(flags.defaultPrevented, false, `${values.key} 在输入框里不能被 preventDefault`);
  }
  assert.equal(h.bubble().hidden, false, 'Ctrl+Z 在输入框里不能触发画布撤销');
  assert.equal(h.editor.hasEdits, false);
  assert.equal(h.editor.isOpen, true, '输入时 Enter 不能关掉编辑器');

  // 输入法组合中：Esc 是取消候选，不能当成取消气泡。
  const composing = h.key(node, { key: 'Escape', isComposing: true });
  assert.equal(composing.defaultPrevented, false, '输入法组合中的 Esc 不能被吞');
  assert.equal(h.bubble().hidden, false, '输入法组合中不能取消气泡');
  assert.equal(h.key(node, { key: 'Enter', isComposing: true }).defaultPrevented, false, '上屏的 Enter 不能被吞');

  // Ctrl+Enter 保存。
  const ctrlEnter = h.key(node, { key: 'Enter', ctrlKey: true });
  assert.equal(ctrlEnter.defaultPrevented, true);
  assert.equal(h.bubble().hidden, true, 'Ctrl+Enter 保存并收起气泡');
  assert.equal(h.editor.hasEdits, true);
  assert.deepEqual((await h.notes()).map(note => note.text), ['草稿']);
});

test('复制把开着的气泡按保存处理，不丢字；外传路由整套不存在', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(80, 80));
  h.type('还没保存');

  // 外传路由全删：开着的气泡只会在导出前被存进这一条。
  assert.equal(h.q('.ie-status').textContent, '', '还没导出时不提前报警');
  assert.equal(h.q('[data-action="feedback"]'), null, '编辑器里没有外传按钮');
  assert.equal(h.calls.feedback, 0, '任何操作都不能触发 onFeedback');
  assert.equal('exportFeedback' in h.editor, false, '不再提供反馈包导出 API');
  assert.equal(h.calls.close, 0);

  // 复制：先自动把文字存进这一条，成图里也带着编号。
  const copied = await h.editor.exportClipboard();
  assert.ok(isPng(copied.png));
  assert.equal(h.editor.hasEdits, true, '导出前自动保存，不丢字');
  assert.deepEqual((await h.notes()).map(note => note.text), ['还没保存']);
  assert.equal(h.calls.commit.length, 0, 'exportPNG 不自己调 onCommit');

  // 宿主真实时序：commit() 先 setBusy(true) 再 exportPNG()，这条路径也不能丢字。
  h.drag(at(160, 160));
  h.type('忙时保存的那条');
  h.editor.setBusy(true);
  assert.ok(isPng(await h.editor.exportPNG()), '忙碌锁不是导出锁');
  h.editor.setBusy(false);
  assert.deepEqual((await h.notes()).map(note => note.text), ['还没保存', '忙时保存的那条'], 'setBusy 期间导出的气泡文字也要存下');
  assert.deepEqual(h.numbers(), [1, 2]);

  // 只打开看看、没改字，不影响导出；改过文字就存进这一条。
  h.click(h.q(`.ie-marker[data-annotation-id="${(await h.notes())[0].id}"]`));
  assert.equal(h.bubble().hidden, false);
  // 没改字时导出原样（导出会把气泡收起，改字前要重新点开）。
  const unchanged = await h.copy();
  assert.deepEqual(unchanged.annotations.map(item => item.text), ['还没保存', '忙时保存的那条'], '没改字的旧批注照常导出');
  h.click(h.q(`.ie-marker[data-annotation-id="${(await h.notes())[0].id}"]`));
  assert.equal(h.bubble().hidden, false);
  h.type('改成别的');
  assert.ok(isPng((await h.copy()).result.png), '改过的文字先存进这一条再导出');
  assert.deepEqual((await h.notes()).map(item => item.text), ['改成别的', '忙时保存的那条'], '导出带上新文字');
  // 清空再导出：不能悄悄存成空条目，也不静默丢字。
  h.click(h.q(`.ie-marker[data-annotation-id="${(await h.notes())[0].id}"]`));
  h.type('   ');
  await assert.rejects(h.editor.exportClipboard(), /先写一句|还没保存|取消/, '清空的批注不能存成空条目');
  h.save();
  assert.equal(h.bubble().hidden, false, '空白保存被拒，气泡还开着');
  h.cancelBubble();
  assert.deepEqual((await h.notes()).map(item => item.text), ['改成别的', '忙时保存的那条'], '取消保留原文');
  assert.ok(isPng(await h.editor.exportPNG()));

  // 空白新点不拦导出，也不留空条目。
  h.tool('point');
  h.drag(at(200, 200));
  assert.ok(isPng(await h.editor.exportPNG()));
  assert.deepEqual(h.numbers(), [1, 2]);
  assert.equal(h.bubble().hidden, true);
});

test('zoom / scroll 之后标记与气泡跟着同一帧的画布变换重算，且始终留在画布区内', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(100, 100));
  h.type('第一条');
  h.save();
  const before = h.markers()[0];
  const transformBefore = h.displayTransform();
  const ringCenter = item => ({ x: item.ringLeft + item.ringSize / 2, y: item.ringTop + item.ringSize / 2 });
  const beforeRing = ringCenter(before);
  assert.ok(Math.abs(beforeRing.x - (transformBefore[4] + 100 * transformBefore[0])) <= 1.5,
    `空心圈和画布用同一个变换：${json({ marker: beforeRing, transform: transformBefore })}`);
  assert.ok(Math.abs(beforeRing.y - (transformBefore[5] + 100 * transformBefore[3])) <= 1.5);
  // 编号仍是偏在旁边、靠引线连回落点。
  const leaderStartGap = Math.hypot(before.leader.left - beforeRing.x, before.leader.top - beforeRing.y);
  assert.ok(Math.abs(leaderStartGap - before.ringSize / 2) <= 1.5, `引线从圈外沿出发：${leaderStartGap}`);
  assert.ok(before.leader.width > 0);
  const beforeOffset = Math.hypot(before.left + before.size / 2 - beforeRing.x, before.top + before.size / 2 - beforeRing.y);
  assert.ok(beforeOffset > before.size / 2 + before.ringSize / 2, '编号必须避让自己的落点');

  h.click(h.q('[data-action="zoom-in"]'));
  h.dom.flushFrames();
  const after = h.markers()[0];
  const afterRing = ringCenter(after);
  const transformAfter = h.displayTransform();
  assert.ok(transformAfter[0] > transformBefore[0], '放大后画布变换比例要变大');
  assert.ok(Math.abs(afterRing.x - (transformAfter[4] + 100 * transformAfter[0])) <= 1.5,
    `放大后空心圈仍贴合同一点：${json({ marker: afterRing, transform: transformAfter })}`);
  assert.ok(after.size >= 22 && before.size >= 22, '编号在屏幕上一律不少于 22 CSS px');
  assert.equal(after.text, '1', 'DOM 标记自带可读编号');
  assert.ok(after.ringSize < before.ringSize * 1.5, '空心圈跟着实际缩放走，不抢编号的位置');

  // 滚动 40/30：标记跟着画布一起走；右栏表单不参与画布坐标，位置不变。
  const scroller = h.q('.ie-scroll');
  h.click(h.q(`.ie-marker[data-annotation-id="${h.markers()[0].id}"]`));
  const panelBefore = { left: h.q('.ie-panel').style.left, top: h.q('.ie-panel').style.top };
  const scrollBefore = [scroller.scrollLeft, scroller.scrollTop];
  scroller.scrollLeft = scrollBefore[0] + 40; scroller.scrollTop = scrollBefore[1] + 30;
  h.emit(scroller, 'scroll');
  h.dom.flushFrames();
  const scrolled = h.markers()[0];
  const transformScrolled = h.displayTransform();
  assert.ok(Math.abs((scrolled.ringLeft - after.ringLeft) + 40) < 2, `右滚 40 后空心圈左移 40：${scrolled.ringLeft - after.ringLeft}`);
  assert.ok(Math.abs((scrolled.ringTop - after.ringTop) + 30) < 2, `下滚 30 后空心圈上移 30：${scrolled.ringTop - after.ringTop}`);
  assert.ok(Math.abs((scrolled.left - after.left) + 40) < 2, '编号跟着画布一起平移');
  assert.ok(Math.abs(ringCenter(scrolled).x - (transformScrolled[4] + 100 * transformScrolled[0])) <= 1.5);
  assert.ok(Math.abs((scrolled.left + scrolled.size / 2 - ringCenter(scrolled).x) - (after.left + after.size / 2 - ringCenter(after).x)) < 2,
    '滚动不改变编号相对落点的偏移');
  assert.deepEqual({ left: h.q('.ie-panel').style.left, top: h.q('.ie-panel').style.top }, panelBefore,
    '右栏不跟画布滚动（不再按画布坐标定位）');
});

test('point 用对话气泡光标，热点在气泡尾巴尖端；region 用同套定位点 + 空心框', async () => {
  const h = harness();
  await h.open();
  const scroller = h.q('.ie-scroll');
  const hover = (x, y) => {
    h.emit(scroller, 'pointermove', { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', buttons: 1 });
    return scroller.style.cursor;
  };
  h.tool('point');
  const pointCursor = hover(at(100, 100).x, at(100, 100).y);
  const match = /^url\("data:image\/svg\+xml,([^"]+)"\) (\d+) (\d+), crosshair$/.exec(pointCursor);
  assert.ok(match, `point 光标必须是自定义 SVG 对话气泡（保留十字回退）：${pointCursor}`);
  const svg = decodeURIComponent(match[1]);
  assert.match(svg, /^<svg /, '光标是真 SVG');
  assert.match(svg, /M13 19 10 29 17 19/, '气泡尾巴的尖端就是热点坐标');
  assert.equal(`${match[2]} ${match[3]}`, '10 29', '热点必须落在尾巴尖端，不能飘在气泡中间');
  assert.ok(Number(match[2]) < 32 && Number(match[3]) < 32, '热点要在 viewBox 内');
  assert.ok(Number(match[2]) > 0 && Number(match[2]) > Number(match[3]) - 24, '热点贴着气泡左下角，不超出图外');

  // 区域批注不再用系统十字：改成同套「定位点 + 空心框」的 SVG（热点 8,8）；point 不会借用它。
  h.tool('region');
  const regionCursor = hover(at(120, 120).x, at(120, 120).y);
  const regionMatch = /^url\("data:image\/svg\+xml,([^"]+)"\) (\d+) (\d+), crosshair$/.exec(regionCursor);
  assert.ok(regionMatch, `region 光标必须是定位点 + 空心框的 SVG（保留十字回退）：${regionCursor}`);
  const regionSvg = decodeURIComponent(regionMatch[1]);
  assert.match(regionSvg, /M8 2V5M8 11V14M2 8H5M11 8H14/, '带 A 方案定位点');
  assert.match(regionSvg, /M18 17H29V28H18Z/, '带空心框');
  assert.equal(`${regionMatch[2]} ${regionMatch[3]}`, '8 8', '热点在定位点');
  assert.notEqual(regionSvg, decodeURIComponent(match[1]), '框批注与点批注不是同一个图标');
  h.tool('point');
  assert.equal(hover(2, 2), 'default', '鼠标出图回到普通指针');
  assert.match(hover(at(120, 120).x, at(120, 120).y), /^url\("data:image\/svg\+xml,/, '回到图上还是气泡光标');
  // 笔类光标没被弄坏。
  h.tool('pen');
  const penCursor = hover(at(120, 120).x, at(120, 120).y);
  assert.match(penCursor, /^url\("data:image\/svg\+xml,/);
  assert.notEqual(penCursor, pointCursor, '批注气泡光标和笔光标不是同一个');
});

test('编号避让：落点只留小空心圈，编号偏到旁边；四角和贴边向内收，坐标元数据不改', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  const clicked = [[0, 0], [399, 0], [0, 299], [399, 299], [200, 150]];
  for (const [x, y] of clicked) {
    h.drag(at(x, y));
    h.type(`点 ${x},${y}`);
    h.save();
  }
  const notes = await h.notes();
  // 坐标元数据仍是点击时的落点（避让只动显示，不动数据）。
  notes.forEach((note, index) => {
    assert.ok(Math.abs(note.point.x - clicked[index][0]) < 1e-6 && Math.abs(note.point.y - clicked[index][1]) < 1e-6,
      `落点坐标不能被避让改掉：${json(note.point)} vs ${json(clicked[index])}`);
  });

  // 屏幕上的编号：整体留在图片显示区内（贴边向内收），并且不盖住自己的落点。
  const rect = { left: at(0, 0).x, top: at(0, 0).y, right: at(400, 300).x, bottom: at(400, 300).y };
  h.markers().forEach((marker, index) => {
    assert.ok(marker.left >= rect.left - 1.5 && marker.left + marker.size <= rect.right + 1.5,
      `编号横向不出图：${json(marker)}`);
    assert.ok(marker.top >= rect.top - 1.5 && marker.top + marker.size <= rect.bottom + 1.5,
      `编号纵向不出图：${json(marker)}`);
    const ringX = marker.ringLeft + marker.ringSize / 2, ringY = marker.ringTop + marker.ringSize / 2;
    assert.ok(Math.abs(ringX - at(clicked[index][0], clicked[index][1]).x) <= 1.5, `空心圈就在落点上：${ringX}`);
    const badgeX = marker.left + marker.size / 2, badgeY = marker.top + marker.size / 2;
    assert.ok(Math.hypot(badgeX - ringX, badgeY - ringY) > marker.size / 2 + marker.ringSize / 2,
      `编号不能盖住自己的落点：${json({ badgeX, badgeY, ringX, ringY })}`);
    assert.ok(marker.leader.width > 0, '要有引线连回落点');
  });

  // 导出的图片里不带任何编号/空心圈/引线：编号只活在编辑器预览浮层。
  const before = h.dom.canvases.length;
  assert.ok(isPng(await h.editor.exportPNG()));
  const calls = h.dom.canvases.slice(before)[0].context.calls;
  assert.deepEqual(annotationMarks(calls), [], '导出图片里不能出现编号/空心圈/徽章');
  assert.equal(calls.some(call => call.name === 'lineTo'), false, '导出图片里不能出现引线');
});

test('低缩放：屏幕 canvas 不画编号、DOM 只叠一个 22px 编号；导出仍是完整一份且坐标不变', async () => {
  // 5760 宽的原图 fit 到 400 宽视口：zoom ≈ 0.064，canvas 里的编号只有 18px 原图像素×缩放，
  // 而 DOM 编号保底 22 CSS px、偏移也按屏幕尺寸重算——两者不能各画一个，否则出现两个编号。
  const h = harness({ width: 5760, height: 1080,
    dom: { workspace: { width: 420, height: 320 }, scroller: { width: 400, height: 300 } } });
  await h.open();
  h.dom.flushFrames();
  // 用画布实际的变换取缩放和原点：缩放控件只显示整数百分比，不能拿来算坐标。
  const transform = h.displayTransform();
  const zoom = transform[0];
  assert.ok(zoom < 0.08, `前提：这是低缩放预览：${zoom}`);
  h.tool('point');
  h.drag({ x: transform[4] + 1000 * zoom, y: transform[5] + 500 * zoom });
  h.type('这里字太小');
  h.save();

  // DOM 只叠一份编号，并且保底 22 CSS px。
  assert.equal(h.qa('.ie-marker').length, 1, 'DOM 只有这一个编号');
  assert.equal(h.qa('.ie-marker-ring').length, 1, '空心圈也只有这一个');
  const marker = h.markers()[0];
  assert.equal(marker.size, 22, '低缩放时编号保底 22 CSS px');
  assert.equal(marker.text, '1');
  assert.ok(marker.ringSize >= 6, `空心圈不能细到看不见：${marker.ringSize}`);

  // 屏幕 canvas 这一帧不画编号/空心圈/引线，只留底图。
  const displayCallList = h.q('.ie-display').context.calls;
  h.dom.flushFrames();
  const from = displayCallList.length;
  h.emit(h.q('.ie-scroll'), 'scroll');
  h.dom.flushFrames();
  const frame = displayCallList.slice(from);
  assert.ok(frame.length > 0, '要有新的一帧');
  assert.equal(frame.some(call => call.name === 'fillText'), false, '屏幕 canvas 不画编号文字');
  assert.equal(frame.some(call => call.name === 'arc'), false, '屏幕 canvas 也不画空心圈/徽章（没有其他绘制，arc 只属于批注）');
  assert.equal(frame.some(call => call.name === 'lineTo'), false, '屏幕 canvas 不画引线');

  // 导出图片同样不带这份浮层：坐标只是元数据，不当坐标画回去。
  const before = h.dom.canvases.length;
  const copied = await h.copy();
  assert.equal(copied.annotations.length, 1);
  assert.ok(Math.abs(copied.annotations[0].point.x - 1000) < 0.01 && Math.abs(copied.annotations[0].point.y - 500) < 0.01,
    `坐标不能被避让或缩放改掉：${json(copied.annotations[0].point)}`);
  assert.deepEqual(annotationMarks(h.dom.canvases.slice(before)[0].context.calls), [],
    '导出图片不能带编号/空心圈/徽章');
});

test('框批注：区域边框只在预览里，DOM 编号避开框角；导出不带框/编号', async () => {
  const h = harness();
  await h.open();
  h.tool('region');
  h.drag(at(20, 20), at(120, 90));
  h.type('这块被裁掉了');
  h.save();
  const marker = h.markers()[0];
  const ringX = marker.ringLeft + marker.ringSize / 2, ringY = marker.ringTop + marker.ringSize / 2;
  assert.ok(Math.abs(ringX - at(20, 20).x) <= 1 && Math.abs(ringY - at(20, 20).y) <= 1, '空心圈标在框的角落');
  assert.ok(Math.hypot(marker.left + marker.size / 2 - ringX, marker.top + marker.size / 2 - ringY) > marker.size / 2,
    '编号偏离框角，不压住边框起点');

  // 预览帧里仍画区域边框（框是预览信息，不是成图内容）。
  const displayCalls = h.q('.ie-display').context.calls;
  h.dom.flushFrames();
  const from = displayCalls.length;
  h.emit(h.q('.ie-scroll'), 'scroll');
  h.dom.flushFrames();
  const frame = displayCalls.slice(from);
  assert.ok(frame.some(call => call.name === 'strokeRect' && Math.abs(call.args[0] - 20) < 1.5 &&
    Math.abs(call.args[1] - 20) < 1.5), '预览里仍画区域边框');

  const before = h.dom.canvases.length;
  assert.ok(isPng(await h.editor.exportPNG()));
  assert.deepEqual(annotationMarks(h.dom.canvases.slice(before)[0].context.calls), [],
    '导出的图片不带框批注边框和编号');
});

test('极小图：编号只能夹在图内，落点小圈仍留在真实坐标', async () => {
  // 40×40 的小图还能避让；12×12 时编号（屏幕保底 22px）必然比图大，只能夹在图内。
  const small = harness({ width: 40, height: 40,
    dom: { workspace: { width: 100, height: 100 }, scroller: { width: 100, height: 100 }, bubble: { width: 80, height: 60 } } });
  await small.open();
  small.tool('point');
  // 40×40 的图在 100 宽视口里 zoom=1：x 居中留白 30，y 从 16 开始。
  small.drag({ x: 30, y: 16 });
  small.type('角上');
  small.save();
  let marker = small.markers()[0];
  assert.ok(Math.abs(marker.ringLeft + marker.ringSize / 2 - 30) <= 1 && Math.abs(marker.ringTop + marker.ringSize / 2 - 16) <= 1,
    '空心圈仍在真实落点');
  assert.ok(marker.left >= 30 - 1.5 && marker.left + marker.size <= 70 + 1.5, '编号横向夹在图内');
  assert.ok(marker.top >= 16 - 1.5 && marker.top + marker.size <= 56 + 1.5, '编号纵向夹在图内');
  assert.ok(Math.hypot(marker.left + marker.size / 2 - 30, marker.top + marker.size / 2 - 16) > marker.size / 2,
    '还能避让时就不盖落点');
  assert.deepEqual((await small.notes()).map(note => [note.point.x, note.point.y]), [[0, 0]], '坐标元数据不受避让影响');

  const tiny = harness({ width: 12, height: 12,
    dom: { workspace: { width: 100, height: 100 }, scroller: { width: 100, height: 100 }, bubble: { width: 80, height: 60 } } });
  await tiny.open();
  tiny.tool('point');
  // 12×12 的图在 44..56 / 16..28 的显示区内，点中心。
  tiny.drag({ x: 50, y: 22 });
  tiny.type('极小图');
  tiny.save();
  marker = tiny.markers()[0];
  assert.equal(marker.size, 22, '编号仍然保底 22 CSS px 可读');
  assert.ok(Math.abs(marker.ringLeft + marker.ringSize / 2 - 50) <= 1 && Math.abs(marker.ringTop + marker.ringSize / 2 - 22) <= 1,
    '空心圈仍在真实落点（命中图中心）');
  const tinyCenter = { x: marker.left + marker.size / 2, y: marker.top + marker.size / 2 };
  assert.ok(tinyCenter.x >= 44 - 1.5 && tinyCenter.x <= 56 + 1.5 && tinyCenter.y >= 16 - 1.5 && tinyCenter.y <= 28 + 1.5,
    '避不开时编号居中在图片内，不会飞出去');
  assert.equal(marker.leader.width, 0, '落点和编号重合时不画一段反向引线');
  assert.equal(marker.leader.hidden, true, '重合时引线元素也收起来');
  const tinyNotes = await tiny.notes();
  assert.ok(Math.abs(tinyNotes[0].point.x - 6) < 1e-6 && Math.abs(tinyNotes[0].point.y - 6) < 1e-6, '极小图坐标也不改');

  // 30×30：编号被边界拉回来，两个圆心的距离比 ring+badge 还短——旧判定（看端点距离）
  // 会在重叠情况下画一条方向反转的引线，这里必须不画，和 DOM 同一判定。
  const near = harness({ width: 30, height: 30,
    dom: { workspace: { width: 100, height: 100 }, scroller: { width: 100, height: 100 }, bubble: { width: 80, height: 60 } } });
  await near.open();
  near.tool('point');
  near.drag({ x: 50, y: 31 });
  near.type('贴太近');
  near.save();
  const nearMarker = near.markers()[0];
  const nearBadge = { x: nearMarker.left + nearMarker.size / 2, y: nearMarker.top + nearMarker.size / 2 };
  const nearRing = { x: nearMarker.ringLeft + nearMarker.ringSize / 2, y: nearMarker.ringTop + nearMarker.ringSize / 2 };
  assert.ok(Math.hypot(nearBadge.x - nearRing.x, nearBadge.y - nearRing.y) < nearMarker.size / 2 + nearMarker.ringSize / 2,
    `前提：这一例的两个圆心确实比半径之和还近：${json({ nearBadge, nearRing })}`);
  assert.equal(nearMarker.leader.hidden, true, '圆心太近就不画引线（不反向）');
  const nearBefore = near.dom.canvases.length;
  assert.ok(isPng(await near.editor.exportPNG()));
  const nearCalls = near.dom.canvases.slice(nearBefore)[0].context.calls;
  assert.deepEqual(annotationMarks(nearCalls), [], '成图里不带编号/空心圈，也不可能画反向引线');
  assert.equal(nearCalls.some(call => call.name === 'lineTo'), false, '成图里不能画引线');
});

test('点靠右下边时表单在右栏，不遮挡画布也不挡编号', async () => {
  const h = harness({ width: 600, height: 440,
    dom: { workspace: { width: 640, height: 480 }, scroller: { width: 640, height: 480 } } });
  await h.open();
  h.tool('point');
  h.drag({ x: 20 + 540, y: 16 + 400 });
  assert.equal(h.bubble().hidden, false, '点下去了就该出表单');
  assert.equal(h.q('.ie-panel').hidden, false, '右栏展开');
  assert.equal(h.q('.ie-panel').style.left, undefined, '右栏不靠 left 定位，不会盖到画布上');
  const marker = h.markers()[0];
  assert.ok(marker.left >= 0 && marker.top >= 0, '编号仍在画布坐标系里');
  h.type('右下角也要能看');
  h.save();
  assert.deepEqual(h.numbers(), [1]);
});

test('窄窗：画布仍有宽度、右栏自己可滚，textarea 不被压成负高度', async () => {
  const h = harness({ width: 200, height: 150,
    dom: { workspace: { width: 300, height: 260 }, scroller: { width: 300, height: 260 }, bubble: { width: 284, height: 200 } } });
  await h.open();
  h.tool('point');
  h.drag({ x: 50 + 180, y: 16 + 120 });
  assert.equal(h.bubble().hidden, false);
  // 夹具没有布局引擎：这里证的是结构与规则（宽度上下限 + 面板自滚 + 文本域可写）。
  const css = fs.readFileSync(path.join(ROOT, 'renderer/image-editor.css'), 'utf8');
  assert.match(css, /\.ie-panel\{[^}]*width:clamp\(200px,34vw,300px\)/, '右栏宽度有上下限');
  assert.match(css, /\.ie-panel\{[^}]*overflow:auto/, '面板自己可滚，不靠整页');
  assert.match(css, /\.ie-main\{[^}]*grid-template-columns:minmax\(0,1fr\) auto/, '画布列至少占剩余空间');
  h.type('窄屏也要能写完');
  h.save();
  assert.deepEqual(h.numbers(), [1]);
});

test('预览可隐藏批注：编号/引线/空心圈/框和命中一起收掉，马赛克纯色笔迹不动，导出本来就不带标记', async () => {
  const h = harness();
  await h.open();
  // 先铺三条不该被隐藏的东西：马赛克、纯色遮盖、自由笔。
  h.tool('mosaic');
  h.drag({ x: 60, y: 200 }, { x: 160, y: 220 });
  h.q('[data-setting="fill"]').checked = true;
  h.tool('rect');
  h.drag({ x: 40, y: 40 }, { x: 120, y: 80 });
  h.tool('pen');
  h.drag({ x: 200, y: 200 }, { x: 260, y: 240 });
  h.tool('point');
  h.drag(at(80, 90));
  h.type('看这里');
  h.save();
  h.tool('region');
  h.drag(at(200, 40), at(300, 120));
  h.type('这块要放大');
  h.save();

  const toggle = h.q('[data-action="notes-toggle"]');
  assert.ok(toggle, '缩放控件区要有显示/隐藏批注的按钮');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true', '默认可见，aria-pressed 表示可见');
  assert.equal(toggle.getAttribute('aria-label'), '显示或隐藏批注');
  assert.match(toggle.getAttribute('title'), /仅预览/);
  assert.match(toggle.getAttribute('title'), /不含/, 'title 要说清导出图片不带这些标记');
  assert.equal(h.q('.ie-marker-layer').hidden, false);
  assert.equal(h.q('.ie-marker').getClientRects().length, 1, '显示时编号可命中');

  const displayCalls = () => h.q('.ie-display').context.calls;
  // 抽一帧屏幕预览：先把待画帧抽干，再主动触发一帧，只看这一帧新增加的调用。
  const nextFrame = () => {
    h.dom.flushFrames();
    const from = displayCalls().length;
    h.emit(h.q('.ie-scroll'), 'scroll');
    h.dom.flushFrames();
    return displayCalls().slice(from);
  };
  const visibleFrame = nextFrame();
  assert.equal(visibleFrame.some(call => call.name === 'fillText'), false, '屏幕 canvas 不画编号：编号只由 DOM 画一份');
  assert.ok(visibleFrame.some(call => call.name === 'strokeRect'), '区域边框仍由 canvas 画在预览里');
  assert.equal(h.markers().length, 2, '屏幕上两个编号都是 DOM 按钮');

  h.click(toggle);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(h.q('.ie-marker-layer').hidden, true, '编号层整体收起');
  assert.equal(h.q('.ie-marker').getClientRects().length, 0, '隐藏后编号没有命中盒');
  assert.equal(h.q('.ie-workspace').classList.contains('ie-markers-live'), false, '也不再接指针事件');
  assert.match(h.q('.ie-status').textContent, /不含悬浮标记/, '状态栏要说清导出图片本来就不带标记');
  assert.match(h.q('.ie-status').textContent, /复制说明区/, '状态栏要说清复制说明区仍保留编号');
  const hiddenFrame = nextFrame();
  assert.ok(hiddenFrame.length > 0, '隐藏后也要重绘一帧');
  assert.equal(hiddenFrame.some(call => call.name === 'fillText'), false, '预览里不再画编号');
  assert.equal(hiddenFrame.some(call => call.name === 'strokeRect'), false, '框批注也一起藏了（隐藏预览连区域边框不画）');
  assert.ok(hiddenFrame.some(call => call.name === 'clip'), '马赛克遮罩不能跟着隐藏');
  assert.ok(hiddenFrame.some(call => call.name === 'drawImage' && call.source.startsWith('canvas#')), '马赛克网格不能跟着隐藏');
  assert.ok(hiddenFrame.some(call => call.name === 'fillRect'), '纯色遮盖不能跟着隐藏');
  assert.ok(hiddenFrame.some(call => call.name === 'stroke'), '笔迹不能跟着隐藏');

  // 隐藏只是预览：批注没删，保存和复制都不带编号/框标记，但遮盖与笔迹都在。
  const assertExported = (calls, label) => {
    assert.deepEqual(annotationMarks(calls, { brushRadius: 10 }), [], `${label}不能带编号/空心圈/框标记`);
    assert.ok(calls.some(call => call.name === 'clip'), `${label}仍带马赛克`);
    assert.ok(calls.some(call => call.name === 'drawImage' && call.source.startsWith('canvas#')), `${label}仍带马赛克网格`);
    assert.ok(calls.some(call => call.name === 'fillRect'), `${label}仍带纯色遮盖`);
    assert.ok(calls.some(call => call.name === 'stroke'), `${label}仍带笔迹`);
  };
  let before = h.dom.canvases.length;
  assert.ok(isPng(await h.editor.exportPNG()), '保存这条出口也照常出图');
  assertExported(h.dom.canvases.slice(before)[0].context.calls, '保存导出');
  before = h.dom.canvases.length;
  const clip = await h.editor.exportClipboard();
  assert.ok(isPng(clip.png), '复制这条出口也照常出图');
  const clipCalls = h.dom.canvases.slice(before)[0].context.calls;
  assertExported(clipCalls, '复制导出');
  // 复制说明区仍然带编号与坐标（这正是隐藏预览后还能读懂批注的原因）。
  const clipTexts = fillTexts(clipCalls).map(item => item.text);
  assert.ok(clipTexts.some(text => /第 1 条 · 点 \(/.test(text)), '复制的说明区仍带第 1 条点坐标');
  assert.ok(clipTexts.some(text => /第 2 条 · 框 \(/.test(text)), '复制的说明区仍带第 2 条框范围');

  // 再点一下恢复显示，编号/引线/空心圈都回来。
  h.click(toggle);
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(h.q('.ie-marker-layer').hidden, false);
  assert.equal(h.q('.ie-marker').getClientRects().length, 1);
  assert.deepEqual(h.numbers(), [1, 2]);
  assert.ok(h.markers().every(item => item.ringSize > 0 && item.leader && item.leader.width > 0), '引线/空心圈也跟着回来');
});

test('隐藏批注后新增会自动切回显示；隐藏时正在写的字先存下；开新图重置为显示', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(60, 60));
  h.type('甲');
  h.save();
  const toggle = h.q('[data-action="notes-toggle"]');
  h.click(toggle);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');

  // 新点一条：自动显示，否则刚点的内容看不见。
  h.drag(at(160, 120));
  assert.equal(toggle.getAttribute('aria-pressed'), 'true', '新增批注要自动显示');
  assert.equal(h.q('.ie-marker-layer').hidden, false);
  h.type('乙');
  h.save();

  // 正在写的时候隐藏：先把字存进这一条，再收起气泡，不丢字。
  h.drag(at(220, 200));
  h.type('丙');
  h.click(toggle);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(h.bubble().hidden, true, '隐藏预览后气泡不能悬空');
  assert.deepEqual((await h.notes()).map(note => note.text), ['甲', '乙', '丙'], '隐藏前把正在写的字存下');

  // 拉框时也要马上显示：否则拖出来的框在隐藏状态下看不见。
  h.tool('region');
  const scroller = h.q('.ie-scroll');
  const down = { clientX: at(40, 40).x, clientY: at(40, 40).y, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1,
    preventDefault() {}, getCoalescedEvents: () => [] };
  scroller.emit('pointerdown', down);
  assert.equal(toggle.getAttribute('aria-pressed'), 'true', '开始拖框也要自动切回显示');
  scroller.emit('pointerup', { ...down, buttons: 0 });
  assert.match(h.q('.ie-status').textContent, /框太小/);

  // 防御性 guard：隐藏时命中已被 layer hidden 收掉，这里直接派发 click 只验证 openEdit 会把预览切回显示。
  const [first] = await h.notes();
  h.click(h.q(`.ie-marker[data-annotation-id="${first.id}"]`));
  assert.equal(toggle.getAttribute('aria-pressed'), 'true', '编辑批注也要自动显示');
  h.cancelBubble();

  // 开新图重置为显示，不留着上一张图的隐藏状态。
  h.click(toggle);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  await h.open({ token: 'doc-2' });
  assert.equal(toggle.getAttribute('aria-pressed'), 'true', '新图重置为显示');
  assert.equal(h.q('.ie-marker-layer').hidden, false);
  assert.deepEqual(h.markers(), []);
});

test('补充说明用同一个小浮层编辑总体 comment，不做侧栏', async () => {
  const h = harness();
  await h.open();
  h.click(h.q('[data-action="comment"]'));
  assert.equal(h.q('.ie-comment-bubble').hidden, false, '补充说明是浮层');
  assert.equal(h.dom.document.activeElement, h.comment(), '点开就聚焦');
  h.typeComment('整体没问题，就这一处');
  h.click(h.q('[data-action="comment-close"]'));
  assert.equal(h.q('.ie-comment-bubble').hidden, true);
  h.tool('point');
  h.drag(at(80, 80));
  h.type('唯一一处');
  h.save();
  const result = await h.copy();
  assert.equal(result.comment, '整体没问题，就这一处');
  assert.equal(result.annotations.length, 1);
  // 点画布也会收起浮层，但文字还在。
  h.click(h.q('[data-action="comment"]'));
  h.drag(at(160, 160));
  assert.equal(h.q('.ie-comment-bubble').hidden, true, '点画布收起补充说明');
  h.cancelBubble();
  assert.equal((await h.copy()).comment, '整体没问题，就这一处');
});

test('复制返回固定安全结构：只有 token / 单张 PNG / 说明区尺寸，不含原始来源与 ops', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(80, 90));
  h.type('这里字太小');
  h.save();
  h.tool('region');
  h.drag(at(120, 100), at(220, 180));
  h.type('这块被裁掉了');
  h.save();
  h.click(h.q('[data-action="comment"]'));
  h.typeComment('整体没问题，就这两处');

  const panel = await h.copy();
  const result = panel.result;
  assert.deepEqual(Object.keys(result).sort(), ['clipboardSize', 'png', 'token'], '复制只交出 token、一张 PNG 和说明区尺寸');
  assert.equal(result.token, 'doc-1');
  assert.ok(isPng(result.png), 'PNG 必须是真实签名');
  assert.equal(result.clipboardSize.width, 720, '窄图按最窄说明宽度补齐');
  assert.ok(result.clipboardSize.height > 300, '说明区接在图片下方');
  const shape = panel.annotations.map(item => ({ ...item, keys: Object.keys(item).sort() }));
  assert.equal(shape.length, 2);
  assert.deepEqual(shape[0].keys, ['id', 'kind', 'number', 'point', 'text']);
  assert.deepEqual(shape[1].keys, ['id', 'kind', 'number', 'rect', 'text']);
  assert.deepEqual(Object.keys(shape[0].point).sort(), ['x', 'y']);
  assert.deepEqual(Object.keys(shape[1].rect).sort(), ['height', 'width', 'x', 'y']);
  assert.equal(panel.comment, '整体没问题，就这两处');
  assert.deepEqual(shape.map(item => item.number), [1, 2]);
  const serialized = json({ result, lines: panel.lines });
  for (const secret of ['SOURCE-SECRET-BASE64', 'RAW-BITMAP-SECRET', '"ops"', '"points"', 'dataUrl', 'imageBitmap']) {
    assert.equal(serialized.includes(secret), false, `导出里不能出现 ${secret}`);
  }
});

test('导出 PNG 只从 compose 画布来：底图 + 马赛克 + 笔迹都在，批注浮层和气泡文字都不进图', async () => {
  const h = harness();
  await h.open();
  // 先涂一笔马赛克，再加两条批注：导出要带底图和马赛克，但不能带批注浮层。
  h.tool('mosaic');
  h.drag({ x: 60, y: 200 }, { x: 160, y: 220 });
  h.tool('point');
  h.drag(at(80, 90));
  h.type('看这里');
  h.save();
  h.tool('region');
  h.drag(at(260, 180), at(330, 240));
  h.type('这块也要看');
  h.save();

  const before = h.dom.canvases.length;
  assert.ok(isPng(await h.editor.exportPNG()));
  const created = h.dom.canvases.slice(before);
  assert.ok(created.length >= 1, '导出必须自己建一张画布');
  const exportCanvas = created[0];
  const calls = exportCanvas.context.calls;
  assert.ok(calls.length > 0, '导出画布必须真的被绘制过');
  assert.equal(calls.filter(call => call.name === 'drawImage' && call.source === 'bitmap').length, 1, '底图只画一次');
  assert.equal(calls.some(call => call.name === 'drawImage' && call.source === 'url'), false, '不允许直接画原始 dataUrl');
  assert.ok(calls.some(call => call.name === 'clip'), '马赛克仍走裁剪路径');
  assert.ok(calls.some(call => call.name === 'drawImage' && call.source.startsWith('canvas#')), '马赛克网格仍在输出里');
  // 批注浮层一律不进图：没有裸编号文字、没有编号/空心圈的 arc、没有区域边框的 strokeRect。
  assert.deepEqual(annotationMarks(calls, { brushRadius: 10 }), [], '导出画布不带编号/空心圈/框标记');
  assert.equal(calls.some(call => call.name === 'fillText' && String(call.args[0]).length > 2), false, '气泡文字不能被画进成图');
  // 普通导出仍走同一条 compose：有批注时能正常出 PNG。
  assert.ok(isPng(await h.editor.exportPNG()), '普通导出语义不变');
});

test('超长草稿不被截断：导出明确报错，气泡里原样还在', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(80, 90));
  assert.equal(h.field().getAttribute('maxlength'), null, '批注输入框不能靠 maxlength 静默截断');
  assert.equal(h.q('.ie-comment').getAttribute('maxlength'), null, '补充说明同理');

  const long = '字'.repeat(2001);
  h.type(long);
  assert.equal(h.field().value.length, 2001, 'UI 里看到多少字就是多少字');
  h.save();
  assert.deepEqual(h.numbers(), [1], '超长草稿本身可以保存进编辑器');
  await assert.rejects(h.editor.exportClipboard(), /超过 2000 字/, '超长只能在导出时明确拒绝');

  // 再建一条再撤销：第一条的超长文字不能被连带改动。
  h.drag(at(140, 90));
  h.type('第二条');
  h.save();
  h.key(h.q('.ie-scroll'), { key: 'z', ctrlKey: true });
  assert.equal(h.markers().length, 1);
  const reopened = h.markers()[0];
  h.click(h.q(`.ie-marker[data-annotation-id="${reopened.id}"]`));
  assert.equal(h.field().value, long, '撤销别的操作不能动文字');

  h.editor.close();
  await h.open();
  h.click(h.q(`.ie-marker[data-annotation-id="${reopened.id}"]`));
  assert.equal(h.field().value, long, '同 token 重开保留超长草稿');

  // 码位计数：2000 个 emoji 合法（UTF-16 长度 4000）。
  h.type('😀'.repeat(2000));
  h.save();
  const panel = await h.copy();
  assert.equal(panel.annotations.length, 1);
  assert.equal(panel.annotations[0].text.replace(/\n/g, ''), '😀'.repeat(2000), '2000 个 emoji 按码位计字，一个字不少');

  // 前后空格属于用户输入，不能被 trim 掉。
  h.click(h.q(`.ie-marker[data-annotation-id="${reopened.id}"]`));
  h.type('  前后空格  ');
  h.save();
  assert.equal((await h.copy()).annotations[0].text, '  前后空格  ');
});

test('Annotations 纯模型的边界：越界拒绝、码位计字、重复 id、尺寸上限、原样文本', () => {
  const dom = createEditorDom();
  const window = {};
  const sandbox = { window, document: dom.document };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'renderer/annotations.js'), 'utf8'), sandbox, { filename: 'annotations.js' });
  const Annotations = sandbox.window.Annotations;
  assert.equal(Array.isArray(Object.keys(Annotations).sort()), true);
  assert.deepEqual(Object.keys(Annotations).sort(), ['LIMITS', 'prepare'], '模型只提供限额与校验/编号，不再拼反馈包');
  const point = (id, text, x = 10, y = 20) => ({ id, kind: 'point', point: { x, y }, text });
  const prepare = (annotations, comment = '') => Annotations.prepare({ width: 100, height: 100, annotations, comment });

  const many = Array.from({ length: 101 }, (_, index) => point(`a${index}`, 'x'));
  assert.throws(() => prepare(many), /批注最多 100 条/);
  assert.throws(() => prepare([], 'x'.repeat(4001)), /总体说明超过 4000 字/);
  assert.throws(() => prepare([point('a1', '  ')]), /还没有填写意见/);
  assert.throws(() => prepare([]), /至少写一条批注或一段总体说明/, '空交付没有意义');

  // 坐标越界整份拒绝：不静默夹取（点与框各方向）。
  assert.throws(() => prepare([point('a1', 'x', -1, 10)]), /批注坐标超出图片范围/);
  assert.throws(() => prepare([point('a1', 'x', 0, 100.5)]), /批注坐标超出图片范围/);
  assert.throws(() => prepare([{ id: 'a1', kind: 'region', rect: { x: -0.5, y: 0, width: 10, height: 10 }, text: 'x' }]), /批注范围超出图片范围/);
  assert.throws(() => prepare([{ id: 'a1', kind: 'region', rect: { x: 90, y: 90, width: 11, height: 10 }, text: 'x' }]), /批注范围超出图片范围/);
  assert.throws(() => prepare([{ id: 'a1', kind: 'region', rect: { x: 0, y: 0, width: 0, height: 10 }, text: 'x' }]), /批注范围无效/);
  const edge = prepare([{ id: 'a1', kind: 'point', point: { x: 0, y: 100 }, text: '边' },
    { id: 'a2', kind: 'region', rect: { x: 90, y: 90, width: 10, height: 10 }, text: '角' }]);
  assert.deepEqual(plain(edge.annotations[1].rect), { x: 90, y: 90, width: 10, height: 10 }, '恰好贴边是合法的，且原值返回');

  // 计字按码位：2000 个 emoji 合法（UTF-16 长度是 4000），2001 个拒绝。
  const emoji = '😀'.repeat(2000);
  assert.equal(emoji.length, 4000, '前置：UTF-16 长度确实是 4000');
  assert.equal(prepare([point('a1', emoji)]).annotations[0].text.length, 4000);
  assert.throws(() => prepare([point('a1', `${emoji}😀`)]), /超过 2000 字/);
  assert.equal(prepare([point('a1', '中'.repeat(2000))]).annotations[0].text.length, 2000);
  assert.throws(() => prepare([point('a1', '中'.repeat(2001))]), /超过 2000 字/);

  // 总体说明独立 4000：两条 2000 字批注 + 4000 字总体说明同时合法，4001 拒。
  const both = Annotations.prepare({ width: 100, height: 100, comment: '😀'.repeat(4000),
    annotations: [point('a1', 'a'.repeat(2000)), point('a2', 'b'.repeat(2000))] });
  assert.equal(Array.from(both.comment).length, 4000);
  assert.deepEqual(both.annotations.map(item => Array.from(item.text).length), [2000, 2000]);
  assert.throws(() => Annotations.prepare({ width: 100, height: 100, comment: '😀'.repeat(4001), annotations: [point('a1', 'x')] }), /总体说明超过 4000 字/);

  // id 类型/重复：必须是 string 且不重复。
  assert.throws(() => prepare([{ id: 1, kind: 'point', point: { x: 1, y: 1 }, text: 'x' }]), /批注标识无效/);
  assert.throws(() => prepare([point('a1', 'x'), point('a1', 'y')]), /批注标识重复/);

  // 尺寸与主进程同一限额：边长 30000、总计 1600 万像素。
  assert.throws(() => Annotations.prepare({ width: 30001, height: 10, annotations: [], comment: 'x' }), /批注尺寸无效/);
  assert.throws(() => Annotations.prepare({ width: 4000, height: 4001, annotations: [], comment: 'x' }), /批注尺寸无效/);
  assert.equal(Annotations.prepare({ width: 4000, height: 4000, annotations: [], comment: 'x' }).annotations.length, 0);

  // 文本原样：前导/尾随空格与换行不丢，额外字段不外泄。
  const prepared = Annotations.prepare({ width: 100, height: 100,
    annotations: [{ id: 'a1', kind: 'region', rect: { x: 90, y: 90, width: 10, height: 10 }, text: '  前后有空格\n第二行  ', number: 99, points: [[1, 2]] }],
    comment: ' 总体 ' });
  assert.deepEqual(plain(prepared.annotations[0]), { id: 'a1', number: 1, kind: 'region',
    rect: { x: 90, y: 90, width: 10, height: 10 }, text: '  前后有空格\n第二行  ' }, '文本不能被 trim 或夹取');
  assert.equal(prepared.comment, ' 总体 ', '总体说明也原样保留');
  assert.deepEqual(Object.keys(prepared.annotations[0]).sort(), ['id', 'kind', 'number', 'rect', 'text'], '额外字段（number/points）不能漏出去');
});

test('不再有外传路由：没有外传按钮，也没有 onFeedback / exportFeedback / setFeedbackTarget', async () => {
  const h = harness();
  await h.open();
  assert.equal(h.q('[data-action="feedback"]'), null, '页头不再有外传按钮');
  assert.equal(typeof h.editor.setFeedbackTarget, 'undefined', '发送目标链路已从编辑器拿掉（旧 backend 协议不再驱动 UI）');
  assert.equal('exportFeedback' in h.editor, false, '不再拼反馈包');
  assert.equal(h.window.Feedback, undefined, '旧的 window.Feedback 兼容壳已删');
  assert.equal(typeof h.window.Annotations.prepare, 'function', '换成通用的 window.Annotations');
  assert.deepEqual([...h.q('.ie-exports').children].map(node => node.dataset.action),
    ['save-as', 'save', 'copy'], '页头输出统一为另存/保存/复制，无外传入口');
  assert.equal(h.q('[data-action="frame-done"]'), null, '不再有中间确认的「完成调框」按钮');
  h.tool('point');
  h.drag(at(80, 80));
  h.type('只复制不发送');
  h.save();
  assert.equal(h.editor.hasEdits, true);
  const result = await h.editor.exportClipboard();
  assert.ok(isPng(result.png), '复制这条路自己就完成导出');
  assert.equal(h.calls.feedback, 0, '任何操作都不能触发 onFeedback');
  assert.equal(h.calls.commit.length, 0, '编辑器不自己调 onCommit');
  assert.equal(h.calls.close, 0, '编辑器不自己关窗');
});

test('同 token 重开保留批注与补充说明，新 token / reset 清空', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(80, 90));
  h.type('保留我');
  h.save();
  h.click(h.q('[data-action="comment"]'));
  h.typeComment('总体保留');

  h.editor.close();
  await h.open();
  assert.deepEqual((await h.notes()).map(note => note.text), ['保留我'], '同 token 重开保留批注');
  assert.deepEqual(h.numbers(), [1], '标记也回来了');
  assert.equal(h.q('.ie-comment').value, '总体保留', '补充说明也保留');

  h.editor.reset();
  assert.deepEqual(h.markers(), [], 'reset 清空标记');
  assert.equal(h.q('.ie-comment').value, '');

  await h.open({ token: 'doc-2' });
  assert.deepEqual(h.markers(), [], '新 token 不会带上一份的批注');
  assert.equal(h.q('.ie-comment').value, '');
});

test('setBusy 期间气泡和补注都锁住，复制/保存都只把动作交给宿主', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(80, 90));
  h.type('忙时别动');

  h.editor.setBusy(true);
  h.dom.flushFrames();
  assert.equal(h.field().disabled, true, '忙碌时气泡输入框也要锁');
  assert.equal(h.q('[data-action="bubble-save"]').disabled, true, '忙碌时保存按钮要禁用');
  assert.equal(h.q('.ie-marker').disabled, true, '忙碌时标记不能点');
  h.save();
  assert.equal(h.bubble().hidden, false, '忙碌时保存不生效，文字还在');
  h.editor.setBusy(false);
  h.dom.flushFrames();
  assert.equal(h.field().disabled, false);
  h.save();
  assert.deepEqual(h.numbers(), [1]);

  h.click(h.q('[data-action="copy"]'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.commit, ['copy'], '复制只把动作交给宿主');
  h.click(h.q('[data-action="save"]'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.commit, ['copy', 'save-quick'], '保存也只交给宿主，沿用设置目录快存');
  assert.equal(h.calls.feedback, 0, '不再有 onFeedback 这条路');
  assert.equal(h.calls.close, 0, '不能偷偷关窗');
  assert.equal(h.editor.isOpen, true);
});

// —— 复制出口：批注不能只复制编号 ——
// 夹具的字宽是固定模型（CJK/全角 20px、其余 10px），所以换行位置、行数和画布高度都能被精确预期；
// 真实字体下的换行与像素由 Electron 离屏实验另验。
const charWidth = text => [...String(text)].reduce((sum, char) => sum + (char.codePointAt(0) > 0x2e80 ? 20 : 10), 0);
const fillTexts = calls => calls.filter(call => call.name === 'fillText')
  .map(call => ({ text: call.args[0], x: call.args[1], y: call.args[2] }));

test('复制窄图：说明区画上编号/原始坐标/全文/总体说明，原图仍从 (0, 0) 起不缩放', async () => {
  // 200 宽的图在 300 宽视口里 zoom=1，落点坐标是整数，便于逐字核对。
  const h = harness({ width: 200, height: 150,
    dom: { scroller: { width: 300, height: 300 }, workspace: { width: 300, height: 300 } } });
  await h.open();
  h.tool('point');
  h.drag({ x: 50 + 40, y: 16 + 30 });
  h.type('太窄了');
  h.save();
  h.tool('region');
  h.drag({ x: 50 + 60, y: 16 + 50 }, { x: 50 + 120, y: 16 + 100 });
  h.type('这块要放大');
  h.save();
  h.click(h.q('[data-action="comment"]'));
  h.typeComment('整体还行');
  const notes = await h.notes();

  const before = h.dom.canvases.length;
  const result = await h.editor.exportClipboard();
  const created = h.dom.canvases.slice(before);
  assert.equal(created.length, 1, '复制只建一张画布：先 1 像素高量字，再撑到最终高度');
  assert.equal(result.token, 'doc-1');
  assert.ok(isPng(result.png), '复制的仍是真 PNG');
  const size = plain(result.clipboardSize);
  assert.equal(size.width, 720, '200 宽的窄图右侧补白到 720');
  assert.equal('insetWidth' in result.clipboardSize, false, '没有局部放大就不声明 insetWidth，旧形状不变');
  assert.ok(size.height > 150, '原图下方留出说明区');
  assert.equal(result.png[8], size.width & 0xff, '编码出来的画布宽度就是声明的宽度');

  const calls = created[0].context.calls;
  const draws = calls.filter(call => call.name === 'drawImage');
  assert.deepEqual(draws.map(call => call.source), ['bitmap'], '像素只来自 compose 的底图');
  assert.deepEqual(draws[0].args, [0, 0], 'drawImage 只给坐标不给尺寸：原图贴 (0,0) 且不缩放');
  assert.ok(calls.some(call => call.name === 'fillRect' && call.args[0] === 0 && call.args[1] === 0 &&
    call.args[2] === 720 && call.args[3] === size.height), '整张画布先铺白底：右侧补白、下方说明区');

  const texts = fillTexts(calls);
  const rows = texts.filter(item => item.y >= 150);
  assert.deepEqual(rows.slice(0, 4).map(item => item.text),
    ['【截图批注说明】', '图像尺寸：200 × 150 像素', '坐标原点 (0, 0) 在图片左上角，单位：像素',
      '上方截图不含编号悬浮标记；下列坐标基于上方截图，框为 (x, y, 宽, 高)']);
  assert.equal(rows[0].y, 150 + 24, '说明区从原图底边加留白开始');
  for (const item of rows) assert.equal(item.x, 20, '正文左边距 20');
  assert.equal(rows[4].text, `第 1 条 · 点 (${notes[0].point.x}, ${notes[0].point.y})：太窄了`,
    '编号 + 原始点坐标 + 全文在同一行（坐标不取整、不换算）');
  assert.equal(rows[5].text, `第 2 条 · 框 (${notes[1].rect.x}, ${notes[1].rect.y}, ${notes[1].rect.width}, ${notes[1].rect.height})：这块要放大`);
  assert.equal(rows[6].text, '总体说明：整体还行');
  assert.deepEqual(texts.filter(item => item.y < 150), [], '原图区域里不画任何批注文字（编号只在预览浮层）');
});

test('复制普通图：没批注也没总体说明时仍是原尺寸成图，不加说明区', async () => {
  const h = harness();
  await h.open();
  assert.equal(h.editor.hasEdits, false);
  const before = h.dom.canvases.length;
  const result = await h.editor.exportClipboard();
  const created = h.dom.canvases.slice(before);
  assert.equal(created.length, 1, '没有说明区就只建编码那一张画布');
  assert.equal('clipboardSize' in result, false, '没有说明区就不声明额外尺寸');
  assert.equal(result.token, 'doc-1');
  assert.ok(isPng(result.png));
  assert.equal(result.png[8], 400 & 0xff, '宽度还是原图 400');
  assert.equal(result.png[9], 300 & 0xff, '高度还是原图 300');
  const calls = created[0].context.calls;
  assert.equal(calls.some(call => call.name === 'fillText'), false, '没批注就不写字');
  assert.equal(calls.some(call => call.name === 'fillRect'), false, '也不额外铺白底');
});

test('复制：长文字按行宽换行，一字不截断，显式换行和空格原样保留', async () => {
  const h = harness({ width: 200, height: 150,
    dom: { scroller: { width: 300, height: 300 }, workspace: { width: 300, height: 300 } } });
  await h.open();
  h.click(h.q('[data-action="comment"]'));
  const long = '很长的一句说明'.repeat(20);
  h.typeComment(long);
  let before = h.dom.canvases.length;
  const wrapped = await h.editor.exportClipboard();
  let rows = fillTexts(h.dom.canvases.slice(before)[0].context.calls).filter(item => item.y >= 150);
  const body = rows.slice(4);
  assert.ok(body.length > 1, '长文字确实换行了');
  assert.deepEqual(body.map(item => item.text).join(''), `总体说明：${long}`, '全文一字不少，只按行宽断开');
  for (const item of body) assert.ok(charWidth(item.text) <= 680, `每行不超过正文行宽：${item.text}`);
  assert.ok(plain(wrapped.clipboardSize).height > 150 + body.length * 30, '行多了画布跟着变高');

  // 显式换行原样保留，不被 trim、不合并成一个空格。
  h.typeComment('第一行\n第二行  ');
  before = h.dom.canvases.length;
  await h.editor.exportClipboard();
  rows = fillTexts(h.dom.canvases.slice(before)[0].context.calls).filter(item => item.y >= 150);
  assert.deepEqual(rows.slice(4).map(item => item.text), ['总体说明：第一行', '第二行  '],
    '显式换行分行画，行尾空格不被吞');
});

test('复制：总体意见超过限制拒绝，不分配成图、不截断输入，编辑仍可修改', async () => {
  const h=harness();await h.open();h.click(h.q('[data-action="comment"]'));
  const text='😀'.repeat(4001);h.typeComment(text);
  const before=h.dom.canvases.length;
  await assert.rejects(h.editor.exportClipboard(), /总体说明超过 4000 字/);
  assert.equal(h.dom.canvases.length,before);
  assert.equal(h.q('.ie-comment').value,text);
  assert.equal(h.editor.isOpen,true);assert.equal(h.editor.busy,false);
  h.typeComment('改短后继续');assert.ok(isPng((await h.editor.exportClipboard()).png));
});

test('复制：说明区放不下就明确失败，不缩放不截断，编辑和批注都保留', async () => {
  // 720 × 29000 已经超过 1600 万像素上限：必须在分配大画布前拒绝。
  const h = harness({ width: 200, height: 29000,
    dom: { scroller: { width: 300, height: 600 }, workspace: { width: 300, height: 600 } } });
  await h.open();
  h.tool('point');
  h.drag({ x: 50 + 40, y: 16 + 30 });
  h.type('高图');
  h.save();
  const before = h.dom.canvases.length;
  await assert.rejects(h.editor.exportClipboard(), /超过复制上限/);
  const created = h.dom.canvases.slice(before);
  assert.equal(created.length, 1, '只建了量字那一张，没有再去分配超大画布');
  assert.equal(created[0].width, 0, '量完就释放');
  assert.equal(created[0].height, 0, '终值高度从未被设上去');
  assert.equal(h.editor.hasEdits, true, '批注仍在');
  assert.equal(h.editor.isOpen, true, '编辑仍在');
  assert.equal(h.editor.busy, false, '失败后不再锁住');
  assert.ok(isPng(await h.editor.exportPNG()), '保存原尺寸那条不受影响，不回退原图');
});

test('复制：说明区下面的图仍是 compose 的最终像素（马赛克和遮盖都在，但不带编号），不是原始底图', async () => {
  const h = harness();
  await h.open();
  h.tool('mosaic');
  h.drag({ x: 60, y: 200 }, { x: 160, y: 220 });
  h.q('[data-setting="fill"]').checked = true;
  h.tool('rect');
  h.drag(at(40, 40), at(120, 80));
  h.tool('point');
  h.drag(at(80, 90));
  h.type('看这里');
  h.save();
  const before = h.dom.canvases.length;
  const result = await h.editor.exportClipboard();
  assert.ok(plain(result.clipboardSize), '有批注就有说明区');
  const calls = h.dom.canvases.slice(before)[0].context.calls;
  assert.ok(calls.some(call => call.name === 'clip'), '马赛克仍走裁剪路径');
  assert.ok(calls.some(call => call.name === 'drawImage' && call.source.startsWith('canvas#')), '马赛克网格仍进复制图');
  assert.equal(calls.some(call => call.name === 'drawImage' && call.source === 'url'), false, '不直接画原始 dataUrl');
  assert.equal(calls.filter(call => call.name === 'drawImage' && call.source === 'bitmap').length, 1, '底图只画一次');
  // 纯色遮盖必须带自己的矩形坐标：不能被说明区的铺白 fillRect 冒充。
  const cover = calls.filter(call => call.name === 'fillRect' && call.args[0] !== 0 && call.args[1] !== 0);
  assert.ok(cover.some(call => call.args[0] === 40 && call.args[1] === 40 && call.args[2] === 80 && call.args[3] === 40),
    `纯色遮盖的矩形参数要原样在复制图里：${json(cover)}`);
  // 上方图片区域不带任何编号文字。
  assert.deepEqual(fillTexts(calls).filter(item => item.y < 300 && /^\d+$/.test(String(item.text))), [],
    '复制图的原图区域不画编号');
});

test('窄图复制把贴边粗笔迹裁在截图内，说明文字在裁剪恢复后绘制', async () => {
  const h = harness({ width: 200, height: 150 });
  await h.open();
  h.tool('pen');
  h.q('[data-setting="width"]').value = '128';
  const t = h.displayTransform();
  const screen = (x, y) => ({ x: t[4] + x * t[0], y: t[5] + y * t[3] });
  h.drag(screen(199, 149), screen(200, 150));
  h.click(h.q('[data-action="comment"]'));
  h.typeComment('边缘粗笔画不得盖到说明');
  const before = h.dom.canvases.length;
  const result = await h.editor.exportClipboard();
  assert.equal(result.clipboardSize.width, 720);
  const calls = h.dom.canvases.slice(before)[0].context.calls;
  const clipRect = calls.findIndex(c => c.name === 'rect' && json(c.args) === '[0,0,200,150]');
  const base = calls.findIndex(c => c.name === 'drawImage' && c.source === 'bitmap');
  const text = calls.findIndex(c => c.name === 'fillText');
  assert.ok(clipRect >= 0 && clipRect < base && base < text, '截图裁剪先于底图，说明文字在底图后');
  assert.equal(calls[clipRect + 1].name, 'clip');
  assert.deepEqual(calls[base].args, [0, 0], '底图不偏移、不重采样');
  assert.ok(calls.slice(base, text).some(c => c.name === 'stroke'), '贴边笔迹仍被绘制');
  let depth = 0;
  for (let i = clipRect - 2; i < text; i += 1) {
    if (calls[i].name === 'save') depth += 1;
    if (calls[i].name === 'restore') depth -= 1;
  }
  assert.equal(depth, 0, '说明文字前恢复截图裁剪，不裁掉下方说明');
  assert.ok(fillTexts(calls).every(row => row.y >= 150));
});

test('复制沿用 exportPNG 的收拢语义：有字存、空白新点丢，导出不关窗不提交', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(80, 80));
  h.type('复制前没保存');
  const result = await h.editor.exportClipboard();
  assert.ok(isPng(result.png));
  const copiedTexts=fillTexts(h.dom.canvases.at(-1).context.calls);
  assert.deepEqual((await h.notes()).map(note => note.text), ['复制前没保存'], '有字就存进这一条，并画进说明区');
  assert.ok(copiedTexts.some(item => String(item.text).includes('复制前没保存')),
    '说明区里有这条全文');

  h.drag(at(160, 160));
  await h.editor.exportClipboard();
  assert.deepEqual((await h.notes()).map(note => note.text), ['复制前没保存'], '空白新点直接丢，不进说明区');
  assert.deepEqual(h.numbers(), [1]);
  assert.equal(h.bubble().hidden, true, '复制后气泡收起');
  assert.deepEqual(h.calls.commit, [], '复制不自己调 onCommit');
  assert.equal(h.calls.close, 0, '复制不关窗');
  assert.equal(h.editor.isOpen, true);
});

test('三个导出口都不带批注浮层：PNG/复制/thumbnail 只带编辑基图、遮盖与笔迹', async () => {
  const h = harness();
  await h.open();
  h.tool('mosaic');
  h.drag({ x: 60, y: 200 }, { x: 160, y: 220 });
  h.q('[data-setting="fill"]').checked = true;
  h.tool('rect');
  h.drag(at(40, 40), at(120, 80));
  h.tool('pen');
  h.drag({ x: 200, y: 200 }, { x: 260, y: 240 });
  h.tool('point');
  h.drag(at(80, 90));
  h.type('看这里');
  h.save();
  h.tool('region');
  h.drag(at(260, 180), at(330, 240));
  h.type('这块也要看');
  h.save();
  const notes = plain(await h.notes());
  assert.equal(notes.length, 2);

  const checkBase = (calls, label) => {
    assert.equal(calls.filter(call => call.name === 'drawImage' && call.source === 'bitmap').length, 1, `${label}底图只画一次`);
    assert.equal(calls.some(call => call.name === 'drawImage' && call.source === 'url'), false, `${label}不直接画原始 dataUrl`);
    assert.ok(calls.some(call => call.name === 'clip'), `${label}马赛克仍在`);
    assert.ok(calls.some(call => call.name === 'drawImage' && call.source.startsWith('canvas#')), `${label}马赛克网格仍在`);
    assert.ok(calls.some(call => call.name === 'stroke'), `${label}笔迹仍在`);
    assert.ok(calls.some(call => call.name === 'fillRect' && call.args[0] === 40 && call.args[1] === 40 &&
      call.args[2] === 80 && call.args[3] === 40), `${label}纯色遮盖按自己的矩形画`);
    assert.deepEqual(annotationMarks(calls, { brushRadius: 10 }), [], `${label}不带编号/空心圈/框标记`);
  };

  let before = h.dom.canvases.length;
  assert.ok(isPng(await h.editor.exportPNG()), '保存出口能出图');
  checkBase(h.dom.canvases.slice(before)[0].context.calls, '保存导出');

  before = h.dom.canvases.length;
  const clip = await h.editor.exportClipboard();
  const clipCalls = h.dom.canvases.slice(before)[0].context.calls;
  checkBase(clipCalls, '复制导出');
  const clipTexts = fillTexts(clipCalls);
  assert.deepEqual(clipTexts.filter(item => item.y < 300), [], '复制图上方不写任何字（没有编号）');
  const pointRow = clipTexts.find(item => /^第 1 条 · 点 \(/.test(item.text));
  const rectRow = clipTexts.find(item => /^第 2 条 · 框 \(/.test(item.text));
  assert.ok(pointRow && rectRow, `说明区仍带点/框坐标行：${json(clipTexts.map(item => item.text))}`);
  const pointNumbers = /^第 1 条 · 点 \(([-\d.]+), ([-\d.]+)\)：看这里$/.exec(pointRow.text);
  assert.ok(pointNumbers, `点坐标行格式不能变：${pointRow.text}`);
  assert.equal(Number(pointNumbers[1]), notes[0].point.x);
  assert.equal(Number(pointNumbers[2]), notes[0].point.y);
  const rectNumbers = /^第 2 条 · 框 \(([-\d.]+), ([-\d.]+), ([-\d.]+), ([-\d.]+)\)：这块也要看$/.exec(rectRow.text);
  assert.ok(rectNumbers, `框坐标行格式不能变：${rectRow.text}`);
  assert.deepEqual(rectNumbers.slice(1).map(Number),
    [notes[1].rect.x, notes[1].rect.y, notes[1].rect.width, notes[1].rect.height], '框行是 x/y/宽/高');
  assert.ok(clipTexts.some(item => /上方截图不含编号悬浮标记/.test(String(item.text))), '说明区讲清上方没有悬浮标记');
  const whites = clipCalls.filter(call => call.name === 'fillRect' && call.args[0] === 0 && call.args[1] === 0);
  assert.equal(whites.length, 1, '复制图只铺一次白底');
  assert.equal(whites[0].args[2], 720, '白底铺到说明区宽度');
  assert.notDeepEqual(whites[0].args.slice(0, 4), [40, 40, 80, 40], '纯色遮盖不能被说明区的白底冒充');

  before = h.dom.canvases.length;
  const thumb = await h.editor.thumbnail(300, 300);
  assert.match(String(thumb), /^data:image\/png;base64,/);
  checkBase(h.dom.canvases.slice(before)[0].context.calls, '缩略图');
});

test('显示/隐藏、缩放、删除与撤销都不改批注元数据，导出口始终不带标记', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(60, 60));
  h.type('甲');
  h.save();
  h.drag(at(140, 60));
  h.type('乙');
  h.save();
  h.drag(at(220, 60));
  h.type('丙');
  h.save();
  const snapshot = async () => plain(await h.notes()).map(note => ({ id: note.id, number: note.number, kind: note.kind,
    point: note.point ? { ...note.point } : null, rect: note.rect ? { ...note.rect } : null, text: note.text }));
  const original = await snapshot();
  assert.equal(original.length, 3);

  const toggle = h.q('[data-action="notes-toggle"]');
  h.click(toggle);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  h.click(toggle);
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await snapshot(), original, '显示/隐藏不改元数据');

  h.click(h.q('[data-action="zoom-in"]'));
  h.click(h.q('[data-action="zoom-out"]'));
  h.dom.flushFrames();
  assert.deepEqual(await snapshot(), original, '缩放不改元数据');

  // 删中间那条：剩下两条坐标不变，只是编号重排；撤销后三条原样回来。
  const [, second] = original;
  h.click(h.q(`.ie-marker[data-annotation-id="${second.id}"]`));
  h.click(h.q('[data-action="bubble-delete"]'));
  const afterDelete = await snapshot();
  assert.deepEqual(afterDelete.map(note => note.text), ['甲', '丙']);
  assert.deepEqual(afterDelete[1].point, original[2].point, '删除只重排编号，不改坐标');
  h.key(h.q('.ie-scroll'), { key: 'z', ctrlKey: true });
  assert.deepEqual(await snapshot(), original, '撤销删除后元数据原样回来');

  // 每一步之后三个导出口都不带批注标记。
  const noMarks = async () => {
    let before = h.dom.canvases.length;
    before = h.dom.canvases.length;
    assert.ok(isPng(await h.editor.exportPNG()));
    assert.deepEqual(annotationMarks(h.dom.canvases.slice(before)[0].context.calls), [], '保存导出不带标记');
    before = h.dom.canvases.length;
    await h.editor.exportClipboard();
    assert.deepEqual(annotationMarks(h.dom.canvases.slice(before)[0].context.calls), [], '复制导出不带标记');
    before = h.dom.canvases.length;
    await h.editor.thumbnail();
    assert.deepEqual(annotationMarks(h.dom.canvases.slice(before)[0].context.calls), [], '缩略图不带标记');
  };
  await noMarks();
});

// —— 裁切 ——
// 进裁切会先双维度 fit 整图（四边至少 16 CSS px）并全选当前画面；
// 定框靠 8 个手柄或框内移动，不再默认从空白画布拖框。
const cropMap = h => {
  const t = h.displayTransform();
  return (x, y) => ({ x: t[4] + x * t[0], y: t[5] + y * t[3] });
};
const dragCropPoint = (h, from, to) => {
  const map = cropMap(h);
  h.drag(map(from.x, from.y), map(to.x, to.y));
};
// 抽一帧屏幕预览：只留这一帧新增的调用。
const cropFrame = h => {
  const calls = h.q('.ie-display').context.calls;
  h.dom.flushFrames();
  const from = calls.length;
  h.emit(h.q('.ie-scroll'), 'scroll');
  h.dom.flushFrames();
  return calls.slice(from);
};
test('裁切：进裁切双维度 fit 并全选，手柄只出预览，应用后按源图像素裁小且不重采样', async () => {
  const h = harness();
  await h.open();
  h.tool('crop');
  h.dom.flushFrames();
  // 双维度适应：400×300 图在 400×300 视口里按高度适配，四边至少 16 CSS px。
  const fitZoom = Math.min((400 - 32) / 400, (300 - 32) / 300);
  const t0 = h.displayTransform();
  assert.ok(Math.abs(t0[0] - fitZoom) < 1e-9, `进裁切要 fit 整图：${t0[0]}`);
  assert.ok(300 * t0[0] <= 300 - 32 + 1e-6, '高度方向也完整放进视口');
  assert.deepEqual(plain(h.editor.outputSize), { width: 400, height: 300 });
  assert.match(h.q('.ie-crop-size').textContent, /保留 400 × 300 像素/, '默认全选当前画面');
  assert.equal(h.editor.hasEdits, false, '未应用不进历史');

  // 8 个手柄固定 10 CSS px（屏幕坐标，不随 zoom 缩小）；框外遮罩 + 虚线框只画在预览里。
  const canvasesBefore = h.dom.canvases.length;
  const frame = cropFrame(h);
  assert.equal(frame.filter(call => call.name === 'fillRect' && call.args[2] === 10 && call.args[3] === 10).length, 8, '8 个手柄');
  assert.ok(frame.filter(call => call.name === 'fillRect').length >= 12, '框外遮罩 + 手柄');
  assert.ok(frame.some(call => call.name === 'strokeRect'), '虚线预览框');
  assert.equal(h.dom.canvases.length, canvasesBefore, '未确认不产生导出画布');

  // 拖右下手柄向上左（反向拖）只缩框；再拖左上手柄缩到 (100,80)-(300,200)。
  dragCropPoint(h, { x: 400, y: 300 }, { x: 300, y: 200 });
  assert.match(h.q('.ie-crop-size').textContent, /保留 300 × 200 像素/);
  dragCropPoint(h, { x: 0, y: 0 }, { x: 100, y: 80 });
  assert.match(h.q('.ie-crop-size').textContent, /保留 200 × 120 像素/);

  // 框内拖动是移动（夹在当前画面内），尺寸不变；框内不是新框。
  dragCropPoint(h, { x: 150, y: 120 }, { x: 190, y: 160 });
  assert.match(h.q('.ie-crop-size').textContent, /保留 200 × 120 像素/, '移动不改尺寸');
  dragCropPoint(h, { x: 190, y: 160 }, { x: 150, y: 120 });
  assert.match(h.q('.ie-crop-size').textContent, /保留 200 × 120 像素/);

  h.click(h.q('[data-action="crop-apply"]'));
  assert.deepEqual(plain(h.editor.cropRect), { x: 100, y: 80, width: 200, height: 120 }, 'crop 存源图绝对整数矩形');
  assert.deepEqual(plain(h.editor.outputSize), { width: 200, height: 120 });
  assert.equal(h.editor.hasEdits, true, '应用后进历史');
  assert.match(h.q('.ie-crop-size').textContent, /当前画面 200 × 120 像素/);
  assert.equal(h.q('[data-action="crop-apply"]').disabled, true, '没有草稿时应用按钮禁用');

  // 裁后屏幕帧只画当前画面，不重复平移；左边缘按当前画面居中，上边保留 16px。
  const beforeCroppedFrame = h.q('.ie-display').context.calls.length;
  h.dom.flushFrames();
  const croppedFrame = h.q('.ie-display').context.calls.slice(beforeCroppedFrame);
  assert.equal(croppedFrame.some(call => call.name === 'translate'), false, '屏幕帧不能重复平移裁切原点');
  const screenTransform = h.displayTransform();
  assert.ok(Math.abs(screenTransform[4] + 100 * screenTransform[0] - Math.max(16, (400 - 200 * screenTransform[0]) / 2)) < 1e-6,
    '裁切左边缘在当前画面居中位置');
  assert.ok(Math.abs(screenTransform[5] + 80 * screenTransform[3] - 16) < 1e-6, '裁切上边缘仍保留 16px 留白');

  // 导出尺寸跟着当前画面，且只做平移不缩放。
  const png = await h.editor.exportPNG();
  assert.equal(png[8], 200 & 0xff); assert.equal(png[9], 120 & 0xff);
  const exportCalls = h.dom.canvases.at(-1).context.calls;
  assert.deepEqual(exportCalls.find(call => call.name === 'translate').args, [-100, -80], '导出把视窗原点搬到 (0,0)');
  assert.deepEqual(exportCalls.find(call => call.name === 'rect').args, [100, 80, 200, 120], 'clip 仍用源坐标矩形');
  assert.deepEqual(clipDevice(exportCalls), { x: 0, y: 0, width: 200, height: 120 },
    'translate 之后 clip 的设备坐标必须刚好从 (0,0) 开始盖满输出');
  assert.equal(exportCalls.some(call => call.name === 'scale'), false, '裁切不重采样');
  assert.deepEqual(exportCalls.find(call => call.name === 'drawImage' && call.source === 'bitmap').args, [0, 0]);

  // 显示/隐藏批注、缩放都不动裁切矩形。
  h.click(h.q('[data-action="notes-toggle"]'));
  h.click(h.q('[data-action="notes-toggle"]'));
  h.click(h.q('[data-action="zoom-in"]'));
  assert.deepEqual(plain(h.editor.cropRect), { x: 100, y: 80, width: 200, height: 120 }, '开关/缩放不改 crop');

  // 再次裁切：重新进裁切仍是 fit + 全选当前画面，手柄相对当前画面选，op 仍是源图绝对矩形。
  h.tool('pen');
  h.tool('crop');
  h.dom.flushFrames();
  dragCropPoint(h, { x: 100, y: 80 }, { x: 150, y: 100 });
  dragCropPoint(h, { x: 300, y: 200 }, { x: 250, y: 150 });
  h.click(h.q('[data-action="crop-apply"]'));
  assert.deepEqual(plain(h.editor.cropRect), { x: 150, y: 100, width: 100, height: 50 });
  assert.deepEqual(plain(h.editor.outputSize), { width: 100, height: 50 });

  // 撤销/重做逐层回到上一个视窗，再回到全图。
  h.key(h.q('.ie-scroll'), { key: 'z', ctrlKey: true });
  assert.deepEqual(plain(h.editor.outputSize), { width: 200, height: 120 });
  h.key(h.q('.ie-scroll'), { key: 'z', ctrlKey: true });
  assert.deepEqual(plain(h.editor.outputSize), { width: 400, height: 300 });
  assert.equal(h.editor.cropRect, undefined);
  h.key(h.q('.ie-scroll'), { key: 'y', ctrlKey: true });
  assert.deepEqual(plain(h.editor.cropRect), { x: 100, y: 80, width: 200, height: 120 });
  h.key(h.q('.ie-scroll'), { key: 'y', ctrlKey: true });
  assert.deepEqual(plain(h.editor.cropRect), { x: 150, y: 100, width: 100, height: 50 });
});

test('拖裁切手柄/移动框时 Esc 取消并释放手势，后续移动和松手不会复活草稿', async () => {
  for (const mode of ['resize', 'move']) {
    const h = harness(); await h.open(); h.tool('crop'); h.dom.flushFrames();
    // 先把全选框缩到 (0,0,300,200)，再在右下角手柄或框内下压。
    dragCropPoint(h, { x: 400, y: 300 }, { x: 300, y: 200 });
    const map = cropMap(h);
    const start = mode === 'resize' ? map(300, 200) : map(150, 100);
    const scroller = h.q('.ie-scroll');
    const event = (type, x, y) => ({ type, clientX: x, clientY: y, pointerId: 7, button: 0,
      buttons: type === 'pointerup' ? 0 : 1, preventDefault() {} });
    h.emit(scroller, 'pointerdown', event('pointerdown', start.x, start.y));
    h.emit(scroller, 'pointermove', event('pointermove', start.x - 30, start.y - 20));
    h.key(scroller, { key: 'Escape' });
    assert.equal(h.editor.isOpen, true, 'Esc 只取消裁切，不关闭编辑器');
    assert.equal(scroller.hasPointerCapture(7), false, '取消时释放指针捕获');
    h.emit(scroller, 'pointermove', event('pointermove', start.x - 60, start.y - 40));
    h.emit(scroller, 'pointerup', event('pointerup', start.x - 70, start.y - 50));
    assert.equal(h.q('[data-action="crop-apply"]').disabled, true, '后续指针事件不复活草稿');
    assert.equal(h.editor.hasEdits, false);
    assert.equal(h.editor.cropRect, undefined);
    assert.ok(isPng(await h.editor.exportPNG()), '取消后可以直接导出');
  }
});

test('未应用的裁切：取消/Esc/切工具/关闭都不导出旧范围；草稿期间保存复制被禁用', async () => {
  const h = harness();
  await h.open();
  h.tool('crop');
  h.drag(at(100, 80), at(300, 200));
  assert.equal(h.q('[data-action="save"]').disabled, true, '草稿期间保存按钮禁用');
  assert.equal(h.q('[data-action="copy"]').disabled, true, '草稿期间复制按钮禁用');
  for (const call of [async () => h.editor.exportPNG(), async () => h.editor.exportClipboard(),
    async () => h.editor.thumbnail()]) {
    await assert.rejects(call(), /裁切框还没应用/);
  }
  assert.equal(h.editor.hasEdits, false, '拒绝导出不自动应用裁切');

  // 取消按钮：只是丢掉草稿。
  h.click(h.q('[data-action="crop-cancel"]'));
  assert.match(h.q('.ie-status').textContent, /已取消未应用的裁切/);
  assert.equal(h.q('[data-action="save"]').disabled, false);
  assert.equal(h.editor.cropRect, undefined);
  assert.equal(h.editor.hasEdits, false);

  // Esc 优先取消草稿，不关编辑器。
  h.drag(at(120, 90), at(260, 180));
  const escape = h.key(h.q('.ie-scroll'), { key: 'Escape' });
  assert.equal(escape.defaultPrevented, true);
  assert.match(h.q('.ie-status').textContent, /已取消未应用的裁切/);
  assert.equal(h.calls.close, 0);
  assert.equal(h.editor.isOpen, true);

  // 切工具也取消，不会把旧框带到别的工具。
  h.drag(at(140, 100), at(240, 180));
  h.tool('pen');
  assert.match(h.q('.ie-status').textContent, /已取消未应用的裁切/);
  assert.equal(h.editor.hasEdits, false);

  // 关闭编辑器前先丢掉草稿；onClose 里的缩略预览不应被草稿拦住。
  h.tool('crop');
  h.drag(at(150, 110), at(250, 190));
  h.editor.close();
  assert.equal(h.calls.close, 1);
  assert.equal(h.editor.cropRect, undefined, '关闭不会应用草稿');
  assert.ok(String(await h.editor.thumbnail()).startsWith('data:image/png'));
});

test('裁切后：马赛克仍用源图网格；批注按交集筛选、导出坐标投影回裁后图', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(60, 60)); h.type('范围外'); h.save();
  h.drag(at(300, 60)); h.type('范围内'); h.save();
  h.tool('region');
  h.drag(at(150, 150), at(300, 250)); h.type('半截框'); h.save();
  assert.deepEqual(h.numbers(), [1, 2, 3]);
  const beforeIds = h.markers().map(item => item.id);

  // 裁到右半边：源图 200..400 × 40..280（手柄定框）。
  h.tool('crop');
  h.dom.flushFrames();
  dragCropPoint(h, { x: 0, y: 0 }, { x: 200, y: 40 });
  dragCropPoint(h, { x: 400, y: 300 }, { x: 400, y: 280 });
  h.click(h.q('[data-action="crop-apply"]'));
  assert.deepEqual(plain(h.editor.cropRect), { x: 200, y: 40, width: 200, height: 240 });

  // 范围外的点批注隐藏；剩下的按可见顺序重编号，id 不变。
  const visibleIds = h.markers().map(item => item.id);
  assert.equal(visibleIds.length, 2);
  assert.deepEqual(visibleIds, [beforeIds[1], beforeIds[2]], '隐藏第一条，其余保留原 id');
  assert.deepEqual(h.numbers(), [1, 2]);

  // 裁后继续涂马赛克：网格仍是源图尺寸，不重建、不挪格。
  const mosaicCanvases = () => h.dom.canvases.filter(canvas => canvas.width === Math.ceil(400 / 12) && canvas.height === Math.ceil(300 / 12));
  assert.equal(mosaicCanvases().length, 0, '还没涂过马赛克');
  h.dom.flushFrames();
  const transform = h.displayTransform();
  const screenAt = (x, y) => ({ x: transform[4] + x * transform[0], y: transform[5] + y * transform[3] });
  h.tool('mosaic');
  h.drag(screenAt(220, 120), screenAt(320, 160));
  h.dom.flushFrames();
  assert.equal(mosaicCanvases().length, 1, '马赛克缓存用源图网格（34×25），不是裁后 17×20');

  // 复制出口：尺寸是裁后尺寸，坐标是裁后坐标；半截框被裁到画面内。
  const panel = await h.copy();
  assert.deepEqual(plain(h.editor.outputSize), { width: 200, height: 240 });
  assert.deepEqual(panel.annotations.map(note => note.kind), ['point', 'region']);
  assert.ok(Math.abs(panel.annotations[0].point.x - 100) < 1e-6 && Math.abs(panel.annotations[0].point.y - 20) < 1e-6,
    `点坐标要减视窗原点：${json(panel.annotations[0].point)}`);
  assert.deepEqual(panel.annotations[1].rect, { x: 0, y: 110, width: 100, height: 100 },
    '框取与视窗的交集再减原点');
  assert.equal(panel.annotations.length, 2, '范围外的批注不进导出');

  // 导出口一律不带批注标记，且都只画当前画面。
  const pngBefore = h.dom.canvases.length;
  assert.ok(isPng(await h.editor.exportPNG()));
  const pngCalls = h.dom.canvases.slice(pngBefore)[0].context.calls;
  assert.deepEqual(annotationMarks(pngCalls, { brushRadius: 10 }), [], '保存不带标记');
  assert.deepEqual(pngCalls.find(call => call.name === 'translate').args, [-200, -40]);
  assert.ok(pngCalls.some(call => call.name === 'drawImage' && call.source.startsWith('canvas#')), '马赛克仍在');
  const mosaicDraw = pngCalls.find(call => call.name === 'drawImage' && call.source.startsWith('canvas#'));
  assert.deepEqual(mosaicDraw.args, [0, 0, 408, 300], '马赛克网格按源图尺寸铺（34×12=408）');

  // 撤销裁切（先撤掉裁后那笔马赛克，再撤裁切）：批注回到 3 条，源坐标一个像素没变。
  h.key(h.q('.ie-scroll'), { key: 'z', ctrlKey: true });
  h.key(h.q('.ie-scroll'), { key: 'z', ctrlKey: true });
  assert.equal(h.editor.cropRect, undefined, '撤销回到全图');
  assert.deepEqual(h.numbers(), [1, 2, 3]);
  const back = await h.copy();
  assert.deepEqual(plain(h.editor.outputSize), { width: 400, height: 300 });
  assert.deepEqual(back.annotations.map(note => note.point ?? note.rect).slice(0, 2),
    [{ x: 60, y: 60 }, { x: 300, y: 60 }], '撤销后回到源坐标');
});

test('跨左/上边的框批注：裁后 DOM 锚点落在新画面左上，导出取交集，撤销回源矩形', async () => {
  const h = harness();
  await h.open();
  h.tool('region');
  h.drag(at(40, 30), at(160, 140)); // 源矩形 (40,30)-(160,140)
  h.type('跨左上');
  h.save();
  const sourceRect = plain((await h.notes())[0].rect);
  assert.deepEqual(sourceRect, { x: 40, y: 30, width: 120, height: 110 });

  // 裁到 (100,80)-(400,300)：框只在视窗里剩 (100,80)-(160,140)，即 60×60。
  h.tool('crop');
  h.dom.flushFrames();
  dragCropPoint(h, { x: 0, y: 0 }, { x: 100, y: 80 });
  h.click(h.q('[data-action="crop-apply"]'));
  h.dom.flushFrames();
  const transform = h.displayTransform();
  const marker = h.markers()[0];
  const ringX = marker.ringLeft + marker.ringSize / 2, ringY = marker.ringTop + marker.ringSize / 2;
  assert.ok(Math.abs(ringX - (transform[4] + 100 * transform[0])) <= 1.5, `锚点要贴视窗左边，不是被裁掉的 40：${ringX}`);
  assert.ok(Math.abs(ringY - (transform[5] + 80 * transform[3])) <= 1.5, `锚点要贴视窗上边，不是被裁掉的 30：${ringY}`);
  const panel = await h.copy();
  assert.deepEqual(panel.annotations[0].rect, { x: 0, y: 0, width: 60, height: 60 }, '导出取交集再减视窗原点');

  // 撤销裁切：DOM 锚点与导出矩形都回到源坐标。
  h.key(h.q('.ie-scroll'), { key: 'z', ctrlKey: true });
  h.dom.flushFrames();
  const restored = h.markers()[0];
  const back = h.displayTransform();
  assert.ok(Math.abs(restored.ringLeft + restored.ringSize / 2 - (back[4] + 40 * back[0])) <= 1.5, '撤销后锚点回到源矩形左上');
  assert.deepEqual(plain((await h.copy()).annotations[0].rect), sourceRect, '撤销后矩形原样恢复');
});

test('裁成当前画面本身：不追加历史、不截断 redo、不改 hasEdits', async () => {
  const h = harness();
  await h.open();
  h.tool('crop');
  h.dom.flushFrames();
  dragCropPoint(h, { x: 400, y: 300 }, { x: 300, y: 200 });
  dragCropPoint(h, { x: 0, y: 0 }, { x: 100, y: 80 });
  h.click(h.q('[data-action="crop-apply"]'));
  assert.equal(h.editor.hasEdits, true);
  h.key(h.q('.ie-scroll'), { key: 'z', ctrlKey: true });
  assert.equal(h.editor.hasEdits, false);
  assert.equal(h.q('[data-action="redo"]').disabled, false, '前提：此时有可重做历史');

  h.tool('pen');
  h.tool('crop');
  h.dom.flushFrames();
  assert.match(h.q('.ie-crop-size').textContent, /保留 400 × 300 像素/);
  h.click(h.q('[data-action="crop-apply"]'));
  assert.match(h.q('.ie-status').textContent, /没有变化/);
  assert.equal(h.editor.hasEdits, false, '全图裁切不追加历史');
  assert.equal(h.q('[data-action="redo"]').disabled, false, 'redo 不能被无意义裁切截断');
  h.key(h.q('.ie-scroll'), { key: 'y', ctrlKey: true });
  assert.deepEqual(plain(h.editor.cropRect), { x: 100, y: 80, width: 200, height: 120 }, '重做仍能回到上一裁切');
});

test('裁切后的三个输出尺寸：PNG/复制/缩略图都按当前画面，复制仍是一张图', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(300, 60)); h.type('右半边'); h.save();
  h.tool('crop');
  h.dom.flushFrames();
  dragCropPoint(h, { x: 0, y: 0 }, { x: 200, y: 40 });
  dragCropPoint(h, { x: 400, y: 300 }, { x: 400, y: 280 });
  h.click(h.q('[data-action="crop-apply"]'));
  const view = { x: 200, y: 40, width: 200, height: 240 };

  const png = await h.editor.exportPNG();
  assert.equal(png[8], 200 & 0xff); assert.equal(png[9], 240 & 0xff);
  assert.deepEqual(clipDevice(h.dom.canvases.at(-1).context.calls), { x: 0, y: 0, width: 200, height: 240 },
    'PNG 的裁剪区设备左上必须是 (0,0)');

  const panel = await h.copy();
  assert.deepEqual(plain(h.editor.outputSize), { width: 200, height: 240 });
  assert.equal(panel.annotations.length, 1);

  const clip = await h.editor.exportClipboard();
  assert.deepEqual(plain(clip.crop), view, '复制结果带上 crop 供主进程验证');
  const size = plain(clip.clipboardSize);
  assert.equal(size.width, 720, '窄的裁后图仍补白到 720');
  assert.ok(size.height > 240);
  const clipCalls = h.dom.canvases.at(-1).context.calls;
  assert.deepEqual(clipDevice(clipCalls), { x: 0, y: 0, width: 200, height: 240 }, '复制图的裁剪区左上在 (0,0) 且宽高正确');
  assert.deepEqual(clipCalls.find(call => call.name === 'translate').args, [-200, -40]);
  assert.deepEqual(clipCalls.find(call => call.name === 'drawImage' && call.source === 'bitmap').args, [0, 0], '裁后图仍在 (0,0)');
  const rows = fillTexts(clipCalls).filter(item => item.y >= 240);
  assert.equal(rows[1].text, '图像尺寸：200 × 240 像素');
  assert.ok(rows.some(item => item.text === `第 1 条 · 点 (100, 20)：右半边`), `说明区坐标要投影：${json(rows.map(r => r.text))}`);
  assert.deepEqual(annotationMarks(clipCalls), [], '复制图不带标记');

  const thumbBefore = h.dom.canvases.length;
  assert.match(String(await h.editor.thumbnail(100, 100)), /^data:image\/png;base64,/);
  const thumbCanvas = h.dom.canvases.slice(thumbBefore)[0];
  const thumbScale = thumbCanvas.context.calls.find(call => call.name === 'scale').args;
  assert.ok(Math.abs(thumbScale[0] - 83 / 200) < 1e-9 && Math.abs(thumbScale[1] - 100 / 240) < 1e-9,
    `缩略图按裁后 200×240 等比缩（83×100）：${json(thumbScale)}`);
  const thumbClip = clipDevice(thumbCanvas.context.calls);
  assert.ok(Math.abs(thumbClip.x) < 1e-9 && Math.abs(thumbClip.y) < 1e-9 &&
    Math.abs(thumbClip.width - 83) < 1e-9 && Math.abs(thumbClip.height - 100) < 1e-9,
    `缩略图裁剪区要刚好盖满输出：${json(thumbClip)}`);
  assert.deepEqual(thumbCanvas.context.calls.find(call => call.name === 'translate').args, [-200, -40], '缩略图也按视窗平移');
  assert.deepEqual(annotationMarks(thumbCanvas.context.calls), [], '缩略图不带标记');
});

test('裁切状态：同 token 重开保留，reset / 新 token 回到全图', async () => {
  const h = harness();
  await h.open();
  h.tool('crop');
  h.dom.flushFrames();
  dragCropPoint(h, { x: 400, y: 300 }, { x: 300, y: 200 });
  dragCropPoint(h, { x: 0, y: 0 }, { x: 100, y: 80 });
  h.click(h.q('[data-action="crop-apply"]'));
  assert.deepEqual(plain(h.editor.outputSize), { width: 200, height: 120 });

  h.editor.close();
  await h.open();
  assert.deepEqual(plain(h.editor.cropRect), { x: 100, y: 80, width: 200, height: 120 }, '同 token 重开保留裁切');
  assert.deepEqual(plain(h.editor.outputSize), { width: 200, height: 120 });
  // 没批注时复制仍是原尺寸图，但仍带 crop 与裁后尺寸。
  const clip = await h.editor.exportClipboard();
  assert.deepEqual(plain(clip.crop), { x: 100, y: 80, width: 200, height: 120 });
  assert.equal('clipboardSize' in clip, false, '无批注不加说明区');
  assert.equal(clip.png[8], 200 & 0xff); assert.equal(clip.png[9], 120 & 0xff);

  h.editor.reset();
  assert.equal(h.editor.cropRect, undefined);
  assert.equal(h.editor.isOpen, false, 'reset 后编辑器是关的，输出尺寸不再有意义');

  await h.open({ token: 'doc-2' });
  assert.equal(h.editor.cropRect, undefined, '新 token 不带上一张的裁切');
  assert.deepEqual(plain(h.editor.outputSize), { width: 400, height: 300 });
});

// —— 裁切手柄 / 导航 ——
const screenMap = h => {
  const t = h.displayTransform();
  return (x, y) => ({ x: t[4] + x * t[0], y: t[5] + y * t[3] });
};
const wheelOn = (h, values) => {
  let prevented = false;
  h.emit(h.q('.ie-scroll'), 'wheel', { deltaX: 0, deltaY: 0, deltaMode: 0, clientX: 120, clientY: 90,
    preventDefault() { prevented = true; }, ...values });
  return prevented;
};
const panDown = (h, target, values = {}) => {
  let prevented = false, stopped = false;
  h.emit(h.q('.ie-workspace'), 'pointerdown', { target, clientX: 200, clientY: 150, pointerId: 9,
    button: 1, buttons: 4, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; }, ...values });
  return { prevented, stopped };
};
const panMove = (h, x, y, buttons = 4) => h.emit(h.q('.ie-scroll'), 'pointermove', { clientX: x, clientY: y, pointerId: 9, button: 0, buttons });
const panUp = (h, x, y) => h.emit(h.q('.ie-scroll'), 'pointerup', { clientX: x, clientY: y, pointerId: 9, button: 0, buttons: 0 });

for (const [key, from, to, expected] of [
  ['nw', { x: 0, y: 0 }, { x: 20, y: 10 }, { x: 20, y: 10, width: 380, height: 290 }],
  ['n', { x: 200, y: 0 }, { x: 200, y: 10 }, { x: 0, y: 10, width: 400, height: 290 }],
  ['ne', { x: 400, y: 0 }, { x: 380, y: 10 }, { x: 0, y: 10, width: 380, height: 290 }],
  ['e', { x: 400, y: 150 }, { x: 380, y: 150 }, { x: 0, y: 0, width: 380, height: 300 }],
  ['se', { x: 400, y: 300 }, { x: 380, y: 290 }, { x: 0, y: 0, width: 380, height: 290 }],
  ['s', { x: 200, y: 300 }, { x: 200, y: 290 }, { x: 0, y: 0, width: 400, height: 290 }],
  ['sw', { x: 0, y: 300 }, { x: 20, y: 290 }, { x: 20, y: 0, width: 380, height: 290 }],
  ['w', { x: 0, y: 150 }, { x: 20, y: 150 }, { x: 20, y: 0, width: 380, height: 300 }]
]) test(`裁切手柄 ${key}：拖到指定位置只改预览，应用后得到整数源矩形`, async () => {
  const h = harness();
  await h.open();
  h.tool('crop');
  h.dom.flushFrames();
  dragCropPoint(h, from, to);
  assert.equal(h.editor.hasEdits, false, '拖手柄不进历史');
  h.click(h.q('[data-action="crop-apply"]'));
  assert.deepEqual(plain(h.editor.cropRect), expected);
});

test('裁切：框内移动夹在当前画面内，框外开始可重新拖框', async () => {
  const h = harness();
  await h.open();
  h.tool('crop');
  h.dom.flushFrames();
  dragCropPoint(h, { x: 400, y: 300 }, { x: 300, y: 200 }); // 框 (0,0,300,200)
  // 往右下拖到底：只能移到 (100,100)，不越出当前画面。
  dragCropPoint(h, { x: 150, y: 100 }, { x: 900, y: 900 });
  h.click(h.q('[data-action="crop-apply"]'));
  assert.deepEqual(plain(h.editor.cropRect), { x: 100, y: 100, width: 300, height: 200 }, '移动被夹在画面内');

  const h2 = harness();
  await h2.open();
  h2.tool('crop');
  h2.dom.flushFrames();
  dragCropPoint(h2, { x: 0, y: 0 }, { x: 100, y: 100 }); // 先缩成 (100,100,300,200)
  // 从左上角外侧（画布内、框外）重新拖框：新框从指针位置开始，旧框丢弃。
  const map = screenMap(h2);
  h2.drag(map(40, 40), map(200, 150));
  h2.click(h2.q('[data-action="crop-apply"]'));
  assert.deepEqual(plain(h2.editor.cropRect), { x: 40, y: 40, width: 160, height: 110 }, '框外重新拖框');
});

test('裁切框方向键 1px / Shift 10px，输入框与按钮焦点不被抢', async () => {
  const h = harness();
  await h.open();
  h.tool('crop');
  h.dom.flushFrames();
  dragCropPoint(h, { x: 400, y: 300 }, { x: 300, y: 200 }); // (0,0,300,200)，左右上下都有余量
  const scroller = h.q('.ie-scroll');
  assert.equal(h.key(scroller, { key: 'ArrowRight' }).defaultPrevented, true);
  assert.equal(h.key(scroller, { key: 'ArrowDown', shiftKey: true }).defaultPrevented, true);
  assert.equal(h.key(scroller, { key: 'PageDown' }).defaultPrevented, false, 'PageUp/PageDown 保持原生滚动');
  h.click(h.q('[data-action="crop-apply"]'));
  assert.deepEqual(plain(h.editor.cropRect), { x: 1, y: 10, width: 300, height: 200 }, '方向键 1px / Shift 10px');

  // 数字输入框/按钮焦点：方向键归控件，不能移动裁切框。
  const h2 = harness();
  await h2.open();
  h2.tool('crop');
  h2.dom.flushFrames();
  dragCropPoint(h2, { x: 0, y: 0 }, { x: 100, y: 100 });
  const widthInput = h2.q('[data-setting="width"]');
  const onInput = h2.key(widthInput, { key: 'ArrowRight' });
  assert.equal(onInput.defaultPrevented, false, '输入框里的方向键不被画布吞掉');
  const onButton = h2.key(h2.q('[data-action="crop-apply"]'), { key: 'ArrowDown' });
  assert.equal(onButton.defaultPrevented, false, '按钮焦点上的方向键不被抢');
  h2.click(h2.q('[data-action="crop-apply"]'));
  assert.deepEqual(plain(h2.editor.cropRect), { x: 100, y: 100, width: 300, height: 200 }, '焦点在控件上时框不动');
});

test('裁切：Enter 应用；重复点裁切按钮不重置正在调整的框', async () => {
  const h = harness();
  await h.open();
  h.tool('crop');
  h.dom.flushFrames();
  dragCropPoint(h, { x: 0, y: 0 }, { x: 100, y: 100 });
  const transformBefore = h.displayTransform();
  // 重复点同一个工具按钮：不重建全选、不重 fit。
  h.tool('crop');
  h.dom.flushFrames();
  assert.match(h.q('.ie-crop-size').textContent, /保留 300 × 200 像素/);
  assert.deepEqual(h.displayTransform(), transformBefore, '重复点不重置缩放');
  const enter = h.key(h.q('.ie-scroll'), { key: 'Enter' });
  assert.equal(enter.defaultPrevented, true);
  assert.deepEqual(plain(h.editor.cropRect), { x: 100, y: 100, width: 300, height: 200 }, 'Enter 应用裁切');
});

test('适合整图：长图双维度适应（最小缩放降到 0.001），裁切进入也用它', async () => {
  const h = harness({ width: 200, height: 29000,
    dom: { workspace: { width: 420, height: 320 }, scroller: { width: 400, height: 300 } } });
  await h.open();
  h.dom.flushFrames();
  h.click(h.q('[data-action="fit-image"]'));
  h.dom.flushFrames();
  assert.equal(h.q('[data-action="fit"]').textContent, '适合宽度', '保留原有适合宽度');
  assert.equal(h.q('[data-action="fit-image"]').textContent, '适合整图');
  const fit = h.displayTransform()[0];
  assert.ok(Math.abs(fit - Math.min(368 / 200, 268 / 29000)) < 1e-9, `适合整图按双维度：${fit}`);
  assert.ok(29000 * fit <= 268 + 1e-6, '整张长图能完整放进视口');
  assert.ok(fit >= 0.001, '不突破最小缩放 0.001');
  h.tool('crop');
  h.dom.flushFrames();
  assert.ok(Math.abs(h.displayTransform()[0] - Math.min(368 / 200, 268 / 29000)) < 1e-9, '进裁切也双维度 fit');
  assert.match(h.q('.ie-crop-size').textContent, /保留 200 × 29000 像素/);
  h.click(h.q('[data-action="crop-apply"]'));
  assert.match(h.q('.ie-status').textContent, /没有变化/);
  assert.equal(h.editor.hasEdits, false, '全图裁切不追加历史');
});

test('滚轮：上下/Shift 横移/纯 deltaX/Ctrl 指针缩放/线页模式，均不改 zoom 或历史', async () => {
  const h = harness({ width: 2000, height: 1200,
    dom: { workspace: { width: 420, height: 320 }, scroller: { width: 400, height: 300 } } });
  await h.open();
  h.click(h.q('[data-action="actual"]'));
  h.dom.flushFrames();
  const scroller = h.q('.ie-scroll');
  const zoomBefore = h.displayTransform()[0];
  const start = { left: scroller.scrollLeft, top: scroller.scrollTop };
  const clamp = (value, max) => Math.max(0, Math.min(max, value));
  assert.equal(wheelOn(h, { deltaY: 100 }), true);
  assert.equal(scroller.scrollTop, clamp(start.top + 100, 932));
  assert.equal(scroller.scrollLeft, start.left);
  wheelOn(h, { deltaY: 100, shiftKey: true });
  assert.equal(scroller.scrollLeft, clamp(start.left + 100, 1632), 'Shift 滚轮横移');
  wheelOn(h, { deltaX: 50 });
  assert.equal(scroller.scrollLeft, clamp(start.left + 150, 1632), '纯 deltaX 也横移');
  wheelOn(h, { deltaY: 2, deltaMode: 1 });
  assert.equal(scroller.scrollTop, clamp(start.top + 132, 932), '行模式 16px/行');
  wheelOn(h, { deltaY: 1, deltaMode: 2 });
  assert.equal(scroller.scrollTop, clamp(start.top + 432, 932), '页模式一页 = 视口高');
  wheelOn(h, { deltaY: 99999 });
  assert.equal(scroller.scrollTop, 932, '滚动位置夹在合法范围');
  wheelOn(h, { deltaY: -100 });
  assert.equal(scroller.scrollTop, 832);
  assert.equal(h.displayTransform()[0], zoomBefore, '普通滚轮不改 zoom');
  assert.equal(h.editor.hasEdits, false, '滚动不进历史');

  // Ctrl+滚轮在指针位置缩放，仍不改历史。
  h.dom.flushFrames();
  const t0 = h.displayTransform();
  const px = 120, py = 90, sx = (px - t0[4]) / t0[0], sy = (py - t0[5]) / t0[3];
  wheelOn(h, { deltaY: -100, ctrlKey: true });
  h.dom.flushFrames();
  const t1 = h.displayTransform();
  assert.ok(t1[0] > t0[0], 'Ctrl 滚轮放大');
  assert.ok(Math.abs(t0[4] + sx * t0[0] - (t1[4] + sx * t1[0])) < 0.5, '指针下的点不动');
  assert.ok(Math.abs(t0[5] + sy * t0[3] - (t1[5] + sy * t1[3])) < 0.5);
  assert.equal(h.editor.hasEdits, false);
});

test('滚轮：绘制中禁轮不吃掉文字区滚动，拖动不改历史', async () => {
  const h = harness();
  await h.open();
  h.click(h.q('[data-action="actual"]'));
  h.dom.flushFrames();
  const scroller = h.q('.ie-scroll');
  const map = screenMap(h);
  h.tool('pen');
  h.drag(map(60, 60), map(160, 120)); // 完成一笔，制造可重做/历史
  const historyLength = h.q('[data-action="redo"]').disabled;
  const scrollBefore = scroller.scrollTop;
  // 画笔按住时滚轮：不滚、不缩放、不额外画。
  h.emit(scroller, 'pointerdown', { clientX: map(200, 150).x, clientY: map(200, 150).y, pointerId: 3, button: 0, buttons: 1, preventDefault() {} });
  const prevented = wheelOn(h, { deltaY: 120 });
  assert.equal(prevented, true);
  assert.equal(scroller.scrollTop, scrollBefore, '绘制中滚轮不滚动');
  h.emit(scroller, 'pointermove', { clientX: map(260, 200).x, clientY: map(260, 200).y, pointerId: 3, button: 0, buttons: 1, preventDefault() {} });
  h.emit(scroller, 'pointerup', { clientX: map(260, 200).x, clientY: map(260, 200).y, pointerId: 3, button: 0, buttons: 0, preventDefault() {} });
  assert.equal(h.q('[data-action="redo"]').disabled, historyLength, '只多了一笔，不因滚轮多出 op');

  // 滚动条区域按下不当画笔（clientWidth 守卫保留）。
  const bounds = scroller.getBoundingClientRect();
  h.tool('pen');
  h.emit(scroller, 'pointerdown', { clientX: bounds.left + scroller.clientWidth + 4, clientY: bounds.top + 40, pointerId: 6, button: 0, buttons: 1, preventDefault() {} });
  h.emit(scroller, 'pointerup', { clientX: bounds.left + scroller.clientWidth + 4, clientY: bounds.top + 40, pointerId: 6, button: 0, buttons: 0 });
  assert.equal(h.q('[data-action="redo"]').disabled, true, '滚动条上的按下不产生笔迹');

  // 气泡输入框里的滚轮不拦。
  h.tool('point');
  h.drag(map(100, 100));
  const bubbleField = h.field();
  let preventedOnField = false;
  h.emit(scroller, 'wheel', { target: bubbleField, deltaY: 120, deltaMode: 0, preventDefault() { preventedOnField = true; } });
  assert.equal(preventedOnField, false, '输入框滚轮不拦');
  assert.equal(scroller.scrollTop, scrollBefore);
});

test('中键拖拽临时平移：不改工具、不产生 op、不打开标记，滚轮值夹紧', async () => {
  const h = harness({ width: 1200, height: 900,
    dom: { workspace: { width: 420, height: 320 }, scroller: { width: 400, height: 300 } } });
  await h.open();
  h.click(h.q('[data-action="actual"]'));
  h.dom.flushFrames();
  h.tool('point');
  const map = screenMap(h);
  h.drag(map(100, 100));
  h.type('标记');
  h.save();
  const scroller = h.q('.ie-scroll');
  const marker = h.q('.ie-marker');
  const before = { left: scroller.scrollLeft, top: scroller.scrollTop };
  const start = panDown(h, marker);
  assert.equal(start.prevented, true, '中键默认自动滚动要拦下');
  assert.equal(start.stopped, true, '标记层不能截走平移手势');
  assert.equal(scroller.style.cursor, 'grabbing');
  panMove(h, 150, 120);
  assert.equal(scroller.scrollLeft, before.left + 50);
  assert.equal(scroller.scrollTop, before.top + 30);
  panUp(h, 150, 120);
  assert.equal(h.bubble().hidden, true, '平移不打开批注');
  assert.equal(h.q('[data-tool="point"]').getAttribute('aria-pressed'), 'true', '平移不换工具');
  assert.equal(h.editor.hasEdits, true);

  // 中键 pointerup 不能替画笔提交或取消：非同一 pointerId 的 up 被忽略，最终左键松手只提交一笔。
  h.tool('pen');
  h.emit(scroller, 'pointerdown', { clientX: 120, clientY: 120, pointerId: 2, button: 0, buttons: 1, preventDefault() {} });
  h.emit(scroller, 'pointermove', { clientX: 180, clientY: 160, pointerId: 2, button: 0, buttons: 1 });
  h.emit(scroller, 'pointerup', { clientX: 180, clientY: 160, pointerId: 3, button: 1, buttons: 0 });
  h.emit(scroller, 'pointermove', { clientX: 220, clientY: 190, pointerId: 2, button: 0, buttons: 1 });
  h.emit(scroller, 'pointerup', { clientX: 220, clientY: 190, pointerId: 2, button: 0, buttons: 0 });
  h.key(scroller, { key: 'z', ctrlKey: true });
  h.key(scroller, { key: 'z', ctrlKey: true });
  assert.equal(h.editor.hasEdits, false, '两次撤销后回到空历史：中键 up 没额外提交也没取消画笔');

  // 滚动条上的中键按下不归临时平移（交给滚动条）。
  const barBounds = scroller.getBoundingClientRect();
  const onBar = panDown(h, scroller, { button: 1, clientX: barBounds.left + scroller.clientWidth + 3, clientY: barBounds.top + 40 });
  assert.equal(onBar.prevented, false, '滚动条不抢平移手势');
  assert.equal(onBar.stopped, false);

  // 抓手工具左拖仍是平移（不改工具、不切到临时模式）。
  h.tool('browse');
  const browseBefore = scroller.scrollLeft;
  h.emit(scroller, 'pointerdown', { clientX: 300, clientY: 200, pointerId: 5, button: 0, buttons: 1, preventDefault() {} });
  h.emit(scroller, 'pointermove', { clientX: 240, clientY: 200, pointerId: 5, button: 0, buttons: 1 });
  h.emit(scroller, 'pointerup', { clientX: 240, clientY: 200, pointerId: 5, button: 0, buttons: 0 });
  assert.equal(scroller.scrollLeft, Math.min(832, browseBefore + 60), '抓手左拖平移');
  assert.equal(h.q('[data-tool="browse"]').getAttribute('aria-pressed'), 'true');
});

test('空格+左键临时平移；先松空格再松鼠标也完成平移，不误画；模糊/关闭清状态', async () => {
  const h = harness({ width: 1200, height: 900,
    dom: { workspace: { width: 420, height: 320 }, scroller: { width: 400, height: 300 } } });
  await h.open();
  h.click(h.q('[data-action="actual"]'));
  h.dom.flushFrames();
  h.tool('pen');
  const scroller = h.q('.ie-scroll');
  const map = screenMap(h);
  const before = { left: scroller.scrollLeft, top: scroller.scrollTop };
  const space = h.key(scroller, { key: ' ' });
  assert.equal(space.defaultPrevented, true, '空格抓手生效时拦下默认滚动');
  assert.equal(scroller.style.cursor, 'grab');
  const start = panDown(h, scroller, { button: 0, buttons: 1, clientX: 300, clientY: 250 });
  assert.equal(start.prevented, true);
  assert.equal(scroller.style.cursor, 'grabbing');
  panMove(h, 200, 150, 1);
  h.window.emit('keyup', { key: ' ', target: scroller }); // 先松空格
  h.emit(scroller, 'pointermove', { clientX: 150, clientY: 120, pointerId: 9, button: 0, buttons: 1 });
  panUp(h, 150, 120);
  assert.equal(scroller.scrollLeft, before.left + 150, '平移已完成');
  assert.equal(scroller.scrollTop, before.top + 130);
  assert.equal(h.editor.hasEdits, false, '空格平移不误画');

  // 输入框焦点上按空格不进入抓手。
  const numberInput = h.q('[data-setting="width"]');
  const inInput = h.key(numberInput, { key: ' ' });
  assert.equal(inInput.defaultPrevented, false);
  assert.notEqual(scroller.style.cursor, 'grab', '输入框里的空格不进入抓手');
  // 气泡开着时（键目标仍是画布）Space 也要拦住原生滚动，但不进入抓手。
  h.tool('point');
  h.drag(screenMap(h)(100, 100));
  const withBubble = h.key(scroller, { key: ' ' });
  assert.equal(withBubble.defaultPrevented, true, '键目标是画布时 Space 不允许原生滚动');
  assert.notEqual(scroller.style.cursor, 'grab', '气泡开着不进入抓手');
  assert.equal(h.key(h.field(), { key: ' ' }).defaultPrevented, false, '键目标是输入框时空格归输入框');
  h.cancelBubble();
  // 模糊清掉空格状态。
  const h2 = harness({ width: 1200, height: 900,
    dom: { workspace: { width: 420, height: 320 }, scroller: { width: 400, height: 300 } } });
  await h2.open();
  h2.click(h2.q('[data-action="actual"]'));
  h2.dom.flushFrames();
  h2.tool('pen');
  const scroller2 = h2.q('.ie-scroll');
  h2.key(scroller2, { key: ' ' });
  h2.window.emit('blur');
  assert.notEqual(scroller2.style.cursor, 'grab', '模糊后不再显示抓手');
  const map2 = screenMap(h2);
  h2.drag(map2(60, 60), map2(160, 120));
  assert.equal(h2.editor.hasEdits, true, '模糊后左键恢复画笔而不是平移');
});

test('画笔已按下再按空格不转平移；空格期间马赛克笔刷隐藏', async () => {
  const h = harness();
  await h.open();
  const scroller = h.q('.ie-scroll');
  h.tool('mosaic');
  h.emit(scroller, 'pointermove', { clientX: at(60, 60).x, clientY: at(60, 60).y, pointerId: 1, pointerType: 'mouse', buttons: 1 });
  assert.equal(h.q('.ie-brush-cursor').hidden, false, '马赛克笔刷显示');
  h.emit(scroller, 'pointerdown', { clientX: at(60, 60).x, clientY: at(60, 60).y, pointerId: 2, button: 0, buttons: 1, preventDefault() {} });
  const spaceWhileDrawing = h.key(scroller, { key: ' ' });
  assert.equal(spaceWhileDrawing.defaultPrevented, true, '画着笔时画布上的 Space 也要拦下原生翻页');
  assert.notEqual(scroller.style.cursor, 'grab', '画笔已按下不转平移');
  h.emit(scroller, 'pointermove', { clientX: at(160, 120).x, clientY: at(160, 120).y, pointerId: 2, button: 0, buttons: 1 });
  h.emit(scroller, 'pointerup', { clientX: at(160, 120).x, clientY: at(160, 120).y, pointerId: 2, button: 0, buttons: 0, preventDefault() {} });
  assert.equal(h.editor.hasEdits, true, '画的这一笔照常提交');
  assert.equal(scroller.scrollTop, 0, '没有转成平移');
  // 空格按下时空格期间笔刷隐藏、光标抓手。
  h.key(scroller, { key: ' ' });
  h.emit(scroller, 'pointermove', { clientX: at(60, 60).x, clientY: at(60, 60).y, pointerId: 1, pointerType: 'mouse', buttons: 0 });
  assert.equal(h.q('.ie-brush-cursor').hidden, true, '空格期间隐藏马赛克笔刷');
  assert.equal(scroller.style.cursor, 'grab');
});

test('裁后滚动/缩放不改裁切几何，坐标映射仍准确', async () => {
  const h = harness({ width: 1200, height: 900,
    dom: { workspace: { width: 420, height: 320 }, scroller: { width: 400, height: 300 } } });
  await h.open();
  h.click(h.q('[data-action="actual"]'));
  h.dom.flushFrames();
  h.tool('point');
  h.drag(screenMap(h)(300, 200));
  h.type('裁后仍准');
  h.save();
  // 隐私遮盖与笔迹在裁后仍要完整进图。
  h.tool('mosaic');
  h.drag(screenMap(h)(240, 170), screenMap(h)(320, 200));
  h.q('[data-setting="fill"]').checked = true;
  h.tool('rect');
  h.drag(screenMap(h)(260, 250), screenMap(h)(360, 300));
  h.tool('crop');
  h.dom.flushFrames();
  dragCropPoint(h, { x: 0, y: 0 }, { x: 200, y: 150 });
  h.click(h.q('[data-action="crop-apply"]'));
  const crop = { x: 200, y: 150, width: 1000, height: 750 };
  assert.deepEqual(plain(h.editor.cropRect), crop);
  // 裁后滚轮/缩放/平移：裁切矩形不变，导出尺寸不变。
  wheelOn(h, { deltaY: 80 });
  h.click(h.q('[data-action="zoom-in"]'));
  const scroller = h.q('.ie-scroll');
  panDown(h, scroller);
  panMove(h, 260, 210);
  panUp(h, 260, 210);
  assert.deepEqual(plain(h.editor.cropRect), crop, '导航不改裁切矩形');
  h.dom.flushFrames();
  const t = h.displayTransform();
  const ring = h.markers()[0];
  assert.ok(Math.abs(ring.ringLeft + ring.ringSize / 2 - (t[4] + 300 * t[0])) <= 1.5, '批注仍落在源坐标映射位置');
  const png = await h.editor.exportPNG();
  assert.equal(png[8], 1000 & 0xff); assert.equal(png[9], 750 & 0xff);
  const pngCalls = h.dom.canvases.at(-1).context.calls;
  assert.ok(pngCalls.some(call => call.name === 'clip'), '马赛克仍在');
  assert.ok(pngCalls.some(call => call.name === 'drawImage' && call.source.startsWith('canvas#')), '马赛克网格仍在');
  assert.ok(pngCalls.some(call => call.name === 'fillRect' && call.args[0] === 260 && call.args[1] === 250 &&
    call.args[2] === 100 && call.args[3] === 50), '纯色遮盖矩形参数原样');
  assert.deepEqual(annotationMarks(pngCalls, { brushRadius: 10 }), [], '单图导出不带批注标记');

  const clip = await h.editor.exportClipboard();
  const clipSize = plain(clip.clipboardSize);
  assert.equal(clipSize.width, 1000, '裁后宽超过 720 时不补白');
  const clipRows = fillTexts(h.dom.canvases.at(-1).context.calls).filter(item => item.y >= 750);
  assert.equal(clipRows[1].text, '图像尺寸：1000 × 750 像素');
  assert.ok(clipRows.some(item => item.text === '第 1 条 · 点 (100, 50)：裁后仍准'), '复制说明用裁后坐标');
});

test('裁切手柄画在 compose 的 clip 之外，导出不带手柄；图边外留白可抓、滚动条优先', async () => {
  const h = harness();
  await h.open();
  h.tool('crop');
  h.dom.flushFrames();
  const frame = cropFrame(h);
  const handleRects = frame.filter(call => call.name === 'fillRect' && call.args[2] === 10 && call.args[3] === 10);
  assert.equal(handleRects.length, 8, '8 个手柄都画了');
  const clipIndex = frame.findIndex(call => call.name === 'clip');
  const composeRestore = clipIndex >= 0 ? frame.findIndex((call, index) => index > clipIndex && call.name === 'restore') : -1;
  const firstHandle = frame.findIndex(call => call.name === 'fillRect' && call.args[2] === 10 && call.args[3] === 10);
  assert.ok(clipIndex >= 0 && composeRestore >= 0 && firstHandle > composeRestore, '手柄在 compose 的 clip/restore 之后画');
  assert.equal(frame.slice(firstHandle).some(call => call.name === 'clip'), false, '手柄不受 view clip 裁切');
  const map = cropMap(h);
  const corner = map(0, 0);
  assert.ok(handleRects.some(call => Math.abs(call.args[0] + 5 - corner.x) < 0.5 && Math.abs(call.args[1] + 5 - corner.y) < 0.5),
    '左上角手柄就在画面边缘，能被完整看到');

  // 图边外 16px 留白里的手柄也能抓：按在画面外 5px 的左上角手柄上再拖进来。
  const scroller = h.q('.ie-scroll');
  const outside = { x: corner.x - 5, y: corner.y - 5 };
  const inside = map(100, 80);
  h.emit(scroller, 'pointerdown', { clientX: outside.x, clientY: outside.y, pointerId: 11, button: 0, buttons: 1, preventDefault() {} });
  h.emit(scroller, 'pointermove', { clientX: inside.x, clientY: inside.y, pointerId: 11, button: 0, buttons: 1 });
  h.emit(scroller, 'pointerup', { clientX: inside.x, clientY: inside.y, pointerId: 11, button: 0, buttons: 0 });
  assert.match(h.q('.ie-crop-size').textContent, /保留 300 × 220 像素/, '图外留白里的手柄可抓');

  // 原生滚动条上的按下不归裁切（滚动条优先）。
  const bounds = scroller.getBoundingClientRect();
  h.emit(scroller, 'pointerdown', { clientX: bounds.left + scroller.clientWidth + 3, clientY: bounds.top + 150, pointerId: 12, button: 0, buttons: 1, preventDefault() {} });
  h.emit(scroller, 'pointermove', { clientX: map(300, 250).x, clientY: map(300, 250).y, pointerId: 12, button: 0, buttons: 1 });
  h.emit(scroller, 'pointerup', { clientX: map(300, 250).x, clientY: map(300, 250).y, pointerId: 12, button: 0, buttons: 0 });
  assert.match(h.q('.ie-crop-size').textContent, /保留 300 × 220 像素/, '滚动条上的按下不动裁切框');

  // 有草稿时导出被拒；取消后导出画布里没有任何手柄。
  await assert.rejects(h.editor.exportPNG(), /裁切框还没应用/);
  h.click(h.q('[data-action="crop-cancel"]'));
  const before = h.dom.canvases.length;
  assert.ok(isPng(await h.editor.exportPNG()));
  const exportCalls = h.dom.canvases.slice(before)[0].context.calls;
  assert.equal(exportCalls.some(call => call.name === 'fillRect' && call.args[2] === 10 && call.args[3] === 10), false, '导出不带手柄');
});

test('适合整图与进裁切显式把滚动归零，不沿用旧锚点把图移出视口', async () => {
  const h = harness({ width: 1200, height: 900,
    dom: { workspace: { width: 420, height: 320 }, scroller: { width: 400, height: 300 } } });
  await h.open();
  h.click(h.q('[data-action="actual"]'));
  h.dom.flushFrames();
  const scroller = h.q('.ie-scroll');
  scroller.scrollLeft = 500; scroller.scrollTop = 400;
  h.emit(scroller, 'scroll');
  h.dom.flushFrames();
  h.click(h.q('[data-action="fit-image"]'));
  h.dom.flushFrames();
  assert.equal(scroller.scrollLeft, 0, '适合整图显式归零');
  assert.equal(scroller.scrollTop, 0);
  let t = h.displayTransform();
  assert.ok(1200 * t[0] <= 368 + 1e-6 && 900 * t[0] <= 268 + 1e-6, '整图完整落在视口内');

  h.click(h.q('[data-action="zoom-in"]'));
  h.dom.flushFrames();
  scroller.scrollLeft = 120; scroller.scrollTop = 80;
  h.emit(scroller, 'scroll');
  h.dom.flushFrames();
  h.tool('crop');
  h.dom.flushFrames();
  assert.equal(scroller.scrollLeft, 0, '进裁切也显式归零');
  assert.equal(scroller.scrollTop, 0);
  t = h.displayTransform();
  assert.ok(1200 * t[0] <= 368 + 1e-6 && 900 * t[0] <= 268 + 1e-6, '裁切初始全选框完整可见');
});

test('默认全选直接确认：无变化干净退出、不追加历史、不丢 redo，不需要双击', async () => {
  const h = harness();
  await h.open();
  h.tool('pen');
  h.drag(at(60, 60), at(160, 120));
  h.key(h.q('.ie-scroll'), { key: 'z', ctrlKey: true });
  assert.equal(h.editor.hasEdits, false);
  assert.equal(h.q('[data-action="redo"]').disabled, false, '前提：此时有可重做历史');

  h.tool('crop');
  h.dom.flushFrames();
  const apply = h.q('[data-action="crop-apply"]');
  assert.equal(apply.disabled, false, '默认全选时完成按钮可用，不会卡在禁用态');
  assert.match(h.q('.ie-crop-size').textContent, /保留 400 × 300 像素/);
  h.click(apply);
  assert.match(h.q('.ie-status').textContent, /没有变化/);
  assert.equal(h.editor.hasEdits, false, '无变化不追加 op');
  assert.equal(h.q('[data-action="redo"]').disabled, false, 'redo 不被截断');
  assert.equal(apply.disabled, true, '退出草稿后按钮回到禁用');
  assert.equal(h.editor.isOpen, true, '不关编辑器');

  // Enter 也能确认退出；同样不追加历史。
  h.tool('pen');
  h.tool('crop');
  h.dom.flushFrames();
  assert.equal(h.key(h.q('.ie-scroll'), { key: 'Enter' }).defaultPrevented, true);
  assert.match(h.q('.ie-status').textContent, /没有变化/);
  assert.equal(h.editor.hasEdits, false);
});

test('鼠标选工具后焦点交给画布（Space 立即可抓手），键盘触发保留按钮焦点', async () => {
  const h = harness();
  await h.open();
  const scroller = h.q('.ie-scroll');
  h.tool('mosaic'); // 夹具 click 无 detail，按指针处理
  assert.equal(h.dom.document.activeElement, scroller, '鼠标点工具后焦点在画布');
  assert.equal(h.key(h.dom.document.activeElement, { key: ' ' }).defaultPrevented, true, '焦点在画布时 Space 进抓手');
  h.window.emit('keyup', { key: ' ', target: scroller });

  const pen = h.q('[data-tool="pen"]');
  pen.focus();
  h.root.emit('click', { target: pen, detail: 0 });
  assert.equal(h.dom.document.activeElement, pen, '键盘触发保留工具焦点');
  assert.equal(h.q('[data-tool="pen"]').getAttribute('aria-pressed'), 'true');
  assert.equal(h.key(h.dom.document.activeElement, { key: ' ' }).defaultPrevented, false, '工具按钮上的 Space 不抢');

  // 重复点同一个工具也把焦点交给画布，不重置正在调整的裁切框。
  h.tool('crop');
  h.dom.flushFrames();
  dragCropPoint(h, { x: 400, y: 300 }, { x: 300, y: 200 });
  const apply = h.q('[data-action="crop-apply"]');
  apply.focus();
  h.tool('crop');
  assert.equal(h.dom.document.activeElement, scroller, '重复点同工具也归焦点给画布');
  assert.match(h.q('.ie-crop-size').textContent, /保留 300 × 200 像素/);
});

test('裁切确认要等手势/平移结束：拖拽中不提交，松手后可应用', async () => {
  const h = harness();
  await h.open();
  h.tool('crop');
  h.dom.flushFrames();
  const scroller = h.q('.ie-scroll'), map = cropMap(h);
  const corner = map(400, 300), target = map(300, 200);
  h.emit(scroller, 'pointerdown', { clientX: corner.x, clientY: corner.y, pointerId: 21, button: 0, buttons: 1, preventDefault() {} });
  h.emit(scroller, 'pointermove', { clientX: target.x, clientY: target.y, pointerId: 21, button: 0, buttons: 1 });
  h.click(h.q('[data-action="crop-apply"]'));
  assert.match(h.q('.ie-status').textContent, /松开鼠标/, '拖拽中确认被拒');
  assert.equal(h.editor.hasEdits, false);
  h.emit(scroller, 'pointerup', { clientX: target.x, clientY: target.y, pointerId: 21, button: 0, buttons: 0 });
  h.click(h.q('[data-action="crop-apply"]'));
  assert.deepEqual(plain(h.editor.cropRect), { x: 0, y: 0, width: 300, height: 200 });

  const h2 = harness({ width: 1200, height: 900,
    dom: { workspace: { width: 420, height: 320 }, scroller: { width: 400, height: 300 } } });
  await h2.open();
  h2.click(h2.q('[data-action="actual"]'));
  h2.dom.flushFrames();
  h2.tool('crop');
  h2.dom.flushFrames();
  dragCropPoint(h2, { x: 0, y: 0 }, { x: 100, y: 100 });
  panDown(h2, h2.q('.ie-scroll'));
  h2.click(h2.q('[data-action="crop-apply"]'));
  assert.match(h2.q('.ie-status').textContent, /平移中/, '平移中确认被拒');
  assert.equal(h2.editor.hasEdits, false);
  panUp(h2, 200, 150);
  h2.click(h2.q('[data-action="crop-apply"]'));
  assert.equal(h2.editor.hasEdits, true, '松手后可正常应用');
});

test('平移期间不改工具/视图/历史；pan 只认起始按钮，抬起样本不产画笔', async () => {
  const h = harness({ width: 1200, height: 900,
    dom: { workspace: { width: 420, height: 320 }, scroller: { width: 400, height: 300 } } });
  await h.open();
  h.click(h.q('[data-action="actual"]'));
  h.dom.flushFrames();
  h.tool('pen');
  const scroller = h.q('.ie-scroll'), map = screenMap(h);
  h.drag(map(60, 60), map(160, 120));
  const t0 = h.displayTransform();
  panDown(h, scroller);
  assert.equal(scroller.hasPointerCapture(9), true);
  h.click(h.q('[data-action="fit-image"]'));
  assert.deepEqual(h.displayTransform(), t0, '平移中不改缩放/视图');
  h.click(h.q('[data-action="zoom-in"]'));
  assert.deepEqual(h.displayTransform(), t0);
  h.key(scroller, { key: 'z', ctrlKey: true });
  assert.equal(h.editor.hasEdits, true, '平移中不撤销');
  h.tool('mosaic');
  assert.equal(h.q('[data-tool="pen"]').getAttribute('aria-pressed'), 'true', '平移中不切工具');

  const beforeTop = scroller.scrollTop;
  panMove(h, 180, 130, 5);
  assert.equal(scroller.scrollTop, beforeTop + 20, '同时按住左键仍继续平移');
  panMove(h, 160, 110, 1);
  assert.equal(scroller.hasPointerCapture(9), false, '起始中键抬起就结束平移');
  const afterTop = scroller.scrollTop;
  panMove(h, 100, 60, 1);
  assert.equal(scroller.scrollTop, afterTop, '结束后不再滚动');
  h.emit(scroller, 'pointerup', { clientX: 100, clientY: 60, pointerId: 9, button: 0, buttons: 0 });
  assert.equal(h.editor.hasEdits, true, '平移与抬起样本不新增画笔');
});

test('忙碌/关闭/重置/新图都清平移并释放指针捕获', async () => {
  for (const how of ['busy', 'close', 'reset', 'newToken']) {
    const h = harness({ width: 1200, height: 900,
      dom: { workspace: { width: 420, height: 320 }, scroller: { width: 400, height: 300 } } });
    await h.open();
    h.click(h.q('[data-action="actual"]'));
    h.dom.flushFrames();
    const scroller = h.q('.ie-scroll');
    panDown(h, scroller);
    assert.equal(scroller.hasPointerCapture(9), true, how);
    if (how === 'busy') {
      h.editor.setBusy(true);
      assert.equal(scroller.hasPointerCapture(9), false, '忙碌时释放捕获');
      assert.notEqual(scroller.style.cursor, 'grabbing');
      h.editor.setBusy(false);
    } else if (how === 'close') {
      h.editor.close();
      assert.equal(scroller.hasPointerCapture(9), false, '关闭释放捕获');
    } else if (how === 'reset') {
      h.editor.reset();
      assert.equal(scroller.hasPointerCapture(9), false, '重置释放捕获');
    } else {
      await h.open({ token: 'doc-2' });
      assert.equal(scroller.hasPointerCapture(9), false, '新图释放捕获');
    }
  }
});

test('窄长裁切框：手柄取最近中心，200×29000 fit 下顶部/右上角/右边各调对边', async () => {
  const long = () => harness({ width: 200, height: 29000,
    dom: { workspace: { width: 420, height: 320 }, scroller: { width: 400, height: 300 } } });
  for (const [label, from, to, expected] of [
    ['顶部中心只改 y/高', { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50, width: 200, height: 28950 }],
    ['右上角只改 x/宽与 y', { x: 200, y: 0 }, { x: 150, y: 20 }, { x: 0, y: 20, width: 150, height: 28980 }],
    ['右边中心只改宽', { x: 200, y: 14500 }, { x: 150, y: 14500 }, { x: 0, y: 0, width: 150, height: 29000 }]
  ]) {
    const h = long();
    await h.open();
    h.tool('crop');
    h.dom.flushFrames();
    // 前提：fit 后框只有不到 2 CSS px 宽，8 个手柄热区完全重叠。
    assert.ok(200 * h.displayTransform()[0] < 2);
    dragCropPoint(h, from, to);
    h.click(h.q('[data-action="crop-apply"]'));
    assert.deepEqual(plain(h.editor.cropRect), expected, label);
  }
});

test('宽度不足 1 CSS px 的窄框：上下/左右边仍能精确命中，不被左上角抢', async () => {
  const thin = () => harness({ width: 20, height: 29000,
    dom: { workspace: { width: 420, height: 320 }, scroller: { width: 400, height: 300 } } });
  for (const [label, from, to, expected] of [
    ['顶部中心', { x: 10, y: 0 }, { x: 10, y: 40 }, { x: 0, y: 40, width: 20, height: 28960 }],
    ['左边中心', { x: 0, y: 14500 }, { x: 5, y: 14500 }, { x: 5, y: 0, width: 15, height: 29000 }]
  ]) {
    const h = thin();
    await h.open();
    h.tool('crop');
    h.dom.flushFrames();
    assert.ok(20 * h.displayTransform()[0] < 1, '前提：框宽不到 1 CSS px');
    dragCropPoint(h, from, to);
    h.click(h.q('[data-action="crop-apply"]'));
    assert.deepEqual(plain(h.editor.cropRect), expected, label);
  }
});

test('小框（约 10 CSS px）中心拖动是移动，不是缩放手柄；边中心仍可 resize', async () => {
  const h = harness();
  await h.open();
  h.tool('crop');
  h.dom.flushFrames();
  dragCropPoint(h, { x: 400, y: 300 }, { x: 11, y: 11 }); // 源 11×11 → 约 9.8 CSS px，手柄热区完全盖住中心
  const map = cropMap(h);
  assert.ok(11 * h.displayTransform()[0] < 10 && 11 * h.displayTransform()[0] > 8, '前提：确是小框');
  h.drag(map(5.5, 5.5), map(10.5, 10.5));
  assert.match(h.q('.ie-crop-size').textContent, /保留 11 × 11 像素/, '中心拖动不改尺寸');
  h.click(h.q('[data-action="crop-apply"]'));
  assert.deepEqual(plain(h.editor.cropRect), { x: 5, y: 5, width: 11, height: 11 });

  const h2 = harness();
  await h2.open();
  h2.tool('crop');
  h2.dom.flushFrames();
  dragCropPoint(h2, { x: 400, y: 300 }, { x: 11, y: 11 });
  const map2 = cropMap(h2);
  h2.drag(map2(0, 5.5), map2(5, 5.5));
  assert.match(h2.q('.ie-crop-size').textContent, /保留 6 × 11 像素/, '左侧边中心仍能 resize');
  h2.click(h2.q('[data-action="crop-apply"]'));
  assert.deepEqual(plain(h2.editor.cropRect), { x: 5, y: 0, width: 6, height: 11 });
});

// —— 批注增强：关联多目标 / 可选模板 / 局部放大 / OCR（编辑器侧） ——
// 全部只用夹具假画布和假宿主：不采桌面、不联网、不落盘，也不走主进程 OCR 桥。
const addTarget = (h, kind, from, to = null) => {
  h.click(h.q(`[data-action="bubble-add-${kind}"]`));
  if (kind === 'point') h.drag(from); else h.drag(from, to);
};
const noteText = async h => (await h.notes())[0].text;

test('关联目标：气泡先暂藏、点一下加 B、回到同一条且文字不丢；多目标显示 1A/1B', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(60, 60));
  h.type('两处都要改');
  h.save();
  const id = h.markers()[0].id;
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"]`));
  assert.equal(h.q('.ie-bubble-relation').hidden, true, '单目标不显示关系选择');
  addTarget(h, 'point', at(300, 80));
  assert.equal(h.bubble().hidden, false, '选完回到同一条气泡');
  assert.equal(h.field().value, '两处都要改', '选点过程中没丢已写文字');
  assert.deepEqual(h.markers().map(item => item.text).sort(), ['1A', '1B'], '多目标显示 1A/1B');
  assert.equal(h.q('.ie-bubble-relation').hidden, false, '两个目标才出现关系');
  addTarget(h, 'region', at(200, 160), at(320, 240));
  assert.deepEqual(h.markers().map(item => item.text).sort(), ['1A', '1B', '1C']);
  assert.equal(h.q('.ie-bubble-title').textContent, '第 1 条批注', '一条批注只有一个标题');
  h.save();
  const text = await noteText(h);
  assert.match(text, /^两处都要改/);
  assert.match(text, /\[目标\] A 点 \(60, 60\)；B 点 \(300, 80\)；C 框 \(200, 160, 120, 80\)/);
  assert.match(text, /\[关系\] 多处同意见/);
  // 旧包形状不变：仍然只有 id/number/kind/point|rect/text。
  assert.deepEqual(Object.keys(plain((await h.notes())[0])).sort(), ['id', 'kind', 'number', 'point', 'text']);
});

test('关系：恰好两个目标才能选「从A移到B」；三个目标时提示且不改关系', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(60, 60));
  h.type('挪个位置');
  h.save();
  const id = h.markers()[0].id;
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"]`));
  addTarget(h, 'point', at(300, 200));
  h.change(h.q('[data-setting="relation"]'), 'move');
  assert.equal(h.q('[data-setting="relation"]').value, 'move');
  h.save();
  assert.match(await noteText(h), /\[关系\] 从A移到B/);

  h.click(h.q(`.ie-marker[data-annotation-id="${id}"][data-target-index="0"]`));
  addTarget(h, 'point', at(120, 220));
  h.change(h.q('[data-setting="relation"]'), 'move');
  assert.match(h.q('.ie-status').textContent, /只支持恰好两个目标/);
  assert.equal(h.q('[data-setting="relation"]').value, 'same', '不满足条件就不假造移动关系');
  h.save();
  assert.match(await noteText(h), /\[关系\] 多处同意见/);
});

test('关系下拉：方向/Home/End/Enter/空格 归原生 select，不被画布快捷键吃掉，也不改批注', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(60, 60));
  h.type('两处都要改');
  h.save();
  const id = h.markers()[0].id;
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"]`));
  addTarget(h, 'point', at(300, 80));
  const select = h.q('[data-setting="relation"]');
  assert.equal(select.disabled, false, '恰好两个目标时关系可选');
  // 夹具的 :open 伪类总匹配，这里只把这一颗 select 的 :open 覆写成关闭，不放宽其他 selector 逻辑。
  const nativeMatches = select.matches;
  let menuOpen = false;
  select.matches = selector => (selector === ':open' ? menuOpen : nativeMatches.call(select, selector));
  for (const key of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' ']) {
    const flags = h.key(select, { key });
    assert.equal(flags.defaultPrevented, false, `${key} 在 select 上不能被 preventDefault`);
    assert.equal(flags.stopped, true, `${key} 要挡住下游画布快捷键`);
  }
  assert.equal(select.value, 'same', '键盘不替用户改关系');
  assert.equal(h.bubble().hidden, false, '方向/Enter/空格 不能取消气泡');
  assert.equal(h.field().value, '两处都要改', '已写文字不动');
  assert.equal(h.calls.close, 0);
  assert.equal(h.editor.isOpen, true);
  // 输入法组合中的键不抢：不 preventDefault、只挡住下游画布快捷键。
  const composing = h.key(select, { key: 'Enter', isComposing: true });
  assert.equal(composing.defaultPrevented, false);
  assert.equal(composing.stopped, true);
  assert.equal(h.bubble().hidden, false);
  h.save();
  assert.match(await noteText(h), /\[关系\] 多处同意见/);
});

test('关系下拉弹层：:open 时 Esc/Tab 只收菜单；关闭时 Esc 取消气泡、Tab 仍走焦点环', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(60, 60));
  h.type('两处都要改');
  h.save();
  const id = h.markers()[0].id;
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"]`));
  addTarget(h, 'point', at(300, 80));
  const select = h.q('[data-setting="relation"]');
  const nativeMatches = select.matches;
  let menuOpen = true;
  select.matches = selector => (selector === ':open' ? menuOpen : nativeMatches.call(select, selector));
  select.focus();

  const esc = h.key(select, { key: 'Escape' });
  assert.equal(esc.defaultPrevented, false, '弹层打开时 Esc 不 preventDefault，交回原生收菜单');
  assert.equal(esc.stopped, true);
  assert.equal(h.bubble().hidden, false, 'Esc 收菜单不能顺手取消批注气泡');
  assert.equal(h.calls.close, 0, '一 Esc 也不应关编辑器');
  assert.equal(h.editor.isOpen, true);

  const tab = h.key(select, { key: 'Tab' });
  assert.equal(tab.defaultPrevented, false, 'Tab 也先给原生关弹层');
  assert.equal(tab.stopped, true);
  assert.equal(h.dom.document.activeElement, select, '弹层打开时 root 焦点环不接管 Tab');

  // 弹层关掉：Esc 回到旧语义（先取消气泡、不动编辑器），Tab 仍由 root 焦点环接管。
  menuOpen = false;
  const closedEsc = h.key(select, { key: 'Escape' });
  assert.equal(closedEsc.defaultPrevented, true);
  assert.equal(closedEsc.stopped, true);
  assert.equal(h.bubble().hidden, true, '关闭状态的 Esc 仍然先取消气泡');
  assert.equal(h.calls.close, 0, '关闭状态的 Esc 不能连编辑器一起关');
  assert.equal(h.editor.isOpen, true);

  h.click(h.q(`.ie-marker[data-annotation-id="${id}"]`));
  select.focus();
  const closedTab = h.key(select, { key: 'Tab' });
  assert.equal(closedTab.defaultPrevented, true, '关闭状态的 Tab 仍由编辑器焦点环处理');
  assert.notEqual(h.dom.document.activeElement, select, 'Tab 把焦点移走，不依赖浏览器默认');
  // 其他快捷键不变：先收起气泡，焦点在画布上 Esc 仍能关编辑器。
  h.click(h.q('[data-action="bubble-cancel"]'));
  assert.equal(h.bubble().hidden, true);
  h.key(h.q('.ie-scroll'), { key: 'Escape' });
  assert.equal(h.calls.close, 1);
});

test('关联目标上限 8：满 8 个后按钮禁用并提示', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(30, 30));
  h.type('八个目标');
  h.save();
  const id = h.markers()[0].id;
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"]`));
  for (let i = 0; i < 7; i += 1) addTarget(h, 'point', at(60 + i * 40, 260));
  assert.equal(h.markers().length, 8, '主目标 + 7 个关联目标');
  assert.deepEqual(h.markers().map(item => item.text).sort(), ['1A', '1B', '1C', '1D', '1E', '1F', '1G', '1H']);
  const add = h.q('[data-action="bubble-add-point"]');
  assert.equal(add.disabled, true, '满 8 个后按钮禁用');
  h.click(add);
  assert.match(h.q('.ie-status').textContent, /最多 8 个目标/);
  h.save();
  const text = await noteText(h);
  assert.equal((text.match(/ 点 \(/g) || []).length, 8);
  assert.match(text, /H 点/);
});

test('关联选点取消：Esc 只回到气泡；空格/中键/非左键不会误加目标', async () => {
  const h = harness({ width: 1200, height: 900,
    dom: { workspace: { width: 420, height: 320 }, scroller: { width: 400, height: 300 } } });
  await h.open();
  h.click(h.q('[data-action="actual"]'));
  h.dom.flushFrames();
  h.tool('point');
  h.drag(screenMap(h)(60, 60));
  h.type('别丢我');
  h.save();
  const id = h.markers()[0].id;
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"]`));
  h.click(h.q('[data-action="bubble-add-point"]'));
  assert.equal(h.bubble().hidden, false, '选关联目标时右栏不收起（避免布局跳动）');
  assert.equal(h.q('.ie-panel').hidden, false, '面板一直开着');
  const escape = h.key(h.q('.ie-scroll'), { key: 'Escape' });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(h.calls.close, 0, 'Esc 不能连编辑器一起关');
  assert.equal(h.bubble().hidden, false, 'Esc 回到同一条批注');
  assert.equal(h.field().value, '别丢我');
  assert.equal(h.markers().length, 1, '取消不新增目标');

  // 中键平移：只滚动，不加目标，选点状态还在。
  h.click(h.q('[data-action="bubble-add-point"]'));
  const scroller = h.q('.ie-scroll');
  const start = { left: scroller.scrollLeft, top: scroller.scrollTop };
  panDown(h, scroller);
  panMove(h, 300, 210);
  panUp(h, 300, 210);
  assert.equal(scroller.scrollLeft, Math.max(0, start.left - 100), '中键仍然临时平移（从 200 拖到 300：画布往回移 100）');
  assert.equal(h.markers().length, 1, '中键不误加目标');
  assert.equal(h.q('.ie-panel').hidden, false, '平移后面板仍在');

  // 空格+左键平移：也不误加目标。
  h.key(scroller, { key: ' ' });
  panDown(h, scroller, { button: 0, buttons: 1, clientX: 300, clientY: 250 });
  panMove(h, 280, 230, 1);
  panUp(h, 280, 230);
  h.window.emit('keyup', { key: ' ', target: scroller });
  assert.equal(h.markers().length, 1, '空格平移不误加目标');
  assert.equal(h.bubble().hidden, false, '仍在选点，面板没动');

  // 非左键：直接忽略。
  h.emit(scroller, 'pointerdown', { clientX: at(200, 150).x, clientY: at(200, 150).y, pointerId: 31, button: 2, buttons: 2, preventDefault() {} });
  h.emit(scroller, 'pointerup', { clientX: at(200, 150).x, clientY: at(200, 150).y, pointerId: 31, button: 2, buttons: 0 });
  assert.equal(h.markers().length, 1, '右键不误加目标');

  // 正常左键点一下：这才加目标，并回到气泡。
  h.drag(screenMap(h)(100, 100));
  assert.equal(h.markers().length, 2);
  assert.equal(h.bubble().hidden, false);
  assert.equal(h.field().value, '别丢我', '加目标后原文字仍在');
});

test('子标记：点任意目标都编辑整条，删除整条，撤销恢复全部目标', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(60, 60));
  h.type('整条');
  h.save();
  const id = h.markers()[0].id;
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"]`));
  addTarget(h, 'point', at(300, 200));
  h.save();
  assert.equal(h.markers().length, 2);
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"][data-target-index="1"]`));
  assert.equal(h.q('.ie-bubble-title').textContent, '第 1 条批注', '点子标记编辑整条');
  assert.equal(h.field().value, '整条');
  h.click(h.q('[data-action="bubble-delete"]'));
  assert.deepEqual(h.markers(), [], '删除是整条原子删除');
  h.key(h.q('.ie-scroll'), { key: 'z', ctrlKey: true });
  assert.deepEqual(h.markers().map(item => item.text).sort(), ['1A', '1B'], '撤销删除恢复整条和两个目标');
});

test('目标变更走 annotation-update：撤销/重做按历史有效版本；纯改字仍不新增历史', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(60, 60));
  h.type('甲');
  h.save();
  const id = h.markers()[0].id;
  const redoDisabled = () => h.q('[data-action="redo"]').disabled;
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"]`));
  h.type('甲改字');
  h.save();
  assert.equal(redoDisabled(), true, '纯改字不进历史');
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"]`));
  addTarget(h, 'point', at(300, 200));
  h.save();
  assert.equal(h.markers().length, 2);
  h.key(h.q('.ie-scroll'), { key: 'z', ctrlKey: true });
  assert.equal(h.markers().length, 1, '撤销目标变更');
  assert.equal(await noteText(h), '甲改字', '撤销目标变更不能连文字一起丢');
  h.key(h.q('.ie-scroll'), { key: 'y', ctrlKey: true });
  assert.equal(h.markers().length, 2, '重做恢复目标');
  assert.match(await noteText(h), /\[目标\] A 点 \(60, 60\)；B 点 \(300, 200\)/);
  // 移除目标也走 update，可撤销。
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"][data-target-index="1"]`));
  h.click(h.q('.ie-bubble-targets [data-action="target-remove"][data-target-index="1"]'));
  h.save();
  assert.equal(h.markers().length, 1, '移除后只剩主目标');
  h.key(h.q('.ie-scroll'), { key: 'z', ctrlKey: true });
  assert.equal(h.markers().length, 2, '撤销移除恢复目标');
});

test('裁切：主目标 A 被裁掉保留 B，导出主几何合法；目标文字/局部放大略过；撤销恢复', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(60, 60));
  h.type('两处同意见');
  h.save();
  const id = h.markers()[0].id;
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"]`));
  h.click(h.q('[data-action="bubble-more-toggle"]'));
  h.input(h.q('.ie-target-text'), '按钮上的保存二字');
  const insetBox = h.q('[data-setting="inset"]');
  insetBox.checked = true;
  h.change(insetBox);
  addTarget(h, 'point', at(300, 60));
  h.save();
  assert.deepEqual(h.markers().map(item => item.text).sort(), ['1A', '1B']);

  h.tool('crop');
  h.dom.flushFrames();
  dragCropPoint(h, { x: 0, y: 0 }, { x: 200, y: 0 });
  h.click(h.q('[data-action="crop-apply"]'));
  assert.deepEqual(plain(h.editor.cropRect), { x: 200, y: 0, width: 200, height: 300 });

  // A 被裁掉：这条不能整条消失，用存活的首个目标当合法主几何，字母仍是 B。
  assert.deepEqual(h.markers().map(item => item.text), ['1B']);
  const result = await h.copy();
  assert.equal(result.annotations.length, 1, '任一目标存活就保留这条');
  assert.equal(result.annotations[0].kind, 'point');
  assert.deepEqual(result.annotations[0].point, { x: 100, y: 60 }, '投影到裁后原坐标');
  assert.equal(result.annotations[0].number, 1);
  assert.match(result.annotations[0].text, /\[目标\] B 点 \(100, 60\)/);
  assert.match(result.annotations[0].text, /\[提示\] 主目标 A 不在当前画面：目标文字与局部放大已略过/);
  assert.equal(result.annotations[0].text.includes('按钮上的保存二字'), false, 'A 被裁掉就不再导出它的派生文字');

  // 局部放大同样略过：复制只建说明画布，不建放大源画布，也不扩宽。
  let before = h.dom.canvases.length;
  const dead = plain(await h.editor.exportClipboard());
  assert.equal(h.dom.canvases.length - before, 1, 'A 被裁掉就不画局部放大');
  assert.equal(dead.clipboardSize.width, 720, '不附局部放大就不扩宽（裁后 200 宽仍补白到 720）');
  assert.equal('insetWidth' in dead.clipboardSize, false, '不附局部放大就不声明 insetWidth');

  // 撤销裁切：两个目标、目标文字、放大都回来。
  h.key(h.q('.ie-scroll'), { key: 'z', ctrlKey: true });
  assert.deepEqual(h.markers().map(item => item.text).sort(), ['1A', '1B']);
  const back = await noteText(h);
  assert.match(back, /\[目标\] A 点 \(60, 60\)；B 点 \(300, 60\)/);
  assert.match(back, /\[目标文字\] 按钮上的保存二字/);
  before = h.dom.canvases.length;
  await h.editor.exportClipboard();
  assert.equal(h.dom.canvases.length - before, 2, '撤销后局部放大恢复（说明画布 + 放大源画布）');
});

test('裁切：只裁掉关联 B 也保留 A 字母，并明确提示缺失目标与关系需确认', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(300, 60));
  h.type('把 A 移到 B');
  addTarget(h, 'point', at(60, 60));
  h.save();
  h.tool('crop');
  h.dom.flushFrames();
  dragCropPoint(h, { x: 0, y: 0 }, { x: 200, y: 0 });
  h.click(h.q('[data-action="crop-apply"]'));
  const text = await noteText(h);
  assert.match(text, /\[目标\] A 点 \(100, 60\)/);
  assert.match(text, /目标 B 已裁掉.*关系需重新确认/);
  assert.equal(text.includes('B 点'), false, '不提供裁掉目标的坐标');
});

test('裁切：关联框跨边取交集，所有导出坐标都在裁后画幅内', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(60, 60));
  h.type('跨边也要合法');
  h.save();
  const id = h.markers()[0].id;
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"]`));
  addTarget(h, 'region', at(150, 100), at(300, 250));
  h.save();
  h.tool('crop');
  h.dom.flushFrames();
  dragCropPoint(h, { x: 0, y: 0 }, { x: 200, y: 0 });
  h.click(h.q('[data-action="crop-apply"]'));
  assert.deepEqual(plain(h.editor.cropRect), { x: 200, y: 0, width: 200, height: 300 });

  const result = await h.copy();
  assert.equal(result.annotations.length, 1);
  assert.equal(result.annotations[0].kind, 'region', 'A 被裁掉后主几何换成存活的 B 框');
  assert.deepEqual(result.annotations[0].rect, { x: 0, y: 100, width: 100, height: 150 }, '跨边只报交集');
  assert.match(result.annotations[0].text, /\[目标\] B 框 \(0, 100, 100, 150\)/);
  const nums = result.annotations[0].text.match(/-?\d+(?:\.\d+)?/g).map(Number);
  assert.ok(nums.every(value => value >= 0 && value <= 300), `导出文字里的坐标都要在图内：${json(nums)}`);
});

test('没有新元数据时完全旧输出：文字原样、不加空标签', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(80, 90));
  h.type('只有这一句');
  h.save();
  const note = plain((await h.notes())[0]);
  assert.equal(note.text, '只有这一句');
  assert.deepEqual(Object.keys(note).sort(), ['id', 'kind', 'number', 'point', 'text']);
  for (const label of ['[目标]', '[关系]', '[目标文字]', '[操作]', '[当前]', '[期望]', '[提示]']) {
    assert.equal(note.text.includes(label), false, `不该凭空出现 ${label}`);
  }
  const before = h.dom.canvases.length;
  await h.editor.exportClipboard();
  const rows = fillTexts(h.dom.canvases.slice(before)[0].context.calls).filter(item => item.y >= 300);
  assert.ok(rows.some(item => /^第 1 条 · 点 \(\d+, \d+\)：只有这一句$/.test(item.text)), json(rows.map(row => row.text)));
});

test('可选模板：操作/当前/期望只在填了才拼进旧包文字，复制说明区同样展开', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(80, 90));
  h.type('按钮没反应');
  h.click(h.q('[data-action="bubble-more-toggle"]'));
  h.input(h.q('.ie-details-action'), '点击保存');
  h.input(h.q('.ie-details-expected'), '出现下载提示');
  h.save();
  const text = await noteText(h);
  assert.match(text, /\[操作\] 点击保存/);
  assert.match(text, /\[期望\] 出现下载提示/);
  assert.equal(text.includes('[当前]'), false, '没填的字段不出现空标签');
  const before = h.dom.canvases.length;
  await h.editor.exportClipboard();
  const rows = fillTexts(h.dom.canvases.slice(before)[0].context.calls).filter(item => item.y >= 300);
  const joined = rows.map(row => row.text).join('\n');
  assert.match(joined, /\[操作\] 点击保存/);
  assert.match(joined, /\[期望\] 出现下载提示/);
});

test('局部放大：来源是 compose 画布（含遮盖），不进保存本体；高度不够明确失败不截', async () => {
  const h = harness();
  await h.open();
  h.q('[data-setting="fill"]').checked = true;
  h.tool('rect');
  h.drag(at(80, 70), at(120, 110));
  h.tool('point');
  h.drag(at(100, 90));
  h.type('放大看这里');
  h.click(h.q('[data-action="bubble-more-toggle"]'));
  const insetBox = h.q('[data-setting="inset"]');
  assert.equal(insetBox.checked, false, '附局部放大默认不勾');
  insetBox.checked = true;
  h.change(insetBox);
  h.save();

  // 保存本体不带放大图。
  let before = h.dom.canvases.length;
  await h.editor.exportPNG();
  let calls = h.dom.canvases.slice(before)[0].context.calls;
  assert.equal(calls.some(call => call.name === 'drawImage' && call.source.startsWith('canvas#')), false, '保存截图不带局部放大');
  assert.equal(calls.some(call => call.name === 'fillText'), false, '保存截图不画说明文字');

  // 复制：说明画布 + 放大源画布；源画布就是 compose 的整幅（含纯色遮盖）。
  before = h.dom.canvases.length;
  const clip = await h.editor.exportClipboard();
  const created = h.dom.canvases.slice(before);
  assert.equal(created.length, 2, '说明画布 + 局部放大源画布');
  const [panel, source] = created;
  const sourceCalls = source.context.calls;
  assert.ok(sourceCalls.some(call => call.name === 'drawImage' && call.source === 'bitmap'), '放大源来自 compose 的底图');
  assert.ok(sourceCalls.some(call => call.name === 'translate'), '放大源走 compose 的导出平移');
  assert.ok(sourceCalls.some(call => call.name === 'clip'), '放大源仍走 compose 裁剪');
  assert.ok(sourceCalls.some(call => call.name === 'fillRect' && call.args[0] === 80 && call.args[1] === 70 &&
    call.args[2] === 40 && call.args[3] === 40), '放大源包含已经画好的纯色遮盖');
  assert.equal(sourceCalls.some(call => call.name === 'fillText'), false, '放大源不带说明文字');

  const panelCalls = panel.context.calls;
  const inset = panelCalls.filter(call => call.name === 'drawImage' && call.source.startsWith('canvas#'));
  assert.equal(inset.length, 1, '局部放大只从 compose 画布取一块');
  assert.deepEqual(inset[0].args.slice(0, 4), [52, 58, 96, 64], '点局部默认 96×64 源像素并夹在图内');
  assert.deepEqual(inset[0].args.slice(6, 8), [192, 128], '固定放大 2×，不再按 480×240 面板适配');
  const rows = fillTexts(panelCalls);
  assert.ok(rows.some(item => item.text === '局部放大 · 第 1 条 A · 来源框 (52, 58, 96, 64) · 放大 2×'), json(rows.map(row => row.text)));
  assert.ok(rows.some(item => /第 1 条 · 点 \(100, 90\)：放大看这里/.test(item.text)), '说明文字仍全在');
  assert.deepEqual(panelCalls.find(call => call.name === 'drawImage' && call.source === 'bitmap').args, [0, 0], '主图不缩放、不位移');
  assert.ok(plain(clip.clipboardSize).height > 300, '放大图接在说明下方');

  // 放不下就明确失败：不缩主图、不截说明，也不分配大画布。
  const tall = harness({ width: 200, height: 29000,
    dom: { workspace: { width: 420, height: 320 }, scroller: { width: 400, height: 300 } } });
  await tall.open();
  tall.tool('point');
  tall.drag({ x: 100 + 40, y: 16 + 30 });
  tall.type('高图放大');
  tall.click(tall.q('[data-action="bubble-more-toggle"]'));
  const tallInset = tall.q('[data-setting="inset"]');
  tallInset.checked = true;
  tall.change(tallInset);
  tall.save();
  const tallBefore = tall.dom.canvases.length;
  await assert.rejects(tall.editor.exportClipboard(), /关闭「附局部放大」/);
  const tallCreated = tall.dom.canvases.slice(tallBefore);
  assert.equal(tallCreated.length, 1, '只建了量字画布，没有分配超大画布');
  assert.equal(tallCreated[0].width, 0, '量完就释放');
  assert.equal(tall.editor.isOpen, true, '失败后编辑仍在');
  assert.equal(tall.editor.hasEdits, true);
});

test('局部放大固定 2×：582×243 的框复制成 1164×486，不再被 480×240 压成 0.82×', async () => {
  // 1848×1234 原图、视口够大时 zoom=1：落点坐标就是整数源坐标，便于逐像素核对。
  const h = harness({ width: 1848, height: 1234,
    dom: { workspace: { width: 1900, height: 1300 }, scroller: { width: 1900, height: 1300 } } });
  await h.open();
  h.tool('region');
  const map = screenMap(h);
  h.drag(map(100, 100), map(682, 343));
  h.type('这里对不上');
  h.click(h.q('[data-action="bubble-more-toggle"]'));
  const insetBox = h.q('[data-setting="inset"]');
  insetBox.checked = true;
  h.change(insetBox);
  h.save();

  const before = h.dom.canvases.length;
  const clip = plain(await h.editor.exportClipboard());
  const created = h.dom.canvases.slice(before);
  assert.equal(created.length, 2, '说明画布 + 放大源画布');
  const calls = created[0].context.calls;
  const insets = calls.filter(call => call.name === 'drawImage' && call.source.startsWith('canvas#'));
  assert.equal(insets.length, 1);
  assert.deepEqual(insets[0].args.slice(0, 4), [100, 100, 582, 243], '源像素就是这条框在当前画面里的范围');
  assert.deepEqual(insets[0].args.slice(6, 8), [1164, 486], '固定 2×：582×243 → 1164×486');
  const rows = fillTexts(calls);
  assert.ok(rows.some(item => item.text === '局部放大 · 第 1 条 A · 来源框 (100, 100, 582, 243) · 放大 2×'), json(rows.map(row => row.text)));
  assert.equal(rows.some(item => /\d+\.\d+×/.test(item.text)), false, '不会再出现 0.82 这类小于 1 的倍率');
  assert.equal(clip.clipboardSize.width, 1848, '1164+40 没超过原图宽度，画布仍是原图宽');
  assert.equal('insetWidth' in clip.clipboardSize, false, '没被放大图撑宽就不声明 insetWidth');
  assert.deepEqual(calls.find(call => call.name === 'drawImage' && call.source === 'bitmap').args, [0, 0],
    '放大图只在下方，主图仍在 (0, 0) 且不缩放');
  assert.equal(created[1].width, 0, '放大源画布用完释放');
  assert.equal(created[0].width, 0, '说明画布用完释放');
});

test('窄图放大：500 宽的框 2× 成 1000，画布扩到 1040 并声明 insetWidth', async () => {
  const h = harness({ width: 600, height: 400,
    dom: { workspace: { width: 640, height: 460 }, scroller: { width: 640, height: 460 } } });
  await h.open();
  h.tool('region');
  const map = screenMap(h);
  h.drag(map(50, 50), map(550, 150));
  h.type('这一段');
  h.click(h.q('[data-action="bubble-more-toggle"]'));
  const insetBox = h.q('[data-setting="inset"]');
  insetBox.checked = true;
  h.change(insetBox);
  h.save();

  const before = h.dom.canvases.length;
  const clip = plain(await h.editor.exportClipboard());
  const panel = h.dom.canvases.slice(before)[0];
  const size = plain(clip.clipboardSize);
  assert.equal(size.insetWidth, 1000, '放大图宽 500×2，如实声明');
  assert.equal(size.width, 1040, '画布宽 = 放大宽 + 左右各 20');
  const calls = panel.context.calls;
  const inset = calls.filter(call => call.name === 'drawImage' && call.source.startsWith('canvas#'));
  assert.deepEqual(inset[0].args.slice(4, 8), [20, inset[0].args[5], 1000, 200], '放大图从左边凑 20 开始，2× 后 1000×200');
  assert.ok(calls.some(call => call.name === 'fillRect' && call.args[0] === 0 && call.args[1] === 0 &&
    call.args[2] === 1040 && call.args[3] === size.height), '真的分配到 1040 宽：整张铺白底（右侧也是白的）');
  assert.deepEqual(calls.find(call => call.name === 'drawImage' && call.source === 'bitmap').args, [0, 0],
    '源图不拉伸：仍在 (0, 0) 原尺寸位置');
  assert.equal(panel.width, 0, '画布用完释放');
});

test('局部放大超预算：明确失败，不降倍率、不丢编辑，关掉放大后同一张图仍可复制', async () => {
  // 3000×5000 本身在 1600 万像素内，但框 2000 宽 2× 后画布 4040 × 约 5866 就超了。
  const h = harness({ width: 3000, height: 5000,
    dom: { workspace: { width: 3100, height: 5100 }, scroller: { width: 3100, height: 5100 } } });
  await h.open();
  h.tool('region');
  const map = screenMap(h);
  h.drag(map(100, 100), map(2100, 500));
  h.type('这条别丢');
  h.click(h.q('[data-action="bubble-more-toggle"]'));
  const insetBox = h.q('[data-setting="inset"]');
  insetBox.checked = true;
  h.change(insetBox);
  h.save();
  const id = h.markers()[0].id;

  const before = h.dom.canvases.length;
  await assert.rejects(h.editor.exportClipboard(), /缩小框选范围或关闭「附局部放大」/);
  const created = h.dom.canvases.slice(before);
  assert.equal(created.length, 1, '只建了量字画布');
  assert.equal(created[0].width, 0, '量完就释放，没有分配超大画布');
  assert.equal(h.editor.isOpen, true, '失败后编辑仍在');
  assert.equal(h.editor.hasEdits, true);
  assert.deepEqual(plain(h.editor.outputSize), { width: 3000, height: 5000 }, '不偷偷改输出尺寸或倍率');
  assert.equal(h.markers().length, 1, '批注与放大开关都还在');

  // 用户自己关掉放大后，同一张图仍能正常复制（说明区本身不超限）。
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"]`));
  h.click(h.q('[data-action="bubble-more-toggle"]'));
  const reopenBox = h.q('[data-setting="inset"]');
  assert.equal(reopenBox.checked, true, '失败不擅改用户的放大开关');
  reopenBox.checked = false;
  h.change(reopenBox);
  h.save();
  const ok = plain(await h.editor.exportClipboard());
  assert.equal(ok.clipboardSize.width, 3000);
  assert.equal('insetWidth' in ok.clipboardSize, false);
  assert.match(await noteText(h), /这条别丢/);
});

test('OCR 未接回调：按钮显示不可用，目标文字仍可手填并导出', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(80, 80));
  h.type('这里按钮写错了');
  h.click(h.q('[data-action="bubble-more-toggle"]'));
  const button = h.q('[data-action="bubble-ocr"]');
  assert.equal(button.disabled, true, '没有识别能力就明确不可用');
  assert.match(button.textContent, /不可用/);
  assert.match(button.textContent, /A/, '按钮文案明确是目标 A，不是整图');
  h.input(h.q('.ie-target-text'), '保存');
  h.save();
  assert.match(await noteText(h), /\[目标文字\] 保存/);
});

test('OCR 成功：只在用户点击后调用，只送 compose 后的局部 PNG，结果写进目标文字', async () => {
  const pending = [];
  const h = harness({ recognizeText: () => new Promise(resolve => { pending.push(resolve); }) });
  await h.open();
  h.tool('point');
  h.drag(at(100, 90));
  h.type('识别过再手改');
  h.click(h.q('[data-action="bubble-more-toggle"]'));
  assert.equal(h.calls.ocr.length, 0, '打开气泡/展开可选字段都不自动识别');
  const before = h.dom.canvases.length;
  h.click(h.q('[data-action="bubble-ocr"]'));
  await h.tick(); await h.tick();
  assert.equal(h.calls.ocr.length, 1, '只在用户点击时识别一次');
  const payload = h.calls.ocr[0];
  assert.equal(payload.token, 'doc-1');
  assert.ok(payload.png && payload.png.length >= 8, 'PNG 用字节数组送');
  assert.equal(payload.width, 96);
  assert.equal(payload.height, 64);

  // 安全像素来源：先 compose 整幅（含遮盖），再从这张 canvas 裁局部。
  const created = h.dom.canvases.slice(before);
  assert.equal(created.length, 2, '合成画布 + 局部画布');
  const [source, crop] = created;
  assert.ok(source.context.calls.some(call => call.name === 'clip'), '合成画布走 compose 裁剪');
  assert.ok(source.context.calls.some(call => call.name === 'drawImage' && call.source === 'bitmap'), '合成画布先画底图与遮盖');
  const cropDraws = crop.context.calls.filter(call => call.name === 'drawImage');
  assert.equal(cropDraws.length, 1);
  assert.ok(cropDraws[0].source.startsWith('canvas#'), '裁剪来源必须是已处理的 canvas，不是原始位图/dataUrl');
  assert.deepEqual(cropDraws[0].args.slice(0, 4), [52, 58, 96, 64], '只裁目标 A 的 96×64 局部');
  assert.deepEqual(cropDraws[0].args.slice(4, 8), [0, 0, 96, 64]);

  pending[0]({ text: '保存', language: 'zh' });
  await h.tick(); await h.tick();
  assert.equal(h.q('.ie-target-text').value, '保存');
  h.save();
  assert.match(await noteText(h), /\[目标文字\] 保存/);
});

test('OCR 迟到结果不写回；先识别后改像素不再导出旧文字；手改后重新生效', async () => {
  const pending = [];
  const h = harness({ recognizeText: () => new Promise(resolve => { pending.push(resolve); }) });
  await h.open();
  h.tool('point');
  h.drag(at(100, 90));
  h.type('旧文字不应该留下');
  h.save();
  h.tool('pen');
  h.drag(at(20, 20), at(60, 50));
  const id = h.markers()[0].id;
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"]`));
  h.click(h.q('[data-action="bubble-more-toggle"]'));
  h.click(h.q('[data-action="bubble-ocr"]'));
  await h.tick(); await h.tick();
  assert.equal(pending.length, 1);
  // 识别在飞的时候撤销那笔改动：像素 revision 变了，迟到结果不能写回。
  h.key(h.q('.ie-scroll'), { key: 'z', ctrlKey: true });
  pending[0]({ text: '过期结果' });
  await h.tick(); await h.tick();
  assert.equal(h.q('.ie-target-text').value, '', '迟到的识别结果不能写进目标文字');
  assert.equal((await noteText(h)).includes('过期结果'), false);

  // 关闭编辑器后到达的结果也不写回。
  h.click(h.q('[data-action="bubble-ocr"]'));
  await h.tick(); await h.tick();
  h.editor.close();
  pending[pending.length - 1]({ text: '关窗后的结果' });
  await h.tick(); await h.tick();
  assert.equal(h.editor.isOpen, false);
  await h.open();
  assert.equal(h.q('.ie-target-text').value, '', '重开后也没有关窗后的识别结果');

  // 识别成功但之后图像改了：旧 OCR 文字不再导出。
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"]`));
  h.click(h.q('[data-action="bubble-more-toggle"]'));
  h.click(h.q('[data-action="bubble-ocr"]'));
  await h.tick(); await h.tick();
  pending[pending.length - 1]({ text: '旧按钮文字' });
  await h.tick(); await h.tick();
  assert.equal(h.q('.ie-target-text').value, '旧按钮文字');
  h.save();
  assert.match(await noteText(h), /\[目标文字\] 旧按钮文字/);
  h.tool('mosaic');
  h.drag(at(40, 40), at(90, 70));
  const afterMask = await noteText(h);
  assert.equal(afterMask.includes('旧按钮文字'), false, '先识别后马赛克不得再导出旧文字');
  assert.match(afterMask, /目标文字来自较早的图像状态，已略过/);

  // 用户主动手改就按手填处理，不再受生成 revision 限制。
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"]`));
  h.click(h.q('[data-action="bubble-more-toggle"]'));
  h.input(h.q('.ie-target-text'), '手填的按钮文字');
  h.save();
  assert.match(await noteText(h), /\[目标文字\] 手填的按钮文字/);
});

test('OCR：先识别后调整形状（shape-update）也会让旧文字失效', async () => {
  const h = harness({ recognizeText: async () => ({ text: '旧按钮文字', language: 'zh-Hans-CN' }) });
  await h.open();
  // 先把形状画好（创建本身也是像素变化），后面只调不重画。
  h.tool('rect');
  h.drag(at(240, 40), at(320, 100));
  // 再建批注并识别文字。
  h.tool('point');
  h.drag(at(100, 90));
  h.type('看这里');
  h.save();
  const id = h.markers()[0].id;
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"]`));
  h.click(h.q('[data-action="bubble-more-toggle"]'));
  h.click(h.q('[data-action="bubble-ocr"]'));
  await h.tick(); await h.tick();
  assert.equal(h.q('.ie-target-text').value, '旧按钮文字');
  h.save();
  assert.match(await noteText(h), /\[目标文字\] 旧按钮文字/);
  // 只拖一下形状（一条 shape-update，不新增/不删除）：像素 revision 必须真的推进。
  h.tool('select');
  h.drag(at(320, 100), at(340, 120));
  const adjusted = await noteText(h);
  assert.equal(adjusted.includes('旧按钮文字'), false, '调整形状后旧识别文字不得再导出');
  assert.match(adjusted, /目标文字来自较早的图像状态，已略过/);
});

test('OCR：主目标 A 被裁掉就提示并跳过，不拿 B 冒充', async () => {
  const h = harness({ recognizeText: () => Promise.resolve({ text: '不该被识别' }) });
  await h.open();
  h.tool('point');
  h.drag(at(60, 60));
  h.type('裁掉 A');
  h.save();
  const id = h.markers()[0].id;
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"]`));
  addTarget(h, 'point', at(300, 200));
  h.save();
  h.tool('crop');
  h.dom.flushFrames();
  dragCropPoint(h, { x: 0, y: 0 }, { x: 200, y: 0 });
  h.click(h.q('[data-action="crop-apply"]'));
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"]`));
  h.click(h.q('[data-action="bubble-more-toggle"]'));
  const before = h.calls.ocr.length;
  h.click(h.q('[data-action="bubble-ocr"]'));
  await h.tick(); await h.tick();
  assert.equal(h.calls.ocr.length, before, 'A 不在画面里就不调用识别');
  assert.match(h.q('.ie-status').textContent, /目标 A 不在当前画面/);
});

test('主目标换成 B：旧 A 的自动识别文字作废，不跟着新 A 导出', async () => {
  const h = harness({ recognizeText: () => Promise.resolve({ text: 'A上的按钮' }) });
  await h.open();
  h.tool('point');
  h.drag(at(60, 60));
  h.type('两个目标');
  h.save();
  const id = h.markers()[0].id;
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"]`));
  h.click(h.q('[data-action="bubble-more-toggle"]'));
  addTarget(h, 'point', at(300, 200));
  h.click(h.q('[data-action="bubble-ocr"]'));
  await h.tick(); await h.tick();
  assert.equal(h.q('.ie-target-text').value, 'A上的按钮');
  h.save();
  assert.match(await noteText(h), /\[目标文字\] A上的按钮/);

  // 把原主目标 A 移除：新主目标变成 B，旧 A 的识别文字不能跟着走。
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"][data-target-index="0"]`));
  h.click(h.q('[data-action="bubble-more-toggle"]'));
  h.click(h.q('.ie-bubble-targets [data-action="target-remove"][data-target-index="0"]'));
  assert.equal(h.q('.ie-target-text').value, '', '旧 A 的自动文字不能挂到新 A 上');
  assert.match(h.q('.ie-status').textContent, /作废/);
  h.save();
  const text = await noteText(h);
  assert.equal(text.includes('A上的按钮'), false, '导出里不得出现旧 A 的识别文字');
});

test('OCR 在飞时的手改/主目标替换都不可被覆盖；回包后手改仍可用', async () => {
  const pending = [];
  const h = harness({ recognizeText: () => new Promise(resolve => { pending.push(resolve); }) });
  await h.open();
  h.tool('point');
  h.drag(at(60, 60));
  h.type('在飞的手改');
  h.save();
  const id = h.markers()[0].id;
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"]`));
  h.click(h.q('[data-action="bubble-more-toggle"]'));
  addTarget(h, 'point', at(300, 200));
  const targetField = h.q('.ie-target-text');

  // 手改一下再清空：迟到结果不能因“又变回原值”就写回。
  h.click(h.q('[data-action="bubble-ocr"]'));
  await h.tick(); await h.tick();
  h.input(targetField, '我改的');
  h.input(targetField, '');
  pending[0]({ text: '不该覆盖' });
  await h.tick(); await h.tick();
  assert.equal(targetField.value, '', '手改后即使清空也不能被迟到结果覆盖');

  // 主目标在飞时被移除：旧 PNG 对应的不是现在的主目标，回包不能写。
  h.click(h.q('[data-action="bubble-ocr"]'));
  await h.tick(); await h.tick();
  h.click(h.q('.ie-bubble-targets [data-action="target-remove"][data-target-index="0"]'));
  pending[1]({ text: '旧 A 的结果' });
  await h.tick(); await h.tick();
  assert.equal(targetField.value, '', '主目标换人后的迟到结果不能写回');
  assert.equal(/文字识别失败/.test(h.q('.ie-status').textContent), false, '过期任务不能污染状态栏');

  // 同一张图、同一条批注、同一个目标时，回包照常写。
  h.click(h.q('[data-action="bubble-ocr"]'));
  await h.tick(); await h.tick();
  pending[2]({ text: '新的目标文字' });
  await h.tick(); await h.tick();
  assert.equal(targetField.value, '新的目标文字');

  // 过期任务报错也不能污染新图的状态栏。
  h.click(h.q('[data-action="bubble-ocr"]'));
  await h.tick(); await h.tick();
  h.key(h.q('.ie-scroll'), { key: 'Escape' });
  pending[3](Promise.reject(new Error('识别服务炸了')));
  await h.tick(); await h.tick();
  assert.equal(h.bubble().hidden, true, 'Esc 已收起气泡');
  assert.equal(/识别服务炸了/.test(h.q('.ie-status').textContent), false, '过期任务的错误不能写进状态栏');
});

test('只填操作/当前/期望也能保存：自由文字留空不丢内容', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(80, 90));
  h.click(h.q('[data-action="bubble-more-toggle"]'));
  h.input(h.q('.ie-details-action'), '点击保存');
  h.save();
  assert.equal(h.markers().length, 1, '填了模板就不用再重复写一句自由文字');
  const text = await noteText(h);
  assert.equal(text, '[操作] 点击保存');
  // 什么都没填时仍明确拒绝空保存。
  h.tool('point');
  h.drag(at(160, 160));
  h.save();
  assert.equal(h.markers().filter(item => !item.draft).length, 1, '空白新点仍然不能保存');
  assert.match(h.q('.ie-status').textContent, /先写一句再保存/);
});

// —— 批注框二次调整：画好的框可以再移动 / 8 边角缩放（A/B 都行），拖动中实时可见 ——
// 几何只进气泡里的暂存状态：松手留草稿，点「保存批注」才走既有的 annotation-update（一次可撤销）。
const pointerAt = (x, y, extra = {}) => ({ clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1,
  preventDefault() {}, getCoalescedEvents: () => [], ...extra });
const pressAt = (h, x, y) => h.emit(h.q('.ie-scroll'), 'pointerdown', pointerAt(x, y));
const moveTo = (h, x, y) => h.emit(h.q('.ie-scroll'), 'pointermove', pointerAt(x, y));
const releaseAt = (h, x, y) => h.emit(h.q('.ie-scroll'), 'pointerup', pointerAt(x, y, { buttons: 0 }));
// 抽一帧屏幕预览：只留这一帧新增的调用（手柄、高亮框、虚线都在这里看）。
const liveFrame = h => {
  const calls = h.q('.ie-display').context.calls;
  h.dom.flushFrames();
  const from = calls.length;
  h.emit(h.q('.ie-scroll'), 'scroll');
  h.dom.flushFrames();
  return calls.slice(from);
};
// 手柄是固定 8 CSS px 的白色小方块；导出画布里一块都不应该有。
const handleSquares = calls => calls.filter(call => call.name === 'fillRect' && call.args[2] === 8 && call.args[3] === 8);
const chipLabels = h => (h.bubble().hidden ? [] : h.qa('.ie-target-chip').map(chip => chip.querySelector('.ie-target-label').textContent));
// 选关联目标时气泡是收着的（但 chips 还在），要看“旧框没被动”只能直接读 chip。
const chipLabelsRaw = h => h.qa('.ie-target-chip').map(chip => chip.querySelector('.ie-target-label').textContent);
const frameButton = (h, index) => h.q(`.ie-target-chip [data-action="target-frame"][data-target-index="${index}"]`);

test('新画的框就是当前框：8 个手柄、框内拖动移动、手柄缩放，松手只留草稿，保存才进历史', async () => {
  const h = harness();
  await h.open();
  h.tool('region');
  h.drag(at(100, 60), at(200, 160));
  assert.equal(h.bubble().hidden, false);
  assert.deepEqual(chipLabels(h), ['框 (100, 60, 100, 100)'], '新画的框就是暂存几何');
  assert.equal(frameButton(h, 0).getAttribute('aria-pressed'), 'true', '新画的框默认选中，直接能调');
  assert.equal(handleSquares(liveFrame(h)).length, 8, '当前框要显示 8 个手柄');

  // 框内拖动：整块平移 30/30 源像素，只改暂存几何。
  h.drag(at(150, 110), at(180, 140));
  assert.deepEqual(chipLabels(h), ['框 (130, 90, 100, 100)'], '框内拖动整块平移');
  assert.equal(h.editor.hasEdits, false, '拖动不进 ops');
  assert.match(h.q('.ie-status').textContent, /完成批注/, '松手只留草稿，明确说要保存才生效');
  assert.equal(h.bubble().hidden, false, '调框不会把正在写的气泡收掉');

  // 右下角手柄缩放：拖到 (260, 220) → 宽高各 +30。
  h.drag(at(230, 190), at(260, 220));
  assert.deepEqual(chipLabels(h), ['框 (130, 90, 130, 130)'], '手柄缩放只动被拖的那条边');
  assert.equal(h.editor.hasEdits, false, '缩放同样不进 ops');
  assert.equal(handleSquares(liveFrame(h)).length, 8, '调整过程中手柄一直在');

  // 上边中点手柄：只把顶边往上拉 20，左右和底边不动。
  h.drag(at(195, 90), at(195, 70));
  assert.deepEqual(chipLabels(h), ['框 (130, 70, 130, 150)'], '边中点手柄只改一条边');

  h.type('调过的框');
  h.click(h.q('[data-action="bubble-save"]'));
  const saved = (await h.notes())[0];
  assert.equal(saved.text, '调过的框');
  assert.deepEqual(saved.rect, { x: 130, y: 70, width: 130, height: 150 }, '保存后的是调整过的几何');
  assert.equal(handleSquares(liveFrame(h)).length, 0, '保存并收起气泡后不再画手柄');

  // 一次入史：撤销把这条批注整条收回，重做按调整后的几何回来。
  h.key(h.q('.ie-scroll'), { key: 'z', ctrlKey: true });
  assert.deepEqual(await h.notes(), [], '撤销把这条新批注整条收回');
  h.key(h.q('.ie-scroll'), { key: 'y', ctrlKey: true });
  assert.deepEqual((await h.notes())[0].rect, { x: 130, y: 70, width: 130, height: 150 }, '重做恢复调整后的几何');
});

test('已存批注 A/B 都能选中再调整：点编号或气泡「调框」，保存一次可撤销，互不牵连', async () => {
  const h = harness();
  await h.open();
  h.tool('region');
  h.drag(at(40, 40), at(120, 120));
  h.type('两块框');
  h.save();
  const id = h.markers()[0].id;
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"]`));
  addTarget(h, 'region', at(240, 180), at(320, 260));
  h.save();
  assert.deepEqual(h.markers().map(item => item.text), ['1A', '1B']);

  // 点 1B 编号：直接选中 B 框；A 的手柄不跟着亮。
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"][data-target-index="1"]`));
  assert.equal(frameButton(h, 1).getAttribute('aria-pressed'), 'true', '点 B 编号就选中 B 框');
  assert.equal(frameButton(h, 0).getAttribute('aria-pressed'), 'false', 'A 框没被选中就不会误拖');

  // 点「选中」：面板不收起（不再有中间确认），手柄直接在画布上出现。
  h.click(frameButton(h, 1));
  assert.equal(h.bubble().hidden, false, '右栏一直开着，不抢画布也不挡手柄');
  assert.equal(h.q('[data-action="frame-done"]'), null, '没有「完成调框」中间步骤');
  assert.equal(handleSquares(liveFrame(h)).length, 8, '手柄照常可见');

  // 拖到一半：画布上只该有新几何一份，不能把旧框叠着再画一遍。
  pressAt(h, at(320, 260).x, at(320, 260).y);
  moveTo(h, at(340, 280).x, at(340, 280).y);
  const midBoxes = liveFrame(h).filter(call => call.name === 'strokeRect').map(call => call.args);
  const nearBox = (args, x, y, size = 80) => Math.abs(args[0] - x) < 1.5 && Math.abs(args[1] - y) < 1.5 && Math.abs(args[2] - size) < 2;
  assert.equal(midBoxes.some(args => nearBox(args, 240, 180)), false, '拖动中不能还画着 B 的旧几何');
  assert.ok(midBoxes.some(args => nearBox(args, 240, 180, 100)), '拖动中就要显示 B 的新几何');
  releaseAt(h, at(340, 280).x, at(340, 280).y);

  // 松手后几何还在草稿里，面板里的目标行已更新。
  assert.equal(h.bubble().hidden, false, '面板保持展开');
  assert.equal(h.editor.hasEdits, true, '前面已有保存过的批注，但这次调整本身不新增历史');
  assert.deepEqual(chipLabels(h), ['框 (40, 40, 80, 80)', '框 (240, 180, 100, 100)'], 'B 框右下角缩放，A 一动不动');

  // 换成 A：再点 A 的「选中」，框内拖动把它平移。
  h.click(frameButton(h, 0));
  assert.equal(frameButton(h, 0).getAttribute('aria-pressed'), 'true');
  assert.equal(frameButton(h, 1).getAttribute('aria-pressed'), 'false');
  h.drag(at(80, 80), at(100, 100));
  assert.deepEqual(chipLabels(h), ['框 (60, 60, 80, 80)', '框 (240, 180, 100, 100)'], 'A 平移只改 A');
  h.save();

  const saved = (await h.notes())[0];
  assert.deepEqual(saved.rect, { x: 60, y: 60, width: 80, height: 80 }, '主几何仍是 A');
  assert.match(saved.text, /\[目标\] A 框 \(60, 60, 80, 80\)；B 框 \(240, 180, 100, 100\)/, '两块框的调整都进了同一条批注');

  // 一次可撤销：撤销回到调整前，重做回到调整后。
  h.key(h.q('.ie-scroll'), { key: 'z', ctrlKey: true });
  const undone = (await h.notes())[0];
  assert.deepEqual(undone.rect, { x: 40, y: 40, width: 80, height: 80 }, '撤销回到调整前的 A');
  assert.match(undone.text, /\[目标\] A 框 \(40, 40, 80, 80\)；B 框 \(240, 180, 80, 80\)/, 'B 也一起回到调整前');
  h.key(h.q('.ie-scroll'), { key: 'y', ctrlKey: true });
  assert.deepEqual((await h.notes())[0].rect, { x: 60, y: 60, width: 80, height: 80 }, '重做恢复调整后的 A');
});

test('裁切后调框：屏幕上是源坐标，边界夹在裁后视窗内，导出的仍是画幅内坐标', async () => {
  const h = harness();
  await h.open();
  h.tool('region');
  h.drag(at(60, 60), at(160, 160));
  h.type('裁后调框');
  h.save();
  h.tool('crop');
  h.dom.flushFrames();
  dragCropPoint(h, { x: 0, y: 0 }, { x: 100, y: 0 });
  h.click(h.q('[data-action="crop-apply"]'));
  h.dom.flushFrames();
  h.tool('region');
  h.click(h.q('.ie-marker'));
  assert.equal(frameButton(h, 0).getAttribute('aria-pressed'), 'true', '打开这条就选中它唯一的框');

  // 往左拖出画面：x 必须夹在视窗左边界 (100) 上，不能把框拖到被裁掉的地方。
  const onScreen = screenMap(h);
  h.drag(onScreen(130, 110), onScreen(10, 110));
  assert.deepEqual(chipLabels(h), ['框 (100, 60, 100, 100)'], '屏幕/数据都用源坐标，并夹在当前裁切视窗里');
  h.save();

  const exported = (await h.notes())[0];
  assert.deepEqual(exported.rect, { x: 0, y: 60, width: 100, height: 100 }, '导出减去视窗原点');
  const { result } = await h.copy();
  assert.deepEqual(result.clipboardSize, { width: 720, height: result.clipboardSize.height });
  const values = [exported.rect.x, exported.rect.y, exported.rect.x + exported.rect.width, exported.rect.y + exported.rect.height];
  assert.deepEqual(values, [0, 60, 100, 160], '四边都在裁后画幅 (300×300) 内');
  assert.ok(values.every(value => value >= 0 && value <= 300));
});

test('调框被 Esc / pointercancel 打断：几何回到拖动前，文字和其它框都不丢', async () => {
  const h = harness();
  await h.open();
  h.tool('region');
  h.drag(at(40, 40), at(120, 120));
  h.type('别丢我');
  assert.deepEqual(chipLabels(h), ['框 (40, 40, 80, 80)']);

  pressAt(h, at(80, 80).x, at(80, 80).y);
  moveTo(h, at(200, 200).x, at(200, 200).y);
  assert.notDeepEqual(chipLabels(h), ['框 (40, 40, 80, 80)'], '拖动中确实动了');
  h.key(h.q('.ie-scroll'), { key: 'Escape' });
  assert.equal(h.bubble().hidden, false, 'Esc 只中断这次调整，不关气泡');
  assert.deepEqual(chipLabels(h), ['框 (40, 40, 80, 80)'], '几何回到拖动前');
  assert.equal(h.field().value, '别丢我', '文字没被带走');
  assert.match(h.q('.ie-status').textContent, /几何回到拖动前/);

  // pointercancel 同样只放弃这次调整。
  pressAt(h, at(80, 80).x, at(80, 80).y);
  moveTo(h, at(160, 160).x, at(160, 160).y);
  h.emit(h.q('.ie-scroll'), 'pointercancel', pointerAt(at(160, 160).x, at(160, 160).y, { buttons: 0 }));
  assert.deepEqual(chipLabels(h), ['框 (40, 40, 80, 80)'], 'pointercancel 也退回原几何');
  assert.equal(h.bubble().hidden, false);

  // 点「选中」只是点亮手柄，面板与文字都留着；Esc 仍按旧语义收起这条未保存的草稿。
  h.click(frameButton(h, 0));
  assert.equal(h.bubble().hidden, false, '面板保持展开');
  assert.equal(h.q('[data-action="frame-done"]'), null, '没有中间确认按钮');
  assert.equal(h.field().value, '别丢我', '文字仍原样');
  h.save();
  assert.deepEqual((await h.notes())[0].rect, { x: 40, y: 40, width: 80, height: 80 }, '保存的仍是拖动前几何');
  assert.equal((await h.notes())[0].text, '别丢我');

  h.save();
  assert.deepEqual((await h.notes())[0].rect, { x: 40, y: 40, width: 80, height: 80 }, '保存的仍是拖动前几何');
  assert.equal((await h.notes())[0].text, '别丢我');
});
test('草稿A尚未保存就关联B：拖动未松手时两个框都保持实时可见', async () => {
  const h = harness();
  await h.open(); h.tool('region');
  h.drag(at(40, 40), at(120, 120)); h.type('A还没有保存');
  h.click(h.q('[data-action="bubble-add-region"]'));
  pressAt(h, at(200, 160).x, at(200, 160).y);
  moveTo(h, at(300, 250).x, at(300, 250).y);
  const calls = liveFrame(h).filter(call => call.name === 'strokeRect');
  for (const rect of [[40, 40, 80, 80], [200, 160, 100, 90]]) {
    assert.equal(calls.filter(call => JSON.stringify(call.args) === JSON.stringify(rect)).length, 2,
      `草稿框 ${rect} 应同时保留纸底与墨色两次描边`);
  }
  releaseAt(h, at(300, 250).x, at(300, 250).y);
  assert.equal(h.field().value, 'A还没有保存');
  h.save();
  const notes = await h.notes();
  assert.equal(notes.length, 1);
  // notes() 读取实际PNG说明区，不暴露内部targets；两块几何应一起交付。
  assert.match(notes[0].text, /A 框 \(40, 40, 80, 80\)/);
  assert.match(notes[0].text, /B 框 \(200, 160, 100, 90\)/);
});

test('关联框拖动过程中就画虚线框，不用等松手；关联期间旧框不被拖动', async () => {
  const h = harness();
  await h.open();
  h.tool('region');
  h.drag(at(40, 40), at(120, 120));
  h.type('主框');
  h.save();
  h.click(h.q('.ie-marker'));
  h.click(h.q('[data-action="bubble-add-region"]'));
  assert.equal(frameButton(h, 0).disabled, true, '选关联目标时「调框」先禁用');
  assert.equal(handleSquares(liveFrame(h)).length, 0, '选关联目标时不显示旧框手柄');

  // 从旧框里起手、拖到一半停下来：这一次点击属于关联，不是拖旧框。
  // 夹具把数组参数压成 'other'，这里临时包一层 setLineDash 拿到真实虚线参数。
  const display = h.q('.ie-display').context, originalDash = display.setLineDash, dashes = [];
  display.setLineDash = value => { dashes.push(Array.isArray(value) ? [...value] : value); originalDash(value); };
  pressAt(h, at(60, 60).x, at(60, 60).y);
  moveTo(h, at(200, 200).x, at(200, 200).y);
  const frame = liveFrame(h);
  display.setLineDash = originalDash;
  const dashed = dashes.filter(value => Array.isArray(value) && value.length === 2 && value[0] > 0);
  assert.ok(dashed.length > 0, `拖动中就要用虚线画这个新框：${json(dashes)}`);
  assert.ok(dashes.some(value => Array.isArray(value) && value.length === 0), '已存的框仍是实线');
  const strokes = frame.filter(call => call.name === 'strokeRect').map(call => call.args);
  const dragStrokes = strokes.filter(args => args.every((value, index) => Math.abs(value - [60, 60, 140, 140][index]) < 0.5));
  assert.equal(dragStrokes.length, 2, `拖动中的新框要真描两遍边（白底 + 墨线）：${json(strokes)}`);
  assert.deepEqual(dragStrokes[0], dragStrokes[1], '两遍描边用同一个矩形');
  assert.deepEqual(dragStrokes[0], [60, 60, 140, 140], '描的就是这次拖出来的尺寸');
  assert.deepEqual(chipLabelsRaw(h), ['框 (40, 40, 80, 80)'], '关联期间旧框几何不动');
  assert.equal(h.q('.ie-panel').hidden, false, '选关联目标时右栏不收起，避免布局跳动');
  assert.equal(handleSquares(frame).length, 0, '选关联目标时不显示旧框手柄');

  releaseAt(h, at(200, 200).x, at(200, 200).y);
  assert.deepEqual(chipLabels(h), ['框 (40, 40, 80, 80)', '框 (60, 60, 140, 140)'], '松手后关联目标才进暂存');
  assert.equal(frameButton(h, 1).getAttribute('aria-pressed'), 'true', '新关联的框直接成为当前框');
});

test('手柄与高亮边框只在预览：保存 / 复制 / 缩略图 / 识别局部图都不带', async () => {
  const h = harness({ recognizeText: async () => ({ text: '识别', language: 'zh-Hans-CN' }) });
  await h.open();
  h.tool('region');
  h.drag(at(40, 40), at(120, 120));
  h.type('别烧进图里');
  assert.equal(handleSquares(liveFrame(h)).length, 8, '草稿阶段就有手柄');
  h.save();
  h.click(h.q('.ie-marker'));
  assert.equal(handleSquares(liveFrame(h)).length, 8, '重新打开选中后也有手柄');

  const assertClean = (calls, label) => {
    assert.equal(handleSquares(calls).length, 0, `${label}不能带手柄`);
    assert.deepEqual(annotationMarks(calls), [], `${label}不能带框/编号这类预览标记`);
  };
  let before = h.dom.canvases.length;
  assert.ok(isPng(await h.editor.exportPNG()));
  assertClean(h.dom.canvases.slice(before)[0].context.calls, '保存导出');
  before = h.dom.canvases.length;
  await h.editor.exportClipboard();
  assertClean(h.dom.canvases.slice(before)[0].context.calls, '复制导出');
  before = h.dom.canvases.length;
  await h.editor.thumbnail();
  assertClean(h.dom.canvases.slice(before)[0].context.calls, '缩略图');

  // 识别用的局部图也只从 compose 取像素：手柄不会烧进去。（导出会把气泡收拢，先重新打开）
  h.click(h.q('.ie-marker'));
  h.click(h.q('[data-action="bubble-more-toggle"]'));
  before = h.dom.canvases.length;
  h.click(h.q('[data-action="bubble-ocr"]'));
  await h.tick(); await h.tick();
  const ocrCanvases = h.dom.canvases.slice(before);
  assert.ok(ocrCanvases.length >= 2, '合成画布 + 局部画布');
  for (const canvas of ocrCanvases) assert.equal(handleSquares(canvas.context.calls).length, 0, '识别局部图不带手柄');
});

test('调框与 OCR：改 A 清掉旧自动识别文字（手填保留），改 B 绝不动 A 的文字', async () => {
  const h = harness({ recognizeText: async () => ({ text: '识别出来的字', language: 'zh-Hans-CN' }) });
  await h.open();
  h.tool('region');
  h.drag(at(40, 40), at(160, 160));
  h.type('主框');
  h.click(h.q('[data-action="bubble-more-toggle"]'));
  h.click(h.q('[data-action="bubble-ocr"]'));
  await h.tick(); await h.tick();
  assert.equal(h.q('.ie-target-text').value, '识别出来的字', '前提：A 上已经有自动识别的文字');

  // 先只动 A（拖一下再 Esc）：不能把识别文字误清掉。
  pressAt(h, at(100, 100).x, at(100, 100).y);
  moveTo(h, at(120, 120).x, at(120, 120).y);
  h.key(h.q('.ie-scroll'), { key: 'Escape' });
  assert.equal(h.q('.ie-target-text').value, '识别出来的字', '取消拖动不清文字');

  // 加 B 框并保存，留着自动文字。
  addTarget(h, 'region', at(240, 180), at(320, 260));
  h.save();
  const id = h.markers()[0].id;

  // 动 B：A 的自动文字与几何都不变。
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"][data-target-index="1"]`));
  h.drag(at(280, 220), at(300, 240));
  assert.deepEqual(chipLabels(h), ['框 (40, 40, 120, 120)', '框 (260, 200, 80, 80)'], '只动了 B');
  assert.equal(h.q('.ie-target-text').value, '识别出来的字', '调整 B 不会误清 A 的文字');
  h.save();
  assert.match((await h.notes())[0].text, /\[目标文字\] 识别出来的字/, 'B 变了，A 的识别文字仍导出');

  // 动 A：旧自动文字作废，明确提示要重新识别。
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"][data-target-index="0"]`));
  h.drag(at(100, 100), at(110, 110));
  assert.equal(h.q('.ie-target-text').value, '', 'A 的几何变了，旧自动文字被清掉');
  assert.match(h.q('.ie-status').textContent, /重新识别|手填/);
  h.save();
  assert.equal((await h.notes())[0].text.includes('[目标文字]'), false, '旧自动文字不再跟着导出');

  // 手填的文字不属于自动识别：调 A 之后照旧保留。
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"][data-target-index="0"]`));
  h.input(h.q('.ie-target-text'), '手填的目标文字');
  h.save();
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"][data-target-index="0"]`));
  h.drag(at(120, 120), at(130, 130));
  assert.equal(h.q('.ie-target-text').value, '手填的目标文字', '手填文字不受几何变化影响');
  h.save();
  assert.match((await h.notes())[0].text, /\[目标文字\] 手填的目标文字/);
});

test('调 A 会让在途的识别回包作废：迟到的文字不能写到新几何上', async () => {
  const pending = [];
  const h = harness({ recognizeText: () => new Promise(resolve => { pending.push(resolve); }) });
  await h.open();
  h.tool('region');
  h.drag(at(40, 40), at(160, 160));
  h.type('主框');
  h.click(h.q('[data-action="bubble-more-toggle"]'));
  h.click(h.q('[data-action="bubble-ocr"]'));
  await h.tick(); await h.tick();
  assert.equal(h.calls.ocr.length, 1, '前提：识别已经发出并卡在回包上');

  // A 的几何一改，旧请求整份作废：回包再写回来就是错位的文字。
  h.drag(at(100, 100), at(120, 120));
  assert.deepEqual(chipLabels(h), ['框 (60, 60, 120, 120)']);
  pending[0]({ text: '迟到的字', language: 'zh-Hans-CN' });
  await h.tick(); await h.tick();
  assert.equal(h.q('.ie-target-text').value, '', '迟到的识别结果不能写到新几何上');

  // 作废不能把 OCR 永久卡在“正在识别”：按钮恢复可用，能再发一次并正常回包。
  const ocrButton = h.q('[data-action="bubble-ocr"]');
  assert.equal(ocrButton.disabled, false, '作废后不残留“识别中”状态');
  assert.doesNotMatch(ocrButton.textContent, /正在识别/);
  h.click(ocrButton);
  await h.tick(); await h.tick();
  assert.equal(h.calls.ocr.length, 2, '可以重试识别');
  pending[1]({ text: '重识别到的字', language: 'zh-Hans-CN' });
  await h.tick(); await h.tick();
  assert.equal(h.q('.ie-target-text').value, '重识别到的字', '重试的识别结果正常写回');
  h.save();
  assert.match((await h.notes())[0].text, /\[目标文字\] 重识别到的字/);
  assert.equal((await h.notes())[0].text.includes('迟到的字'), false, '迟到的文字始终不进去');
});

test('调 B 不影响 A 的在途识别：回包照常写进目标文字', async () => {
  const pending = [];
  const h = harness({ recognizeText: () => new Promise(resolve => { pending.push(resolve); }) });
  await h.open();
  h.tool('region');
  h.drag(at(40, 40), at(160, 160));
  h.type('主框');
  h.click(h.q('[data-action="bubble-more-toggle"]'));
  h.click(h.q('[data-action="bubble-ocr"]'));
  await h.tick(); await h.tick();
  assert.equal(h.calls.ocr.length, 1, '前提：A 的识别已经卡在回包上');

  // 这段时间里去调 B：B 不是识别对象，不能把 A 的请求作废。
  addTarget(h, 'region', at(240, 180), at(320, 260));
  h.click(frameButton(h, 1));
  h.drag(at(280, 220), at(300, 240));
  assert.deepEqual(chipLabels(h), ['框 (40, 40, 120, 120)', '框 (260, 200, 80, 80)'], 'B 确实改了');

  pending[0]({ text: 'A 的识别结果', language: 'zh-Hans-CN' });
  await h.tick(); await h.tick();
  assert.equal(h.q('.ie-target-text').value, 'A 的识别结果', '拖 B 期间 A 的识别正常回包');
  h.save();
  assert.match((await h.notes())[0].text, /\[目标文字\] A 的识别结果/);
});

test('框内拖动到右下越界：只夹位置，不把框压成 2px', async () => {
  const h = harness();
  await h.open();
  h.tool('region');
  h.drag(at(20, 20), at(120, 100));
  assert.deepEqual(chipLabels(h), ['框 (20, 20, 100, 80)']);

  // 一直往右下拖、远超画面：位置要停在“刚好贴右边/下边”，宽高必须原样。
  pressAt(h, at(60, 50).x, at(60, 50).y);
  moveTo(h, at(900, 700).x, at(900, 700).y);
  releaseAt(h, at(900, 700).x, at(900, 700).y);
  assert.deepEqual(chipLabels(h), ['框 (300, 220, 100, 80)'], '越界只挪位置，宽高不变');
  h.type('越界移动');
  h.save();
  assert.deepEqual((await h.notes())[0].rect, { x: 300, y: 220, width: 100, height: 80 }, '存下的也是原尺寸');
});

test('框贴图边时，图外那一半手柄仍抓得到（原生滚动条仍优先）', async () => {
  const h = harness();
  await h.open();
  h.tool('region');
  h.drag(at(0, 0), at(80, 80));
  assert.deepEqual(chipLabels(h), ['框 (0, 0, 80, 80)']);

  // 左上角手柄中心在图左上角；图外 6px 处还在 7px 热区里，不能再被“图外就早退”吞掉。
  const corner = at(0, 0);
  pressAt(h, corner.x - 6, corner.y - 6);
  moveTo(h, at(20, 20).x, at(20, 20).y);
  releaseAt(h, at(20, 20).x, at(20, 20).y);
  assert.deepEqual(chipLabels(h), ['框 (20, 20, 60, 60)'], '外半手柄也能拉出缩放');
});

test('browse 抓手不会被拐成移框，光标与新建行为不变', async () => {
  const h = harness();
  await h.open();
  h.tool('region');
  h.drag(at(40, 40), at(120, 120));
  h.type('别被抓手拖走');
  h.save();

  // 没有打开的气泡时，框上拖动就是普通画布手势（不产生批注几何变化、不进 ops）。
  h.tool('browse');
  h.drag(at(80, 80), at(160, 160));
  assert.deepEqual(chipLabels(h), [], 'browse 下没有气泡就没有可调框');
  assert.equal(h.markers().length, 1, '也没有多出批注');
  const saved = (await h.notes())[0];
  assert.deepEqual(saved.rect, { x: 40, y: 40, width: 80, height: 80 }, '框几何没被抓起手拖走');

  // 点批注没有框：选中它也不会冒出可拖的手柄（不影响点工具原本的用法）。
  h.tool('point');
  h.drag(at(200, 200));
  h.type('点批注');
  h.save();
  const pointMarker = h.markers().find(item => item.text === '2');
  h.click(h.q(`.ie-marker[data-annotation-id="${pointMarker.id}"][data-target-index="0"]`));
  assert.equal(h.q('.ie-target-chip [data-action="target-frame"]'), null, '点目标不给「调框」');
  assert.equal(handleSquares(liveFrame(h)).length, 0, '点批注没有手柄');
});

// —— 停靠布局：工具条与缩放控件不盖画布 ——
// 注：fixtures/editor-dom.cjs 故意没有布局引擎（“不做布局与样式计算”），
// 这里能证的是 DOM 结构与重绘输入（尺寸/坐标），真实像素不重叠由 CSS 结构和 Electron 窗口见证，见未验项。
test('停靠：绘图工具是根 grid 的直属行，缩放控件真实进底栏，画布内没有任何控件', async () => {
  const h = harness();
  await h.open();
  const toolbar = h.q('.ie-toolbar'), workspace = h.q('.ie-workspace'), footer = h.q('.ie-footer');
  const viewActions = h.q('.ie-view-actions');
  assert.equal(toolbar.parentNode, h.root, '工具条是根 grid 的直属行，不再绝对定位浮在画布上');
  assert.equal(viewActions.parentNode, footer, '缩放控件真实搬进 footer，而不是 CSS 挪走但 DOM 还占画布');
  assert.equal(workspace.querySelector('.ie-toolbar'), null);
  assert.equal(workspace.querySelector('.ie-view-actions'), null);
  // 画布里只允许批注/气泡这类交互内容，不充许编辑器铬件（工具、缩放、底栏）出现在上面。
  assert.deepEqual(h.qa('.ie-workspace [data-tool], .ie-workspace .ie-view-actions, .ie-workspace .ie-footer, .ie-workspace .ie-toolbar, .ie-workspace .ie-help').length, 0,
    '画布上没有任何编辑器控件，不可能吞掉落笔');
  assert.equal(toolbar.querySelector('.ie-grip'), null, '拖拽把手 DOM 已移除');
  assert.equal(toolbar.getAttribute('aria-label'), '工具');
  const main = h.q('.ie-main');
  assert.equal(main.parentNode, h.root, '画布与右栏共占一行');
  assert.deepEqual(h.root.children.map(node => node.className).filter(Boolean),
    ['ie-header', 'ie-toolbar', 'ie-warning', 'ie-main', 'ie-help', 'ie-footer'], '行顺序：页头/工具/警告/画布+右栏/帮助/底栏');
  assert.equal(h.q('.ie-warning').parentNode, h.root, '警告是一条独立行，不盖画布');
  assert.ok(footer.contains(h.q('.ie-status')), '短状态在底栏');
  assert.equal(h.q('.ie-footer-hint'), null, '长说明已收进帮助，不再占底栏');
  assert.ok(h.q('.ie-panel').parentNode === main, '批注面板在画布旁边的独立列，不在画布内');
  assert.equal(workspace.querySelector('.ie-panel'), null, '面板不放进画布');
  // 工具、撤销重做、缩放按钮都还在且可键盘到达。
  assert.equal(h.qa('[data-tool]').length, 10, '工具一个不少（多了一个「选择」）');
  assert.equal(h.q('[data-action="undo"]') !== null && h.q('[data-action="redo"]') !== null, true, '撤销重做仍在工具行');
  for (const node of [...h.qa('[data-tool]'), ...h.qa('.ie-view-actions button')]) {
    assert.equal(node.hidden, false, '按钮不能藏起来');
    assert.equal(node.disabled, false, `${node.dataset.tool || node.dataset.action} 打开后可点`);
  }
  // ResizeObserver 仍然盯 scroller（布局驱动没换）。
  const scroller = h.q('.ie-scroll');
  assert.ok(h.dom.observers.some(observer => observer.targets.includes(scroller)), '仍由 scroller 的尺寸变化驱动 layout');
});

test('窄宽 320：画布角点落笔不被控件吞，缩放后坐标仍对，resize 重算但不 reset zoom', async () => {
  const h = harness({ width: 1600, height: 1200,
    dom: { root: { width: 320, height: 600 }, workspace: { width: 320, height: 240 }, scroller: { width: 320, height: 240 } } });
  await h.open();
  const scroller = h.q('.ie-scroll');
  const mapping = () => {
    const t = h.displayTransform(), dpr = h.dom.window.devicePixelRatio || 1;
    return { zoom: t[0] / dpr, ox: t[4] / dpr, oy: t[5] / dpr };
  };
  let m = mapping();
  const clientOf = (sx, sy) => ({ x: m.ox + sx * m.zoom, y: m.oy + sy * m.zoom });
  assert.ok(m.zoom > 0 && m.zoom < 1, '大图在窄窗里是缩小显示');
  h.tool('point');
  h.drag(clientOf(0, 0)); h.type('左上角'); h.save();
  h.drag(clientOf(1600, 1200)); h.type('右下角'); h.save();
  let notes = await h.notes();
  assert.equal(notes.length, 2, '两个角都落得下笔（画布上没有任何控件抢指针）');
  assert.ok(Math.abs(notes[0].point.x) < 1 && Math.abs(notes[0].point.y) < 1, `左上角坐标：${json(notes[0].point)}`);
  assert.ok(Math.abs(notes[1].point.x - 1600) < 2 && Math.abs(notes[1].point.y - 1200) < 2, `右下角坐标：${json(notes[1].point)}`);
  // 控件本身在 footer/toolbar：点击它们不应在画布上落笔。
  const before = h.qa('.ie-marker').length;
  h.click(h.q('[data-action="zoom-in"]'));
  h.dom.flushFrames();
  assert.equal(h.qa('.ie-marker').length, before, '点底栏按钮不会误落笔');
  m = mapping();
  assert.ok(m.zoom > 0.18, '放大生效');
  h.drag(clientOf(800, 600)); h.type('放大后'); h.save();
  notes = await h.notes();
  assert.ok(Math.abs(notes[2].point.x - 800) < 3 && Math.abs(notes[2].point.y - 600) < 3,
    `缩放后落点仍按新 origin 换算：${json(notes[2].point)}`);
  // resize：换角色尺寸 + 推一次观察者，layout 重算；zoom 不 reset。
  const zoomBefore = mapping().zoom;
  const widthBefore = scroller.clientWidth;
  scroller.box = { left: 0, top: 0, width: 600, height: 420 };
  h.q('.ie-workspace').box = { left: 0, top: 0, width: 600, height: 420 };
  h.dom.resize(); h.dom.flushFrames(); h.dom.flushFrames();
  assert.notEqual(scroller.clientWidth, widthBefore, '夹具确实换了尺寸');
  assert.equal(h.q('.ie-display').style.width, '600px', '画布跟着新宽度重算');
  assert.ok(Math.abs(mapping().zoom - zoomBefore) < 1e-9, 'resize 不擅自 reset zoom');
  m = mapping();
  h.drag(clientOf(400, 300)); h.type('换尺寸后'); h.save();
  notes = await h.notes();
  assert.ok(Math.abs(notes[3].point.x - 400) < 3 && Math.abs(notes[3].point.y - 300) < 3,
    `resize 后坐标按新 origin 换算：${json(notes[3].point)}`);
  // 标注重绘：四条都还在标记层里（坐标随滚动/尺寸重算，不要求全部在可视区内）。
  assert.equal(h.markers().filter(item => !item.draft).length, 4, 'resize 后标注重绘不丢');
  assert.equal(h.markers().filter(item => item.ringSize > 0).length >= 1, true, '至少有一个落点圈正常渲染');
});

test('警告行出现不破布局；底栏焦点下空格/方向键不误画', async () => {
  const h = harness();
  await h.editor.open({ token: 'doc-warn', dataUrl: SOURCE_URL, width: 400, height: 300, warning: '本次长图仅保留已接部分' });
  h.dom.flushFrames();
  const warningNode = h.q('.ie-warning');
  assert.equal(warningNode.hidden, false, '警告能看到');
  assert.equal(warningNode.parentNode, h.root, '警告是独立行，不压画布');
  assert.equal(h.q('.ie-workspace').querySelector('.ie-warning'), null);
  // 底栏按钮接手键盘：空格/方向键不被画布快捷键掳走，也不落笔。
  const fit = h.q('[data-action="fit"]');
  fit.focus();
  const space = h.key(fit, { key: ' ' });
  assert.equal(space.defaultPrevented, false, '按钮上的空格保留原生激活，不拦翻页');
  h.key(fit, { key: 'ArrowDown' });
  assert.equal(h.editor.hasEdits, false, '底栏焦点下不产生任何标注');
  assert.equal(h.q('.ie-scroll').captured, undefined, '也不进入临时抓手');
  // 画布焦点仍可落笔，证明只是底栏不被抢。
  h.tool('point');
  h.drag(at(100, 80)); h.type('底栏之外照常'); h.save();
  assert.equal(h.editor.hasEdits, true);
  assert.deepEqual(h.numbers(), [1]);
});

test('动画模式禁批注和静态出口；换帧保历史，锁住 UI 仍可 renderFrame',async()=> {
  const h=harness({animation:true}); await h.open();
  for(const action of ['save','comment','notes-toggle']) assert.equal(h.q(`[data-action="${action}"]`).hidden,true);
  assert.equal(h.q('[data-action="copy"]').textContent,'应用编辑');
  h.tool('point'); h.drag({x:100,y:80}); assert.equal(h.editor.hasEdits,false);
  await assert.rejects(()=>h.editor.exportPNG(),/动画/);
  await assert.rejects(()=>h.editor.exportClipboard(),/动画/);
  assert.equal('exportFeedback' in h.editor, false, '动画模式也不再有任何反馈包出口');
  h.tool('pen'); h.drag({x:100,y:80},{x:140,y:90}); assert.equal(h.editor.hasEdits,true);
  assert.equal(await h.editor.replaceFrame({width:400,height:300}),true);
  assert.equal(h.editor.hasEdits,true);
  h.click(h.q('[data-action="undo"]')); assert.equal(h.editor.hasEdits,false);
  h.click(h.q('[data-action="redo"]')); assert.equal(h.editor.hasEdits,true);
  h.editor.setBusy(true);
  const rendered=h.editor.renderFrame({width:400,height:300,close(){throw new Error('调用者 source 不能 close');}});
  assert.equal(rendered.width,400); assert.equal(rendered.rgba.length,400*300*4);
  h.editor.setBusy(false);
  await assert.rejects(()=>h.editor.replaceFrame({width:2,height:2}),/尺寸/);
  h.tool('crop'); assert.throws(()=>h.editor.renderFrame({width:400,height:300}),/裁切/);
});

test('动画 replaceFrame 迟到结果不能复活 reset；同源 revision 保证最后请求优先',async()=> {
  const dom=createEditorDom(), pending=[], closed=[];
  const original=dom.createImageBitmap;
  dom.createImageBitmap=image=> image.naturalWidth ? original(image) : new Promise(resolve=>pending.push(()=>resolve({width:400,height:300,close(){closed.push(image.id);}})));
  loadScripts(dom.window,dom.document,dom);
  dom.document.images.set(SOURCE_URL,{width:400,height:300});
  const editor=dom.window.createImageEditor({root:dom.root,animation:true}); dom.attachBoxes();
  await editor.open({token:'t',dataUrl:SOURCE_URL,width:400,height:300});
  const first=editor.replaceFrame({id:'old'}), second=editor.replaceFrame({id:'new'});
  pending[1](); assert.equal(await second,true);
  pending[0](); assert.equal(await first,false); assert.deepEqual(closed,['old']);
  const last=editor.replaceFrame({id:'late'}); editor.reset(); pending[2]();
  assert.equal(await last,false); assert.equal(editor.isOpen,false); assert.ok(closed.includes('late'));
});
