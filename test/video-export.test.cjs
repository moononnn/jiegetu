'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');
const {createVideoExporter,runProcess,TIMING_SUBCODES,timingDiagnostics}=require('../main/video-export.cjs');const {validateOutput}=require('../core/video-session.mjs');
const box=(tag,payload=[])=>Buffer.from([0,0,0,8+payload.length,...Buffer.from(tag),...payload]);const mp4=Buffer.concat([box('ftyp',[0,0,0,0,0,0,0,0]),box('moov',[1]),box('mdat',[1])]);const root=path.resolve(__dirname,'../.tmp');
const validFrames=Array.from({length:282},(_,i)=>`${i*1024+(i>=96?226:0)},1024`).join('\n');
async function fixture({audio=true, audioStart='0', videoStart='0', formatStart='0', formatDuration='6', videoDuration='6', audioDuration='6', packet='0.000000,6.000000', audioPacket=packet, audioFrames=validFrames, audioTimebase='1/48000', extra='\n00000000: 0164 0028 ffe1 0000  ........\n', outputAudio=true, softwareAudioTiming=false}={}){
 const scratch=await fs.mkdtemp(path.join(root,'export-unit-')),calls=[];
 const stream=(type,start='0',duration='6')=>({codec_type:type,start_time:start,duration,...(type==='audio'?{sample_rate:'48000',time_base:audioTimebase}:{})});
 const inputInfo={streams:[stream('video',videoStart,videoDuration),...(audio?[stream('audio',audioStart,audioDuration)]:[])],format:{start_time:formatStart,duration:formatDuration}};
 const outputInfo={streams:[{codec_type:'video',codec_name:'h264',codec_tag_string:'avc1',extradata:extra},...(outputAudio?[{codec_type:'audio',codec_name:'aac',codec_tag_string:'mp4a',profile:'LC'}]:[])]};
 let probes=0;const run=async(exe,args)=>{calls.push({exe,args});if(exe.endsWith('probe.exe')){if(args.includes('-select_streams'))return {stdout:args.includes('frame=best_effort_timestamp,nb_samples') ? audioFrames : args[args.indexOf('-select_streams')+1] === 'a:0' ? audioPacket : packet};return {stdout:JSON.stringify(probes++===0?inputInfo:outputInfo)}}await fs.writeFile(args.at(-1),mp4);return {stdout:''}};
 const exporter=createVideoExporter({ffmpegPath:path.join(scratch,'ffmpeg.exe'),ffprobePath:path.join(scratch,'probe.exe'),scratchRoot:scratch,run,softwareAudioTiming});
 const original={bytes:Uint8Array.from(mp4),extension:'mp4',mimeType:'video/mp4;codecs=avc1.42001f',hasAudio:audio};
 const plan={durationMs:6000,ranges:[{startMs:400,endMs:1601},{startMs:4400,endMs:5600}],totalMs:2401};
 return {scratch,calls,exporter,original,plan,done:()=>fs.rm(scratch,{recursive:true,force:true})};
}
test('软件模式：音频多出的尾巴只在“选整段”时收边界，任意剪辑不缩，超界照旧拒绝',async()=>{
  // 软件录制的实际形态：音频比视频多 135ms。
  const software={formatDuration:'6.135',videoDuration:'6',audioDuration:'6.135',audioPacket:'0.000000,6.135000'};
  // 默认路径照旧拒绝（门限一字未改）。
  {
    const h=await fixture(software);
    try{await assert.rejects(h.exporter({original:h.original,plan:{durationMs:6135,ranges:[{startMs:0,endMs:6135}],totalMs:6135}}),e=>e.code==='export-timing'&&e.subcode==='av-duration-mismatch');}
    finally{await h.done()}
  }
  // 软件模式 + 用户选整段：边界收到最后一段可用视频的末尾，音频那截尾巴不进成片。
  {
    const h=await fixture({...software,softwareAudioTiming:true});
    try{
      const out=await h.exporter({original:h.original,plan:{durationMs:6135,ranges:[{startMs:0,endMs:6135}],totalMs:6135}});
      assert.ok(out.bytes.length>0);
      const args=h.calls.find(c=>c.exe.endsWith('ffmpeg.exe')).args;
      const f=args[args.indexOf('-filter_complex')+1];
      assert.match(f,/trim=start=0\.000:end=6\.000/);
      assert.match(f,/atrim=start=0\.000:end=6\.000/);
      assert.doesNotMatch(f,/end=6\.135/);
    }finally{await h.done()}
  }
  // 软件模式 + 用户自己要的一段超出视频末尾：不缩，明确拒绝。
  {
    const h=await fixture({...software,softwareAudioTiming:true});
    try{await assert.rejects(h.exporter({original:h.original,plan:{durationMs:6135,ranges:[{startMs:0,endMs:6100}],totalMs:6100}}),e=>e.code==='export-timing'&&e.subcode==='track-span');}
    finally{await h.done()}
  }
  // 软件模式 + 尾巴超过 180ms：照旧拒绝。
  {
    const h=await fixture({formatDuration:'6.200',videoDuration:'6',audioDuration:'6.200',audioPacket:'0.000000,6.200000',softwareAudioTiming:true});
    try{await assert.rejects(h.exporter({original:h.original,plan:{durationMs:6200,ranges:[{startMs:0,endMs:6200}],totalMs:6200}}),e=>e.code==='export-timing'&&e.subcode==='av-duration-mismatch');}
    finally{await h.done()}
  }
  // 视频比音频长的既有软件容忍不受影响（仍按 180ms 门限；父用例已覆盖 150ms 可过）。
  {
    const h=await fixture({formatDuration:'6',videoDuration:'6',audioDuration:'5.850',audioPacket:'0.000000,5.850000',softwareAudioTiming:true});
    try{await h.exporter({original:h.original,plan:{durationMs:6000,ranges:[{startMs:0,endMs:6000}],totalMs:6000}});}
    finally{await h.done()}
  }
});
test('主机契约与实际 AVC 配置 MIME，双段配对共享时间轴',async()=>{const h=await fixture();try{const input=Uint8Array.from(h.original.bytes);const out=await h.exporter({original:h.original,plan:h.plan});assert.deepEqual(h.original.bytes,input);assert.equal(out.mimeType,'video/mp4;codecs=avc1.640028,mp4a.40.2');assert.equal(validateOutput(out).size,mp4.length);const args=h.calls.find(c=>c.exe.endsWith('ffmpeg.exe')).args;const f=args[args.indexOf('-filter_complex')+1];assert.match(f,/trim=start=0\.400:end=1\.601/);assert.match(f,/setpts=PTS-0\.400\/TB/);assert.match(f,/asetpts=PTS-4\.400\/TB/);assert.match(f,/concat=n=2:v=1:a=1/);assert.deepEqual(await fs.readdir(h.scratch),[])}finally{await h.done()}});
test('无音频单段导出不伪造音轨',async()=>{const h=await fixture({audio:false,outputAudio:false});try{const out=await h.exporter({original:h.original,plan:{durationMs:6000,ranges:[{startMs:0,endMs:3000}],totalMs:3000}});assert.equal(out.mimeType,'video/mp4;codecs=avc1.640028');assert.equal(out.hasAudio,false)}finally{await h.done()}});
test('拒绝音轨声明不符、延迟、短轨、间隙及缺失编码配置',async()=>{for(const opts of [{audioStart:'0.1'},{videoDuration:'2'},{packet:'0,2\n2.2,3.8'},{extra:''}]){const h=await fixture(opts);try{await assert.rejects(h.exporter({original:h.original,plan:h.plan}));assert.deepEqual(await fs.readdir(h.scratch),[])}finally{await h.done()}}const h=await fixture();try{h.original.hasAudio=false;await assert.rejects(h.exporter({original:h.original,plan:h.plan}),/不一致/)}finally{await h.done()}});
test('只允许不超过100毫秒的视频包间隙，音频大间隙仍拒绝',async()=>{for(const gap of ['0,2\n2.0283,3.9717','0,2\n2.1,3.9']){const h=await fixture({packet:gap,audioPacket:'0,6'});try{await h.exporter({original:h.original,plan:h.plan});const args=h.calls.find(c=>c.exe.endsWith('ffmpeg.exe')).args;assert.match(args[args.indexOf('-filter_complex')+1],/fps=fps=60:round=up/);assert.equal(args[args.indexOf('-fps_mode:v')+1],'vfr')}finally{await h.done()}}for(const opts of [{packet:'0,2\n2.1001,3.8999',audioPacket:'0,6'},{packet:'0,6',audioPacket:'0,2\n2.0283,3.9717'},{packet:'0,0.01\n0.01,5.99',audioPacket:'0,6'},{audioStart:'0.030'}]){const h=await fixture(opts);try{await assert.rejects(h.exporter({original:h.original,plan:h.plan}));assert.deepEqual(await fs.readdir(h.scratch),[])}finally{await h.done()}}});
test('小音频空隙只在帧时间可验证时以共同时间轴补静音',async()=>{for(const audioPacket of ['0,2\n2.004709,3.995291','0,2\n2.00005,3.99995']){const h=await fixture({packet:'0,6',audioPacket});try{await h.exporter({original:h.original,plan:h.plan});const args=h.calls.find(c=>c.exe.endsWith('ffmpeg.exe')).args;const f=args[args.indexOf('-filter_complex')+1];assert.match(f,/aresample=async=1:first_pts=0:min_hard_comp=0\.00001,atrim/);assert.match(f,/asetpts=PTS-0\.400\/TB/);assert.doesNotMatch(f,/STARTPTS/);assert.ok(h.calls.some(c=>c.args.includes('frame=best_effort_timestamp,nb_samples')))}finally{await h.done()}}});
test('超长、累计过大或解码帧不可信的音频空隙必须拒绝',async()=>{const gaps=Array.from({length:7},(_,i)=>`${i*0.8},0.794`).join('\n')+'\n5.6,0.4';for(const opts of [{audioPacket:'0,2\n2.0061,3.9939'},{audioPacket:gaps},{audioPacket:'0,2\n2.004709,3.995291',audioFrames:'0,1024\n1000,1024'},{audioPacket:'0,2\n2.004709,3.995291',audioFrames:''},{audioPacket:'0,2\n2.004709,3.995291',audioTimebase:''}]){const h=await fixture({packet:'0,6',...opts});try{await assert.rejects(h.exporter({original:h.original,plan:h.plan}));assert.deepEqual(await fs.readdir(h.scratch),[])}finally{await h.done()}}});
test('只接受预算内的单采样重叠，拒绝双采样及过密或累计过多',async()=>{function frames(length,overlaps){let offset=0;return Array.from({length},(_,i)=>{if(i===1)offset+=226;else if(i>1&&i<=overlaps+1)offset--;return `${i*1024+offset},1024`}).join('\n')}for(const opts of [{audioFrames:'0,1024\n1022,1024',error:/重叠不支持/},{audioFrames:frames(282,250),error:/重叠频率过高/},{audioFrames:frames(610,590),error:/重叠频率过高/}]){const {error,...config}=opts;const h=await fixture({packet:'0,6',audioPacket:'0,2\n2.004709,3.995291',...config});try{await assert.rejects(h.exporter({original:h.original,plan:h.plan}),error)}finally{await h.done()}}});
test('保留末尾时仅允许短音频尾差，并且只在最后一段补静音', async () => {
  const plan = { durationMs:6000, ranges:[{startMs:0,endMs:2000},{startMs:3000,endMs:6000}], totalMs:5000 };
  const audioFrames = Array.from({length:279}, (_,i) => `${i*1024},1024`).join('\n');
  const small = await fixture({audioDuration:'5.952',audioPacket:'0,5.952',audioFrames});
  try {
    await small.exporter({original:small.original,plan});
    const args=small.calls.find(c=>c.exe.endsWith('ffmpeg.exe')).args;
    const filter=args[args.indexOf('-filter_complex')+1];
    assert.equal((filter.match(/apad=/g)||[]).length,1);
    assert.match(filter,/apad=pad_dur=0\.080,atrim=start=3\.000:end=6\.000/);
  } finally { await small.done(); }
  for (const opts of [{audioDuration:'5.910',audioPacket:'0,5.910',audioFrames}, {audioDuration:'5.952',audioPacket:'0,5.8',audioFrames}, {videoDuration:'5.952'}]) {
    const h=await fixture(opts);
    try { await assert.rejects(h.exporter({original:h.original,plan}), {code: opts.audioPacket === '0,5.8' ? 'export-audio' : 'export-timing'}); }
    finally { await h.done(); }
  }
});
test('软件编码试用允许短音尾和一次轻微暂停接缝，仍拒绝缺画面或越界时间轴', async () => {
  const plan = { durationMs:6000, ranges:[{startMs:0,endMs:2000},{startMs:3000,endMs:6000}], totalMs:5000 };
  const frames = (early = -50, later = 0) => Array.from({length:275}, (_,i) => `${i*1024+(i>=64?early:0)+(i>=90?later:0)},1024`).join('\n');
  const options = {audioDuration:'5.850',audioPacket:'0,5.850',audioFrames:frames()};
  for (const opts of [{}, {softwareAudioTiming:true}, {softwareAudioTiming:true,audioDuration:'5.800'},
    {softwareAudioTiming:true,audioFrames:frames(-50,-50)},
    {softwareAudioTiming:true,audioFrames:frames(500)}]) {
    const h=await fixture({...options,...opts});
    try {
      const run=h.exporter({original:h.original,plan});
      if (Object.keys(opts).length!==1) { await assert.rejects(run); continue; }
      await run;
      const args=h.calls.find(c=>c.exe.endsWith('ffmpeg.exe')).args;
      const filter=args[args.indexOf('-filter_complex')+1];
      assert.match(filter,/aresample=.*apad=pad_dur=0\.180,atrim=start=3\.000/);
      assert.equal((filter.match(/apad=/g)||[]).length,1);
    } finally { await h.done(); }
  }
  // 音频比视频长（软件录制的实际形态）：用户选的是整段时，边界收到最后一段可用视频的末尾。
  {
    const h=await fixture({...options,softwareAudioTiming:true,videoDuration:'5.850',audioDuration:'6'});
    try {
      await h.exporter({original:h.original,plan});
      const args=h.calls.find(c=>c.exe.endsWith('ffmpeg.exe')).args;
      const filter=args[args.indexOf('-filter_complex')+1];
      assert.match(filter,/trim=start=3\.000:end=5\.850/);
      assert.match(filter,/atrim=start=3\.000:end=5\.850/);
      assert.doesNotMatch(filter,/end=6\.000/);
    } finally { await h.done(); }
  }
});
test('缺失容器或轨道起点元数据不能按零接受',async()=>{for(const opts of [{formatStart:null},{formatStart:''},{videoStart:''},{videoStart:null}]){const h=await fixture(opts);try{await assert.rejects(h.exporter({original:h.original,plan:h.plan}),/起始时间不支持|起止时间不支持/)}finally{await h.done()}}});
test('缺失包时间戳不能按零接受',async()=>{for(const packet of [',6.0','  ,6.0','0,','0,N/A']){const h=await fixture({packet});try{await assert.rejects(h.exporter({original:h.original,plan:h.plan}),/时间戳不可验证/);assert.deepEqual(await fs.readdir(h.scratch),[])}finally{await h.done()}}});
test('拒绝无效路径、计划、媒体及预取消',async()=>{assert.throws(()=>createVideoExporter({ffmpegPath:'ffmpeg',ffprobePath:'probe'}),/绝对路径/);const h=await fixture();try{await assert.rejects(h.exporter({original:h.original,plan:{...h.plan,totalMs:9}}),/计划/);await assert.rejects(h.exporter({original:{...h.original,hasAudio:undefined},plan:h.plan}),/音频/);await assert.rejects(h.exporter({original:h.original,plan:h.plan,signal:AbortSignal.abort()}),/取消/);assert.deepEqual(await fs.readdir(h.scratch),[])}finally{await h.done()}});
test('候选路径只能由工厂选项开启：非法选项拒绝，默认仍走原路径',()=>{
 const abs=p=>require('node:path').resolve(p);
 assert.throws(()=>createVideoExporter({ffmpegPath:abs('ffmpeg.exe'),ffprobePath:abs('probe.exe'),scratchRoot:abs('scratch'),timeline:'other'}),/导出配置无效/);
 // 默认仍是 packet；显式候选选项只能由工厂层给出（请求参数里带 timeline 不会被采纳）。
 assert.equal(typeof createVideoExporter({ffmpegPath:abs('ffmpeg.exe'),ffprobePath:abs('probe.exe'),scratchRoot:abs('scratch')}),'function');
 assert.equal(typeof createVideoExporter({ffmpegPath:abs('ffmpeg.exe'),ffprobePath:abs('probe.exe'),scratchRoot:abs('scratch'),timeline:'explicit-pts'}),'function');
});
test('进程取消、超时及输出上限',async()=>{const c=new AbortController();setTimeout(()=>c.abort(),50);await assert.rejects(runProcess(process.execPath,['-e','setTimeout(()=>{},10000)'],{signal:c.signal,timeoutMs:5000}),/取消/);await assert.rejects(runProcess(process.execPath,['-e','setTimeout(()=>{},10000)'],{timeoutMs:50}),/超时/);await assert.rejects(runProcess(process.execPath,['-e','process.stdout.write("x".repeat(1200000))'],{timeoutMs:5000}),/输出过大/)});

