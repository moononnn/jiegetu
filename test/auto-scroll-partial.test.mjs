import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { createAutoScrollSession } from '../core/auto-scroll-session.mjs';
import { sanitize } from '../main/diagnostics.cjs';
import { createScene } from './fixtures/auto-scenes.mjs';

test('续采诊断仅保留有限数值，不让任意文本进入报告',()=>{
 assert.deepEqual(sanitize({capturedHeight:304,capturedAdded:16,pixels:'private'}),{capturedHeight:304,capturedAdded:16});
 assert.deepEqual(sanitize({capturedHeight:'private',capturedAdded:Infinity}),{});
});

// 故意保留始终挡字的大固定标签：允许带警告续采，不允许把它当背景或报完整。
function blockedScene(options = {}) {
 const scene=createScene({offsets:[0,16,32,48,64,80,96],...options});
 const frames=scene.frames.map(({offset,image})=>{
  const data=new Uint8ClampedArray(image.data);
  for(let y=scene.top;y<image.height-scene.bottom;y++)for(let x=28;x<36;x++){
   const doc=y-scene.top+offset;let v=doc>=136&&doc<140?35:250;
   if(y-scene.top>=60&&y-scene.top<=220)v=250-2*Math.max(0,Math.min(y-scene.top-60,220-(y-scene.top)));
   data.set([v,v,v,255],(y*image.width+x)*4);
  }
  return {offset,image:{...image,data}};
 });
 return {...scene,frames,seedFrame:frames[0].image};
}
for(const bounds of [{top:0,bottom:0},{top:32,bottom:48}])test(`大区域不确定时续采但不伪报完整 ${JSON.stringify(bounds)}`,()=>{
 const scene=blockedScene(bounds),s=createAutoScrollSession(scene.seedFrame);
 const updates=scene.frames.map((f,i)=>s.accept(f.image,i*50));
 assert.ok(updates.some(u=>u.autoEvidence.fixedStopReason==='large-region'));
 assert.ok(updates.every(u=>u.autoEvidence.analysisStage!=='paused'));
 const last=updates.at(-1),out=s.finish();
 assert.equal(last.capturedHeight,scene.height+96);
 assert.equal(out.height,last.capturedHeight);
 assert.ok(updates.slice(-2).every(u=>u.capturedAdded===16));
 assert.equal(last.height,scene.height,'未确认像素不能计入可信高度');
 assert.equal(last.complete,false);assert.equal(out.complete,false);
 assert.ok(out.missingRanges.length>0);assert.match(out.warning,/未确认|无法确认/);
 assert.ok(last.autoEvidence.unknownRects.length>0);
 assert.equal(last.autoEvidence.fixedAnalysisSkipped,true);assert.equal(last.autoEvidence.fixedCandidates,undefined);
 assert.ok(Number.isInteger(last.autoEvidence.unknownTop));
 // 固定头尾各保留一次，尾栏不能随着追加复制到正文里。
 const stride=scene.width*4;
 assert.deepEqual(out.data.slice(0,scene.top*stride),scene.seedFrame.data.slice(0,scene.top*stride));
 if(scene.bottom)assert.deepEqual(out.data.slice(-scene.bottom*stride),scene.frames.at(-1).image.data.slice(-scene.bottom*stride));
 assert.ok(updates.every(u=>u.autoEvidence.rawFrames<=6));
 for(let y=0;y<out.height;y++)for(let x=0;x<out.width;x++)if(x<28||x>=36){
  const p=(y*out.width+x)*4;
  for(let c=0;c<4;c++)assert.equal(out.data[p+c],scene.expected.data[p+c],`未遮挡正文改变 ${x},${y},${c}`);
 }
 for(let y=scene.top;y<out.height-scene.bottom;y++)for(let x=0;x<out.width;x++){
  const p=(y*out.width+x)*4;
  assert.ok(scene.frames.some(f=>{const yy=y-f.offset;if(yy<scene.top||yy>=f.image.height-scene.bottom)return false;const q=(yy*out.width+x)*4;return [0,1,2,3].every(c=>out.data[p+c]===f.image.data[q+c]);}),`续采像素无对应原帧 ${x},${y}`);
 }
 s.clear();
});
test('未确认续采不能绕过失配帧的位移核验',()=>{
 const scene=blockedScene(),s=createAutoScrollSession(scene.seedFrame);
 scene.frames.forEach((f,i)=>s.accept(f.image,i*50));
 const before=s.stats(),other=createScene({seed:84303}).lastFrame;
 const u=s.accept(other,500),out=s.finish();
 assert.equal(u.capturedAdded,0);assert.equal(u.capturedHeight,before.capturedHeight);
 assert.equal(out.complete,false);assert.ok(out.missingRanges.length>0);s.clear();
});
test('真实Worker传递续采高度和缺口，固定头尾未知大区仍能输出长图',async()=>{
 const scene=blockedScene({top:32,bottom:48}),url=new URL('../renderer/scroll-match-worker.mjs',import.meta.url).href;
 const w=new Worker(new URL('data:text/javascript,'+encodeURIComponent(`import {parentPort} from 'node:worker_threads';globalThis.self={postMessage:(p,t)=>parentPort.postMessage(p,t)};await import(${JSON.stringify(url)});parentPort.on('message',data=>self.onmessage({data}));`)),{type:'module'});
 // Worker 会先发轻量的证据版本事件：等真实回包时要把它当元数据跳过，不能当成 sample/done。
 const send=async p=>{const reply=once(w,'message');w.postMessage(p);let packet=(await reply)[0];while(packet?.type==='evidence-invalidated')packet=(await once(w,'message'))[0];return packet;};
 try{
  assert.equal((await send({type:'init',image:scene.seedFrame})).type,'ready');
  let last;
  for(let i=1;i<scene.frames.length;i++)last=await send({type:'frame',id:i,image:scene.frames[i].image,atMs:i*50});
  assert.equal(last.type,'sample');assert.equal(last.capturedHeight,scene.height+96);assert.equal(last.capturedAdded,16);
  assert.equal(last.added,0);assert.equal(last.complete,false);
  const done=await send({type:'finish'});assert.equal(done.type,'done');assert.equal(done.output.height,last.capturedHeight);
  assert.equal(done.output.complete,false);assert.ok(done.output.missingRanges.length>0);
 }finally{await w.terminate();}
});
test('浮条显示实际接长高度，未确认图完成时也先停止主进程采集',async()=>{
 const source=fs.readFileSync(new URL('../renderer/scroll-capture.mjs',import.meta.url),'utf8');
 const progress=[],traces=[],finishing=[],packets=[],selection={onScrollStop(){},onScrollAbort(){},scrollProgress:async(_,p)=>progress.push(p),scrollFinishing:async t=>finishing.push(t),diagnostic:async(e,p)=>traces.push({e,p})};
 const context={window:{selection},performance:{now:()=>1000},clearTimeout(){},clearInterval(){},setTimeout(){return 1;}};
 vm.runInNewContext(source+'\n globalThis.feed=(s,u)=>{running=s;matched(s,u);};globalThis.end=finish;',context);
 const state={config:{token:'test'},startedAt:0,lastMotion:0,failures:0,height:240,chunks:1,sampleIndex:0,inflight:{id:1,atMs:50},queue:[],queueBytes:0,matcherReady:false,lastProgress:0};
 context.feed(state,{id:1,result:{auto:true,kind:'occluded',shift:16},height:240,chunks:1,added:0,capturedHeight:304,capturedChunks:5,capturedAdded:16});
 assert.equal(state.height,240);assert.equal(state.chunks,1);assert.equal(state.capturedHeight,304);assert.equal(state.capturedChunks,5);assert.equal(state.lastMotion,1000);
 assert.equal(progress.at(-1).height,304);assert.equal(traces[0].p.height,240);
 assert.match(progress.at(-1).message,/未确认/);assert.match(state.pendingWarning,/重复或缺失/);
 assert.equal(traces[0].p.added,0);assert.equal(traces[0].p.capturedAdded,16);
 state.matcherReady=true;state.matcher={postMessage:p=>packets.push(p)};
 await context.end(state,'已到上限','size-limit');
 assert.deepEqual(finishing,['test']);assert.equal(packets[0].type,'finish');
});

