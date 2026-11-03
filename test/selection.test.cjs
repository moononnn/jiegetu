'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function harness({ viewport, failOnce = false, cancelOnce = false, diagnostic = false, decodeFails = false, previewGate, previewDecodeFails = false, scrollFails = false, scrollCanceled = false, fullPreviewFails = false, fullPreviewGate, editSourceFails = false, editSourceGate, editStateFails = null, editStateGate = null, openFails = false, exportFails = false, clipboardFails = false, commitGate, mode = 'single', frame, screens, withRecognizeText = false, recordFails = false, recordCanceled = false, recordGate, exitKept = false, exitFails = false, exitGate } = {}) {
  const listeners = new Map(), windowListeners = new Map();
  const captures = new Set();
  const commits = [];
  let cancels = 0;
  let completeScroll;
  const recognizePayloads = [];
  const scrolls = [], traces = [], cancelReasons = [], editSources = [], editStates = [], records = [], exits = [], previews = [];
  let emitEditorPreview = () => {};
  const nodes = Object.fromEntries(['desktop', 'box', 'veil', 'hint', 'actions', 'save', 'save-as', 'copy', 'edit', 'record-gif', 'long-preview', 'retake', 'image-viewer', 'viewer-scroll', 'viewer-image', 'viewer-close', 'zoom-in', 'zoom-out', 'zoom-fit', 'zoom-original', 'zoom-label', 'viewer-status'].map(id => [id, {
    hidden: ['box', 'actions', 'image-viewer', 'retake'].includes(id), style: {}, textContent: '', disabled: false,
    clientWidth: 900, clientHeight: 600, scrollLeft: 0, scrollTop: 0, focus() { this.focused = true; },
    offsetWidth: 236, offsetHeight: 54, naturalWidth: 2000, naturalHeight: 1600,
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id), releasePointerCapture: id => captures.delete(id),
    setAttribute(key,value) { this[key] = value; }, classList: { toggle() {} },
    decode: async () => {}, addEventListener(type, fn) { this[type] = fn; }
  }]));
  nodes['long-preview'].decode = async () => { if (previewGate) await previewGate; if (previewDecodeFails) throw new Error('SECRET_PREVIEW_ERROR'); };
  const previewTokens = [], fullRequests = [];
  if (decodeFails) nodes.desktop.decode = async () => { throw new Error('SECRET_IMAGE_ERROR'); };
  nodes.actions.contains = target => [nodes.actions, nodes.save, nodes['save-as'], nodes.copy, nodes.edit, nodes.retake, nodes['record-gif']].includes(target);
  nodes['image-viewer'].contains = target => ['image-viewer','viewer-scroll','viewer-image','viewer-close','zoom-in','zoom-out','zoom-fit','zoom-original'].some(id => target === nodes[id]);
  const document = { querySelector: selector => nodes[selector.slice(1)], title: '截个图 · 框选截图',
    addEventListener(type, fn) { listeners.set(type, fn); },
    body: { style: {}, classList: { classes: new Set(), add(name) { this.classes.add(name); }, remove(name) { this.classes.delete(name); },
      toggle(name, force) { const on = force === undefined ? !this.classes.has(name) : Boolean(force); if (on) this.classes.add(name); else this.classes.delete(name); return on; } },
      setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id),
      releasePointerCapture: id => captures.delete(id) } };
  const selection = { init: async () => (mode === 'desktop' ? { mode: 'desktop', frame, screens, dataUrl: 'test' } : { dataUrl: 'test' }), ready: async () => {},
    beginScroll: async rect => { scrolls.push(rect); if (scrollFails) throw new Error('选区预检失败'); return scrollCanceled?{started:false,canceled:true}:{ started: true }; },
    beginRecord: async rect => { records.push({ ...rect }); if (recordGate) await recordGate; if (recordFails) throw new Error('录制预检失败'); return recordCanceled?{started:false,canceled:true}:{ started: true }; },
    onScrollComplete: fn => { completeScroll = fn; },
    previewReady: async token => { previewTokens.push(token); return true; },
    previewImage: async token => { fullRequests.push(token); if (fullPreviewGate) await fullPreviewGate; if (fullPreviewFails) throw new Error('原图读取失败'); return { dataUrl: 'full-resolution', width: 751, height: 6766 }; },
    editSource: async (rect, longToken, warning) => { editSources.push({rect:{...rect},longToken,warning}); if(editSourceGate)await editSourceGate; if(editSourceFails)throw new Error('编辑来源不可用'); return {token:'edit-owned',width:longToken?751:Math.round(rect.width*2),height:longToken?6766:Math.round(rect.height*2)}; },
    editState: async (token, action) => { editStates.push({token,action}); if (editStateGate && action === 'close') await editStateGate; if (editStateFails === action) throw new Error('窗口形态切换失败'); return true; },
    onEditorPreview: callback => { emitEditorPreview = callback; },
    requestExit: async (token, source) => { exits.push({ token, source }); if (exitGate) await exitGate; if (exitFails) throw new Error('退出确认失败'); return !exitKept; },
    commit: async (rect, action, longToken, edited) => {
      commits.push({ rect: JSON.parse(JSON.stringify(rect)), action, ...(longToken ? { longToken } : {}), ...(edited?{edited}: {}) });
      if (commitGate) await commitGate;
      if (cancelOnce && commits.length === 1) return { ok: false, canceled: true, errors: [] };
      if (failOnce && commits.length === 1) return { ok: false, errors: ['暂时失败'] };
      return { ok: true };
    }, cancel: async reason => { cancels++; cancelReasons.push(reason); } };
  if (diagnostic) selection.diagnostic = async (event, fields) => { traces.push({ event, fields }); return true; };
  if (withRecognizeText) selection.recognizeText = async payload => { recognizePayloads.push(payload); return { text: '识别文字', language: 'zh-Hans-CN' }; };
  // 视口尺寸用 getter 暴露，测试可以改视口再触发 resize（真实窗口定型/屏幕重置）。
  const view = { width: viewport?.width ?? 1000, height: viewport?.height ?? 800 };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../renderer/selection.js'), 'utf8'),
    { document, window: { selection, requestAnimationFrame: fn => queueMicrotask(fn), addEventListener: (type, fn) => windowListeners.set(type, fn) },
      get innerWidth() { return view.width; }, get innerHeight() { return view.height; } });
  await tick();
  const emit = (type, values = {}) => listeners.get(type)({ button: 0, pointerId: 1, clientX: 0, clientY: 0,
    target: nodes.desktop, preventDefault() {}, ...values });
  const drag = (x, y, endX, endY) => {
    emit('pointerdown', { clientX: x, clientY: y });
    emit('pointermove', { clientX: endX, clientY: endY });
    emit('pointerup', { clientX: endX, clientY: endY });
  };
  const emitViewport = (type, values = {}) => nodes['viewer-scroll'][type]?.({ button: 0, buttons: 1, pointerId: 8, clientX: 100, clientY: 200,
    target: nodes['viewer-image'], preventDefault() {}, ...values });
  return { nodes, commits, scrolls, traces, cancelReasons, editSources, editStates, records, exits, previews, title: () => document.title, editorOptions: () => undefined, recognizePayloads, previewTokens, fullRequests, emitViewport, blur: () => windowListeners.get('blur')?.(), cursor: () => document.body.style.cursor, completeScroll: result => completeScroll(result), cancels: () => cancels, emit, drag,
    // 主进程从编辑窗交回预览时推给本页的缩略图/输出尺寸（真实通道是 shot:editor-preview）。
    editorPreview: payload => { previews.push(payload); emitEditorPreview(payload); },
    resizeTo: (width, height) => { view.width = width; view.height = height; windowListeners.get('resize')?.(); },
    bodyClasses: () => [...document.body.classList.classes] };
}

test('固定顶底栏、横线与更多菜单均已从页面撤除，普通框选长截提示的选择器仍生效', () => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/selection.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../renderer/selection.css'), 'utf8');
  for (const id of ['selection-more', 'selection-more-toggle', 'fixed-bands', 'confirm-bands', 'scroll-guides', 'content-top', 'content-bottom']) {
    assert.equal(html.includes(`id="${id}"`), false, id);
  }
  assert.equal(/selection-more|fixed-bands|confirm-bands|scroll-guide|content-top|content-bottom/.test(css), false);
  // 横线 DOM 删掉后，:has(#scroll-guides[hidden]) 永远不成立，必须改选择器否则普通框选看不到长截图提示。
  const rules = css.split('\n').filter(line => line.includes('#long-capture-tip{display:block}'));
  assert.equal(rules.length, 1);
  assert.ok(rules[0].startsWith('body:has(#box:not([hidden])):has(#actions:not([hidden]))'));
  assert.equal(rules[0].includes('scroll-guides'), false);
});
test('普通框选滚轮直接开启长截图，只传选区、不传手动正文范围', async () => {
  const h = await harness(); h.drag(100, 100, 500, 700);
  await h.emit('wheel', { deltaY: 100, clientX: 300, clientY: 300 });
  assert.equal(h.scrolls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.scrolls[0])), { x: 100, y: 100, width: 400, height: 600 });
});
test('长截图启动被拒后仍是普通空白框选，不要求确认范围也不残留横线', async () => {
  const h = await harness({ scrollFails: true }); h.drag(100, 100, 500, 700);
  await h.emit('wheel', { deltaY: 100, clientX: 300, clientY: 300 });
  assert.match(h.nodes.hint.textContent, /预检失败/);
  assert.equal(h.nodes.copy.disabled, false);
  await h.emit('wheel', { deltaY: 100, clientX: 300, clientY: 300 });
  assert.equal(h.scrolls.length, 2);
});
test('光标基线：开始长截图即改普通箭头，不把框选十字带到采集中', async () => {
  const h = await harness(); h.drag(10, 20, 300, 200);
  await h.emit('wheel', { deltaY: 100, clientX: 100, clientY: 100 });
  assert.equal(h.cursor(), 'default');
});

