'use strict';
// Opt-in; tools are explicit local R&D paths. All input media is generated here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { createVideoExporter, runProcess } = require('../main/video-export.cjs');
const exec = promisify(execFile), ff = process.env.VIDEO_TEST_FFMPEG, fp = process.env.VIDEO_TEST_FFPROBE;
const enabled = Boolean(ff && fp);
function boxes(b, start, end) {
  const out=[];
  for(let p=start;p+8<=end;){let size=b.readUInt32BE(p),head=8;const type=b.toString('ascii',p+4,p+8);if(size===1){size=Number(b.readBigUInt64BE(p+8));head=16}if(!size)size=end-p;assert.ok(size>=head && p+size<=end,'invalid synthetic fragment');out.push({type,p,size,head});p+=size;}
  return out;
}
// Make independently timed one-sample fragments: AAC 1024 samples at 48 kHz,
// video 512 ticks at 1/12800. This creates actual uncovered audio PTS intervals,
// not an inflated previous packet duration (which MP4 muxers often synthesize).
function withGaps(base, gaps) {
  const b=Buffer.from(base);let audio=0,video=0,offset=0;
  for(const moof of boxes(b,0,b.length).filter(x=>x.type==='moof')) for(const traf of boxes(b,moof.p+moof.head,moof.p+moof.size).filter(x=>x.type==='traf')) {
    const subs=boxes(b,traf.p+traf.head,traf.p+traf.size),tfhd=subs.find(x=>x.type==='tfhd'),tfdt=subs.find(x=>x.type==='tfdt'),trun=subs.find(x=>x.type==='trun');
    assert.ok(tfhd && tfdt && trun,'missing synthetic fragment');
    const id=b.readUInt32BE(tfhd.p+tfhd.head+4),flags=b.readUInt32BE(tfhd.p+tfhd.head)&0xffffff;
    assert.ok((id===1||id===2) && flags===0x020038 && b.readUInt32BE(trun.p+trun.head+4)===1 && b[tfdt.p+tfdt.head]===1,'unexpected FFmpeg fixture layout');
    let time,duration;
    if(id===1){time=video++*512;duration=512;}
    else {offset+=gaps[audio] || 0;time=audio++*1024+offset;duration=1024;}
    b.writeUInt32BE(duration,tfhd.p+tfhd.head+8);b.writeBigUInt64BE(BigInt(time),tfdt.p+tfdt.head+4);
  }
  assert.ok(audio>200 && video>=100);return b;
}
async function pcm(file, filter) {
  const args=['-v','error','-i',file,'-map','0:a:0'];if(filter)args.push('-af',filter);
  args.push('-ac','1','-ar','48000','-f','s16le','pipe:1');
  return (await exec(ff,args,{encoding:'buffer',windowsHide:true,timeout:30000,maxBuffer:4*1024*1024})).stdout;
}
function rms(b,a,z){let sum=0,n=0;for(let i=Math.round(a*48000);i<Math.round(z*48000);i++){const x=b.readInt16LE(i*2);sum+=x*x;n++}return Math.sqrt(sum/n)}
function bestLag(reference, output, refTime, outTime) {
  let best={correlation:-2};
  for(let lag=-128;lag<=128;lag++){let xy=0,xx=0,yy=0;for(let i=0;i<4800;i++){const x=reference.readInt16LE((Math.round(refTime*48000)+i)*2),y=output.readInt16LE((Math.round(outTime*48000)+i+lag)*2);xy+=x*y;xx+=x*x;yy+=y*y;}const correlation=xy/Math.sqrt(xx*yy);if(correlation>best.correlation)best={lag,correlation};}
  return best;
}

