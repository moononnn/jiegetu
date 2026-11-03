'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function harness(hostName = 'selection') {
  const handlers = {}, frames = [], calls = [];
  let receive, rejectChoice = false;
  const document = { activeElement: null };
  class Element {
    constructor(tag) { this.tagName=tag; this.children=[]; this.inert=false; this.isConnected=true; this.listeners={}; this.attrs={}; }
    append(...nodes) { for (const node of nodes) { node.parent=this; this.children.push(node); } }
    remove() { this.parent.children=this.parent.children.filter(child=>child!==this); this.isConnected=false; }
    setAttribute(name,value) { this.attrs[name]=value; }
    addEventListener(name,fn) { this.listeners[name]=fn; }
    focus() { document.activeElement=this; }
    getBoundingClientRect() { return {width:420,height:200}; }
    click() { this.listeners.click?.(); }
  }
  document.createElement=tag=>new Element(tag);
  document.body=new Element('body');
  const original=new Element('button'), alreadyInert=new Element('div'); alreadyInert.inert=true;
  document.body.append(original,alreadyInert); original.focus();
  const host={onExitConfirmation:fn=>{receive=fn;},replyExitConfirmation:(id,choice)=>{calls.push([id,choice]);return rejectChoice&&choice!=='ready'?Promise.reject(new Error('suspended')):Promise.resolve();}};
  const window={ [hostName]:host, addEventListener:(type,fn,capture)=>{assert.equal(capture,true);handlers[type]=fn;} };
  vm.runInNewContext(read('renderer/exit-confirmation.js'),{window,document,requestAnimationFrame:fn=>frames.push(fn),Promise,Set});
  const key=(key,opts={})=>{const e={key,...opts,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;}}; handlers.keydown(e);return e;};
  const flush=()=>{const next=frames.splice(0);next.forEach(fn=>fn());};
  const panel=()=>document.body.children.at(-1).children[0];
  const buttons=()=>panel().children.at(-1).children;
  return {document,original,alreadyInert,calls,receive,key,flush,buttons,panel,fail:()=>{rejectChoice=true;},allow:()=>{rejectChoice=false;}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('两个 owner 显示安全焦点、焦点循环、阻断快捷键且放行 F1，关闭恢复原状态', async()=>{
  for(const name of ['selection','editorHost']){
    const h=harness(name);h.receive({id:'a',open:true}); const [keep,discard]=h.buttons();
    assert.equal(h.document.activeElement,keep);assert.equal(h.original.inert,true);assert.equal(h.panel().attrs.role,'alertdialog');assert.equal(h.panel().attrs['aria-modal'],'true');
    for(const type of ['pointerdown','pointerup','wheel','click']){let stopped=false;h.panel().parent.listeners[type]({stopPropagation(){stopped=true;}});assert.equal(stopped,true,`${type} 不得冒泡到底层`);}
    assert.equal(h.calls.length,0,'点击背景不触发退出');
    assert.equal(h.key('Tab').stopped,true);assert.equal(h.document.activeElement,discard);
    h.key('Tab');assert.equal(h.document.activeElement,keep);h.key('Tab',{shiftKey:true});assert.equal(h.document.activeElement,discard);
    assert.equal(h.key('x').prevented,true);assert.equal(h.key('F1').stopped,undefined);
    h.key('Escape',{repeat:true});assert.equal(h.calls.length,0);h.key('Escape');await tick();assert.deepEqual(h.calls,[['a','keep']]);
    h.receive({id:'other',open:false});assert.equal(h.original.inert,true);
    h.receive({id:'a',open:false});assert.equal(h.original.inert,false);assert.equal(h.alreadyInert.inert,true);assert.equal(h.document.activeElement,h.original);
  }
});

test('两帧后 ready，重复 open、不匹配 close 与迟到帧不触发旧请求',async()=>{
 const h=harness();h.receive({id:'one',open:true});h.receive({id:'one',open:true});h.flush();assert.equal(h.calls.length,0);h.receive({id:'one',open:false});h.flush();assert.equal(h.calls.length,0);
 h.receive({id:'one',open:true});assert.equal(h.document.body.children.length,2);
 h.receive({id:'two',open:true});h.receive({id:'one',open:false});h.flush();h.flush();await tick();assert.deepEqual(h.calls,[['two','ready']]);
});

test('Enter 按当前按钮选择，默认和 Escape 都安全保留',async()=>{
 const h=harness();h.receive({id:'enter',open:true});h.key('Enter');await tick();assert.deepEqual(h.calls,[['enter','keep']]);
 h.key('Tab');h.key('Enter');await tick();assert.deepEqual(h.calls,[['enter','keep'],['enter','discard']]);
});

test('回复被拒绝后保持面板并允许重试，只有主进程 close 才收起',async()=>{
 const h=harness();h.receive({id:7,open:true});h.fail();h.buttons()[1].click();await tick();assert.deepEqual(h.calls,[[7,'discard']]);assert.equal(h.original.inert,true);
 h.allow();h.buttons()[1].click();await tick();assert.deepEqual(h.calls,[[7,'discard'],[7,'discard']]);assert.equal(h.original.inert,true);
 h.receive({id:7,open:false});assert.equal(h.original.inert,false);
});

test('两个 preload 只通过固定退出确认通道订阅与回复',async()=>{
 for(const file of ['main/selection-preload.cjs','main/image-editor-preload.cjs']){
  let api;const listeners=new Map(),calls=[];const electron={contextBridge:{exposeInMainWorld:(_name,value)=>{api=value;}},ipcRenderer:{on:(name,fn)=>listeners.set(name,fn),removeListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);},invoke:(...args)=>{calls.push(args);return Promise.resolve(true);}}};
  vm.runInNewContext(read(file),{require:()=>electron,process:{platform:'win32'},Promise,String});
  const seen=[];const off=api.onExitConfirmation(v=>seen.push(v));const payload={id:'n',open:true};listeners.get('shot:exit-confirmation')({},payload);assert.equal(seen[0],payload);
  await api.replyExitConfirmation('n','keep');assert.deepEqual(calls,[['shot:exit-confirmation-reply','n','keep']]);off();assert.equal(listeners.has('shot:exit-confirmation'),false);assert.equal(api.invoke,undefined);assert.equal(api.readFile,undefined);
 }
});

test('两个页面通过自有 CSP 资源加载，打包白名单包含 renderer',()=>{
 for(const file of ['renderer/selection.html','renderer/image-editor-window.html']){const html=read(file);assert.match(html,/script-src 'self'/);assert.match(html,/exit-confirmation\.js/);assert.match(html,/exit-confirmation\.css/);}
 const config=JSON.parse(read('electron-builder.json'));assert.ok(config.files.includes('renderer/**/*'));
});