test('长截图预检被拒后恢复选框光标并保留普通截图操作', async () => {
  const h = await harness({ scrollFails: true }); h.drag(10, 20, 300, 200);
  await h.emit('wheel', { deltaY: 100, clientX: 100, clientY: 100 });
  assert.equal(h.cursor(), 'move'); assert.equal(h.nodes.copy.disabled, false);
  assert.match(h.nodes.hint.textContent, /预检失败/); assert.equal(h.cancels(), 0);
});

test('残留基线：没有活动拖动时的pointercancel不清掉已固定选框或错误提示', async () => {
  const h = await harness(); h.drag(10, 20, 210, 220);
  const before = h.nodes.hint.textContent;
  h.emit('pointercancel');
  assert.equal(h.nodes.hint.textContent, before);
  assert.equal(h.nodes.actions.hidden, false);
});

test('底图解码失败记录固定阶段代码，以失败收回而非误报用户取消', async () => {
  const h = await harness({ diagnostic: true, decodeFails: true });
  assert.deepEqual(h.cancelReasons, ['failed']);
  assert.equal(h.traces[0].event, 'renderer-error');
  assert.equal(h.traces[0].fields.errorCode, 'image-decode');
  assert.doesNotMatch(JSON.stringify(h.traces), /SECRET_IMAGE_ERROR/);
  assert.equal(h.commits.length, 0);
});

test('诊断区分收到滚轮与符合启动条件，不记录坐标或滚轮原值', async () => {
  const h = await harness({ diagnostic: true });
  await h.emit('wheel', { deltaY: 120, clientX: 200, clientY: 200 });
  h.drag(100, 100, 400, 300);
  await h.emit('wheel', { deltaY: 120, clientX: 800, clientY: 700 });
  await h.emit('wheel', { deltaY: 120, clientX: 200, clientY: 200 });
  const wheels = h.traces.filter(row => row.event === 'wheel');
  assert.deepEqual(wheels.map(row => row.fields.accepted), [false, false, true]);
  assert.equal(h.scrolls.length, 1); assert.equal(h.commits.length, 0);
  assert.equal(h.traces.find(row => row.event === 'selection-input').fields.width, 300);
  assert.doesNotMatch(JSON.stringify(h.traces), /deltaY|clientX|clientY|dataUrl|fingerprint/);
});

for (const [name, start, end, expected] of [
  ['左边', [100, 200], [80, 200], { x: 80, y: 100, width: 320, height: 200 }],
  ['右边', [400, 200], [450, 200], { x: 100, y: 100, width: 350, height: 200 }],
  ['上边', [250, 100], [250, 70], { x: 100, y: 70, width: 300, height: 230 }],
  ['下边', [250, 300], [250, 350], { x: 100, y: 100, width: 300, height: 250 }],
  ['左上角', [100, 100], [80, 70], { x: 80, y: 70, width: 320, height: 230 }],
  ['右上角', [400, 100], [450, 70], { x: 100, y: 70, width: 350, height: 230 }],
  ['左下角', [100, 300], [80, 350], { x: 80, y: 100, width: 320, height: 250 }],
  ['右下角', [400, 300], [450, 350], { x: 100, y: 100, width: 350, height: 250 }]
]) test(`固定框可从${name}缩放，松手不写出`, async () => {
  const h = await harness(); h.drag(100, 100, 400, 300); h.drag(...start, ...end);
  assert.equal(h.commits.length, 0); await h.nodes.copy.click();
  assert.deepEqual(h.commits[0].rect, expected);
});
test('框内拖动搬移选区且尺寸保持，超出屏幕时夹在边界', async () => {
  const h = await harness(); h.drag(100, 100, 400, 300); h.drag(200, 200, 999, 799);
  await h.nodes.copy.click();
  assert.deepEqual(h.commits[0].rect, { x: 700, y: 600, width: 300, height: 200 });
});
for (const [width, height] of [[12, 12], [12, 80], [80, 12], [2, 2]]) test(`小尺寸 ${width}×${height} 选框中心仍可移动，不被边缘抢走`, async () => {
  const h = await harness(); h.drag(100, 100, 100 + width, 100 + height);
  h.drag(100 + width / 2, 100 + height / 2, 200 + width / 2, 200 + height / 2);
  await h.nodes.copy.click();
  assert.deepEqual(h.commits[0].rect, { x: 200, y: 200, width, height });
});
test('缩小不能反转选框或产生负尺寸，右键恢复初始状态', async () => {
  const h = await harness(); h.drag(100, 100, 400, 300); h.drag(100, 200, 600, 200);
  assert.equal(h.nodes.box.style.width, '2px');
  h.emit('contextmenu');
  assert.equal(h.nodes.hint.textContent, '拖动框选 · Esc 退出');
  assert.equal(h.nodes.box.hidden, true); assert.equal(h.nodes.actions.hidden, true);
  h.drag(50, 60, 200, 220); await h.nodes.copy.click();
  assert.deepEqual(h.commits[0].rect, { x: 50, y: 60, width: 150, height: 160 });
});
test('松手只固定选框，不调用保存／复制', async () => {
  const h = await harness();
  h.drag(10, 20, 300, 200);
  await tick();
  assert.equal(h.commits.length, 0);
  assert.equal(h.nodes.box.hidden, false);
  assert.equal(h.nodes.actions.hidden, false);
  assert.match(h.nodes.hint.textContent, /回车复制并退出/);
});
test('随时重框，点确认只提交最后一个选框', async () => {
  const h = await harness();
  h.drag(10, 20, 300, 200);
  h.drag(500, 400, 200, 100);
  assert.equal(h.commits.length, 0);
  // 操作按钮的按下事件不得被当成重新框选。
  h.emit('pointerdown', { target: h.nodes.copy });
  await h.nodes.copy.click();
  assert.deepEqual(h.commits, [{ rect: { x: 200, y: 100, width: 300, height: 300 }, action: 'copy' }]);
});
test('第一次右键只清框，第二次右键才退出', async () => {
  const h = await harness();
  h.drag(10, 20, 300, 200);
  h.emit('contextmenu');
  assert.equal(h.cancels(), 0);
  assert.equal(h.nodes.box.hidden, true);
  assert.equal(h.nodes.actions.hidden, true);
  h.emit('contextmenu');
  assert.equal(h.cancels(), 1);
  assert.equal(h.commits.length, 0);
});
test('拖动中右键清框，之后左键松开不得提交或复活旧框', async () => {
  const h = await harness();
  h.emit('pointerdown', { clientX: 10, clientY: 20 });
  h.emit('pointermove', { clientX: 100, clientY: 100 });
  h.emit('contextmenu');
  h.emit('pointerup', { clientX: 100, clientY: 100 });
  assert.equal(h.nodes.box.hidden, true);
  assert.equal(h.commits.length, 0);
  assert.equal(h.cancels(), 0);
});
test('回车需有效固定框，连续回车和确认只提交一次', async () => {
  const h = await harness();
  h.emit('keydown', { key: 'Enter' });
  assert.equal(h.commits.length, 0);
  h.drag(10, 20, 100, 100);
  h.emit('keydown', { key: 'Enter' });
  h.emit('keydown', { key: 'Enter' });
  await h.nodes.copy.click();
  assert.equal(h.commits.length, 1);
  assert.equal(h.commits[0].action, 'copy');
});
test('保存按钮直接存到设置的文件夹，另存按钮每次都问位置', async () => {
  const h = await harness();
  h.drag(10, 20, 100, 100);
  h.emit('pointerdown', { target: h.nodes.save });
  await h.nodes.save.click();
  assert.equal(h.commits.length, 1);
  assert.equal(h.commits[0].action, 'save-quick', '直接保存不弹另存框');
});
test('另存按钮每次都问位置，走弹框那条', async () => {
  const h = await harness();
  h.drag(10, 20, 100, 100);
  h.emit('pointerdown', { target: h.nodes['save-as'] });
  await h.nodes['save-as'].click();
  assert.equal(h.commits.length, 1);
  assert.equal(h.commits[0].action, 'save');
});
test('失败后保留框和两个按钮，可改选另一动作', async () => {
  const h = await harness({ failOnce: true });
  h.drag(10, 20, 100, 100);
  await h.nodes.copy.click();
  assert.equal(h.nodes.box.hidden, false);
  assert.equal(h.nodes.copy.disabled, false);
  assert.equal(h.nodes.save.disabled, false);
  assert.match(h.nodes.hint.textContent, /暂时失败/);
  await h.nodes.save.click();
  assert.deepEqual(h.commits.map(item => item.action), ['copy', 'save-quick']);
});
test('取消另存为显示非错误提示，按钮恢复且可以改选复制', async () => {
  const h = await harness({ cancelOnce: true });
  h.drag(10, 20, 100, 100);
  await h.nodes['save-as'].click();
  assert.equal(h.nodes.box.hidden, false);
  assert.equal(h.nodes.copy.disabled, false);
  assert.equal(h.nodes.save.disabled, false);
  assert.match(h.nodes.hint.textContent, /已取消保存/);
  assert.doesNotMatch(h.nodes.hint.textContent, /未完成/);
  await h.nodes.copy.click();
  assert.deepEqual(h.commits.map(item => item.action), ['save', 'copy']);
});
test('框内向下滚轮启动长截图但不写出，完成后提交完整长图 token', async () => {
  const h = await harness();
  h.drag(10, 20, 300, 200);
  await h.emit('wheel', { deltaY: 100, clientX: 100, clientY: 100 });
  assert.equal(h.scrolls.length, 1);
  assert.equal(h.commits.length, 0);
  await h.completeScroll({ ok: true, token: 'long-token', width: 580, height: 1800, preview: 'data:test' });
  assert.deepEqual(h.previewTokens, ['long-token']); assert.equal(h.cursor(), 'default');
  h.emit('pointermove'); assert.equal(h.cursor(), 'default');
  assert.equal(h.nodes['long-preview'].hidden, false);
  await h.nodes.copy.click();
  assert.equal(h.commits[0].longToken, 'long-token');
});
test('长图原图预览里复制：提交一开始就把“正在复制…”同步到 viewer-status，并禁用按钮', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = await harness({ commitGate: gate });
  h.drag(10, 20, 300, 200);
  await h.completeScroll({ ok: true, token: 'long-token', width: 751, height: 6766, preview: 'thumbnail' });
  h.emit('pointerdown', { clientX: 100, clientY: 100 }); await tick();
  assert.equal(h.nodes['image-viewer'].hidden, false, '前置：原图预览已打开');
  assert.doesNotMatch(h.nodes['viewer-status'].textContent, /正在复制/);
  const clicking = h.nodes.copy.click();
  await tick();
  assert.equal(h.nodes.hint.textContent, '正在复制…');
  assert.equal(h.nodes['viewer-status'].textContent, '正在复制…', '用户正在看的原图预览必须同步“正在复制…”');
  assert.equal(h.nodes.copy.disabled, true);
  assert.equal(h.nodes.save.disabled, true);
  assert.equal(h.nodes['save-as'].disabled, true);
  release(); await clicking;
  assert.equal(h.commits.length, 1);
  assert.equal(h.commits[0].action, 'copy');
});
test('完成图只接受明确重新框选，失焦或右键不清图不复制，诊断区分是否执行',async()=>{
 for(const source of ['retake','context-menu']){
  const h=await harness({diagnostic:true,exitKept:source==='context-menu'});h.drag(10,20,300,200);
  await h.completeScroll({ok:true,token:'long-token',width:580,height:1800,preview:'data:test'});
  h.blur();assert.equal(h.nodes['long-preview'].hidden,false);assert.equal(h.cancels(),0);assert.equal(h.commits.length,0);
  if(source==='retake')h.nodes.retake.click();else h.emit('contextmenu');
  const row=h.traces.find(x=>x.event==='selection-dismiss');assert.equal(row.fields.dismissSource,source);assert.equal(row.fields.hasLongImage,true);
  assert.equal(row.fields.accepted,source==='retake');assert.equal(h.nodes['long-preview'].hidden,source==='retake');assert.equal(h.cancels(),0);
  if(source==='context-menu'){
    assert.deepEqual(h.exits,[{token:'long-token',source:'context-menu'}],'右键改成申请一次确认，不再被忽略');
    await tick();assert.equal(h.nodes.copy.disabled,false,'保留后按钮解锁');
    await h.nodes.copy.click();assert.equal(h.commits[0].longToken,'long-token','右键之后仍能复制原长图');
  }
 }
});
test('缩略图 Esc 走同一退出确认，不再直接取消也不触发复制',async()=>{
 const h=await harness({exitKept:true});h.drag(10,20,300,200);await h.completeScroll({ok:true,token:'long-token',width:580,height:1800,preview:'data:test'});
 h.emit('keydown',{key:'Escape'});await tick();
 assert.deepEqual(h.exits,[{token:'long-token',source:'escape-key'}]);
 assert.equal(h.cancels(),0,'确认前不发 shot:cancel');assert.equal(h.commits.length,0);
 assert.equal(h.nodes['long-preview'].hidden,false,'保留后成图预览还在');
});

