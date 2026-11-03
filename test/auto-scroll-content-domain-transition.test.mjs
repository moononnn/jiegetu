import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoScrollSession } from '../core/auto-scroll-session.mjs';
import { firstDifference } from './fixtures/auto-scenes.mjs';

// 同一份连续文档：前段消息宽，后段消息窄。不能通过临时裁画面伪造内容消失。
const W=720,H=900;
function documentFrame(offset,rows=H){
 const data=new Uint8ClampedArray(W*rows*4);
 for(let y=0;y<rows;y++)for(let x=0;x<W;x++){
  const docRow=offset+y,width=docRow<900?240:150;
  let v=214;
  if(x>=20&&x<20+width){
   let n=Math.imul(docRow+11,0x9e3779b1)^Math.imul(x-20+7,0x85ebca6b);
   n^=n>>>15;n=Math.imul(n,0x2545f491);n^=n>>>13;
   v=25+((n>>>3)%210);
  }
  const p=(y*W+x)*4;data[p]=data[p+1]=data[p+2]=v;data[p+3]=255;
 }
 return {width:W,height:rows,data};
}

test('初始宽消息走旧严格路径，后续窄消息仍能使用三位置核实的历史域',()=>{
 const offsets=[0,40,80,240,400,560,720,880,1040,1120];
 const session=createAutoScrollSession(documentFrame(0));
 try{
  const updates=offsets.map((offset,index)=>session.accept(documentFrame(offset),(index+1)*50));
  assert.equal(updates[2].result.kind,'forward',JSON.stringify(updates[2].autoEvidence));
  assert.equal(updates[2].autoEvidence.motionColumns,2);
  assert.notEqual(updates[2].autoEvidence.motionDomainUsed,true,'建窗本身须走原严格路径');
  assert.ok(updates[2].capturedAdded>0,'必须已建窗接入，不能靠后续重新开场规避');
  assert.equal(updates.at(-1).result.kind,'forward',JSON.stringify(updates.at(-1).autoEvidence));
  assert.ok(updates.slice(3).some(u=>u.autoEvidence.motionDomainUsed===true),'后续单桶消息须实际用历史域放行');
  const output=session.finish();
  assert.equal(output.complete,true,output.warning);
  assert.equal(output.height,H+1120);
  assert.equal(firstDifference(output,documentFrame(0,H+1120)),null,'与同一连续文档整幅逐字节相同');
 }finally{session.clear();}
});
