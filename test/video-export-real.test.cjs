'use strict';
// Opt-in local R&D only. Supply absolute paths to independently obtained tools and
// the synthetic-playback-probe directory. Never uses system-installed discovery.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { createVideoExporter, runProcess } = require('../main/video-export.cjs');
const ffmpegPath = process.env.VIDEO_TEST_FFMPEG;
const ffprobePath = process.env.VIDEO_TEST_FFPROBE;
const sampleDir = process.env.VIDEO_TEST_SYNTHETIC_DIR;
const optIn = Boolean(ffmpegPath && ffprobePath && sampleDir);
async function colorAt(file, seconds) {
  const { stdout } = await exec(ffmpegPath, ['-v','error','-i',file,'-vf',`fps=100:round=up,select=gte(t\\,${seconds}),scale=1:1`,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'], { encoding:'buffer', windowsHide:true, timeout:30000 });
  assert.equal(stdout.length, 3, `missing frame at ${seconds}`);
  const [r,g,b] = stdout;
  return r > g + 60 && r > b + 60 ? 'red' : b > r + 60 && b > g + 60 ? 'blue' : g > r + 60 && g > b + 60 ? 'green' : 'other';
}
async function mediaInfo(file) {
  return JSON.parse((await runProcess(ffprobePath, ['-v','error','-show_entries','stream=codec_type,duration,start_time:format=duration,start_time','-of','json',file], { timeoutMs:30000 })).stdout);
}

test('opt-in real Electron MP4 export, bounded video gap and short-track refusal', { skip: optIn ? false : 'set VIDEO_TEST_FFMPEG, VIDEO_TEST_FFPROBE and VIDEO_TEST_SYNTHETIC_DIR' }, async () => {
  for (const p of [ffmpegPath, ffprobePath, sampleDir]) assert.ok(path.isAbsolute(p), 'fixture paths must be absolute');
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'jiegetu-video-real-test-'));
  try {
    const exporter = createVideoExporter({ ffmpegPath, ffprobePath, scratchRoot: scratch, timeoutMs: 30000 });
    async function run(file, hasAudio, durationMs, ranges) {
      const bytes = await fs.readFile(path.join(sampleDir, file));
      const before = Buffer.from(bytes);
      const original = { bytes, extension: 'mp4', mimeType: 'video/mp4', hasAudio };
      const plan = { durationMs, ranges, totalMs: ranges.reduce((n, r) => n + r.endMs - r.startMs, 0) };
      try { return await exporter({ original, plan }); }
      finally { assert.deepEqual(bytes, before); }
    }
    // Reject the gross 0.715 s video / 2.345 s audio mismatch even for a short selection.
    for (const endMs of [600, 2000]) await assert.rejects(run('integrated-0.mp4', true, 2345, [{ startMs: 100, endMs }]), /音视频轨道时长差异过大/);
    // This real variable-rate fixture has a measured 28.3 ms packet gap.
    const variable = await run('integrated-1.mp4', false, 2392, [{ startMs: 100, endMs: 1500 }, { startMs: 1700, endMs: 2100 }]);
    const variableFile = path.join(scratch, 'variable.mp4');
    await fs.writeFile(variableFile, variable.bytes, { flag:'wx' });
    const sourceFile = path.join(sampleDir, 'integrated-1.mp4');
    for (const [outTime, sourceTime] of [[1.10,1.20],[1.13,1.23],[1.15,1.25],[1.17,1.27],[1.19,1.29],[1.25,1.35],[1.45,1.75],[1.55,1.85]]) {
      assert.deepEqual(await colorAt(variableFile, outTime), await colorAt(sourceFile, sourceTime), `presentation differs at ${outTime}s`);
    }
    const variableMeta = await mediaInfo(variableFile);
    assert.ok(Math.abs(Number(variableMeta.format.duration) - 1.8) < 0.035);
    const output = await run('h264-aac-160x120.mp4', true, 3091, [{ startMs: 250, endMs: 1250 }, { startMs: 1800, endMs: 2500 }]);
    const target = path.join(scratch, 'result.mp4');
    await fs.writeFile(target, output.bytes, { flag: 'wx' });
    // Exercise the actual decoders, not only the container probe.
    await runProcess(ffmpegPath, ['-v','error','-xerror','-i',target,'-map','0:v:0','-map','0:a:0','-f','null','-'], { timeoutMs: 30000 });
    const metadata = JSON.parse((await runProcess(ffprobePath, ['-v','error','-show_entries','stream=codec_type,codec_name:format=duration','-of','json',target], { timeoutMs: 30000 })).stdout);
    assert.deepEqual(metadata.streams.map(s => [s.codec_type, s.codec_name]), [['video','h264'], ['audio','aac']]);
    assert.ok(Number(metadata.format.duration) > 1.4 && Number(metadata.format.duration) < 2.1);
    assert.deepEqual((await fs.readdir(scratch)).sort(), ['result.mp4','variable.mp4']);
  } finally { await fs.rm(scratch, { recursive:true, force:true }); }
});

