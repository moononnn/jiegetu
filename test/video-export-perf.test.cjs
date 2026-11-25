'use strict';
// Opt-in local R&D save-perf measurement: synthetic media only, no desktop, no install.
// Same env gates as video-export-real.test.cjs. Timings are logged, never asserted
// (machine-dependent); correctness assertions stay strict. Hash pins are re-verified
// here and the trial hooks replicate module semantics exactly — nothing is weakened.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createReadStream, constants } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { performance } = require('node:perf_hooks');
const exec = promisify(execFile);
const { createVideoExporter, runProcess } = require('../main/video-export.cjs');
const { createTrialLoader, CONFIG, SCRATCH, PINS } = require('../main/video-export-trial.cjs');
const ffmpegPath = process.env.VIDEO_TEST_FFMPEG;
const ffprobePath = process.env.VIDEO_TEST_FFPROBE;
const sampleDir = process.env.VIDEO_TEST_SYNTHETIC_DIR;
const optIn = Boolean(ffmpegPath && ffprobePath && sampleDir);
const skip = optIn ? false : 'set VIDEO_TEST_FFMPEG, VIDEO_TEST_FFPROBE and VIDEO_TEST_SYNTHETIC_DIR';
const MAX_BINARY = 512 * 1024 * 1024;
// 21 s synthetic "screen recordings": solid red/green/blue 720p30 (content checks)
// and detailed moving testsrc2 1080p30 (realistic encode load), each with tones.
const SOURCE_SECONDS = 21, OUT_TOTAL_MS = 16000;
const RANGES = [{ startMs: 500, endMs: 8500 }, { startMs: 10000, endMs: 18000 }];
let scratch;
const sources = {};

