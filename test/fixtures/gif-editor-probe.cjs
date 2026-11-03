'use strict';
// Explicit synthetic-only, hidden Chromium acceptance. Not auto-run by node --test.
const {app,BrowserWindow}=require('electron');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const {createGifEncoder}=require('../../main/gif-encoder.cjs');
const {parse}=require('../../core/gif-timeline.js');
app.setPath('userData',path.join(os.tmpdir(),`gif-renderer-check-${process.pid}`));
app.commandLine.appendSwitch('disable-background-networking');
let win,encoder;
const timeout=setTimeout(()=>finish(new Error('probe timeout')),60000);
function finish(error) {clearTimeout(timeout); encoder?.cancel();win?.destroy();if(error) console.error(error);app.exit(error?1:0);}
async function encode(frames,width,height,durationMs) {
  encoder=createGifEncoder({width,height});
  for(const frame of frames) await encoder.frame(Uint8Array.from(frame.rgba),frame.elapsedMs);
  const result=await encoder.finish(durationMs);encoder=null;return result;
}
app.whenReady().then(async()=> {
  const width=40,height=30,frames=[];
  for(let f=0;f<3;f++) {
    const rgba=new Uint8Array(width*height*4);
    for(let y=0;y<height;y++) for(let x=0;x<width;x++) rgba.set(x>=4&&x<6&&y>=4&&y<6 ? [255,255,255,255] : [f===0?248:0,f===1?252:0,f===2?248:0,255],(y*width+x)*4);
    frames.push({rgba,elapsedMs:[0,500,1500][f]});
  }
  const encoded=await encode(frames,width,height,1800);
  const bytes=encoded.bytes || encoded;
  const shortEncoded=await encode([frames[0]],width,height,10);
  const shortBytes=shortEncoded.bytes || shortEncoded;
  assert.equal(parse(bytes).durationMs,1800);
  win=new BrowserWindow({show:false,width:1000,height:568,webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  await win.loadURL(pathToFileURL(path.resolve(__dirname,'../../renderer/gif-recorder.html')).href);
  const result=await win.webContents.executeJavaScript(`(async()=> {
    const checks=[];
    function check(value,name){if(!value)throw new Error(name);checks.push(name);}
    const data=new Uint8Array(${JSON.stringify(Array.from(bytes))});
    const decoder=new ImageDecoder({type:'image/gif',data});await decoder.tracks.ready;
    const root=document.createElement('section');document.body.append(root);
    const editor=createImageEditor({root,animation:true});
    const first=(await decoder.decode({frameIndex:0})).image;
    try {const canvas=document.createElement('canvas');canvas.width=40;canvas.height=30;canvas.getContext('2d').drawImage(first,0,0);await editor.open({token:'s',width:40,height:30,dataUrl:canvas.toDataURL()});} finally{first.close();}
    const q=s=>root.querySelector(s), click=s=>q(s).click();
    const scroll=q('.ie-scroll');scroll.setPointerCapture=()=>{};scroll.hasPointerCapture=()=>false;
    function drag(x,y,x2,y2){
      const rect=scroll.getBoundingClientRect(), view=editor.cropRect||{x:0,y:0,width:40,height:30};
      const zoom=parseFloat(q('.ie-zoom').textContent)/100;
      const originX=rect.left+Math.max(16,(scroll.clientWidth-view.width*zoom)/2)-view.x*zoom, originY=rect.top+16-view.y*zoom;
      function send(type,px,py){scroll.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:1,pointerType:'mouse',button:0,buttons:type==='pointerup'?0:1,clientX:originX+px*zoom,clientY:originY+py*zoom}));}
      send('pointerdown',x,y);send('pointermove',x2,y2);send('pointerup',x2,y2);
    }
    click('[data-tool="rect"]');q('[data-setting="fill"]').checked=true;q('[data-setting="color"]').value='#000000';drag(8,8,20,20);
    click('[data-tool="mosaic"]');q('[data-setting="diameter"]').value='8';q('[data-setting="grain"]').value='4';drag(12,8,12,20);drag(28,8,28,20);
    click('[data-tool="crop"]');drag(0,0,4,4); // Move NW handle inward; current full crop was preselected.
    click('[data-action="crop-apply"]');
    const crop=editor.cropRect;check(crop&&crop.x===4&&crop.y===4&&crop.width===36&&crop.height===26,'spatial crop '+JSON.stringify(crop));
    editor.setBusy(true);
    const cropped=[];
    for(let i=0;i<3;i++){
      const frame=(await decoder.decode({frameIndex:i})).image;
      try{
        const r=editor.renderFrame(frame);cropped.push({elapsedMs:[0,300,1300][i],rgba:Array.from(r.rgba)});check(r.width===36&&r.height===26,'frame '+i+' crop size');
        const at=(x,y)=>Array.from(r.rgba.slice((y*r.width+x)*4,(y*r.width+x)*4+4));
        check(at(0,0).join()==='255,255,255,255','frame '+i+' coordinate marker crop alignment');
        check(at(8,8).join() === '0,0,0,255','frame '+i+' opaque mask survives later mosaic');
        const expected=[[248,0,0,255],[0,252,0,255],[0,0,248,255]][i];
        check(at(24,8).join()===expected.join(),'frame '+i+' mosaic cache uses current source');
      }finally{frame.close();}
    }
    editor.setBusy(false);
    const next=(await decoder.decode({frameIndex:1})).image;
    try {await editor.replaceFrame(next);}finally{next.close();}
    check(editor.cropRect.x===4&&editor.hasEdits,'replace preserves crop/history');
    click('[data-action="undo"]');check(!editor.cropRect,'undo crop after replace');click('[data-action="redo"]');check(editor.cropRect.x===4,'redo crop after replace');
    editor.reset();decoder.close();root.remove();
    // Controller uses real scripts and real ImageDecoder; bridge is synthetic, never IPC/capture.
    const host=document.createElement('section');host.id='gif-editor';document.body.append(host);
    let sent=[],begins=[],aborts=[],finishCount=0,mode='success',release;
    const bridge={action:async()=>{},edit:async(action,payload)=>{
      if(action==='begin'){begins.push(payload);if(mode==='late')await new Promise(resolve=>release=resolve);return {token:'tok'};}
      if(action==='frame'){if(mode==='fail')throw new Error('synthetic frame failure');sent.push({elapsedMs:payload.elapsedMs,rgba:Array.from(payload.rgba)});}
      if(action==='finish'){finishCount++;controller.reset({committed:true});}
      if(action==='abort')aborts.push(payload);
    }};
    const controller=createGifEditor({root:host,bridge});
    const source={sourceId:'source-1',bytes:data,width:40,height:30};
    const wait=async(fn)=>{for(let i=0;i<300;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('wait timeout');};
    await controller.open(source);check(controller.isOpen,'controller opens real GIF');
    check(host.querySelector('.ge-time').getBoundingClientRect().top>=host.querySelector('.ie-footer').getBoundingClientRect().bottom,'timeline remains outside image workspace/footer');
    check(host.querySelector('.ie-workspace').clientHeight>100,'canvas keeps usable height');
    const ge=n=>host.querySelector('[data-ge="'+n+'"]');
    for(const value of [500,0,1500]) {ge('seek').value=value;ge('seek').dispatchEvent(new Event('input'));}
    await wait(()=>ge('position').textContent.startsWith('3/'));
    check(ge('position').textContent.includes('1.50秒'),'latest seek wins');
    const startHandle=ge('start-handle'),endHandle=ge('end-handle'),rail=ge('rail');
    const value=name=>Number(ge(name+'-handle').getAttribute('aria-valuenow'));
    const key=(handle,key,shiftKey=false)=>handle.dispatchEvent(new KeyboardEvent('keydown',{key,shiftKey,bubbles:true}));
    check(!ge('start')&&!ge('end')&&value('start')===0&&value('end')===1800,'one rail defaults to full selection without separate ranges');
    check(ge('seek').max==='1790'&&ge('seek').step==='10'&&ge('seek').value==='1500','seek uses real milliseconds');
    check(Math.abs(parseFloat(ge('playhead').style.left)-1500/1800*100)<0.01,'uneven frame dwell maps to real duration proportion');
    // Untrusted DOM pointer events cannot own native capture. Only the capture transport is stubbed;
    // real browser geometry and production drag handlers below remain in use.
    function dragHandle(handle,targetMs,outside=false) {
      const captures=new Set();
      handle.setPointerCapture=id=>captures.add(id);handle.hasPointerCapture=id=>captures.has(id);handle.releasePointerCapture=id=>captures.delete(id);
      const r=rail.getBoundingClientRect(),h=handle.getBoundingClientRect(),x=h.left+h.width/2,y=h.top+h.height/2;
      const boundary=value(handle===startHandle?'start':'end');
      const send=(type,clientX)=>handle.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:7,button:0,clientX,clientY:outside?r.top-50:y}));
      const targets=Array.isArray(targetMs)?targetMs:[targetMs];
      send('pointerdown',x);for(const target of targets)send('pointermove',x+(target-boundary)/1800*r.width);send('pointerup',x+(targets.at(-1)-boundary)/1800*r.width);
      check(!captures.size&&!handle.classList.contains('ge-dragging'),'pointer release clears capture/drag');
    }
    ge('play').click();await wait(()=>ge('play').textContent==='暂停');
    dragHandle(startHandle,500,true);await wait(()=>ge('position').textContent.startsWith('2/'));
    check(value('start')===500&&ge('play').textContent==='播放','left drag pauses and previews start boundary outside rail');
    dragHandle(endHandle,1500,true);await new Promise(resolve=>setTimeout(resolve,40));
    check(ge('position').textContent.startsWith('2/'),'end boundary at next-frame start previews previous frame');
    check(value('end')===1500,'right drag previews end minus one, not next frame');
    check(ge('seek').value==='1490','exclusive end pointer stays inside retained interval');
    check(Math.abs(parseFloat(ge('selection').style.left)-500/1800*100)<0.01,'selection shares millisecond rail');
    dragHandle(startHandle,1800);check(value('start')===1490,'start cannot cross end and keeps 10ms');
    dragHandle(endHandle,0);check(value('end')===1500,'end cannot cross start and keeps 10ms');
    key(startHandle,'Home');check(value('start')===0,'start Home');
    key(endHandle,'End');check(value('end')===1800,'end End');
    key(endHandle,'Home');check(value('end')===10,'end Home respects start plus 10');
    key(endHandle,'End');key(startHandle,'End');check(value('start')===1790,'start End respects end minus 10');
    key(startHandle,'Home');key(startHandle,'ArrowRight',true);check(value('start')===100,'Shift arrow is 100ms');
    key(startHandle,'ArrowLeft');check(value('start')===90,'arrow is 10ms');
    ge('reset').click();check(value('start')===0&&value('end')===1800,'reset restores full range');
    await wait(()=>ge('position').textContent.startsWith('1/'));
    dragHandle(startHandle,[1500,100,1200,0,1600]);await wait(()=>ge('position').textContent.startsWith('3/'));
    check(value('start')===1600&&ge('seek').value==='1600','rapid handle drag last target and exact in-frame time win');
    ge('reset').click();await wait(()=>ge('position').textContent.startsWith('1/'));
    for(let i=0;i<60;i++){ge('seek').value=[1500,0,500][i%3];ge('seek').dispatchEvent(new Event('input'));}
    await wait(()=>ge('position').textContent.startsWith('2/'));check(ge('seek').value==='500','rapid seek last target wins');
    host.style.width='320px';host.style.height='568px';host.style.right='auto';host.style.bottom='auto';
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const timeRect=host.querySelector('.ge-time').getBoundingClientRect(),a=startHandle.getBoundingClientRect(),b=endHandle.getBoundingClientRect();
    check(a.left>=timeRect.left&&b.right<=timeRect.right&&a.top>=timeRect.top&&b.bottom<=timeRect.bottom,'narrow full-selection handles remain visible');
    check(host.querySelector('.ie-workspace').clientHeight>80&&timeRect.top>=host.querySelector('.ge-image').getBoundingClientRect().bottom,'narrow canvas remains separate and usable '+JSON.stringify({workspace:host.querySelector('.ie-workspace').clientHeight,timeTop:timeRect.top,imageBottom:host.querySelector('.ge-image').getBoundingClientRect().bottom}));
    host.style.width='';host.style.height='';host.style.right='';host.style.bottom='';
    const r=rail.getBoundingClientRect();
    const pointer=type=>new PointerEvent(type,{bubbles:true,pointerId:9,button:0,clientX:r.left,clientY:r.top});
    startHandle.setPointerCapture=()=>{throw new Error('synthetic capture failure');};
    startHandle.dispatchEvent(pointer('pointerdown'));startHandle.dispatchEvent(pointer('pointermove'));
    check(!startHandle.classList.contains('ge-dragging')&&value('start')===0,'capture failure leaves no drag');
    const captured=new Set();startHandle.setPointerCapture=id=>captured.add(id);startHandle.hasPointerCapture=id=>captured.has(id);startHandle.releasePointerCapture=id=>captured.delete(id);
    for(const type of ['pointercancel','blur']) {
      startHandle.dispatchEvent(pointer('pointerdown'));
      if(type==='blur')window.dispatchEvent(new Event('blur'));else startHandle.dispatchEvent(pointer(type));
      check(!captured.size&&!startHandle.classList.contains('ge-dragging'),type+' clears drag capture');
    }
    host.querySelector('[data-tool="crop"]').click();
    key(startHandle,'ArrowRight');check(value('start')===0&&ge('status').textContent.includes('空间裁切'),'unapplied spatial crop blocks trim with explicit message');
    host.querySelector('[data-action="crop-cancel"]').click();
    ge('play').click();await wait(()=>ge('play').textContent==='暂停');
    host.querySelector('.ge-image').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
    check(ge('play').textContent==='播放','image pointerdown pauses playback before drawing');
    ge('start-number').value='0.20';ge('start-number').dispatchEvent(new Event('change'));
    ge('end-number').value='1.60';ge('end-number').dispatchEvent(new Event('change'));
    host.querySelector('[data-action="copy"]').click();await wait(()=>finishCount===1);
    check(begins[0].frames===3&&begins[0].durationMs===1400,'partial first/last export metadata');
    check(sent.map(f=>f.elapsedMs).join()==='0,300,1300','partial export elapsed');
    check(aborts.length===0,'success preview reset does not abort new product');
    const exported=sent;
    mode='fail';sent=[];await controller.open(source);host.querySelector('[data-action="copy"]').click();await wait(()=>!controller.busy&&aborts.length>0);
    check(controller.isOpen&&ge('status').textContent.includes('synthetic frame failure'),'failure preserves editor and visible error');
    mode='late';aborts=[];host.querySelector('[data-action="copy"]').click();await wait(()=>Boolean(release));
    check(Array.from(host.querySelectorAll('.ge-time input,.ge-time button')).every(node=>node===ge('cancel')?!node.disabled:node.disabled),'generating locks all timeline inputs/handles but not cancel');
    const lockedStart=value('start');key(startHandle,'End');check(value('start')===lockedStart,'busy guard blocks slider keyboard changes');
    ge('cancel').click();await wait(()=>aborts.some(a=>a.sourceId==='source-1'));release();await wait(()=>!controller.busy);
    check(aborts.some(a=>a.token==='tok'),'late begin token is aborted after source cancellation');
    check(controller.isOpen,'cancel retains editing draft');
    aborts=[];release=null;host.querySelector('[data-action="copy"]').click();await wait(()=>Boolean(release));
    controller.reset();release();await wait(()=>aborts.some(a=>a.token==='tok'));
    check(!controller.isOpen&&host.hidden,'late begin after reset cannot revive editor');
    await controller.open({...source,bytes:new Uint8Array(${JSON.stringify(Array.from(shortBytes))})});
    check(value('start')===0&&value('end')===10&&ge('seek').max==='0','single-frame 10ms clip is full selected and seek-safe');
    key(startHandle,'End');key(endHandle,'Home');check(value('start')===0&&value('end')===10,'single-frame handles cannot cross');
    controller.reset();host.remove();
    return {checks,exported,cropped};
  })()`);
  const output=await encode(result.exported,width,height,1400);
  assert.deepEqual(parse(output.bytes||output).frames.map(f=>f.durationMs),[300,1000,100]);
  const croppedOutput=await encode(result.cropped,36,26,1400);
  assert.deepEqual(parse(croppedOutput.bytes||croppedOutput).frames.map(f=>f.durationMs),[300,1000,100]);
  const roundtrip=await win.webContents.executeJavaScript(`(async()=>{
    const decoder=new ImageDecoder({type:'image/gif',data:new Uint8Array(${JSON.stringify(Array.from(croppedOutput.bytes||croppedOutput))})});await decoder.tracks.ready;
    let checks=0;
    try{for(let i=0;i<3;i++){
      const image=(await decoder.decode({frameIndex:i})).image;
      try{const c=new OffscreenCanvas(36,26),ctx=c.getContext('2d');ctx.drawImage(image,0,0);const rgba=ctx.getImageData(0,0,36,26).data;
        const at=(x,y)=>Array.from(rgba.slice((y*36+x)*4,(y*36+x)*4+4)).join();
        if(at(0,0)!=='255,255,255,255'||at(8,8)!=='0,0,0,255'||at(24,8)!==[[248,0,0,255],[0,252,0,255],[0,0,248,255]][i].join())throw new Error('encoded cropped pixel mismatch '+i);
        if(image.duration!==[300000,1000000,100000][i])throw new Error('encoded cropped duration mismatch '+i);checks+=4;
      }finally{image.close();}
    }}finally{decoder.close();}return checks;
  })()`);
  console.log(JSON.stringify({result:'GIF_RENDERER_PROBE_PASS',roundtripPixelAndDurationChecks:roundtrip,checks:result.checks,versions:process.versions,outputDurationMs:1400,noCapture:true,noClipboard:true,noNetwork:true}));
  finish();
}).catch(finish);