test('opt-in synthetic 60ms frame hold, audio timeline, join and delayed audio refusal', { skip: optIn ? false : 'set VIDEO_TEST_FFMPEG, VIDEO_TEST_FFPROBE and VIDEO_TEST_SYNTHETIC_DIR', timeout:60000 }, async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'jiegetu-video-gap-test-'));
  const source = path.join(scratch, 'source.mp4'), edited = path.join(scratch, 'edited.mp4'), delayed = path.join(scratch, 'delayed.mp4');
  const ff = args => runProcess(ffmpegPath, args, { timeoutMs:30000 });
  try {
    const args = ['-v','error'];
    for (const color of ['red','green','blue']) args.push('-f','lavfi','-i',`color=${color}:s=160x120:r=25:d=2`);
    for (const hz of [440,660,880]) args.push('-f','lavfi','-i',`sine=frequency=${hz}:sample_rate=48000:duration=2`);
    args.push('-filter_complex','[0:v][1:v][2:v]concat=n=3:v=1:a=0[v0];[v0]setpts=PTS+if(gte(T\\,2)\\,0.06/TB\\,0)[v];[3:a][4:a][5:a]concat=n=3:v=0:a=1[a]',
      '-map','[v]','-map','[a]','-c:v','libx264','-bf','0','-pix_fmt','yuv420p','-fps_mode:v','passthrough','-enc_time_base:v','1:30000','-c:a','aac','-n',source);
    await ff(args);
    const packetText = (await runProcess(ffprobePath, ['-v','error','-select_streams','v:0','-show_entries','packet=pts_time','-of','csv=p=0',source], { timeoutMs:30000 })).stdout;
    const times = packetText.trim().split(/\r?\n/).map(Number);
    assert.ok(times.some((time, i) => i > 0 && time - times[i-1] >= 0.099 && time - times[i-1] <= 0.101), 'synthetic source lacks 60ms display hold');
    const exporter = createVideoExporter({ ffmpegPath, ffprobePath, scratchRoot:scratch, timeoutMs:30000 });
    const ranges = [{ startMs:400, endMs:3401 }, { startMs:4200, endMs:5400 }];
    const originalBytes = await fs.readFile(source), before = Buffer.from(originalBytes);
    const output = await exporter({ original:{ bytes:originalBytes, extension:'mp4', mimeType:'video/mp4', hasAudio:true }, plan:{ durationMs:6060, ranges, totalMs:4201 } });
    assert.deepEqual(originalBytes, before); await fs.writeFile(edited, output.bytes, { flag:'wx' });
    const points = [[1.58,1.98,'red'],[1.62,2.02,'red'],[1.65,2.05,'red'],[1.72,2.12,'green'],[2.85,3.25,'green'],[3.15,4.35,'blue']];
    for (const [outTime, sourceTime, expected] of points) {
      assert.equal(await colorAt(source, sourceTime), expected, `synthetic source at ${sourceTime}`);
      assert.equal(await colorAt(edited, outTime), expected, `edited output at ${outTime}`);
    }
    async function toneAt(file, time) {
      const { stdout } = await exec(ffmpegPath, ['-v','error','-ss',String(time),'-i',file,'-t','0.1','-f','s16le','-ac','1','-ar','48000','pipe:1'], { encoding:'buffer', windowsHide:true, timeout:30000 });
      assert.ok(stdout.length >= 9000); let crossings = 0, previous = 0;
      for (let i=0; i+1<stdout.length; i+=2) { const value=stdout.readInt16LE(i); if(i && previous<=0 && value>0) crossings++; previous=value; }
      return crossings / 0.1;
    }
    for (const [outTime, sourceTime, expected] of [[1.75,2.15,660],[2.8,3.2,660],[3.15,4.35,880]]) {
      assert.ok(Math.abs(await toneAt(source, sourceTime)-expected) < 35);
      assert.ok(Math.abs(await toneAt(edited, outTime)-expected) < 35);
    }
    const { stdout:pcm } = await exec(ffmpegPath, ['-v','error','-i',edited,'-map','0:a:0','-f','s16le','-ac','1','-ar','48000','pipe:1'], { encoding:'buffer', windowsHide:true, timeout:30000, maxBuffer:2*1024*1024 });
    let audioJoin;
    for (let start = Math.floor(2.95*48000); start < Math.floor(3.05*48000); start += 48) {
      let crossings = 0, previous = 0;
      for (let j=start; j<start+960; j++) { const value=pcm.readInt16LE(j*2); if(j>start && previous<=0 && value>0) crossings++; previous=value; }
      if (crossings >= 16) { audioJoin=start/48000; break; }
    }
    assert.ok(Number.isFinite(audioJoin) && Math.abs(audioJoin - 3.001) <= 0.020, `audio join ${audioJoin}`);
    let videoJoin;
    for (let ms=2960; ms<=3050; ms+=10) if (await colorAt(edited, ms/1000) === 'blue') { videoJoin=ms/1000; break; }
    assert.ok(Number.isFinite(videoJoin) && Math.abs(videoJoin - 3.001) <= 0.035, `video join ${videoJoin}`);
    const meta = await mediaInfo(edited);
    assert.ok(Math.abs(Number(meta.format.duration) - 4.201) < 0.035);
    for (const stream of meta.streams) assert.ok(Math.abs(Number(stream.duration)-4.201) < 0.035, `${stream.codec_type} duration`);
    console.log(`synthetic join video=${videoJoin}s audio-window=${audioJoin}s expected=3.001s duration=${meta.format.duration}s`);
    await ff(['-v','error','-i',source,'-itsoffset','0.3','-i',source,'-map','0:v:0','-map','1:a:0','-c','copy','-n',delayed]);
    const delayedBytes = await fs.readFile(delayed);
    await assert.rejects(exporter({ original:{ bytes:delayedBytes, extension:'mp4', mimeType:'video/mp4', hasAudio:true }, plan:{ durationMs:6300, ranges:[{ startMs:400,endMs:2000 }], totalMs:1600 } }), /轨道起止时间不支持|容器起始时间不支持/);
  } finally { await fs.rm(scratch, { recursive:true, force:true }); }
});