// —— 成图退出：右键 / Esc 都先申请一次带确认的退出，保留时什么都不丢 ——
test('成图右键申请超时或失败只报错，成图与批注仍保留且可继续输出',async()=>{
 const h=await harness({exitFails:true});h.drag(10,20,300,200);
 await h.completeScroll({ok:true,token:'long-token',width:580,height:1800,preview:'data:test'});
 h.emit('contextmenu');await tick();
 assert.equal(h.exits.length,1);assert.equal(h.cancels(),0);assert.equal(h.commits.length,0);
 assert.match(h.nodes.hint.textContent,/退出没能确认/);assert.match(h.nodes.hint.textContent,/仍保留/);
 assert.equal(h.nodes.copy.disabled,false,'失败也解锁');
 await h.nodes.copy.click();assert.equal(h.commits[0].longToken,'long-token');
});
test('编辑稿（已回到预览）右键也走确认，不丢草稿也不重新框选',async()=>{
 const h=await harness({exitKept:true});h.drag(10,20,300,200);await h.nodes.edit.click();
 h.editorPreview({token:'edit-owned',thumbnail:'data:image/png;base64,edited-thumbnail',outputSize:{width:300,height:200}});
 h.emit('contextmenu');await tick();
 assert.deepEqual(h.exits,[{token:'edit-owned',source:'context-menu'}]);
 assert.equal(h.cancels(),0);assert.equal(h.commits.length,0);
 assert.equal(h.nodes['long-preview'].hidden,false,'编辑保留的缩略图还在');
 assert.equal(h.editStates.filter(x=>x.action==='discard').length,0,'不丢会话也不释放编辑');
 await h.nodes.copy.click();assert.equal(h.commits.length,1,'保留后仍可保存当前标注');
});
test('退出确认期间锁住按钮与手势：不重弹、不重框、不提交、不重开编辑',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});
 const h=await harness({exitKept:true,exitGate:gate});h.drag(10,20,300,200);
 await h.completeScroll({ok:true,token:'long-token',width:580,height:1800,preview:'data:test'});
 h.emit('contextmenu');
 const hint=h.nodes.hint.textContent;
 assert.equal(h.nodes.copy.disabled,true);assert.equal(h.nodes.save.disabled,true);assert.equal(h.nodes.edit.disabled,true);
 h.emit('contextmenu');h.emit('keydown',{key:'Escape'});
 assert.equal(h.exits.length,1,'确认中的右键/Esc 不重复申请');
 h.drag(30,40,200,300);assert.equal(h.nodes.box.hidden,true,'确认中不能重新框选');
 await h.nodes.copy.click();await h.nodes.edit.click();assert.equal(h.commits.length,0);assert.equal(h.editSources.length,0);
 release();await tick();await tick();
 assert.equal(h.nodes.copy.disabled,false,'结果回来解锁');assert.equal(h.nodes.edit.disabled,false);
 assert.notEqual(h.nodes.hint.textContent,hint,'保留后会给一句保留提示');
 assert.match(h.nodes.hint.textContent,/已保留成图与批注/);
 await h.nodes.copy.click();assert.equal(h.commits.length,1);assert.equal(h.commits[0].rect.width,290);
});
test('原图预览里的 Esc 仍只关预览，关掉后再次 Esc 才申请退出',async()=>{
 const h=await harness({exitKept:true});h.drag(10,20,300,200);
 await h.completeScroll({ok:true,token:'long-token',width:580,height:1800,preview:'data:test'});
 h.emit('pointerdown',{clientX:100,clientY:100});await tick();
 assert.equal(h.nodes['image-viewer'].hidden,false);
 h.emit('keydown',{key:'Escape'});
 assert.equal(h.nodes['image-viewer'].hidden,true);assert.equal(h.exits.length,0,'预览 Esc 不申请退出');
 h.emit('keydown',{key:'Escape'});await tick();
 assert.deepEqual(h.exits,[{token:'long-token',source:'escape-key'}]);
});
test('编辑窗口开着时本页不接键盘：不会因本页 Esc 而申请退出',async()=>{
 const h=await harness();h.drag(10,20,300,200);await h.nodes.edit.click();
 assert.equal(h.editorOpenNow?.(),undefined,'本页没有编辑器实例');
 assert.equal(h.editSources.length,1,'已交给独立编辑窗');
 assert.equal(h.exits.length,0);
});
test('无浮条确认返回只恢复框选操作，不记计算失败且可再次开始',async()=>{
 const h=await harness({scrollCanceled:true,diagnostic:true});h.drag(10,20,300,200);
 for(let i=1;i<=2;i++){h.emit('wheel',{clientX:100,clientY:100,deltaY:30});await tick();assert.equal(h.scrolls.length,i);assert.match(h.nodes.hint.textContent,/已返回框选/);assert.equal(h.nodes.copy.disabled,false);}
 assert.equal(h.traces.some(x=>x.event==='worker-error'),false);assert.equal(h.cancels(),0);
});
test('完成长图缩略图恢复周边暗幕，隐藏选框而不遮住缩略图',async()=>{
 const h=await harness();h.drag(10,20,300,200);assert.equal(h.nodes.veil.hidden,true);
 await h.completeScroll({ok:true,token:'long-token',width:580,height:1800,preview:'data:test'});
 assert.equal(h.nodes.veil.hidden,false);assert.equal(h.nodes.box.hidden,true);assert.equal(h.nodes['long-preview'].hidden,false);
 h.emit('pointerdown',{clientX:100,clientY:100,target:h.nodes['long-preview']});await tick();
 h.nodes['viewer-close'].click();assert.equal(h.nodes.veil.hidden,false);assert.equal(h.nodes['long-preview'].hidden,false);
});
test('长图解码和布局确认前禁用保存复制，完成后才发送就绪确认', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = await harness({ previewGate: gate }); h.drag(10, 20, 300, 200);
  const pending = h.completeScroll({ ok: true, token: 'long-token', width: 580, height: 1800, preview: 'data:test' });
  assert.equal(h.nodes.save.disabled, true); assert.equal(h.nodes.copy.disabled, true);
  assert.deepEqual(h.previewTokens, []); await h.nodes.copy.click(); assert.equal(h.commits.length, 0);
  release(); await pending;
  assert.deepEqual(h.previewTokens, ['long-token']); assert.equal(h.nodes.copy.disabled, false);
});
test('缩略图解码失败只降级显示，保留完整长图与原图预览和复制入口', async () => {
  const h = await harness({ previewDecodeFails: true, diagnostic: true }); h.drag(10, 20, 300, 200);
  await h.completeScroll({ ok: true, token: 'long-token', width: 580, height: 1800, preview: 'data:test' });
  assert.deepEqual(h.previewTokens, ['long-token']); assert.deepEqual(h.cancelReasons, []);
  assert.equal(h.traces.at(-1).fields.errorCode, 'preview-decode');
  assert.doesNotMatch(JSON.stringify(h.traces), /SECRET_PREVIEW_ERROR/); assert.equal(h.commits.length, 0);
  assert.match(h.nodes.hint.textContent, /仍可保存或复制/);
  h.emit('pointerdown', { clientX: 100, clientY: 100 }); await tick();
  assert.equal(h.nodes['viewer-image'].src, 'full-resolution');
  await h.nodes.copy.click(); assert.equal(h.commits[0].longToken, 'long-token');
});

