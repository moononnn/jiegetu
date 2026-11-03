import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createAutoScrollSession} from '../core/auto-scroll-session.mjs';
import {createScene} from './fixtures/auto-scenes.mjs';

test('模板预算不足属于已知未核实区域，立即作废检查点且本场不再恢复为可信快照',()=>{
 const width=1000,base=createScene({top:32,bottom:48,bodyHeight:1720,offsets:[0,350,700]});
 const paint=im=>{
  const data=new Uint8ClampedArray(width*im.height*4);
  for(let y=0;y<im.height;y++){
   const row=im.data.subarray(y*im.width*4,(y+1)*im.width*4);
   for(let x=0;x<width;x+=im.width)data.set(row.subarray(0,Math.min(im.width,width-x)*4),(y*width+x)*4);
  }
  for(let y=400;y<1100;y++)for(let x=250;x<650;x++)data.set([200,20,20,255],(y*width+x)*4);
  return {width,height:im.height,data};
 };
 const evidence=[],session=createAutoScrollSession(paint(base.seedFrame),{onEvidence:(revision,reason)=>evidence.push({revision,reason})});
 let update;
 for(let i=1;i<base.frames.length;i++)update=session.accept(paint(base.frames[i].image),i*50);
 assert.equal(update.autoEvidence.fixedStopReason,'mask-budget','必须真正碰到模板点数预算，不用模拟字段');
 assert.equal(session.checkpoint(),null,'旧实现会导出2500像素并带已知未核实的固定物');
 assert.ok(evidence.some(e=>e.reason==='mask-budget'&&e.revision>0));
 session.accept(paint(base.frames.at(-1).image),200);
 assert.equal(session.checkpoint(),null,'静止或后续帧不能把未修复的旧区域重新认证');
 // 预算耗尽只是“不宣称完整”，不是“停止输出”：静止帧与收尾都必须给出完整原像素 + complete:false + 提示。
 const still=session.accept(paint(base.frames.at(-1).image),250);
 assert.equal(still.complete,false,'预算耗尽后静止帧不能宣称完整');
 assert.equal(still.height,base.height+base.offsets.at(-1),'静止帧仍按已接满高度给图，不截短');
 const done=session.finish();
 assert.equal(done.complete,false,'预算耗尽后收尾不能宣称完整');
 assert.ok(done.warning,'必须带出可见提示，不能静默宣称完整');
 assert.equal(done.height,base.height+base.offsets.at(-1),'原像素完整输出，不用截短冒充');
 assert.equal(done.data.length,done.height*width*4);
 assert.deepEqual(done.missingRanges,[],'没有证据就不伪造缺口矩形');
 session.clear();
});

test('Worker在零新增高度的新证据修复帧补发检查点，同版本静止帧不重复拷贝',()=>{
 const source=fs.readFileSync(new URL('../renderer/scroll-match-worker.mjs',import.meta.url),'utf8').replace(/^import[^\n]*\n/,'');
 const packets=[];let frame=0,revision=0,checkpointCalls=0;
 const self={postMessage:p=>packets.push(p)};
 vm.runInNewContext(source,{self,performance:{now:()=>0},ANALYSIS_BUDGET_MS:4000,
  createAutoScrollSession:(_seed,options)=>({stats:()=>({}),clear(){},
   accept(){frame++;if(frame===2){revision=1;options.onEvidence(revision);}
    return {added:frame===1?16:0,complete:true,height:80,capturedHeight:80,autoEvidence:{evidenceRevision:revision}};},
   checkpoint(){checkpointCalls++;return {width:16,height:80,data:new Uint8ClampedArray(16*80*4),evidenceRevision:revision};}
  })});
 self.onmessage({data:{type:'init',image:{}}});
 for(let id=1;id<=3;id++)self.onmessage({data:{type:'frame',id,image:{},atMs:id*50}});
 const samples=packets.filter(p=>p.type==='sample');
 assert.ok(samples[0].checkpoint);
 assert.equal(samples[1].added,0);assert.equal(samples[1].checkpoint?.evidenceRevision,1);
 assert.equal(samples[2].checkpoint,undefined);assert.equal(checkpointCalls,2);
 assert.ok(packets.findIndex(p=>p.type==='evidence-invalidated')<packets.indexOf(samples[1]));
});
