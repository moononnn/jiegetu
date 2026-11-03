'use strict';
const fsModule = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parse } = require('../core/gif-timeline.js');
const ownName = /^GIF-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.gif$/;

function createGifClipboard({ directory, helperPath = path.resolve(__dirname, '../native/gif-clipboard.exe'),
  fs = fsModule.promises, spawn = require('node:child_process').spawn,
  maxCacheBytes = 512 * 1024 * 1024, maxCacheFiles = 4096, timeoutMs = 6000,
  uuid = randomUUID } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('GIF 缓存目录必须为主进程私有绝对路径');
  if (!Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < 1 || !Number.isSafeInteger(maxCacheFiles) || maxCacheFiles < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('无效 GIF 复制限制');
  let busy = false;
  function publish(file) {
    return new Promise((resolve, reject) => {
      let child, timer, settled = false, stdout = '', stderrBytes = 0, stdoutBytes = 0;
      const fail = () => finish(new Error('GIF 剪贴板组件失败；成品仍保留，请使用保存/另存'));
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child) {
          child.stdout?.removeListener('data', out); child.stderr?.removeListener('data', err);
          // Keep error guards until close: kill/end can still emit EPIPE asynchronously.
          // The close handler removes these final listeners even after a settled failure.
          if (error) { try { child.kill(); } catch {} }
        }
        if (error) reject(error); else resolve();
      };
      const out = data => {
        stdoutBytes += Buffer.byteLength(data);
        if (stdoutBytes > 16 * 1024) return fail();
        stdout += data.toString('utf8');
      };
      const err = data => { stderrBytes += Buffer.byteLength(data); if (stderrBytes > 4 * 1024) fail(); };
      const close = (code, signal) => {
        child.removeListener('close', close); child.removeListener('error', fail);
        child.stdout?.removeListener('error', fail); child.stderr?.removeListener('error', fail);
        child.stdin?.removeListener('error', fail);
        if (settled) return;
        if (code !== 0 || signal) return fail();
        try { if (JSON.parse(stdout)?.ok !== true) return fail(); } catch { return fail(); }
        finish();
      };
      try {
        child = spawn(helperPath, ['--publish', file], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        child.on('error', fail); child.on('close', close);
        child.stdout.on('data', out); child.stderr.on('data', err);
        child.stdout.on('error', fail); child.stderr.on('error', fail);
        child.stdin?.on('error', fail);
        timer = setTimeout(() => finish(new Error('GIF 复制超时；成品仍保留，请使用保存/另存')), timeoutMs);
        child.stdin?.end();
      } catch { fail(); }
    });
  }
  async function copy(bytes, { isCurrent = () => true } = {}) {
    if (busy) throw new Error('GIF 正在复制，请稍后重试');
    const check = () => { if (typeof isCurrent !== 'function' || !isCurrent()) throw new Error('GIF 预览已关闭，未发布剪贴板内容'); };
    busy = true;
    try {
      check();
      parse(bytes);
      // Snapshot trusted final bytes before any asynchronous operation.
      const snapshot = Buffer.from(bytes);
      await fs.access(helperPath, fsModule.constants.F_OK);
      check();
      await fs.mkdir(directory, { recursive: true });
      let total = 0, count = 0;
      for (const name of await fs.readdir(directory)) {
        if (!ownName.test(name)) continue;
        const stat = await fs.lstat(path.join(directory, name));
        if (!stat.isFile()) continue;
        total += stat.size; count++;
      }
      if (count + 1 > maxCacheFiles || total + snapshot.length > maxCacheBytes) {
        throw new Error(`GIF 复制缓存已满；可清理目录 ${directory}，或使用保存/另存`);
      }
      const name = `GIF-${uuid()}.gif`;
      if (!ownName.test(name)) throw new Error('无效 GIF 缓存文件名');
      const file = path.join(directory, name);
      check();
      await fs.writeFile(file, snapshot, { flag: 'wx' });
      // Check at the final synchronous gate before any external clipboard publication.
      check();
      // Never unlink: even an uncertain helper result may already reference this file.
      await publish(file);
      return { file };
    } finally { busy = false; }
  }
  return { copy };
}
module.exports = { createGifClipboard };