test('明确点重新框选后不带旧长图 token，仍能生成普通截图', async () => {
  const h = await harness();
  h.drag(10, 20, 300, 200);
  await h.completeScroll({ ok: true, token: 'long-token', width: 580, height: 1800, preview: 'data:test' });
  await h.nodes.retake.click();
  h.drag(30, 40, 100, 100);
  await h.nodes.copy.click();
  assert.equal(h.commits[0].longToken, undefined);
  assert.equal(h.nodes['long-preview'].hidden, true);
});
test('点击长图进入原图预览，缩放滚动和返回都不丢长图token', async () => {
  const h = await harness(); h.drag(10, 20, 300, 200);
  await h.completeScroll({ ok: true, token: 'long-token', width: 751, height: 6766, preview: 'thumbnail' });
  assert.deepEqual(h.fullRequests, [], '只看缩略图时不传输大原图');
  h.emit('pointerdown', { clientX: 100, clientY: 100, target: h.nodes['long-preview'] }); await tick();
  assert.deepEqual(h.fullRequests, ['long-token']);
  assert.equal(h.nodes['image-viewer'].hidden, false); assert.equal(h.nodes['viewer-image'].src, 'full-resolution');
  assert.equal(h.nodes['long-preview'].hidden, false);
  await h.nodes['zoom-original'].click(); assert.equal(h.nodes['viewer-image'].style.width, '751px');
  await h.nodes['zoom-in'].click(); assert.ok(parseFloat(h.nodes['viewer-image'].style.width) > 751);
  let trapped = false;
  h.emit('keydown', { key: 'Tab', target: h.nodes.copy, preventDefault() { trapped = true; } });
  assert.equal(trapped, true); assert.equal(h.nodes['zoom-out'].focused, true);
  h.emit('keydown', { key: 'Enter', target: h.nodes['zoom-original'] }); assert.equal(h.commits.length, 0);
  h.emit('wheel', { deltaY: 100, clientX: 100, clientY: 100, target: h.nodes['viewer-image'] });
  assert.equal(h.scrolls.length, 0, '预览滚轮不能重新启动长截图');
  h.emit('contextmenu', { target: h.nodes['viewer-image'] }); assert.equal(h.nodes['long-preview'].hidden, false);
  h.emit('keydown', { key: 'Escape' }); assert.equal(h.nodes['image-viewer'].hidden, true); assert.equal(h.cancels(), 0);
  await h.nodes.copy.click(); assert.equal(h.commits[0].longToken, 'long-token');
});
test('点长图外面不静默重框，原图读取失败仍可保存复制', async () => {
  const h = await harness({ fullPreviewFails: true }); h.drag(10, 20, 300, 200);
  await h.completeScroll({ ok: true, token: 'long-token', width: 751, height: 6766, preview: 'thumbnail' });
  h.emit('pointerdown', { clientX: 900, clientY: 700 }); assert.equal(h.nodes['long-preview'].hidden, false);
  h.emit('pointerdown', { clientX: 100, clientY: 100 }); await tick();
  assert.match(h.nodes['viewer-status'].textContent, /原图读取失败/); assert.equal(h.cancels(), 0);
  await h.nodes.save.click(); assert.equal(h.commits[0].longToken, 'long-token');
});
test('原图尚在读取时返回，不因迟到结果重开预览或丢掉成图', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = await harness({ fullPreviewGate: gate }); h.drag(10, 20, 300, 200);
  await h.completeScroll({ ok: true, token: 'long-token', width: 751, height: 6766, preview: 'thumbnail' });
  h.emit('pointerdown', { clientX: 100, clientY: 100 }); await h.nodes['viewer-close'].click(); release(); await tick();
  assert.equal(h.nodes['image-viewer'].hidden, true); await h.nodes.copy.click(); assert.equal(h.commits[0].longToken, 'long-token');
});
async function previewHarness() {
  const h = await harness(); h.drag(10, 20, 300, 200);
  await h.completeScroll({ ok: true, token: 'long-token', width: 751, height: 6766, preview: 'thumbnail' });
  h.emit('pointerdown', { clientX: 100, clientY: 100 }); await tick();
  h.nodes['viewer-scroll'].scrollLeft = 120; h.nodes['viewer-scroll'].scrollTop = 300;
  return h;
}
test('原图按住左键双轴拖动，异指针不串入，松手停止且不重框', async () => {
  const h = await previewHarness(), v = h.nodes['viewer-scroll'];
  h.emitViewport('pointerdown'); assert.equal(v.hasPointerCapture(8), true); assert.equal(v.style.cursor, 'grabbing');
  h.emitViewport('pointermove', { pointerId: 9, clientY: 0 }); assert.equal(v.scrollTop, 300);
  h.emitViewport('pointermove', { clientX: 40, clientY: 100 }); assert.equal(v.scrollLeft, 180); assert.equal(v.scrollTop, 400);
  h.emitViewport('pointermove', { clientX: 300, clientY: 600 }); assert.equal(v.scrollLeft, 0); assert.equal(v.scrollTop, 0);
  h.emitViewport('pointerup'); assert.equal(v.hasPointerCapture(8), false);
  h.emitViewport('pointermove', { clientY: 0 }); assert.equal(v.scrollTop, 0);
  assert.equal(h.nodes['image-viewer'].hidden, false); await h.nodes.copy.click(); assert.equal(h.commits[0].longToken, 'long-token');
});
for (const end of ['pointercancel','lostpointercapture','blur','buttons-up','right-only','zoom','close','retake']) test(`预览拖动遇到${end}立即释放，不留粘拖`, async () => {
  const h = await previewHarness(), v = h.nodes['viewer-scroll']; h.emitViewport('pointerdown'); assert.equal(v.hasPointerCapture(8), true);
  if (end === 'blur') h.blur();
  else if (end === 'buttons-up' || end === 'right-only') h.emitViewport('pointermove', { buttons: end === 'right-only' ? 2 : 0 });
  else if (end === 'zoom') h.nodes['zoom-in'].click();
  else if (end === 'close') h.nodes['viewer-close'].click();
  else if (end === 'retake') h.nodes.retake.click();
  else h.emitViewport(end);
  assert.equal(v.hasPointerCapture(8), false); assert.notEqual(v.style.cursor, 'grabbing');
  const top = v.scrollTop; h.emitViewport('pointermove', { clientY: 0 }); assert.equal(v.scrollTop, top);
});
test('只从图片左键启动拖动，滚动条空白、其他按钮及第二指针不抢手势', async () => {
  const h = await previewHarness(), v = h.nodes['viewer-scroll'];
  for (const input of [{button:1},{button:2},{isPrimary:false},{target:v},{target:h.nodes.save}]) {
    h.emitViewport('pointerdown', input); assert.equal(v.hasPointerCapture(8), false);
  }
  h.emitViewport('pointerdown'); h.emitViewport('pointerdown', {pointerId:9});
  assert.equal(v.hasPointerCapture(8), true); assert.equal(v.hasPointerCapture(9), false); h.emitViewport('pointerup');
});
test('预览普通滚轮保留原生滚动并释放拖动，Ctrl滚轮仍缩放而不重启截图', async () => {
  const h = await previewHarness(), v = h.nodes['viewer-scroll']; h.emitViewport('pointerdown'); assert.equal(v.hasPointerCapture(8), true); let prevented = false;
  h.emit('wheel', {deltaY:100,target:h.nodes['viewer-image'],preventDefault(){prevented=true}});
  assert.equal(prevented, false); assert.equal(v.hasPointerCapture(8), false);
  const width = parseFloat(h.nodes['viewer-image'].style.width);
  h.emit('wheel', {deltaY:-100,ctrlKey:true,target:h.nodes['viewer-image'],preventDefault(){prevented=true}});
  assert.equal(prevented, true); assert.ok(parseFloat(h.nodes['viewer-image'].style.width)>width); assert.equal(h.scrolls.length,0);
});
test('贴边选框的两个按钮仍在屏幕内', async () => {
  const h = await harness();
  h.drag(990, 790, 1000, 800);
  const x = parseFloat(h.nodes.actions.style.left);
  const y = parseFloat(h.nodes.actions.style.top);
  assert.ok(x >= 0 && x + h.nodes.actions.offsetWidth <= 1000);
  assert.ok(y >= 0 && y + h.nodes.actions.offsetHeight <= 800);
});
test('P0按钮说明明确复制保存后果、重新框选丢弃和预览缩放不改尺寸', () => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/selection.html'), 'utf8');
  const tag = id => html.match(new RegExp(`<button\\b[^>]*\\bid="${id}"[^>]*>`))[0];
  assert.match(tag('save'), /title="[^"]*直接保存到设置好的文件夹，不弹窗[^"]*成功后退出"/);
  assert.match(tag('save-as'), /title="[^"]*从上次那个文件夹开始[^"]*成功后退出"/);
  assert.match(tag('copy'), /title="复制图片到剪贴板并退出，不自动保存文件"/);
  assert.match(tag('retake'), /title="[^"]*丢弃当前成图及编辑[^"]*尚未保存的内容将不再保留"/);
  for (const id of ['zoom-in', 'zoom-out', 'zoom-fit', 'zoom-original']) assert.match(tag(id), /title="[^"]*图片尺寸不变"/);
  assert.match(tag('viewer-close'), /title="[^"]*图片保留[^"]*Esc"/);
});
test('P0阶段提示对应原有操作，不额外提交或改变重框行为', async () => {
  const h = await harness(); h.drag(10, 20, 300, 200);
  assert.match(h.nodes.hint.textContent, /回车复制并退出/);
  assert.equal(h.commits.length, 0);
  await h.completeScroll({ ok: true, token: 'long-token', width: 751, height: 6766, preview: 'thumbnail' });
  await h.emit('wheel', { deltaY: 100, clientX: 100, clientY: 100 });
  assert.match(h.nodes.hint.textContent, /重来请点「重新框选」/);
  assert.equal(h.scrolls.length, 0); assert.equal(h.commits.length, 0);
  h.nodes.retake.click();
  assert.equal(h.nodes['long-preview'].hidden, true); assert.equal(h.cancels(), 0);
});
for(const long of [false,true])test(`普通/长图预览共用独立编辑窗：本页只交元数据（long=${long}）`,async()=>{
  const h=await harness();h.drag(10,20,300,200);
  if(long)await h.completeScroll({ok:true,token:'long-token',width:751,height:6766,preview:'thumbnail'});
  await h.nodes.edit.click();
  assert.equal(h.commits.length,0);
  assert.equal(h.editSources.length,1);
  assert.equal(h.editSources[0].longToken,long?'long-token':undefined);
  assert.equal('dataUrl' in h.editSources[0],false,'本页不再拿原图，也不在本页建编辑器');
  assert.deepEqual(h.editSources[0].rect,{x:10,y:20,width:290,height:180});
  // 主进程带走原图去开编辑窗；本页等它交回预览缩略图。
  assert.equal(h.nodes.copy.disabled,false,'打开成功后按钮解锁（编辑窗在另一扇窗里）');
  h.editorPreview({token:'edit-owned',thumbnail:'data:image/png;base64,edited-thumbnail',outputSize:{width:300,height:200},crop:{x:0,y:0,width:300,height:200}});
  assert.equal(h.nodes['long-preview'].src,'data:image/png;base64,edited-thumbnail');assert.equal(h.nodes.retake.hidden,false);
  await h.emit('wheel',{deltaY:120,clientX:100,clientY:100});assert.equal(h.scrolls.length,0,'有编辑文档时滚轮不开长截图');
  await h.nodes.edit.click();assert.equal(h.editSources.length,1,'重开复用文档，不重新取原图覆盖标注');
  assert.deepEqual(h.editStates.map(x=>x.action),['open'],'同 token 只唤回编辑窗');
  await h.nodes.copy.click();assert.equal(h.commits.length,1);assert.equal(h.commits[0].action,'copy');
  assert.equal('edited' in h.commits[0],false,'导出现在由主进程向编辑窗取，本页不再传 PNG');
  assert.equal(h.commits[0].rect.width,290);
});
for(const long of [false,true])test(`普通和长图预览都只提交选区，不把完整 PNG 塞回本页（long=${long}）`,async()=>{
  // 导出结果只走主进程 ↔ 编辑窗那条通道；本页提交的永远只有选区与动作。
  const h=await harness();
  h.drag(10,20,300,200);
  if(long)await h.completeScroll({ok:true,token:'long-token',width:751,height:6766,preview:'thumbnail'});
  await h.nodes.edit.click();
  h.editorPreview({token:'edit-owned',thumbnail:'data:image/png;base64,edited-thumbnail',outputSize:{width:300,height:200}});
  await h.nodes.copy.click();
  assert.equal(h.commits.length,1);assert.equal(h.commits[0].action,'copy');
  assert.equal('edited' in h.commits[0],false);
  assert.equal(h.cancels(),0);
});
test('返回预览的提示只说明编辑已保留、保存或复制成功后退出，不承诺发送目标',async()=>{
  const h=await harness();h.drag(10,20,300,200);await h.nodes.edit.click();
  h.editorPreview({token:'edit-owned',thumbnail:'data:image/png;base64,edited-thumbnail',outputSize:{width:288,height:198}});
  assert.match(h.nodes.hint.textContent,/编辑已保留/);
  assert.match(h.nodes.hint.textContent,/288 × 198 像素/,'用编辑窗给的输出尺寸');
  for(const banned of ['Hana','对话','发送','8 MiB','8MiB']) assert.equal(h.nodes.hint.textContent.includes(banned),false,`提示里不能出现 ${banned}：${h.nodes.hint.textContent}`);
});
test('预览里的保存与复制都走同一个提交入口，不带编辑结果（导出由主进程负责）',async()=>{
  const h=await harness();h.drag(10,20,300,200);await h.nodes.edit.click();
  h.editorPreview({token:'edit-owned',thumbnail:'data:image/png;base64,edited-thumbnail',outputSize:{width:300,height:200}});
  await h.nodes.save.click();
  assert.equal(h.commits.length,1);assert.equal(h.commits[0].action,'save-quick');
  assert.equal('edited' in h.commits[0],false,'本页不传 PNG');
});
test('裁切与说明尺寸校验留在主进程：本页提交不带 crop/clipboardSize', async () => {
  const h = await harness(); h.drag(10, 20, 300, 200); await h.nodes.edit.click();
  h.editorPreview({ token: 'edit-owned', thumbnail: 'data:image/png;base64,edited-thumbnail', outputSize: { width: 120, height: 90 }, crop: { x: 4, y: 6, width: 120, height: 90 } });
  await h.nodes.copy.click();
  assert.equal(h.commits.length, 1);
  assert.equal('crop' in h.commits[0], false, '裁切信息只存在编辑窗与主进程之间');
  assert.equal('edited' in h.commits[0], false, '说明尺寸也由主进程核对');
});
test('预览回执缺输出尺寸时用文档尺寸，不把 undefined 写进提示', async () => {
  const h = await harness(); h.drag(10, 20, 300, 200); await h.nodes.edit.click();
  h.editorPreview({ token: 'edit-owned', thumbnail: 'data:image/png;base64,edited-thumbnail' });
  assert.match(h.nodes.hint.textContent, /580 × 360 像素/);
  assert.equal(h.nodes['long-preview'].src, 'data:image/png;base64,edited-thumbnail');
});
test('保存或复制失败只报错，预览与编辑文档都保留',async()=>{
  const h=await harness({failOnce:true});h.drag(10,20,300,200);await h.nodes.edit.click();
  h.editorPreview({token:'edit-owned',thumbnail:'data:image/png;base64,edited-thumbnail',outputSize:{width:300,height:200}});
  await h.nodes.copy.click();
  assert.equal(h.commits.length,1);assert.equal(h.cancels(),0);
  assert.match(h.nodes.hint.textContent,/暂时失败/);assert.equal(h.nodes.copy.disabled,false);
  assert.equal(h.nodes['long-preview'].src,'data:image/png;base64,edited-thumbnail','失败后预览不丢');
  assert.equal(h.editStates.filter(x=>x.action==='discard').length,0,'不丢编辑文档');
  await h.nodes.copy.click();assert.equal(h.commits.length,2,'可重试');
});
test('提交等待期间连点不重复提交',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve});
  const h=await harness({commitGate:gate});h.drag(10,20,300,200);await h.nodes.edit.click();
  h.editorPreview({token:'edit-owned',thumbnail:'data:image/png;base64,edited-thumbnail',outputSize:{width:300,height:200}});
  const sending=h.nodes.copy.click();await tick();
  assert.equal(h.nodes.copy.disabled,true,'提交中按钮禁用');await h.nodes.copy.click();
  assert.equal(h.commits.length,1);
  release();await sending;assert.equal(h.commits.length,1,'完成后再点也不会重复提交');
});
test('取消另存保留预览与编辑文档，可改复制',async()=>{
  const h=await harness({cancelOnce:true});h.drag(10,20,300,200);await h.nodes.edit.click();
  h.editorPreview({token:'edit-owned',thumbnail:'data:image/png;base64,edited-thumbnail',outputSize:{width:300,height:200}});
  await h.nodes.save.click();
  assert.equal(h.nodes.copy.disabled,false);assert.match(h.nodes.hint.textContent,/已取消保存/);
  await h.nodes.copy.click();assert.equal(h.commits.length,2);assert.equal(h.commits[1].action,'copy');
});
test('编辑打开失败不丢原选框、普通复制仍可用',async()=>{
  const h=await harness({editSourceFails:true});h.drag(10,20,300,200);await h.nodes.edit.click();assert.equal(h.nodes.copy.disabled,false);assert.match(h.nodes.hint.textContent,/成图仍保留/);
  await h.nodes.copy.click();assert.equal(h.commits.length,1);assert.equal(h.commits[0].edited,undefined);
});
test('原选区页的标题不再跟着编辑状态变：编辑窗口有自己的标题', async () => {
  const ok = await harness();
  ok.drag(10, 20, 300, 200);
  await ok.nodes.edit.click();
  assert.equal(ok.title(), '截个图 · 框选截图', '本页只负责框选，不当编辑页');
  ok.editorPreview({ token: 'edit-owned', thumbnail: 'data:image/png;base64,edited-thumbnail', outputSize: { width: 300, height: 200 } });
  assert.equal(ok.title(), '截个图 · 框选截图');
});

