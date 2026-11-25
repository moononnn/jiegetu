'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createTrialLoader, CONFIG, SCRATCH, PINS } = require('../main/video-export-trial.cjs');
async function harness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'jiegetu-trial-unit-'));
  const userData = path.join(root,'userdata'), bin = path.join(root,'bin');
  await fs.mkdir(userData); await fs.mkdir(bin);
  const ffmpeg = path.join(bin,'ffmpeg.exe'), ffprobe = path.join(bin,'ffprobe.exe');
  await fs.writeFile(ffmpeg,'trusted-ffmpeg'); await fs.writeFile(ffprobe,'trusted-ffprobe');
  const calls = [];
  const hashFile = async file => { const text = await fs.readFile(file,'utf8'); return text === 'trusted-ffmpeg' ? PINS.ffmpeg : text === 'trusted-ffprobe' ? PINS.ffprobe : 'bad'; };
  const createVideoExporter = options => async request => { calls.push({ options, request }); return { bytes:new Uint8Array([1]), extension:'mp4', mimeType:'video/mp4' }; };
  const config = { enabled:true, ffmpeg:{ path:ffmpeg, sha256:PINS.ffmpeg }, ffprobe:{ path:ffprobe, sha256:PINS.ffprobe } };
  const loader = (hooks, softwareAudioTiming) => createTrialLoader({ userData, isPackaged:false, softwareAudioTiming, testHooks:{ hashFile, createVideoExporter, ...hooks } });
  const save = data => fs.writeFile(path.join(userData,CONFIG),JSON.stringify(data));
  return { root,userData,ffmpeg,ffprobe,calls,config,loader,save,done:()=>fs.rm(root,{recursive:true,force:true}) };
}

test('default off, packaged off, strict config and immutable pinned executable identity',async()=>{
  const h=await harness();try{
    assert.equal(await h.loader().load(),null); await h.save(h.config);
    let touched=false;const packaged=createTrialLoader({userData:h.userData,isPackaged:true,testHooks:{hashFile:async()=>{touched=true;throw Error()}}});
    assert.equal(await packaged.load(),null);await packaged.cleanup();assert.equal(touched,false);
    assert.equal(typeof await h.loader().load(),'function');
    for(const config of [ {...h.config,enabled:false}, {...h.config,extra:'x'}, {...h.config,ffmpeg:{...h.config.ffmpeg,sha256:'a'.repeat(64)}}, {...h.config,ffmpeg:{...h.config.ffmpeg,path:'relative/ffmpeg.exe'}}, {...h.config,ffprobe:{...h.config.ffprobe,path:h.ffmpeg}}, {...h.config,ffmpeg:{...h.config.ffmpeg,path:h.ffmpeg,arguments:['--evil']}} ]) {
      await h.save(config);assert.equal(await h.loader().load(),null);
    }
    await h.save(h.config); await fs.writeFile(h.ffmpeg,'attacker-controlled');
     let hashes=0; const loader=h.loader({hashFile:async()=>{hashes++;return 'bad';}});
     const exportVideo=await loader.load(); assert.equal(typeof exportVideo,'function'); assert.equal(hashes,0);
     await assert.rejects(exportVideo({}),/已变化/); assert.equal(hashes,1);
    assert.equal(h.calls.length,0);
  }finally{await h.done()}
});

test('private executable snapshots, no path substitution, and no retained media on success or failure',async()=>{
  const h=await harness();try{
    await h.save(h.config);let processCalls=0;
    const loader=h.loader({runProcess:async()=>{processCalls++;return {stdout:'ok',stderr:''}},createVideoExporter:({ffmpegPath,ffprobePath,scratchRoot,run})=>async()=>{
      assert.notEqual(ffmpegPath,h.ffmpeg);assert.notEqual(ffprobePath,h.ffprobe);
      await fs.writeFile(path.join(scratchRoot,'private-media'),'private');
      assert.equal((await run(ffmpegPath,['-version'],{})).stdout,'ok');
      await assert.rejects(run(h.ffmpeg,['-version'],{}),/校验/);
      await fs.writeFile(ffprobePath,'replaced');await assert.rejects(run(ffprobePath,[],{}),/校验/);
      return {bytes:new Uint8Array([7])};
    }});
    const exportVideo=await loader.load();const out=await exportVideo({original:{},plan:{}});assert.deepEqual(out.bytes,new Uint8Array([7]));assert.equal(processCalls,1);
    assert.deepEqual(await fs.readdir(path.join(h.userData,SCRATCH)),[]);
    const revoked=await loader.load();await h.save({...h.config,enabled:false});await assert.rejects(revoked({}),/已停用/);
    await h.save(h.config);const after=await loader.load();await fs.writeFile(h.ffmpeg,'changed-after-load');await assert.rejects(after({}),/已变化/);
    assert.deepEqual(await fs.readdir(path.join(h.userData,SCRATCH)),[]);
  }finally{await h.done()}
});

test('trial loader hands the explicit-PTS candidate to the exporter factory; ordinary exporter stays default',async()=>{
  const h=await harness();try{
    await h.save(h.config);
    const exportVideo=await h.loader().load();
    assert.equal(typeof exportVideo,'function');
    await exportVideo({original:{bytes:new Uint8Array([1])},plan:{durationMs:1000,ranges:[{startMs:0,endMs:500}],totalMs:500}});
    assert.equal(h.calls.length,1,'试用导出必须真的经过导出器工厂');
    assert.equal(h.calls[0].options.timeline,'explicit-pts','试用装载器必须把显式时间轴候选交给导出器');
    assert.equal(h.calls[0].options.softwareAudioTiming, undefined);
    const softwareExport = await h.loader(undefined, true).load();
    await softwareExport({});
    assert.equal(h.calls[1].options.softwareAudioTiming, true);
    // 普通导出器入口不得开启候选（只有试用装载器给）。
    const index=await fs.readFile(path.join(__dirname,'..','main','index.cjs'),'utf8');
    assert.ok(!index.includes('explicit-pts'),'普通导出器不得开启显式时间轴候选');
  }finally{await h.done()}
});

test('stale cleanup only removes marked owned runs and does not create folders when off',async()=>{
  const h=await harness();try{
    const loader=h.loader();await loader.cleanup();await assert.rejects(fs.stat(path.join(h.userData,SCRATCH)),{code:'ENOENT'});
    const root=path.join(h.userData,SCRATCH),owned=path.join(root,'run-11111111-1111-4111-8111-111111111111'),other=path.join(root,'run-22222222-2222-4222-8222-222222222222');
    await fs.mkdir(owned,{recursive:true});await fs.mkdir(other,{recursive:true});await fs.writeFile(path.join(owned,'.owner'),'jiegetu-video-editor-local-trial-v1\n');await fs.writeFile(path.join(owned,'media'),'sensitive');await fs.writeFile(path.join(other,'keep'),'untouched');
    await assert.rejects(loader.cleanup(),/归属/);await assert.rejects(fs.stat(owned),{code:'ENOENT'});assert.equal(await fs.readFile(path.join(other,'keep'),'utf8'),'untouched');
  }finally{await h.done()}
});

test('review and release builders do not glob native executables or include trial binaries',async()=>{
  for(const file of ['electron-builder.json','electron-builder.release.json']){
    const config=JSON.parse(await fs.readFile(path.join(__dirname,'..',file),'utf8'));
    assert.ok(!config.files.includes('native/*.exe'));
    assert.ok(!config.files.some(x=>/ffmpeg|ffprobe|\.tmp/i.test(x)));
  }
});