test('opt-in real multi-cut: four tones survive three cuts on one source timeline', { skip: optIn ? false : 'set VIDEO_TEST_FFMPEG, VIDEO_TEST_FFPROBE and VIDEO_TEST_SYNTHETIC_DIR', timeout: 90000 }, async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'jiegetu-video-multicut-'));
  const ff = args => runProcess(ffmpegPath, args, { timeoutMs: 30000 });
  try {
    const source = path.join(scratch, 'tones.mp4');
    const hz = [440, 660, 880, 1200];
    const args = ['-v', 'error'];
    for (const f of hz) args.push('-f', 'lavfi', '-i', `sine=frequency=${f}:sample_rate=48000:duration=1.5`);
    args.push('-f', 'lavfi', '-i', 'color=c=#202020:s=160x120:r=15:d=6');
    args.push('-filter_complex', '[0:a][1:a][2:a][3:a]concat=n=4:v=0:a=1[a]', '-map', '4:v:0', '-map', '[a]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-n', source);
    await ff(args);
    const bytes = await fs.readFile(source);
    const before = Buffer.from(bytes);
    const exporter = createVideoExporter({ ffmpegPath, ffprobePath, scratchRoot: scratch, timeoutMs: 30000 });
    // 四段 1.5s：删 [0.4,0.7) 与 [2.2,2.6) 与 [4.6,5.0) → 保留四段
    const cuts = [{ startMs: 400, endMs: 700 }, { startMs: 2200, endMs: 2600 }, { startMs: 4600, endMs: 5000 }];
    const plan = { durationMs: 6000, cuts, startMs: 0, endMs: 6000 };
    const { normalizeVideoEdit } = await import('../core/video-edit.mjs');
    const normalized = normalizeVideoEdit({ durationMs: plan.durationMs, startMs: plan.startMs, endMs: plan.endMs, cuts });
    assert.equal(normalized.spans.length, 4);
    const output = await exporter({ original: { bytes, extension: 'mp4', mimeType: 'video/mp4', hasAudio: true },
      plan: { durationMs: normalized.durationMs, ranges: normalized.spans, totalMs: normalized.totalMs } });
    assert.deepEqual(bytes, before, '原片不变');
    const target = path.join(scratch, 'multi.mp4');
    await fs.writeFile(target, output.bytes, { flag: 'wx' });
    const info = await mediaInfo(target);
    const expected = normalized.totalMs / 1000;
    assert.ok(Math.abs(Number(info.format.duration) - expected) < 0.08, `时长 ${info.format.duration} vs ${expected}`);
    // 每个保留段里各取一个点，验听感频率没串段
    const toneAt = async (time) => {
      const { stdout } = await exec(ffmpegPath, ['-v', 'error', '-ss', String(time), '-i', target, '-t', '0.1', '-f', 's16le', '-ac', '1', '-ar', '48000', 'pipe:1'], { encoding: 'buffer', windowsHide: true, timeout: 30000 });
      let crossings = 0, previous = 0;
      for (let i = 0; i + 1 < stdout.length; i += 2) { const value = stdout.readInt16LE(i); if (i && previous <= 0 && value > 0) crossings++; previous = value; }
      return crossings / 0.1;
    };
    const points = [[0.2, 440], [1.3, 660], [2.5, 880], [4.4, 1200]];
    for (const [time, expectedHz] of points) assert.ok(Math.abs((await toneAt(time)) - expectedHz) < 40, `t=${time} 期望 ${expectedHz}Hz，实际 ${await toneAt(time)}Hz`);
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
});