// Identical algorithm to sha256File in video-export-trial.cjs, plus timing.
async function hashOnce(file) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_BINARY) throw new Error('invalid executable');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function mediaInfo(file) {
  return JSON.parse((await runProcess(ffprobePath, ['-v','error','-show_entries','stream=codec_type,codec_name,duration:format=duration','-of','json',file], { timeoutMs: 30000 })).stdout);
}
async function colorAt(file, seconds) {
  const { stdout } = await exec(ffmpegPath, ['-v','error','-i',file,'-vf',`fps=100:round=up,select=gte(t\\,${seconds}),scale=1:1`,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'], { encoding:'buffer', windowsHide:true, timeout:60000 });
  assert.equal(stdout.length, 3, `missing frame at ${seconds}`);
  const [r,g,b] = stdout;
  return r > g + 60 && r > b + 60 ? 'red' : b > r + 60 && b > g + 60 ? 'blue' : g > r + 60 && g > b + 60 ? 'green' : 'other';
}
async function toneAt(file, time) {
  const { stdout } = await exec(ffmpegPath, ['-v','error','-ss',String(time),'-i',file,'-t','0.1','-f','s16le','-ac','1','-ar','48000','pipe:1'], { encoding:'buffer', windowsHide:true, timeout:60000 });
  assert.ok(stdout.length >= 9000);
  let crossings = 0, previous = 0;
  for (let i = 0; i + 1 < stdout.length; i += 2) { const value = stdout.readInt16LE(i); if (i && previous <= 0 && value > 0) crossings++; previous = value; }
  return crossings / 0.1;
}
const plan = () => ({ durationMs: SOURCE_SECONDS * 1000, ranges: RANGES, totalMs: OUT_TOTAL_MS });
const original = key => ({ bytes: sources[key].bytes, extension: 'mp4', mimeType: 'video/mp4', hasAudio: true });

before(async () => {
  if (!optIn) return;
  for (const p of [ffmpegPath, ffprobePath, sampleDir]) assert.ok(path.isAbsolute(p), 'fixture paths must be absolute');
  for (const [name, file] of [['ffmpeg', ffmpegPath], ['ffprobe', ffprobePath]]) assert.equal(await hashOnce(file), PINS[name], 'supplied binaries must match pinned local R&D build');
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'jiegetu-save-perf-'));
  const solid = path.join(scratch, 'source-solid-720p.mp4');
  const args = ['-v','error'];
  for (const color of ['red','green','blue']) args.push('-f','lavfi','-i',`color=${color}:s=1280x720:r=30:d=7`);
  for (const hz of [440,660,880]) args.push('-f','lavfi','-i',`sine=frequency=${hz}:sample_rate=48000:duration=7`);
  args.push('-filter_complex','[0:v][1:v][2:v]concat=n=3:v=1:a=0[v];[3:a][4:a][5:a]concat=n=3:v=0:a=1[a]',
    '-map','[v]','-map','[a]','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-n',solid);
  await runProcess(ffmpegPath, args, { timeoutMs: 240000 });
  sources.solid = { file: solid, bytes: await fs.readFile(solid) };
  const detail = path.join(scratch, 'source-detail-1080p.mp4');
  await runProcess(ffmpegPath, ['-v','error','-f','lavfi','-i','testsrc2=s=1920x1080:r=30:d=21','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=21',
    '-map','0:v:0','-map','1:a:0','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-n',detail], { timeoutMs: 240000 });
  sources.detail = { file: detail, bytes: await fs.readFile(detail) };
}, { timeout: 600000 });
after(async () => { if (scratch) await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

test('isolated sha256 and copy cost of the two pinned tools', { skip, timeout: 120000 }, async () => {
  const report = {};
  for (const [name, file] of [['ffmpeg', ffmpegPath], ['ffprobe', ffprobePath]]) {
    const size = (await fs.lstat(file)).size, hashes = [], copies = [];
    for (let i = 0; i < 2; i++) {
      let t = performance.now();
      assert.equal(await hashOnce(file), PINS[name]);
      hashes.push(Math.round(performance.now() - t));
      const target = path.join(scratch, `copy-${name}-${i}.exe`);
      t = performance.now();
      await fs.copyFile(file, target, constants.COPYFILE_EXCL);
      copies.push(Math.round(performance.now() - t));
      await fs.rm(target, { force: true });
    }
    report[name] = { bytes: size, hashMs: hashes, copyMs: copies };
  }
  console.log('ISOLATED ' + JSON.stringify(report));
});

test('full trial export stage breakdown on synthetic sources', { skip, timeout: 600000 }, async () => {
  for (const key of ['solid', 'detail']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiegetu-save-perf-trial-'));
    let hashMs = 0, hashCalls = 0, probeMs = 0, probeCalls = 0, encodeMs = 0, encodeCalls = 0;
    const calls = [];
    try {
      await fs.writeFile(path.join(root, CONFIG), JSON.stringify({ enabled: true, ffmpeg: { path: ffmpegPath, sha256: PINS.ffmpeg }, ffprobe: { path: ffprobePath, sha256: PINS.ffprobe } }), { flag: 'wx' });
      const loader = createTrialLoader({ userData: root, isPackaged: false, testHooks: {
        hashFile: async file => { const t = performance.now(); try { return await hashOnce(file); } finally { hashMs += performance.now() - t; hashCalls++; } },
        runProcess: async (exe, args, opts) => {
          const t = performance.now();
          try { return await runProcess(exe, args, opts); }
          finally {
            const ms = performance.now() - t, name = path.basename(exe).toLowerCase();
            calls.push({ name, ms: Math.round(ms) });
            if (name.startsWith('ffprobe')) { probeMs += ms; probeCalls++; } else { encodeMs += ms; encodeCalls++; }
          }
        },
      } });
      let t = performance.now();
      const exportVideo = await loader.load();
      const loadMs = Math.round(performance.now() - t);
      assert.equal(typeof exportVideo, 'function');
      const beforeBytes = Buffer.from(sources[key].bytes);
      t = performance.now();
      const output = await exportVideo({ original: original(key), plan: plan() });
      const totalMs = Math.round(performance.now() - t);
      assert.deepEqual(sources[key].bytes, beforeBytes, '原片不变');
      assert.equal(output.extension, 'mp4');
      assert.deepEqual(await fs.readdir(path.join(root, SCRATCH)), []);
      const breakdown = { source: key, loadMs, totalMs, hashMs: Math.round(hashMs), hashCalls, probeMs: Math.round(probeMs), probeCalls, encodeMs: Math.round(encodeMs), encodeCalls, remainderMs: Math.round(totalMs - hashMs - probeMs - encodeMs), outputBytes: output.bytes.length, calls };
      console.log('TRIAL-BREAKDOWN ' + JSON.stringify(breakdown));
    } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  }
});

test('x264 preset A/B through the real exporter: module default vs comparison preset', { skip, timeout: 900000 }, async () => {
  const abPreset = process.env.VIDEO_TEST_AB_PRESET || 'veryfast';
  for (const key of ['solid', 'detail']) {
    const results = { source: key };
    for (const preset of [null, abPreset]) {
      const label = preset || 'module-default';
      let encodeMs = 0;
      const run = async (exe, args, opts) => {
        let finalArgs = args;
        if (preset && path.basename(exe).toLowerCase().startsWith('ffmpeg')) {
          const p = args.indexOf('-preset');
          if (p >= 0) finalArgs = [...args.slice(0, p + 1), preset, ...args.slice(p + 2)];
          else {
            const i = args.indexOf('-c:v');
            assert.ok(i >= 0, 'encode args must carry -c:v');
            finalArgs = [...args.slice(0, i), '-preset', preset, ...args.slice(i)];
          }
          assert.equal(finalArgs[finalArgs.lastIndexOf('-preset') + 1], preset, 'comparison preset must be the effective one');
        }
        const t = performance.now();
        try { return await runProcess(exe, finalArgs, opts); }
        finally { if (path.basename(exe).toLowerCase().startsWith('ffmpeg')) encodeMs += performance.now() - t; }
      };
      const exporter = createVideoExporter({ ffmpegPath, ffprobePath, scratchRoot: scratch, run, timeoutMs: 240000 });
      const runs = [];
      let output;
      for (let i = 0; i < 2; i++) {
        const beforeBytes = Buffer.from(sources[key].bytes);
        const t = performance.now();
        output = await exporter({ original: original(key), plan: plan() });
        runs.push({ totalMs: Math.round(performance.now() - t), encodeMs: Math.round(encodeMs) });
        encodeMs = 0;
        assert.deepEqual(sources[key].bytes, beforeBytes, '原片不变');
      }
      const target = path.join(scratch, `out-${key}-${preset || 'default'}.mp4`);
      await fs.writeFile(target, output.bytes, { flag: 'wx' });
      // Full decode exercise, not only container probe.
      await runProcess(ffmpegPath, ['-v','error','-xerror','-i',target,'-map','0:v:0','-map','0:a:0','-f','null','-'], { timeoutMs: 120000 });
      const info = await mediaInfo(target);
      assert.deepEqual(info.streams.map(s => [s.codec_type, s.codec_name]), [['video','h264'],['audio','aac']]);
      for (const stream of info.streams) assert.ok(Math.abs(Number(stream.duration) - OUT_TOTAL_MS / 1000) < 0.08, `${key}/${label} ${stream.codec_type} duration ${stream.duration}`);
      assert.ok(Math.abs(Number(info.format.duration) - OUT_TOTAL_MS / 1000) < 0.08, `${key}/${label} format duration`);
      if (key === 'solid') {
        for (const [time, expected] of [[3,'red'],[7,'green'],[13,'blue']]) assert.equal(await colorAt(target, time), expected, `${label} color at ${time}s`);
        for (const [time, hz] of [[2,440],[9,660],[14,880]]) assert.ok(Math.abs(await toneAt(target, time) - hz) < 40, `${label} tone at ${time}s`);
      }
      results[label] = { runs, outputBytes: output.bytes.length, duration: info.format.duration };
    }
    const a = results['module-default'], b = results[abPreset];
    results.sizeRatio = Number((b.outputBytes / a.outputBytes).toFixed(3));
    results.encodeSpeedup = Number((a.runs[1].encodeMs / Math.max(1, b.runs[1].encodeMs)).toFixed(2));
    console.log('PRESET-AB ' + JSON.stringify(results));
  }
});
