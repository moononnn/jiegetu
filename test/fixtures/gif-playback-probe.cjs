'use strict';
// 隐藏合成窗口验证 GIF 播放时钟；只跑本仓自编码的 16x16 合成 GIF。
// 不采屏、不碰剪贴板、不联网、不启动真实应用：show:false + offscreen + 隔离 userData + 拦截 http(s)。
// 仅由 Electron 运行：node_modules/.bin/electron test/fixtures/gif-playback-probe.cjs
// 输出一行 JSON 报告；test/gif-playback.test.cjs 负责 spawn 与结构断言。
const {app,BrowserWindow}=require('electron');
const {createGifEncoder}=require('../../main/gif-encoder.cjs');
const path=require('node:path'),os=require('node:os');
app.setPath('userData',path.join(os.tmpdir(),'gif-playback-probe-'+process.pid));
app.commandLine.appendSwitch('disable-background-networking');
let win,encoder,done=false;
const deadline=setTimeout(()=>finish(new Error('合成播放时钟检查超时')),60000);
function finish(error,result){if(done)return;done=true;clearTimeout(deadline);encoder?.cancel();if(win&&!win.isDestroyed())win.destroy();const report={result:error?'GIF_PLAYBACK_PROBE_FAIL':'GIF_PLAYBACK_PROBE_PASS',synthetic:true,desktopRead:false,clipboardReadOrWritten:false,visibleWindow:false,networkBlocked:true,...result,...(error?{error:error.stack}:{})};console.log(JSON.stringify(report));app.exit(error?1:0);}
async function encode(frames,durationMs) {
  encoder=createGifEncoder({width:16,height:16});
  for(const frame of frames) await encoder.frame(frame.pixels,frame.at);
  const bytes=await encoder.finish(durationMs);encoder=null;return bytes;
}
const solid=(rgb,at)=>{const pixels=new Uint8Array(16*16*4);for(let p=0;p<pixels.length;p+=4)pixels.set([...rgb,255],p);return{pixels,at};};
app.whenReady().then(async()=>{
  // 单帧 2000ms（原始复现）、400/1200/400ms 的变长帧，以及 1000/1000ms 的两帧循环。
  const single=await encode([solid([255,255,255],0)],2000);
  const uneven=await encode([solid([240,0,0],0),solid([0,240,0],400),solid([0,0,240],1600)],2000);
  const loop=await encode([solid([240,0,0],0),solid([0,240,0],1000)],2000);
  win=new BrowserWindow({show:false,width:1000,height:750,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,offscreen:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest((d,callback)=>callback({cancel:/^https?:|^wss?:/.test(d.url)}));
  await win.loadFile(path.resolve(__dirname,'../../renderer/gif-recorder.html'));
  const result=await win.webContents.executeJavaScript(`(async()=>{
    const root=document.querySelector('#gif-editor'),bridge={action:async()=>{},edit:async()=>{throw new Error('合成检查不产出成品')}};
    const checks=[];let failure=null;
    const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const q=n=>root.querySelector('[data-ge="'+n+'"]'),head=()=>Number(q('seek').value),pos=()=>q('position').textContent;
    const wait=async(fn,label)=>{for(let i=0;i<600;i++){if(fn())return;await sleep(5);}throw new Error('等待超时：'+label);};
    const near=(actual,expected,tolerance,label)=>{if(!(Math.abs(actual-expected)<=tolerance))throw new Error(label+'：'+actual+' 不在 '+expected+'±'+tolerance);};
    const same=(actual,expected,label)=>{if(actual!==expected)throw new Error(label+'：'+actual+' ≠ '+expected);};
    async function check(name,fn){try{const details=await fn();checks.push({name,ok:true,details});return details;}catch(error){checks.push({name,ok:false,error:error.message});throw new Error(name+'：'+error.message);}}
    // 只让解码变慢：控制器仍然创建真实 ImageDecoder 实例。
    const Native=window.ImageDecoder;let delayIndex=-1,delayMs=0;
    function Tracked(options){const decoder=new Native(options),decode=decoder.decode.bind(decoder);
      decoder.decode=async options=>{if(delayMs>0&&options&&options.frameIndex===delayIndex)await sleep(delayMs);return decode(options);};return decoder;}
    Tracked.isTypeSupported=Native.isTypeSupported.bind(Native);window.ImageDecoder=Tracked;
    const single=new Uint8Array(${JSON.stringify(Array.from(single))}),uneven=new Uint8Array(${JSON.stringify(Array.from(uneven))}),loop=new Uint8Array(${JSON.stringify(Array.from(loop))});
    const controller=createGifEditor({root,bridge});
    try{
      await controller.open({sourceId:'synthetic-dwell',width:16,height:16,bytes:single});
      await check('单帧 2000ms：播放头随钟前进，不再整段停在 0',async()=>{
        const samples=[];q('play').click();const at=performance.now();
        while(performance.now()-at<650){samples.push(head());await sleep(30);}
        const during={elapsedWallMs:Math.round(performance.now()-at),playText:q('play').textContent,playheadMs:head(),position:pos()};
        q('play').click();
        const paused={playText:q('play').textContent,playheadMs:head(),position:pos()};
        near(during.playheadMs,650,150,'播放 650ms 的播放头');if(!(during.playheadMs>0))throw new Error('播放头仍停在 0');
        same(during.playText,'暂停','播放中按钮文案');same(paused.playText,'播放','暂停后按钮文案');
        near(paused.playheadMs,during.playheadMs,60,'暂停时记录当前时间');
        const distinct=new Set(samples).size;if(distinct<10)throw new Error('播放头只更新了 '+distinct+' 次，未按钟刷新');
        return {sourceFrames:1,sourceDurationMs:2000,during,paused,distinctPlayheadValues:distinct,samples:samples.length};
      });
      await check('暂停不再走表，继续播从暂停点接着走',async()=>{
        const base=head();await sleep(250);const still=head();
        same(still,base,'暂停期间播放头');
        q('play').click();await sleep(300);const resumed=head();q('play').click();
        near(resumed,base+300,120,'续播 300ms 后的播放头');
        return {pausedAtMs:base,afterIdleMs:still,resumedAtMs:resumed};
      });
      await check('变长帧：播放头在长帧内继续走，帧号按真实边界切换',async()=>{
        await controller.open({sourceId:'synthetic-uneven',width:16,height:16,bytes:uneven});
        await wait(()=>pos().startsWith('1/')&&head()===0,'打开变长帧 GIF');
        const at=performance.now();q('play').click();const marks=[];
        for(const [offset,frame] of [[150,'1/'],[700,'2/'],[1780,'3/']]){
          while(performance.now()-at<offset)await sleep(10);
          marks.push({offset,head:head(),position:pos()});near(head(),offset,120,'t+'+offset+' 的播放头');
          if(!pos().startsWith(frame))throw new Error('t+'+offset+' 停在 '+pos()+'，期望 '+frame);
        }
        q('play').click();
        return {marks,playTextAfterPause:q('play').textContent};
      });
      await check('循环回到首帧但不重置播放钟',async()=>{
        await controller.open({sourceId:'synthetic-uneven',width:16,height:16,bytes:uneven});
        await wait(()=>pos().startsWith('1/')&&head()===0,'重新打开');
        const at=performance.now();q('play').click();
        while(performance.now()-at<2150)await sleep(10);
        const wrapped={head:head(),position:pos()};
        q('play').click();
        if(!(wrapped.head<400))throw new Error('循环后播放头没有回到首帧区：'+wrapped.head);
        if(!wrapped.position.startsWith('1/'))throw new Error('循环后帧号未回到首帧：'+wrapped.position);
        return wrapped;
      });
      await check('暂停时的迟到解码不回退播放头、不重启播放',async()=>{
        await controller.open({sourceId:'synthetic-uneven',width:16,height:16,bytes:uneven});
        await wait(()=>pos().startsWith('1/')&&head()===0,'重新打开');
        delayIndex=1;delayMs=500;
        q('play').click();await sleep(700);q('play').click();
        const pauseHead=head();
        await wait(()=>pos().startsWith('2/'),'迟到的帧解码落地');
        const settled={head:head(),position:pos(),playText:q('play').textContent};
        delayIndex=-1;delayMs=0;
        if(!(pauseHead>=600))throw new Error('暂停点异常：'+pauseHead);
        same(settled.head,pauseHead,'迟到解码后的播放头');same(settled.playText,'播放','迟到解码后的播放状态');
        const beforeResume=head();q('play').click();await sleep(250);const resumed=head();q('play').click();
        near(resumed,beforeResume+250,140,'从暂停点续播');
        return {pauseHead,settled,resumedFrom:beforeResume,resumed};
      });
      await check('暂停中异步 seek 后立即播放：从 seek 目标起播，不回退',async()=>{
        await controller.open({sourceId:'synthetic-uneven',width:16,height:16,bytes:uneven});
        await wait(()=>pos().startsWith('1/')&&head()===0,'重新打开');
        delayIndex=1;delayMs=300;
        q('seek').value=900;q('seek').dispatchEvent(new Event('input'));
        q('play').click();
        await wait(()=>q('play').textContent==='暂停','播放开始');
        const started=head();await sleep(150);const later=head();q('play').click();
        delayIndex=-1;delayMs=0;
        if(!(started>=900))throw new Error('起播位置回退：'+started);
        near(later,started+150,140,'起播后的播放头');
        return {started,later,position:pos()};
      });
      await check('时间滑块 pointerdown 即暂停，拖动区间不被时钟写回',async()=>{
        await controller.open({sourceId:'synthetic-uneven',width:16,height:16,bytes:uneven});
        await wait(()=>pos().startsWith('1/')&&head()===0,'重新打开');
        // 播放头是 10ms 网格、2000ms 循环的实时时钟（clockHead），滑块上的值只是上一帧 UI 的快照。
        const LOOP_MS=2000,CLOCK_STEP=10;
        const expectHead=elapsed=>Math.min(LOOP_MS-CLOCK_STEP,Math.floor(((elapsed%LOOP_MS)+LOOP_MS)%LOOP_MS/CLOCK_STEP)*CLOCK_STEP);
        q('play').click();
        const playFrom=performance.now();          // 播放钟起点：就在 play.click 附近
        await sleep(300);
        const playing={head:head(),playText:q('play').textContent,at:performance.now()};
        // 确定性阻塞主线程 120ms：RAF/ticker 不会更新（UI 就停在陈旧值），但 performance 时钟照走。
        // 这样“把刚读到的显示值抄回去”仍然对不上实时钟，只有真的按 clock 暂停才能过。
        const blockUntil=performance.now()+120;while(performance.now()<blockUntil){}
        const rail=q('seek').getBoundingClientRect();
        // 强制布局本身也可能耗时；采样必须紧邻真正的 pointerdown，不能把布局等待算成暂停误差。
        const beforePress=performance.now();
        q('seek').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:31,pointerType:'mouse',isPrimary:true,button:0,buttons:1,clientX:rail.left+rail.width/2,clientY:rail.top+rail.height/2}));
        const pressedAt=performance.now();
        const pressed={head:head(),playText:q('play').textContent};
        q('seek').value=1200;q('seek').dispatchEvent(new Event('input'));
        await wait(()=>head()===1200,'拖动落到目标时间');
        await sleep(400);
        const settled={head:head(),position:pos(),playText:q('play').textContent};
        same(playing.playText,'暂停','播放中按钮文案');
        same(pressed.playText,'播放','滑块 pointerdown 必须立刻暂停');
        // 按下那一刻记录的必须是实时钟，不是上一帧的显示值：与 2000ms 循环/10ms 网格的实际预期对齐。
        const expected=expectHead(beforePress-playFrom);
        near(pressed.head,expected,60,'pointerdown 时的实时播放头');
        // 陈旧显示值必须明显落后（先把旧值抄回去也会被这条拦住）。
        if(!(pressed.head>=playing.head+100))throw new Error('pointerdown 没有追到当前时间：陈旧显示 '+playing.head+'，按下时 '+pressed.head);
        same(settled.playText,'播放','拖动后不自行恢复播放');
        same(settled.head,1200,'拖动目标不能被时钟写回');
        return {playing,pressed,blockedMs:Math.round(beforePress-playing.at),pressedElapsedMs:Math.round(beforePress-playFrom),expectedHead:expected,pressedAtMs:Math.round(pressedAt-playFrom),draggedTo:1200,settled};
      });
      await check('延迟解码跨循环：绕回首帧后暂停，head/帧号/画面保持一致',async()=>{
        await controller.open({sourceId:'synthetic-loop',width:16,height:16,bytes:loop});
        await wait(()=>pos().startsWith('1/')&&head()===0,'打开两帧循环 GIF');
        const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const colours=()=>{const canvas=root.querySelector('.ie-display');
          if(!canvas.width||!canvas.height)throw new Error('画面未布局：'+canvas.width+'x'+canvas.height);
          const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
          let red=0,green=0,opaque=0;
          for(let i=0;i<data.length;i+=8){if(!data[i+3])continue;opaque++;if(data[i]>150&&data[i+1]<100)red++;else if(data[i+1]>150&&data[i]<100)green++;}
          return {red,green,opaque};};
        await settle();
        const first=colours();
        if(!(first.red>0&&first.green===0))throw new Error('开局画面不是第 1 帧：'+JSON.stringify(first));
        delayIndex=1;delayMs=1200;   // frame1 要解码到绕回首帧之后才回来
        q('play').click();
        await sleep(2100);           // 1000ms 进入 frame1 并请求慢解码，2000ms 绕回 frame0
        q('play').click();
        const paused={head:head(),position:pos(),playText:q('play').textContent};
        await sleep(900);            // 迟到的 frame1 解码此刻落地
        delayIndex=-1;delayMs=0;
        await settle();
        const settled={head:head(),position:pos(),playText:q('play').textContent,colours:colours()};
        same(paused.playText,'播放','暂停后按钮文案');
        if(!(paused.head<1000))throw new Error('暂停点不在首帧区间：'+paused.head);
        if(!paused.position.startsWith('1/'))throw new Error('暂停时帧号就不是首帧：'+paused.position);
        same(settled.head,paused.head,'迟到解码后的播放头');
        if(!settled.position.startsWith('1/'))throw new Error('迟到解码改写了帧号：'+settled.position);
        if(!(settled.colours.red>0&&settled.colours.green===0))throw new Error('画面与暂停点不一致：'+JSON.stringify(settled.colours));
        return {first,paused,settled};
      });
      await check('播放中 reset：迟到解码不复活画面',async()=>{
        delayIndex=1;delayMs=400;
        q('play').click();await sleep(500);controller.reset();await sleep(600);
        delayIndex=-1;delayMs=0;
        const afterReset={open:controller.isOpen,hidden:root.hidden};
        if(afterReset.open||!afterReset.hidden)throw new Error('reset 后编辑器未关闭');
        return afterReset;
      });
    }catch(error){failure=error.message;}
    finally{controller.reset();window.ImageDecoder=Native;}
    return {checks,failure};
  })()`);
  const failed=result.checks.filter(check=>!check.ok);
  finish(result.failure?new Error(result.failure):undefined,{...result,passed:result.checks.length-failed.length});
}).catch(error=>finish(error));
