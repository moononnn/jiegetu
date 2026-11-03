import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createScene,firstDifference} from './fixtures/auto-scenes.mjs';

const url=new URL('../core/auto-scroll-session.mjs',import.meta.url);
const source=fs.readFileSync(url,'utf8').replace(/from '(\.\/[^']+)'/g,(_,p)=>`from '${new URL(p,url).href}'`);
async function load(tag,uncached=false){
 let code=source;
 if(uncached){
  const lookup=' let cache=presenceCache.get(mask);const cached=cache?.get(record);if(cached!==undefined)return cached;';
  const store=' if(!cache){cache=new WeakMap();presenceCache.set(mask,cache);}cache.set(record,result);';
  assert.ok(code.includes(lookup)&&code.includes(store));code=code.replace(lookup,'').replace(store,'');
 }
 assert.ok(code.includes('let same=0;for(let k=0;k<mask.points.length;k++){'));
 code=code.replace('let same=0;for(let k=0;k<mask.points.length;k++){',`globalThis[${JSON.stringify(tag)}]=(globalThis[${JSON.stringify(tag)}]??0)+mask.points.length;let same=0;for(let k=0;k<mask.points.length;k++){`);
 return import('data:text/javascript,'+encodeURIComponent(code+'\nexport {present as probePresent,crop as probeCrop};'));
}
const cached=await load('__cachedPresenceReads'),baseline=await load('__baselinePresenceReads',true);
function record(value){return {offset:16,image:{data:new Uint8ClampedArray([value,value,value,255])}};}
const mask=()=>({points:[{i:0,r:50,g:50,b:50}]});
test('裁切必须复制，片段修补不得改写缓存依据的原帧',()=>{
 const image={width:1,height:2,data:new Uint8ClampedArray([50,50,50,255,100,100,100,255])},before=image.data.slice();
 const part=cached.probeCrop(image,0,1);assert.notEqual(part.data.buffer,image.data.buffer);part.data.fill(0);
 assert.deepEqual(image.data,before);
});
test('同一模板与不可变原帧只核验一次，true/false及同位移另一帧不串缓存',()=>{
 globalThis.__cachedPresenceReads=0;
 const m=mask(),yes=record(50),no=record(100);
 for(let i=0;i<20;i++){assert.equal(cached.probePresent(m,yes),true);assert.equal(cached.probePresent(m,no),false);}
 assert.equal(globalThis.__cachedPresenceReads,2);
 assert.equal(cached.probePresent(m,record(50)),true);assert.equal(globalThis.__cachedPresenceReads,3);
 assert.equal(cached.probePresent(mask(),yes),true);assert.equal(globalThis.__cachedPresenceReads,4);
});
test('取消重复核验而不改变缺口、可信进度和原始成图，浮物出现/消失仍正确',()=>{
 for(const options of [
  {ball:'screen',ballRadius:8,lastFrameHasBall:false},
  {ball:'screen',ballRadius:8,offsets:[0,2,4,6,8]},
  {top:32,bottom:48,ball:'screen',ballRadius:8,lastFrameHasBall:false},
  {ball:'screen',ballRadius:8,lastFrameHasBall:false,offsets:Array.from({length:24},(_,i)=>i*8)}
 ]){
  const scene=createScene(options),run=(module,key)=>{
   globalThis[key]=0;const s=module.createAutoScrollSession(scene.seedFrame);const start=performance.now();
   const updates=scene.frames.map((f,i)=>s.accept(f.image,i*50)),out=s.finish();s.clear();
   return {out,updates,reads:globalThis[key],ms:performance.now()-start};
  };
  const before=run(baseline,'__baselinePresenceReads'),after=run(cached,'__cachedPresenceReads');
  assert.equal(firstDifference(before.out,after.out),null);assert.equal(before.out.complete,after.out.complete);
  assert.deepEqual(before.out.missingRanges,after.out.missingRanges);assert.equal(before.out.warning,after.out.warning);
  assert.deepEqual(before.updates,after.updates);
  assert.ok(after.reads<before.reads/2,JSON.stringify({before:before.reads,after:after.reads}));
  console.log('PRESENCE_CACHE_EQUIVALENT',JSON.stringify({options,beforeReads:before.reads,afterReads:after.reads,beforeMs:+before.ms.toFixed(2),afterMs:+after.ms.toFixed(2)}));
 }
});