test('opt-in fragmented synthetic AAC: bounded 4.708ms gap becomes silence without timeline drift', { skip:enabled?false:'set VIDEO_TEST_FFMPEG and VIDEO_TEST_FFPROBE',timeout:60000 }, async()=>{
  assert.ok(path.isAbsolute(ff)&&path.isAbsolute(fp));
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jiegetu-audio-gap-'));
  try {
    const baseFile=path.join(dir,'base.mp4');
    await runProcess(ff,['-v','error','-f','lavfi','-i','color=red:s=160x120:r=25:d=6','-f','lavfi','-i','aevalsrc=0.08*sin(2*PI*437*t)+0.08*sin(2*PI*613*t)+0.08*sin(2*PI*887*t):s=48000:d=6','-c:v','libx264','-bf','0','-c:a','aac','-movflags','frag_every_frame+empty_moov+default_base_moof','-n',baseFile],{timeoutMs:30000});
    const base=await fs.readFile(baseFile),input=withGaps(base,{96:226}),file=path.join(dir,'gap.mp4');
    await fs.writeFile(file,input,{flag:'wx'});
    const probe=JSON.parse((await runProcess(fp,['-v','error','-select_streams','a:0','-show_entries','packet=pts_time,duration_time','-of','json',file],{timeoutMs:30000})).stdout);
    const packets=probe.packets.map(p=>[Number(p.pts_time),Number(p.duration_time)]).sort((a,b)=>a[0]-b[0]);let end=-1,gaps=[];
    for(const [pts,duration] of packets){if(end>=0&&pts-end>0.002)gaps.push(pts-end);end=Math.max(end,pts+duration)}
    assert.equal(gaps.length,1);assert.ok(gaps[0]>0.00470&&gaps[0]<0.00472,`unexpected gap ${gaps[0]}`);
    const exporter=createVideoExporter({ffmpegPath:ff,ffprobePath:fp,scratchRoot:dir,timeoutMs:30000});
    const plan={durationMs:6042,ranges:[{startMs:500,endMs:3000},{startMs:3500,endMs:5500}],totalMs:4500};
    const original={bytes:input,extension:'mp4',mimeType:'video/mp4',hasAudio:true},before=Buffer.from(input);
    const output=await exporter({original,plan});assert.deepEqual(input,before);
    const target=path.join(dir,'export.mp4');await fs.writeFile(target,output.bytes,{flag:'wx'});
    const reference=await pcm(file,'aresample=async=1:first_pts=0:min_hard_comp=0.00001'),plain=await pcm(file),actual=await pcm(target);
    assert.ok(Math.abs(actual.length/96000-4.5)<0.03);
    const beforeGap=rms(actual,1.544,1.547),gap=rms(actual,1.5487,1.552),afterGap=rms(actual,1.553,1.556);
    assert.ok(beforeGap>500&&afterGap>500&&gap<Math.min(beforeGap,afterGap)*0.25,`silence rms: ${beforeGap}/${gap}/${afterGap}`);
    const checks=[[1.5,1],[2.5,2],[4,3]].map(([src,dst])=>bestLag(reference,actual,src,dst));
    for(const result of checks){assert.ok(result.correlation>0.90,JSON.stringify(result));assert.ok(Math.abs(result.lag)<=48,JSON.stringify(result));}
    // The plain decoder concatenates the original samples without silence, so
    // its post-gap source positions are exactly 226 samples earlier.
    const rawChecks=[[1.5,1],[2.5-226/48000,2],[4-226/48000,3]].map(([src,dst])=>bestLag(plain,actual,src,dst));
    for(const result of rawChecks){assert.ok(result.correlation>0.90,JSON.stringify(result));assert.ok(Math.abs(result.lag)<=48,JSON.stringify(result));}
    const outInfo=JSON.parse((await runProcess(fp,['-v','error','-show_entries','stream=codec_type,start_time,duration:format=duration','-of','json',target],{timeoutMs:30000})).stdout);
    assert.ok(Math.abs(Number(outInfo.format.duration)-4.5)<0.035);
    console.log(`audio gap=${(gaps[0]*1000).toFixed(3)}ms rms-before/gap/after=${beforeGap.toFixed(0)}/${gap.toFixed(0)}/${afterGap.toFixed(0)} lags=${checks.map(c=>c.lag).join(',')} raw-lags=${rawChecks.map(c=>c.lag).join(',')} samples output=${outInfo.format.duration}s`);
    for(const [label,gapMap] of [['long',{96:337}],['cumulative',{96:226,116:226,136:226,156:226,176:226,196:226,216:226}],['overlap',{96:226,116:-100}]]){
      const bad=withGaps(base,gapMap);await assert.rejects(exporter({original:{...original,bytes:bad},plan}),/音频时间间隙过大|音频时间间隙累计过大|音频帧时间间隙或重叠不支持|音频包时间重叠不支持/,label);
    }
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('opt-in fragmented AAC with 388 one-sample overlaps and two bounded gaps', { skip:enabled?false:'set VIDEO_TEST_FFMPEG and VIDEO_TEST_FFPROBE',timeout:90000 }, async()=>{
  assert.ok(path.isAbsolute(ff)&&path.isAbsolute(fp));
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jiegetu-audio-overlap-'));
  try {
    const baseFile=path.join(dir,'base.mp4');
    await runProcess(ff,['-v','error','-f','lavfi','-i','color=red:s=160x120:r=25:d=13','-f','lavfi','-i','aevalsrc=0.08*sin(2*PI*437*t)+0.08*sin(2*PI*613*t)+0.08*sin(2*PI*887*t):s=48000:d=13','-c:v','libx264','-bf','0','-c:a','aac','-movflags','frag_every_frame+empty_moov+default_base_moof','-n',baseFile],{timeoutMs:30000});
    const shifts={100:210,300:20};for(let i=1;i<=390;i++)if(i!==100&&i!==300)shifts[i]=-1;
    const input=withGaps(await fs.readFile(baseFile),shifts),file=path.join(dir,'overlap.mp4');await fs.writeFile(file,input,{flag:'wx'});
    const stream=JSON.parse((await runProcess(fp,['-v','error','-select_streams','a:0','-show_entries','frame=best_effort_timestamp,nb_samples','-of','json',file],{timeoutMs:30000})).stdout);
    let previousEnd=0,overlaps=0,positive=[];
    for(const frame of stream.frames){const pts=Number(frame.best_effort_timestamp),count=Number(frame.nb_samples),delta=pts-previousEnd;assert.equal(count,1024);if(delta===-1)overlaps++;else if(delta>0)positive.push(delta);else assert.equal(delta,0,`unexpected decoded frame skew ${delta}`);previousEnd=pts+count;}
    assert.equal(overlaps,388);assert.deepEqual(positive,[210,20]);
    const raw=await pcm(file),normalized=await pcm(file,'aresample=async=1:first_pts=0:min_hard_comp=0.00001');
    assert.equal(raw.length,stream.frames.length*1024*2);
    const pieces=[];for(let i=0;i<stream.frames.length;i++){const shift=shifts[i]||0;if(shift>0)pieces.push(Buffer.alloc(shift*2));const samples=Number(stream.frames[i].nb_samples);pieces.push(raw.subarray(i*1024*2+Math.max(0,-shift)*2,i*1024*2+samples*2));}
    const manual=Buffer.concat(pieces);const referenceChecks=[.5,1.5,3.5,5.5,8.5,11.5].map(t=>bestLag(manual,normalized,t,t));
    console.log(`overlap PCM manual=${manual.length/2} normalized=${normalized.length/2} reference=${JSON.stringify(referenceChecks)}`);
    assert.ok(Math.abs(normalized.length-manual.length)<=64,'resampler sample count differs by more than 32 samples');
    const correctedOverlaps=(raw.length-normalized.length)/2+230;
    assert.ok(correctedOverlaps>=356&&correctedOverlaps<=388,`insufficient overlap compensation: ${correctedOverlaps}`);
    for(const match of referenceChecks)assert.ok(match.correlation>0.98 && Math.abs(match.lag)<=32,JSON.stringify(match));
    const exporter=createVideoExporter({ffmpegPath:ff,ffprobePath:fp,scratchRoot:dir,timeoutMs:30000});
    const ranges=[{startMs:500,endMs:4000},{startMs:6500,endMs:12000}],plan={durationMs:13000,ranges,totalMs:9000};
    const output=await exporter({original:{bytes:input,extension:'mp4',mimeType:'video/mp4',hasAudio:true},plan});
    const target=path.join(dir,'edited.mp4');await fs.writeFile(target,output.bytes,{flag:'wx'});const result=await pcm(target);
    const exportChecks=[[1.5,1],[3.0,2.5],[7,4],[11,8]].map(([src,dst])=>bestLag(manual,result,src,dst));
    for(const match of exportChecks)assert.ok(match.correlation>0.90&&Math.abs(match.lag)<=48,JSON.stringify(match));
    const quiet=rms(result,1.632,1.6348),before=rms(result,1.627,1.630),after=rms(result,1.637,1.640);
    assert.ok(before>500&&after>500&&quiet<Math.min(before,after)*0.3,`silence rms ${before}/${quiet}/${after}`);
    assert.ok(Math.abs(result.length/96000-9)<0.035);
    console.log(`export lags=${exportChecks.map(c=>c.lag).join(',')} samples duration=${result.length/96000}s gap-rms=${Math.round(before)}/${Math.round(quiet)}/${Math.round(after)}`);
    const twoSamples=withGaps(await fs.readFile(baseFile),{100:210,120:-2});
    await assert.rejects(exporter({original:{bytes:twoSamples,extension:'mp4',mimeType:'video/mp4',hasAudio:true},plan}),/音频帧时间间隙或重叠不支持/);
    const tooMany={100:210};for(let i=1;i<=550;i++)if(i!==100)tooMany[i]=-1;
    await assert.rejects(exporter({original:{bytes:withGaps(await fs.readFile(baseFile),tooMany),extension:'mp4',mimeType:'video/mp4',hasAudio:true},plan}),/音频帧重叠频率过高/);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