test('打开编辑期间锁住选区页：不重开、不重框、不提交', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = await harness({ editSourceGate: gate });
  h.drag(10, 20, 300, 200);
  const opening = h.nodes.edit.click();
  await tick();
  assert.equal(h.nodes.edit.disabled, true, '编辑按钮锁住');
  assert.equal(h.nodes.copy.disabled, true, '输出按钮锁住');
  await h.nodes.edit.click();
  assert.equal(h.editSources.length, 1, '锁定期间不重复请求');
  h.drag(20, 30, 500, 500);
  await h.nodes.copy.click();
  assert.equal(h.commits.length, 0, '锁定期间不提交');
  release();
  await opening;
  assert.equal(h.nodes.copy.disabled, false, '打开完成解锁');
  assert.equal(h.editSources[0].rect.width, 290, '锁定期间的拖动没有改掉交给编辑窗的框');
});

test('同 token 喚回被拒时保留编辑文档并报错，不假装回到编辑', async () => {
  const h = await harness({ editStateFails: 'open' });
  h.drag(10, 20, 300, 200);
  await h.nodes.edit.click();
  h.editorPreview({ token: 'edit-owned', thumbnail: 'data:image/png;base64,edited-thumbnail', outputSize: { width: 300, height: 200 } });
  await h.nodes.edit.click();
  assert.match(h.nodes.hint.textContent, /编辑未能打开/);
  assert.equal(h.nodes['long-preview'].src, 'data:image/png;base64,edited-thumbnail', '预览不丢');
  assert.equal(h.editStates.filter(item => item.action === 'discard').length, 0, '不丢文档');
});
test('首次编辑打开失败：成图保留，仍可普通复制', async () => {
  const h = await harness({ editSourceFails: true });
  h.drag(10, 20, 300, 200);
  await h.nodes.edit.click();
  assert.deepEqual(h.editStates, [], '没拿到 token 就不发 editState');
  assert.match(h.nodes.hint.textContent, /编辑未能打开/);
  await h.nodes.copy.click();
  assert.equal(h.commits.length, 1);
  assert.equal(h.commits[0].edited, undefined, '回到未编辑的普通复制');
});
test('编辑读取中不重框不复制；回到预览后重新框选显式丢弃旧会话',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve});const h=await harness({editSourceGate:gate});h.drag(10,20,300,200);
  const opening=h.nodes.edit.click();h.drag(20,30,500,500);h.emit('keydown',{key:'Enter'});assert.equal(h.commits.length,0);release();await opening;
  h.editorPreview({token:'edit-owned',thumbnail:'data:image/png;base64,edited-thumbnail',outputSize:{width:300,height:200}});
  h.nodes.retake.click();await tick();assert.equal(h.editStates.at(-1).action,'discard');
  h.drag(20,30,200,100);await h.nodes.copy.click();assert.equal(h.commits[0].edited,undefined);assert.equal(h.commits[0].rect.width,180);
});
test('长截图独立短提示突出滚轮与上下键，状态行不堆操作说明',async()=>{
 const h=await harness();h.drag(100,100,500,700);
 assert.match(h.nodes.hint.textContent,/像素 · 回车复制并退出 · Esc 退出/);
 assert.ok(h.nodes.hint.textContent.length<55);
 const html=fs.readFileSync(path.join(__dirname,'../renderer/selection.html'),'utf8');
 assert.match(html,/<aside id="long-capture-tip"[^>]*><strong>滚轮 \/ ↑↓ <span>开启长截图<\/span><\/strong><small>鼠标放选区内 · 页面需可滚动<\/small><\/aside>/);
});
for(const key of ['ArrowUp','ArrowDown'])test(`${key}可进入长截图，重复按键不重复创建、不保存复制`,async()=>{
 const h=await harness();h.drag(100,100,500,700);let prevented=false;
 const first=h.emit('keydown',{key,preventDefault(){prevented=true;}});h.emit('keydown',{key,repeat:true});await first;
 assert.equal(prevented,true);assert.equal(h.scrolls.length,1);assert.equal(h.commits.length,0);assert.match(h.nodes.hint.textContent,/等选区界面收起.*↑↓/);
});
test('方向键不抢编辑、工具栏与修饰键；未框选不启动',async()=>{
 const h=await harness();h.emit('keydown',{key:'ArrowDown'});assert.equal(h.scrolls.length,0);h.drag(100,100,500,700);
 for(const target of [h.nodes.edit,h.nodes.save])h.emit('keydown',{key:'ArrowDown',target});
 for(const modifier of ['ctrlKey','shiftKey','altKey','metaKey'])h.emit('keydown',{key:'ArrowDown',[modifier]:true});
 h.emit('keydown',{key:'ArrowDown',defaultPrevented:true});assert.equal(h.scrolls.length,0);
 await h.nodes.edit.click();h.emit('keydown',{key:'ArrowDown'});assert.equal(h.scrolls.length,0);
 const p=await previewHarness();p.emit('keydown',{key:'ArrowUp',target:p.nodes['viewer-scroll']});assert.equal(p.scrolls.length,0);
});
test('向上滚轮同样能进入长截图，启动参数不带正文范围',async()=>{
 const w=await harness();w.drag(100,100,500,700);await w.emit('wheel',{deltaY:-100,clientX:300,clientY:300});
 assert.equal(w.scrolls.length,1);assert.equal('content' in w.scrolls[0],false);
});

