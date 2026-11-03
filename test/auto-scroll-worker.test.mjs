import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { createScene, firstDifference } from './fixtures/auto-scenes.mjs';
import { thinScene } from './fixtures/thin-strokes.mjs';
// worker 现在会先发轻量的证据版本事件；harness 必须把它当元数据过滤，不能当成匹配回包或丢掉。
function channel(worker) {
 const evidence = [], waiting = [];
 worker.on('message', value => {
  if (value?.type === 'evidence-invalidated') { evidence.push(value); return; }
  waiting.shift()?.(value);
 });
 return { evidence, send: (packet, transfer) => new Promise(resolve => {
  waiting.push(resolve);
  worker.postMessage(packet, transfer ?? (packet.image ? [packet.image.data.buffer] : []));
 }) };
}
async function workerRun(scene,inspect=()=>{},evidenceOut){
 const url=new URL('../renderer/scroll-match-worker.mjs',import.meta.url).href;
 const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(`
 import {parentPort} from 'node:worker_threads';
 globalThis.self={postMessage:(packet,transfer)=>parentPort.postMessage(packet,transfer)};
 await import(${JSON.stringify(url)});
 parentPort.on('message',data=>self.onmessage({data}));`)),{type:'module'});
 const {send,evidence}=channel(worker);
 try{
  const ready=await send({type:'init',image:structuredClone(scene.seedFrame)});assert.equal(ready.type,'ready');assert.equal(ready.result.auto,true,'无手动范围时必须真正走自动核心');assert.equal(ready.complete,false);inspect(ready);
  for(let i=1;i<scene.frames.length;i++){const sample=await send({type:'frame',id:i,image:structuredClone(scene.frames[i].image),atMs:i*50});assert.equal(sample.type,'sample');assert.equal(sample.id,i);assert.equal(sample.result.auto,true);inspect(sample);}
  const done=await send({type:'finish'});assert.equal(done.type,'done');if(evidenceOut)evidenceOut.push(...evidence);return done.output;
 }finally{await worker.terminate();}
}
for(const [name,options] of [['全滚动',{}],['仅顶部',{top:32}],['仅底部',{bottom:48}],['上下固定',{top:32,bottom:48}],['局部浮物',{ball:'screen',lastFrameHasBall:false}]])test(`真实Worker默认自动：${name}，无手动content且PNG前RGBA零差异`,async()=>{
 const scene=createScene(options),output=await workerRun(scene);assert.equal(output.complete,true,output.warning);assert.equal(firstDifference(output,scene.expected),null);
});
test('真实Worker：细笔画辅助匹配模块实际加载且整幅RGBA保持原文档',async()=>{
 const scene=thinScene(),output=await workerRun(scene);assert.equal(output.complete,true,output.warning);assert.equal(firstDifference(output,scene.expected),null);
});
test('真实Worker：首次建窗能沿用小位移正文见证，动态头尾仍各保留一次',async()=>{
 const scene=createScene({top:32,bottom:48,offsets:[0,2,66,130]});
 for(let i=2;i<scene.frames.length;i++){const image=scene.frames[i].image;
  for(let y=0;y<image.height;y++)if(y<scene.top||y>=image.height-scene.bottom)for(let x=0;x<image.width;x++){
   const v=((Math.imul(x+3,17389)^Math.imul(y+7,31337)^Math.imul(i,1103515245))>>>8)&255;image.data.set([v,v,v,255],(y*image.width+x)*4);
  }
 }
 const bytes=scene.bottom*scene.width*4;scene.expected.data.set(scene.frames.at(-1).image.data.slice(-bytes),scene.expected.data.length-bytes);
 const output=await workerRun(scene);assert.equal(output.complete,true,output.warning);assert.equal(firstDifference(output,scene.expected),null);
});
for(const [width,height]of [[2971,2152],[2701,2159],[3840,2160]])test(`真实Worker：现场大选区${width}×${height}默认启动、接长与RGBA来源一致`,async()=>{
 const base=createScene({top:32,bottom:48,bodyHeight:height-80,offsets:[0,16,32,48,64]}),expand=image=>{
  const data=new Uint8ClampedArray(width*image.height*4);
  for(let y=0;y<image.height;y++){const row=image.data.subarray(y*image.width*4,(y+1)*image.width*4);for(let x=0;x<width;x+=image.width)data.set(row.subarray(0,Math.min(image.width,width-x)*4),(y*width+x)*4);}
  return {width,height:image.height,data};
 },scene={seedFrame:expand(base.seedFrame),frames:base.frames.map(f=>({...f,image:expand(f.image)})),expected:expand(base.expected)};
 const budget=Math.max(64*1024*1024,scene.seedFrame.data.byteLength*4);
 const output=await workerRun(scene,packet=>{assert.ok(packet.autoEvidence.rawBytes<=budget);assert.ok(packet.autoEvidence.rawFrames<=6);});
 assert.equal(output.complete,true,output.warning);assert.equal(output.height,height+64);assert.equal(firstDifference(output,scene.expected),null);
});
test('真实Worker：存在始终遮住的内容，传回缺口与partial而非完整成功',async()=>{
 const scene=createScene({ball:'screen',ballRadius:8,offsets:[0,2,4,6,8]}),output=await workerRun(scene);assert.equal(output.complete,false);assert.ok(output.missingRanges.length>0);assert.ok(output.warning);assert.equal(output.data.length,output.width*output.height*4);
});

test('真实Worker：新增遮挡证据即时上报，只带递增版本号，不改变像素或完整结论',async()=>{
 const scene=createScene({ball:'screen',lastFrameHasBall:false}),evidence=[],output=await workerRun(scene,()=>{},evidence);
 assert.ok(evidence.length>0,'新增固定遮挡必须产生证据事件');
 for(const packet of evidence){
  assert.deepEqual(Object.keys(packet).sort(),['revision','type'],'证据事件只能带版本号，不得携带像素或矩形');
  assert.equal(packet.type,'evidence-invalidated');
  assert.ok(Number.isInteger(packet.revision)&&packet.revision>0);
 }
 const revisions=evidence.map(packet=>packet.revision);
 assert.deepEqual(revisions,[...revisions].sort((a,b)=>a-b),'版本号只能递增');
 assert.equal(new Set(revisions).size,revisions.length,'同一份证据不重复计版本');
 assert.equal(output.complete,true,output.warning);
 assert.equal(firstDifference(output,scene.expected),null);
});

test('真实Worker：旧手动正文范围参数明确拒绝，不再分派固定栏会话',async()=>{
 const url=new URL('../renderer/scroll-match-worker.mjs',import.meta.url).href;
 const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(`
 import {parentPort} from 'node:worker_threads';
 globalThis.self={postMessage:(packet,transfer)=>parentPort.postMessage(packet,transfer)};
 await import(${JSON.stringify(url)});
 parentPort.on('message',data=>self.onmessage({data}));`)),{type:'module'});
 try{
  const scene=createScene({top:32,bottom:48});
  const rejected=once(worker,'message');
  worker.postMessage({type:'init',image:structuredClone(scene.seedFrame),content:{top:32,bottom:200}});
  const [packet]=await rejected;
  assert.equal(packet.type,'error');assert.match(packet.message,/不再接收手动正文范围/);
  const orphan=once(worker,'message');
  worker.postMessage({type:'frame',id:1,image:structuredClone(scene.frames[1].image),atMs:50});
  const [next]=await orphan;
  assert.equal(next.type,'error');assert.match(next.message,/未启动/);
 }finally{await worker.terminate();}
});