test('时间轴拒绝：总码不变，固定子码区分来源，指标仅为粗粒度数值',async()=>{
  const driftFrames=Array.from({length:282},(_,i)=>`${i*1024+200*Math.max(0,Math.min(i-9,8))},1024`).join('\n');
  const gaps=Array.from({length:7},(_,i)=>`${i*0.8},0.794`).join('\n')+'\n5.6,0.4';
  const overlapFrames=(length,overlaps)=>{let offset=0;return Array.from({length},(_,i)=>{if(i===1)offset+=226;else if(i>1&&i<=overlaps+1)offset--;return `${i*1024+offset},1024`}).join('\n')};
  const cases=[
    [{packet:',6.0'},'export-timing','packets-unverifiable'],
    [{packet:'0.5,5.5',audioPacket:'0,6'},'export-timing','track-start-missing'],
    [{packet:'0,6\n0.001,5.99',audioPacket:'0,6'},'export-timing','video-frame-interval-short'],
    [{packet:'0,2\n2.1001,3.8999',audioPacket:'0,6'},'export-timing','video-gap-large'],
    [{packet:'0,6',audioPacket:'0,2\n1.99,4.01'},'export-audio','audio-packet-overlap'],
    [{packet:'0,6',audioPacket:'0,2\n2.0283,3.9717'},'export-audio','audio-gap-large'],
    [{packet:'0,6',audioPacket:gaps},'export-audio','audio-gap-cumulative'],
    [{packet:'0,6',audioPacket:'0,2\n2.004709,3.995291',audioFrames:driftFrames},'export-audio','audio-frame-drift-cumulative'],
    [{packet:'0,6',audioPacket:'0,2\n2.004709,3.995291',audioFrames:overlapFrames(282,250)},'export-audio','audio-overlap-rate'],
    [{formatStart:'0.01'},'export-timing','container-start'],
    [{videoDuration:'6',audioDuration:'5'},'export-timing','av-duration-mismatch'],
  ];
  const seen=new Set();
  for(const [opts,code,subcode] of cases){
    const h=await fixture(opts);
    try{
      await assert.rejects(h.exporter({original:h.original,plan:h.plan}),error=>{
        assert.equal(error.code,code,`总码保留 ${subcode}`);
        assert.equal(error.subcode,subcode);
        assert.ok(TIMING_SUBCODES.includes(subcode),'子码在白名单内');
        assert.ok(error.metrics&&typeof error.metrics==='object');
        for(const v of Object.values(error.metrics))assert.equal(typeof v,'number','指标只能是数值');
        assert.ok(!/[\\/]/.test(JSON.stringify(error.metrics)),'指标不能带路径');
        return true;
      });
      seen.add(subcode);
      assert.deepEqual(await fs.readdir(h.scratch),[]);
    }finally{await h.done()}
  }
  assert.equal(seen.size,cases.length,'不同来源的子码互不相同');
});