test('中断恢复图滚轮后仍显示原警告，不误报完成或重新启动采集',async()=>{
  const h=await harness();h.drag(10,20,300,200);
  const warning='计算中断，仅保留首屏原图，滚动部分未确认';
  await h.completeScroll({ok:true,token:'recovered-token',width:580,height:360,preview:'thumbnail',warning});
  await h.emit('wheel',{deltaY:100,clientX:100,clientY:100});
  assert.ok(h.nodes.hint.textContent.includes(warning));
  assert.equal(h.nodes.hint.textContent.includes('本次长图已完成'),false);
  assert.equal(h.commits.length,0);assert.equal(h.scrolls.length,0);
});

test('编辑后的缩略图键盘打开编辑：只唤回编辑窗，不误触复制',async()=>{
  const h=await harness();h.drag(10,20,300,200);await h.nodes.edit.click();
  h.editorPreview({token:'edit-owned',thumbnail:'data:image/png;base64,edited-thumbnail',outputSize:{width:300,height:200}});
  h.emit('keydown',{key:'Enter',target:h.nodes['long-preview']});await tick();
  assert.equal(h.commits.length,0);
  assert.deepEqual(h.editStates.map(x=>x.action),['open'],'同 token 唤回编辑窗');
  assert.equal(h.editSources.length,1,'不重新取源');
});

// 跨屏：一窗盖住整组屏。frame 是物理 union，screens 是相对 union 原点的物理矩形；
// 视口 1000×800 下 A 占左侧 666.67px，B 占右下 333.33×400，两屏之间的右下角是黑洞。
const DESKTOP = { frame: { width: 5760, height: 2160 },
  screens: [{ x: 0, y: 0, width: 3840, height: 2160 }, { x: 3840, y: 548, width: 1920, height: 1080 }] };
const near = (a, b) => Math.abs(a - b) < 0.6;
const cssRect = node => ({ left: parseFloat(node.style.left), top: parseFloat(node.style.top),
  width: node.offsetWidth, height: node.offsetHeight });

test('跨屏模式：跨缝选框滚轮与上下键都不进长截图，提示跨屏仅普通截图', async () => {
  const h = await harness({ mode: 'desktop', ...DESKTOP });
  assert.deepEqual(h.bodyClasses(), ['desktop-mode'], '还没框选时不算跨屏选区');
  h.drag(600, 250, 900, 500);
  assert.deepEqual(h.bodyClasses(), ['desktop-mode', 'desktop-cross-selection']);
  assert.match(h.nodes.hint.textContent, /跨屏选区仅支持普通截图/);
  await h.emit('wheel', { deltaY: 120, clientX: 800, clientY: 350 });
  assert.equal(h.scrolls.length, 0, '跨屏图不是可滚动窗口');
  assert.match(h.nodes.hint.textContent, /跨屏选区仅支持普通截图/);
  await h.emit('keydown', { key: 'ArrowUp', target: h.nodes.desktop });
  await h.emit('keydown', { key: 'ArrowDown', target: h.nodes.desktop });
  assert.equal(h.scrolls.length, 0);
  assert.match(h.nodes.hint.textContent, /跨屏选区仅支持普通截图/);
  assert.equal(h.nodes.actions.hidden, false, '被拒后仍保留保存/复制');
});

test('跨屏模式：单屏选区的滚轮与 ↑↓ 都能开始长图，副屏 owner 同样算单屏', async () => {
  const wheel = await harness({ mode: 'desktop', ...DESKTOP });
  wheel.drag(700, 250, 900, 500);
  assert.deepEqual(wheel.bodyClasses(), ['desktop-mode'], '副屏里的选框也是单屏');
  assert.doesNotMatch(wheel.nodes.hint.textContent, /跨屏选区仅支持普通截图/);
  await wheel.emit('wheel', { deltaY: 120, clientX: 800, clientY: 350 });
  assert.deepEqual(JSON.parse(JSON.stringify(wheel.scrolls[0])), { x: 700, y: 250, width: 200, height: 250 });
  for (const key of ['ArrowUp', 'ArrowDown']) {
    const h = await harness({ mode: 'desktop', ...DESKTOP });
    h.drag(700, 250, 900, 500);
    await h.emit('keydown', { key, target: h.nodes.desktop });
    assert.equal(h.scrolls.length, 1, `${key} 在单屏选区内可以开始长截图`);
  }
});

