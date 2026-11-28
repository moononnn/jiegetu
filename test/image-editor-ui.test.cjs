'use strict';
// 编辑页 UI 重构的定向测试：顶栏输出、分组工具、右栏批注面板、直接调框、收起不丢草稿。
// 用 test/fixtures/editor-dom.cjs 的最小 DOM 跑真实的 renderer/image-editor.js 与 annotations.js；
// 不采桌面、不画真实像素，只断言结构与交互（真实 Chromium 观感由父的浏览器联调另验）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createEditorDom, HTMLElement } = require('./fixtures/editor-dom.cjs');

const ROOT = path.join(__dirname, '..');
const SOURCE_URL = 'data:image/png;base64,UI-SOURCE';
const ZOOM = 0.92, ORIGIN = 16;                    // 400×300 图在 400×300 视口里：min(1,(400-32)/400)
const at = (x, y) => ({ x: ORIGIN + x * ZOOM, y: ORIGIN + y * ZOOM });

function harness({ width = 400, height = 300, animation = false, onMinimize = null, onPreviewRequest = null, onExitRequest = null, limits = null, visualsPatch = null } = {}) {
  const dom = createEditorDom();
  const sandbox = { window: dom.window, document: dom.document, HTMLElement, Image: dom.Image,
    createImageBitmap: dom.createImageBitmap, ResizeObserver: dom.ResizeObserver,
    requestAnimationFrame: dom.requestAnimationFrame, cancelAnimationFrame: dom.cancelAnimationFrame,
    setTimeout, clearTimeout, queueMicrotask, console };
  vm.createContext(sandbox);
  for (const file of ['core/check-regions.js', 'core/segment-export.js', 'renderer/annotations.js', 'renderer/annotation-visuals.js', 'renderer/image-editor.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: path.basename(file) });
    // 限额用例：annotations.js 的 LIMITS 是冻结对象，只能在加载编辑器之前换一份只读副本。
    if (limits && file === 'renderer/annotations.js') {
      sandbox.window.Annotations = { ...sandbox.window.Annotations,
        LIMITS: { ...sandbox.window.Annotations.LIMITS, ...limits } };
    }
    // 绘制用例：需要盯住共享 helper 有没有被调用时，也必须在 createImageEditor 之前换掉（同一份冻结对象不改原物）。
    if (visualsPatch && file === 'renderer/annotation-visuals.js') {
      sandbox.window.AnnotationVisuals = { ...sandbox.window.AnnotationVisuals, ...visualsPatch };
    }
  }
  dom.document.images.set(SOURCE_URL, { width, height });
  const commits = [];
  const closes = [];
  const previews = [], exits = [];
  const editor = sandbox.window.createImageEditor({ root: dom.root, animation,
    onMinimize: onMinimize ? (...args) => onMinimize(...args) : undefined,
    onPreviewRequest: onPreviewRequest ? () => { previews.push(true); return onPreviewRequest(); } : undefined,
    onExitRequest: onExitRequest ? () => { exits.push(true); return onExitRequest(); } : undefined,
    onCommit: action => commits.push(action), onClose: () => closes.push(true) });
  dom.attachBoxes();
  const q = selector => dom.root.querySelector(selector);
  const qa = selector => dom.root.querySelectorAll(selector);
  const click = node => dom.root.emit('click', { target: node });
  const open = async (extra = {}) => { await editor.open({ token: 'ui', dataUrl: SOURCE_URL, width, height, ...extra }); dom.flushFrames(); };
  const pointer = (x, y, extra = {}) => ({ clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1,
    preventDefault() {}, getCoalescedEvents: () => [], ...extra });
  const scroller = () => q('.ie-scroll');
  const drag = (from, to = from) => {
    dom.root.querySelector('.ie-scroll').emit('pointerdown', pointer(from.x, from.y));
    dom.root.querySelector('.ie-scroll').emit('pointermove', pointer(to.x, to.y));
    dom.root.querySelector('.ie-scroll').emit('pointerup', pointer(to.x, to.y, { buttons: 0 }));
  };
  const tool = id => click(q(`[data-tool="${id}"]`));
  const type = value => { const field = q('.ie-bubble-text'); field.value = value; dom.root.emit('input', { target: field }); };
  const chips = () => (q('.ie-note-bubble').hidden ? [] : qa('.ie-target-label').map(node => node.textContent));
  const note = () => q('.ie-note-bubble');
  // 导出结果从复制图下方的说明区读回来（与界面上看到的一致，不用内部 API）。
  // 新协议：一行一条意见，身份是编号（多目标带字母），冒号后面就是原文；说明区不再有任何坐标。
  const NOTE_HEAD = /^意见(\d+)(?:[A-H]?(?:、意见\d+[A-H]?)*)：([\s\S]*)$/;
  const readPanel = lines => {
    const annotations = [];
    let comment = '';
    for (const line of lines) {
      const head = NOTE_HEAD.exec(line);
      if (head) {
        annotations.push({ number: Number(head[1]), text: head[2] });
        continue;
      }
      if (line.startsWith('总体说明：')) comment = line.slice('总体说明：'.length);
    }
    return { annotations, comment };
  };
  // 几何不再出现在说明文字里：从编辑器只读诊断接口取，并按当前视窗投影成成图坐标。
  const shapes = () => {
    const state = editor.debug(), view = state.view;
    return state.notes.map(note => ({
      id: note.id, number: note.number, kind: note.kind,
      ...(note.kind === 'point' ? { point: { x: note.point.x - view.x, y: note.point.y - view.y } }
        : { rect: { x: note.rect.x - view.x, y: note.rect.y - view.y, width: note.rect.width, height: note.rect.height } })
    }));
  };
  const copy = async () => {
    const before = dom.canvases.length;
    const raw = await editor.exportClipboard();
    const canvas = dom.canvases[before] || null;
    const lines = canvas ? canvas.context.calls.filter(call => call.name === 'fillText').map(call => String(call.args[0])) : [];
    const panel = readPanel(lines);
    const geometry = shapes();
    const annotations = panel.annotations.map(item => {
      const shape = geometry.find(entry => entry.number === item.number);
      return shape ? { ...shape, text: item.text } : item;
    });
    return { raw, lines, annotations, comment: panel.comment };
  };
  const notes = async () => { try { return (await copy()).annotations; } catch { return []; } };
  return { dom, window: dom.window, root: dom.root, editor, commits, closes, previews, exits, q, qa, click, open, drag, tool, type, chips, note, copy, notes,
    more: () => click(q('[data-action="bubble-more-toggle"]')),
    field: () => q('.ie-bubble-text'), save: () => click(q('[data-action="bubble-save"]')), cancel: () => click(q('[data-action="bubble-cancel"]')),
    key: key => dom.window.emit('keydown', { key, target: q('.ie-scroll'), preventDefault() {}, stopImmediatePropagation() {} }) };
}

test('顶栏三段输出按另存并复制 / 保存并复制 / 复制排列，动作映射分别是 save / save-quick / copy', async () => {
  const h = harness();
  await h.open();
  const exports = [...h.q('.ie-exports').children];
  assert.deepEqual(exports.map(node => node.dataset.action), ['segments', 'save-as', 'save', 'copy'], '分段导出在最前，三个原有输出次序与映射不变');
  assert.deepEqual(exports.map(node => node.textContent), ['分段导出', '另存并复制…', '保存并复制', '复制图片']);
  const byAction = action => exports.find(node => node.dataset.action === action);
  assert.equal(byAction('copy').classList.contains('ie-primary'), true, '复制是主按钮');
  // 另存与保存同一层：细边纸白，不再是没轮廓的透明按钮；复制仍唯一主按钮。
  assert.equal(byAction('save-as').classList.contains('ie-outline'), true, '另存与保存同级细边');
  assert.equal(byAction('save').classList.contains('ie-outline'), true);
  assert.equal(byAction('segments').classList.contains('ie-outline'), true, '分段导出也是次级按钮，不抢主按钮');
  assert.equal(byAction('copy').classList.contains('ie-outline'), false, '复制不能降级成次级按钮');
  // 标题要说明白：保存与另存都会把同一张成图复制到剪贴板。
  assert.match(byAction('save').getAttribute('title'), /复制到剪贴板/);
  assert.match(byAction('save-as').getAttribute('title'), /复制到剪贴板/);

  h.click(byAction('save-as')); await new Promise(resolve => setImmediate(resolve));
  h.click(byAction('save')); await new Promise(resolve => setImmediate(resolve));
  h.click(byAction('copy')); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.commits, ['save', 'save-quick', 'copy'], '另存=save、保存=save-quick、复制=copy');
  assert.equal(h.editor.isOpen, true, '输出动作不自己关窗');
});

test('移进输出组的「编辑图片」照样吃通用忙碌禁用，位置不靠 CSS order', async () => {
  const h = harness();
  await h.open();
  const group = h.q('.ie-exports');
  // 页面就是这样把宿主的按钮插进输出组最前面的（真实 DOM 顺序：编辑 → 另存 → 保存 → 复制）。
  const edit = h.dom.document.createElement('button');
  edit.id = 'host-edit';
  edit.textContent = '编辑图片';
  group.append(edit);
  group.childNodes.unshift(group.childNodes.pop());
  assert.equal(group.children[0], edit, '编辑按钮在组里第一个');
  h.editor.setBusy(false);
  assert.equal(edit.disabled, false, '空闲时可点');
  h.editor.setBusy(true);
  assert.equal(edit.disabled, true, '保存/复制进行中，编辑入口一起禁用');
  h.editor.setBusy(false);
  assert.equal(edit.disabled, false);
  // 输出四按钮的顺序与主次不受影响（分段导出在最前，其余三个不动）。
  assert.deepEqual([...group.children].filter(node => node.dataset.action).map(node => node.dataset.action), ['segments', 'save-as', 'save', 'copy']);
});

test('动画模式没有任何截图输出：只剩「应用编辑」一个动作', async () => {
  const h = harness({ animation: true });
  await h.open();
  for (const selector of ['[data-action="save"]', '[data-action="save-as"]', '[data-action="comment"]',
    '[data-tool="point"]', '[data-tool="region"]', '[data-action="notes-toggle"]']) {
    assert.equal(h.q(selector).hidden, true, `${selector} 不该出现在动画模式`);
  }
  const copy = h.q('[data-action="copy"]');
  assert.equal(copy.hidden, false);
  assert.equal(copy.textContent, '应用编辑');
});

test('横排工具按四组排，撤销/重做只在顶栏；属性只跟当前工具，长说明收进帮助里', async () => {
  const h = harness();
  await h.open();
  const labels = h.qa('.ie-tool-group .ie-group-label').map(node => node.textContent);
  assert.deepEqual(labels, ['查看', '批注', '画标记', '处理图片']);
  const groups = h.qa('.ie-tool-group');
  const toolsOf = index => [...groups[index].querySelectorAll('[data-tool]')].map(node => node.dataset.tool);
  assert.deepEqual(toolsOf(0), ['browse', 'select'], '查看组：抓手 + 选择');
  assert.deepEqual(toolsOf(1), ['point', 'region', 'connect'], '批注三件：点、框、连线相邻');
  assert.deepEqual(toolsOf(2), ['pen', 'arrow', 'line', 'rect']);
  assert.deepEqual(toolsOf(3), ['mosaic', 'crop', 'ocr']);
  // 撤销/重做只有一套，固定在不滚动的顶栏：工具区窄到要滚也不会把按钮折行裁掉。
  const history = h.q('.ie-header .ie-history');
  assert.ok(history, '顶栏有编辑历史组');
  assert.deepEqual([...history.querySelectorAll('[data-action]')].map(node => node.dataset.action), ['undo', 'redo']);
  assert.deepEqual([...history.querySelectorAll('[data-action] span')].map(node => node.textContent), ['撤销', '重做'],
    '沿用原来的按钮文案（不改叫法）');
  assert.equal(h.qa('.ie-toolbar [data-action="undo"]').length, 0, '工具区不再重复一套撤销');
  assert.equal(h.qa('.ie-toolbar [data-action="redo"]').length, 0, '工具区不再重复一套重做');
  assert.deepEqual([...h.q('.ie-header').children].map(node => node.className), ['ie-document', 'ie-history', 'ie-exports'],
    '历史组夹在文档标题与导出区之间');
  // 文字按原型：画笔 / 点批注，不再叫自由笔 / 批注。
  assert.deepEqual([...groups[2].querySelectorAll('[data-tool] span')].map(node => node.textContent), ['画笔', '箭头', '直线', '矩形']);
  assert.deepEqual([...groups[1].querySelectorAll('[data-tool] span')].map(node => node.textContent), ['点批注', '框批注', '连线']);
  assert.equal(groups[1].querySelector('[data-action="comment"]').textContent, '补充说明', '补充说明跟在批注组');

  // 属性行只显示当前工具的设置：抓手 → 裁切 → 马赛克 → 画笔。
  const visibleTools = () => h.qa('[data-tools]').filter(node => !node.hidden).map(node => node.dataset.tools);
  h.tool('browse');
  assert.ok(visibleTools().every(value => value.includes('browse')));
  h.tool('crop');
  assert.ok(visibleTools().every(value => value.includes('crop')), `裁切只显示裁切项：${visibleTools()}`);
  assert.ok(visibleTools().includes('crop'), '裁切有尺寸/应用按钮');
  h.tool('mosaic');
  assert.ok(visibleTools().every(value => value.includes('mosaic')));
  h.tool('pen');
  assert.ok(visibleTools().every(value => value.includes('pen')));
  // 两个场景按钮真的不存在，不是藏起来：DOM 里一个都没有。
  assert.equal(h.q('[data-tool="note-move"]'), null);
  assert.equal(h.q('[data-tool="note-reference"]'), null);
  // 点/框/连线也不堆属性项，只留一句画布提示。
  h.tool('point');
  assert.ok(visibleTools().every(value => value === 'point'));
  h.tool('region');
  assert.ok(visibleTools().every(value => value === 'region'));
  // 连线是独立工具，不是像素「直线」：id 不同、属性提示各一份。
  assert.notEqual(h.q('[data-tool="connect"]').getAttribute('data-tool'), h.q('[data-tool="line"]').getAttribute('data-tool'));
  assert.match(h.q('[data-tool="connect"]').title, /两处|连/);

  // 长说明在帮助里，底栏不再放提示长句。
  assert.equal(h.q('.ie-footer-hint'), null, '底栏只留短状态与缩放');
  assert.equal(h.q('.ie-help').hidden, true, '帮助默认收起');
  h.click(h.q('[data-action="help-toggle"]'));
  assert.equal(h.q('.ie-help').hidden, false, '帮助可展开');
  assert.match(h.q('.ie-help').textContent, /空格|滚轮/, '帮助里写清操作');
  // 复制成图带上批注标记（框、编号、连线），图上的编号与下方说明一一对应：帮助不能反着说主图是干净的。
  assert.match(h.q('.ie-help').textContent, /批注的框、编号与连线也画在图上/, '帮助要说清成图带上批注标记');
  assert.match(h.q('.ie-help').textContent, /图上的编号与下方说明里的意见编号一一对应/, '帮助要说清图上编号与说明对应');
  assert.doesNotMatch(h.q('.ie-help').textContent, /复制图片的主图同样干净/, '不能反着说主图不带批注标记');
  assert.equal(h.q('[data-action="help-toggle"]').getAttribute('aria-expanded'), 'true');
  h.window.emit('keydown', { key: 'Escape', target: h.q('.ie-scroll'), preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(h.q('.ie-help').hidden, true, 'Esc 收起帮助');
});

test('便签贴着批注出现，不再占画布列；点/框落位即成可编辑标记，文字离开输入框就记下', async () => {
  const h = harness();
  await h.open();
  assert.equal(h.q('.ie-panel'), null, '常驻说明侧栏已撤掉（DOM 里不存在）');
  assert.equal(h.q('.ie-note-list'), null, '位置清单不在 DOM');
  assert.equal(h.q('.ie-relation-list'), null, '关系清单不在 DOM');
  assert.equal(h.q('[data-action="multi-toggle"]'), null, '多选开关不在 DOM');
  assert.equal(h.q('.ie-quick-bar'), null, '画布浮条已撤掉（DOM 里不存在）');
  assert.equal(h.q('.ie-relation-bar'), null, '关系浮条已撤掉（DOM 里不存在）');
  assert.equal(h.note().hidden, true, '没选中时便签不占位置也不占列');
  const canvasWidth = h.q('.ie-scroll').clientWidth;

  h.tool('region');
  h.drag(at(40, 40), at(120, 120));
  assert.equal(h.editor.hasEdits, true, '框一落位就进历史，不等「完成」');
  assert.equal(h.note().hidden, false, '这条批注的便签直接打开');
  assert.equal(h.q('.ie-workspace').contains(h.note()), true, '便签贴在画布上，不再另开一列');
  assert.equal(h.q('.ie-scroll').clientWidth, canvasWidth, '便签出现不改变画布宽度');
  assert.match(String(h.note().style.left), /^\d+px$/, '便签按批注位置算 left');
  assert.equal(h.q('[data-action="bubble-save"]'), null, '不再有「完成批注」这道必经步骤');
  const field = h.field();
  field.value = '落位后直接写';
  h.root.emit('input', { target: field });
  h.tool('pen');
  assert.deepEqual((await h.notes()).map(item => item.text), ['落位后直接写'], '切工具前已经把没按回车的字写回');
});

test('直接调框：拖动/手柄松手就是一次可撤销变更；取消编辑不等于删标记', async () => {
  const h = harness();
  await h.open();
  h.tool('region');
  h.drag(at(40, 40), at(120, 120));
  h.type('原始文字');
  const id = h.q('.ie-marker').dataset.annotationId;
  h.more();

  // 新建的框就是当前框：直接拖框内就能移动。
  assert.equal(h.qa('[data-action="target-select"]')[0].getAttribute('aria-pressed'), 'true', '打开即选中 A 框');
  h.drag(at(80, 80), at(100, 100));
  assert.deepEqual(h.chips().map(value => value.split(' · ')[0]), ['框'], '拖框内直接移动，无需中间确认');
  // 再拖右下角手柄缩放。
  h.drag(at(140, 140), at(160, 160));
  assert.deepEqual(h.chips().map(value => value.split(' · ')[0]), ['框'], '拖手柄直接缩放');
  assert.deepEqual((await h.notes())[0].rect, { x: 60, y: 60, width: 100, height: 100 }, '松手后导出就是新几何');

  // Esc 只退出编辑：不删标记、不改文字，也不改几何。
  h.key('Escape');
  assert.equal(h.note().hidden, true, '退出编辑后便签收起');
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"]`));
  assert.equal(h.field().value, '原始文字');
  assert.equal(h.editor.hasEdits, true);
});

test('便签与「更多」开合不改变画布尺寸、缩放与滚动；切换对象不丢没按回车的字', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(80, 80));
  h.type('还没写完');
  const canvasWidth = h.q('.ie-scroll').clientWidth;
  const before = h.editor.debug();
  assert.equal(h.note().hidden, false, '选中时便签在场');
  assert.equal(h.editor.hasEdits, true, '落位就已入历史');

  h.more();
  assert.equal(h.q('.ie-bubble-more').hidden, false, '更多字段在便签里展开');
  h.dom.flushFrames();
  assert.equal(h.q('.ie-scroll').clientWidth, canvasWidth, '展开更多字段不挤动画布');
  assert.equal(h.editor.debug().zoom, before.zoom, '展开更多不改缩放');
  assert.deepEqual([h.q('.ie-scroll').scrollLeft, h.q('.ie-scroll').scrollTop], [0, 0], '展开更多不偷偷滚画布');

  h.tool('point');
  h.drag(at(200, 200));
  h.type('第二条');
  assert.deepEqual((await h.notes()).map(item => item.text).sort(), ['还没写完', '第二条'].sort(), '上一条的字不丢，新的一条接上');
  assert.equal(h.q('[data-action="panel-collapse"]'), null, '不再需要收起/恢复面板这个来回');
});

