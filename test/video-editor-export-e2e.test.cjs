'use strict';
// Runs only with explicit local R&D binaries and synthetic fixtures. No app install or capture.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const keys = ['VIDEO_TEST_ELECTRON', 'VIDEO_TEST_FFMPEG', 'VIDEO_TEST_FFPROBE', 'VIDEO_TEST_SYNTHETIC_DIR'];
const enabled = keys.every(key => Boolean(process.env[key]));

test('opt-in isolated Electron editor → host IPC → real exporter → saved synthetic MP4', { skip: enabled ? false : 'set VIDEO_TEST_ELECTRON, VIDEO_TEST_FFMPEG, VIDEO_TEST_FFPROBE and VIDEO_TEST_SYNTHETIC_DIR', timeout:65000 }, async () => {
  for (const key of keys) assert.ok(path.isAbsolute(process.env[key]), `${key} must be absolute`);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jiegetu-editor-e2e-'));
  const report = path.join(temp, 'result.json');
  try {
    const env = { ...process.env, VIDEO_TEST_TMPDIR:temp, VIDEO_TEST_REPORT:report };
    delete env.ELECTRON_RUN_AS_NODE;
    let runError;
    try { await run(process.env.VIDEO_TEST_ELECTRON, [path.join(__dirname, 'fixtures/video-editor-export-e2e.cjs'), '--synthetic-video-editor-e2e'], { env, windowsHide:true, timeout:55000, maxBuffer:1024*1024 }); }
    catch (error) { runError = error; }
    let result;
    try { result = JSON.parse(await fs.readFile(report, 'utf8')); }
    catch { throw runError || new Error('fixture did not produce its report'); }
    assert.equal(result.ok, true, result.error || JSON.stringify(result));
    if (runError) throw runError;
    assert.equal(result.originalUnchanged, true);
    assert.deepEqual(result.streams.map(s => s.codec_name), ['h264', 'aac']);
    assert.ok(Number(result.duration) > 1.4 && Number(result.duration) < 2.1);
  } finally { await fs.rm(temp, { recursive:true, force:true, maxRetries:5, retryDelay:200 }); }
});