test('跨屏模式：选框移动跨缝后拒长图，移回单屏自动恢复', async () => {
  const h = await harness({ mode: 'desktop', ...DESKTOP });
  h.drag(700, 250, 900, 500);
  h.emit('pointerdown', { clientX: 750, clientY: 375 });
  h.emit('pointermove', { clientX: 670, clientY: 375 });
  h.emit('pointerup', { clientX: 670, clientY: 375 });
  assert.deepEqual(h.bodyClasses(), ['desktop-mode', 'desktop-cross-selection']);
  await h.emit('wheel', { deltaY: 100, clientX: 700, clientY: 375 });
  assert.equal(h.scrolls.length, 0);
  assert.match(h.nodes.hint.textContent, /跨屏选区仅支持普通截图/);
  h.emit('pointerdown', { clientX: 700, clientY: 375 });
  h.emit('pointermove', { clientX: 760, clientY: 375 });
  h.emit('pointerup', { clientX: 760, clientY: 375 });
  assert.deepEqual(h.bodyClasses(), ['desktop-mode']);
  await h.emit('wheel', { deltaY: 100, clientX: 850, clientY: 375 });
  assert.equal(h.scrolls.length, 1, '移回单屏后长图入口直接恢复，不用重开');
});

test('跨屏模式：拖边把选框拉过缝就拒长图，缩回单屏又恢复', async () => {
  const h = await harness({ mode: 'desktop', ...DESKTOP });
  h.drag(700, 250, 900, 500);
  h.emit('pointerdown', { clientX: 700, clientY: 375 });
  h.emit('pointermove', { clientX: 600, clientY: 375 });
  h.emit('pointerup', { clientX: 600, clientY: 375 });
  assert.deepEqual(h.bodyClasses(), ['desktop-mode', 'desktop-cross-selection']);
  await h.emit('keydown', { key: 'ArrowDown', target: h.nodes.desktop });
  assert.equal(h.scrolls.length, 0);
  h.emit('pointerdown', { clientX: 600, clientY: 375 });
  h.emit('pointermove', { clientX: 700, clientY: 375 });
  h.emit('pointerup', { clientX: 700, clientY: 375 });
  assert.deepEqual(h.bodyClasses(), ['desktop-mode']);
  await h.emit('keydown', { key: 'ArrowDown', target: h.nodes.desktop });
  assert.equal(h.scrolls.length, 1);
});

test('跨屏模式：跨缝选框只拒长图，复制/保存/另存仍提交原选区', async () => {
  for (const [id, action] of [['copy', 'copy'], ['save', 'save-quick'], ['save-as', 'save']]) {
    const h = await harness({ mode: 'desktop', ...DESKTOP });
    h.drag(600, 250, 900, 500);
    await h.nodes[id].click();
    assert.equal(h.commits.length, 1, `${id} 跨屏也要能提交`);
    assert.deepEqual(h.commits[0].rect, { x: 600, y: 250, width: 300, height: 250 });
    assert.equal(h.commits[0].action, action);
  }
});

test('跨屏模式：接缝端点按 round 判 owner，边跨 1 像素与屏间空洞都拒', async () => {
  // 右端正好落在物理接缝 3840 上：仍整框属于主屏。
  const edge = await harness({ mode: 'desktop', ...DESKTOP });
  edge.drag(664, 250, 666.6667, 500);
  assert.deepEqual(edge.bodyClasses(), ['desktop-mode'], '正好到接缝不算跨屏');
  // 再往右 1 物理像素，主屏与副屏都包不住整框。
  const one = await harness({ mode: 'desktop', ...DESKTOP });
  one.drag(664, 250, 666.9, 500);
  assert.deepEqual(one.bodyClasses(), ['desktop-mode', 'desktop-cross-selection']);
  // 副屏上方的黑底不属于任何屏幕。
  const hole = await harness({ mode: 'desktop', ...DESKTOP });
  hole.drag(700, 100, 900, 190);
  assert.deepEqual(hole.bodyClasses(), ['desktop-mode', 'desktop-cross-selection']);
});

test('跨屏模式：分数视口下仍按 round 端点判 owner，1 像素差可复现', async () => {
  const viewport = { width: 1000.5, height: 800.5 };
  const inside = await harness({ mode: 'desktop', ...DESKTOP, viewport });
  inside.drag(600, 250, 667, 500);
  assert.deepEqual(inside.bodyClasses(), ['desktop-mode'], '右端舍入到 3840 仍属主屏');
  const outside = await harness({ mode: 'desktop', ...DESKTOP, viewport });
  outside.drag(600, 250, 667.2, 500);
  assert.deepEqual(outside.bodyClasses(), ['desktop-mode', 'desktop-cross-selection'], '舍入到 3841 就跨缝');
});

test('跨屏模式：视口比例变化后按新比例重判，长图入口和控件同步更新', async () => {
  const h = await harness({ mode: 'desktop', ...DESKTOP });
  h.drag(600, 250, 667, 500);
  assert.deepEqual(h.bodyClasses(), ['desktop-mode', 'desktop-cross-selection'], '1000 宽下右端舍入到 3842，跨缝');
  h.resizeTo(1000.5, 800.5);
  assert.deepEqual(h.bodyClasses(), ['desktop-mode'], '窗口定型后右端舍入到 3840，回到单屏');
  const bar = cssRect(h.nodes.actions);
  assert.ok(bar.left + bar.width <= 1000.5 + 0.6, `工具栏按新投影重排，实际右沿 ${bar.left + bar.width}`);
  await h.emit('wheel', { deltaY: 100, clientX: 620, clientY: 375 });
  assert.equal(h.scrolls.length, 1, '重判为单屏后长图入口直接可用');
});

test('跨屏模式：副屏里的最小 48×96 物理像素选框可以接长图', async () => {
  const h = await harness({ mode: 'desktop', ...DESKTOP });
  h.drag(700, 300, 700 + 48 / 5.76, 300 + 96 / 2.7);
  assert.deepEqual(h.bodyClasses(), ['desktop-mode']);
  assert.deepEqual({ width: Math.round((700 + 48 / 5.76) * 5.76) - Math.round(700 * 5.76),
    height: Math.round((300 + 96 / 2.7) * 2.7) - Math.round(300 * 2.7) }, { width: 48, height: 96 });
  await h.emit('wheel', { deltaY: 100, clientX: 704, clientY: 317 });
  assert.equal(h.scrolls.length, 1);
});

test('跨屏模式：完成后视口变化让原框跨缝，滚轮仍报旧警告且不重开不大改 token', async () => {
  const h = await harness({ mode: 'desktop', ...DESKTOP });
  h.drag(600, 250, 666.5, 500);
  assert.deepEqual(h.bodyClasses(), ['desktop-mode'], '1000 宽下右端舍入到 3839，仍属主屏');
  const warning = '计算中断，仅保留首屏原图，滚动部分未确认';
  await h.completeScroll({ ok: true, token: 'recovered-token', width: 580, height: 360, preview: 'thumbnail', warning });
  h.resizeTo(999.5, 800);
  assert.deepEqual(h.bodyClasses(), ['desktop-mode', 'desktop-cross-selection'], '视口变窄后原框重算成跨屏');
  await h.emit('wheel', { deltaY: 100, clientX: 620, clientY: 375 });
  assert.ok(h.nodes.hint.textContent.includes(warning), '恢复警告不能被跨屏提示盖掉');
  assert.equal(h.nodes.hint.textContent.includes('跨屏选区仅支持普通截图'), false);
  assert.equal(h.scrolls.length, 0, '已成图不重新 begin');
  await h.nodes.copy.click();
  assert.equal(h.commits.length, 1);
  assert.equal(h.commits[0].longToken, 'recovered-token', 'token 不被改掉');
  assert.equal(h.commits[0].action, 'copy');
});

test('跨屏模式：取消框与右键清框都回到初始提示，不再算跨屏选区', async () => {
  const cancel = await harness({ mode: 'desktop', ...DESKTOP });
  cancel.emit('pointerdown', { clientX: 600, clientY: 250 });
  cancel.emit('pointermove', { clientX: 900, clientY: 500 });
  cancel.emit('pointercancel');
  assert.equal(cancel.commits.length, 0);
  assert.deepEqual(cancel.cancelReasons, [], '本地清框不上报后端取消');
  assert.deepEqual(cancel.bodyClasses(), ['desktop-mode']);
  assert.equal(cancel.nodes.hint.textContent, '拖动框选，可跨屏；选区内滚动接长图 · Esc 退出');
  const clear = await harness({ mode: 'desktop', ...DESKTOP });
  clear.drag(600, 250, 900, 500);
  clear.emit('contextmenu', {});
  assert.deepEqual(clear.bodyClasses(), ['desktop-mode']);
  assert.equal(clear.nodes.hint.textContent, '拖动框选，可跨屏；选区内滚动接长图 · Esc 退出');
});

test('跨屏模式：单屏选框完成长图后滚轮提示与重新框选不被跨屏提示顶掉', async () => {
  const h = await harness({ mode: 'desktop', ...DESKTOP });
  h.drag(700, 250, 900, 500);
  await h.completeScroll({ ok: true, token: 'long-token', width: 751, height: 6766, preview: 'thumbnail' });
  await h.emit('wheel', { deltaY: 100, clientX: 800, clientY: 350 });
  assert.match(h.nodes.hint.textContent, /本次长图已完成/);
  assert.equal(h.nodes.hint.textContent.includes('跨屏选区仅支持普通截图'), false);
  assert.equal(h.scrolls.length, 0);
  assert.equal(h.cancelReasons.length, 0);
  h.nodes.retake.click();
  assert.deepEqual(h.bodyClasses(), ['desktop-mode']);
  assert.equal(h.nodes.hint.textContent, '拖动框选，可跨屏；选区内滚动接长图 · Esc 退出');
});

