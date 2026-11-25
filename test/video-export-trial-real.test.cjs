'use strict';
// Explicit opt-in R&D integration: no desktop, no install, synthetic media only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createTrialLoader, CONFIG, SCRATCH, PINS } = require('../main/video-export-trial.cjs');
const { runProcess, createVideoExporter } = require('../main/video-export.cjs');
const ffmpeg=process.env.VIDEO_TEST_FFMPEG,ffprobe=process.env.VIDEO_TEST_FFPROBE,samples=process.env.VIDEO_TEST_SYNTHETIC_DIR;
const enabled=Boolean(ffmpeg&&ffprobe&&samples);
const pin=(exe,args)=>runProcess(exe,args,{timeoutMs:60000});
test('opt-in pinned local trial uses verified snapshots and removes all scratch after synthetic export', { skip:enabled?false:'set VIDEO_TEST_FFMPEG, VIDEO_TEST_FFPROBE and VIDEO_TEST_SYNTHETIC_DIR',timeout:180000 }, async()=>{
  for(const p of [ffmpeg,ffprobe,samples])assert.ok(path.isAbsolute(p));
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'jiegetu-real-trial-'));
  try{
    const config={enabled:true,ffmpeg:{path:ffmpeg,sha256:PINS.ffmpeg},ffprobe:{path:ffprobe,sha256:PINS.ffprobe}};
    await fs.writeFile(path.join(root,CONFIG),JSON.stringify(config),{flag:'wx'});
    const loader=createTrialLoader({userData:root,isPackaged:false});await loader.cleanup();const exportVideo=await loader.load();assert.equal(typeof exportVideo,'function','supplied binaries must match pinned local R&D build');
    const bytes=await fs.readFile(path.join(samples,'h264-aac-160x120.mp4')),original=Buffer.from(bytes);
    const output=await exportVideo({original:{bytes,extension:'mp4',mimeType:'video/mp4',hasAudio:true},plan:{durationMs:3091,ranges:[{startMs:250,endMs:1250},{startMs:1800,endMs:2500}],totalMs:1700}});
    assert.equal(output.extension,'mp4');assert.ok(output.bytes.length>100);assert.match(output.mimeType,/^video\/mp4;codecs=avc1\.[0-9a-f]{6},mp4a\.40\.2$/);assert.deepEqual(bytes,original);
    assert.deepEqual(await fs.readdir(path.join(root,SCRATCH)),[]);
    const noisy=await fs.readFile(path.join(samples,'integrated-0.mp4')),noisyBefore=Buffer.from(noisy);
    await assert.rejects(exportVideo({original:{bytes:noisy,extension:'mp4',mimeType:'video/mp4',hasAudio:true},plan:{durationMs:2345,ranges:[{startMs:100,endMs:2000}],totalMs:1900}}),/音视频轨道时长差异过大/);
    assert.deepEqual(noisy,noisyBefore);assert.deepEqual(await fs.readdir(path.join(root,SCRATCH)),[]);
    // 代表性真 VFR 合成源：>100ms 显示空洞 + <1/60 近帧（普通导出器会以 export-timing 拒绝）。
    // 试用装载器启用显式时间轴候选后必须能导出，且原始文件不变、输出可完整解码。
    const colors=['red','green','blue','yellow'];
    for(const c of colors) await pin(ffmpeg,['-v','error','-f','lavfi','-i',`color=c=${c}:s=160x120`,'-frames:v','1',path.join(root,`${c}.png`),'-y']);
    const seqDir=path.join(root,'seq');await fs.mkdir(seqDir);
    const sched=[[0,0],[1,0.04],[2,0.11],[3,0.35],[0,0.42],[1,0.46]];
    for(let k=0;k<sched.length;k++) await fs.copyFile(path.join(root,`${colors[sched[k][0]]}.png`),path.join(seqDir,`f${String(k).padStart(3,'0')}.png`));
    let expr='0';for(let k=sched.length-1;k>=0;k--) expr=`if(eq(N\\,${k})\\,${sched[k][1]}\\,${expr})`;
    const vfrFile=path.join(root,'vfr.mp4');
    await pin(ffmpeg,['-v','error','-framerate','1000','-start_number','0','-i',path.join(seqDir,'f%03d.png'),'-f','lavfi','-i','sine=frequency=440:duration=0.50','-vf',`setpts='${expr}/TB'`,'-fps_mode','vfr','-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p','-enc_time_base','1/90000','-video_track_timescale','90000','-c:a','aac','-shortest','-movflags','+faststart','-y',vfrFile]);
    const vfrBytes=await fs.readFile(vfrFile),vfrBefore=Buffer.from(vfrBytes);
    const srcPackets=(await pin(ffprobe,['-v','error','-protocol_whitelist','file,pipe','-f','mp4','-select_streams','v:0','-show_entries','packet=pts_time,duration_time','-of','csv=p=0',vfrFile])).stdout.trim().split(/\r?\n/).map(l=>l.split(',').map(Number));
    const srcMaxPacketMs=Math.max(...srcPackets.map(r=>r[1]*1000));
    const vfrMeta=JSON.parse((await pin(ffprobe,['-v','error','-protocol_whitelist','file,pipe','-f','mp4','-show_entries','format=duration','-of','json',vfrFile])).stdout);
    const vfrDurationMs=Math.floor(Number(vfrMeta.format.duration)*1000);
    const vfrRanges=[{startMs:0,endMs:250},{startMs:320,endMs:450}];
    const vfrPlan={durationMs:Math.max(vfrDurationMs,vfrRanges.at(-1).endMs),ranges:vfrRanges,totalMs:vfrRanges.reduce((n,r)=>n+r.endMs-r.startMs,0)};
    // 对照：普通导出器（默认 packet）仍以 export-timing 拒绝同一个源 —— 成功只能来自试用装载器的候选。
    const ordinary=createVideoExporter({ffmpegPath:ffmpeg,ffprobePath:ffprobe,scratchRoot:path.join(root,'ordinary'),timeoutMs:60000});
    await fs.mkdir(path.join(root,'ordinary'),{recursive:true});
    await assert.rejects(ordinary({original:{bytes:vfrBytes,extension:'mp4',mimeType:'video/mp4',hasAudio:true},plan:vfrPlan}),e=>e.code==='export-timing'&&e.subcode==='video-gap-large');
    const vfrOut=await exportVideo({original:{bytes:vfrBytes,extension:'mp4',mimeType:'video/mp4',hasAudio:true},plan:vfrPlan});
    assert.equal(vfrOut.extension,'mp4');assert.ok(vfrOut.bytes.length>100);
    assert.deepEqual(vfrBytes,vfrBefore,'原始文件必须保持不变');
    const vfrOutFile=path.join(root,'vfr-out.mp4');await fs.writeFile(vfrOutFile,vfrOut.bytes,{flag:'wx'});
    await pin(ffmpeg,['-v','error','-xerror','-i',vfrOutFile,'-map','0:v:0','-map','0:a:0','-f','null','-']);
    const vfrOutMeta=JSON.parse((await pin(ffprobe,['-v','error','-protocol_whitelist','file,pipe','-f','mp4','-show_entries','stream=codec_type,codec_name,nb_frames:format=duration','-of','json',vfrOutFile])).stdout);
    assert.deepEqual(vfrOutMeta.streams.map(s=>[s.codec_type,s.codec_name]),[['video','h264'],['audio','aac']]);
    assert.equal(Number(vfrOutMeta.streams.find(s=>s.codec_type==='video').nb_frames),5,'输出帧数应等于排程帧数');
    // 尾帧时长余量由源包元数据决定（源本身的 stts 时长不规范），因此用源实际最大包长定界。
    assert.ok(Math.abs(Number(vfrOutMeta.format.duration)*1000-vfrPlan.totalMs)<=60+srcMaxPacketMs,'输出时长应落在保留计划范围内');
    assert.ok(Number(vfrOutMeta.format.duration)*1000>=vfrPlan.totalMs-20,'输出不得短于保留计划');
    assert.deepEqual(await fs.readdir(path.join(root,SCRATCH)),[]);
  }finally{await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200})}
});
