import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutoScrollSession } from '../core/auto-scroll-session.mjs';
import { createScene, firstDifference } from './fixtures/auto-scenes.mjs';
import { chatFrame } from './fixtures/chat-background.mjs';
import { thinScene, thinFrame } from './fixtures/thin-strokes.mjs';
import { estimateFeatureMotion } from '../core/feature-motion.mjs';
import { fingerprint, estimateMotion } from '../core/scroll.mjs';
const run=(scene,options={})=>{const session=createAutoScrollSession(scene.seedFrame,options);let time=0;const updates=scene.frames.map(f=>session.accept(f.image,time+=50));return {session,updates,output:session.finish()};};
const equal=(a,b)=>{assert.equal(a.complete,true,a.warning);assert.equal(firstDifference(a,b),null);};
const overlay=(image,rect,color)=>{const out={...image,data:new Uint8ClampedArray(image.data)};for(let y=rect.top;y<rect.bottom;y++)for(let x=rect.left;x<rect.right;x++){const i=(y*image.width+x)*4;out.data.set([...color,255],i);}return out;};

// 外侧纯色窄边只能当扫描连接段：它不能把内侧柔和壁纸挡在识别之外，也不能给它自己新豁免。
const pureMarginFrame=(left,right)=>offset=>{const image=chatFrame(offset,{alpha:1,footer:40});
 for(let y=0;y<image.height;y++){for(let x=0;x<left;x++)image.data.set([250,250,250,255],(y*image.width+x)*4);
  for(let x=0;x<right;x++)image.data.set([250,250,250,255],(y*image.width+image.width-1-x)*4);}
 return {offset,image};};