test('跨屏模式：编辑态不丢已编辑内容，回到预览后照样提交带标注原图', async () => {
  const h = await harness({ mode: 'desktop', ...DESKTOP });
  h.drag(600, 250, 900, 500);
  await h.nodes.edit.click();
  assert.equal(h.editSources.length, 1);
  assert.equal(h.editSources[0].longToken, undefined);
  assert.equal(h.exits.length, 0, '打开编辑本身不申请退出');
  assert.equal(h.commits.length, 0);
  h.editorPreview({ token: 'edit-owned', thumbnail: 'data:image/png;base64,edited-thumbnail', outputSize: { width: 300, height: 250 } });
  assert.equal(h.nodes['long-preview'].src, 'data:image/png;base64,edited-thumbnail');
  await h.nodes.copy.click();
  assert.equal(h.commits.length, 1);
  assert.equal(h.commits[0].action, 'copy');
  assert.equal('edited' in h.commits[0], false, '跨屏编辑的导出也由主进程向编辑窗取');
});

test('跨屏模式：工具栏留在选区所在的那块真实屏幕上', async () => {
  const h = await harness({ mode: 'desktop', ...DESKTOP });
  h.drag(700, 250, 900, 500);
  const bar = cssRect(h.nodes.actions);
  assert.ok(bar.left >= 666.67, `工具栏左沿 ${bar.left} 不能进主屏`);
  assert.ok(bar.left + bar.width <= 1000 + 0.6, '工具栏右沿不能出屏');
  assert.ok(bar.top >= 202.9 - 0.6 && bar.top + bar.height <= 602.96 + 0.6, '工具栏上下不出副屏');
});

test('跨屏模式：选区落在两屏之间的黑洞时，工具栏退回最大那块屏', async () => {
  const h = await harness({ mode: 'desktop', ...DESKTOP });
  h.drag(700, 620, 950, 780);
  const bar = cssRect(h.nodes.actions);
  assert.ok(bar.left + bar.width <= 666.67 + 0.6, `工具栏整块必须在主屏内，实际右沿 ${bar.left + bar.width}`);
  assert.ok(bar.top + bar.height <= 800 + 0.6);
  assert.ok(near(parseFloat(h.nodes.hint.style.left), 333.33), '提示条也回到主屏中线');
});

test('跨屏模式：提交只带页面局部坐标，不在渲染层做任何比例换算', async () => {
  const h = await harness({ mode: 'desktop', ...DESKTOP });
  h.drag(700, 250, 900, 500);
  await h.nodes.copy.click();
  assert.deepEqual(h.commits[0].rect, { x: 700, y: 250, width: 200, height: 250 });
  assert.equal(h.commits[0].action, 'copy');
});

test('跨屏模式：只有跨屏选框才收起长截图提示，单屏选框照常提示', () => {
  const css = fs.readFileSync(path.join(__dirname, '../renderer/selection.css'), 'utf8');
  assert.ok(css.includes('body.desktop-cross-selection #long-capture-tip{display:none!important}'));
  assert.ok(css.includes('body.desktop-cross-selection:has(#box:not([hidden]))'), '自动显现规则也要有跨屏覆盖');
  assert.equal(css.includes('body.desktop-mode #long-capture-tip'), false, '不再按模式一律收起');
  const script = fs.readFileSync(path.join(__dirname, '../renderer/selection.js'), 'utf8');
  assert.ok(script.includes("classList.add('desktop-mode')"));
  assert.ok(script.includes("classList.toggle('desktop-cross-selection'"));
});

test('选区页不再创建编辑器：识别桥只在独立编辑窗口那边接', async () => {
  const h = await harness({ withRecognizeText: true });
  h.drag(10, 20, 300, 200);
  await h.nodes.edit.click();
  assert.equal(h.editorOptions(), undefined, '选区页没有 createImageEditor 回调对象');
  assert.equal(h.recognizePayloads.length, 0, '打开编辑不触发识别');
  // 本页也不再有编辑器实例变量：页面脚本里不应再引用 createImageEditor。
  const script = fs.readFileSync(path.join(__dirname, '../renderer/selection.js'), 'utf8');
  assert.equal(script.includes('createImageEditor'), false, '编辑器只在独立页面里创建');
  assert.equal(script.includes('exportClipboard'), false, '导出入口不再回到选区页');
});

// —— GIF 录制入口：只在显式点击后交给主进程实时采屏 ——
test('录制入口：没有选区时禁用，固定好普通选区后才能点', async () => {
  const idle = await harness();
  assert.equal(idle.nodes['record-gif'].disabled, true, '还没框选就不能录');
  const h = await harness();
  h.drag(10, 20, 300, 200);
  assert.equal(h.nodes['record-gif'].disabled, false);
});
test('录制入口：点「录制 GIF」才把当前矩形交给 beginRecord，成功后面板保持忙', async () => {
  const h = await harness();
  h.drag(10, 20, 300, 200);
  await h.nodes['record-gif'].click();
  assert.deepEqual(h.records, [{ x: 10, y: 20, width: 290, height: 180 }], '只交矩形，不交图也不加字段');
  assert.match(h.nodes.hint.textContent, /GIF 录制已开始/);
  assert.equal(h.nodes.save.disabled, true, '录制中其它出口一起禁用');
  assert.equal(h.nodes.copy.disabled, true);
  assert.equal(h.nodes['record-gif'].disabled, true);
  assert.equal(h.commits.length, 0, '录制不进入 PNG 保存/复制');
});
test('录制入口：跨屏选区禁用并说明仅一屏内', async () => {
  const h = await harness({ mode: 'desktop', ...DESKTOP });
  h.drag(600, 250, 900, 500);
  assert.deepEqual(h.bodyClasses(), ['desktop-mode', 'desktop-cross-selection']);
  assert.equal(h.nodes['record-gif'].disabled, true);
  await h.nodes['record-gif'].click();
  assert.equal(h.records.length, 0, '跨屏不发录制请求');
  assert.match(h.nodes.hint.textContent, /GIF 录制仅支持单屏内的选区/);
  const single = await harness({ mode: 'desktop', ...DESKTOP });
  single.drag(700, 250, 900, 500);
  assert.equal(single.nodes['record-gif'].disabled, false, '单屏内的跨屏模式选区可以录');
});
test('录制入口：长图与编辑态禁用，编辑稿不会被悄悄丢掉', async () => {
  const long = await harness();
  long.drag(10, 20, 300, 200);
  await long.completeScroll({ ok: true, token: 'long-token', width: 751, height: 6766, preview: 'thumbnail' });
  assert.equal(long.nodes['record-gif'].disabled, true);
  await long.nodes['record-gif'].click();
  assert.equal(long.records.length, 0);

  const edited = await harness();
  edited.drag(10, 20, 300, 200);
  await edited.nodes.edit.click();
  assert.equal(edited.nodes['record-gif'].disabled, true);
  await edited.nodes['record-gif'].click();
  assert.equal(edited.records.length, 0);
  assert.match(edited.nodes.hint.textContent, /编辑内容尚未保存/);
  assert.equal(edited.editStates.filter(x => x.action === 'discard').length, 0, '编辑文档与草稿必须保留');
});
test('录制入口防双击：连点只发一次请求', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await harness({ recordGate: gate });
  h.drag(10, 20, 300, 200);
  const first = h.nodes['record-gif'].click();
  const second = h.nodes['record-gif'].click();
  await tick();
  assert.equal(h.records.length, 1);
  release();
  await first; await second;
});
test('录制入口失败：错误可读、按钮与忙标记都恢复', async () => {
  const h = await harness({ recordFails: true });
  h.drag(10, 20, 300, 200);
  await h.nodes['record-gif'].click();
  assert.equal(h.records.length, 1);
  assert.match(h.nodes.hint.textContent, /GIF 录制未开始：录制预检失败/);
  assert.equal(h.nodes.save.disabled, false);
  assert.equal(h.nodes.copy.disabled, false);
  assert.equal(h.nodes['record-gif'].disabled, false, '失败后可以再点');
  await h.nodes['record-gif'].click();
  assert.equal(h.records.length, 2);
});
test('录制入口：保存/复制进行中一律禁用，取消保存后恢复', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await harness({ commitGate: gate, cancelOnce: true });
  h.drag(10, 20, 300, 200);
  const pending = h.nodes.copy.click();
  await tick();
  assert.equal(h.nodes['record-gif'].disabled, true);
  release();
  await pending;
  assert.equal(h.nodes['record-gif'].disabled, false, '取消保存后恢复录制入口');
  assert.equal(h.records.length, 0);
});
test('录制按钮文案与说明写明实时画面和 Esc，且不进 PNG 动作枚举', () => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/selection.html'), 'utf8');
  const button = html.match(/<button id="record-gif"[^>]*>([^<]*)<\/button>/);
  assert.ok(button, '工具栏里要有录制按钮');
  assert.equal(button[1].trim(), '录制 GIF');
  assert.match(button[0], /title="[^"]*实时画面/);
  assert.match(button[0], /Esc/);
  const script = fs.readFileSync(path.join(__dirname, '../renderer/selection.js'), 'utf8');
  assert.doesNotMatch(script, /commit\('(record|gif)/i);
  assert.match(script, /beginRecord\(\{ x: rect\.x, y: rect\.y, width: rect\.width, height: rect\.height \}\)/);
  assert.doesNotMatch(script, /innerHTML/, '录制链路不拼 HTML');
});
