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

function harness({ width = 400, height = 300, animation = false, onMinimize = null, onPreviewRequest = null, onExitRequest = null } = {}) {
  const dom = createEditorDom();
  const sandbox = { window: dom.window, document: dom.document, HTMLElement, Image: dom.Image,
    createImageBitmap: dom.createImageBitmap, ResizeObserver: dom.ResizeObserver,
    requestAnimationFrame: dom.requestAnimationFrame, cancelAnimationFrame: dom.cancelAnimationFrame,
    setTimeout, clearTimeout, queueMicrotask, console };
  vm.createContext(sandbox);
  for (const file of ['annotations.js', 'image-editor.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'renderer', file), 'utf8'), sandbox, { filename: file });
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
  const open = async () => { await editor.open({ token: 'ui', dataUrl: SOURCE_URL, width, height }); dom.flushFrames(); };
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
  const panel = () => q('.ie-panel');
  // 导出结果从复制图下方的说明区读回来（与界面上看到的一致，不用内部 API）。
  const readPanel = lines => {
    const annotations = [];
    let comment = '';
    for (const line of lines) {
      const head = /^第 (\d+) 条 · (点|框) \(([^)]*)\)：([\s\S]*)$/.exec(line);
      if (head) {
        const parts = head[3].split(',').map(value => Number(value.trim()));
        annotations.push({ number: Number(head[1]), kind: head[2] === '点' ? 'point' : 'region',
          ...(head[2] === '点' ? { point: { x: parts[0], y: parts[1] } }
            : { rect: { x: parts[0], y: parts[1], width: parts[2], height: parts[3] } }), text: head[4] });
        continue;
      }
      if (line.startsWith('总体说明：')) comment = line.slice('总体说明：'.length);
    }
    return { annotations, comment };
  };
  const copy = async () => {
    const before = dom.canvases.length;
    const raw = await editor.exportClipboard();
    const canvas = dom.canvases[before] || null;
    const lines = canvas ? canvas.context.calls.filter(call => call.name === 'fillText').map(call => String(call.args[0])) : [];
    return { raw, lines, ...readPanel(lines) };
  };
  const notes = async () => { try { return (await copy()).annotations; } catch { return []; } };
  return { dom, window: dom.window, root: dom.root, editor, commits, closes, previews, exits, q, qa, click, open, drag, tool, type, chips, note, panel, copy, notes,
    field: () => q('.ie-bubble-text'), save: () => click(q('[data-action="bubble-save"]')), cancel: () => click(q('[data-action="bubble-cancel"]')),
    key: key => dom.window.emit('keydown', { key, target: q('.ie-scroll'), preventDefault() {}, stopImmediatePropagation() {} }) };
}

test('顶栏三段输出按另存 / 保存 / 复制排列，动作映射分别是 save / save-quick / copy', async () => {
  const h = harness();
  await h.open();
  const exports = [...h.q('.ie-exports').children];
  assert.deepEqual(exports.map(node => node.dataset.action), ['save-as', 'save', 'copy']);
  assert.deepEqual(exports.map(node => node.textContent), ['另存…', '保存', '复制图片']);
  assert.equal(exports[2].classList.contains('ie-primary'), true, '复制是主按钮');
  // 另存与保存同一层：细边纸白，不再是没轮廓的透明按钮；复制仍唯一主按钮。
  assert.equal(exports[0].classList.contains('ie-outline'), true, '另存与保存同级细边');
  assert.equal(exports[1].classList.contains('ie-outline'), true);
  assert.equal(exports[2].classList.contains('ie-outline'), false, '复制不能降级成次级按钮');

  h.click(exports[0]); await new Promise(resolve => setImmediate(resolve));
  h.click(exports[1]); await new Promise(resolve => setImmediate(resolve));
  h.click(exports[2]); await new Promise(resolve => setImmediate(resolve));
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
  // 输出三按钮的顺序与主次不受影响。
  assert.deepEqual([...group.children].filter(node => node.dataset.action).map(node => node.dataset.action), ['save-as', 'save', 'copy']);
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

test('横排工具按原型五组排，属性只跟当前工具，长说明收进帮助里', async () => {
  const h = harness();
  await h.open();
  const labels = h.qa('.ie-tool-group .ie-group-label').map(node => node.textContent);
  assert.deepEqual(labels, ['查看', '需求批注', '画标记', '处理图片', '编辑历史']);
  const groups = h.qa('.ie-tool-group');
  const toolsOf = index => [...groups[index].querySelectorAll('[data-tool]')].map(node => node.dataset.tool);
  assert.deepEqual(toolsOf(0), ['browse', 'select'], '查看组：抓手 + 选择');
  assert.deepEqual(toolsOf(1), ['point', 'region']);
  assert.deepEqual(toolsOf(2), ['pen', 'arrow', 'line', 'rect']);
  assert.deepEqual(toolsOf(3), ['mosaic', 'crop']);
  assert.deepEqual(toolsOf(4), []);
  // 文字按原型：画笔 / 点批注，不再叫自由笔 / 批注。
  assert.deepEqual([...groups[2].querySelectorAll('[data-tool] span')].map(node => node.textContent), ['画笔', '箭头', '直线', '矩形']);
  assert.deepEqual([...groups[1].querySelectorAll('[data-tool] span')].map(node => node.textContent), ['点批注', '框批注']);
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

  // 长说明在帮助里，底栏不再放提示长句。
  assert.equal(h.q('.ie-footer-hint'), null, '底栏只留短状态与缩放');
  assert.equal(h.q('.ie-help').hidden, true, '帮助默认收起');
  h.click(h.q('[data-action="help-toggle"]'));
  assert.equal(h.q('.ie-help').hidden, false, '帮助可展开');
  assert.match(h.q('.ie-help').textContent, /空格|滚轮/, '帮助里写清操作');
  assert.equal(h.q('[data-action="help-toggle"]').getAttribute('aria-expanded'), 'true');
  h.window.emit('keydown', { key: 'Escape', target: h.q('.ie-scroll'), preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(h.q('.ie-help').hidden, true, 'Esc 收起帮助');
});

test('批注表单在右栏：编辑时展开、完成或取消后收起，全程不放进画布也不按画布坐标定位', async () => {
  const h = harness();
  await h.open();
  assert.equal(h.panel().hidden, true, '没有批注时右栏收起');
  h.tool('region');
  h.drag(at(40, 40), at(120, 120));
  assert.equal(h.panel().hidden, false, '画完就展开右栏');
  assert.equal(h.note().hidden, false);
  assert.equal(h.q('.ie-workspace').contains(h.panel()), false, '面板不在画布里');
  assert.equal(h.panel().style.left, undefined);
  assert.equal(h.panel().style.top, undefined);
  assert.equal(h.note().style.left, undefined, '表单不再算画布坐标');
  h.type('右栏写意见');
  h.save();
  assert.equal(h.panel().hidden, true, '完成后收起');
  assert.equal(h.editor.hasEdits, true);
});

test('直接调框：选中目标后拖框内/拖手柄，点「完成批注」一次保存；取消恢复原几何与文字', async () => {
  const h = harness();
  await h.open();
  h.tool('region');
  h.drag(at(40, 40), at(120, 120));
  h.type('原始文字');
  h.save();
  const id = h.q('.ie-marker').dataset.annotationId;

  // 重新打开：默认选中这块框，直接拖框内就能移动。
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"]`));
  assert.equal(h.qa('[data-action="target-frame"]')[0].getAttribute('aria-pressed'), 'true', '打开即选中 A 框');
  h.drag(at(80, 80), at(100, 100));
  assert.deepEqual(h.chips(), ['框 (60, 60, 80, 80)'], '拖框内直接移动，无需中间确认');
  // 再拖右下角手柄缩放。
  h.drag(at(140, 140), at(160, 160));
  assert.deepEqual(h.chips(), ['框 (60, 60, 100, 100)'], '拖手柄直接缩放');
  h.save();
  assert.deepEqual((await h.notes())[0].rect, { x: 60, y: 60, width: 100, height: 100 }, '一次「完成批注」就保存');

  // 取消：几何与文字都回到上次保存的样子。
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"]`));
  h.drag(at(110, 110), at(150, 150));
  const field = h.field();
  field.value = '不要这句';
  h.root.emit('input', { target: field });
  h.cancel();
  h.click(h.q(`.ie-marker[data-annotation-id="${id}"]`));
  assert.deepEqual(h.chips(), ['框 (60, 60, 100, 100)'], '取消后几何回原样');
  assert.equal(h.field().value, '原始文字', '取消后文字回原文');
});

test('收起面板不丢草稿，底栏「继续编辑」回来；收起不替用户保存', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(80, 80));
  h.type('还没写完');
  assert.equal(h.panel().hidden, false);

  h.click(h.q('[data-action="panel-collapse"]'));
  assert.equal(h.panel().hidden, true, '收起后不占画布');
  assert.equal(h.editor.hasEdits, false, '收起不写历史、不静默保存');
  const resume = h.q('[data-action="panel-resume"]');
  assert.equal(resume.hidden, false, '底栏露出继续编辑入口');
  assert.match(resume.textContent, /继续编辑/);
  assert.match(h.q('.ie-status').textContent, /草稿还在/);

  h.click(resume);
  assert.equal(h.panel().hidden, false, '能回到面板');
  assert.equal(h.note().hidden, false);
  assert.equal(h.field().value, '还没写完', '草稿文字没丢');
  assert.equal(resume.hidden, true, '回到面板后收起入口');
  h.save();
  assert.deepEqual((await h.notes()).map(item => item.text), ['还没写完']);

  // 收起后直接点保存/复制：那是用户明确要留，既有「有字就存」语义不变。
  h.tool('point');
  h.drag(at(200, 200));
  h.type('收起后导出也要留');
  h.click(h.q('[data-action="panel-collapse"]'));
  assert.equal(h.editor.hasEdits, true, '前一条已保存，但这一条草稿还没进历史');
  await h.editor.exportPNG();
  assert.deepEqual((await h.notes()).map(item => item.text).sort(), ['收起后导出也要留', '还没写完'].sort());
});

test('补充说明也用右栏，不覆盖画布；关掉后右栏一起收起', async () => {
  const h = harness();
  await h.open();
  h.click(h.q('[data-action="comment"]'));
  assert.equal(h.panel().hidden, false);
  assert.equal(h.q('.ie-comment-bubble').hidden, false);
  assert.equal(h.q('.ie-workspace').contains(h.q('.ie-comment-bubble')), false, '说明框在右栏不在画布');
  const field = h.q('.ie-comment');
  field.value = '整体没问题';
  h.root.emit('input', { target: field });
  h.click(h.q('[data-action="comment-close"]'));
  assert.equal(h.panel().hidden, true, '说明关掉后右栏收起');
  assert.match((await h.copy()).comment, /整体没问题/);
});

test('新建/重开批注先显示右栏再聚焦；同一份草稿的同步不抢焦点', async () => {
  const h = harness();
  await h.open();
  const field = h.field();
  const seen = [];
  const original = field.focus;
  // 真浏览器里 display:none 祖先下的 focus 不生效：这里记录调用瞬间面板的显隐。
  field.focus = function (...args) {
    seen.push({ panelHidden: h.panel().hidden, noteHidden: h.note().hidden, inside: h.note().contains(this) });
    return original.apply(this, args);
  };

  h.tool('point');
  h.drag(at(80, 80));
  assert.equal(seen.length, 1, '新建点批注只聚焦一次');
  assert.deepEqual(seen[0], { panelHidden: false, noteHidden: false, inside: true }, '聚焦时面板已经显示');
  assert.equal(h.dom.document.activeElement, field, '真实 activeElement 落在意见框');

  // 同一份草稿再走一次完整 sync（忙碌开关会调 syncBubble）：不重聚焦、不改值。
  h.q('.ie-scroll').focus();
  h.editor.setBusy(false);
  h.dom.flushFrames();
  assert.equal(seen.length, 1, '同一草稿的同步不重复聚焦');
  assert.equal(h.dom.document.activeElement, h.q('.ie-scroll'), '焦点没有被抢回面板');

  // 保存后点编号重开：换绑到另一条时再聚焦一次，仍在面板显示之后。
  h.type('写一句');
  h.save();
  assert.equal(h.panel().hidden, true);
  h.q('.ie-scroll').focus();
  h.click(h.q('.ie-marker'));
  assert.equal(seen.length, 2, '重开旧批注聚焦一次');
  assert.deepEqual(seen[1], { panelHidden: false, noteHidden: false, inside: true });
  assert.equal(h.dom.document.activeElement, field);
  assert.equal(field.value, '写一句');
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
  assert.deepEqual([...h.q('.ie-exports').children].map(node => node.dataset.action), ['save-as', 'save', 'copy'], '输出顺序与映射不变');
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
  assert.equal(h.panel().hidden, true, '补充说明面板不展开');
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

test('进预览前先把开着的气泡按保存处理，不静默丢字', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(50, 50));
  h.type('这句要留下');
  assert.equal(h.editor.hasEdits, false, '草稿还没进历史');
  assert.equal(h.editor.setPreviewMode(true), true);
  assert.equal(h.editor.hasEdits, true, '进预览前已写进历史');
  assert.equal(h.note().hidden, true, '面板收起');
  assert.deepEqual((await h.notes()).map(item => item.text), ['这句要留下']);
  assert.equal(h.editor.previewMode, true);
});

test('预览 Esc 只申请退出；编辑态末端 Esc 回同窗预览而不是关窗', async () => {
  const calls = [];
  const h = harness({ onExitRequest: () => { calls.push('exit'); return true; }, onPreviewRequest: () => { calls.push('preview'); return true; } });
  await h.open();
  h.tool('point'); h.drag(at(60, 60)); h.type('草稿');
  h.key('Escape');
  assert.deepEqual(calls, [], '第一下只取消草稿');
  assert.equal(h.editor.hasEdits, false);
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
  const after = (x, y) => ({ x: Math.max(16, (400 - 120 * zoom) / 2) + x * zoom, y: 16 + y * zoom });
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
  assert.equal(button.textContent, '选择', '按钮文字保持短字');
  assert.match(button.getAttribute('title'), /选择\/调整/, 'title 写明选择/调整');
  h.tool('select');
  assert.match(h.q('.ie-options').textContent, /选择\/调整/, '属性行也说清楚');
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
  const viewScreen = (x, y) => ({ x: Math.max(16, (400 - 200 * zoom) / 2) + x * zoom, y: 16 + y * zoom });
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