test('补充说明是画布上的紧凑便签，不占列；收起后画布不变', async () => {
  const h = harness();
  await h.open();
  const width = h.q('.ie-scroll').clientWidth;
  h.click(h.q('[data-action="comment"]'));
  assert.equal(h.q('.ie-comment-bubble').hidden, false);
  assert.equal(h.q('.ie-comment-bubble').classList.contains('ie-note-card'), true, '补充说明用同一种便签');
  assert.equal(h.q('.ie-scroll').clientWidth, width, '打开补充说明不改变画布宽度');
  const field = h.q('.ie-comment');
  field.value = '整体没问题';
  h.root.emit('input', { target: field });
  h.click(h.q('[data-action="comment-close"]'));
  assert.equal(h.q('.ie-comment-bubble').hidden, true, '收起补充说明');
  assert.equal(h.q('.ie-scroll').clientWidth, width, '收起后画布尺寸不变');
  assert.match((await h.copy()).comment, /整体没问题/);
});

test('新建/重开批注把焦点交给便签输入框；同一份输入的同步不抢焦点', async () => {
  const h = harness();
  await h.open();
  const input = h.field();
  const seen = [];
  const original = input.focus;
  // 真浏览器里 display:none 祖先下的 focus 不生效：这里记录调用瞬间的显隐。
  input.focus = function (...args) {
    seen.push({ noteHidden: h.note().hidden });
    return original.apply(this, args);
  };

  h.tool('point');
  h.drag(at(80, 80));
  assert.equal(seen.length, 1, '新建点批注只聚焦一次');
  assert.deepEqual(seen[0], { noteHidden: false }, '聚焦时便签已显示');
  assert.equal(h.dom.document.activeElement, input, '真实 activeElement 落在说明区输入框');

  // 同一份输入的再同步（忙碌开关会调 syncBubble）：不重聚焦、不改值。
  h.q('.ie-scroll').focus();
  h.editor.setBusy(false);
  h.dom.flushFrames();
  assert.equal(seen.length, 1, '同一批注的同步不重复聚焦');
  assert.equal(h.dom.document.activeElement, h.q('.ie-scroll'), '焦点没有被抢回输入框');

  // 点编号换成另一条：换绑时再聚焦一次，值同步。
  h.type('写一句');
  h.tool('point');
  h.drag(at(220, 220));
  h.type('第二条');
  h.q('.ie-scroll').focus();
  h.click(h.q('.ie-marker'));
  assert.equal(seen.length, 3, '重开旧批注聚焦一次');
  assert.equal(h.dom.document.activeElement, input);
  assert.equal(input.value, '写一句', '重开的原文已经同步到输入框');
});

test('最小化按钮只在宿主传了 onMinimize 时出现；失败只报状态，不提交也不关窗', async () => {
  // 没传 hook（GIF 编辑就是这种）：按钮不存在效果，一直隐藏。
  const plain = harness();
  await plain.open();
  assert.equal(plain.q('[data-action="minimize"]').hidden, true, '无 hook 时隐藏');
  assert.equal(plain.q('[data-action="minimize"]').closest('.ie-exports'), null, '最小化不占输出按钮位置');

  const calls = [];
  const h = harness({ onMinimize: () => { calls.push('min'); } });
  await h.open();
  const button = h.q('[data-action="minimize"]');
  assert.equal(button.hidden, false, '有 hook 就显示');
  assert.deepEqual([...h.q('.ie-exports').children].map(node => node.dataset.action), ['segments', 'save-as', 'save', 'copy'], '输出顺序与映射不变');
  h.click(button);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['min']);
  assert.equal(h.editor.isOpen, true, '最小化不关编辑器');
  assert.deepEqual(h.commits, [], '最小化不提交');

  // 失败：只显示状态，编辑器与文档都留着。
  const failing = harness({ onMinimize: () => Promise.reject(new Error('窗口忙')) });
  await failing.open();
  failing.click(failing.q('[data-action="minimize"]'));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(failing.q('.ie-status').textContent, /没能最小化窗口：窗口忙/);
  assert.equal(failing.editor.isOpen, true, '失败也不关编辑器');
  assert.deepEqual(failing.commits, [], '失败也不提交');
});

test('同步不重建 textarea：输入法组合串不会被打断', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(80, 80));
  const field = h.field();
  field.value = '拼';
  h.root.emit('input', { target: field });
  // 触发一次完整 sync（忙碌开关会走 sync() → syncBubble），节点必须还是同一个。
  h.editor.setBusy(false);
  h.dom.flushFrames();
  assert.equal(h.field(), field, '同一个 textarea 节点');
  assert.equal(field.value, '拼', '值没被回写覆盖');
});

// —— 只读预览：长截图结果默认同窗浏览，只切显示不换文档 ——
test('只读预览：工具/历史/批注入口全不接，缩放仍可用，退回编辑恢复', async () => {
  const h = harness();
  await h.open();
  h.tool('pen');
  h.drag(at(40, 40), at(90, 90));
  assert.equal(h.editor.hasEdits, true);
  assert.equal(h.editor.setPreviewMode(true), true);
  assert.equal(h.editor.previewMode, true);
  assert.equal(h.root.classList.contains('ie-preview'), true, '预览样式挂在编辑器根');
  assert.equal(h.q('[data-tool="browse"]').getAttribute('aria-pressed'), 'true', '预览固定在抓手');
  h.click(h.q('[data-tool="pen"]'));
  assert.equal(h.q('[data-tool="pen"]').getAttribute('aria-pressed'), 'false', '点工具不切');
  assert.equal(h.q('[data-action="undo"]').disabled, true, '撤销在预览里禁用');
  assert.equal(h.q('[data-action="redo"]').disabled, true);
  h.click(h.q('[data-action="undo"]'));
  assert.equal(h.editor.hasEdits, true, '点击撤销不会真撤');
  h.window.emit('keydown', { key: 'z', ctrlKey: true, target: h.q('.ie-scroll'), preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(h.editor.hasEdits, true, 'Ctrl+Z 在预览里也不改历史');
  h.click(h.q('[data-action="comment"]'));
  assert.equal(h.q('.ie-comment-bubble').hidden, true, '预览里补充说明不展开');
  h.drag(at(120, 120), at(160, 160));
  assert.equal(h.note().hidden, true, '拖拽不落新点/新框');
  const before = h.q('.ie-zoom').textContent;
  h.click(h.q('[data-action="zoom-in"]'));
  assert.notEqual(h.q('.ie-zoom').textContent, before, '缩放仍可用');
  h.click(h.q('[data-action="fit"]'));
  assert.equal(h.editor.previewMode, true, '缩放不改模式');
  assert.equal(h.editor.setPreviewMode(false), false);
  assert.equal(h.root.classList.contains('ie-preview'), false);
  h.click(h.q('[data-tool="pen"]'));
  assert.equal(h.q('[data-tool="pen"]').getAttribute('aria-pressed'), 'true', '回到编辑可切工具');
});

test('进预览前先收口说明区，不静默丢字', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(50, 50));
  h.type('这句要留下');
  assert.equal(h.editor.hasEdits, true, '落位即入历史');
  assert.equal(h.editor.setPreviewMode(true), true);
  assert.equal(h.note().hidden, true, '进预览后编辑区收起');
  assert.deepEqual((await h.notes()).map(item => item.text), ['这句要留下']);
  assert.equal(h.editor.previewMode, true);
});

test('预览 Esc 只申请退出；编辑态末端 Esc 回同窗预览而不是关窗', async () => {
  const calls = [];
  const h = harness({ onExitRequest: () => { calls.push('exit'); return true; }, onPreviewRequest: () => { calls.push('preview'); return true; } });
  await h.open();
  h.tool('point'); h.drag(at(60, 60)); h.type('写下来的字');
  h.key('Escape');
  assert.deepEqual(calls, [], '第一下只退出说明编辑');
  assert.equal(h.editor.hasEdits, true, '标记不删');
  assert.equal(h.note().hidden, true);
  h.key('Escape');
  assert.deepEqual(calls, ['preview'], '末端 Esc 回同窗预览');
  assert.equal(h.root.hidden, false, '没有关窗');
  assert.equal(h.editor.isOpen, true);
  h.editor.setPreviewMode(true);
  h.key('Escape');
  assert.deepEqual(calls, ['preview', 'exit']);
  assert.equal(h.root.hidden, false);
  assert.equal(h.editor.isOpen, true);
  // 没接这两个回调时保持旧语义：返回预览=收起，并回调宿主。
  const plain = harness();
  await plain.open();
  plain.click(plain.q('[data-action="close"]'));
  assert.equal(plain.closes.length, 1, '旧宿主仍然拿到 onClose');
  assert.equal(plain.root.hidden, true);
});

// —— 选择、多选、关联与位置清单：新契约的行为回归 ——
function relationHarness(options = {}) {
  const h = harness(options);
  const scroller = () => h.q('.ie-scroll');
  const make = (x, y, buttons, extra = {}) => ({ clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0, buttons,
    preventDefault() {}, stopImmediatePropagation() {}, getCoalescedEvents: () => [], ...extra });
  const clickAt = (x, y, extra = {}) => {
    scroller().emit('pointerdown', make(x, y, 1, extra));
    scroller().emit('pointerup', make(x, y, 0, extra));
    h.dom.flushFrames();
  };
  const debug = () => h.editor.debug();
  // 按住 B 再拖走：两次点击手势的第二次按住不能盲目连接按下时的目标。
  const pressDrag = (from, to, extra = {}) => {
    scroller().emit('pointerdown', make(from.x, from.y, 1, extra));
    scroller().emit('pointermove', make(to.x, to.y, 1, extra));
    scroller().emit('pointerup', make(to.x, to.y, 0, extra));
    h.dom.flushFrames();
  };
  return { ...h, scroller, clickAt, pressDrag, debug };
}

async function twoMarks(h, { textA = '上边按钮', textB = '下面的分组' } = {}) {
  h.tool('point');
  h.drag(at(60, 60));
  h.type(textA);
  h.tool('region');
  h.drag(at(180, 150), at(280, 240));
  h.type(textB);
  h.tool('select');
  h.dom.flushFrames();
}

test('连线工具拖一处到另一处：当次入历史并选中，线里的字与线同一步撤销', async () => {
  const h = relationHarness();
  await h.open();
  await twoMarks(h);
  h.tool('connect');
  assert.equal(h.q('[data-tool="connect"]').getAttribute('aria-pressed'), 'true', '点击后明确切连线工具');
  assert.match(h.q('.ie-status').textContent, /先点或按住一处/, '状态提示先说清下一步');
  const beforeOps = h.debug().ops;

  h.drag(at(60, 60), at(180, 150));
  const created = h.debug();
  assert.equal(created.relations.length, 1, '按住拖到另一处就建立');
  assert.equal(created.ops, beforeOps + 1, '建线只多一条 op');
  assert.ok(created.selectedRelationId, '建立后选中这条线');
  assert.equal(h.q('.ie-relation-bubble').hidden, false, '线旁便签打开');
  assert.equal(h.q('[data-action="relation-delete"]').textContent, '删线');

  // 线里的字写回同一条 op，不拆成新历史；两端原文不改。
  const field = h.q('.ie-relation-text');
  field.value = '两个入口的按钮样式统一';
  h.root.emit('input', { target: field });
  assert.equal(h.debug().ops, beforeOps + 1, '线纯改字不 push 新历史');
  assert.equal(h.debug().relations.map(item => item.text).join('|'), '两个入口的按钮样式统一');
  assert.equal(h.debug().notes.map(note => note.text).join('|'), '上边按钮|下面的分组', '两边原文不合并');

  // 离开输入后第一次画布撤销：只退线。
  h.q('.ie-scroll').focus();
  h.click(h.q('[data-action="undo"]'));
  const undone = h.debug();
  assert.equal(undone.relations.length, 0, '撤销只退线');
  assert.equal(undone.notes.length, 2, '两处标记还在');
  assert.equal(undone.notes.map(note => note.text).sort().join('|'), '上边按钮|下面的分组', '两边文字都保留');
  assert.equal(undone.selectedRelationId, null, '失效的线选择被清掉');

  h.click(h.q('[data-action="redo"]'));
  assert.equal(h.debug().relations.length, 1, '重做恢复线');
  assert.equal(h.debug().relations[0].text, '两个入口的按钮样式统一', '重做带回原来的共同说明');
});

test('连线随时可用：0 条批注也能进连线；空白起手只暂存坐标，Esc 不留孤立空批注', async () => {
  const solo = relationHarness();
  await solo.open();
  assert.equal(solo.q('[data-tool="connect"]').disabled, false, '没有批注时连线也可用');
  assert.match(solo.q('[data-tool="connect"]').title, /空白|任意一处/, '标题说清空白也能起手');
  solo.tool('connect');
  assert.equal(solo.debug().tool, 'connect', '点一下就进连线工具');
  const before = solo.debug();
  solo.clickAt(at(80, 80).x, at(80, 80).y);
  const armed = solo.debug();
  assert.equal(armed.notes.length, 0, '第一击空白不产生批注');
  assert.equal(armed.ops, before.ops, '第一击空白不写历史');
  assert.equal(armed.connect.phase, 'armed', '第一击只记起点、等第二击');
  assert.ok(Math.abs(armed.connect.start.point.x - 80) < 0.6 && Math.abs(armed.connect.start.point.y - 80) < 0.6,
    '起点只是一个临时坐标');
  solo.key('Escape');
  const cancelled = solo.debug();
  assert.equal(cancelled.connect, null, 'Esc 取消这次手势');
  assert.equal(cancelled.notes.length, 0, '取消后不留孤立空批注');
  assert.equal(cancelled.ops, before.ops, '取消不写历史');
});