//  recurring-bug regression：真 VFR（>100ms 显示空洞 + <1/60 近帧）被当前路径拒绝。
// 合成源、受信工具、opt-in；总码保留 export-timing，子码区分来源。原型对比在 .tmp/vfr-timeline-research（研究-only）。
test('opt-in genuine VFR refusal: >100ms display gap and sub-1/60 close frames', { skip: optIn ? false : 'set VIDEO_TEST_FFMPEG, VIDEO_TEST_FFPROBE and VIDEO_TEST_SYNTHETIC_DIR', timeout: 90000 }, async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'jiegetu-video-vfr-'));
  const ff = args => runProcess(ffmpegPath, args, { timeoutMs: 30000 });
  try {
    const colors = ['red', 'green', 'blue', 'yellow', 'magenta', 'cyan', 'white', 'orange'];
    for (const c of colors) await ff(['-v', 'error', '-f', 'lavfi', '-i', `color=c=${c}:s=160x120`, '-frames:v', '1', path.join(scratch, `${c}.png`), '-y']);
    const tail = (start, steps) => { const out = []; let t = start, i = 0; while (t < 1.600) { out.push([i % 8, Number(t.toFixed(3))]); t += steps[i % steps.length]; i++; } return out; };
    async function makeVfr(name, sched) {
      const seq = path.join(scratch, `seq-${name}`); await fs.mkdir(seq);
      for (let k = 0; k < sched.length; k++) await fs.copyFile(path.join(scratch, `${colors[sched[k][0]]}.png`), path.join(seq, `f${String(k).padStart(3, '0')}.png`));
      let expr = '0'; for (let k = sched.length - 1; k >= 0; k--) expr = `if(eq(N\\,${k})\\,${sched[k][1]}\\,${expr})`;
      const dur = (sched[sched.length - 1][1] + 0.04).toFixed(3);
      const out = path.join(scratch, `${name}.mp4`);
      await ff(['-v', 'error', '-framerate', '1000', '-start_number', '0', '-i', path.join(seq, 'f%03d.png'), '-f', 'lavfi', '-i', `sine=frequency=440:duration=${dur}`,
        '-vf', `setpts='${expr}/TB'`, '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-enc_time_base', '1/90000', '-video_track_timescale', '90000', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', '-y', out]);
      return out;
    }
    const featSched = [[0, 0], [1, 0.04], [2, 0.075], [3, 0.11], [4, 0.35], [5, 0.358], [6, 0.366], [7, 0.42], ...tail(0.46, [0.04, 0.033, 0.045, 0.038, 0.05, 0.03])];
    const closeSched = [[0, 0], [1, 0.04], [2, 0.08], [3, 0.12], [4, 0.128], [5, 0.136], [6, 0.18], [7, 0.22], ...tail(0.26, [0.04, 0.033, 0.045, 0.038])];
    const featFile = await makeVfr('vfr-features', featSched);
    const closeFile = await makeVfr('vfr-close', closeSched);
    const pkt = async f => (await runProcess(ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', f], { timeoutMs: 30000 })).stdout.trim().split(/\r?\n/).map(l => l.split(',').map(Number)).sort((a, b) => a[0] - b[0]);
    const fp = await pkt(featFile);
    assert.ok(fp.some(([p, d], i) => i > 0 && p - (fp[i - 1][0] + fp[i - 1][1]) > 0.100001), 'synthetic source must contain a >100ms display gap');
    assert.ok(fp.some(([p], i) => i > 0 && p - fp[i - 1][0] < 1 / 60 - 1e-6), 'synthetic source must contain sub-1/60 close frames');
    const exporter = createVideoExporter({ ffmpegPath, ffprobePath, scratchRoot: scratch, timeoutMs: 30000 });
    const plan = { durationMs: 1500, ranges: [{ startMs: 0, endMs: 600 }, { startMs: 1000, endMs: 1500 }], totalMs: 1100 };
    const run = async f => exporter({ original: { bytes: Uint8Array.from(await fs.readFile(f)), extension: 'mp4', mimeType: 'video/mp4', hasAudio: true }, plan });
    await assert.rejects(run(featFile), e => e.code === 'export-timing' && e.subcode === 'video-gap-large');
    await assert.rejects(run(closeFile), e => e.code === 'export-timing' && e.subcode === 'video-frame-interval-short');
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
});

//  候选路径（工厂选项 timeline:'explicit-pts'，默认关闭）：真 VFR 两刀导出必须精确映射到接缝，
//  损坏与真短轨仍拒绝，默认路径行为不变。合成源、受信工具、opt-in。
test('opt-in explicit-PTS candidate: VFR two-cut maps exactly; corrupt and short tracks still rejected', { skip: optIn ? false : 'set VIDEO_TEST_FFMPEG, VIDEO_TEST_FFPROBE and VIDEO_TEST_SYNTHETIC_DIR', timeout: 120000 }, async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'jiegetu-video-explicit-pts-'));
  const ff = args => runProcess(ffmpegPath, args, { timeoutMs: 60000 });
  try {
    const colors = ['red', 'green', 'blue'];
    for (const c of colors) await ff(['-v', 'error', '-f', 'lavfi', '-i', `color=c=${c}:s=160x120`, '-frames:v', '1', path.join(scratch, `${c}.png`), '-y']);
    const tail = (start, steps) => { const out = []; let t = start, i = 0; while (t < 1.600) { out.push([i % 3, Number(t.toFixed(3))]); t += steps[i % steps.length]; i++; } return out; };
    // 0.110→0.350 是 >100ms 显示空洞；0.350→0.358→0.366 是 <1/60 近帧；两刀都落在长持有帧内。
    const sched = [[0, 0], [1, 0.04], [2, 0.075], [0, 0.11], [1, 0.35], [2, 0.358], [0, 0.366], [1, 0.42], ...tail(0.46, [0.04, 0.033, 0.045, 0.038, 0.05, 0.03])];
    const seq = path.join(scratch, 'seq'); await fs.mkdir(seq);
    for (let k = 0; k < sched.length; k++) await fs.copyFile(path.join(scratch, `${colors[sched[k][0]]}.png`), path.join(seq, `f${String(k).padStart(3, '0')}.png`));
    let expr = '0'; for (let k = sched.length - 1; k >= 0; k--) expr = `if(eq(N\\,${k})\\,${sched[k][1]}\\,${expr})`;
    const source = path.join(scratch, 'vfr.mp4');
    await ff(['-v', 'error', '-framerate', '1000', '-start_number', '0', '-i', path.join(seq, 'f%03d.png'), '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1.64',
      '-vf', `setpts='${expr}/TB'`, '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-enc_time_base', '1/90000', '-video_track_timescale', '90000', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', '-y', source]);
    const bytes = await fs.readFile(source), before = Buffer.from(bytes);
    const srcInfo = await mediaInfo(source);
    const D = Math.floor(Number(srcInfo.streams.find(s => s.codec_type === 'video').duration) * 1000);   // 末段到视频轨的实际全长
    const plan = { durationMs: D, ranges: [{ startMs: 0, endMs: 150 }, { startMs: 250, endMs: 800 }, { startMs: 900, endMs: D }], totalMs: 150 + 550 + (D - 900) };
    const original = { bytes: Uint8Array.from(bytes), extension: 'mp4', mimeType: 'video/mp4', hasAudio: true };
    const defaultExporter = createVideoExporter({ ffmpegPath, ffprobePath, scratchRoot: scratch, timeoutMs: 60000 });
    const candidateExporter = createVideoExporter({ ffmpegPath, ffprobePath, scratchRoot: scratch, timeoutMs: 60000, timeline: 'explicit-pts' });
    // 默认路径不变：同一真 VFR 源仍按原样拒绝（总码保留，子码区分来源）。
    await assert.rejects(defaultExporter({ original, plan }), e => e.code === 'export-timing' && e.subcode === 'video-gap-large');
    // 候选路径：导出成功且原片不变。
    const output = await candidateExporter({ original: { bytes: Uint8Array.from(bytes), extension: 'mp4', mimeType: 'video/mp4', hasAudio: true }, plan });
    assert.deepEqual(bytes, before, '原片不变');
    const target = path.join(scratch, 'edited.mp4');
    await fs.writeFile(target, output.bytes, { flag: 'wx' });
    await runProcess(ffmpegPath, ['-v', 'error', '-xerror', '-i', target, '-f', 'null', '-'], { timeoutMs: 60000 });
    // 接缝两侧的内容必须与源按同一时间映射完全一致（取帧内安全点，不落在帧边界上）。
    let acc = 0; const spans = plan.ranges.map(s => { const o = acc; acc += s.endMs - s.startMs; return { ...s, O: o }; });
    const toOut = ms => { const sp = spans.find(s => ms >= s.startMs && ms < s.endMs); return sp ? sp.O + (ms - sp.startMs) : null; };
    const srcFrames = (await runProcess(ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', source], { timeoutMs: 30000 })).stdout.trim().split(/\r?\n/).filter(Boolean).map(l => Number(l.split(',')[0])).sort((a, b) => a - b);
    const probes = [];
    for (const cut of [{ startMs: 150, endMs: 250 }, { startMs: 800, endMs: 900 }]) {
      for (const srcMs of [cut.startMs - 20, cut.endMs + 20]) { const outMs = toOut(srcMs); if (outMs != null) probes.push({ srcMs, outMs, tag: `cut${cut.startMs}` }); }
    }
    for (let i = 0; i + 1 < srcFrames.length; i += 2) {
      const gapMs = (srcFrames[i + 1] - srcFrames[i]) * 1000;
      if (gapMs < 15) continue;                                  // 近帧不作采样点（分辨率不够）
      const srcMs = Math.round(srcFrames[i] * 1000) + 2;
      const outMs = toOut(srcMs); if (outMs == null) continue;
      probes.push({ srcMs, outMs, tag: 'frame' });
    }
    assert.ok(probes.length >= 6, '采样点不足');
    for (const p of probes) assert.equal(await colorAt(target, p.outMs / 1000), await colorAt(source, p.srcMs / 1000), `mapped content at ${p.srcMs}ms (${p.tag})`);
    // 每段起点显示的第一张画面必须等于源在该起点显示的画面。
    for (const sp of spans) assert.equal(await colorAt(target, (sp.O + 5) / 1000), await colorAt(source, (sp.startMs + 5) / 1000), `first image of span at ${sp.startMs}ms`);
    const meta = await mediaInfo(target);
    assert.ok(Math.abs(Number(meta.format.duration) - plan.totalMs / 1000) < 0.12, `duration ${meta.format.duration} vs ${plan.totalMs / 1000}`);
    // 损坏与真短轨仍拒绝，且与默认路径同码（诊断码对齐）。
    const corrupt = Buffer.from(bytes); for (let i = 32; i < 256; i++) corrupt[i] ^= 0xff;
    const corruptOriginal = { bytes: Uint8Array.from(corrupt), extension: 'mp4', mimeType: 'video/mp4', hasAudio: true };
    let defaultCorrupt = null, candidateCorrupt = null;
    await assert.rejects(defaultExporter({ original: corruptOriginal, plan }), e => { defaultCorrupt = e.code; return true; });
    await assert.rejects(candidateExporter({ original: corruptOriginal, plan }), e => { candidateCorrupt = e.code; return true; });
    assert.equal(candidateCorrupt, defaultCorrupt, '损坏输入须与默认路径同码拒绝');
    const shortFile = path.join(scratch, 'short.mp4');
    await ff(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=30:duration=0.8', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', shortFile]);
    const shortOriginal = { bytes: Uint8Array.from(await fs.readFile(shortFile)), extension: 'mp4', mimeType: 'video/mp4', hasAudio: true };
    let defaultShort = null, candidateShort = null;
    await assert.rejects(defaultExporter({ original: shortOriginal, plan }), e => { defaultShort = e.code; return true; });
    await assert.rejects(candidateExporter({ original: shortOriginal, plan }), e => { candidateShort = e.code; return true; });
    assert.equal(candidateShort, defaultShort, '真短轨须与默认路径同码拒绝');
    assert.ok(defaultCorrupt && defaultShort, '对照必须被拒绝');
    // 预取消必须仍然走 AbortSignal 语义（不转成别的取消方式）。
    await assert.rejects(candidateExporter({ original: { bytes: Uint8Array.from(bytes), extension: 'mp4', mimeType: 'video/mp4', hasAudio: true }, plan, signal: AbortSignal.abort() }), e => e.code === 'export-aborted');
    // 早期就是 VFR、后续损坏/截断：候选不得凭早期形态就放行，必须与默认路径同码拒绝。
    const earlyVfrShort = Buffer.from(bytes).subarray(0, Math.floor(bytes.length * 0.7));
    const earlyVfrBroken = Buffer.from(bytes);
    for (let i = Math.floor(earlyVfrBroken.length * 0.8); i < Math.floor(earlyVfrBroken.length * 0.9); i++) earlyVfrBroken[i] ^= 0xff;
    for (const [label, payload] of [['truncated tail', earlyVfrShort], ['broken tail', earlyVfrBroken]]) {
      const damaged = { bytes: Uint8Array.from(payload), extension: 'mp4', mimeType: 'video/mp4', hasAudio: true };
      let defaultError, candidateError;
      await assert.rejects(defaultExporter({ original: damaged, plan }), error => { defaultError = error; return true; });
      await assert.rejects(candidateExporter({ original: damaged, plan }), error => { candidateError = error; return true; });
      assert.ok(defaultError.code, `早期 VFR 后 ${label}：默认路径必须拒绝`);
      assert.equal(candidateError.code, defaultError.code, `早期 VFR 后 ${label}：候选须与默认路径同码拒绝`);
      assert.equal(candidateError.subcode, defaultError.subcode);
      // A truncated MP4 may be rejected by container/track validation before
      // candidate selection. Only a shape refusal reaches the candidate gate.
      if (['video-gap-large', 'video-frame-interval-short'].includes(defaultError.subcode)) {
        assert.equal(candidateError.metrics?.candidateDisabled, 1, `${label}：经过候选门的文件必须被判为不可用`);
      }
    }
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
});
