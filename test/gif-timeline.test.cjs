'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parse,trim}=require('../core/gif-timeline.js');
function fixture(delays=[500,1000,300],width=2,height=2) {
  const a=[...Buffer.from('GIF89a'),width&255,width>>8,height&255,height>>8,128,0,0,0,0,0,255,255,255];
  for(const delay of delays) a.push(33,249,4,4,(delay/10)&255,(delay/10)>>8,0,0,44,0,0,0,0,width&255,width>>8,height&255,height>>8,0,2,2,68,1,0);
  return Uint8Array.from([...a,59]);
}
test('解析自家非均匀时间线且保留首尾交集',()=> {
  const t=parse(fixture());
  assert.equal(t.durationMs,1800); assert.deepEqual(t.frames,[{index:0,startMs:0,durationMs:500},{index:1,startMs:500,durationMs:1000},{index:2,startMs:1500,durationMs:300}]);
  assert.deepEqual(trim(t,200,1600),[{index:0,elapsedMs:0,durationMs:300},{index:1,elapsedMs:300,durationMs:1000},{index:2,elapsedMs:1300,durationMs:100}]);
  assert.deepEqual(trim(t,500,1500),[{index:1,elapsedMs:0,durationMs:1000}]);
  assert.equal(trim(t,0,1800).reduce((sum,f)=>sum+f.durationMs,0),1800);
});
test('单帧与同帧内 partial trim',()=> {
  assert.deepEqual(trim(parse(fixture([1000])),200,700),[{index:0,elapsedMs:0,durationMs:500}]);
  assert.deepEqual(trim(parse(fixture([10])),0,10),[{index:0,elapsedMs:0,durationMs:10}]);
});
test('拒绝所有截断、无 trailer、trailing bytes、0 帧',()=> {
  const bytes=fixture();
  for(let i=0;i<bytes.length;i++) assert.throws(()=>parse(bytes.slice(0,i)),`truncated ${i}`);
  assert.throws(()=>parse(Uint8Array.from([...bytes,0])));
  assert.throws(()=>parse(fixture([])));
});
test('拒绝不透明/处置/子帧/无效代码与超限资源',()=> {
  for(const [offset,value] of [[0,0],[22,5],[22,8],[23,0],[24,0],[29,1],[38,1]]) {
    const b=fixture([500]);b[offset]=value;
    // The zero high-delay byte is already zero; pair below explicitly tests zero delay.
    if(offset===24) b[23]=0;
    assert.throws(()=>parse(b),`${offset}:${value}`);
  }
  assert.throws(()=>parse(fixture([0])));
  assert.throws(()=>parse(fixture([31010])));
  assert.throws(()=>parse(fixture(Array(513).fill(10))));
  assert.throws(()=>parse(fixture([10],4097,1)));
  assert.throws(()=>parse(fixture([10],2001,2000)));
  assert.throws(()=>parse(new Uint8Array(48*1024*1024+1)));
  assert.throws(()=>parse([]));
});
test('循环扩展只接受自家完整的 NETSCAPE2.0 无限循环结构',()=> {
  const bytes=fixture(), extension=[33,255,11,...Buffer.from('NETSCAPE2.0'),3,1,0,0,0];
  const full=Uint8Array.from([...bytes.slice(0,19),...extension,...bytes.slice(19)]);
  assert.equal(parse(full).durationMs,1800);
  for(const offset of [21,33,34,35,37]) {const bad=full.slice();bad[offset]=255;assert.throws(()=>parse(bad));}
});

test('首尾范围必须有效且按 10ms 刻度',()=> {
  const t=parse(fixture());
  for(const [a,b] of [[0,0],[-10,100],[0,1810],[1,100],[0,101],[NaN,100],[100,90]]) assert.throws(()=>trim(t,a,b));
});