test('空白→空白一次动作：两个空点加一条线，一条共同说明就够；撤销/重做整组，原批注不动', async () => {
  const h = relationHarness();
  await h.open();
  await twoMarks(h);
  const before = h.debug();
  h.tool('connect');
  h.drag(at(300, 60), at(300, 260));
  const made = h.debug();
  assert.equal(made.relations.length, 1, '空白→空白拖出一条线');
  assert.equal(made.notes.length, 4, '两端空白各落一个空文字点');
  assert.equal(made.notes.slice(2).map(note => note.text || '').join('|'), '|', '新点不填假占位字');
  assert.equal(made.ops, before.ops + 3, '两个空点 + 一条关系，同一次动作');
  assert.equal(made.selectedRelationId, made.relations[0].id, '成功后选中这条线');
  assert.equal(h.q('.ie-relation-bubble').hidden, false, '只开共同说明');
  assert.equal(h.q('.ie-note-bubble').hidden, true, '不弹第二份输入');
  assert.match(h.q('.ie-status').textContent, /共同说明/, '提示写这一条共同说明');
  const ids = made.notes.slice(2).map(note => note.id);

  const field = h.q('.ie-relation-text');
  field.value = '两处一起看';
  h.root.emit('input', { target: field });
  const copied = await h.copy();
  assert.equal(copied.annotations.length, 4, '四个位置都进说明');
  assert.ok(copied.annotations.slice(2).every(item => /见 关系1/.test(item.text)),
    '两个空点都被这一句共同说明覆盖，不逼着各写一句');
  assert.equal(copied.annotations.slice(0, 2).map(item => item.text).join('|'), '上边按钮|下面的分组',
    '原有两端的字不被覆盖');

  // 一次撤销整组：自动新点与线一起回退；原有批注和文字不动。
  h.q('.ie-scroll').focus();
  h.click(h.q('[data-action="undo"]'));
  const undone = h.debug();
  assert.equal(undone.relations.length, 0, '一次撤销把线也撤掉');
  assert.equal(undone.notes.length, 2, '自动落的新点跟着撤回');
  assert.equal(undone.notes.map(note => note.text).join('|'), '上边按钮|下面的分组', '原有文字不动');
  assert.equal(undone.cursor, before.cursor, '一次撤销退到动手前那一步');
  // 一次重做：同一组稳定身份与共同说明都回来。
  h.click(h.q('[data-action="redo"]'));
  const redone = h.debug();
  assert.equal(redone.relations.length, 1, '一次重做恢复线');
  assert.equal(redone.relations[0].text, '两处一起看', '重做带回共同说明');
  assert.equal(redone.notes.slice(2).map(note => note.id).join('|'), ids.join('|'), '重做恢复同样的稳定身份');
});

test('已有↔空白都能连：吸附已有不复制点；太近/图外不留半成品；第二击拖离按松手处落点', async () => {
  const h = relationHarness();
  await h.open();
  await twoMarks(h);
  h.tool('connect');
  // 已有 → 空白（两次点击）
  h.clickAt(at(60, 60).x, at(60, 60).y);
  h.clickAt(at(340, 60).x, at(340, 60).y);
  const linked = h.debug();
  assert.equal(linked.relations.length, 1, '点已有再点空白就连上');
  assert.equal(linked.notes.length, 3, '空白端自动落一个空点');
  assert.equal(linked.notes[2].text, '', '新点是普通空文字点');
  assert.equal(linked.notes[0].text, '上边按钮', '已有端点复用、原文不动');

  // 空白 → 已有（拖动）
  h.drag(at(360, 250), at(180, 150));
  const dragged = h.debug();
  assert.equal(dragged.relations.length, 2, '空白起手拖到已有批注也连上');
  assert.equal(dragged.notes.length, 4, '只多一个空点，已有端点不复制');

  // 同一对再连：选原来那条，不重复、不清字。
  const beforeAgain = h.debug();
  h.clickAt(at(60, 60).x, at(60, 60).y);
  h.clickAt(at(340, 60).x, at(340, 60).y);
  const again = h.debug();
  assert.equal(again.relations.length, 2, '同一对不重复创建');
  assert.equal(again.selectedRelationId, beforeAgain.relations[0].id, '选中原来那条线');
  assert.equal(again.ops, beforeAgain.ops, '去重不写历史');

  // 两个临时点挨得太近：不产生两个点、也不留线。
  h.clickAt(at(100, 270).x, at(100, 270).y);
  h.clickAt(at(101, 271).x, at(101, 271).y);
  const near = h.debug();
  assert.equal(near.relations.length, 2, '挨太近的两次点击不建线');
  assert.equal(near.notes.length, 4, '也不产生两个点');
  assert.equal(near.ops, beforeAgain.ops, '失败手势不写历史');
  assert.match(h.q('.ie-status').textContent, /太近/);

  // 图外松手：清暂态，不建线也不留点。
  h.drag(at(60, 60), { x: 5, y: 5 });
  const outside = h.debug();
  assert.equal(outside.relations.length, 2, '图外松手不建线');
  assert.equal(outside.notes.length, 4, '图外松手不落点');
  assert.equal(outside.connect, null, '暂态已清掉');
  assert.equal(outside.ops, beforeAgain.ops, '图外手势不写历史');

  // 第二击按在已有框上、拖到空白再松手：按松手坐标落一个新点，不用按下的那一处。
  h.clickAt(at(60, 60).x, at(60, 60).y);
  h.pressDrag(at(180, 150), at(370, 285));
  const away = h.debug();
  assert.equal(away.relations.length, 3, '拖离后照常连成');
  assert.equal(away.notes.length, 5, '终点是松手处的新空点，不是按下的那个框');
  const last = away.relations[2];
  assert.equal(last.a.annotationId, away.notes[0].id, '起点仍是原来那处');
  assert.equal(last.b.annotationId, away.notes[4].id, '终点指向新落下的空点');
});

test('自动新点的历史组不吞邻接画笔：一次撤销只退这次连接', async () => {
  const h = relationHarness();
  await h.open();
  h.tool('pen');
  h.drag(at(20, 20), at(60, 40));
  const afterStroke = h.debug();
  assert.equal(afterStroke.paint.length, 1, '前提：先画了一笔');
  h.tool('connect');
  h.drag(at(300, 60), at(300, 260));
  const afterConnect = h.debug();
  assert.equal(afterConnect.notes.length, 2, '前提：空白→空白自动落了两个点');
  h.q('.ie-scroll').focus();
  h.click(h.q('[data-action="undo"]'));
  const undone = h.debug();
  assert.equal(undone.notes.length, 0, '新点与线一起撤回');
  assert.equal(undone.cursor, afterStroke.cursor, '只退这次连接的三步');
  assert.equal(undone.paint.length, afterStroke.paint.length, '邻接的画笔没有被组撤销带走');
  h.click(h.q('[data-action="undo"]'));
  assert.equal(h.debug().paint.length, 0, '再撤销一次才退画笔');
});

test('额度不够时先校验：不落点、不建线、不写历史，也不留半条线', async () => {
  // 批注上限压到 3：已有 2 条时，空白→空白要 2 个新点，放不下。
  const h = relationHarness({ limits: { annotations: 3 } });
  await h.open();
  await twoMarks(h);
  h.tool('connect');
  const before = h.debug();
  h.drag(at(300, 60), at(300, 260));
  const after = h.debug();
  assert.equal(after.notes.length, 2, '额度不够就不落空点');
  assert.equal(after.relations.length, 0, '也不建线');
  assert.equal(after.ops, before.ops, '不写历史');
  assert.equal(after.cursor, before.cursor, '光标不动');
  assert.match(h.q('.ie-status').textContent, /最多 3 条/, '说清是哪一项额度不够');
});

test('输出 API 直接调用也收掉未完成的连线手势：不留点/线/历史，指针捕获也释放', async () => {
  const h = relationHarness();
  await h.open();
  const scroller = h.q('.ie-scroll');
  const arm = label => {
    h.tool('connect');
    h.clickAt(at(120, 120).x, at(120, 120).y);
    const armed = h.debug();
    assert.equal(armed.connect && armed.connect.phase, 'armed', `${label}：前提：空白第一击只是待定起点`);
    assert.equal(armed.notes.length, 0, `${label}：前提：还没有正式点`);
    assert.equal(scroller.captured, 1, `${label}：前提：指针捕获在编辑器上`);
    return armed;
  };
  // 三个输出 API 都可能不走按钮路径（handleExport 直接调公共导出），手势不能被带出去。
  const outputs = [
    ['exportPNG', () => h.editor.exportPNG(), () => {}],
    ['exportClipboard', () => h.editor.exportClipboard(), () => {}],
    ['beginSegmentExport', () => h.editor.beginSegmentExport(), () => h.editor.endSegmentExport()]
  ];
  for (const [label, call, cleanup] of outputs) {
    const before = h.debug();
    arm(label);
    await call();
    cleanup();
    const after = h.debug();
    assert.equal(after.connect, null, `${label}：未完成的手势被取消`);
    assert.equal(after.notes.length, 0, `${label}：没有落下正式点`);
    assert.equal(after.relations.length, 0, `${label}：没有落下关系`);
    assert.equal(after.cursor, before.cursor, `${label}：没有写历史`);
    assert.equal(scroller.captured, undefined, `${label}：指针捕获已释放`);
    // 之后再点画布只是重新起手，不会自动把上一次补完。
    h.clickAt(at(120, 120).x, at(120, 120).y);
    const again = h.debug();
    assert.equal(again.connect && again.connect.phase, 'armed', `${label}：下一次点击只是新起手`);
    assert.equal(again.notes.length, 0, `${label}：没有补出正式点`);
    assert.equal(again.cursor, before.cursor, `${label}：没有补历史`);
    h.key('Escape');
    assert.equal(h.debug().connect, null, `${label}：Esc 收掉这次起手`);
  }
});

test('输出前文字校验失败：输入与原选择都留着，不被提前清掉', async () => {
  const h = relationHarness();
  await h.open();
  await twoMarks(h);
  const long = '长'.repeat(2001);
  const notes = h.debug().notes;
  h.clickAt(at(60, 60).x, at(60, 60).y);
  h.type(long);
  await assert.rejects(h.editor.exportPNG(), /超过 2000 字|说明还没写完/, '超限要拦');
  assert.equal(h.q('.ie-bubble-text').value, long, '说明输入原样保留');
  assert.equal(h.debug().noteId, notes[0].id, '原选择不丢');
  assert.equal(h.debug().notes.length, 2, '批注一条不少');
  // 改回短句后同一条输出 API 就能正常出图。
  h.type('短句');
  const png = await h.editor.exportPNG();
  assert.ok(png && png.length > 0, '校验通过后照常出图');
});

test('进预览/忙碌/复位：未完成的连线手势连同指针捕获一起释放', async () => {
  const busy = relationHarness();
  await busy.open();
  busy.tool('connect');
  busy.clickAt(at(120, 120).x, at(120, 120).y);
  assert.equal(busy.q('.ie-scroll').captured, 1, '前提：起手时指针被捕获');
  busy.editor.setBusy(true);
  assert.equal(busy.debug().connect, null, '忙碌时手势清掉');
  assert.equal(busy.q('.ie-scroll').captured, undefined, '忙碌时指针捕获释放');
  busy.editor.setBusy(false);

  const preview = relationHarness();
  await preview.open();
  preview.tool('connect');
  preview.clickAt(at(120, 120).x, at(120, 120).y);
  assert.equal(preview.q('.ie-scroll').captured, 1, '前提：起手时指针被捕获');
  preview.editor.setPreviewMode(true);
  assert.equal(preview.debug().connect, null, '进预览时手势清掉');
  assert.equal(preview.q('.ie-scroll').captured, undefined, '进预览时指针捕获释放');
  preview.editor.setPreviewMode(false);

  const reset = relationHarness();
  await reset.open();
  reset.tool('connect');
  reset.clickAt(at(120, 120).x, at(120, 120).y);
  assert.equal(reset.q('.ie-scroll').captured, 1, '前提：起手时指针被捕获');
  reset.editor.reset();
  assert.equal(reset.debug().connect, null, '复位时手势清掉');
  assert.equal(reset.q('.ie-scroll').captured, undefined, '复位时指针捕获释放');
});


test('选择工具能点连线选中；非选择模式下连线不抢画笔点击', async () => {
  const h = relationHarness();
  await h.open();
  await twoMarks(h);
  h.tool('connect');
  h.drag(at(60, 60), at(180, 150));
  const curve = h.debug().relations[0].curve;
  assert.ok(Array.isArray(curve) && curve.length > 9, '连线曲线有可用的几何');
  const relationId = h.debug().relations[0].id;
  const origin = h.debug().origin, zoom = h.debug().zoom;
  const toClient = point => ({ x: origin.x + point.x * zoom, y: origin.y + point.y * zoom });
  // 沿曲线点：先点到哪算哪，只要有一段能命中这条线就够（端点附近的点/框会优先命中）。
  let hitPoint = null;
  h.tool('select');
  for (const sample of curve.slice(1, -1)) {
    const client = toClient(sample);
    h.clickAt(client.x, client.y);
    if (h.debug().selectedRelationId === relationId) { hitPoint = client; break; }
  }
  assert.ok(hitPoint, '点连线能选中它');

  // 非选择模式：同一位置起笔是画线，不抢选中。
  h.tool('pen');
  const opsBefore = h.debug().ops;
  h.drag({ x: hitPoint.x - 20, y: hitPoint.y - 20 }, { x: hitPoint.x + 20, y: hitPoint.y + 20 });
  assert.equal(h.debug().ops, opsBefore + 1, '画笔在线上照常落笔');
  assert.equal(h.debug().selectedRelationId, null, '画笔不选连线');
});

test('重叠标记从该批注「更多」里的邻近入口逐个选；完全重叠的两处也能分别选中', async () => {
  const h = relationHarness();
  await h.open();
  h.tool('point');
  h.drag(at(100, 100));
  h.type('第一条');
  h.tool('point');
  h.drag(at(100, 100));
  h.type('第二条');
  h.tool('select');
  // 画布上只能点到最上面那条；下面那条在选中项的「更多」里能选到。
  assert.equal(h.field().value, '第二条', '前提：当前选中的是后标的一条');
  h.more();
  const neighbors = h.qa('.ie-bubble-neighbors [data-action="bubble-neighbor"]');
  assert.equal(neighbors.length, 1, '「更多」里列出压在一起的另一处');
  assert.match(neighbors[0].textContent, /第 1 条 · 点/);
  h.click(neighbors[0]);
  assert.equal(h.field().value, '第一条', '能选到下面那一处');
  h.more();
  const back = h.qa('.ie-bubble-neighbors [data-action="bubble-neighbor"]');
  assert.equal(back.length, 1);
  h.click(back[0]);
  assert.equal(h.field().value, '第二条', '也能回到上面那一处');
});

test('空标记导出前被拦、被有效关系覆盖后可导出；关系正文为空仍拦', async () => {
  const h = relationHarness();
  await h.open();
  h.tool('point');
  h.drag(at(60, 60));
  h.tool('region');
  h.drag(at(180, 150), at(280, 240));
  h.tool('select');
  await assert.rejects(h.editor.exportClipboard(), /既没正文、也没被有效关系覆盖/, '两个空标记直接导出要拦');

  h.tool('connect');
  h.drag(at(60, 60), at(180, 150));
  await assert.rejects(h.editor.exportClipboard(), /还没写共同说明/, '空线也要拦');
  const field = h.q('.ie-relation-text');
  field.value = '这两处一起改';
  h.root.emit('input', { target: field });
  const copied = await h.copy();
  assert.ok(copied.annotations.length === 2, '两端都有说明条目');
  assert.ok(copied.annotations.every(item => /见 关系1/.test(item.text)), '没单独写的一端指向共同关系');
});

test('同条追加位置立即一次可撤销变更；撤销只退追加，不丢原位置与没按回车的字', async () => {
  const h = relationHarness();
  await h.open();
  h.tool('point');
  h.drag(at(60, 60));
  h.type('先写这句');
  h.tool('region');
  h.drag(at(180, 150), at(280, 240));
  h.type('第一条的位置在这');
  h.tool('select');
  h.clickAt(at(60, 60).x, at(60, 60).y);
  const before = h.debug();
  const originalTargets = before.notes[0].targets.length;
  h.click(h.q('[data-action="bubble-add-region"]'));
  h.drag(at(60, 200), at(140, 260));
  const appended = h.debug();
  assert.equal(appended.notes[0].targets.length, originalTargets + 1, '追加立即入历史');
  assert.equal(appended.ops, before.ops + 1, '一次追加一条 op');
  assert.equal(appended.notes[0].text, '先写这句', '已写的字还在');

  h.q('.ie-scroll').focus();
  h.click(h.q('[data-action="undo"]'));
  const undone = h.debug();
  assert.equal(undone.notes[0].targets.length, originalTargets, '撤销只退追加');
  assert.equal(undone.notes[0].text, '先写这句', '撤销后原文不动');
  assert.equal(undone.notes.length, 2, '另一条不受影响');
});

test('删线可撤销：两端标记与各自原文都保留', async () => {
  const h = relationHarness();
  await h.open();
  await twoMarks(h);
  h.tool('connect');
  h.drag(at(60, 60), at(180, 150));
  const field = h.q('.ie-relation-text');
  field.value = '这两处一起改';
  h.root.emit('input', { target: field });
  assert.equal(h.debug().relations.length, 1);
  h.click(h.q('[data-action="relation-delete"]'));
  const removed = h.debug();
  assert.equal(removed.relations.length, 0, '删线只删这条线');
  assert.equal(removed.selectedRelationId, null, '失效的线选择被清掉');
  assert.equal(removed.notes.map(note => note.text).join('|'), '上边按钮|下面的分组', '两边原文都在');
  assert.equal(removed.notes.length, 2, '两端批注都在');
  h.click(h.q('[data-action="undo"]'));
  const restored = h.debug();
  assert.equal(restored.relations.length, 1, '撤销恢复线');
  assert.equal(restored.relations[0].text, '这两处一起改', '共同说明一并回来');
});

