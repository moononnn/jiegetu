'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const source=path.join(__dirname,'../native/gdi-capture.cs'),exe=path.join(__dirname,'../native/gdi-capture.exe');
test('GDI源只抓原像素，保持硬件鼠标与软件鼠标边界声明',()=>{
 const s=fs.readFileSync(source,'utf8');assert.match(s,/Height=-h/);assert.match(s,/Size=40/);assert.match(s,/16000000/);assert.match(s,/Software cursors already in desktop pixels cannot be removed/);assert.doesNotMatch(s,/GraphicsCaptureSession|DrawIcon|ShowCursor|SetCursor\(/);assert.match(s,/SelectObject\(memory,previous\)/);assert.match(s,/ReleaseDC\(IntPtr.Zero,screen\)/);
});
test('GDI自检为完整JGC2 RGBA，不验证桌面API',()=>{
 const r=spawnSync(exe,['--self-test'],{windowsHide:true,timeout:5000});assert.equal(r.status,0,String(r.stderr));assert.equal(r.stdout.length,36);assert.equal(r.stdout.subarray(0,4).toString(),'JGC2');assert.deepEqual([...Array(4)].map((_,i)=>r.stdout.readUInt32LE(4+i*4)),[2,2,1,1]);assert.equal(r.stdout.subarray(20).toString('hex'),'010203ff040506ff070809ff0a0b0cff');
});
test('非法区域在创建桌面资源前拒绝，无像素回包',()=>{
 const r=spawnSync(exe,['0','0','16000001','1'],{windowsHide:true,timeout:5000});assert.equal(r.status,1);assert.equal(r.stdout.length,0);assert.match(String(r.stderr),/invalid-region/);
});
