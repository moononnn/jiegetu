'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createDiagnostics, sanitize } = require('../main/diagnostics.cjs');
test('页面视口诊断保留有限尺寸与固定错误类别，不保留私密文本', () => {
 assert.deepEqual(sanitize({ viewportWidth:1536, viewportHeight:864, errorCode:'selection-viewport', errorMessage:'PRIVATE_TEXT', image:'PRIVATE' }), { viewportWidth:1536, viewportHeight:864, errorCode:'selection-viewport' });
 assert.deepEqual(sanitize({ viewportWidth:Infinity, viewportHeight:'PRIVATE', errorCode:'PRIVATE' }), {});
});
test('受保护浮条只记录模式和固定失败类别，不保存截图或任意错误文本',()=>{
 assert.deepEqual(sanitize({protectedBar:true,noBar:false,barProtected:true,cancelRegistered:true,png:'PRIVATE'}),{protectedBar:true,noBar:false,barProtected:true,cancelRegistered:true});
 for(const [text,code] of [['长截图浮条排除不可用','bar-protection-unavailable'],['长截图浮条排除状态或位置异常','bar-protection-invalid'],['长截图浮条排除已失效','bar-protection-lost'],['长截图浮条已隐藏','bar-hidden']])assert.deepEqual(sanitize({errorMessage:text+' PRIVATE'}),{errorCode:code});
});
test('无浮条模式只记录固定状态，快捷键失败有固定类别',()=>{
 assert.deepEqual(sanitize({reason:'no-space',noBar:true,escapeRegistered:true,cancelRegistered:true,keyText:'PRIVATE'}),{reason:'no-space',noBar:true,escapeRegistered:true,cancelRegistered:true});
 assert.deepEqual(sanitize({errorMessage:'全屏长截图快捷键未能注册 PRIVATE'}),{errorCode:'scroll-shortcut-unavailable'});
});
test('自动识别启动缓存不足记录固定错误类别，原始消息不落盘',()=>{
 assert.deepEqual(sanitize({errorName:'RangeError',errorMessage:'自动识别选区过大或缓存不足，请缩小选区或使用手动范围 PRIVATE_TEXT'}),{errorName:'RangeError',errorCode:'auto-cache-limit'});
});
test('旧手动范围拒绝只保留固定原因和错误类别，不保存原始消息',()=>{
 assert.deepEqual(sanitize({reason:'manual-content',errorMessage:'长截图已改为自动识别，不再接收手动正文范围 PRIVATE_TEXT',content:{top:1,bottom:2}}),{reason:'manual-content',errorCode:'manual-content-rejected'});
 assert.deepEqual(sanitize({reason:'PRIVATE_TEXT',errorMessage:'PRIVATE_TEXT'}),{errorCode:'unclassified'});
});
test('预览消失来源仅允许固定类别，任意文本不落盘',()=>{
 assert.deepEqual(sanitize({dismissSource:'context-menu',hasLongImage:true}),{dismissSource:'context-menu',hasLongImage:true});
 assert.deepEqual(sanitize({dismissSource:'PRIVATE_APP_OR_CLIPBOARD',source:'PRIVATE_TEXT'}),{});
});
test('自动适配只记录状态与数量，不保存二维模板或原始帧',()=>{
  assert.deepEqual(sanitize({kind:'learning',autoMode:true,contentTop:12,contentBottom:280,maskCount:2,complete:false,missingRanges:1,masks:[{private:'no'}],frames:['no'],warning:'no'}),{kind:'learning',autoMode:true,contentTop:12,contentBottom:280,maskCount:2,complete:false,missingRanges:1});
  assert.deepEqual(sanitize({kind:'occluded'}),{kind:'occluded'});
});
test('分阶段证据只接收固定枚举与数值，私聊/原帧/任意原因字符串仍被剔除',()=>{
 const fields={analysisStage:'closure',motionMethod:'features',motionSupport:.87654,motionCoverage:.42,closureShift:108,closureExpected:104,fixedCandidates:3,fixedUnknown:1,fixedEdgeLeft:0,fixedEdgeRight:343,fixedStopReason:'large-region'};
 assert.deepEqual(sanitize({...fields,image:{text:'PRIVATE'},frames:['PRIVATE'],source:'PRIVATE',points:[123]}),{...fields,motionSupport:.877});
 assert.deepEqual(sanitize({analysisStage:'PRIVATE',motionMethod:'PRIVATE',fixedStopReason:'PRIVATE',motionCoverage:'PRIVATE'}),{});
});
test('窄内容域诊断仅保留版本、宽度、列组与布尔结果，不记录像素或内容边界',()=>{
 const fields={motionProofVersion:2,motionDomainWidth:108,motionDomainColumns:4,motionDomainUsed:true,motionDomainBuild:false};
 assert.deepEqual(sanitize({...fields,proofDomain:{left:40,right:148},domainEdge:'PRIVATE',image:'PRIVATE',points:[1,2]}),fields);
 assert.deepEqual(sanitize({motionProofVersion:'PRIVATE',motionDomainWidth:Infinity,motionDomainColumns:NaN,motionDomainUsed:'PRIVATE',motionDomainBuild:1}),{});
});
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'longshot-diagnostic-test-'));
  const recorder = createDiagnostics({ directory, ...options });
  t.after(async () => { recorder.end(); await recorder.flush(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { recorder, directory, rows: () => fs.readFileSync(recorder.getFile(), 'utf8').trim().split('\n').map(JSON.parse) };
}
test('默认不记录、不新建报告；开启后按序写入并可封口', async t => {
  const { recorder: r, directory, rows } = fixture(t);
  assert.equal(r.record('sample', { height: 100 }), false);
  assert.deepEqual(fs.readdirSync(directory), []);
  r.start({ electron: '44.9.2', platform: 'win32' });
  for (let i = 1; i <= 20; i++) r.record('sample', { sampleIndex: i });
  r.end('completed'); assert.equal(r.record('sample'), false);
  await r.flush();
  const output = rows();
  assert.equal(output[0].event, 'diagnostic-start');
  assert.deepEqual(output.slice(1, -1).map(row => row.sampleIndex), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(output.at(-1).reason, 'completed');
  assert.equal(r.state().recording, false); assert.equal(r.state().writing, false);
});
test('窗口阶段事件真实落盘：window-created/fitted/loaded 与 selection-init 不再被白名单丢弃', async t => {
  const { recorder: r, rows } = fixture(t);
  r.start({ platform: 'win32' });
  for (const event of ['window-created', 'window-fitted', 'window-loaded', 'selection-init']) {
    assert.equal(r.record(event, { phase: 'loading' }), true, event);
  }
  assert.equal(r.record('window-unknown', { phase: 'loading' }), false);
  r.end('cancelled');
  await r.flush();
  assert.deepEqual(rows().slice(1, -1).map(row => row.event),
    ['window-created', 'window-fitted', 'window-loaded', 'selection-init']);
});
test('只保留允许的摘要，图片、指纹、剪贴板、按键、标题、路径和URL不能混入', async t => {
  const { recorder: r, rows } = fixture(t);
  r.start();
  assert.equal(r.record('PRIVATE_EVENT', { text: 'private' }), false);
  r.record('worker-error', { errorName: 'NotAllowedError', errorMessage: 'denied file:///C:/Users/private/a.js https://private.example/path data:image/png;base64,PRIVATE C:\\Users\\secret\\capture.png',
    png: 'PRIVATE_IMAGE', dataUrl: 'PRIVATE_IMAGE', fingerprint: [1, 2, 3], clipboard: 'PRIVATE_CLIP', key: 'PRIVATE_KEY', title: 'PRIVATE_TITLE', path: 'C:\\private',
    height: 120, shift: 3, score: 0.5, width: Infinity, videoTime: NaN });
  r.record('renderer-error', { errorName: 'PLAIN_PRIVATE_NAME', errorMessage: 'plain secret chat text SECRET_SENTENCE' });
  r.end('failed'); await r.flush();
  const raw = fs.readFileSync(r.getFile(), 'utf8');
  assert.doesNotMatch(raw, /PRIVATE|private|secret|SECRET_SENTENCE|C:\\|file:\/\/|https:\/\/|data:image/);
  assert.deepEqual(Object.keys(rows()[1]).sort(), ['atMs', 'errorCode', 'errorName', 'event', 'height', 'schema', 'score', 'shift', 'time'].sort());
  assert.equal(rows()[2].errorName, 'OtherError'); assert.equal(rows()[2].errorCode, 'unclassified');
  assert.deepEqual(sanitize({ errorMessage: '屏幕流尺寸不匹配 SECRET_SENTENCE' }), { errorCode: 'video-size-mismatch' });
  assert.deepEqual(sanitize({ width: -12.12345, extra: 1, ready: true, kind: 'forward', remoteVisibility: 'unobserved' }),
    { width: -12.123, ready: true, kind: 'forward', remoteVisibility: 'unobserved' });
});
test('预览与Esc诊断只记录就绪和重复标志，不记录按键文本或图片', async t => {
  const { recorder: r, rows } = fixture(t); r.start();
  assert.equal(r.record('escape-input', { phase: 'selecting', repeat: true, previewPending: true, key: 'PRIVATE_KEY' }), true);
  assert.equal(r.record('preview-dom-ready', { ready: true, hasLongImage: true, width: 363, height: 996, remoteVisibility: 'unobserved', png: 'PRIVATE_IMAGE' }), true);
  r.end('cancelled'); await r.flush();
  assert.equal(rows()[1].repeat, true); assert.equal(rows()[1].previewPending, true);
  assert.equal(rows()[2].ready, true); assert.equal(rows()[2].remoteVisibility, 'unobserved');
  assert.doesNotMatch(JSON.stringify(rows()), /PRIVATE|"key"|"png"/);
});

test('范围提示只保留就绪摘要和固定错误类别，不保留矩形坐标', async t => {
  const { recorder: r, rows } = fixture(t); r.start();
  assert.equal(r.record('mask-ready', { ready: true, hidden: false, remoteVisibility: 'unobserved', x: 123, regions: [{ x: 123 }] }), true);
  r.end(); await r.flush();
  assert.equal(rows()[1].ready, true); assert.equal(rows()[1].remoteVisibility, 'unobserved');
  assert.equal(rows()[1].x, undefined); assert.equal(rows()[1].regions, undefined);
  assert.deepEqual(sanitize({ errorMessage: '采集范围提示准备超时 PRIVATE' }), { errorCode: 'region-mask-timeout' });
});

test('前景匹配只记录覆盖率及证据数量，不记录边缘指纹、历史帧或可疑行位置', async t => {
  const { recorder: r, rows } = fixture(t); r.start();
  r.record('sample', { foreground: true, pending: true, coverage: .98675, movingRows: 85, movingColumns: 9,
    duplicateFrames: 3, queueFrames: 4, queueBytes: 1000, queueDropped: 2, cachedFrames: 3, cachedBytes: 900, cacheDropped: 1, replayedFrames: 2,
    captureDurationMs: 1.25, queueAgeMs: 90, reference: { dataUrl: 'PRIVATE' }, image: 'PRIVATE',
    background: [1, 2], detail: [3, 4], history: { previous: { rows: [5, 6] } }, suspects: [{ y: 512 }] });
  r.end(); await r.flush();
  assert.equal(rows()[1].foreground, true); assert.equal(rows()[1].pending, true);
  assert.equal(rows()[1].coverage, .987); assert.equal(rows()[1].movingRows, 85); assert.equal(rows()[1].movingColumns, 9);
  assert.equal(rows()[1].duplicateFrames, 3);
  assert.equal(rows()[1].queueFrames, 4); assert.equal(rows()[1].cachedBytes, 900); assert.equal(rows()[1].replayedFrames, 2);
  assert.equal(rows()[1].captureDurationMs, 1.25); assert.equal(rows()[1].queueAgeMs, 90);
  assert.equal(rows()[1].reference, undefined); assert.equal(rows()[1].image, undefined);
  assert.deepEqual(sanitize({ duplicateFrames: 'PRIVATE', history: 'PRIVATE' }), {});
  assert.doesNotMatch(JSON.stringify(rows()), /"background"|"detail"|"history"|"suspects"|"previous"|"y"/);
});

test('背景重铺只收计数与阶段布尔，图像/颜色/坐标/证据对象仍被拒', async t => {
  const { recorder: r, rows } = fixture(t); r.start();
  r.record('worker-finishing', { backgroundActive: false, backgroundRows: 0, backgroundPixels: 0, backgroundProcessed: true,
    backgroundChunks: 3, backgroundInvalidChunks: 1, backgroundMovingPixels: 12, backgroundMaskPixels: 40,
    backgroundTargetInvalidPixels: 5, backgroundSourceInvalidPixels: 6, backgroundColorMismatchPixels: 7,
    background: { rows: 3, pixels: 9 }, backgroundEvidence: { extend: { movingPixels: 12 } },
    backgroundColor: '#ff0000', backgroundRect: { x: 1, y: 2 }, backgroundPixelsList: [1, 2] });
  r.end(); await r.flush();
  const row = rows().find(row => row.event === 'worker-finishing');
  assert.equal(row.backgroundActive, false); assert.equal(row.backgroundPixels, 0); assert.equal(row.backgroundProcessed, true);
  assert.equal(row.backgroundChunks, 3); assert.equal(row.backgroundInvalidChunks, 1); assert.equal(row.backgroundMovingPixels, 12);
  assert.equal(row.backgroundMaskPixels, 40); assert.equal(row.backgroundTargetInvalidPixels, 5);
  assert.equal(row.backgroundSourceInvalidPixels, 6); assert.equal(row.backgroundColorMismatchPixels, 7);
  assert.deepEqual(sanitize({ background: {}, backgroundEvidence: { extend: {} }, backgroundColor: '#fff',
    backgroundRect: { x: 1 }, backgroundPixelsList: [1, 2], backgroundProcessed: 'true', backgroundChunks: 'PRIVATE' }), {});
});

test('正常长截图自动记录：轮换专用槽，快速连开也不串写、不改旧手动报告', async t => {
  const { recorder: r, directory } = fixture(t, { maxAutomaticReports: 2 });
  r.start(); r.end('completed'); await r.flush();
  const manual = r.getFile(), original = fs.readFileSync(manual, 'utf8');
  for (let i = 0; i < 5; i++) {
    r.startAutomatic(); r.record('sample', { sampleIndex: i });
    r.record('commit-end', { action: 'copy', ok: true, file: 'PRIVATE_PATH', clipboard: 'PRIVATE_IMAGE' }); r.end('completed');
  }
  await r.flush();
  const names = fs.readdirSync(directory).filter(name => name.startsWith('auto-')).sort();
  assert.equal(names.length, 2); assert.equal(fs.readFileSync(manual, 'utf8'), original);
  for (const [slot, expected] of [[0, 4], [1, 3]]) {
    const raw = fs.readFileSync(path.join(directory, names[slot]), 'utf8'), rows = raw.trim().split('\n').map(JSON.parse);
    assert.equal(rows.filter(row => row.event === 'diagnostic-start').length, 1);
    assert.equal(rows[0].mode, 'automatic'); assert.equal(rows.find(row => row.event === 'sample').sampleIndex, expected);
    assert.equal(rows.at(-1).event, 'diagnostic-end'); assert.doesNotMatch(raw, /PRIVATE/);
  }
  const future = new Date(Date.now() + 1000); fs.utimesSync(r.getFile(), future, future);
  const reopened = createDiagnostics({ directory, maxAutomaticReports: 2 });
  assert.equal(reopened.getFile(), r.getFile()); assert.equal(reopened.state().recording, false);
  reopened.startAutomatic(); reopened.end(); await reopened.flush();
  assert.match(reopened.getFile(), /auto-longshot-01\.jsonl$/);
});
test('自动详细采样超时不封口：保存、复制、取消结果仍可记录', async t => {
  const { recorder: r, rows } = fixture(t, { durationMs: 15 }); r.startAutomatic();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(r.state().recording, true); assert.equal(r.state().limited, true);
  assert.equal(r.record('sample', { sampleIndex: 99 }), true);
  r.record('worker-finishing', { reason: 'manual-stop', duplicateFrames: 7 });
  r.record('selection-dismiss', { dismissSource: 'context-menu', hasLongImage: true });
  r.record('commit-start', { action: 'copy' }); r.record('commit-end', { action: 'copy', ok: true });
  r.record('capture-end', { reason: 'completed' }); r.end('completed'); await r.flush();
  assert.ok(rows().some(row => row.event === 'diagnostic-limited' && row.reason === 'timeout'));
  assert.ok(!rows().some(row => row.sampleIndex === 99));
  assert.equal(rows().find(row => row.event === 'commit-end').ok, true);
  assert.equal(rows().find(row => row.event === 'selection-dismiss').dismissSource,'context-menu');
  assert.equal(rows().at(-1).reason, 'completed');
});
test('自动条数上限为结束事件预留空间，重复提交也不会无限增长', async t => {
  const { recorder: r, rows } = fixture(t, { maxEvents: 4 }); r.startAutomatic();
  for (let i = 0; i < 100; i++) r.record('sample', { sampleIndex: i });
  assert.equal(r.state().recording, true); assert.equal(r.state().limited, true);
  for (let i = 0; i < 100; i++) r.record('commit-end', { action: 'save', ok: false, canceled: true });
  r.record('capture-end', { reason: 'cancelled' }); r.end('cancelled'); await r.flush();
  assert.ok(rows().length <= 38); assert.equal(rows().at(-2).event, 'capture-end'); assert.equal(rows().at(-1).reason, 'cancelled');
});
test('自动记录目录不可写不会抛出或占用截图事务', () => {
  const fakeFs = { readdirSync: () => [], mkdirSync() { const error = new Error('PRIVATE_PATH'); error.code = 'EACCES'; throw error; } };
  const context = { module: { exports: {} }, require: name => name === 'node:fs' ? fakeFs : require(name), setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main/diagnostics.cjs'), 'utf8'), context);
  const r = context.module.exports.createDiagnostics({ directory: 'not-written' });
  assert.doesNotThrow(() => r.startAutomatic()); assert.equal(r.state().recording, false);
  assert.match(r.state().error, /EACCES/); assert.doesNotMatch(r.state().error, /PRIVATE/);
});

test('条数上限保留最终标记，后续记录忽略', async t => {
  const { recorder: r, rows } = fixture(t, { maxEvents: 3 }); r.start();
  for (let i = 0; i < 10; i++) r.record('sample', { sampleIndex: i });
  await r.flush(); assert.equal(rows().length, 4); assert.equal(rows().at(-1).reason, 'limit');
  assert.equal(r.state().recording, false);
});
test('时间上限自动封口，不影响截图流程', async t => {
  const { recorder: r, rows } = fixture(t, { durationMs: 15 }); r.start();
  await new Promise(resolve => setTimeout(resolve, 40)); await r.flush();
  assert.equal(rows().at(-1).reason, 'timeout'); assert.equal(r.state().recording, false);
});
test('重启后只发现格式正确的既有报告，仍默认关闭', async t => {
  const { recorder: r, directory } = fixture(t); r.start(); r.end(); await r.flush();
  fs.writeFileSync(path.join(directory, 'zzz-private.txt'), 'not a report');
  const reopened = createDiagnostics({ directory });
  assert.equal(reopened.getFile(), r.getFile()); assert.equal(reopened.state().recording, false);
});
test('诊断写失败不会向截图路径抛错，并停止继续写入', async () => {
  const writes = [], states = [];
  const fakeFs = { readdirSync: () => [], mkdirSync() {}, writeFileSync() {},
    promises: { appendFile: async (_file, line) => { writes.push(line); throw new Error('denied C:\\Users\\private\\report'); } } };
  const context = { module: { exports: {} }, require: name => name === 'node:fs' ? fakeFs : require(name), setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main/diagnostics.cjs'), 'utf8'), context);
  const r = context.module.exports.createDiagnostics({ directory: 'not-written', onChange: state => states.push(state) });
  r.start(); assert.doesNotThrow(() => r.record('sample')); await r.flush();
  assert.equal(r.state().recording, false); assert.equal(writes.length, 1);
  assert.match(r.state().error, /写入失败/); assert.doesNotMatch(r.state().error, /private|Users/);
  assert.equal(r.record('sample'), false); assert.ok(states.length > 0);
});

test('超时/预算恢复只记录固定类别、阶段与少量计数，原始文本不落盘', () => {
  assert.deepEqual(sanitize({ errorName: 'Error', errorMessage: '图片匹配超时，未确认部分没有拼入 PRIVATE', inflightId: 7, pendingMs: 10012.3456, learnPasses: 3, learnDuration: 44.4444, repairDuration: 5 }),
    { errorName: 'Error', errorCode: 'match-timeout', inflightId: 7, pendingMs: 10012.346, learnPasses: 3, learnDuration: 44.444, repairDuration: 5 });
  for (const [text, code] of [['长图计算收尾超时', 'finish-timeout'], ['图片匹配进程启动超时', 'matcher-start-timeout'], ['图片匹配回包不对应当前任务', 'reply-mismatch'], ['遮挡分析超出预算', 'analysis-budget']]) {
    assert.deepEqual(sanitize({ errorMessage: text + ' PRIVATE_TEXT' }), { errorCode: code });
  }
  assert.deepEqual(sanitize({ stage: 'mark-repair', reason: 'analysis-budget', recovered: true, seeded: false, evidenceRevision: 3 }),
    { stage: 'mark-repair', reason: 'analysis-budget', recovered: true, seeded: false, evidenceRevision: 3 });
  assert.deepEqual(sanitize({ stage: 'PRIVATE', reason: 'PRIVATE', recovered: 'yes', seeded: 1, learnPasses: 'PRIVATE', evidenceRevision: '3' }), {});
});
test('恢复事件与阶段计数写入报告，仍不保存像素、原始帧或错误原文', async t => {
  const { recorder: r, rows } = fixture(t); r.start();
  assert.equal(r.record('worker-recovering', { reason: 'match-timeout', recovered: true, seeded: false, height: 180,
    inflightId: 4, pendingMs: 10000, learnPasses: 2, learnDuration: 9.5, repairDuration: 1,
    message: 'PRIVATE_MESSAGE', checkpoint: { data: 'PRIVATE_IMAGE' } }), true);
  r.end('failed'); await r.flush();
  const row = rows()[1];
  assert.equal(row.event, 'worker-recovering');
  assert.equal(row.reason, 'match-timeout'); assert.equal(row.recovered, true); assert.equal(row.seeded, false);
  assert.equal(row.height, 180); assert.equal(row.inflightId, 4); assert.equal(row.pendingMs, 10000);
  assert.equal(row.learnPasses, 2); assert.equal(row.learnDuration, 9.5); assert.equal(row.repairDuration, 1);
  assert.doesNotMatch(JSON.stringify(rows()), /PRIVATE|message|checkpoint/);
  assert.deepEqual(sanitize({ learnPasses: 1, learnDuration: 2, repairDuration: 3, inflightId: 4, pendingMs: 5 }),
    { learnPasses: 1, learnDuration: 2, repairDuration: 3, inflightId: 4, pendingMs: 5 });
});
test('displayId 只收有限数值：正负整数都留，字符串/对象/NaN/无值一律剔除', () => {
  assert.deepEqual(sanitize({ displayId: 318034052 }), { displayId: 318034052 });
  assert.deepEqual(sanitize({ displayId: -7 }), { displayId: -7 });
  assert.deepEqual(sanitize({ displayId: 0 }), { displayId: 0 });
  assert.deepEqual(sanitize({ displayId: '318034052' }), {});
  assert.deepEqual(sanitize({ displayId: { id: 7 } }), {});
  assert.deepEqual(sanitize({ displayId: [7] }), {});
  assert.deepEqual(sanitize({ displayId: NaN }), {});
  assert.deepEqual(sanitize({ displayId: Infinity }), {});
  assert.deepEqual(sanitize({ displayId: null }), {});
  assert.deepEqual(sanitize({ displayId: true }), {});
});
test('三个多屏事件透传数值 displayId，屏名/边界/字符串id 不落盘', async t => {
  const { recorder: r, rows } = fixture(t);
  r.start({ platform: 'win32' });
  r.record('capture-start', { displayId: -12, width: 8, height: 6, scaleFactor: 1.25, label: '显示器 1', bounds: { x: -1280, y: 0 } });
  r.record('snapshot-ready', { displayId: 318034052, width: 10, height: 7 });
  r.record('scroll-request', { phase: 'selecting', displayId: '7', width: 200, height: 200 });
  r.end('completed'); await r.flush();
  const output = rows();
  const start = output.find(row => row.event === 'capture-start');
  assert.equal(start.displayId, -12); assert.equal(start.label, undefined); assert.equal(start.bounds, undefined);
  assert.equal(output.find(row => row.event === 'snapshot-ready').displayId, 318034052);
  const request = output.find(row => row.event === 'scroll-request');
  assert.equal(request.displayId, undefined, '字符串 id 不落盘');
  assert.equal(request.phase, 'selecting'); assert.equal(request.width, 200);
  assert.doesNotMatch(JSON.stringify(output), /显示器 1|label|bounds/);
});

test('跨屏模式与屏数只保留固定枚举，预算错误只留固定类别不留原文', () => {
  assert.deepEqual(sanitize({ mode: 'desktop', screenCount: 2 }), { mode: 'desktop', screenCount: 2 });
  assert.deepEqual(sanitize({ mode: 'desktop-ish' }), {}, '未知 mode 仍丢弃');
  assert.deepEqual(sanitize({ mode: 'PRIVATE_TEXT' }), {});
  assert.deepEqual(sanitize({ screenCount: 'two screens' }), {}, '任意屏幕文字不落盘');
  assert.deepEqual(sanitize({ screenCount: Infinity }), {});
  assert.deepEqual(sanitize({ errorCode: 'desktop-window-mismatch' }), { errorCode: 'desktop-window-mismatch' });
  assert.deepEqual(sanitize({ errorCode: 'PRIVATE_TEXT' }), {}, '未知错误类别仍丢弃');
  const budget = sanitize({ errorName: 'RangeError', errorMessage: '跨屏范围 7000×3000（21000000 像素）超出 3600 万像素上限，请降低分辨率后重试' });
  assert.deepEqual(budget, { errorName: 'RangeError', errorCode: 'desktop-size-limit' });
  assert.doesNotMatch(JSON.stringify(budget), /7000|21000000|像素/, '预算错误不写原文与尺寸');
});