// —— 矩形/直线/箭头的二次调整（选择工具 + 形状历史）——
// 全部用真实 renderer/image-editor.js + fake DOM：导出画布与屏幕帧的绘制调用都真实记录。
function shapeHarness(options = {}) {
  const h = harness(options);
  const key = (value, extra = {}) => h.window.emit('keydown', { key: value, target: h.q('.ie-scroll'),
    preventDefault() {}, stopImmediatePropagation() {}, ...extra });
  // 导出的真仕：新开的画布会自己生成并记录。绘图坐标本来就可能带 1e-15 噪声，这里统一舍到 0.01 再比。
  const roundArgs = args => args.map(value => (typeof value === 'number' ? Math.round(value * 100) / 100 : value));
  const exportCalls = async () => {
    const before = h.dom.canvases.length;
    await h.editor.exportPNG();
    return h.dom.canvases.slice(before).flatMap(canvas => canvas.context.calls);
  };
  const strokes = async () => (await exportCalls()).filter(call => call.name === 'strokeRect').map(call => roundArgs(call.args));
  const lineEnds = async () => (await exportCalls()).filter(call => call.name === 'lineTo').map(call => roundArgs(call.args));
  const handleSquares = calls => calls.filter(call => call.name === 'fillRect' && call.args[2] === 8 && call.args[3] === 8);
  const undo = () => key('z', { ctrlKey: true });
  const redo = () => key('y', { ctrlKey: true });
  const selected = () => !h.q('[data-action="shape-delete"]').disabled;
  const deleteKey = () => h.window.emit('keydown', { key: 'Delete', target: h.q('.ie-scroll'),
    preventDefault() {}, stopImmediatePropagation() {} });
  return { ...h, key, exportCalls, strokes, lineEnds, handleSquares, undo, redo, selected, deleteKey };
}

test('画完矩形自动选中并切到选择工具：屏幕帧有手柄，导出没有', async () => {
  const h = shapeHarness();
  await h.open();
  h.tool('rect');
  h.drag(at(40, 40), at(120, 80));
  h.dom.flushFrames();
  assert.equal(h.q('[data-tool="select"]').getAttribute('aria-pressed'), 'true', '画完自动切到选择工具');
  assert.equal(h.selected(), true, '刚画的矩尺已选中（删除按钮可用）');
  // 屏幕帧画 8 个手柄，导出画布一个都没有。
  const screen = h.handleSquares(h.q('.ie-display').context.calls);
  assert.equal(screen.length >= 8, true, `屏幕帧应画 8 个手柄，实际 ${screen.length}`);
  const exported = await h.exportCalls();
  assert.equal(h.handleSquares(exported).length, 0, '导出不带选中手柄');
  assert.deepEqual(await h.strokes(), [[40, 40, 80, 40]], '导出仍是空心矩形本体');
});

test('拖手柄缩放：松手才进历史，撤销/重做各一次', async () => {
  const h = shapeHarness();
  await h.open();
  h.tool('rect');
  h.drag(at(40, 40), at(120, 80));
  h.drag(at(120, 80), at(160, 100));   // 右下角手柄
  assert.deepEqual(await h.strokes(), [[40, 40, 120, 60]], '一次拖完才生效');
  assert.equal(h.selected(), true, '调整后仍选中');
  h.undo();
  assert.deepEqual(await h.strokes(), [[40, 40, 80, 40]], '撤销回到原几何');
  h.redo();
  assert.deepEqual(await h.strokes(), [[40, 40, 120, 60]], '重做回到调整后');
  h.undo(); h.undo();
  assert.deepEqual(await h.strokes(), [], '再撤一次就连创建一起撤掉');
});

test('拖边线移动保宽高，贴到右边只夹位置不挤瘦', async () => {
  const h = shapeHarness();
  await h.open();
  h.tool('rect');
  h.drag(at(40, 40), at(120, 80));
  h.drag(at(60, 40), at(390, 40));    // 抓上边线（避开了左右两个手柄）往右拖出画面
  const [box] = await h.strokes();
  assert.equal(box[2], 80, '宽不变');
  assert.equal(box[3], 40, '高不变');
  assert.equal(Math.round(box[0]), 320, '整体夹在画面内：400-80');
});

test('线/箭头可拖线身、可拖端点；端点能交叉翻转，0 长也不报错', async () => {
  const h = shapeHarness();
  await h.open();
  h.tool('line');
  h.drag(at(40, 40), at(200, 40));
  assert.equal(h.selected(), true, '线画完自动选中');
  h.drag(at(120, 40), at(120, 120));    // 线身往下拖
  let lines = await h.lineEnds();
  assert.deepEqual(lines.at(-1), [200, 120], '线身移动后末端跟着平移');
  h.drag(at(200, 120), at(10, 120));    // 端点拖过另一端
  lines = await h.lineEnds();
  assert.deepEqual(lines.at(-1), [10, 120], '端点可交叉翻转');
  h.drag(at(10, 120), at(40, 120));     // 两端重合 → 0 长
  assert.deepEqual((await h.strokes()), [], '0 长线不产生矩形');
  assert.deepEqual(await h.lineEnds(), [[40, 120]], '0 长仍是一次安全的线');
});

test('z-order：调整只换原槽位的快照，不会画到后画形状之上', async () => {
  const h = shapeHarness();
  await h.open();
  h.tool('rect');
  h.drag(at(20, 20), at(60, 60));       // A 先画
  h.tool('rect');
  h.drag(at(100, 20), at(140, 60));     // B 后画
  assert.deepEqual(await h.strokes(), [[20, 20, 40, 40], [100, 20, 40, 40]]);
  h.drag(at(30, 20), at(30, 60));       // 选 A 的上边线并往下拖
  const order = await h.strokes();
  assert.deepEqual(order, [[20, 60, 40, 40], [100, 20, 40, 40]], 'A 仍在 B 之前画（更新不改变槽位）');
  h.undo();
  assert.deepEqual(await h.strokes(), [[20, 20, 40, 40], [100, 20, 40, 40]], '撤销只回滚这一次调整');
});

test('填充矩形是隐私遮盖：不可选中、不露出手柄，也不接边线命中', async () => {
  const h = shapeHarness();
  await h.open();
  h.q('[data-setting="fill"]').checked = true;
  h.tool('rect');
  h.drag(at(40, 40), at(200, 160));
  assert.equal(h.q('[data-tool="rect"]').getAttribute('aria-pressed'), 'true', '填充矩形不自动切选择工具');
  h.tool('select');
  h.drag(at(40, 100), at(40, 120));     // 点它的左边线
  assert.equal(h.selected(), false, '填充矩形不能被选中');
  h.dom.flushFrames();
  assert.equal(h.handleSquares(h.q('.ie-display').context.calls).length, 0, '不露手柄');
});

test('画笔/马赛克不参与形状选中', async () => {
  const h = shapeHarness();
  await h.open();
  h.tool('pen');
  h.drag(at(40, 40), at(200, 200));
  h.tool('select');
  h.drag(at(120, 120), at(120, 130));
  assert.equal(h.selected(), false, '笔迹不能被选中');
  h.tool('mosaic');
  h.drag(at(60, 60), at(160, 160));
  h.tool('select');
  h.drag(at(100, 100), at(100, 110));
  assert.equal(h.selected(), false, '马赛克不能被选中');
});

test('Esc/失焦取消拖动回原几何；再 Esc 取消选中；空拖不落历史', async () => {
  const h = shapeHarness();
  await h.open();
  h.tool('rect');
  h.drag(at(40, 40), at(120, 80));
  const scroller = h.q('.ie-scroll');
  const press = (x, y) => scroller.emit('pointerdown', { clientX: x, clientY: y, pointerId: 3, button: 0, buttons: 1,
    pointerType: 'mouse', preventDefault() {}, setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false });
  const moveTo = (x, y) => scroller.emit('pointermove', { clientX: x, clientY: y, pointerId: 3, button: 0, buttons: 1,
    pointerType: 'mouse', preventDefault() {}, getCoalescedEvents: () => [] });
  press(at(120, 80).x, at(120, 80).y);
  moveTo(at(180, 140).x, at(180, 140).y);
  h.key('Escape');
  assert.deepEqual(await h.strokes(), [[40, 40, 80, 40]], 'Esc 后几何回到按下那一刻');
  assert.equal(h.selected(), true, 'Esc 只取消这次调整，选中还在');
  press(at(120, 80).x, at(120, 80).y);
  moveTo(at(180, 140).x, at(180, 140).y);
  h.window.emit('blur', {});
  assert.deepEqual(await h.strokes(), [[40, 40, 80, 40]], '失焦也回原几何');
  h.key('Escape');
  assert.equal(h.selected(), false, '再 Esc 才取消选中');
  // 空拖（按下即松开、没位移）不落历史：一次撤销就能把形状整条撤掉。
  h.tool('select');
  h.drag(at(80, 80), at(80, 80));
  h.undo(); h.undo();
  assert.deepEqual(await h.strokes(), [], '空拖没有额外历史');
});

test('选中后可改颜色/粗细并删除，全部可撤销重做', async () => {
  const h = shapeHarness();
  await h.open();
  h.tool('rect');
  h.drag(at(40, 40), at(120, 80));
  const color = h.q('[data-setting="color"]');
  color.value = '#2979ff';
  h.dom.root.emit('change', { target: color });
  const width = h.q('[data-setting="width"]');
  width.value = '12';
  h.dom.root.emit('change', { target: width });
  h.undo();
  assert.deepEqual(await h.strokes(), [[40, 40, 80, 40]], '撤一次只回滚粗细');
  h.undo();
  assert.deepEqual(await h.strokes(), [[40, 40, 80, 40]], '再撤回滚颜色，形状还在');
  h.undo();
  assert.deepEqual(await h.strokes(), [], '第三次才撤掉创建');
  h.redo(); h.redo(); h.redo();
  assert.deepEqual(await h.strokes(), [[40, 40, 80, 40]]);
  assert.equal(h.selected(), false, '撤销到底时选中被清掉，重做不会自己选回来');
  // 重新选中再删：按钮与 Delete 键都进历史。
  h.drag(at(60, 40), at(60, 40));
  assert.equal(h.selected(), true);
  h.click(h.q('[data-action="shape-delete"]'));
  assert.deepEqual(await h.strokes(), [], '删除后不画');
  assert.equal(h.selected(), false, '删除后不再选中');
  h.undo();
  assert.deepEqual(await h.strokes(), [[40, 40, 80, 40]], '撤销删除就恢复');
});

test('Delete 只认画布焦点：输入框里按键不删，预览态只读不选不改', async () => {
  const h = shapeHarness();
  await h.open();
  h.tool('rect');
  h.drag(at(40, 40), at(120, 80));
  // 焦点在文字输入：不删
  const field = h.q('.ie-bubble-text');
  field.focus();
  h.deleteKey();
  assert.deepEqual(await h.strokes(), [[40, 40, 80, 40]], '输入框里的 Delete 不删形状');
  // 回到画布焦点：删
  h.q('.ie-scroll').focus();
  h.deleteKey();
  assert.deepEqual(await h.strokes(), [], '画布焦点下 Delete 删除');
  h.undo();
  // 预览只读：不能选、不能删
  h.editor.setPreviewMode(true);
  assert.equal(h.selected(), false, '进预览清掉选中');
  h.q('.ie-scroll').focus();
  h.deleteKey();
  assert.deepEqual(await h.strokes(), [[40, 40, 80, 40]], '预览态 Delete 不生效');
  h.editor.setPreviewMode(false);
});

test('缩放后手柄命中仍按 CSS 像素（不随 zoom 缩水）', async () => {
  const h = shapeHarness();
  await h.open();
  h.tool('rect');
  h.drag(at(40, 40), at(120, 80));
  h.click(h.q('[data-action="zoom-out"]'));
  h.dom.flushFrames();
  // zoom 变小后按屏坐标重新定位手柄：先读当前缩放标签，再用 origin+zoom 反推。
  const zoomText = h.q('.ie-zoom').textContent;
  const zoom = Number(zoomText.replace('%', '')) / 100;
  assert.ok(zoom < 0.92, `应先缩小：${zoomText}`);
  const origin = { x: Math.max(16, (400 - 400 * zoom) / 2), y: 16 };
  const screen = { x: origin.x + 120 * zoom, y: origin.y + 80 * zoom };
  h.drag(screen, { x: screen.x + 40, y: screen.y + 20 });
  const [box] = await h.strokes();
  assert.ok(box[2] > 80, `缩放后手柄仍能抓住并放大：${JSON.stringify(box)}`);
});

test('空心框中间可穿透：点到上层帧的内部会选中下面那个形状', async () => {
  const h = shapeHarness();
  await h.open();
  h.tool('rect');
  h.drag(at(40, 40), at(160, 120));     // B 先画（下）
  h.tool('rect');
  h.drag(at(20, 20), at(200, 200));     // A 后画（上，空心）
  h.drag(at(70, 40), at(70, 40));       // 点 B 的上边线（在 A 内部、不在 A 边线上，也避开 B 自己的手柄）
  assert.equal(h.selected(), true, '选到了东西');
  const before = await h.strokes();
  // 拖一下：只有 B 会动，A 不动
  h.drag(at(70, 40), at(90, 60));
  const after = await h.strokes();
  assert.deepEqual(after[0], [60, 60, 120, 80], '下面的 B 被选中并整体移动');
  assert.deepEqual(after[1], before[1], '上面的 A 没动');
});

test('裁切后命中/拖动仍用源坐标：贴边形状可选中，同 token 重开历史不丢', async () => {
  const h = shapeHarness();
  await h.open();
  h.tool('rect');
  h.drag(at(40, 40), at(120, 80));
  // 进入裁切会先适宽整图（zoom 变了），按当时的 zoom 把源坐标换成屏坐标。
  h.tool('crop');
  h.dom.flushFrames();
  const zoom = Number(h.q('.ie-zoom').textContent.replace('%', '')) / 100;
  const before = (x, y) => ({ x: Math.max(16, (400 - 400 * zoom) / 2) + x * zoom, y: 16 + y * zoom });
  const scroller = h.q('.ie-scroll');
  const press = (p) => scroller.emit('pointerdown', { clientX: p.x, clientY: p.y, pointerId: 5, button: 0, buttons: 1,
    pointerType: 'mouse', preventDefault() {}, setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false });
  const moveTo = (p) => scroller.emit('pointermove', { clientX: p.x, clientY: p.y, pointerId: 5, button: 0, buttons: 1,
    pointerType: 'mouse', preventDefault() {}, getCoalescedEvents: () => [] });
  press(before(400, 300));
  moveTo(before(120, 80));
  scroller.emit('pointerup', { clientX: before(120, 80).x, clientY: before(120, 80).y, pointerId: 5, button: 0, buttons: 0 });
  h.click(h.q('[data-action="crop-apply"]'));
  assert.deepEqual(JSON.parse(JSON.stringify(h.editor.cropRect)), { x: 0, y: 0, width: 120, height: 80 });
  // 裁后视窗变成 120×80，形状贴右下角；用新的 origin 点它的上边线仍然选得中。
  assert.equal(h.editor.debug().tool, 'browse', '应用裁切后自动回到抓手');
  assert.ok(h.editor.debug().zoom > 1, '裁后小图自动放大到适合画布');
  const after = (x, y) => { const s=h.editor.debug(); return {x:s.origin.x+x*s.zoom,y:s.origin.y+y*s.zoom}; };
  h.tool('select');
  h.drag(after(60, 40), after(60, 40));
  assert.equal(h.selected(), true, '裁切后仍能选中贴边形状');
  // 同 token 重开：同一份历史还在（先撤裁切、再撤形状）。
  await h.editor.open({ token: 'ui' });
  assert.equal(h.editor.hasEdits, true, '重开保留同一份历史');
  h.undo();
  assert.equal(h.editor.cropRect, undefined, '一次撤销回滚裁切');
  assert.deepEqual(await h.strokes(), [[40, 40, 80, 40]], '形状还在');
  h.undo();
  assert.deepEqual(await h.strokes(), [], '再撤销就回到创建前');
});

test('选择工具按钮明确「选择/调整」：短字可用，title 与属性说明讲清楚', async () => {
  const h = shapeHarness();
  await h.open();
  const button = h.q('[data-tool="select"]');
  assert.equal(button.textContent, '选择/调整', '按钮直接说清用途');
  assert.equal(button.disabled, true, '空图没有可调整对象');
  assert.match(button.title, /还没有可调整|先添加/, '不可用时解释原因');
  h.tool('rect'); h.drag(at(40,40),at(120,80));
  assert.equal(button.disabled, false);
  assert.match(button.title, /调整已添加.*空心矩形/, '可用时说明调整哪些内容');
  h.tool('select');
  assert.match(h.q('.ie-options').textContent, /选择\/调整/, '属性行也说清楚');
});