test('漂移累计拒绝携带可比较的粗粒度指标（重叠计数/采样率/累计毫秒）',async()=>{
  const driftFrames=Array.from({length:282},(_,i)=>`${i*1024+200*Math.max(0,Math.min(i-9,8))},1024`).join('\n');
  const h=await fixture({packet:'0,6',audioPacket:'0,2\n2.004709,3.995291',audioFrames:driftFrames});
  try{
    await assert.rejects(h.exporter({original:h.original,plan:h.plan}),error=>{
      assert.equal(error.subcode,'audio-frame-drift-cumulative');
      assert.equal(error.metrics.rate,48000);
      assert.ok(Number.isInteger(error.metrics.totalGapMs)&&error.metrics.totalGapMs>30);
      assert.ok(Number.isInteger(error.metrics.overlapCount));
      return true;
    });
  }finally{await h.done()}
});

test('timingDiagnostics 只放行白名单子码与数值指标，丢弃原始报错与私有 metadata',()=>{
  assert.deepEqual(timingDiagnostics(null),{});
  assert.deepEqual(timingDiagnostics({subcode:'evil',metrics:{gapMs:5}}),{});
  assert.deepEqual(timingDiagnostics({subcode:'video-gap-large'}),{subcode:'video-gap-large',metrics:{}});
  const dirty={subcode:'audio-frame-drift-cumulative',metrics:{overlapCount:497,rate:48000,roundingOverlapMs:10.354,path:'C:\\secret\\a.mp4',stderr:'raw error',note:'内部',nan:NaN,inf:Infinity}};
  const clean=timingDiagnostics(dirty);
  assert.equal(clean.subcode,'audio-frame-drift-cumulative');
  assert.deepEqual(clean.metrics,{overlapCount:497,rate:48000,roundingOverlapMs:10});
  assert.ok(!JSON.stringify(clean).includes('secret'));
  assert.ok(!JSON.stringify(clean).includes('raw error'));
});