// —— 删段：返回新的连续虚拟时间线，帧号重排，sourceIndex 指回原解码帧 ——
const {remove}=require('../core/gif-timeline.js');
test('删段：整帧被删时其余帧重排且 sourceIndex 仍是原帧号，输入时间线不变',()=> {
  const t=parse(fixture());
  const before=JSON.parse(JSON.stringify(t));
  const next=remove(t,500,1500);
  assert.deepEqual(next.frames,[{index:0,sourceIndex:0,startMs:0,durationMs:500},{index:1,sourceIndex:2,startMs:500,durationMs:300}]);
  assert.equal(next.durationMs,800);
  assert.equal(next.width,2); assert.equal(next.height,2);
  assert.deepEqual(t,before,'不得修改传入的 timeline');
  // trim 的 index 是原帧号，elapsedMs 从 0 连续累加
  assert.deepEqual(trim(next,0,800),[{index:0,elapsedMs:0,durationMs:500},{index:2,elapsedMs:500,durationMs:300}]);
});
test('删段：切口落在一帧内部时两侧同源合并成一段，不拆成两帧',()=> {
  const t=parse(fixture([1000]));
  const next=remove(t,300,500);
  assert.deepEqual(next.frames,[{index:0,sourceIndex:0,startMs:0,durationMs:800}]);
  assert.equal(next.durationMs,800);
  // 长静止帧删中间：时长相加正好等于原长减删除段
  const long=parse(fixture([5000]));
  const cut=remove(long,1000,4000);
  assert.equal(cut.durationMs,2000);
  assert.deepEqual(cut.frames,[{index:0,sourceIndex:0,startMs:0,durationMs:2000}]);
});
test('删段：可连续删除多段，每次作用于上一次结果且源帧号沿用',()=> {
  const t=parse(fixture([500,1000,300,200]));
  const first=remove(t,0,500);
  assert.deepEqual(first.frames.map(f=>[f.index,f.sourceIndex,f.startMs,f.durationMs]),[[0,1,0,1000],[1,2,1000,300],[2,3,1300,200]]);
  const second=remove(first,300,1000);
  assert.deepEqual(second.frames.map(f=>[f.index,f.sourceIndex,f.startMs,f.durationMs]),[[0,1,0,300],[1,2,300,300],[2,3,600,200]]);
  assert.equal(second.durationMs,800);
  assert.equal(first.durationMs,1500,'第一次的结果不能被第二次改掉');
});
test('删段：剩余时长相加等于剪后总长，首尾与 10ms 边界都能删',()=> {
  const t=parse(fixture([500,1000,300]));
  for(const [a,b] of [[0,10],[0,1800-10],[20,30],[1700,1800]]) {
    const next=remove(t,a,b);
    assert.equal(next.durationMs,t.durationMs-(b-a),`${a}-${b}`);
    assert.equal(next.frames.reduce((sum,f)=>sum+f.durationMs,0),next.durationMs);
    assert.deepEqual(next.frames.map(f=>f.index),next.frames.map((_,i)=>i),'虚拟序号必须连续');
    let elapsed=0; for(const f of next.frames){assert.equal(f.startMs,elapsed);elapsed+=f.durationMs;}
  }
});
test('删段：拒删空段、整段、非 10ms 刻度与越界',()=> {
  const t=parse(fixture([500,1000,300]));
  for(const [a,b] of [[0,0],[500,500],[0,1800],[0,1795],[100,90],[-10,100],[0,1810],[1,100],[0,101],[NaN,100],[100.5,200]]) {
    assert.throws(()=>remove(t,a,b),undefined,`${a}-${b}`);
  }
  assert.throws(()=>remove(parse(fixture([10])),0,10),/至少保留 10ms/);
  assert.throws(()=>remove({frames:[]},0,10));
  // 10ms 粒度下最小的合法剩余就是 10ms，刚好保留 10ms 应当放行。
  assert.equal(remove(parse(fixture([1000])),0,990).durationMs,10);
});
test('删段后再 trim：虚拟序号不会当成原帧号，导出序号回落到 sourceIndex',()=> {
  const t=parse(fixture([500,1000,300]));
  const next=remove(t,500,1500);
  // 虚拟 1 号实际上要拿原图第 2 帧
  assert.equal(next.frames[1].index,1);
  assert.equal(next.frames[1].sourceIndex,2);
  assert.deepEqual(trim(next,next.frames[1].startMs,next.durationMs),[{index:2,elapsedMs:0,durationMs:300}]);
});
