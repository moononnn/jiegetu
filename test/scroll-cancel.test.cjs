'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {watchScrollCancel}=require('../main/scroll-cancel.cjs');
const {spawn,spawnSync}=require('node:child_process');
const path=require('node:path');
function fixture(){
 const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
 child.stdin.end=value=>{child.ended=value;};child.kill=()=>{child.killed=true;};
 let cancelled=0,errors=[];
 const watcher=watchScrollCancel(()=>cancelled++,error=>errors.push(error),{spawn:(exe,args,options)=>{
  assert.ok(exe.endsWith('gdi-capture.exe'));assert.deepEqual(args,['--watch-cancel']);assert.equal(options.windowsHide,true);return child;
 }});
 return {child,watcher,cancelled:()=>cancelled,errors};
}
test('右键监听只回调一次并关闭子进程输入，迟到数据不重复取消',()=>{
 const h=fixture();h.child.stdout.emit('data',Buffer.from('R'));h.child.stdout.emit('data',Buffer.from('R'));
 assert.equal(h.cancelled(),1);assert.equal(h.child.ended,'Q');h.child.emit('exit',0);assert.equal(h.errors.length,0);
});
test('会话清理先停监听，迟到右键和进程退出均不取消',()=>{
 const h=fixture();h.watcher.stop();h.watcher.stop();h.child.stdout.emit('data',Buffer.from('R'));h.child.emit('exit',0);
 assert.equal(h.cancelled(),0);assert.equal(h.errors.length,0);assert.equal(h.child.ended,'Q');
});
test('监听启动或输入失败只报错一次，不伪造用户取消',()=>{
 const h=fixture();h.child.emit('error',new Error('failed'));h.child.stdin.emit('error',new Error('closed'));h.child.emit('exit',1);
 assert.equal(h.cancelled(),0);assert.equal(h.errors.length,1);assert.match(h.errors[0].message,/failed/);
});
test('监听意外退出有明确错误和有界错误文本',()=>{
 const h=fixture();h.child.stderr.emit('data',Buffer.from('x'.repeat(1000)));h.child.emit('exit',1);
 assert.equal(h.errors.length,1);assert.equal(h.errors[0].message.length,600);assert.equal(h.cancelled(),0);
});
test('重编译原生组件保留原JGC2自测协议，不采集桌面',{skip:process.platform!=='win32'},()=>{
 const result=spawnSync(path.resolve(__dirname,'../native/gdi-capture.exe'),['--self-test'],{windowsHide:true,timeout:3000});
 assert.equal(result.status,0,result.stderr?.toString());assert.equal(result.stdout.length,36);
 assert.equal(result.stdout.toString('ascii',0,4),'JGC2');assert.equal(result.stdout.readUInt32LE(4),2);assert.equal(result.stdout.readUInt32LE(8),2);
});
test('真实右键监听进程收到Q可退出，不注入鼠标或写入文件',{skip:process.platform!=='win32'},async()=>{
 const child=spawn(path.resolve(__dirname,'../native/gdi-capture.exe'),['--watch-cancel'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 const timer=setTimeout(()=>child.kill(),3000);let output='';child.stdout.on('data',value=>{output+=value.toString('ascii');});
 try{const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});child.stdin.on('error',()=>{});child.stdin.end('Q');
 const result=await exited;assert.equal(result.code,0);assert.equal(result.signal,null);assert.match(output,/^R?$/);
 }finally{clearTimeout(timer);}
});
