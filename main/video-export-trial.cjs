'use strict';
// Local development trial only. No executable discovery, download or renderer input.
const fs = require('node:fs/promises');
const { createReadStream, constants } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');
const { createVideoExporter, runProcess } = require('./video-export.cjs');

// Individual executable hashes from the previously verified 9.0.2 local R&D archive.
// A user-controlled config can select a location, never a new executable identity.
const PINS = Object.freeze({
  ffmpeg: '3256173f3f8bffd7df12227c68adf68025edb1832273a9530688a7bb1ed8edec',
  ffprobe: 'f0d36ecbbdd3bcfac3efa078c96c7271c2e68b3810595552ac3b7f17e9a65c52',
});
const CONFIG = 'video-editor-local-trial.json';
const SCRATCH = 'video-editor-trial-scratch';
const MARKER = 'jiegetu-video-editor-local-trial-v1\n';
const RUN_NAME = /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BINARY = 512 * 1024 * 1024;

async function sha256File(file) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_BINARY) throw new Error('invalid executable');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function localPath(file, name) {
  if (typeof file !== 'string' || file.includes('\0') || !path.isAbsolute(file) || path.basename(file).toLowerCase() !== `${name}.exe`) return false;
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(file) || file.slice(2).includes(':'))) return false;
  return true;
}
function exactKeys(obj, keys) {
  return obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length === keys.length && keys.every(k => Object.hasOwn(obj,k));
}
function configValues(config) {
  if (!exactKeys(config,['enabled','ffmpeg','ffprobe']) || config.enabled !== true) return null;
  for (const name of ['ffmpeg','ffprobe']) {
    const entry = config[name];
    if (!exactKeys(entry,['path','sha256']) || !localPath(entry.path,name) || typeof entry.sha256 !== 'string' || entry.sha256.toLowerCase() !== PINS[name]) return null;
  }
  return { ffmpeg:config.ffmpeg.path, ffprobe:config.ffprobe.path };
}

async function readPaths(userData) {
  const file = path.join(userData,CONFIG), stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 8192) return null;
  return configValues(JSON.parse(await fs.readFile(file,'utf8')));
}

// Only this private, fixed child of userData can contain scratch. Never follow a
// junction/symlink for the root or a stale run; only remove marked UUID runs.
async function scratchRoot(userData, create) {
  const parent = await fs.realpath(userData), root = path.join(parent,SCRATCH);
  if (create) { try { await fs.mkdir(root, { mode:0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
  let stat; try { stat = await fs.lstat(root); } catch (e) { if (e.code === 'ENOENT' && !create) return null; throw e; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid scratch root');
  const real = await fs.realpath(root);
  const equal = process.platform === 'win32' ? real.toLowerCase() === root.toLowerCase() : real === root;
  if (!equal) throw new Error('invalid scratch root');
  return root;
}
async function cleanupStale(userData) {
  const root = await scratchRoot(userData,false); if (!root) return;
  let unresolved = false;
  for (const entry of await fs.readdir(root,{withFileTypes:true})) {
    if (!RUN_NAME.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) { unresolved = true; continue; }
    const dir = path.join(root,entry.name), marker = path.join(dir,'.owner');
    let owned = false;
    try {
      const m = await fs.lstat(marker);
      owned = m.isFile() && !m.isSymbolicLink() && m.size === Buffer.byteLength(MARKER) && await fs.readFile(marker,'utf8') === MARKER;
    } catch { /* Preserve unrecognized/unreadable entries, but fail closed. */ }
    if (owned) await fs.rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});
    else unresolved = true;
  }
  if (unresolved) throw new Error('无法确认试用临时目录归属');
}
function safeEnvironment(dir) {
  if (process.platform !== 'win32') return { PATH:'/usr/bin:/bin', TMPDIR:dir, HOME:dir };
  const root = process.env.SystemRoot || process.env.WINDIR;
  if (!root || !path.isAbsolute(root)) throw new Error('missing Windows system root');
  return { SystemRoot:root, WINDIR:root, PATH:path.join(root,'System32'), TEMP:dir, TMP:dir };
}

// Optional hooks are process-local unit-test substitutes, never taken from config
// or IPC. Production calls this function with only userData and isPackaged.
function createTrialLoader({ userData, isPackaged = true, softwareAudioTiming = false, testHooks = {} } = {}) {
  if (isPackaged !== false || typeof userData !== 'string' || !path.isAbsolute(userData)) return { load:async () => null, cleanup:async () => {} };
  const hashFile = testHooks.hashFile || sha256File;
  const makeExporter = testHooks.createVideoExporter || createVideoExporter;
  const run = testHooks.runProcess || runProcess;
  const cleanup = () => cleanupStale(userData);
  async function load() {
    try {
      const paths = await readPaths(userData);
      if (!paths) return null;
      for (const name of ['ffmpeg','ffprobe']) {
        const stat = await fs.lstat(paths[name]);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_BINARY) return null;
      }
      // Full hashes are checked on actual export, not while opening the editor.
      // The export closure verifies the originals and hashes its private copies
      // again immediately before *each* process. No renderer-supplied path enters here.
      return async request => {
        if (request?.signal?.aborted) throw new Error('导出已取消');
        const now = await readPaths(userData);
        if (!now || now.ffmpeg !== paths.ffmpeg || now.ffprobe !== paths.ffprobe) throw new Error('视频试用已停用或配置已变化');
        const root = await scratchRoot(userData,true), dir = path.join(root,`run-${randomUUID()}`);
        await fs.mkdir(dir,{mode:0o700});
        try {
          await fs.writeFile(path.join(dir,'.owner'),MARKER,{flag:'wx',mode:0o600});
          const snapshots = {};
          for (const name of ['ffmpeg','ffprobe']) {
            if (await hashFile(paths[name]) !== PINS[name]) throw new Error('试用工具已变化');
            const target = path.join(dir,`${name}.exe`);
            await fs.copyFile(paths[name],target,constants.COPYFILE_EXCL);
            if (await hashFile(target) !== PINS[name]) throw new Error('试用工具校验失败');
            snapshots[name] = target;
          }
          const guardedRun = async (exe,args,opts) => {
            const name = exe === snapshots.ffmpeg ? 'ffmpeg' : exe === snapshots.ffprobe ? 'ffprobe' : null;
            if (!name || await hashFile(exe) !== PINS[name]) throw new Error('试用工具校验失败');
            if (opts?.signal?.aborted) throw new Error('导出已取消');
            return run(exe,args,{ ...opts, cwd:dir, env:safeEnvironment(dir) });
          };
          // 试用装载器专用：这里才把显式时间轴候选交给导出器。普通导出器（main/index.cjs）仍是默认 packet，
          // 安装版/打包版因 isPackaged !== false 直接返回 null，用不到这条路径。
          return await makeExporter({ ffmpegPath:snapshots.ffmpeg, ffprobePath:snapshots.ffprobe, scratchRoot:dir, run:guardedRun, timeline:'explicit-pts', ...(softwareAudioTiming === true ? { softwareAudioTiming:true } : {}) })(request);
        } finally {
          try { await fs.rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100}); }
          catch { const error = new Error('试用临时文件清理失败'); error.code = 'TRIAL_CLEANUP_FAILED'; throw error; }
        }
      };
    } catch { return null; }
  }
  return { load, cleanup };
}
module.exports = { createTrialLoader, CONFIG, SCRATCH, PINS };
