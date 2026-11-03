import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {sanitize} from '../main/diagnostics.cjs';
const coreUrl=new URL('../core/auto-scroll-session.mjs',import.meta.url);
const source=fs.readFileSync(coreUrl,'utf8').replace(/from '(\.\/[^']+)'/g,(_,p)=>`from '${new URL(p,coreUrl).href}'`);
const {proof}=await import('data:text/javascript,'+encodeURIComponent(source+'\nexport {support as proof};'));
import {createAutoScrollSession} from '../core/auto-scroll-session.mjs';
import {createScene,firstDifference} from './fixtures/auto-scenes.mjs';

// 候选已裁到正文，但原像素复核不能把位移后的固定栏误当成正文证据。
test('学习正文后，固定头尾的动态像素不越界污染正反向位移核验',()=>{
 const scene=createScene({top:32,bottom:48,offsets:[0,16,32,96,32,112]});
 const frames=scene.frames.map((f,i)=>{
  const image={...f.image,data:f.image.data.slice()};
  if(i>=3)for(let y=image.height-scene.bottom;y<image.height;y++)for(let x=0;x<image.width;x++){
   const v=((Math.imul(x+3,17389)^Math.imul(y+7,31337)^Math.imul(i,1103515245))>>>8)&255;
   image.data.set([v,v,v,255],(y*image.width+x)*4);
  }
  if(i===4)for(let y=0;y<scene.top;y++)for(let x=0;x<image.width;x++){
   const v=((Math.imul(x+9,31337)^Math.imul(y+3,17389))>>>8)&255;
   image.data.set([v,v,v,255],(y*image.width+x)*4);
  }
  return {...f,image};
 });
 const s=createAutoScrollSession(frames[0].image),updates=frames.map((f,i)=>s.accept(f.image,i*50));
 assert.equal(updates[3].result.kind,'forward',JSON.stringify(updates[3].autoEvidence));
 assert.equal(updates[3].result.shift,64);assert.equal(updates[3].autoEvidence.motionConflicts,0);
 assert.equal(updates[4].result.kind,'reverse',JSON.stringify(updates[4].autoEvidence));
 assert.equal(updates[4].result.shift,-64);
 assert.equal(updates[5].result.kind,'forward');
 const out=s.finish(),expected={...scene.expected,data:scene.expected.data.slice()},bytes=scene.bottom*scene.width*4;
 expected.data.set(frames.at(-1).image.data.slice(-bytes),expected.data.length-bytes);
 assert.equal(out.complete,true,out.warning);assert.equal(firstDifference(out,expected),null);s.clear();
});
test('首次建窗：已有小位移正文见证后，第三位置的动态头尾不阻断学习',()=>{
 const scene=createScene({top:32,bottom:48,offsets:[0,2,66,130]});
 const frames=scene.frames.map((f,i)=>{
  const image={...f.image,data:f.image.data.slice()};
  if(i>=2)for(let y=0;y<image.height;y++)if(y<scene.top||y>=image.height-scene.bottom)for(let x=0;x<image.width;x++){
   const v=((Math.imul(x+3,17389)^Math.imul(y+7,31337)^Math.imul(i,1103515245))>>>8)&255;image.data.set([v,v,v,255],(y*image.width+x)*4);
  }
  return {...f,image};
 });
 const s=createAutoScrollSession(frames[0].image),updates=frames.map((f,i)=>s.accept(f.image,i*50));
 assert.equal(updates[2].result.kind,'forward',JSON.stringify(updates[2].autoEvidence));assert.equal(updates[2].capturedAdded,66);
 assert.equal(updates[3].result.kind,'forward');assert.equal(updates[3].result.shift,64);
 const out=s.finish(),expected={...scene.expected,data:scene.expected.data.slice()},bytes=scene.bottom*scene.width*4;
 expected.data.set(frames.at(-1).image.data.slice(-bytes),expected.data.length-bytes);
 assert.equal(out.complete,true,out.warning);assert.equal(firstDifference(out,expected),null);s.clear();
});
for(const mode of ['正文真冲突','跨过正文无重叠'])test(`首次建窗不能借临时范围绕过${mode}`,()=>{
 const scene=createScene({top:32,bottom:48,offsets:[0,2,mode==='正文真冲突'?66:270]});
 const s=createAutoScrollSession(scene.frames[0].image);s.accept(scene.frames[0].image,0);s.accept(scene.frames[1].image,50);
 const image={...scene.frames[2].image,data:scene.frames[2].image.data.slice()};
 if(mode==='正文真冲突')for(let y=96;y<144;y++)for(let x=0;x<48;x++){const p=(y*image.width+x)*4;for(let c=0;c<3;c++)image.data[p+c]^=255;}
 const u=s.accept(image,100);assert.notEqual(u.result.kind,'forward');assert.equal(u.capturedAdded,0);assert.equal(u.capturedHeight,scene.height);assert.equal(s.finish().complete,false);s.clear();
});
test('正文交集内的真实矛盾仍拒绝，交集归零不能凭固定栏通过',()=>{
 const scene=createScene({top:32,bottom:48,offsets:[0,64]}),a=scene.frames[0].image,b=scene.frames[1].image,range={top:32,bottom:272};
 assert.equal(proof(a,b,64,range).ok,true);
 const changed={...b,data:b.data.slice()};
 for(let y=96;y<144;y++)for(let x=0;x<48;x++){const p=(y*b.width+x)*4;for(let c=0;c<3;c++)changed.data[p+c]^=255;}
 assert.equal(proof(a,changed,64,range).ok,false);
 const empty=proof(a,b,240,range);assert.equal(empty.ok,false);assert.equal(empty.eligible,0);
});
test('原帧复核只记录计数，任意文本和图像信息不落盘',()=>{
 const fields={motionEligible:100,motionGood:90,motionRows:20,motionColumns:4,motionConflicts:1,barRaises:3};
 assert.deepEqual(sanitize({...fields,rawFrame:'private'}),fields);
 assert.deepEqual(sanitize({motionEligible:'private',motionGood:Infinity}),{});
});

