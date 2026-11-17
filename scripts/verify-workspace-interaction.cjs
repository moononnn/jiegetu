/* 隐藏窗口里的工作台交互验收：真实 renderer/workspace.js，在合成指针/键盘事件下跑
   “圈点批注 → 原位输入 → 跨图拉线 → 撤销/重做 → 纯色遮盖”，每一步都核对落库模型。
   不加载生产 main/index.cjs、不采屏、不碰系统剪贴板与真实 userData。
   运行：node_modules\electron\dist\electron.exe scripts\verify-workspace-interaction.cjs */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const STUB = path.join(ROOT, 'test/fixtures/workspace-host-stub.cjs');
const PAGE = path.join(ROOT, 'renderer/workspace.html');
const results = [];
const failures = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures.push(name);
};

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makePng(width, height, paint) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length, 0);
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const stride = width * 3;
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      rows[base + 1 + x * 3] = r; rows[base + 2 + x * 3] = g; rows[base + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-interaction-'));
  const imageA = makePng(400, 300, (x, y) => (x < 200 ? [20, 40, 60] : [200, 120, 60]));
  const imageB = makePng(360, 260, (x, y) => (y < 130 ? [30, 60, 40] : [60, 130, 90]));
  const hashA = crypto.createHash('sha256').update(imageA).digest('hex');
  const hashB = crypto.createHash('sha256').update(imageB).digest('hex');
  fs.writeFileSync(path.join(dir, 'a.png'), imageA);
  fs.writeFileSync(path.join(dir, 'b.png'), imageB);
  const document_ = {
    schemaVersion: 1, id: 'group_interaction', title: '交互验收组', revision: 1,
    images: [
      { id: 'image_one', assetHash: hashA, name: '图1', width: 400, height: 300,
        frame: { x: 0, y: 0, width: 400, height: 300 }, masks: [] },
      { id: 'image_two', assetHash: hashB, name: '图2', width: 360, height: 260,
        frame: { x: 520, y: 40, width: 360, height: 260 }, masks: [] }
    ],
    notes: [], comment: '', view: { panX: 0, panY: 0, zoom: 1 }
  };
  const fixtureFile = path.join(dir, 'fixture.json');
  fs.writeFileSync(fixtureFile, JSON.stringify({ document: document_, assets: { [hashA]: path.join(dir, 'a.png'), [hashB]: path.join(dir, 'b.png') }, exportDir: path.join(dir, 'out'), delayPartMs: 250, delayBeginMs: 400 }));

  const win = new BrowserWindow({ show: false, width: 1200, height: 820,
    webPreferences: { contextIsolation: true, sandbox: false, nodeIntegration: false,
      preload: STUB, additionalArguments: [`--ws-fixture=${fixtureFile}`], backgroundThrottling: false } });
  const consoleLines = [];
  win.webContents.on('console-message', (event, level, message) => consoleLines.push(`${level}: ${message}`));
  win.webContents.on('preload-error', (event, file, error) => consoleLines.push(`preload-error: ${error}`));
  await win.loadFile(PAGE);
  await sleep(900);

  const run = code => win.webContents.executeJavaScript(code, true);

  await run(`document.getElementById('fit').click()`);
  await sleep(200);

  const geometry = await run(`(() => {
    const rect = id => { const node = document.querySelector('.ws-image[data-id="' + id + '"]'); const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
    const stage = document.getElementById('stage').getBoundingClientRect();
    return { a: rect('image_one'), b: rect('image_two'), stage: { left: stage.left, top: stage.top, width: stage.width, height: stage.height } };
  })()`);
  check('图块在画布里可见', geometry.a.width > 20 && geometry.b.width > 20, geometry);
  const layoutTimeline = await run(`(async () => {
    const out = [];
    const bar = document.querySelector('.ws-toolbar');
    for (let i = 0; i < 30; i++) { out.push(Math.round(bar.getBoundingClientRect().height)); await new Promise(r => setTimeout(r, 100)); }
    return out;
  })()`);
  check('工具栏高度时间线', true, layoutTimeline);
  const barMeasure = await run(`(() => { const bar = document.querySelector('.ws-toolbar'); const kids = [...bar.children].map(g => ({ label: g.getAttribute('aria-label'), w: Math.round(g.getBoundingClientRect().width) })); return { total: Math.round(bar.scrollWidth), client: bar.clientWidth, kids }; })()`);
  check('工具栏宽度明细', true, barMeasure);
  const layoutStart = await run(`({ bar: Math.round(document.querySelector('.ws-toolbar').getBoundingClientRect().height), stageTop: document.getElementById('stage').getBoundingClientRect().top })`);

  // 派发合成指针事件的工具（页面监听在 #stage 上）。
  const dispatch = async (type, x, y) => run(`(() => {
    const stage = document.getElementById('stage');
    const event = new PointerEvent('${type}', { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y}, pointerId: 7, button: 0, buttons: ${type === 'pointerup' ? 0 : 1} });
    stage.dispatchEvent(event);
    return true;
  })()`);
  const pointIn = (rect, fx, fy) => ({ x: rect.left + rect.width * fx, y: rect.top + rect.height * fy });

  // 1. 圈点批注：图1 里拖一个框。
  await run(`document.querySelector('.ws-tool[data-tool="annotate"]').click()`);
  const p1 = pointIn(geometry.a, 0.2, 0.25), p2 = pointIn(geometry.a, 0.6, 0.6);
  await dispatch('pointerdown', p1.x, p1.y);
  await dispatch('pointermove', p2.x, p2.y);
  await dispatch('pointerup', p2.x, p2.y);
  await sleep(150);
  const composerOpen = await run(`!document.getElementById('composer').hidden`);
  check('框完就出现原位输入', composerOpen === true, composerOpen);

  const longNote = '这段说明比较长：颜色照这个，边框再收一点，第二张图的右下角也要对齐。';
  // 2. 输入法 composing 时 Enter 不提交。
  await run(`(() => {
    const area = document.getElementById('composerText');
    area.focus(); area.value = '颜色';
    area.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true, keyCode: 229 }));
    return true;
  })()`);
  await sleep(80);
  const stillOpen = await run(`!document.getElementById('composer').hidden && document.getElementById('composerText').value`);
  check('输入法 composing 时 Enter 不提交', stillOpen === '颜色', stillOpen);

  // 3. 正常提交：Enter 建立一条意见（故意用长文，后面验证追加目标不会吃掉原文）。
  await run(`(() => {
    const area = document.getElementById('composerText');
    area.value = ${JSON.stringify(longNote)};
    area.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: false }));
    return true;
  })()`);
  await sleep(700);
  const afterNote = await run(`window.workspaceHost.__report().saves.at(-1)?.document`);
  const saved = afterNote ? JSON.parse(afterNote) : undefined;
  check('提交后落库一条意见', saved?.notes?.length === 1 && saved.notes[0].text === longNote, saved?.notes);
  check('意见目标是图1 的一个框', saved?.notes?.[0]?.targets?.[0]?.kind === 'region' && saved.notes[0].targets[0].imageId === 'image_one', saved?.notes?.[0]?.targets);

  // 4. 选中这条框，从右把手拖到图2 内部 → 建关联点。
  const stageTopBefore = await run(`document.getElementById('stage').getBoundingClientRect().top`);
  await run(`document.querySelector('.ws-tool[data-tool="select"]').click()`);
  const centerTarget = pointIn(geometry.a, 0.4, 0.42);
  await dispatch('pointerdown', centerTarget.x, centerTarget.y);
  const afterDownDebug = await run(`({ debug: window.__workspaceDebug(), hint: document.getElementById('hint').textContent, probe: window.__workspaceHitTest(${centerTarget.x}, ${centerTarget.y}) })`);
  await dispatch('pointerup', centerTarget.x, centerTarget.y);
  await sleep(120);
  const selectedHint = await run(`document.getElementById('hint').textContent`);
  const stageTopAfter = await run(`document.getElementById('stage').getBoundingClientRect().top`);
  check('关联按钮只换可用态，画布不因选中而上下跳', stageTopBefore === stageTopAfter, { stageTopBefore, stageTopAfter });
  const selDebug = await run(`window.__workspaceDebug()`);
  check('点已有框能选中它（拉线手柄的前提）', /已选中意见 1 的框/.test(selectedHint), { selectedHint, afterDownDebug });
  const targetRect = saved.notes[0].targets[0].rect;
  const handle = {
    x: geometry.a.left + geometry.a.width * ((targetRect.x + targetRect.width) / 400),
    y: geometry.a.top + geometry.a.height * ((targetRect.y + targetRect.height / 2) / 300)
  };
  const drop = pointIn(geometry.b, 0.4, 0.5);
  await dispatch('pointerdown', handle.x, handle.y);
  await dispatch('pointermove', drop.x, drop.y);
  await dispatch('pointerup', drop.x, drop.y);
  await sleep(800);
  const afterLink = await run(`window.workspaceHost.__report().saves.at(-1)?.document`);
  const linked = afterLink ? JSON.parse(afterLink) : undefined;
  check('跨图拉线建了第二个目标', linked?.notes?.[0]?.targets?.length === 2, linked?.notes?.[0]?.targets);
  check('跨图意见标了 linked', linked?.notes?.[0]?.linked === true, linked?.notes?.[0]?.linked);
  check('第二个目标是图2 的点', linked?.notes?.[0]?.targets?.[1]?.imageId === 'image_two' && linked.notes[0].targets[1].kind === 'point', linked?.notes?.[0]?.targets?.[1]);

  // 5. 撤销 / 重做。
  await run(`document.getElementById('undo').click()`);
  await sleep(700);
  const undone = JSON.parse((await run(`window.workspaceHost.__report().saves.at(-1)?.document`)) || '{}');
  check('撤销回到一个目标', undone?.notes?.[0]?.targets?.length === 1, undone?.notes?.[0]?.targets);
  await run(`document.getElementById('redo').click()`);
  await sleep(700);
  const redone = JSON.parse((await run(`window.workspaceHost.__report().saves.at(-1)?.document`)) || '{}');
  check('重做回到两个目标', redone?.notes?.[0]?.targets?.length === 2, redone?.notes?.[0]?.targets);

  // 6. 纯色遮盖：图2 圈一块。
  await run(`document.querySelector('.ws-tool[data-tool="mask"]').click()`);
  const m1 = pointIn(geometry.b, 0.2, 0.2), m2 = pointIn(geometry.b, 0.5, 0.5);
  await dispatch('pointerdown', m1.x, m1.y);
  await dispatch('pointermove', m2.x, m2.y);
  await dispatch('pointerup', m2.x, m2.y);
  await sleep(800);
  const masked = JSON.parse((await run(`window.workspaceHost.__report().saves.at(-1)?.document`)) || '{}');
  const masks = masked?.images?.[1]?.masks || [];
  check('图2 加了一块遮盖', masks.length === 1 && masks[0].color === '#ffffff', masks);
  check('遮盖矩形落在图2 源坐标内', Boolean(masks[0]) && masks[0].rect.width > 0 && masks[0].rect.x + masks[0].rect.width <= 360, masks[0]?.rect);

  // 7. “再指一处”：选中已有长意见，点按钮后再画一处 —— 追到同一号，原文不能丢。
  await run(`document.querySelector('.ws-tool[data-tool="select"]').click()`);
  const noteCenter = pointIn(geometry.a, 0.4, 0.42);
  await dispatch('pointerdown', noteCenter.x, noteCenter.y);
  await dispatch('pointerup', noteCenter.x, noteCenter.y);
  await sleep(120);
  await run(`document.getElementById('aimTarget').click()`);
  await run(`document.querySelector('.ws-tool[data-tool="annotate"]').click()`);
  const extra1 = pointIn(geometry.b, 0.55, 0.3), extra2 = pointIn(geometry.b, 0.8, 0.55);
  await dispatch('pointerdown', extra1.x, extra1.y);
  await dispatch('pointermove', extra2.x, extra2.y);
  await dispatch('pointerup', extra2.x, extra2.y);
  await sleep(800);
  const appended = JSON.parse((await run(`window.workspaceHost.__report().saves.at(-1)?.document`)) || '{}');
  check('再指一处不再弹输入框，直接追到同一条', (await run(`document.getElementById('composer').hidden`)) === true, null);
  check('追加目标后原文完整保留', appended?.notes?.[0]?.text === longNote, appended?.notes?.[0]?.text);
  check('追加目标后目标数 +1', appended?.notes?.[0]?.targets?.length === 3, appended?.notes?.[0]?.targets?.length);
  check('再指一处后仍是第 2 版（独立关系/草稿语义已启用）', appended?.schemaVersion === 2, appended?.schemaVersion);

  // 7b. 先标两处不给文字：先标后写，标完可以直接留着，不写假字。
  await run(`document.querySelector('.ws-tool[data-tool="annotate"]').click()`);
  const e1 = pointIn(geometry.a, 0.72, 0.78), e2 = pointIn(geometry.a, 0.9, 0.95);
  await dispatch('pointerdown', e1.x, e1.y);
  await dispatch('pointermove', e2.x, e2.y);
  await dispatch('pointerup', e2.x, e2.y);
  await sleep(150);
  const draftComposer = await run(`({ open: !document.getElementById('composer').hidden, text: document.getElementById('composerText').value })`);
  check('标好一处就出现输入框，但可以一个字都不写', draftComposer.open === true && draftComposer.text === '', draftComposer);
  await run(`document.getElementById('composerText').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(500);
  const firstDraft = JSON.parse((await run(`window.workspaceHost.__report().saves.at(-1)?.document`)) || '{}');
  check('空标记落库为草稿（文字为空，不是假字）', firstDraft?.notes?.length === 2 && firstDraft.notes[1].text === '', firstDraft?.notes?.map(note => note.text));

  const d1 = pointIn(geometry.b, 0.12, 0.15);
  await dispatch('pointerdown', d1.x, d1.y);
  await dispatch('pointerup', d1.x, d1.y);
  await sleep(150);
  await run(`document.getElementById('composerText').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(600);
  const twoDrafts = JSON.parse((await run(`window.workspaceHost.__report().saves.at(-1)?.document`)) || '{}');
  check('两处空白标记都留着', twoDrafts?.notes?.length === 3 && twoDrafts.notes[1].text === '' && twoDrafts.notes[2].text === '',
    twoDrafts?.notes?.map(note => note.text));

  // 7b-2. 版本高水位：撤销/重做也不能把已升到第 2 版的组拉回第 1 版。
  await run(`document.getElementById('undo').click()`);
  await sleep(700);
  const undoneDraft = JSON.parse((await run(`window.workspaceHost.__report().saves.at(-1)?.document`)) || '{}');
  check('撤销空目标后仍是第 2 版', undoneDraft?.schemaVersion === 2 && (undoneDraft?.notes?.length || 0) === 2,
    { version: undoneDraft?.schemaVersion, notes: undoneDraft?.notes?.length });
  await run(`document.getElementById('redo').click()`);
  await sleep(700);
  const redoneDraft = JSON.parse((await run(`window.workspaceHost.__report().saves.at(-1)?.document`)) || '{}');
  check('重做后仍是第 2 版且草稿回来', redoneDraft?.schemaVersion === 2 && redoneDraft?.notes?.length === 3,
    { version: redoneDraft?.schemaVersion, notes: redoneDraft?.notes?.length });

  // 7c. 成品导出必须被拦住，并指出缺在哪：草稿可以存，不能冒充写完。
  const beforeBlocked = await run('window.workspaceHost.__report()');
  await run(`document.getElementById('copyAll').click()`);
  await sleep(600);
  const blocked = await run('window.workspaceHost.__report()');
  const blockedUi = await run(`document.getElementById('exportInfo').textContent`);
  check('没写说明时复制被拦下', blocked.done === undefined && blocked.parts.length === beforeBlocked.parts.length, { done: blocked.done });
  check('拦截提示说清缺几处、缺在哪', /没写说明/.test(blockedUi) && /意见/.test(blockedUi), blockedUi);

  // 7d. 两个空标记 + 一条有字关系：选中一处 → 「关联…」→ 点另一处，Esc 不建、Enter 建。
  const blankBox = { x: geometry.a.left + geometry.a.width * 0.81, y: geometry.a.top + geometry.a.height * 0.86 };
  const blankPoint = { x: geometry.b.left + geometry.b.width * 0.12, y: geometry.b.top + geometry.b.height * 0.15 };
  const pickPair = async () => {
    await run(`document.querySelector('.ws-tool[data-tool="select"]').click()`);
    await dispatch('pointerdown', blankBox.x, blankBox.y);
    await dispatch('pointerup', blankBox.x, blankBox.y);
    await sleep(120);
    await run(`document.getElementById('linkPick').click()`);
    await sleep(80);
    await dispatch('pointerdown', blankPoint.x, blankPoint.y);
    await dispatch('pointerup', blankPoint.x, blankPoint.y);
    await sleep(150);
    return run(`({ open: !document.getElementById('composer').hidden, hint: document.getElementById('composerHint').textContent })`);
  };
  const relationComposer = await pickPair();
  check('关联已有两处时弹出关系说明输入', relationComposer.open === true, relationComposer);
  await run(`document.getElementById('composerText').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(600);
  const canceled = JSON.parse((await run(`window.workspaceHost.__report().saves.at(-1)?.document`)) || '{}');
  check('关系取消不留半成品', (canceled?.relations?.length || 0) === 0, canceled?.relations);

  const relationText = '这两处颜色一致';
  await pickPair();
  await run(`(() => {
    const area = document.getElementById('composerText');
    area.value = ${JSON.stringify(relationText)};
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: false }));
    return true;
  })()`);
  await sleep(800);
  const related = JSON.parse((await run(`window.workspaceHost.__report().saves.at(-1)?.document`)) || '{}');
  const relation = related?.relations?.[0];
  check('两处已有目标建立了一条关系', related?.relations?.length === 1, related?.relations);
  check('关系文字独立保存', relation?.text === relationText, relation?.text);
  check('关系两端引用稳定目标，不抄几何', Boolean(relation?.ends?.[0]?.targetId) && Boolean(relation?.ends?.[1]?.targetId)
    && !('rect' in relation.ends[0]) && !('point' in relation.ends[0]), relation?.ends);
  check('两处各自的文字没被合并或改动', related?.notes?.[1]?.text === '' && related?.notes?.[2]?.text === ''
    && related?.notes?.[0]?.text === longNote, related?.notes?.map(note => note.text));

  // 7d-2. Shift 点击两处 → 「关联所选」：与「关联…」是两条独立路径。
  // 用“带字意见的目标 + 另一张图上的点”，避开已被 7d 关联的那一对（同一对只能有一条关系）。
  await run(`document.querySelector('.ws-tool[data-tool="select"]').click()`);
  const shiftFirst = pointIn(geometry.a, 0.4, 0.42);
  await dispatch('pointerdown', shiftFirst.x, shiftFirst.y);
  await dispatch('pointerup', shiftFirst.x, shiftFirst.y);
  await sleep(150);
  await run(`(() => {
    const stage = document.getElementById('stage');
    const at = { clientX: ${blankPoint.x}, clientY: ${blankPoint.y}, pointerId: 11, button: 0 };
    stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, ...at, buttons: 1, shiftKey: true }));
    stage.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, ...at, buttons: 0, shiftKey: true }));
    return true;
  })()`);
  await sleep(200);
  const twoSelected = await run(`({ disabled: document.getElementById('linkSelected').disabled, count: window.__workspaceDebug().selection.length })`);
  check('Shift 点击加选到两处', twoSelected.disabled === false && twoSelected.count === 2, twoSelected);
  await run(`document.getElementById('linkSelected').click()`);
  await sleep(200);
  const shiftRelationText = '这两处形状一样';
  await run(`(() => {
    const area = document.getElementById('composerText');
    area.value = ${JSON.stringify(shiftRelationText)};
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: false }));
    return true;
  })()`);
  await sleep(800);
  const shiftSaved = JSON.parse((await run(`window.workspaceHost.__report().saves.at(-1)?.document`)) || '{}');
  const shiftRelation = (shiftSaved.relations || []).at(-1);
  const endsValid = Boolean(shiftRelation) && shiftRelation.ends.length === 2
    && shiftRelation.ends.every(end => (shiftSaved.notes || []).some(note => note.id === end.noteId
      && note.targets.some(target => target.id === end.targetId)));
  check('关联所选建出的关系两端指向刚选的两处', shiftRelation?.text === shiftRelationText && endsValid, shiftRelation);

  // 7e. 未按回车直接「复制说明」：先把输入存进库，再让 main 重新读库生成说明。
  await run(`document.querySelector('.ws-tool[data-tool="select"]').click()`);
  const copyCenter = pointIn(geometry.a, 0.4, 0.42);
  await dispatch('pointerdown', copyCenter.x, copyCenter.y);
  await dispatch('pointerup', copyCenter.x, copyCenter.y);
  await sleep(150);
  await run(`document.getElementById('editNote').click()`);
  await sleep(150);
  const baseText = await run(`document.getElementById('composerText').value`);
  const copyMarker = '｜复制前没按回车';
  await run(`(() => {
    const area = document.getElementById('composerText');
    area.value = ${JSON.stringify(`${baseText}${copyMarker}`)};
    area.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(150);
  const copiesBefore = (await run('window.workspaceHost.__report()')).copyNotesCalls || 0;
  await run(`document.getElementById('copyNotes').click()`);
  await sleep(900);
  const copyReport = await run('window.workspaceHost.__report()');
  const copiedDocument = copyReport.copiedDocument ? JSON.parse(copyReport.copiedDocument) : undefined;
  check('未按回车直接复制说明：先落盘再复制',
    (copyReport.copyNotesCalls || 0) === copiesBefore + 1 && String(copiedDocument?.notes?.[0]?.text || '').includes(copyMarker),
    { calls: copyReport.copyNotesCalls, text: copiedDocument?.notes?.[0]?.text });

  // 8. pointercancel：画到一半被打断，不能把半截当提交。
  await run(`document.querySelector('.ws-tool[data-tool="annotate"]').click()`);
  const beforeCancel = related?.notes?.length || 0;
  const c1 = pointIn(geometry.a, 0.1, 0.1), c2 = pointIn(geometry.a, 0.3, 0.3);
  await dispatch('pointerdown', c1.x, c1.y);
  await dispatch('pointermove', c2.x, c2.y);
  await run(`(() => { document.getElementById('stage').dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 7 })); return true; })()`);
  await sleep(700);
  const afterCancel = JSON.parse((await run(`window.workspaceHost.__report().saves.at(-1)?.document`)) || '{}');
  const composerStillHidden = await run(`document.getElementById('composer').hidden`);
  check('pointercancel 不提交半截框', (afterCancel?.notes?.length || 0) === beforeCancel && composerStillHidden === true,
    { notes: afterCancel?.notes?.length, hidden: composerStillHidden });

  // 9. 预览缓存有界：预算 64MiB，且每张预览 ≤ 2M 像素。
  const stats = await run('window.__workspaceStats()');
  check('预览缓存记着预算且不超 64MiB', stats.previewBytes <= 64 * 1024 * 1024, stats);
  check('预览缓存条目不超过图块数', stats.previews <= 2, stats);

  // 11. 停止导出：编码/交付途中点“停止”，不得发布整组、不得把半组说成完成。
  await run(`document.getElementById('copyAll').click()`);
  await sleep(320);
  await run(`document.getElementById('stopExport').click()`);
  await sleep(1200);
  const stopped = await run('window.workspaceHost.__report()');
  check('停止后没有完成发布', stopped.done === undefined, { done: stopped.done, aborted: stopped.aborted, parts: stopped.parts.length });
  check('停止确实把批次退了', stopped.aborted.length === 1, stopped.aborted);
  const stopUi = await run(`({ text: document.getElementById('exportInfo').textContent, hidden: document.getElementById('stopExport').hidden })`);
  check('停止后状态栏如实说已停止且按钮收回', /停止/.test(stopUi.text) && stopUi.hidden === true, stopUi);

  // 12. begin 期间停止：批次回来后要立刻退掉，不渲染、不交 part，后续还能再导出。
  const beforeBeginStop = await run('window.workspaceHost.__report()');
  await run(`document.getElementById('copyAll').click()`);
  await sleep(150); // 此时还在 delayBeginMs 里，exportBatch 尚未赋值
  await run(`document.getElementById('stopExport').click()`);
  await sleep(1400);
  const afterBeginStop = await run('window.workspaceHost.__report()');
  check('begin 期间停止：没有交任何 part', afterBeginStop.parts.length === beforeBeginStop.parts.length,
    { before: beforeBeginStop.parts.length, after: afterBeginStop.parts.length });
  check('begin 期间停止：批次确实被退掉', afterBeginStop.aborted.length === beforeBeginStop.aborted.length + 1,
    afterBeginStop.aborted);
  check('begin 期间停止：没有完成发布', afterBeginStop.done === undefined, afterBeginStop.done);

  // 13. 同一窗口再导出一次：不能因为上一次没收干净而卡在“上次导出还没结束”。
  await run(`document.getElementById('copyAll').click()`);
  let afterRetry;
  const retryDeadline = Date.now() + 15000;
  do {
    await sleep(300);
    afterRetry = await run('window.workspaceHost.__report()');
  } while (!afterRetry.done && Date.now() < retryDeadline);
  check('停止后再次导出能成功', Boolean(afterRetry.done) && afterRetry.done.kind === 'copy',
    { done: afterRetry.done && afterRetry.done.kind, parts: afterRetry.parts.length });

  // 10. 保存状态与提示没有报错。
  const ui = await run(`({ save: document.getElementById('saveState').textContent, hint: document.getElementById('hint').textContent })`);
  check('保存状态显示已保存', ui.save === '已保存', ui);
  check('页面没有脚本错误', consoleLines.filter(line => line.startsWith('preload-error') || line.startsWith('3:')).length === 0, consoleLines);

  // 14. 改说明输入一半就关窗：没提交的字也必须算未保存，先存进模型再关。
  await run(`document.querySelector('.ws-tool[data-tool="select"]').click()`);
  const closingCenter = pointIn(geometry.a, 0.4, 0.42);
  await dispatch('pointerdown', closingCenter.x, closingCenter.y);
  await dispatch('pointerup', closingCenter.x, closingCenter.y);
  await sleep(150);
  check('选中单处时出现「改说明」', (await run(`!document.getElementById('editNote').disabled`)) === true, null);
  await run(`document.getElementById('editNote').click()`);
  await sleep(150);
  const pendingText = `${longNote}｜关窗前补的一句`;
  await run(`(() => {
    const area = document.getElementById('composerText');
    area.value = ${JSON.stringify(pendingText)};
    area.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(150);
  const dirtyWhileTyping = await run(`window.workspaceHost.__report().dirty.at(-1)`);
  check('没提交的输入也算未保存编辑', dirtyWhileTyping === true, dirtyWhileTyping);
  await run(`window.workspaceHost.__requestClose()`);
  await sleep(250);
  const bannerState = await run(`({ open: !document.getElementById('banner').hidden, closed: window.workspaceHost.__report().closed })`);
  check('有未提交输入时关窗先弹确认', bannerState.open === true, bannerState);
  check('仅弹确认时不关窗', bannerState.closed === 0, bannerState);
  await run(`document.getElementById('bannerYes').click()`);
  await sleep(1000);
  const closeReport = await run('window.workspaceHost.__report()');
  const closeDocument = closeReport.saves.length ? JSON.parse(closeReport.saves.at(-1).document) : {};
  check('确认关窗前把没提交的输入存进模型',
    String(closeDocument?.notes?.[0]?.text || '').includes('关窗前补的一句'), closeDocument?.notes?.[0]?.text);
  check('存完才真正关窗', closeReport.closed === 1, closeReport.closed);
  check('关窗前最后上报的不再是脏', closeReport.dirty.at(-1) === false, closeReport.dirty.at(-1));

  // 14b. 保存失败：既不关窗也不导出；恢复后才清掉过时提示并关窗。
  await run(`document.querySelector('.ws-tool[data-tool="select"]').click()`);
  await dispatch('pointerdown', closingCenter.x, closingCenter.y);
  await dispatch('pointerup', closingCenter.x, closingCenter.y);
  await sleep(150);
  await run(`document.getElementById('editNote').click()`);
  await sleep(150);
  await run(`(() => {
    const area = document.getElementById('composerText');
    area.value = '这一句会碰上保存失败';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await run(`window.workspaceHost.__failNextSave()`);
  const failBase = await run('window.workspaceHost.__report()');
  const closedBeforeFail = failBase.closed;
  const partsBeforeFail = failBase.parts.length;
  const begunBeforeFail = failBase.begun.length;
  const copiesBeforeFail = failBase.copyNotesCalls || 0;
  // 导出：屏障拦下，不能把旧版本发出去。
  await run(`document.getElementById('copyAll').click()`);
  await sleep(900);
  const afterFailExport = await run(`({ closed: window.workspaceHost.__report().closed, parts: window.workspaceHost.__report().parts.length,
    begun: window.workspaceHost.__report().begun.length, copies: window.workspaceHost.__report().copyNotesCalls || 0,
    save: document.getElementById('saveState').textContent, hint: document.getElementById('hint').textContent,
    exportInfo: document.getElementById('exportInfo').textContent })`);
  check('保存失败时不导出', afterFailExport.begun === begunBeforeFail && afterFailExport.parts === partsBeforeFail,
    afterFailExport);
  check('保存失败时不复制说明', afterFailExport.copies === copiesBeforeFail, afterFailExport);
  check('保存失败状态与提示一致', afterFailExport.save === '保存失败' && /没能保存/.test(afterFailExport.hint),
    { save: afterFailExport.save, hint: afterFailExport.hint });
  check('导出提示说清是没存进这组', /没存进/.test(afterFailExport.exportInfo), afterFailExport.exportInfo);
  // 关窗：同样被拦下，不把改动丢了就关。
  await run(`document.getElementById('bannerYes').click()`);
  await sleep(900);
  const afterFailClose = await run(`({ closed: window.workspaceHost.__report().closed, save: document.getElementById('saveState').textContent, hint: document.getElementById('hint').textContent })`);
  check('保存失败时不关窗', afterFailClose.closed === closedBeforeFail, afterFailClose);
  // 模型再改一次会让保存再试一轮；成功后才允许关，并把过时的失败提示换掉。
  await run(`document.getElementById('editNote').click()`);
  await sleep(150);
  await run(`(() => {
    const area = document.getElementById('composerText');
    area.value = '这一句已经能存了';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: false }));
    return true;
  })()`);
  await sleep(600);
  await run(`document.getElementById('bannerYes').click()`);
  await sleep(1200);
  const recovered = await run(`({ closed: window.workspaceHost.__report().closed, save: document.getElementById('saveState').textContent, hint: document.getElementById('hint').textContent })`);
  check('恢复后能保存并关窗', recovered.closed === closedBeforeFail + 1, recovered);
  check('恢复后清掉过时的失败提示', recovered.save === '已保存' && /已经存好了/.test(recovered.hint), recovered);

  // 15. 输入一半点关系标签：旧输入先归位，不被关系输入框覆盖掉。
  await run(`document.querySelector('.ws-tool[data-tool="select"]').click()`);
  await dispatch('pointerdown', closingCenter.x, closingCenter.y);
  await dispatch('pointerup', closingCenter.x, closingCenter.y);
  await sleep(150);
  await run(`document.getElementById('editNote').click()`);
  await sleep(120);
  const halfTyped = `${pendingText}｜点关系前的一段`;
  await run(`(() => {
    const area = document.getElementById('composerText');
    area.value = ${JSON.stringify(halfTyped)};
    area.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(120);
  await run(`(() => {
    const label = document.querySelector('.ws-relation-text');
    if (!label) return false;
    const rect = label.getBoundingClientRect();
    label.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, pointerId: 9, button: 0 }));
    return true;
  })()`);
  await sleep(500);
  const afterRelationClick = JSON.parse((await run(`window.workspaceHost.__report().saves.at(-1)?.document`)) || '{}');
  check('点关系标签前旧输入已入模型', String(afterRelationClick?.notes?.[0]?.text || '').includes('点关系前的一段'),
    afterRelationClick?.notes?.[0]?.text);
  const relationSelected = await run(`!document.getElementById('editRelation').disabled`);
  check('点可见关系标签就能选中关系', relationSelected === true, relationSelected);

  const barLater = await run(`({ h: document.querySelector('.ws-toolbar').getBoundingClientRect().height, top: document.getElementById('stage').getBoundingClientRect().top })`);
  check('工具栏高度到中段', true, barLater);

  // 16. 命中优先级：先放点、再用大框圈住它，点仍然选得中；嵌套框各自可选中。
  await run(`document.querySelector('.ws-tool[data-tool="annotate"]').click()`);
  const countBeforePoint = (await run(`window.__workspaceDebug().targets`)).length;
  const pointSpot = pointIn(geometry.b, 0.85, 0.85);
  await dispatch('pointerdown', pointSpot.x, pointSpot.y);
  await dispatch('pointerup', pointSpot.x, pointSpot.y);
  await sleep(200);
  await run(`document.getElementById('composerText').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(200);
  const countAfterPoint = (await run(`window.__workspaceDebug().targets`)).length;
  check('命中测试前提：先放下一个点', countAfterPoint === countBeforePoint + 1, { countBeforePoint, countAfterPoint });
  const boxStart = pointIn(geometry.b, 0.6, 0.6), boxEnd = pointIn(geometry.b, 0.98, 0.98);
  await dispatch('pointerdown', boxStart.x, boxStart.y);
  await dispatch('pointermove', boxEnd.x, boxEnd.y);
  await dispatch('pointerup', boxEnd.x, boxEnd.y);
  await sleep(200);
  await run(`document.getElementById('composerText').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(400);
  const countAfterOuter = (await run(`window.__workspaceDebug().targets`)).length;
  check('命中测试前提：大框圈住了点', countAfterOuter === countAfterPoint + 1, { countAfterPoint, countAfterOuter });
  await run(`document.querySelector('.ws-tool[data-tool="select"]').click()`);
  await dispatch('pointerdown', pointSpot.x, pointSpot.y);
  await dispatch('pointerup', pointSpot.x, pointSpot.y);
  await sleep(200);
  const pointHint = await run(`document.getElementById('hint').textContent`);
  check('被大框圈住的点仍优先命中点', /的点/.test(pointHint), pointHint);
  // 再画一个嵌套小框，点它的中心应选到小框；点大框内侧空白应选大框。
  const innerStart = pointIn(geometry.b, 0.62, 0.62), innerEnd = pointIn(geometry.b, 0.76, 0.76);
  await run(`document.querySelector('.ws-tool[data-tool="annotate"]').click()`);
  await dispatch('pointerdown', innerStart.x, innerStart.y);
  await dispatch('pointermove', innerEnd.x, innerEnd.y);
  await dispatch('pointerup', innerEnd.x, innerEnd.y);
  await sleep(200);
  await run(`document.getElementById('composerText').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(400);
  const countAfterInner = (await run(`window.__workspaceDebug().targets`)).length;
  check('命中测试前提：内框已画好', countAfterInner === countAfterOuter + 1, { countAfterOuter, countAfterInner });
  await run(`document.querySelector('.ws-tool[data-tool="select"]').click()`);
  const innerCenter = pointIn(geometry.b, 0.69, 0.69);
  await dispatch('pointerdown', innerCenter.x, innerCenter.y);
  await dispatch('pointerup', innerCenter.x, innerCenter.y);
  await sleep(200);
  const innerHint = await run(`document.getElementById('hint').textContent`);
  const innerProbe = await run(`({ probe: window.__workspaceHitTest(${innerCenter.x}, ${innerCenter.y}), rects: window.__workspaceDebug().targets.map(t => ({ n: t.noteNumber, id: t.id, k: t.kind, r: t.rect, p: t.point })), selected: window.__workspaceDebug().activeTargetId })`);
  const outerOnly = pointIn(geometry.b, 0.85, 0.92);
  await dispatch('pointerdown', outerOnly.x, outerOnly.y);
  await dispatch('pointerup', outerOnly.x, outerOnly.y);
  await sleep(200);
  const outerHint = await run(`document.getElementById('hint').textContent`);
  const nestedDebug = await run(`window.__workspaceDebug()`);
  check('嵌套框：内框里选到内框', /的点|的框/.test(innerHint) && innerHint !== outerHint, { innerHint, outerHint, innerProbe });

  // 17. 关系线不垄断指针：圈点工具在线上起笔仍是画批注；空格拖是平移。
  const beforeLineDraw = JSON.parse((await run(`window.workspaceHost.__report().saves.at(-1)?.document`)) || '{}');
  await run(`document.querySelector('.ws-tool[data-tool="annotate"]').click()`);
  // blankBox 的中心就在那条关系的线头上，用它起笔能证明线没把指针吞掉。
  await dispatch('pointerdown', blankBox.x, blankBox.y);
  await dispatch('pointermove', blankBox.x + 30, blankBox.y + 20);
  await dispatch('pointerup', blankBox.x + 30, blankBox.y + 20);
  await sleep(300);
  const lineDrawComposer = await run(`!document.getElementById('composer').hidden`);
  check('圈点工具在关系线上起笔仍建新标记', lineDrawComposer === true, lineDrawComposer);
  await run(`document.getElementById('composerText').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(500);
  const afterLineDraw = JSON.parse((await run(`window.workspaceHost.__report().saves.at(-1)?.document`)) || '{}');
  check('在线上起笔没有变成选关系', (afterLineDraw?.notes?.length || 0) === (beforeLineDraw?.notes?.length || 0) + 1,
    { before: beforeLineDraw?.notes?.length, after: afterLineDraw?.notes?.length });
  await run(`document.querySelector('.ws-tool[data-tool="select"]').click()`);
  // 先清掉选中：否则按下的位置可能正落在刚画那块的拉线把手上，变成拉线而不是平移。
  await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(150);
  const transformBefore = await run(`document.getElementById('world').style.transform`);
  await run(`document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }))`);
  const spaceDebug = await run(`window.__workspaceDebug()`);
  await dispatch('pointerdown', blankBox.x, blankBox.y);
  const panDebug = await run(`window.__workspaceDebug()`);
  await dispatch('pointermove', blankBox.x + 40, blankBox.y + 30);
  await dispatch('pointerup', blankBox.x + 40, blankBox.y + 30);
  await sleep(200);
  await run(`document.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true }))`);
  const transformAfter = await run(`document.getElementById('world').style.transform`);
  const relationStillSelected = await run(`!document.getElementById('editRelation').disabled`);
  check('空格在线上拖是平移，不选关系', transformBefore !== transformAfter && relationStillSelected === false,
    { transformBefore, transformAfter, relationStillSelected, before: { space: spaceDebug.space, editing: spaceDebug.editing, drag: spaceDebug.drag, tool: spaceDebug.tool }, after: { drag: panDebug.drag, tool: panDebug.tool, editing: panDebug.editing } });

  // 18. 已经是圈点工具时直接「关联…」再点已有目标：不能变成新建空标记。
  await run(`document.querySelector('.ws-tool[data-tool="select"]').click()`);
  await dispatch('pointerdown', blankBox.x, blankBox.y);
  await dispatch('pointerup', blankBox.x, blankBox.y);
  await sleep(150);
  await run(`document.querySelector('.ws-tool[data-tool="annotate"]').click()`);
  await sleep(150);
  const beforePickSecond = JSON.parse((await run(`window.workspaceHost.__report().saves.at(-1)?.document`)) || '{}');
  const pickBefore = await run(`({ disabled: document.getElementById('linkPick').disabled, debug: window.__workspaceDebug() })`);
  await run(`document.getElementById('linkPick').click()`);
  await sleep(120);
  const pickAfter = await run(`window.__workspaceDebug()`);
  const existingTarget = pointIn(geometry.a, 0.4, 0.42);
  await dispatch('pointerdown', existingTarget.x, existingTarget.y);
  await dispatch('pointerup', existingTarget.x, existingTarget.y);
  await sleep(300);
  const pickComposer = await run(`({ open: !document.getElementById('composer').hidden, hint: document.getElementById('composerHint').textContent })`);
  const notesWhilePicking = await run(`document.getElementById('fileInfo').textContent`);
  check('不切工具也能点中第二端并弹关系输入', pickComposer.open === true && /关系/.test(pickComposer.hint), { pickComposer, pickBefore: { disabled: pickBefore.disabled, tool: pickBefore.debug.tool, selection: pickBefore.debug.selection.length }, pickAfter: { linkPick: pickAfter.linkPick, tool: pickAfter.tool } });
  const afterPick = JSON.parse((await run(`window.workspaceHost.__report().saves.at(-1)?.document`)) || '{}');
  check('等第二端时没有多建空标记', (afterPick?.notes?.length || 0) === (beforePickSecond?.notes?.length || 0),
    { before: beforePickSecond?.notes?.length, after: afterPick?.notes?.length, info: notesWhilePicking });
  await run(`document.getElementById('composerText').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(400);

  // 7f. 保存屏障：A 挂起时提交 B，A 回来不能把 B 当已存，关窗必须等 B 落盘。
  await run(`document.querySelector('.ws-tool[data-tool="select"]').click()`);
  const barrierCenter = pointIn(geometry.a, 0.4, 0.42);
  await dispatch('pointerdown', barrierCenter.x, barrierCenter.y);
  await dispatch('pointerup', barrierCenter.x, barrierCenter.y);
  await sleep(150);
  await run(`window.workspaceHost.__holdNextSave()`);
  await run(`document.getElementById('editNote').click()`);
  await sleep(120);
  const baseForHold = await run(`document.getElementById('composerText').value`);
  const textA = `${baseForHold}｜A`;
  const textB = `${baseForHold}｜B`;
  await run(`(() => {
    const area = document.getElementById('composerText');
    area.value = ${JSON.stringify(textA)};
    area.dispatchEvent(new Event('input', { bubbles: true }));
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: false }));
    return true;
  })()`);
  await sleep(700); // 350ms 防抖后 A 开始保存并被挂住
  const savesWhileHeld = (await run('window.workspaceHost.__report()')).saves.length;
  await run(`document.getElementById('editNote').click()`);
  await sleep(120);
  await run(`(() => {
    const area = document.getElementById('composerText');
    area.value = ${JSON.stringify(textB)};
    area.dispatchEvent(new Event('input', { bubbles: true }));
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: false }));
    return true;
  })()`);
  await sleep(120);
  const closedBeforeBarrier = (await run('window.workspaceHost.__report()')).closed;
  await run(`window.workspaceHost.__releaseSave()`);
  await run(`window.workspaceHost.__requestClose()`);
  await run(`document.getElementById('bannerYes').click()`);
  await sleep(1500);
  const barrierReport = await run('window.workspaceHost.__report()');
  const barrierDocument = barrierReport.saves.length ? JSON.parse(barrierReport.saves.at(-1).document) : {};
  check('A 挂起时提交的 B 必须被存到', String(barrierDocument?.notes?.[0]?.text || '').includes('｜B'),
    barrierDocument?.notes?.[0]?.text);
  check('关窗等到最新一轮存完', barrierReport.closed === closedBeforeBarrier + 1 && barrierReport.saves.length >= savesWhileHeld + 2,
    { closed: barrierReport.closed, saves: barrierReport.saves.length, savesWhileHeld });

  // 7g. B 保存失败：不关窗、不导出；模型再改一次才重试成功。
  await run(`window.workspaceHost.__holdNextSave()`);
  await run(`document.getElementById('editNote').click()`);
  await sleep(120);
  await run(`(() => {
    const area = document.getElementById('composerText');
    area.value = ${JSON.stringify('保存会失败的C')};
    area.dispatchEvent(new Event('input', { bubbles: true }));
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: false }));
    return true;
  })()`);
  await sleep(700); // C 被挂住
  await run(`document.getElementById('editNote').click()`);
  await sleep(120);
  await run(`(() => {
    const area = document.getElementById('composerText');
    area.value = ${JSON.stringify('等待保存的D')};
    area.dispatchEvent(new Event('input', { bubbles: true }));
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: false }));
    return true;
  })()`);
  await sleep(120);
  await run(`window.workspaceHost.__failNextSave()`);
  const failBase2 = await run('window.workspaceHost.__report()');
  const partsBeforeFail2 = failBase2.parts.length;
  const begunBeforeFail2 = failBase2.begun.length;
  const closedBeforeFail2 = failBase2.closed;
  await run(`window.workspaceHost.__releaseSave()`);
  await sleep(1200);
  const afterFail2 = await run(`({ save: document.getElementById('saveState').textContent, hint: document.getElementById('hint').textContent,
    closed: window.workspaceHost.__report().closed, parts: window.workspaceHost.__report().parts.length })`);
  check('B 保存失败：状态与提示一致', afterFail2.save === '保存失败' && /没能保存/.test(afterFail2.hint), afterFail2);
  await run(`document.getElementById('copyAll').click()`);
  await sleep(800);
  const afterFail2Export = await run(`({ parts: window.workspaceHost.__report().parts.length, begun: window.workspaceHost.__report().begun.length })`);
  check('B 保存失败：不导出', afterFail2Export.begun === begunBeforeFail2 && afterFail2Export.parts === partsBeforeFail2, afterFail2Export);
  await run(`document.getElementById('bannerYes').click()`);
  await sleep(800);
  const afterFail2Close = await run(`({ closed: window.workspaceHost.__report().closed })`);
  check('B 保存失败：不关窗', afterFail2Close.closed === closedBeforeFail2, afterFail2Close);
  // 模型再改一次，屏障重试成功后再关，并把过时提示换掉。
  await run(`document.getElementById('editNote').click()`);
  await sleep(120);
  await run(`(() => {
    const area = document.getElementById('composerText');
    area.value = ${JSON.stringify('最后这句能存下')};
    area.dispatchEvent(new Event('input', { bubbles: true }));
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: false }));
    return true;
  })()`);
  await sleep(600);
  await run(`document.getElementById('bannerYes').click()`);
  await sleep(1200);
  const recovered2 = await run(`({ closed: window.workspaceHost.__report().closed, save: document.getElementById('saveState').textContent, hint: document.getElementById('hint').textContent })`);
  check('恢复后能关窗并清掉过时提示',
    recovered2.closed === closedBeforeFail2 + 1 && recovered2.save === '已保存' && /已经存好了/.test(recovered2.hint), recovered2);

  const layoutEnd = await run(`({ bar: Math.round(document.querySelector('.ws-toolbar').getBoundingClientRect().height), stageTop: document.getElementById('stage').getBoundingClientRect().top })`);
  check('整轮下来工具栏与画布位置不变', layoutStart.bar === layoutEnd.bar && layoutStart.stageTop === layoutEnd.stageTop,
    { layoutStart, layoutEnd });

  const report = await run('window.workspaceHost.__report()');
  win.destroy();
  console.info(JSON.stringify({ ok: failures.length === 0, failures, results, saves: report.saves.length, consoleLines }, null, 2));
  app.exit(failures.length === 0 ? 0 : 1);
}

// 独立临时 profile：在 app ready 之前把 userData/sessionData 指到本次临时目录，
// 不读也不写真实 APPDATA，也不加载生产 main/index.cjs。
const e2eProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-interaction-profile-'));
const e2eSession = path.join(e2eProfile, 'session');
fs.mkdirSync(e2eSession, { recursive: true });
app.setPath('userData', e2eProfile);
app.setPath('sessionData', e2eSession);

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(main).catch(error => {
  console.error(JSON.stringify({ ok: false, error: String(error?.stack || error) }));
  app.exit(2);
});
