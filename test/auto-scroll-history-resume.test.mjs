import test from 'node:test';
import assert from 'node:assert/strict';
import {createAutoScrollSession} from '../core/auto-scroll-session.mjs';
import {chatFrame} from './fixtures/chat-background.mjs';
import {firstDifference} from './fixtures/auto-scenes.mjs';

function boot(options){
 const session=createAutoScrollSession(chatFrame(0,options));let clock=0;
 const accept=offset=>session.accept(chatFrame(offset,options),clock+=80);
 for(const offset of [0,40,80,240,400,560])accept(offset);
 return {session,accept};
}

test('失配后回到完全相同的末帧，恢复定位且不要求再挪动一格',()=>{
 const options={fixed:false};const {session,accept}=boot(options);
 try{
  const before=session.finish();assert.equal(before.complete,true);
  const lost=accept(1900);assert.equal(lost.viewport.matched,false);assert.equal(lost.capturedAdded,0);
  const resumed=accept(560);
  assert.equal(resumed.viewport.matched,true,'不能沿用失配帧的wasMatched=false');
  assert.equal(resumed.capturedAdded,0,'返回已截位置不追加');
  const output=session.finish();assert.equal(output.complete,true,output.warning);
  assert.equal(firstDifference(output,before),null,'精确回位不能改写原成图');
 }finally{session.clear();}
});

test('大跳失配后返回较早已截位置，重定位而非只认最后anchor，再接新内容',()=>{
 const options={fixed:false};const {session,accept}=boot(options);
 try{
  const before=session.finish();assert.equal(before.complete,true);
  const lost=accept(1900);assert.equal(lost.viewport.matched,false);assert.equal(lost.capturedAdded,0);
  const resumed=accept(120);
  assert.equal(resumed.viewport.matched,true,JSON.stringify(resumed.autoEvidence));
  assert.equal(resumed.capturedAdded,0,'重定位不能补造跳过的图');
  assert.equal(resumed.capturedHeight,before.height);
  const output=session.finish();assert.equal(output.complete,true,output.warning);
  assert.equal(firstDifference(output,before),null,'回到历史位置不重复插入片段');
  for(const offset of [240,400,560,720])accept(offset);
  const extended=session.finish();assert.equal(extended.complete,true,extended.warning);
  assert.equal(extended.height,539+720);
  assert.equal(firstDifference(extended,chatFrame(0,{...options,height:539+720})),null,'续接后的整个文档逐字节一致');
 }finally{session.clear();}
});

test('固定带线壁纸重定位只恢复位置，不洗掉既有遮挡缺口或冒充完整',()=>{
 const options={fixed:true,outlinedWallpaper:true};const {session,accept}=boot(options);
 try{
  const before=session.finish();assert.equal(before.complete,false,'此既有背景夹具本就有缺口');
  assert.ok(before.missingRanges.length>0);
  accept(1900);
  const exact=accept(560);assert.equal(exact.viewport.matched,true,'背景页精确回位也要恢复');
  // 独立测得：120 对所有保留原帧均有冲突；96 则有多个严格证明。
  // 不为续接放松固定背景门：先验证拒绝，再验证原门下可证明的历史位置。
  const refused=accept(120);assert.equal(refused.viewport.matched,false,'所有原帧证明失败时仍必须拒绝');
  assert.equal(refused.capturedAdded,0);
  const resumed=accept(96);assert.equal(resumed.viewport.matched,true,JSON.stringify(resumed.autoEvidence));
  assert.equal(resumed.capturedAdded,0);
  const output=session.finish();assert.equal(output.complete,false,'找到位置不等于核验完固定遮挡');
  assert.ok(output.missingRanges.length>0);assert.ok(output.warning);
  assert.equal(output.height,before.height);
 }finally{session.clear();}
});

test('达到成图尺寸上限后，图外anchor的相同帧不能被恢复成已定位',()=>{
 const options={fixed:false};const session=createAutoScrollSession(chatFrame(0,options),{maxHeight:639});let clock=0;
 const accept=offset=>session.accept(chatFrame(offset,options),clock+=80);
 try{
  for(const offset of [0,40,80])accept(offset);
  const overflow=accept(240);assert.equal(overflow.limit,true);assert.equal(overflow.capturedHeight,619);
  const same=accept(240);assert.notEqual(same.viewport?.matched,true,'相同像素也不能为图外位置背书');
  assert.equal(same.capturedAdded,0);
  const output=session.finish();assert.equal(output.complete,false);assert.equal(output.height,619);
 }finally{session.clear();}
});

test('失配后正常匹配回已截范围，也要清掉失配pending而非只让框变绿',()=>{
 const options={fixed:false};const {session,accept}=boot(options);
 try{
  const before=session.finish();accept(1900);
  const resumed=accept(400);assert.equal(resumed.viewport.matched,true);
  assert.equal(resumed.capturedAdded,0);
  const output=session.finish();assert.equal(output.complete,true,output.warning);
  assert.equal(firstDifference(output,before),null);
 }finally{session.clear();}
});