test('有文字的工具不再冒重复名称提示，保留有操作信息的提示', async () => {
  const h=harness(); await h.open();
  for (const button of h.qa('[data-tool]')) {
    const title=(button.title || button.getAttribute('title') || '').trim();
    assert.notEqual(title,button.textContent.trim(),`${button.dataset.tool}不复述按钮名称`);
  }
  assert.equal(h.q('[data-tool="region"]').getAttribute('title'),'','框批注无重复气泡');
  assert.match(h.q('[data-tool="select"]').title,/还没有可调整|先添加/,'保留禁用原因');
  assert.match(h.q('[data-tool="connect"]').title,/拖过去|点两下/,'保留连线操作提示');
});

test('工具栏每个按钮都有实际图形，选择/调整也不留下空SVG', async () => {
  const h=harness(); await h.open();
  for (const button of h.qa('[data-tool]')) {
    const svg=button.querySelector('.ie-icon');
    assert.ok(svg,`${button.dataset.tool}有图标`);
    assert.ok(Array.from(svg.children).some(node=>['path','rect','circle'].includes(node.tagName.toLowerCase())),
      `${button.dataset.tool}图标不能是空SVG`);
    assert.equal(svg.getAttribute('aria-hidden'),'true','图标不重复朗读工具名称');
  }
});

test('拖动中手柄跟草稿走，导出/缩略图不拿未提交草稿', async () => {
  const h = shapeHarness();
  await h.open();
  h.tool('rect');
  h.drag(at(40, 40), at(120, 80));
  const scroller = h.q('.ie-scroll');
  const pointer = (x, y, extra = {}) => ({ clientX: x, clientY: y, pointerId: 7, button: 0, buttons: 1, pointerType: 'mouse',
    preventDefault() {}, setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false, getCoalescedEvents: () => [], ...extra });
  scroller.emit('pointerdown', pointer(at(120, 80).x, at(120, 80).y));   // 拖右下角手柄
  scroller.emit('pointermove', pointer(at(200, 160).x, at(200, 160).y));
  h.dom.flushFrames();
  // 屏幕上的 8 个手柄应该按草稿几何（右上角 = 200,160）画，而不是停在 120,80。
  const squares = h.handleSquares(h.q('.ie-display').context.calls);
  const centers = squares.map(call => ({ x: Math.round(call.args[0] + 4), y: Math.round(call.args[1] + 4) }));
  assert.ok(centers.some(c => Math.abs(c.x - at(200, 160).x) < 1 && Math.abs(c.y - at(200, 160).y) < 1), `手柄应跟到草稿角：${JSON.stringify(centers)}`);
  // 拖拽中导出路径（缩略图）不能带未提交草稿：仍是已提交的 80×40。
  const before = h.dom.canvases.length;
  h.editor.thumbnail();
  const exported = h.dom.canvases.slice(before)[0].context.calls.filter(call => call.name === 'strokeRect');
  assert.deepEqual(exported.map(call => call.args), [[40, 40, 80, 40]], '缩略图不含未提交草稿');
  scroller.emit('pointerup', pointer(at(200, 160).x, at(200, 160).y, { buttons: 0 }));
  assert.deepEqual(await h.strokes(), [[40, 40, 160, 120]], '松手后才落地');
});

test('撤销颜色变更后属性区回到恢复后的版本', async () => {
  const h = shapeHarness();
  await h.open();
  h.tool('rect');
  h.drag(at(40, 40), at(120, 80));
  const startColor = h.q('[data-setting="color"]').value;
  const color = h.q('[data-setting="color"]');
  color.value = '#2979ff';
  h.dom.root.emit('change', { target: color });
  assert.equal(h.q('[data-setting="color"]').value, '#2979ff');
  h.undo();
  assert.equal(h.q('[data-setting="color"]').value, startColor, '撤销后 UI 跟着回到原色');
  h.redo();
  assert.equal(h.q('[data-setting="color"]').value, '#2979ff', '重做也同步');
});

test('零长直线/箭头先补成两端同坐标，选中后拖端点能拉长', async () => {
  const h = shapeHarness();
  await h.open();
  h.tool('line');
  const scroller = h.q('.ie-scroll');
  const point = at(100, 100);
  const pointer = (extra = {}) => ({ clientX: point.x, clientY: point.y, pointerId: 9, button: 0, buttons: 1, pointerType: 'mouse',
    preventDefault() {}, setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false, getCoalescedEvents: () => [], ...extra });
  scroller.emit('pointerdown', pointer());
  scroller.emit('pointerup', pointer({ buttons: 0 }));
  assert.equal(h.editor.hasEdits, true, '零长线也生成一条形状');
  // 拖它唯一的落点：补成两端同坐标后能当成端点拉伸。
  h.drag(at(100, 100), at(220, 100));
  const drawn = (await h.exportCalls())
    .filter(call => call.name === 'moveTo' || call.name === 'lineTo')
    .map(call => call.args.map(value => Math.round(value * 100) / 100));
  assert.ok(drawn.some(args => Math.abs(args[0] - 220) < 0.5 && Math.abs(args[1] - 100) < 0.5),
    `拖端点后应拉长到 220：${JSON.stringify(drawn)}`);
  assert.ok(drawn.some(args => Math.abs(args[0] - 100) < 0.5 && Math.abs(args[1] - 100) < 0.5), '另一端留在原处');
  assert.equal(h.editor.hasEdits, true);
});

test('到全局操作上限后：选择/取消仍可用，形状变更明确拒绝不丢已有内容', async () => {
  const h = shapeHarness();
  await h.open();
  h.tool('rect');
  h.drag(at(20, 20), at(60, 60));
  // 用一条条零位移笔迹把 ops 推到全局上限（LIMIT.operations = 1000）。
  h.tool('pen');
  const scroller = h.q('.ie-scroll');
  const dot = { clientX: at(300, 250).x, clientY: at(300, 250).y, pointerId: 11, button: 0, buttons: 1, pointerType: 'mouse',
    preventDefault() {}, setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false, getCoalescedEvents: () => [] };
  for (let i = 0; i < 1000; i += 1) {
    scroller.emit('pointerdown', dot);
    scroller.emit('pointerup', { ...dot, buttons: 0 });
  }
  h.tool('select');
  const before = await h.strokes();
  h.drag(at(40, 20), at(40, 40));          // 选中并尝试移动（上边线）
  assert.match(h.nodes?.status ?? h.q('.ie-status').textContent, /形状已到编辑上限/, '变更到上限时明确说明');
  assert.deepEqual(await h.strokes(), before, '被拒的调整不丢已有内容也不落半成品');
  assert.equal(h.selected(), true, '选中状态还在，可以继续 Esc 取消');
  h.click(h.q('[data-action="shape-delete"]'));
  assert.equal((await h.strokes()).length, before.length, '删除同样被上限拦住');
  h.key('Escape');
  assert.equal(h.selected(), false, '取消选中仍可用');
});

test('裁切穿过形状后：点击可见边线不位移、不入历史，轻拖不瞬跳', async () => {
  const h = shapeHarness();
  await h.open();
  h.tool('rect');
  h.drag(at(100, 100), at(300, 260));       // 形状比裁切后画面大
  h.tool('crop');
  h.dom.flushFrames();
  // 进裁切会先适宽整图：zoom 固定 = min((400-32)/400, (300-32)/300)，按这个精确值换算屏坐标。
  const zoom = Math.min((400 - 32) / 400, (300 - 32) / 300);
  const cropScreen = (x, y) => ({ x: Math.max(16, (400 - 400 * zoom) / 2) + x * zoom, y: 16 + y * zoom });
  const scroller = h.q('.ie-scroll');
  const pointer = (p, extra = {}) => ({ clientX: p.x, clientY: p.y, pointerId: 13, button: 0, buttons: 1, pointerType: 'mouse',
    preventDefault() {}, setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false, getCoalescedEvents: () => [], ...extra });
  scroller.emit('pointerdown', pointer(cropScreen(400, 300)));
  scroller.emit('pointermove', pointer(cropScreen(200, 200)));
  scroller.emit('pointerup', pointer(cropScreen(200, 200), { buttons: 0 }));
  h.click(h.q('[data-action="crop-apply"]'));
  assert.deepEqual(JSON.parse(JSON.stringify(h.editor.cropRect)), { x: 0, y: 0, width: 200, height: 200 });
  const viewScreen = (x, y) => { const s=h.editor.debug(); return {x:s.origin.x+x*s.zoom,y:s.origin.y+y*s.zoom}; };
  const before = await h.strokes();
  // 点一下可见边线（不拖）就松手：不能把它夹回视窗里，也不能落一条历史。
  h.tool('select');
  scroller.emit('pointerdown', pointer(viewScreen(150, 100)));
  scroller.emit('pointerup', pointer(viewScreen(150, 100), { buttons: 0 }));
  assert.deepEqual(await h.strokes(), before, '点一下不位移');
  assert.equal(h.selected(), true, '点中了就是选中，不产生变更');
  h.undo();
  assert.equal(h.editor.cropRect, undefined, '第一下撤销回到裁切前——证明没有插入形状变更');
  h.redo();
  assert.deepEqual(JSON.parse(JSON.stringify(h.editor.cropRect)), { x: 0, y: 0, width: 200, height: 200 }, '重做回到裁切后');
  assert.deepEqual(await h.strokes(), before, '几何仍未被改动');
  // 往外拖：已经出界的部分不再往外逃（不产生位移）。
  const edge = viewScreen(150, 100);
  h.drag(edge, { x: edge.x + 8, y: edge.y });
  assert.deepEqual(await h.strokes(), before, '不继续往外逃');
  // 往内轻拖：只按实际位移走，不能一下子吸附。
  h.drag(edge, { x: edge.x - 8, y: edge.y });
  const [moved] = await h.strokes();
  assert.ok(moved[0] > 86 && moved[0] < 96, `应小幅平移而不是瞬跳：${JSON.stringify(moved)}`);
  assert.equal(moved[2], 200, '宽不变');
  assert.equal(moved[3], 160, '高不变');
  // 零位移拖手柄：同样不产生变更。
  const afterMove = await h.strokes();
  const handlePoint = viewScreen(moved[0], moved[1]);
  scroller.emit('pointerdown', pointer(handlePoint));
  scroller.emit('pointerup', pointer(handlePoint, { buttons: 0 }));
  assert.deepEqual(await h.strokes(), afterMove, '点手柄不拖不改几何');
});

test('后绘纯色遮盖挡住下面的透明形状：点选不穿透、手柄也不绕开', async () => {
  const h = shapeHarness();
  await h.open();
  h.tool('rect');
  h.drag(at(60, 60), at(260, 240));        // A：空心（可调）
  h.q('[data-setting="fill"]').checked = true;
  h.tool('rect');
  h.drag(at(180, 120), at(340, 280));      // B：纯色遮盖，盖住 A 的右下区域
  const before = await h.strokes();
  h.tool('select');
  // 点 A 被 B 盖住的那段下边线（(220,240) 在 B 内）
  h.drag(at(220, 240), at(240, 260));
  assert.equal(h.selected(), false, '遮盖处不能穿透选中下面的形状');
  assert.deepEqual(await h.strokes(), before, '也不会误移/误删下层');
  // A 没被遮住的边仍能选中并调整，而且依旧画在遮盖下面。
  h.drag(at(160, 60), at(160, 60));
  assert.equal(h.selected(), true, '未被遮的边可以选中');
  h.drag(at(110, 60), at(110, 40));        // 上边线往上拖 20
  const calls = (await h.exportCalls()).filter(call => call.name === 'strokeRect' || call.name === 'fillRect');
  assert.deepEqual(calls.map(call => call.name), ['strokeRect', 'fillRect'], 'A 仍先画、遮盖仍在上');
  assert.deepEqual(calls[0].args.map(v => Math.round(v * 100) / 100), [60, 40, 200, 180], 'A 按轻拖后的几何画');
  // A 的手柄如果在遮盖里（右下角 260,240），也不能绕开遮挡拖。
  const beforeHandle = await h.strokes();
  h.drag(at(260, 240), at(280, 260));
  assert.deepEqual(await h.strokes(), beforeHandle, '被遮盖处的手柄不响应');
  assert.equal(h.selected(), false, '点到遮盖区域就取消选中');
});

test('GIF：逐帧渲染的更新/删除/遮盖顺序与每帧几何一致', async () => {
  const h = shapeHarness({ animation: true });
  await h.open();
  assert.equal(h.q('[data-tool="select"]').hidden, false, '动画模式也用同一个选择工具');
  for (const action of ['save', 'save-as', 'comment', 'notes-toggle']) {
    assert.equal(h.q(`[data-action="${action}"]`).hidden, true, `GIF 仍然没有 ${action}`);
  }
  // 空心矩形 A（先画），后面再画一个填充矩形 B 当隐私遮盖。
  h.tool('rect');
  h.drag(at(60, 60), at(260, 240));
  h.q('[data-setting="fill"]').checked = true;
  h.tool('rect');
  h.drag(at(120, 80), at(200, 160));
  const frameCalls = () => {
    const before = h.dom.canvases.length;
    h.editor.renderFrame({ width: 400, height: 300 });
    return h.dom.canvases.slice(before)[0].context.calls
      .filter(call => call.name === 'strokeRect' || call.name === 'fillRect')
      .map(call => ({ name: call.name, args: call.args.map(value => Math.round(value * 100) / 100) }));
  };
  const first = frameCalls();
  assert.deepEqual(first, [
    { name: 'strokeRect', args: [60, 60, 200, 180] },
    { name: 'fillRect', args: [120, 80, 80, 80] }
  ], '先画的空心框在下、后画的遮盖在上');
  // 调整 A（下边线往下拖）后依旧在 B 之下，不会被提到遮盖上方。
  h.tool('select');
  h.drag(at(100, 240), at(100, 260));
  const adjusted = frameCalls();
  assert.deepEqual(adjusted, [
    { name: 'strokeRect', args: [60, 80, 200, 180] },
    { name: 'fillRect', args: [120, 80, 80, 80] }
  ], '更新不改变槽位，遮盖仍在它上面');
  // 每帧几何一致（同一份形状历史）。
  assert.deepEqual(frameCalls(), adjusted, '连续两帧椭圆几何相同');
  // 删除 A 后帧里只剩遮盖。
  h.drag(at(100, 260), at(100, 260));
  h.click(h.q('[data-action="shape-delete"]'));
  assert.deepEqual(frameCalls(), [{ name: 'fillRect', args: [120, 80, 80, 80] }], '删除后帧里只剩遮盖');
  h.undo();
  assert.equal(frameCalls().length, 2, '撤销删除后帧里又有两个形状');
});

// —— 未确认区域检查层已整体移除 ——
test('任意缺区元数据（合法/非法/无位置）都不出现检查入口或高亮层', async () => {
  const cases = [
    { total: 2, truncated: false, rects: [
      { top: 200, bottom: 260, left: 5, right: 100 },
      { top: 260, bottom: 299, left: 40, right: 300 }] },
    { total: 3, truncated: true, rects: [] },
    { total: 3, truncated: false, rects: [
      { top: 500, bottom: 600, left: 5, right: 100 },
      { top: 40, bottom: 40, left: 5, right: 100 }] },
  ];
  for (const checkRegions of cases) {
    const h = harness({ width: 400, height: 300 });
    await h.open({ checkRegions });
    assert.equal(h.q('.ie-checks'), null, '不保留未确认入口');
    assert.equal(h.q('.ie-check-count'), null);
    assert.equal(h.q('[data-action="check-next"]'), null, '没有定位下一处的按钮');
    assert.equal(h.q('[data-action="check-prev"]'), null, '没有上一处的按钮');
    assert.equal(h.q('[data-action="check-hide"]'), null, '没有显示/隐藏检查的按钮');
    assert.equal(h.q('.ie-check-layer'), null, '没有检查高亮覆盖层');
    assert.equal(h.q('.ie-check-box'), null);
    assert.equal(/未确认|检查高亮/.test(h.q('.ie-status').textContent), false, '状态栏也不提检查流程');
    assert.equal(/未确认|显示检查|检查高亮/.test(h.q('.ie-help').textContent), false, '帮助里不再介绍检查流程');
  }
});

test('缺区元数据不影响成图导出：像素与说明与没有元数据时一致', async () => {
  const plain = harness({ width: 400, height: 300 });
  await plain.open();
  plain.tool('region');
  plain.drag(at(40, 40), at(120, 120));
  plain.field().value = '原有批注';
  plain.root.emit('input', { target: plain.field() });
  plain.tool('pen');
  const baseline = await plain.copy();

  const marked = harness({ width: 400, height: 300 });
  await marked.open({ checkRegions: { total: 2, truncated: false, rects: [
    { top: 10, bottom: 40, left: 5, right: 100 },
    { top: 200, bottom: 260, left: 40, right: 300 }] } });
  marked.tool('region');
  marked.drag(at(40, 40), at(120, 120));
  marked.field().value = '原有批注';
  marked.root.emit('input', { target: marked.field() });
  marked.tool('pen');
  const withRegions = await marked.copy();

  assert.deepEqual(withRegions.annotations, baseline.annotations, '说明区批注完全一致');
  assert.deepEqual(withRegions.comment, baseline.comment);
  assert.equal(withRegions.lines.join('\n').includes('未确认'), false, '导出里没有检查相关文字');
});