// 外层扫描结果只能靠真实诊断字段证明：edges 就是被排除在见证计数外的外边带。
const edgesOf=updates=>{for(const u of updates){const e=u.autoEvidence;if(e.fixedEdgeLeft!=null)return [e.fixedEdgeLeft,e.fixedEdgeRight];}return null;};
test('外侧纯色窄边不阻断柔和壁纸识别，正文像素来自原帧',()=>{
 for(const [left,right] of [[4,4],[12,12],[4,12],[4,0],[0,12]]){
  const frames=[0,4,108,140,172].map(pureMarginFrame(left,right)),label=`纯色边 left=${left} right=${right}`;
  const {output,updates}=run({seedFrame:frames[0].image,frames});
  assert.equal(output.complete,true,`${label}: ${output.warning}`);assert.equal(output.height,frames[0].image.height+172,label);
  // 纯色段只作连接段：壁纸边界仍落在纯色段之后的柔和纹理末尾，而不是停在纯色段内部。
  assert.deepEqual(edgesOf(updates),[22,320],`${label} 外层豁免边界`);
  // 正文（含首屏）必须逐像素来自某张原帧，不能靠铺色冒充。
  for(let y=0;y<frames[0].image.height-40+172;y++)for(let x=22;x<320;x++){
   const p=(y*output.width+x)*4;assert.ok(frames.some(f=>{const yy=y-f.offset;if(yy<0||yy>=f.image.height-40)return false;const q=(yy*output.width+x)*4;return [0,1,2,3].every(c=>output.data[p+c]===f.image.data[q+c]);}),`${label} 正文无原始来源 ${x},${y}`);
  }
 }
});
test('纯色后没有接上合格柔和纹理时不拿豁免，仍不冒充完整长图',()=>{
 const frames=[0,4,108,140,172].map(offset=>{const image=chatFrame(offset,{alpha:1,footer:40});
  for(let y=0;y<image.height;y++){for(let x=0;x<3;x++)image.data.set([250,250,250,255],(y*image.width+x)*4);
   for(let x=3;x<9;x++){const v=Math.floor(y/7)%2?30:220;image.data.set([v,v,v,255],(y*image.width+x)*4);}}
  return {offset,image};});
 const {output,updates}=run({seedFrame:frames[0].image,frames}),edges=edgesOf(updates);
 // 纯色段后接的是高对比固定条，不是柔和壁纸：左边带必须退回 0，不能拿那 3 列当豁免。
 assert.equal(edges[0],0,'纯色段不得只靠自己拿豁免');assert.equal(edges[1],320);
 assert.equal(output.complete,false);assert.ok(output.missingRanges.length>0);assert.ok(output.warning);
});
test('纯色窄边超过连接段上限时不跳，仍报不完整',()=>{
 for(const width of [20,40]){
  const frames=[0,4,108,140,172].map(pureMarginFrame(width,width)),{output,updates}=run({seedFrame:frames[0].image,frames});
  assert.equal(output.complete,false,`width=${width}`);assert.ok(output.warning,`width=${width}`);
  // 两侧都过宽：两侧都不能拿掉任何列，左边带退回 0、右边带退回满宽。
  assert.deepEqual(edgesOf(updates),[0,343],`width=${width} 外层豁免边界`);
 }
});
test('纯色窄边逐帧变色或内缘运动时不放过',()=>{
 const variants={
  整段变色:offset=>{const image=chatFrame(offset,{alpha:1,footer:40}),v=offset?250:210;
   for(let y=0;y<image.height;y++)for(let x=0;x<12;x++)image.data.set([v,v,v,255],(y*image.width+x)*4);return {offset,image};},
  内缘运动:offset=>{const image=chatFrame(offset,{alpha:1,footer:40}),v=offset?60:250;
   for(let y=0;y<image.height;y++)for(let x=0;x<12;x++)image.data.set([250,250,250,255],(y*image.width+x)*4);
   for(let y=0;y<image.height;y++)image.data.set([v,v,v,255],(y*image.width+12)*4);return {offset,image};}
 };
 for(const [label,paint] of Object.entries(variants)){
  const frames=[0,4,108,140,172].map(paint),{output}=run({seedFrame:frames[0].image,frames});
  assert.equal(output.complete,false,label);assert.ok(output.warning,label);
 }
});
test('纯白页不会因为纯色连接段拿到新壁纸豁免',()=>{
 const frames=[0,4,108,140,172].map(offset=>{const image=chatFrame(offset,{alpha:1,footer:40});
  for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++)image.data.set([250,250,250,255],(y*image.width+x)*4);
  return {offset,image};});
 const {output}=run({seedFrame:frames[0].image,frames});
 assert.equal(output.complete,false);assert.deepEqual(output.missingRanges,[]);assert.ok(output.warning);
});
test('纯色前缀必须整段同色且三帧 RGBA 稳定，漂移/alpha抖动/跨帧偏移都不跳',()=>{
 const variants={
  // 相邻列只差 2，累计漂移到 30：并不是一整段同色。
  渐变漂移:(image)=>{for(let y=0;y<image.height;y++)for(let x=0;x<8;x++){const v=250-2*x;image.data.set([v,v,v,255],(y*image.width+x)*4);}},
  // 整列 alpha 在 255/251 之间抖，不是 RGBA 近纯色。
  alpha抖动:(image)=>{for(let y=0;y<image.height;y++)for(let x=0;x<3;x++)image.data.set([250,250,250,y%2?251:255],(y*image.width+x)*4);},
  // 三帧各自单帧范围都很小，但并集 3 > 2，不能算三帧稳定。
  跨帧偏移:(image,offset)=>{const shift=offset?2:0;for(let y=0;y<image.height;y++)for(let x=0;x<3;x++){const v=200+y%2+shift;image.data.set([v,v,v,255],(y*image.width+x)*4);}}
 };
 for(const [label,paint] of Object.entries(variants)){
  const frames=[0,4,108,140,172].map(offset=>{const image=chatFrame(offset,{alpha:1,footer:40});paint(image,offset);return {offset,image};});
  const {output,updates}=run({seedFrame:frames[0].image,frames}),edges=edgesOf(updates);
  assert.equal(edges[0],0,`${label}: 外层豁免不得越过不合格前缀`);
  assert.equal(output.complete,false,label);
 }
});