test('只有固定顶栏像素变化，正文严格相同的零位移也可恢复定位',()=>{
 const options={fixed:false};const {session,accept}=boot(options);
 try{
  const before=session.finish();assert.ok(session.stats().result.content.top>0);
  accept(1900);
  const image=chatFrame(560,options);image.data[0]^=1;
  const resumed=session.accept(image,2000);
  assert.equal(resumed.viewport.matched,true,'正文逐字节相同，不应仅因shift=0保持红框');
  assert.equal(resumed.capturedAdded,0);
  const output=session.finish();assert.equal(output.complete,true,output.warning);
  assert.equal(firstDifference(output,before),null);
 }finally{session.clear();}
});

test('正文不严格相同的一般still，不能在未定位时冒报恢复或完成',()=>{
 const options={fixed:false};const {session,accept}=boot(options);
 try{
  const before=session.finish();accept(1900);
  const image=chatFrame(560,options);image.data[(200*343+100)*4]^=1;
  const update=session.accept(image,2000),matched=update.viewport?.matched===true;
  // 正文一个像素有变，不能靠一般still清失配。若其他历史原帧严格证明回位，则允许恢复。
  assert.equal(update.recoveredFrames,matched?1:0,'红框帧不能报恢复事件');
  const output=session.finish();assert.equal(output.complete,matched,'未确认回位不能洗掉失配pending');
  assert.equal(update.capturedAdded,0);
  assert.equal(firstDifference(output,before),null);
 }finally{session.clear();}
});

test('最后一个历史候选耗尽共享预算时，在提交定位之前安全放弃',()=>{
 const options={fixed:false};let timing=false,reads=0;
 // 建图时不耗时；六帧缓存下，恢复时第七次取时已经落在五个历史候选之后。
 const now=()=>timing&&++reads>=7?2000:0;
 const session=createAutoScrollSession(chatFrame(0,options),{analysisBudgetMs:1000,now});let clock=0;
 const accept=offset=>session.accept(chatFrame(offset,options),clock+=80);
 try{
  for(const offset of [0,40,80,240,400,560])accept(offset);
  const before=session.finish();accept(1900);
  const count=session.stats().pendingFrames;
  timing=true;let update;
  assert.doesNotThrow(()=>{update=accept(120);},'历史搜索预算到期应在record前放弃，不推进后再抛异常');
  assert.ok(reads>=7,'确实触发末尾预算边界');
  assert.equal(update.viewport?.matched,false);
  assert.equal(update.recoveredFrames,0);assert.equal(update.capturedAdded,0);
  assert.equal(update.pendingFrames,count,'不能提交未经最终预算检查的anchor');
  assert.equal(update.capturedHeight,before.height);
  const output=session.finish();assert.equal(output.complete,false);
  assert.equal(firstDifference(output,before),null);
 }finally{session.clear();}
});

test('历史原帧正文严格相同且只有顶栏变化时，小缓存也能定位旧位置',()=>{
 const options={fixed:false};const seed=chatFrame(0,options),frameBytes=seed.data.byteLength;
 const session=createAutoScrollSession(seed,{maxFrames:3,maxBytes:frameBytes*3});let clock=0;
 const accept=offset=>session.accept(chatFrame(offset,options),clock+=80);
 try{
  for(const offset of [0,40,80,240,400,560])accept(offset);
  const before=session.finish();assert.equal(before.complete,true,before.warning);
  assert.ok(session.stats().result.content.top>0);
  accept(1900);
  // 保留的0/400/560中，只有原帧0的正文能证明回位；其余距离均超局部匹配范围。
  const image=chatFrame(0,options);image.data[0]^=1;
  const update=session.accept(image,2000);
  assert.equal(update.viewport?.matched,true,'不能要求历史原帧的固定顶栏时钟也完全相同');
  assert.equal(update.recoveredFrames,1);assert.equal(update.capturedAdded,0);
  assert.ok(update.pendingFrames<=3);assert.ok(update.pendingBytes<=frameBytes*3);
  const output=session.finish();assert.equal(output.complete,true,output.warning);
  assert.equal(firstDifference(output,before),null);
  // 往返淘汰邻帧后，exact anchor可作为已证明候选；其余保留原帧仍须全部核对，不能强要两个参考。
  assert.equal(accept(560).viewport?.matched,true);
  accept(1900);
  const home=accept(560);assert.equal(home.viewport?.matched,true);
  assert.equal(home.recoveredFrames,1);assert.equal(home.capturedAdded,0);
  assert.ok(home.pendingFrames<=3);assert.ok(home.pendingBytes<=frameBytes*3);
  assert.equal(session.finish().complete,true);
 }finally{session.clear();}
});