// —— 本轮修订单（A~F）的回归：先写门禁，再对照源码 ——
test('sync 统一排一帧重画：建线、从批注更多里选中、删线都立刻反映在画布上', async () => {
  const h = relationHarness();
  await h.open();
  await twoMarks(h);
  const ctx = h.q('.ie-display').context;
  const strokes = [], fillTexts = [];
  const stroke = ctx.stroke, fillText = ctx.fillText;
  ctx.stroke = function (...args) { strokes.push(this.strokeStyle); return stroke.apply(this, args); };
  ctx.fillText = function (text, ...args) { fillTexts.push(String(text)); return fillText.call(this, text, ...args); };
  const resetCanvasLog = () => { strokes.length = 0; fillTexts.length = 0; };

  // 建立连线：下一个完成帧就得有线（不点空白、不滚、不缩放、不取消选择）。
  h.tool('connect');
  h.dom.flushFrames();
  resetCanvasLog();
  const opsBefore = h.debug().ops, framesBeforeCreate = h.debug().frames;
  h.drag(at(60, 60), at(180, 150));
  h.dom.flushFrames();
  const created = h.debug();
  assert.equal(created.ops, opsBefore + 1, '建线只多一条 op');
  assert.ok(created.frames > framesBeforeCreate, '建立连线后的第一个完成帧就重画了画布');
  assert.ok(strokes.includes('#e89bb0'), `选中的连线用高亮色画在画布上：${strokes.join(',')}`);

  // 共同说明写回后直接重画中间标签（不整表重绑 textarea）。
  resetCanvasLog();
  const framesBeforeText = h.debug().frames;
  const field = h.q('.ie-relation-text');
  field.value = '两处颜色一致';
  h.root.emit('input', { target: field });
  h.dom.flushFrames();
  assert.ok(h.debug().frames > framesBeforeText, '改共同说明后也排重画');
  assert.ok(fillTexts.includes('两处颜色一致'), `连线中间标签画在画布上：${fillTexts.join('|')}`);

  // 取消选择后线还在（只是不高亮）；从那条批注的「更多」选回立即高亮。
  h.tool('select');
  h.clickAt(at(360, 280).x, at(360, 280).y);
  assert.equal(h.debug().selectedRelationId, null, '空白点击取消连线选中');
  resetCanvasLog();
  h.dom.flushFrames();
  assert.equal(strokes.includes('#e89bb0'), false, '未选中时不用高亮色');
  h.clickAt(at(60, 60).x, at(60, 60).y);
  h.more();
  const item = h.q('.ie-bubble-relations [data-action="bubble-relation"]');
  assert.ok(item, '「更多」里列出这条批注牵着的连线');
  const framesBeforeList = h.debug().frames;
  h.click(item);
  h.dom.flushFrames();
  assert.ok(h.debug().frames > framesBeforeList, '从便签选连线立即重画');
  assert.ok(strokes.includes('#e89bb0'), `选中的连线立即高亮：${strokes.join(',')}`);

  // 删线：下一帧就把线去掉，不留残影。
  resetCanvasLog();
  const framesBeforeRemove = h.debug().frames;
  h.click(h.q('[data-action="relation-delete"]'));
  h.dom.flushFrames();
  assert.ok(h.debug().frames > framesBeforeRemove, '删线立即重画');
  assert.equal(h.debug().relations.length, 0, '连线已经删掉');
  assert.equal(strokes.includes('#e89bb0'), false, '这一帧不再画这条线');
});

async function nestedMarks(h) {
  h.tool('region');
  h.drag(at(60, 60), at(200, 160));
  h.type('外框');
  h.tool('point');
  h.drag(at(75, 75));
  h.type('里面的点');
  h.tool('region');
  h.drag(at(130, 100), at(185, 145));
  h.type('里面小框');
  h.tool('select');
  h.dom.flushFrames();
  const notes = h.debug().notes;
  return { outer: notes[0], point: notes[1], inner: notes[2] };
}

test('选择工具命中优先：框内点/另一框先选目标，只有当前框自己的空白才拖框', async () => {
  const h = relationHarness();
  await h.open();
  const { outer, point, inner } = await nestedMarks(h);
  const selectOuter = () => {
    h.click(h.q(`.ie-marker[data-annotation-id="${outer.id}"][data-target-index="0"]`));
    h.dom.flushFrames();
    assert.equal(h.debug().noteId, outer.id, '前提：外框是当前框');
    assert.equal(h.debug().selectedTargets.length, 1);
  };

  // 普通点击框内的点：先选点，不把旧框拖走。
  selectOuter();
  const opsBefore = h.debug().ops;
  h.clickAt(at(75, 75).x, at(75, 75).y);
  const picked = h.debug();
  assert.equal(picked.selectedTargets.length, 1);
  assert.equal(picked.selectedTargets[0].annotationId, point.id, '普通点击框内点先选该目标');
  assert.equal(picked.ops, opsBefore, '只是选择，不产生几何历史');
  assert.equal(picked.drag, undefined, '没有进入移动/缩放');

  // Shift 点击框内的点：现在是普通替换选择（多选开关已撤），同样不拖框。
  selectOuter();
  h.clickAt(at(75, 75).x, at(75, 75).y, { shiftKey: true });
  const shiftPicked = h.debug();
  assert.equal(shiftPicked.selectedTargets.length, 1, '一次只选一处（单选）');
  assert.equal(shiftPicked.selectedTargets[0].annotationId, point.id, 'Shift 点框内点也先选中该目标');
  assert.equal(shiftPicked.ops, opsBefore, 'Shift 选择不产生几何历史');

  // 连线工具里点框内的另一框：只当连线起点，不拖旧框、不新建批注。
  selectOuter();
  h.tool('connect');
  h.clickAt(at(157, 122).x, at(157, 122).y);
  const connectedPick = h.debug();
  assert.equal(connectedPick.ops, opsBefore, '连线点选不产生几何历史');
  assert.equal(connectedPick.notes.length, 3, '连线点选不新建批注');
  assert.equal(connectedPick.drag, undefined, '连线不进入框移动');
  h.tool('select');
  h.key('Escape');

  // 普通点当前框自己的空白内部：仍然是拖框（一次可撤销变更）。
  selectOuter();
  h.drag(at(90, 140), at(100, 150));
  assert.equal(h.debug().ops, opsBefore + 1, '普通点框内空白仍能拖框，并且只记一次');
  assert.deepEqual(h.chips().map(value => value.split(' · ')[0]), ['框'], '整块平移 10/10');

  // 手柄缩放照旧。
  h.more();
  h.drag(at(210, 170), at(230, 190));
  assert.equal(h.debug().ops, opsBefore + 2, '手柄缩放也是一次可撤销变更');
  assert.deepEqual((await h.notes()).find(note => note.text === '外框').rect, { x: 70, y: 70, width: 160, height: 120 }, '右下角手柄拉大宽高');
});

test('收口门禁：说明/连线超限时，换选、空白点击、Esc 都不先丢掉输入与选择', async () => {
  const h = relationHarness();
  await h.open();
  await twoMarks(h);
  const long = '长'.repeat(2001);
  const notes = h.debug().notes;
  const bId = notes[1].id;

  // 说明超限时点空白：停在原批注与原输入上。
  h.type(long);
  h.clickAt(at(360, 280).x, at(360, 280).y);
  assert.equal(h.debug().noteId, bId, '超限时空白点击不先清选择');
  assert.equal(h.q('.ie-bubble-text').value, long, '说明输入原样保留');
  assert.match(h.q('.ie-status').textContent, /超过 2000 字/, '明确说清超限');

  // 改回短句后能正常切选择。
  h.type('短句');
  h.clickAt(at(60, 60).x, at(60, 60).y);
  assert.equal(h.debug().noteId, notes[0].id, '不超限时正常切到另一条');

  // 连线共同说明超限时：按 Esc / 点空白都不清选择、不丢字。
  h.tool('connect');
  h.drag(at(60, 60), at(180, 150));
  const relId = h.debug().selectedRelationId;
  assert.ok(relId, '前提：连线已建立并选中');
  const relationField = h.q('.ie-relation-text');
  relationField.value = '关'.repeat(2001);
  h.root.emit('input', { target: relationField });
  h.tool('select');
  h.key('Escape');
  assert.equal(h.debug().selectedRelationId, relId, '超限时 Esc 不先清选择');
  assert.equal(h.q('.ie-relation-text').value, '关'.repeat(2001), '共同说明输入原样保留');
  assert.match(h.q('.ie-status').textContent, /超过 2000 字/, '超限也要说清');

  // 超限时画布空白点击同样不清选择。
  h.clickAt(at(360, 280).x, at(360, 280).y);
  assert.equal(h.debug().selectedRelationId, relId, '超限时空白点击不先清选择');

  // 精简后恢复正常。
  relationField.value = '短';
  h.root.emit('input', { target: relationField });
  h.tool('select');
  h.clickAt(at(360, 280).x, at(360, 280).y);
  assert.equal(h.debug().selectedRelationId, null, '不超限时能正常清除选择');
});

test('删掉一端后连线缺端：仍能从这条批注的「更多」里选中并删线', async () => {
  const h = relationHarness();
  await h.open();
  await twoMarks(h);
  const notes = h.debug().notes;
  h.tool('connect');
  h.drag(at(60, 60), at(180, 150));
  assert.equal(h.debug().relations.length, 1, '前提：一条连线');
  const field = h.q('.ie-relation-text');
  field.value = '一起看';
  h.root.emit('input', { target: field });
  // 删掉一端批注（连带删线在同一份历史里）。
  h.tool('select');
  h.clickAt(at(180, 150).x, at(180, 150).y);
  h.click(h.q('[data-action="bubble-delete"]'));
  assert.equal(h.debug().notes.length, 1, '一端批注已删');
  assert.equal(h.debug().relations.length, 0, '牵连的线一起删掉');
  // 撤销恢复端点与连线，再删另一端：线成了缺端，仍要能处理。
  h.click(h.q('[data-action="undo"]'));
  assert.equal(h.debug().relations.length, 1, '撤销恢复端点与连线');
  h.clickAt(at(60, 60).x, at(60, 60).y);
  h.more();
  const relationItem = h.q('.ie-bubble-relations [data-action="bubble-relation"]');
  assert.ok(relationItem, '便签「更多」里列出这条批注牵着的线');
  assert.match(relationItem.textContent, /两处一起说/);
  h.click(relationItem);
  assert.equal(h.q('[data-action="relation-delete"]').textContent, '删线');
  h.key('Escape');
  assert.equal(h.debug().relations.length, 1, 'Esc 不删线');
});