test('固定留白豁免不穿过高对比固定侧条，不冒充完整长图',()=>{
 const base=createScene(),paint=image=>{const out={...image,data:new Uint8ClampedArray(image.data)};for(let y=0;y<image.height;y++)for(let x=0;x<10;x++){const v=x<4?250:Math.floor(y/7)%2?30:220;out.data.set([v,v,v,255],(y*image.width+x)*4);}return out;};
 const {output}=run({...base,seedFrame:paint(base.seedFrame),frames:base.frames.map(f=>({...f,image:paint(f.image)}))});assert.equal(output.complete,false);assert.ok(output.missingRanges.length>0);assert.ok(output.warning);
});
test('自动安全：回滚不改前沿，超过原位置后逐像素接长',()=>{
 const scene=createScene({top:32,bottom:48,offsets:[0,16,32,16,48,64]});equal(run(scene).output,scene.expected);
});
test('自动安全：长序列淘汰原图后仍守真实缓存预算并保持正文',()=>{
 const offsets=Array.from({length:30},(_,i)=>i*8),scene=createScene({offsets}),maxBytes=scene.seedFrame.data.byteLength*6;
 const {session,updates,output}=run(scene,{maxFrames:6,maxBytes});
 for(const u of updates){assert.ok(u.autoEvidence.rawFrames<=6);assert.ok(u.autoEvidence.rawBytes<=maxBytes);}
 equal(output,scene.expected);session.clear();assert.throws(()=>session.stats(),/清除/);
});
test('自动安全：最小三帧预算连续接长仍逐像素一致，显式不足一字节不自动扩容',()=>{
 const scene=createScene({top:32,bottom:48,offsets:Array.from({length:12},(_,i)=>i*8)}),maxBytes=scene.seedFrame.data.byteLength*3;
 const {session,updates,output}=run(scene,{maxBytes});for(const u of updates){assert.ok(u.autoEvidence.rawFrames<=3);assert.ok(u.autoEvidence.rawBytes<=maxBytes);}equal(output,scene.expected);session.clear();
 assert.throws(()=>createAutoScrollSession(scene.seedFrame,{maxBytes:maxBytes-1}),/缓存不足/);
});
test('自动安全：maxHeight拒绝后保留可信截段但不得报本轮完整',()=>{
 const scene=createScene(),{output,updates}=run(scene,{maxHeight:scene.height+32});assert.ok(updates.some(u=>u.limit));assert.ok(output.height<=scene.height+32);assert.equal(output.complete,false);assert.match(output.warning,/上限/);
});
test('自动安全：末帧重排失配不能在finish报完整',()=>{
 const scene=createScene(),session=createAutoScrollSession(scene.seedFrame);let time=0;
 for(const f of scene.frames)session.accept(f.image,time+=50);
 const other=createScene({seed:84303}).lastFrame;const update=session.accept(other,time+=50);
 assert.equal(update.added,0);const output=session.finish();assert.equal(output.complete,false);assert.ok(output.warning);
});
test('自动安全：后出现的纯色球末帧消失，不污染已经存下的图',()=>{
 const offsets=Array.from({length:12},(_,i)=>i*16),base=createScene({offsets}),ball=createScene({offsets,ball:'screen',ballCenterY:216,lastFrameHasBall:false});
 const scene={...base,frames:base.frames.map((f,i)=>i>=4&&i<=9?ball.frames[i]:f)};equal(run(scene).output,base.expected);
});
test('自动安全：中间整宽固定条也按二维遮挡处理，不认图标',()=>{
 const base=createScene(),rect={left:0,right:base.width,top:110,bottom:118};
 const scene={...base,seedFrame:overlay(base.seedFrame,rect,[240,12,80]),frames:base.frames.map(f=>({...f,image:overlay(f.image,rect,[240,12,80])}))};equal(run(scene).output,base.expected);
});
test('自动安全：单像素局部固定干扰也不能烙进首屏',()=>{
 const base=createScene(),rect={left:20,right:21,top:120,bottom:121};
 const scene={...base,seedFrame:overlay(base.seedFrame,rect,[250,20,90]),frames:base.frames.map(f=>({...f,image:overlay(f.image,rect,[250,20,90])}))};equal(run(scene).output,base.expected);
});
test('自动安全：固定柔和壁纸不当成两侧悬浮物，固定底栏可自动略过',()=>{
 for(const footer of [0,40]){
  const frames=[0,16,32,48,64].map(offset=>({offset,image:chatFrame(offset,{footer})})),scene={seedFrame:frames[0].image,frames};
  const {output,updates}=run(scene);assert.equal(output.complete,true,output.warning);assert.equal(output.height,scene.seedFrame.height+64);
  assert.equal(output.background.active,true,'已有的柔和壁纸延展不能因自动模式消失');
  const layout=updates.find(u=>u.result.content)?.result.content;assert.deepEqual(output.data.slice(0,layout.bottom*output.width*4),scene.seedFrame.data.slice(0,layout.bottom*output.width*4),'首帧内窗及其前缀不重铺');
  // 背景允许沿用镜像延展；承载过正文的整列仍须来自正确文档位置的真实原帧，alpha不变。
  const actualBottom=scene.seedFrame.height-footer;
  for(let y=0;y<actualBottom+64;y++)for(let x=0;x<output.width;x++){
   const p=(y*output.width+x)*4;assert.equal(output.data[p+3],255);
   if(x<Math.max(8,Math.round(output.width*.064))||x>=Math.round(output.width*.933))continue;
   let source=false;
   for(const f of frames){const yy=y-f.offset;if(yy<0||yy>=actualBottom)continue;const q=(yy*output.width+x)*4;if(output.data[p]===f.image.data[q]&&output.data[p+1]===f.image.data[q+1]&&output.data[p+2]===f.image.data[q+2]&&output.data[p+3]===f.image.data[q+3]){source=true;break;}}
   assert.ok(source,`无真实来源 x=${x}, docY=${y}`);
  }
 }
});
test('自动安全：清除后所有接口拒绝继续使用，且输入不被修改',()=>{
 const scene=createScene(),before=scene.seedFrame.data.slice(),session=createAutoScrollSession(scene.seedFrame);session.clear();session.clear();assert.deepEqual(scene.seedFrame.data,before);assert.throws(()=>session.accept(scene.lastFrame,1),/清除/);assert.throws(()=>session.finish(),/清除/);
});
test('原生反例回归：旧源被球挡住不能派生出新的假浮物',()=>{
 const width=480,height=320,offsets=[0,20,40,60,80],doc=new Uint8ClampedArray(width*(height+120)*4);let seed=952;
 for(let i=0;i<doc.length;i+=4){seed=(Math.imul(seed,1664525)+1013904223)>>>0;doc[i]=doc[i+1]=doc[i+2]=seed>>>24;doc[i+3]=255;}
 const frame=offset=>{const data=doc.slice(offset*width*4,(offset+height)*width*4);
  if(offset<60)for(let y=132;y<=188;y++)for(let x=212;x<=268;x++){
   let hits=0;for(let yy=0;yy<4;yy++)for(let xx=0;xx<4;xx++)if((x+(xx+.5)/4-240)**2+(y+(yy+.5)/4-160)**2<26**2)hits++;
   const alpha=hits/16,i=(y*width+x)*4;for(let c=0;c<3;c++)data[i+c]=Math.round(data[i+c]*(1-alpha)+(c===1?0:255)*alpha);
  }
  return {width,height,data};
 };
 const frames=offsets.map(offset=>({offset,image:frame(offset)})),scene={seedFrame:frames[0].image,frames},result=run(scene);
 assert.equal(result.output.complete,true,result.output.warning);assert.equal(result.output.height,height+80);
 assert.deepEqual(result.output.data,doc.slice(0,(height+80)*width*4));
 assert.ok(result.updates.every(u=>u.autoEvidence.maskCount<=1),'没有凭被挡的旧像素认出新物体');
});
test('已知限制基线：半透明纸面混合固定壁纸仍会保守停住，不得算支持',()=>{
 const frames=[0,16,32,48,64].map(offset=>({offset,image:chatFrame(offset,{alpha:.52,footer:40})}));
 const {output}=run({seedFrame:frames[0].image,frames});assert.equal(output.complete,false);assert.ok(output.warning);assert.ok(output.missingRanges.length>0);
});
test('辅助位移：旧48列漏掉细笔画时，仍经原帧核验逐像素接长',()=>{
 const scene=thinScene();assert.equal(estimateMotion(fingerprint(scene.seedFrame),fingerprint(scene.frames[1].image)).kind,'still');
 const {updates,output}=run(scene);equal(output,scene.expected);
 const featureUpdates=updates.filter(u=>u.autoEvidence.motionMethod==='features');assert.ok(featureUpdates.length>=3);
 assert.ok(featureUpdates.every(u=>u.autoEvidence.motionCoverage>=.85));
});
test('辅助候选不能越过原帧核验：形状仍相似但对比度改变时拒绝追加',()=>{
 const a=thinFrame(0),b=thinFrame(4);for(let p=0;p<b.data.length;p+=4)for(let c=0;c<3;c++)b.data[p+c]=Math.min(255,b.data[p+c]+40);
 const candidate=estimateFeatureMotion(a,b);assert.equal(candidate.kind,'motion');assert.equal(candidate.shift,4);
 const s=createAutoScrollSession(a),u=s.accept(b,50);assert.equal(u.result.kind,'ambiguous');assert.equal(u.added,0);
 assert.equal(u.autoEvidence.motionMethod,'features');assert.equal(u.autoEvidence.analysisStage,'pixel-proof');assert.ok(u.autoEvidence.motionCoverage<.85);assert.equal(s.finish().complete,false);s.clear();
});
test('首尾闭合失败不能拿逐帧成功冒充，诊断保留闭合目标',()=>{
 const scene=createScene({offsets:[0,100,200]}),{updates,output}=run(scene),last=updates.at(-1);
 assert.equal(output.complete,false);assert.equal(last.result.kind,'ambiguous');assert.equal(last.autoEvidence.analysisStage,'closure');
 assert.equal(last.autoEvidence.closureExpected,200);assert.notEqual(last.autoEvidence.closureShift,200);assert.equal(last.autoEvidence.motionCoverage,undefined);
});
test('相同原帧不重用上一帧的特征匹配和覆盖率诊断',()=>{
 const s=createAutoScrollSession(thinFrame(0)),image=thinFrame(4),first=s.accept(image,50),same=s.accept(image,100);
 assert.equal(first.autoEvidence.motionMethod,'features');assert.equal(same.autoEvidence.analysisStage,'identical');
 assert.equal(same.autoEvidence.motionMethod,undefined);assert.equal(same.autoEvidence.motionCoverage,undefined);assert.equal(same.autoEvidence.motionSupport,undefined);s.clear();
});
test('拒绝反例：始终遮住文字的缓变软标签不能因映射点稳定而获豁免',()=>{
 const base=createScene(),frames=base.frames.map(({offset,image})=>{
  const data=new Uint8ClampedArray(image.data);
  for(let y=0;y<image.height;y++)for(let x=28;x<36;x++){
   const doc=y+offset;let v=doc>=136&&doc<140?35:250;
   if(y>=60&&y<=220)v=250-2*Math.max(0,Math.min(y-60,220-y));
   data.set([v,v,v,255],(y*image.width+x)*4);
  }
  return {offset,image:{...image,data}};
 });
 const {updates,output}=run({...base,seedFrame:frames[0].image,frames});assert.equal(output.complete,false);assert.ok(output.missingRanges.length>0);
 assert.ok(updates.some(u=>u.autoEvidence.fixedStopReason==='large-region'));
});
test('自动安全：探测期与非法缓存参数不伪报完整',()=>{
 const scene=createScene(),session=createAutoScrollSession(scene.seedFrame);assert.equal(session.stats().complete,false);assert.equal(session.finish().complete,false);
 assert.throws(()=>createAutoScrollSession(scene.seedFrame,{maxFrames:2}),/缓存/);assert.throws(()=>createAutoScrollSession(scene.seedFrame,{maxBytes:1}),/缓存/);assert.throws(()=>session.accept(scene.lastFrame,NaN),/时间/);
});
test('自动安全：只滚一下就收尾时只保留首屏，并明确还要再小幅滚动',()=>{
 const scene=createScene(),session=createAutoScrollSession(scene.seedFrame);let time=0;
 assert.equal(session.accept(scene.seedFrame,time+=50).result.kind,'learning');
 assert.equal(session.accept(scene.frames[1].image,time+=50).result.kind,'learning');
 const output=session.finish();
 assert.equal(output.complete,false);assert.equal(output.height,scene.height);
 assert.deepEqual(output.data,scene.seedFrame.data,'只保留首屏原像素，不伪造接长');
 assert.match(output.warning,/还需再小幅滚动一下确认范围/);assert.match(output.warning,/本次仅保留首屏/);
 session.clear();
});
