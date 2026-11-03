'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const source=name=>fs.readFileSync(path.join(__dirname,'../renderer',name),'utf8');
// Header fixture only: decode success/failure is explicitly controlled, not a saved screenshot.
function png(width=120,height=480,marker=0){
 const bytes=Buffer.alloc(34);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(width,16);bytes.writeUInt32BE(height,20);bytes[33]=marker;
 return {width,height,sourceHeight:4800,dataUrl:`data:image/png;base64,${bytes.toString('base64')}`};
}
function harness({initial,box={width:200,height:300}}={}){
 const ids=['height','message','finish','cancel','preview','preview-image','preview-frame','preview-note','viewport','position-status','reference','reference-title','reference-image'];
 const nodes=Object.fromEntries(ids.map(id=>[id,{textContent:'',disabled:id==='finish',hidden:['preview','reference','viewport'].includes(id),attrs:{},style:{},set src(v){this.attrs.src=v;},get src(){return this.attrs.src;},setAttribute(k,v){this.attrs[k]=v;},getAttribute(k){return this.attrs[k];},removeAttribute(k){delete this.attrs[k];},getBoundingClientRect(){return box;},click(){if(!this.disabled)return this.onclick?.();}}]));
 let status,resize,resolveInitial,finishes=0,cancels=0,toggles=0;const listeners={},images=[];
 class Image{
  constructor(){images.push(this);}
  decode(){return new Promise((resolve,reject)=>{this.resolve=()=>{const bytes=Buffer.from(this.src.split(',')[1],'base64');this.naturalWidth=bytes.readUInt32BE(16);this.naturalHeight=bytes.readUInt32BE(20);resolve();};this.reject=()=>reject(new Error('broken PNG'));});}
 }
 const api={onStatus:fn=>{status=fn;},state:()=>initial||new Promise(resolve=>{resolveInitial=resolve;}),toggleCapture:async()=>{toggles++;throw new Error('日常浮条不得调用诊断开关');},finish:async()=>{finishes++;},cancel:async()=>{cancels++;}};
 vm.runInNewContext(source('scroll-bar.js'),{Image,atob,ResizeObserver:class{constructor(fn){resize=fn;}observe(){}},document:{querySelector:s=>nodes[s.slice(1)],addEventListener:(name,fn)=>{listeners[name]=fn;}},window:{scrollBar:api}});
 return {nodes,api,images,box,resize:()=>resize(),initial:s=>resolveInitial(s),status:s=>status(s),finishes:()=>finishes,cancels:()=>cancels,toggles:()=>toggles,listeners};
}
async function ready(h,state={}){h.status({height:4800,message:'上下滚动继续接长',canFinish:true,preview:png(),viewport:{top:1200,height:600,matched:true},...state});h.images.at(-1)?.resolve();await tick();}
const number=(node,key)=>parseFloat(node.style[key]);
test('仅完成/取消，无原生提示、导航或诊断开关',async()=>{
 const h=harness();await ready(h);const html=source('scroll-bar.html');
 assert.deepEqual([...html.matchAll(/<button\b[^>]*id="([^"]+)"/g)].map(m=>m[1]),['finish','cancel']);
 assert.doesNotMatch(html,/capture-toggle|暂停取屏|恢复取屏|\btitle=/);
 assert.doesNotMatch(source('scroll-bar.js'),/captureToggle|captureBusy|pausedMessage|toggleCapture|addEventListener\(['"](?:wheel|pointerdown|mousedown)/);
 assert.equal(h.nodes.finish.disabled,false);assert.equal(h.toggles(),0);
});
test('累计高度使用height而非added，阶段提示安全显示',async()=>{
 const h=harness();h.initial({height:0});await tick();assert.equal(h.nodes.height.textContent,'已截 0 像素');
 h.status({height:12345,added:45,message:'合成中',canFinish:false});assert.equal(h.nodes.height.textContent,'已截 12345 像素');assert.equal(h.nodes.message.textContent,'合成中');assert.equal(h.nodes.finish.disabled,true);
 h.status({height:Infinity,message:{},canFinish:1});assert.equal(h.nodes.height.textContent,'已截 0 像素');assert.equal(h.nodes.message.textContent,'');assert.equal(h.nodes.finish.disabled,true);
});
test('contain真实图矩形：横向留白、缩放及纯viewport更新立即生效',async()=>{
 const h=harness();await ready(h);const v=h.nodes.viewport;
 assert.equal(h.nodes.preview.hidden,false);assert.equal(v.hidden,false);
 assert.equal(number(v,'left'),62.5);assert.equal(number(v,'width'),75);assert.equal(number(v,'top'),75);assert.equal(number(v,'height'),37.5);
 h.status({viewport:{top:2400,height:600,matched:true}});assert.equal(number(v,'top'),150);assert.equal(h.images.length,1);assert.equal(h.nodes.height.textContent,'已截 4800 像素');
 h.box.width=300;h.box.height=200;h.resize();assert.equal(number(v,'left'),125);assert.equal(number(v,'top'),100);assert.equal(number(v,'width'),50);
});
test('contain纵向留白及超长图最小框始终在图内',async()=>{
 const h=harness();await ready(h,{height:1000000,preview:{...png(240,120),sourceHeight:1000000},viewport:{top:999999,height:1,matched:true}});
 const v=h.nodes.viewport;assert.equal(number(v,'left'),0);assert.equal(number(v,'width'),200);assert.equal(number(v,'height'),6);assert.equal(number(v,'top'),194);
 h.status({viewport:{top:0,height:2000000,matched:true}});assert.equal(number(v,'top'),100);assert.equal(number(v,'height'),100);
});
test('极窄缩略图边框也不撑出真实图矩形',async()=>{
 const h=harness();await ready(h,{preview:png(1,480),viewport:{top:4800,height:1,matched:false}});const v=h.nodes.viewport;
 assert.equal(number(v,'width'),0.625);assert.equal(number(v,'borderWidth'),0.3125);assert.equal(number(v,'top')+number(v,'height'),300);
});
test('matched只读协议：失配用虚框和待匹配，无效viewport隐藏',async()=>{
 const h=harness();await ready(h);h.status({message:'已对齐当前位置',viewport:{top:100,height:500,matched:false}});
 assert.equal(h.nodes['position-status'].textContent,'待匹配');assert.equal(h.nodes.viewport.attrs['data-matched'],'false');assert.equal(h.nodes.viewport.hidden,false);
 h.status({message:'未接上',viewport:{top:100,height:500,matched:true}});assert.equal(h.nodes['position-status'].textContent,'当前位置');
 for(const viewport of [null,{top:-1,height:500,matched:true},{top:1,height:0,matched:true},{top:1.2,height:20,matched:true},{top:1,height:20,matched:'true'}]){h.status({viewport});assert.equal(h.nodes.viewport.hidden,true);assert.equal(h.nodes['position-status'].textContent,'待匹配');}
});
test('异步换图不混用新viewport与旧sourceHeight，旧decode晚到不覆盖',async()=>{
 const h=harness();await ready(h);const old=h.nodes['preview-image'].src;
 h.status({height:9600,preview:{...png(120,480,1),sourceHeight:9600},viewport:{top:4800,height:600,matched:true}});const second=h.images.at(-1);
 assert.equal(h.nodes.preview.hidden,false,'新图解码前保留旧缩略图，不闪空');assert.equal(h.nodes.viewport.hidden,true);assert.equal(h.nodes['preview-image'].src,old);
 h.status({viewport:{top:7200,height:600,matched:false}});second.resolve();await tick();assert.equal(number(h.nodes.viewport,'top'),225);assert.equal(h.nodes['position-status'].textContent,'待匹配');
 h.status({height:4800,preview:png(120,480,2),viewport:{top:0,height:600,matched:true}});const stale=h.images.at(-1);
 const latest=png(120,480,3);h.status({preview:latest,viewport:{top:1200,height:600,matched:true}});h.images.at(-1).resolve();await tick();stale.resolve();await tick();
 assert.equal(h.nodes['preview-image'].src,latest.dataUrl);assert.notEqual(h.nodes['preview-image'].src,old);assert.equal(number(h.nodes.viewport,'top'),75);
});
test('重复pending预览不重开decode，快照不受传入对象突变影响',async()=>{
 const h=harness();const preview=png();h.status({height:4800,preview,viewport:{top:0,height:600,matched:true}});h.status({preview:{...preview},viewport:{top:2400,height:600,matched:true}});assert.equal(h.images.length,1);
 preview.sourceHeight=1;h.images[0].resolve();await tick();assert.equal(number(h.nodes.viewport,'top'),150);
});
test('编码滞后时旧preview不接收新height的viewport，即使误报matched也不画框',async()=>{
 const h=harness(),preview=png();await ready(h,{preview});const src=h.nodes['preview-image'].src;
 for(const matched of [false,true]){
  h.status({height:9600,preview,viewport:{top:7200,height:600,matched}});
  assert.equal(h.nodes.preview.hidden,false);assert.equal(h.nodes['preview-image'].src,src);assert.equal(h.nodes.viewport.hidden,true);assert.equal(h.nodes['position-status'].textContent,'待更新');assert.equal(h.nodes.height.textContent,'已截 9600 像素');
  h.resize();assert.equal(h.nodes.viewport.hidden,true);
 }
 h.status({height:10000,viewport:{top:8000,height:600,matched:false}});assert.equal(h.nodes.viewport.hidden,true);assert.equal(h.nodes['position-status'].textContent,'待更新');assert.equal(h.images.length,1);
 const fresh={...png(120,480,1),sourceHeight:10000};h.status({height:10000,preview:fresh,viewport:{top:8000,height:600,matched:true}});
 assert.equal(h.nodes.viewport.hidden,true);h.images.at(-1).resolve();await tick();assert.equal(h.nodes.viewport.hidden,false);assert.equal(h.nodes['position-status'].textContent,'当前位置');assert.equal(h.nodes.viewport.attrs['data-matched'],'true');assert.equal(number(h.nodes.viewport,'top'),240);
});
test('decode期间height再次增长，decode成功也必须检查最新height才可定位',async()=>{
 const h=harness();await ready(h);const preview={...png(120,480,1),sourceHeight:9600};h.status({height:9600,preview,viewport:{top:6000,height:600,matched:true}});const pending=h.images.at(-1);
 h.status({height:12000,viewport:{top:10000,height:600,matched:false}});pending.resolve();await tick();
 assert.equal(h.nodes.preview.hidden,false);assert.equal(h.nodes.viewport.hidden,true);assert.equal(h.nodes['position-status'].textContent,'待更新');
 h.status({height:12000,preview:{...png(120,480,2),sourceHeight:12000},viewport:{top:9000,height:600,matched:true}});h.images.at(-1).resolve();await tick();assert.equal(h.nodes.viewport.hidden,false);assert.equal(number(h.nodes.viewport,'top'),225);
});
test('viewport缺失清除已有定位，同图重复或decode未完成时也只显示待匹配',async()=>{
 const h=harness(),preview=png();await ready(h,{preview});
 h.status({height:4800});assert.equal(h.nodes.viewport.hidden,true);assert.equal(h.nodes['position-status'].textContent,'待匹配');
 h.status({height:4800,preview,viewport:{top:2400,height:600,matched:true}});assert.equal(h.nodes.viewport.hidden,false);
 h.status({height:4800,preview});assert.equal(h.nodes.viewport.hidden,true);assert.equal(h.nodes['position-status'].textContent,'待匹配');
 h.status({height:4800,preview:png(120,480,1),viewport:{top:2400,height:600,matched:true}});h.status({height:4800});h.images.at(-1).resolve();await tick();assert.equal(h.nodes.viewport.hidden,true);assert.equal(h.nodes['position-status'].textContent,'待匹配');
});
test('PNG协议边界、损坏解码和尺寸伪报安全隐藏',async()=>{
 const h=harness();await ready(h);
 const invalid=[{...png(),width:241},{...png(),height:481},{...png(),width:0},{...png(),height:1.5},{...png(),sourceHeight:0},{...png(),sourceHeight:Infinity},{...png(),sourceHeight:1.5},{...png(),dataUrl:'https://example.com/a.png'},{...png(),dataUrl:'data:image/jpeg;base64,Yg=='},{...png(),dataUrl:'data:image/png;base64,Yg=='},{...png(),dataUrl:'data:image/png;base64,'+'A'.repeat(2000000)},{...png(),width:119}];
 for(const preview of invalid){h.status({preview});assert.equal(h.nodes.preview.hidden,true);assert.equal(h.nodes.viewport.hidden,true);assert.equal(h.nodes.reference.hidden,true);}
 h.status({preview:png(120,480,4)});h.images.at(-1).reject();await tick();assert.equal(h.nodes.preview.hidden,true);assert.match(h.nodes['preview-note'].textContent,/暂不可用/);
 h.status({preview:png(120,480,5)});const bad=h.images.at(-1);bad.resolve();bad.naturalWidth=1;await tick();assert.equal(h.nodes.preview.hidden,true);
 await ready(h,{preview:png(120,480,6)});h.nodes['preview-image'].onerror();assert.equal(h.nodes.preview.hidden,true);assert.equal(h.nodes.viewport.hidden,true);
});
test('相同图片解码失败后可随下一次preview重试',async()=>{
 const h=harness(),preview=png();h.status({height:4800,preview});h.images.at(-1).reject();await tick();h.status({height:4800,preview,viewport:{top:0,height:600,matched:true}});assert.equal(h.images.length,2);h.images.at(-1).resolve();await tick();assert.equal(h.nodes.preview.hidden,false);
});
test('旧decode错误不隐藏新图，初始化旧回包不覆盖实时状态',async()=>{
 const h=harness();h.status({preview:png(120,480,1)});const stale=h.images.at(-1);await ready(h,{preview:png(120,480,2)});stale.reject();await tick();h.initial({height:1,preview:png(120,480,3)});await tick();assert.equal(h.nodes.preview.hidden,false);assert.equal(h.nodes.height.textContent,'已截 4800 像素');assert.equal(h.images.length,2);
});
test('老reference明确局部含义，起始参照不冒称已接长',async()=>{
 const h=harness();h.status({added:0,reference:png(960,320)});h.images.at(-1).resolve();await tick();assert.equal(h.nodes.reference.hidden,false);assert.match(h.nodes['reference-title'].textContent,/起始局部参照/);
 h.status({added:60,message:'未接上',reference:png(960,320)});h.images.at(-1).resolve();await tick();assert.equal(h.nodes['reference-title'].textContent,'最后接上的局部参照 · 非完整图');
 h.nodes['reference-image'].onerror();assert.equal(h.nodes.reference.hidden,true);
 h.status({reference:{...png(960,320),width:961}});assert.equal(h.nodes.reference.hidden,true);
 await ready(h);h.status({reference:png(960,320),viewport:{top:0,height:600,matched:true}});assert.equal(h.nodes.reference.hidden,true);assert.equal(h.nodes.preview.hidden,false);
});
test('240×104 / 440×96紧凑策略显式隐藏缩略并保留操作与提示，200×320仍有预览',()=>{
 const css=source('scroll-bar.css'),html=source('scroll-bar.html');
 assert.match(css,/@media\(max-height:160px\)/);assert.match(css,/#preview,#reference,#preview-note\{display:none!important\}/);assert.match(css,/#compact-note\{display:block/);assert.match(html,/空间有限，缩略图已隐藏/);
 assert.match(css,/@media\(min-width:360px\)/);assert.match(css,/@media\(max-height:110px\) and \(max-width:359px\)\{#message\{display:none\}\}/);
 assert.match(css,/#preview-image\{[^}]*object-fit:contain/);assert.match(css,/#viewport\[data-matched="false"\]\{border-style:dashed/);
 assert.doesNotMatch(css,/(?:#preview|#reference)[^{]*\{[^}]*object-fit:cover/);assert.match(html,/鼠标放回选区，上下滚动继续接长/);
});
test('完成反馈、失败重试与取消/右键行为保留',async()=>{
 const h=harness();await ready(h);await h.nodes.finish.onclick();assert.equal(h.finishes(),1);assert.equal(h.nodes.finish.disabled,true);assert.match(h.nodes.message.textContent,/正在生成长图/);
 h.api.finish=async()=>{throw new Error('生成失败');};await h.nodes.finish.onclick();assert.equal(h.nodes.finish.disabled,false);assert.match(h.nodes.message.textContent,/生成失败/);
 h.status({canFinish:false});assert.equal(h.nodes.finish.disabled,true);
 let prevented=false;h.listeners.contextmenu({preventDefault(){prevented=true;}});await tick();await h.nodes.cancel.onclick();assert.equal(prevented,true);assert.equal(h.cancels(),2);assert.equal(h.toggles(),0);assert.equal(h.listeners.mousemove,undefined);
});
test('内部诊断桥接不扩大IPC权限',()=>{
 let api;const calls=[];const electron={contextBridge:{exposeInMainWorld:(_name,value)=>{api=value;}},ipcRenderer:{invoke:channel=>{calls.push(channel);},on(){},removeListener(){}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../main/scroll-bar-preload.cjs'),'utf8'),{require:()=>electron});api.toggleCapture();assert.deepEqual(calls,['scroll-bar:toggle-capture']);assert.equal(api.invoke,undefined);assert.equal(api.pointerInteractive,undefined);
});