// 只在测试内组装：真实源码 + 一个注入在 `const api = {` 之前的接缝，用来喂“旧 ops”。
// 产品当前没有导入旧历史的入口，也不新增；源码结构变了这里会立刻报错，不会静默跳过。
function modelHarness() {
  const dom = createEditorDom();
  const sandbox = { window: dom.window, document: dom.document, HTMLElement, Image: dom.Image,
    createImageBitmap: dom.createImageBitmap, ResizeObserver: dom.ResizeObserver,
    requestAnimationFrame: dom.requestAnimationFrame, cancelAnimationFrame: dom.cancelAnimationFrame,
    setTimeout, clearTimeout, queueMicrotask, console };
  vm.createContext(sandbox);
  for (const file of ['core/check-regions.js', 'core/segment-export.js', 'renderer/annotations.js', 'renderer/annotation-visuals.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: path.basename(file) });
  }
  let source = fs.readFileSync(path.join(ROOT, 'renderer', 'image-editor.js'), 'utf8');
  const anchor = '    const api = {';
  if (source.indexOf(anchor) < 0) throw new Error('image-editor.js 不再有测试接缝锚点：先确认源码结构再改测试');
  const seamSource = `    window.__editorModelSeam = () => ({
      get ops() { return ops; }, set ops(next) { ops = next; cursor = next.length; },
      get cursor() { return cursor; }, set cursor(next) { cursor = next; },
      get selectedTargets() { return selectedTargets; }, set selectedTargets(next) { selectedTargets = next; },
      get noteId() { return noteId; }, get noteState() { return noteState; }, get frameIndex() { return frameIndex; },
      get selectedRelationId() { return selectedRelationId; },
      get cropDraft() { return cropDraft; }, set cropDraft(next) { cropDraft = next; },
      writeNoteText, opById, annotationRecords, annotationList, pruneSelection, selectTarget, applyCrop, history, syncBubble
    });\n`;
  source = source.replace(anchor, seamSource + anchor);
  vm.runInContext(source, sandbox, { filename: 'image-editor.js' });
  dom.document.images.set(SOURCE_URL, { width: 400, height: 300 });
  const editor = sandbox.window.createImageEditor({ root: dom.root, onCommit: () => {}, onClose: () => {} });
  dom.attachBoxes();
  const seam = sandbox.window.__editorModelSeam();
  return { dom, editor, seam, q: selector => dom.root.querySelector(selector),
    async open() { await editor.open({ token: 'model', dataUrl: SOURCE_URL, width: 400, height: 300 }); dom.flushFrames(); } };
}

test('旧物化身份快照：改字写回所有历史载体，导出与清单不回到旧字，删除状态不复活', async () => {
  const m = modelHarness();
  await m.open();
  const seam = m.seam;
  const legacyA = 'legacy:a1:0:p:60,60';
  const legacyB = 'legacy:a2:0:p:220,180';
  seam.ops = [
    { tool: 'annotation', id: 'a1', kind: 'point', text: '旧字', point: { x: 60, y: 60 } },
    { tool: 'annotation', id: 'a2', kind: 'point', text: '另一端', point: { x: 220, y: 180 } },
    { tool: 'annotation-relation', id: 'r1',
      a: { annotationId: 'a1', targetId: legacyA }, b: { annotationId: 'a2', targetId: legacyB }, text: '两处一致',
      snapshots: [
        { id: 'a1', record: { tool: 'annotation', id: 'a1', kind: 'point', text: '旧字', point: { x: 60, y: 60 }, targetId: legacyA } },
        { id: 'a2', record: { tool: 'annotation', id: 'a2', kind: 'point', text: '另一端', point: { x: 220, y: 180 }, targetId: legacyB } }
      ] }
  ];
  m.dom.flushFrames();
  assert.equal(seam.annotationRecords().find(record => record.id === 'a1').text, '旧字', '前提：物化快照是当前历史版本');

  seam.writeNoteText('a1', '新字');
  assert.equal(seam.annotationRecords().find(record => record.id === 'a1').text, '新字', '改字要写进物化快照');
  assert.equal(seam.opById('a1').text, '新字', 'opById 与 annotationRecords 读同一版');
  assert.equal(seam.annotationList().find(note => note.id === 'a1').text, '新字', '清单用的是新字');

  const before = m.dom.canvases.length;
  await m.editor.exportClipboard();
  const painted = m.dom.canvases[before]
    ? m.dom.canvases[before].context.calls.filter(call => call.name === 'fillText').map(call => String(call.args[0])).join('')
    : '';
  assert.ok(painted.includes('新字'), `导出说明区带新字：${painted.slice(0, 80)}`);
  assert.equal(painted.includes('旧字'), false, '导出说明区不回到旧字');

  // 撤销/重做几何不把字带回去。
  seam.history(-1);
  assert.equal(seam.annotationRecords().find(record => record.id === 'a1').text, '新字', '撤销到关系前仍是新字');
  seam.history(1);
  assert.equal(seam.annotationRecords().find(record => record.id === 'a1').text, '新字', '重做回来还是新字');

  // 已删除的记录不被后来的物化快照复活。
  seam.ops = [
    { tool: 'annotation', id: 'a1', kind: 'point', text: '甲', point: { x: 60, y: 60 } },
    { tool: 'annotation-delete', id: 'a1' },
    { tool: 'annotation-relation', id: 'r9',
      a: { annotationId: 'a1', targetId: legacyA }, b: { annotationId: 'a1', targetId: legacyA }, text: '',
      snapshots: [{ id: 'a1', record: { tool: 'annotation', id: 'a1', kind: 'point', text: '复活?', point: { x: 60, y: 60 }, targetId: legacyA } }] }
  ];
  assert.equal(seam.opById('a1'), undefined, '已删除的批注不被快照复活');
  assert.equal(seam.annotationRecords().length, 0, '历史解析同样不复活');
});

test('裁切后清理失效选中：改选当前画面里还看得见的一处；整条被裁走就清选择', async () => {
  const m = modelHarness();
  await m.open();
  const seam = m.seam;
  // 主目标（A）被裁掉，B 还在画面里：不能拿看不见的主位置充当前选中。
  seam.ops = [{ tool: 'annotation', id: 'a1', kind: 'region', text: '两块都要改', targetId: 't1',
    rect: { x: 250, y: 200, width: 80, height: 60 },
    related: [{ kind: 'region', rect: { x: 20, y: 20, width: 100, height: 100 }, targetId: 't2' }] }];
  seam.selectTarget({ annotationId: 'a1', targetId: 't1' });
  assert.equal(seam.frameIndex, 0, '前提：当前选的是主目标 A');
  seam.cropDraft = { x: 0, y: 0, width: 200, height: 150 };
  seam.applyCrop();
  assert.equal(seam.noteId, 'a1', '裁切后仍停在这条批注');
  assert.deepEqual(JSON.parse(JSON.stringify(seam.selectedTargets)), [{ annotationId: 'a1', targetId: 't2' }],
    '回到当前画面里还看得见的一处（不是被裁走的主位置）');
  assert.equal(seam.frameIndex, 1, '调框下标跟着回到可见的那一处');
  assert.equal(m.q('.ie-note-bubble').hidden, false, '说明区跟着剩下那处');

  // 整条都被裁走：选择清掉，不指向看不见的目标。
  seam.ops = [{ tool: 'annotation', id: 'b1', kind: 'region', text: '整条在外面', targetId: 'u1',
    rect: { x: 250, y: 200, width: 80, height: 60 } }];
  seam.selectTarget({ annotationId: 'b1', targetId: 'u1' });
  seam.cropDraft = { x: 0, y: 0, width: 200, height: 150 };
  seam.applyCrop();
  assert.deepEqual(JSON.parse(JSON.stringify(seam.selectedTargets)), [], '没有可见目标就清掉选择');
  assert.equal(seam.noteId, null, '也不留一个看不见的当前批注');
  assert.equal(m.q('.ie-note-bubble').hidden, true, '说明区收回空态');
  // 裁切数据没被删：撤销仍能恢复原画面与目标。
  seam.history(-1);
  assert.equal(seam.annotationList().find(note => note.id === 'b1').text, '整条在外面', '撤销裁切后目标还在');
});

// —— 20261111 review-v2：图外手势门禁、连线里点线、一次 Esc 收起、人话两端摘要 ——
// 两个批注放得很开，线中段一定落在空白里，点线不会被端点命中抢走。
function farMarks(h) {
  h.tool('point');
  h.drag(at(30, 30));
  h.type('左边的点');
  h.tool('region');
  h.drag(at(320, 230), at(380, 280));
  h.type('右边的框');
  h.dom.flushFrames();
}

const pointerOf = (x, y, buttons, extra = {}) => ({ clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse',
  button: 0, buttons, preventDefault() {}, stopImmediatePropagation() {}, getCoalescedEvents: () => [], ...extra });

// 线中段在屏幕上的位置：从当前投影几何现算，不缓存旧坐标。
function lineMid(h, fraction = 0.5) {
  const d = h.debug();
  const curve = d.relations[0].curve;
  const sample = curve[Math.floor(curve.length * fraction)];
  return { x: d.origin.x + sample.x * d.zoom, y: d.origin.y + sample.y * d.zoom };
}

const escOn = (h, target) => h.dom.window.emit('keydown',
  { key: 'Escape', target, preventDefault() {}, stopImmediatePropagation() {} });

test('连线输入只认画面里的原始位置：图外不高亮、图外松手不建线、图外按下不起手', async () => {
  const h = relationHarness();
  await h.open();
  // 贴边批注：左边的点几乎贴着图左缘，右边的框贴着图右缘（letterbox 只差几个像素）。
  h.tool('point');
  h.drag(at(4, 150));
  h.type('贴左边的点');
  h.tool('region');
  h.drag(at(360, 120), at(399, 180));
  h.type('贴右边的框');
  h.tool('connect');
  const before = h.debug();

  // 图内起手，拖到右侧 letterbox（图外 4 CSS px）：不高亮贴边框、松手不建线、不写历史。
  h.scroller().emit('pointerdown', pointerOf(at(4, 150).x, at(4, 150).y, 1));
  assert.equal(h.debug().connect.phase, 'press', '前提：图内按下起了手势');
  h.scroller().emit('pointermove', pointerOf(388, at(0, 150).y, 1));
  assert.equal(h.debug().connect.hover, null, '图外移动不高亮贴边的可接点');
  h.scroller().emit('pointerup', pointerOf(388, at(0, 150).y, 0));
  assert.equal(h.debug().relations.length, 0, '图外松手不建线');
  assert.equal(h.debug().connect, null, '图外松手清暂态');
  assert.equal(h.debug().ops, before.ops, '图外松手不写历史');

  // 直接在左侧 letterbox 按下：clamp 后位置正好贴住那个点，也不能起手。
  h.clickAt(12, at(0, 150).y);
  assert.equal(h.debug().connect, null, '图外按下不起手');
  assert.equal(h.debug().relations.length, 0, '图外按下不连线');
  assert.equal(h.debug().ops, before.ops, '图外按下不写历史');

  // 同一个贴边目标在图内拖：照常连上，门禁没把正常手势一起拦掉。
  h.drag(at(4, 150), at(380, 150));
  assert.equal(h.debug().relations.length, 1, '图内拖到贴边框照常建立');
});

test('连线只由发起手势的主键指针完成：右键松手不提交等着的第二击', async () => {
  const h = relationHarness();
  await h.open();
  await twoMarks(h);
  h.tool('connect');
  h.clickAt(at(60, 60).x, at(60, 60).y);
  assert.equal(h.debug().connect.phase, 'armed', '前提：第一击后等第二击');
  const before = h.debug();
  // 右键在另一处松手：既不能建线，也不能把等着的起点清掉。
  h.scroller().emit('pointerup', pointerOf(at(180, 150).x, at(180, 150).y, 0, { button: 2 }));
  assert.equal(h.debug().relations.length, 0, '右键松手不建线');
  assert.equal(h.debug().ops, before.ops, '右键松手不写历史');
  assert.equal(h.debug().connect.phase, 'armed', '等第二击的手势还在');
  // 换回主键点同一处：正常连上。
  h.clickAt(at(180, 150).x, at(180, 150).y);
  assert.equal(h.debug().relations.length, 1, '主键照常完成连线');
});

test('连线手势被打断（pointercancel / 失焦）只清暂态，不写历史、不删批注', async () => {
  const h = relationHarness();
  await h.open();
  await twoMarks(h);
  h.tool('connect');
  const before = h.debug();
  h.scroller().emit('pointerdown', pointerOf(at(60, 60).x, at(60, 60).y, 1));
  assert.equal(h.debug().connect.phase, 'press', '前提：拖动中');
  h.scroller().emit('pointercancel', { pointerId: 1 });
  assert.equal(h.debug().connect, null, 'pointercancel 清掉这次手势');
  assert.equal(h.debug().notes.length, 2, '批注一条不少');
  assert.equal(h.debug().ops, before.ops, 'pointercancel 不写历史');
  // 等第二击时失焦：同样只清暂态。
  h.clickAt(at(60, 60).x, at(60, 60).y);
  assert.equal(h.debug().connect.phase, 'armed', '前提：等第二击');
  h.dom.window.emit('blur', {});
  assert.equal(h.debug().connect, null, '失焦清掉等着的起点');
  assert.equal(h.debug().ops, before.ops, '失焦不写历史');
  assert.equal(h.debug().notes.length, 2, '批注还在');
  h.dom.flushFrames();
});

test('连线模式里直接点已有的线：选中它改共同说明、删线，不新建线也不写历史', async () => {
  const h = relationHarness();
  await h.open();
  await farMarks(h);
  h.tool('connect');
  h.drag(at(30, 30), at(320, 230));
  const relation = h.debug().relations[0];
  const field = h.q('.ie-relation-text');
  field.value = '原来这句';
  h.root.emit('input', { target: field });
  const before = h.debug();
  // 先收起便签（一次 Esc），仍留在连线工具里。
  escOn(h, field);
  assert.equal(h.debug().selectedRelationId, null, '前提：便签已收起');
  assert.equal(h.q('.ie-relation-bubble').hidden, true, '前提：便签不挡画布');

  const mid = lineMid(h);
  h.clickAt(mid.x, mid.y);
  const selected = h.debug();
  assert.equal(selected.selectedRelationId, relation.id, '连线模式下点线就选中它');
  assert.equal(selected.tool, 'connect', '保持连线工具，不偷偷切选择');
  assert.equal(h.q('.ie-relation-bubble').hidden, false, '共同说明 + 删线就在眼前');
  assert.equal(h.q('.ie-relation-text').value, '原来这句', '原共同说明带回来');
  assert.equal(h.q('[data-action="relation-delete"]').textContent, '删线');
  assert.equal(selected.relations.length, 1, '不重复建线');
  assert.equal(selected.ops, before.ops, '点线不写历史');

  // 就地改字写回同一条线。
  field.value = '改过的共同说明';
  h.root.emit('input', { target: field });
  assert.equal(h.debug().relations[0].text, '改过的共同说明', '点线后能直接改字');
  assert.equal(h.debug().ops, before.ops, '改字也不写历史');

  // 端点优先：线穿过端点也不能抢起点手势。
  escOn(h, h.q('.ie-scroll'));
  h.clickAt(at(30, 30).x, at(30, 30).y);
  const endpoint = h.debug();
  assert.equal(endpoint.selectedRelationId, null, '端点没有被线抢走');
  assert.ok(endpoint.connect && endpoint.connect.start, '端点先起连线手势');
  assert.equal(endpoint.connect.start.annotationId, h.debug().notes[0].id, '起点就是那个端点批注');
  escOn(h, h.q('.ie-scroll'));
  assert.equal(h.debug().connect, null, 'Esc 取消这次手势');

  // 再点线中段 → 删线：只删线，两端批注与文字都在。
  const mid2 = lineMid(h);
  h.clickAt(mid2.x, mid2.y);
  assert.equal(h.debug().selectedRelationId, relation.id, '再点一次还能选中');
  h.click(h.q('[data-action="relation-delete"]'));
  assert.equal(h.debug().relations.length, 0, '删线成功');
  assert.equal(h.debug().notes.length, 2, '两端批注都在');
  assert.equal(h.debug().notes.map(note => note.text).join('|'), '左边的点|右边的框', '两端文字都在');
  h.dom.flushFrames();
});

test('连线共同说明一次 Esc 收起便签；超限时保留原字、原选择与焦点', async () => {
  const h = relationHarness();
  await h.open();
  await farMarks(h);
  h.tool('connect');
  h.drag(at(30, 30), at(320, 230));
  const relation = h.debug().relations[0];
  const field = h.q('.ie-relation-text');
  field.focus();
  field.value = '两处一起说';
  h.root.emit('input', { target: field });
  escOn(h, field);
  const collapsed = h.debug();
  assert.equal(collapsed.selectedRelationId, null, '一次 Esc 就收起这条线的便签');
  assert.equal(h.q('.ie-relation-bubble').hidden, true, '便签不再遮挡画面');
  assert.equal(collapsed.tool, 'connect', '工具还是连线');
  assert.equal(collapsed.relations.length, 1, '线还在');
  assert.equal(collapsed.relations[0].text, '两处一起说', '共同说明保留');
  assert.equal(collapsed.notes.map(note => note.text).join('|'), '左边的点|右边的框', '两端文字保留');
  assert.equal(h.q('[data-action="relation-delete"]').textContent, '删线', '删线入口还在');

  // 超限：一次 Esc 不能先清选择/丢字，焦点也要留在输入框。
  const mid = lineMid(h);
  h.clickAt(mid.x, mid.y);
  assert.equal(h.debug().selectedRelationId, relation.id, '前提：能重新选中这条线');
  const long = '长'.repeat(2001);
  field.value = long;
  h.root.emit('input', { target: field });
  field.focus();
  escOn(h, field);
  assert.equal(h.debug().selectedRelationId, relation.id, '超限时不清选择');
  assert.equal(field.value, long, '超限时原字保留');
  assert.equal(h.dom.document.activeElement, field, '超限时焦点留在输入框');
  assert.match(h.q('.ie-status').textContent, /超过 2000 字/, '明确说清超限');
  h.dom.flushFrames();
});

test('连线模式点空白只收起当前便签：不造新批注/线、不写历史', async () => {
  const h = relationHarness();
  await h.open();
  await farMarks(h);
  h.tool('connect');
  h.drag(at(30, 30), at(320, 230));
  const relation = h.debug().relations[0];
  // 先收起建线后自动弹出的便签，再点线选中它：连线工具下真实能开着的就是线旁便签。
  escOn(h, h.q('.ie-relation-text'));
  assert.equal(h.debug().selectedRelationId, null, '前提：便签先收起');
  const mid = lineMid(h);
  h.clickAt(mid.x, mid.y);
  assert.equal(h.debug().selectedRelationId, relation.id, '前提：线旁便签开着');
  assert.equal(h.q('.ie-relation-bubble').hidden, false, '前提：便签真的露出来了');
  const before = h.debug();
  h.clickAt(at(200, 100).x, at(200, 100).y);
  const after = h.debug();
  assert.equal(after.selectedRelationId, null, '空白点击收起便签');
  assert.equal(h.q('.ie-relation-bubble').hidden, true, '便签真的收起来了');
  assert.equal(h.q('.ie-note-bubble').hidden, true, '也没有另开一条批注便签');
  assert.equal(after.notes.length, 2, '没造新批注');
  assert.equal(after.relations.length, 1, '没造新线');
  assert.equal(after.ops, before.ops, '不写历史');
  assert.equal(after.notes[0].text, '左边的点', '批注文字原样保留');
  assert.equal(after.tool, 'connect', '工具不变');
  h.dom.flushFrames();
});

test('连线便签的两端用人话方位，不露裸坐标；title 与导出说明同样只给编号与方位', async () => {
  const h = relationHarness();
  await h.open();
  await twoMarks(h);
  h.tool('connect');
  h.drag(at(60, 60), at(180, 150));
  const field = h.q('.ie-relation-text');
  field.value = '两处一起改';
  h.root.emit('input', { target: field });
  const ends = h.q('.ie-relation-ends');
  assert.equal(h.q('.ie-relation-bubble').hidden, false, '前提：连线便签开着');
  assert.doesNotMatch(ends.textContent, /[（(]\s*-?\d/, `便签不该露裸坐标：${ends.textContent}`);
  assert.match(ends.textContent, /批注\s*1/, `要有批注编号：${ends.textContent}`);
  assert.match(ends.textContent, /批注\s*2/, `要有另一端编号：${ends.textContent}`);
  assert.match(ends.textContent, /↔/, '两端用箭头连起来');
  assert.match(ends.textContent, /上|下|左|右|居中/, '方位用人话');
  assert.match(ends.title, /第 1 条 点 · /, '悬停给的是编号 + 方位，不是坐标');
  assert.match(ends.title, /第 2 条 框 · /, '框那端也是编号 + 方位');
  assert.doesNotMatch(ends.title, /[（(]\s*-?\d/, `悬停也不该露裸坐标：${ends.title}`);
  // 导出说明（复制图下方的说明文字）同样只给编号与原文，不再回显坐标。
  const copied = await h.copy();
  const pointEntry = copied.annotations.find(item => item.kind === 'point');
  const regionEntry = copied.annotations.find(item => item.kind === 'region');
  assert.deepEqual(pointEntry.point, { x: 60, y: 60 }, '点的位置仍在成图像素里（说明文字不再重复）');
  assert.deepEqual(regionEntry.rect, { x: 180, y: 150, width: 100, height: 90 }, '框的位置同样在成图像素里');
  assert.ok(copied.lines.some(line => /^意见1：/.test(line)), '说明区一行一条意见：意见1 + 原文');
  assert.ok(copied.lines.some(line => /^意见2：/.test(line)), '第二条意见也按编号列出');
  assert.equal(copied.lines.some(line => /\(\s*-?\d+\s*,/.test(line)), false, '说明区不再出现坐标串');
});

// —— 便签底部的「完成」：只是收口反馈，不新增「点完成才写入」的模型 ——
test('单处与连线便签底部各有「完成」，在自己卡片里另起一行，不挤进头部按钮组', async () => {
  const h = relationHarness();
  await h.open();
  const noteDone = h.q('.ie-note-bubble [data-action="note-done"]');
  const relationDone = h.q('.ie-relation-bubble [data-action="relation-done"]');
  assert.ok(noteDone, '单处批注便签有「完成」');
  assert.ok(relationDone, '连线共同说明便签也有「完成」');
  assert.equal(noteDone.textContent.trim(), '完成');
  assert.equal(relationDone.textContent.trim(), '完成');
  assert.equal(noteDone.closest('.ie-note-bubble'), h.q('.ie-note-bubble'), '按钮长在自己卡片里');
  assert.equal(relationDone.closest('.ie-relation-bubble'), h.q('.ie-relation-bubble'));
  assert.equal(noteDone.closest('.ie-card-actions'), null, '不塞回头部按钮组/长浮条');
  assert.ok(noteDone.closest('.ie-card-foot'), '底部操作行是独立一层');
  assert.equal(h.q('.ie-comment-bubble [data-action="note-done"]'), null, '补充说明仍是原来的收起，不扩改');
  // 占位提示不再跟新按钮打架：只说写一句 / 两处一起说，离开也记下。
  assert.equal(h.field().placeholder, '写一句说明…（走开也会记下）');
  assert.equal(h.q('.ie-relation-text').placeholder, '两处一起说…（走开也会记下）');
});

test('点「完成」收起便签：没按回车的字已记下、工具不变，重选回来字还在', async () => {
  const h = relationHarness();
  await h.open();
  h.tool('point');
  h.drag(at(80, 80));
  h.type('这块留白大一点');
  const before = h.debug();
  h.click(h.q('[data-action="note-done"]'));
  h.dom.flushFrames();
  const after = h.debug();
  assert.equal(h.q('.ie-note-bubble').hidden, true, '完成后便签收起');
  assert.equal(after.noteId, null, '选中一起放下');
  assert.equal(after.notes.length, 1, '标记还在');
  assert.equal(after.notes[0].text, '这块留白大一点', '没按回车的字已记下');
  assert.equal(after.ops, before.ops, '完成不新增 op');
  assert.equal(after.cursor, before.cursor, '完成不推进历史');
  assert.equal(h.q('[data-tool="point"]').getAttribute('aria-pressed'), 'true', '保持当前绘图工具，能接着批注');
  assert.match(h.q('.ie-status').textContent, /批注已记下/);
  assert.doesNotMatch(h.q('.ie-status').textContent, /保存/, '不说「已保存到图片」');

  h.click(h.q('.ie-marker'));
  h.dom.flushFrames();
  assert.equal(h.q('.ie-note-bubble').hidden, false, '点编号重开这条');
  assert.equal(h.field().value, '这块留白大一点', '重选回来字还在');
});

test('写字后点别处：便签自动收起、字留着；点便签内部不算走开', async () => {
  const h = relationHarness();
  await h.open();
  h.tool('region');
  h.drag(at(40, 40), at(200, 160));
  h.type('走开也要记下');
  const field = h.q('.ie-bubble-text');
  h.root.emit('focusout', { target: field, relatedTarget: null });
  h.dom.flushFrames();
  assert.equal(h.q('.ie-note-bubble').hidden, true, '走开后便签收起，像是“存下了”');
  assert.equal(h.debug().noteId, null, '选中一起放下');
  assert.equal(h.debug().notes[0].text, '走开也要记下', '字已经在批注里，不用点完成');

  h.click(h.q('.ie-marker'));
  h.dom.flushFrames();
  const more = h.q('.ie-note-bubble [data-action="bubble-more-toggle"]');
  h.root.emit('focusout', { target: h.q('.ie-bubble-text'), relatedTarget: more });
  h.dom.flushFrames();
  assert.equal(h.q('.ie-note-bubble').hidden, false, '点便签内部（更多/删除/位置）不算走开');

  // 输入法组合没结束时不动它：否则会把正在拼的字撤掉。
  h.root.emit('compositionstart', { target: h.q('.ie-bubble-text') });
  h.root.emit('focusout', { target: h.q('.ie-bubble-text'), relatedTarget: null });
  h.dom.flushFrames();
  assert.equal(h.q('.ie-note-bubble').hidden, false, '组合未结束时不收');
  h.root.emit('compositionend', { target: h.q('.ie-bubble-text') });
  h.root.emit('focusout', { target: h.q('.ie-bubble-text'), relatedTarget: null });
  h.dom.flushFrames();
  assert.equal(h.q('.ie-note-bubble').hidden, true, '组合结束后再走开就收');
});

test('完成一条后接着新建：不误连上一条，也不把旧字带过来', async () => {
  const h = relationHarness();
  await h.open();
  h.tool('point');
  h.drag(at(80, 80));
  h.type('第一条');
  h.click(h.q('[data-action="note-done"]'));
  h.dom.flushFrames();
  h.tool('point');
  h.drag(at(240, 200));
  h.dom.flushFrames();
  const after = h.debug();
  assert.equal(after.notes.length, 2, '第二处直接新建');
  assert.equal(after.relations.length, 0, '没留下下一击会误连的暂态');
  assert.equal(after.connect, null, '连线手势是干净的');
  assert.equal(h.field().value, '', '新便签是空输入，不带旧字');
  assert.deepEqual([...after.notes.map(note => note.text)], ['第一条', '']);
});

test('连线说明点「完成」：线、两端原文、共同说明都留着，一次撤销只退这条线本身', async () => {
  const h = relationHarness();
  await h.open();
  await twoMarks(h);
  h.tool('connect');
  h.drag(at(60, 60), at(180, 150));
  const field = h.q('.ie-relation-text');
  field.value = '两处一起说';
  h.root.emit('input', { target: field });
  const before = h.debug();
  assert.equal(before.selectedRelationId, before.relations[0].id, '前提：这条线正被选中');
  h.click(h.q('[data-action="relation-done"]'));
  h.dom.flushFrames();
  const after = h.debug();
  assert.equal(h.q('.ie-relation-bubble').hidden, true, '完成后连线便签收起');
  assert.equal(after.selectedRelationId, null);
  assert.equal(after.relations.length, 1, '完成不删线');
  assert.equal(after.relations[0].text, '两处一起说', '共同说明留着');
  assert.deepEqual([...after.notes.map(note => note.text)], ['上边按钮', '下面的分组'], '两端原字都在');
  assert.equal(after.ops, before.ops, '完成不新增 op/历史');
  assert.equal(after.cursor, before.cursor);
  assert.match(h.q('.ie-status').textContent, /连线说明已记下/);

  // 点线重选：共同说明还在。
  const relationId = after.relations[0].id, curve = after.relations[0].curve;
  h.tool('select');
  let hit = false;
  for (const sample of curve.slice(1, -1)) {
    h.clickAt(after.origin.x + sample.x * after.zoom, after.origin.y + sample.y * after.zoom);
    if (h.debug().selectedRelationId === relationId) { hit = true; break; }
  }
  assert.ok(hit, '点连线能重新选中它');
  assert.equal(h.q('.ie-relation-text').value, '两处一起说', '重选回来共同说明还在');

  // 完成不是一步历史：第一次撤销退的是这条线本身，两端批注原样留着。
  h.clickAt(at(360, 280).x, at(360, 280).y);
  h.click(h.q('[data-action="undo"]'));
  h.dom.flushFrames();
  const undone = h.debug();
  assert.equal(undone.relations.length, 0, '一次撤销直接退掉这条线');
  assert.deepEqual([...undone.notes.map(note => note.text)], ['上边按钮', '下面的分组'], '两端批注与各自原文都还在');
});

test('完成遇上超限：不收起、不丢输入与选择，也不报已完成', async () => {
  const h = relationHarness();
  await h.open();
  h.tool('point');
  h.drag(at(80, 80));
  const long = '长'.repeat(2001);
  h.type(long);
  const before = h.debug();
  h.click(h.q('[data-action="note-done"]'));
  h.dom.flushFrames();
  const after = h.debug();
  assert.equal(h.q('.ie-note-bubble').hidden, false, '超限不收起便签');
  assert.equal(after.noteId, before.noteId, '选择留在原处');
  assert.equal(h.field().value, long, '输入原样保留');
  assert.match(h.q('.ie-status').textContent, /超过 2000 字/);
  assert.doesNotMatch(h.q('.ie-status').textContent, /已记下/);
  assert.equal(after.ops, before.ops, '超限不写任何东西');

  // 连线共同说明同样先校验：失败就留在原线、原输入。
  h.type('短句');
  h.tool('connect');
  h.drag(at(60, 60), at(180, 150));
  const relationField = h.q('.ie-relation-text');
  relationField.value = '关'.repeat(2001);
  h.root.emit('input', { target: relationField });
  const relBefore = h.debug();
  h.click(h.q('[data-action="relation-done"]'));
  h.dom.flushFrames();
  assert.equal(h.q('.ie-relation-bubble').hidden, false, '超限不收起连线便签');
  assert.equal(h.debug().selectedRelationId, relBefore.selectedRelationId);
  assert.equal(h.q('.ie-relation-text').value, '关'.repeat(2001), '共同说明输入原样保留');
  assert.match(h.q('.ie-status').textContent, /超过 2000 字/);
});

test('空字点「完成」：位置留着，只提示稍后补一句，不塞假占位字', async () => {
  const h = relationHarness();
  await h.open();
  h.tool('region');
  h.drag(at(40, 40), at(120, 120));
  h.click(h.q('[data-action="note-done"]'));
  h.dom.flushFrames();
  const after = h.debug();
  assert.equal(h.q('.ie-note-bubble').hidden, true, '空字也能收起');
  assert.equal(after.notes.length, 1, '空框没被丢掉');
  assert.equal(after.notes[0].text, '', '不塞假占位字');
  assert.match(h.q('.ie-status').textContent, /还没写说明/);
  assert.doesNotMatch(h.q('.ie-status').textContent, /已记下/);
  assert.ok(after.relationCount === 0);
  // 原有的输出完整性 guard 原样：空标记仍被拦下。
  const blockedMessage = await h.editor.exportClipboard().then(() => '').catch(error => String(error.message || error));
  assert.match(blockedMessage, /既没正文、也没被有效关系覆盖/);
});

test('屏幕框是一条干净细实线：不走手绘 helper，草稿才用短虚线且本帧内复位', async () => {
  let rough = 0;
  const h = relationHarness({ visualsPatch: { strokeNoteBox: () => { rough += 1; } } });
  await h.open();
  h.tool('region');
  h.drag(at(40, 40), at(120, 120));
  h.dom.flushFrames();
  const scroller = h.q('.ie-scroll'), display = h.q('.ie-display').context;
  const original = display.setLineDash;
  const dashes = [];
  const watch = on => { display.setLineDash = on
    ? value => { dashes.push(Array.isArray(value) ? [...value] : value); original(value); }
    : original; };
  const frameWith = () => {
    h.dom.flushFrames();
    const from = display.calls.length;
    scroller.emit('scroll');
    h.dom.flushFrames();
    return display.calls.slice(from);
  };

  const committed = frameWith();
  assert.equal(rough, 0, '不再调用共享手绘 strokeNoteBox');
  assert.equal(committed.filter(call => call.name === 'strokeRect' && Math.abs(call.args[0] - 40) < 0.01 &&
    Math.abs(call.args[1] - 40) < 0.01 && Math.abs(call.args[2] - 80) < 0.01 && Math.abs(call.args[3] - 80) < 0.01).length,
    1, '一次规则矩形，没有纸底/双描');
  watch(true); dashes.length = 0;
  frameWith();
  watch(false);
  assert.ok(dashes.length > 0, '画框会显式设一次 dash');
  assert.ok(dashes.every(value => Array.isArray(value) && value.length === 0), `已存的框是实线：${JSON.stringify(dashes)}`);

  // 草稿（还没松手）改用短虚线，且同一帧里就复位，不留给下一个框。
  const pe = (x, y, buttons) => ({ clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0, buttons,
    preventDefault() {}, stopImmediatePropagation() {}, getCoalescedEvents: () => [] });
  watch(true); dashes.length = 0;
  h.dom.flushFrames();
  const draftFrom = display.calls.length;
  scroller.emit('pointerdown', pe(at(200, 140).x, at(200, 140).y, 1));
  scroller.emit('pointermove', pe(at(300, 220).x, at(300, 220).y, 1));
  h.dom.flushFrames();
  watch(false);
  const draftFrame = display.calls.slice(draftFrom);
  assert.ok(dashes.some(value => Array.isArray(value) && value.length === 2 && value[0] > 0),
    `草稿框要用短虚线：${JSON.stringify(dashes)}`);
  assert.ok(dashes.some(value => Array.isArray(value) && value.length === 0), '虚线在同一个框画完就复位');
  assert.equal(draftFrame.filter(call => call.name === 'strokeRect' && Math.abs(call.args[0] - 200) < 0.01 &&
    Math.abs(call.args[2] - 100) < 0.01).length, 1, '草稿也只有一条规则框，不双描');
  assert.equal(rough, 0, '草稿也没走手绘 helper');

  // 松手后草稿转正：这一帧不再有虚线。
  watch(true); dashes.length = 0;
  scroller.emit('pointerup', pe(at(300, 220).x, at(300, 220).y, 0));
  h.dom.flushFrames();
  watch(false);
  assert.ok(dashes.every(value => Array.isArray(value) && value.length === 0), `转正后只剩实线：${JSON.stringify(dashes)}`);
  assert.equal(h.debug().notes.length, 2, '松手后草稿转成第二条正式批注');
});

test('屏幕框线宽固定 2 CSS px：放大到 400% 也不变粗，实线不继承调用者的 dash', async () => {
  const h = relationHarness();
  await h.open();
  h.tool('region');
  h.drag(at(40, 40), at(120, 120));
  // 放大到远超 200%（每次 ×1.2，上限 8 倍）：线宽要按屏幕像素折算，不能被 1 原像素下限拉粗。
  for (let i = 0; i < 12; i += 1) h.click(h.q('[data-action="zoom-in"]'));
  h.dom.flushFrames();
  const zoom = h.debug().zoom;
  assert.ok(zoom > 2, `前提：已经放大到 ${zoom} 倍`);
  const context = h.q('.ie-display').context;
  const dashes = [];
  const originalDash = context.setLineDash;
  context.setLineDash = value => { dashes.push(Array.isArray(value) ? [...value] : value); originalDash(value); };
  const strokes = [];
  const originalStroke = context.strokeRect;
  context.strokeRect = (...args) => {
    strokes.push({ args, width: context.lineWidth, dash: dashes.length ? [...dashes[dashes.length - 1]] : null });
    originalStroke(...args);
  };
  // 调用者本来就在虚线状态：实线框不能继承它，必须自己清成实线。
  context.setLineDash([9, 9]);
  h.q('.ie-scroll').emit('scroll');
  h.dom.flushFrames();
  const box = strokes.filter(stroke => stroke.args[0] === 40 && stroke.args[1] === 40
    && stroke.args[2] === 80 && stroke.args[3] === 80);
  assert.equal(box.length, 1, '这个框还是一条规则矩形');
  assert.ok(Math.abs(box[0].width * zoom - 2) < 1e-9, `屏幕上仍是 2px 细线：${box[0].width}×${zoom}`);
  assert.deepEqual(box[0].dash, [], '实线在 strokeRect 之前就清成实线，不继承调用者的虚线');

  // 草稿（还没松手）用短虚线：同样按屏幕比例，不随放大变粗。
  h.key('Escape');
  h.dom.flushFrames();
  const d = h.debug();
  const sx = d.view.x + d.view.width * 0.25, sy = d.view.y + d.view.height * 0.25;
  const client = { x: d.origin.x + sx * d.zoom, y: d.origin.y + sy * d.zoom };
  const pe = (x, y, buttons) => ({ clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0, buttons,
    preventDefault() {}, stopImmediatePropagation() {}, getCoalescedEvents: () => [] });
  strokes.length = 0; dashes.length = 0;
  const scroller = h.q('.ie-scroll');
  scroller.emit('pointerdown', pe(client.x, client.y, 1));
  scroller.emit('pointermove', pe(client.x + 60 * d.zoom, client.y + 40 * d.zoom, 1));
  h.dom.flushFrames();
  const draft = strokes.filter(stroke => Math.abs(stroke.args[0] - sx) < 0.01 && Math.abs(stroke.args[1] - sy) < 0.01
    && Math.abs(stroke.args[2] - 60) < 0.01 && Math.abs(stroke.args[3] - 40) < 0.01);
  assert.equal(draft.length, 1, '草稿框也只描一次');
  assert.deepEqual(draft[0].dash, [6 / d.zoom, 4 / d.zoom], '草稿虚线按屏幕比例，不随放大约束');
  scroller.emit('pointerup', pe(client.x + 60 * d.zoom, client.y + 40 * d.zoom, 0));
  h.dom.flushFrames();
});

test('只有空格/换行的说明点「完成」：仍收起、位置留着、提示待补，不新增历史', async () => {
  const h = relationHarness();
  await h.open();
  h.tool('point');
  h.drag(at(80, 80));
  h.type('   ');
  const before = h.debug();
  h.click(h.q('[data-action="note-done"]'));
  h.dom.flushFrames();
  const after = h.debug();
  assert.equal(h.q('.ie-note-bubble').hidden, true, '纯空格也算收口');
  assert.equal(after.notes.length, 1, '标记留着');
  assert.equal(after.notes[0].text, '   ', '原样保留输入，不改存进去的原文');
  assert.match(h.q('.ie-status').textContent, /还没写说明/);
  assert.doesNotMatch(h.q('.ie-status').textContent, /已记下/);
  assert.equal(after.ops, before.ops, '不新增 op');
  assert.equal(after.cursor, before.cursor, '不推进历史');

  // 换行同理。
  h.tool('point');
  h.drag(at(200, 200));
  h.type('\n');
  h.click(h.q('[data-action="note-done"]'));
  h.dom.flushFrames();
  const second = h.debug();
  assert.equal(second.notes.length, 2, '第二个标记也留着');
  assert.equal(second.notes[1].text, '\n', '换行原样保留');
  assert.match(h.q('.ie-status').textContent, /还没写说明/);

  // 连线共同说明同样：线留着、提示待补、不写历史。
  await twoMarks(h);
  h.tool('connect');
  h.drag(at(60, 60), at(180, 150));
  const relationField = h.q('.ie-relation-text');
  relationField.value = ' \n ';
  h.root.emit('input', { target: relationField });
  const relBefore = h.debug();
  h.click(h.q('[data-action="relation-done"]'));
  h.dom.flushFrames();
  const relAfter = h.debug();
  assert.equal(h.q('.ie-relation-bubble').hidden, true, '纯空白的共同说明也算收口');
  assert.equal(relAfter.relations.length, 1, '线留着');
  assert.equal(relAfter.relations[0].text, ' \n ', '共同说明原样保留');
  assert.match(h.q('.ie-status').textContent, /还没写共同说明/);
  assert.equal(relAfter.ops, relBefore.ops, '不新增 op');
  assert.equal(relAfter.cursor, relBefore.cursor, '不推进历史');
});
