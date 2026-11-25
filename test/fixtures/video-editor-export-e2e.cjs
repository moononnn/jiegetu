'use strict';
// Explicit opt-in: run with Electron and --synthetic-video-editor-e2e, plus
// VIDEO_TEST_FFMPEG, VIDEO_TEST_FFPROBE and VIDEO_TEST_SYNTHETIC_DIR absolute paths.
// Uses a hidden editor and fake capture windows; it never starts desktop capture.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { installVideoRecording } = require('../../main/video-recording.cjs');
const { createVideoExporter, runProcess } = require('../../main/video-export.cjs');
const args = process.argv;
if (!args.includes('--synthetic-video-editor-e2e')) throw new Error('explicit synthetic opt-in required');
const ffmpeg = process.env.VIDEO_TEST_FFMPEG, ffprobe = process.env.VIDEO_TEST_FFPROBE, samples = process.env.VIDEO_TEST_SYNTHETIC_DIR, report = process.env.VIDEO_TEST_REPORT, tmpRoot = process.env.VIDEO_TEST_TMPDIR;
if (![ffmpeg, ffprobe, samples, report, tmpRoot].every(p => typeof p === 'string' && path.isAbsolute(p))) throw new Error('absolute fixture paths required');
fs.writeFileSync(report, JSON.stringify({ status:'started' }));
const temp = fs.mkdtempSync(path.join(tmpRoot, 'run-'));
app.setPath('userData', path.join(temp, 'profile'));
app.setPath('sessionData', path.join(temp, 'profile'));
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => { console.error('fixture timeout'); app.exit(2); }, 45000);
let install;
class FakeWindow extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.visible = false;
    this.webContents = new EventEmitter(); this.webContents.mainFrame = {};
    this.webContents.getURL = () => this.file ? pathToFileURL(this.file).href : '';
    this.webContents.setWindowOpenHandler = () => {}; this.webContents.send = () => {};
    this.webContents.executeJavaScript = async () => options.transparent ? { ready:true, width:options.width, height:options.height } : undefined;
  }
  async loadFile(file) { this.file = file; }
  isDestroyed() { return Boolean(this.destroyed); }
  destroy() { this.destroyed = true; this.emit('closed'); }
  showInactive() { this.visible = true; } show() { this.visible = true; }
  hide() { this.visible = false; this.emit('hide'); } isVisible() { return this.visible; }
  setTitle() {} setIgnoreMouseEvents() {} setAlwaysOnTop() {}
}
app.whenReady().then(async () => {
  const handlers = {}, fakeWindows = [];
  let editor, finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const localIpc = { handle(name, fn) { handlers[name] = fn; ipcMain.handle(name, fn); } };
  function Window(options) {
    if (options.webPreferences?.preload?.endsWith('video-editor-preload.cjs')) {
      editor = new BrowserWindow({ ...options, show:false, webPreferences:{ ...options.webPreferences, backgroundThrottling:false } });
      // 不弹窗，但要如实回答“已可见”：产品在拆采集面之前会确认编辑器已显示。
      let shownForTest = false;
      const reallyVisible = editor.isVisible.bind(editor);
      editor.show = () => { shownForTest = true; };
      editor.isVisible = () => shownForTest;
      editor.__reallyVisible = () => reallyVisible();
      return editor;
    }
    const win = new FakeWindow(options); fakeWindows.push(win); return win;
  }
  const session = { setDisplayMediaRequestHandler() {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} };
  const owner = { phase:'selecting' }, ownerWindow = { hide() {}, isVisible:() => false };
  const screenBounds = { x:0, y:0, width:1920, height:1080 };
  const clip = { x:400, y:200, width:600, height:400 };
  const out = path.join(temp, 'synthetic-edited.mp4');
  const realExport = createVideoExporter({ ffmpegPath:ffmpeg, ffprobePath:ffprobe, scratchRoot:temp, timeoutMs:30000 });
  let planSeen = null;
  install = installVideoRecording({ BrowserWindow:Window, ipcMain:localIpc, screen:{ getAllDisplays:() => [{ id:1, bounds:screenBounds, workArea:screenBounds }] },
    session:{ fromPartition:() => session }, dialog:{ showMessageBox:async () => ({ response:0 }) },
    getActive:() => owner, getOwnerWindow:() => ownerWindow, allowed:() => true, cancel() {}, finishSession:(_owner, reason) => finish(reason),
    fitMask:async () => {}, checkMask:async () => {}, resolveSelection:async () => ({ display:{ id:1, bounds:screenBounds, scaleFactor:1 }, physical:clip, dip:clip }),
    showSaveDialog:async () => ({ filePath:out }), writeFile:(...params) => fsp.writeFile(...params),
    exportVideo:async request => { planSeen = request.plan; return realExport(request); } });
  const event = win => ({ sender:win.webContents, senderFrame:win.webContents.mainFrame });
  await handlers['shot:video-begin']({}, { rect:clip });
  await handlers['video:action'](event(fakeWindows[1]), 'start', { systemAudio:true });
  handlers['video:state'](event(fakeWindows[0]), { state:'recording' });
  const bytes = await fsp.readFile(path.join(samples, 'h264-aac-160x120.mp4'));
  const before = Buffer.from(bytes);
  const result = await handlers['video:result'](event(fakeWindows[0]), { bytes, extension:'mp4', mimeType:'video/mp4;codecs=avc1.42001f,mp4a.40.2' });
  assert.equal(result.editing, true); assert.equal(editor.__reallyVisible(), false, '真实窗口始终没被显示（无 GUI）');
  // 单轨只定位；点击裁剪生成待剪块，再拖它的两个把手。
  const ui = await editor.webContents.executeJavaScript(`(async()=>{
    const q=id=>document.getElementById(id), v=q('video');
    const until=Date.now()+8000;
    while((!Number.isFinite(v.duration)||q('save-edited').disabled)&&Date.now()<until) await new Promise(r=>setTimeout(r,50));
    if(q('save-edited').disabled) throw Error('editor not ready');
    q('close').click();
    for(let i=0;i<40&&!q('close-confirm').open;i++) await new Promise(r=>setTimeout(r,25));
    if(!q('close-confirm').open||document.activeElement!==q('keep-editing')) throw Error('close confirmation did not take focus');
    q('keep-editing').click();
    if(q('close-confirm').open) throw Error('could not return to editing');
    const rail=q('rail').getBoundingClientRect(), durationMs=Math.round(v.duration*1000);
    const point=ms=>({x:rail.left+(ms/durationMs)*rail.width,y:rail.top+rail.height/2});
    const ev=(type,ms)=>new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:9,pointerType:'mouse',isPrimary:true,clientX:point(ms).x,clientY:point(ms).y,button:0,buttons:1});
    const dragRail=(from,to)=>{const node=q('rail');node.dispatchEvent(ev('pointerdown',from));node.dispatchEvent(ev('pointermove',to));node.dispatchEvent(ev('pointerup',to));};
    const dragHandle=(id,ms)=>{const node=q(id),r=node.getBoundingClientRect(),p=point(ms),y=r.top+r.height/2;
      const e=type=>new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:9,pointerType:'mouse',isPrimary:true,clientX:p.x,clientY:y,button:0,buttons:1});
      node.dispatchEvent(e('pointerdown'));node.dispatchEvent(e('pointermove'));node.dispatchEvent(e('pointerup'));};
    const read=id=>Number(q(id).getAttribute('aria-valuenow'));
    dragHandle('handle-start',250); dragHandle('handle-end',2500);
    const cut=(from,to)=>{
      dragRail(from,from);
      q('mode').click();
      if(q('confirm-cut').disabled) throw Error('cut block did not open');
      dragHandle('handle-draft-start',from); dragHandle('handle-draft-end',to);
      q('confirm-cut').click();
    };
    cut(600,900);
    const afterFirst=q('mark-cuts').textContent;
    cut(1200,1500);
    const afterSecond=q('mark-cuts').textContent;
    q('undo').click();
    const afterUndo=q('mark-cuts').textContent;
    cut(1200,1500);
    const afterReapply=q('mark-cuts').textContent;
    dragRail(250,250);
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    for(let i=0;i<80&&v.seeking;i++) await wait(25);
    if(v.seeking) throw Error('editor could not seek before playback');
    // Watch both automatic joins and require playback to reach the retained end.
    const jumps=[]; v.addEventListener('seeked',()=>jumps.push(Math.round(v.currentTime*1000)));
    v.muted=true;
    q('play').click();
    for(let i=0;i<210;i++) {
      if(v.paused&&!v.seeking&&v.currentTime>=2.46) break;
      await wait(25);
    }
    if(v.seeking||!v.paused||Math.abs(v.currentTime*1000-read('handle-end'))>45) throw Error('edited playback did not reach the retained end');
    if(![900,1500].every(ms=>jumps.some(at=>Math.abs(at-ms)<=40))) throw Error('edited playback did not jump across both cuts: '+jumps.join(','));
    const result={src:v.src.slice(0,5),duration:v.duration,start:read('handle-start'),end:read('handle-end'),
      cuts:q('cuts').children.length,afterFirst,afterSecond,afterUndo,afterReapply,
      nativeControls:v.hasAttribute('controls'),titlebar:Boolean(q('titlebar'))};
    q('save-edited').click();
    return result;
  })()`, true);
  assert.equal(ui.src,'blob:');
  assert.equal(ui.nativeControls,false,'不应再有 Chromium 原生控件');
  assert.equal(ui.titlebar,true,'自绘标题栏缺失');
  assert.ok(Math.abs(ui.start-250)<=30, `保留起点 ${ui.start}ms`);
  assert.ok(Math.abs(ui.end-2500)<=30, `保留终点 ${ui.end}ms`);
  assert.equal(ui.cuts,2,'撤销后重新加回，最终仍是两段删除');
  assert.notEqual(ui.afterUndo, ui.afterReapply, '撤销与再加回后的读数应不同');
  assert.match(ui.afterSecond, /2|两/);
  assert.equal(await finished, 'video-saved'); assert.deepEqual(bytes, before);
  assert.ok(planSeen, '导出应带上剪辑计划');
  // 两段删除 → 三段保留；区间边界直接用计划里的值与拖拽目标对齐。
  assert.equal(planSeen.ranges.length, 3, '两段删除应产生三段保留');
  assert.equal(planSeen.ranges[0].startMs, ui.start);
  assert.equal(planSeen.ranges[2].endMs, ui.end);
  assert.ok(Math.abs(planSeen.ranges[0].endMs - 600) <= 40, `第一刀起点 ${planSeen.ranges[0].endMs}`);
  assert.ok(Math.abs(planSeen.ranges[1].startMs - 900) <= 40, `第一刀终点 ${planSeen.ranges[1].startMs}`);
  assert.ok(Math.abs(planSeen.ranges[1].endMs - 1200) <= 40, `第二刀起点 ${planSeen.ranges[1].endMs}`);
  assert.ok(Math.abs(planSeen.ranges[2].startMs - 1500) <= 40, `第二刀终点 ${planSeen.ranges[2].startMs}`);
  assert.equal(planSeen.totalMs, planSeen.ranges.reduce((sum, span) => sum + span.endMs - span.startMs, 0));
  assert.ok(planSeen.ranges.every((span, i) => i === 0 || span.startMs >= planSeen.ranges[i - 1].endMs), '区间严格递增且不重叠');
  const saved = await fsp.readFile(out); assert.ok(saved.length > 100);
  await runProcess(ffmpeg, ['-v','error','-xerror','-i',out,'-map','0:v:0','-map','0:a:0','-f','null','-'], { timeoutMs:30000 });
  const metadata = JSON.parse((await runProcess(ffprobe, ['-v','error','-show_entries','stream=codec_type,codec_name:format=duration','-of','json',out], { timeoutMs:30000 })).stdout);
  assert.deepEqual(metadata.streams.map(s => [s.codec_type,s.codec_name]), [['video','h264'],['audio','aac']]);
  assert.ok(Number(metadata.format.duration) > 1.4 && Number(metadata.format.duration) < 2.1);
  clearTimeout(timeout); install.dispose();
  const summary = { ok:true, ui, plan:planSeen, outputBytes:saved.length, streams:metadata.streams, duration:metadata.format.duration, originalUnchanged:true };
  fs.writeFileSync(report, JSON.stringify(summary, null, 2)); app.exit(0);
}).catch(async error => {
  fs.writeFileSync(report, JSON.stringify({ ok:false, error:error.stack || String(error) }, null, 2)); clearTimeout(timeout); install?.dispose();
  app.exit(1);
});
