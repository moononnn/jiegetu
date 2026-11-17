/* 剪贴板服务：spawn 原生 helper，维护监听状态、命令队列与 spool 校验。
   真实监听开关永远由这里驱动；renderer 看不到 helper、spool 或任何绝对路径。
   文件读取先过路径/类型/大小闸，再把白名单格式交给上层入库。 */
'use strict';

const path = require('node:path');
const fsModule = require('node:fs');
const { spawn: defaultSpawn } = require('node:child_process');
const model = require('../core/clipboard-model.cjs');
const crypto = require('node:crypto');

const ALLOWED_EXT = new Set(['.txt', '.html', '.rtf', '.png', '.dib', '.files', '.gif']);
const FORMAT_TO_KEY = { text: 'text', html: 'html', rtf: 'rtf', png: 'png', dib: 'dib', files: 'files' };
const MAX_PARTS = 8;

function createClipboardService({ helperPath = path.join(__dirname, '../native/clipboard-helper.exe'), spoolDir,
  spawn = defaultSpawn, fs = fsModule, excludedApps = [], timeoutMs = 8000, now = () => Date.now(),
  onEvent, onStatus } = {}) {
  if (typeof spoolDir !== 'string' || !path.isAbsolute(spoolDir)) throw new Error('剪贴板 spool 目录必须是主进程私有绝对路径');
  let child;
  let phase = 'stopped';
  // 真实监听状态：helper 启动只建好窗口，AddClipboardFormatListener 要靠 watch 命令才注册。
  let listening = false;
  let sequence = 0;
  let starting;
  let disposed = false;
  const pending = new Map();
  const excluded = new Set((Array.isArray(excludedApps) ? excludedApps : [])
    .map(normalizeProcessName).filter(Boolean));
  const published = new Set();

  function normalizeProcessName(value) {
    if (typeof value !== 'string') return '';
    return value.trim().toLowerCase().replace(/\.exe$/, '');
  }

  function setPhase(next, detail) {
    if (phase === next) return;
    phase = next;
    try { onStatus?.({ phase, ...detail }); } catch { /* 状态提示失败不影响服务。 */ }
  }

  function ensureSpool() {
    fs.mkdirSync(spoolDir, { recursive: true });
    const stat = fs.statSync(spoolDir);
    if (!stat.isDirectory()) throw new Error('剪贴板 spool 路径不是目录');
  }

  function safeName(value) {
    if (typeof value !== 'string' || value.length < 5 || value.length > 96) return null;
    if (value.includes('/') || value.includes('\\') || value.includes('..')) return null;
    if (!/^[0-9a-f-]+\.[a-z]+$/.test(value)) return null;
    if (!ALLOWED_EXT.has(path.extname(value))) return null;
    const full = path.join(spoolDir, value);
    if (path.dirname(path.resolve(full)) !== path.resolve(spoolDir)) return null;
    return full;
  }

  // 只清自己的 spool：白名单扩展名、直接子文件、非目录/reparse、超过年龄才删。
  // 不扫任何其他路径，也不碰正在跑的另一批次（用10 分钟年龄门槛做保守界限）。
  function cleanStaleSpool(ageMs = 10 * 60 * 1000) {
    let names;
    try { names = fs.readdirSync(spoolDir); } catch { return 0; }
    let removed = 0;
    const cutoff = Date.now() - ageMs;
    for (const name of names) {
      const full = safeName(name);
      if (!full) continue;
      try {
        const stat = fs.lstatSync(full);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        if (stat.mtimeMs > cutoff) continue;
        fs.unlinkSync(full);
        removed += 1;
      } catch { /* 别的进程刚拿走就算了。 */ }
    }
    return removed;
  }

  // 事件里点名的 spool 文件：只认自己的目录、白名单扩展名、普通文件。
  function ownedSpoolFiles(event) {
    const owned = [];
    for (const part of Array.isArray(event?.formats) ? event.formats : []) {
      const full = safeName(part?.file);
      if (!full) continue;
      try {
        const stat = fs.lstatSync(full);
        if (stat.isFile() && !stat.isSymbolicLink()) owned.push(full);
      } catch { /* 不存在。 */ }
    }
    return owned;
  }
  function dropOwned(files) { for (const full of files) { try { fs.unlinkSync(full); } catch { /* 已不在。 */ } } }

  // 把排除列表推给原生：能写 spool 之前就挡掉，不靠 JS 落盘后再过滤。
  function pushExclusions() {
    if (!child) return;
    try { command('exclude', { apps: [...excluded] }).catch(() => { /* 下次 start 再推。 */ }); }
    catch { /* 管道不可用就算了，JS 侧还有一层过滤。 */ }
  }

  function nextId() { return ++sequence; }

  function send(payload) {
    if (!child || !child.stdin || child.stdin.destroyed) throw new Error('剪贴板组件没有在运行');
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  function command(cmd, params = {}, timeout = timeoutMs) {
    const id = nextId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('剪贴板组件响应超时')); }, timeout);
      pending.set(id, { resolve, reject, timer });
      try { send({ id, cmd, ...params }); }
      catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }

  function failAll(message) {
    for (const [id, entry] of pending) { clearTimeout(entry.timer); entry.reject(new Error(message)); pending.delete(id); }
  }

  function handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || typeof message !== 'object') return;
    if (message.event === 'ready') {
      settleStart(null);
      setPhase('ready');
      return;
    }
    if (message.event === 'clip') {
      handleClip(message);
      return;
    }
    // 迟到的错误事件：只影响状态提示，不把服务说成正常。
    if (message.event === 'error') { try { onStatus?.({ phase, error: true, code: message.code }); } catch { /* 忽略。 */ } return; }
    if (typeof message.id !== 'number') return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok === true) entry.resolve(message);
    else entry.reject(new Error(message.code || '剪贴板组件拒绝了这次操作'));
  }

  function settleStart(error) {
    if (!starting) return;
    const wait = starting;
    starting = undefined;
    if (error) wait.reject(error); else wait.resolve(true);
  }

  function attach(proc) {
    child = proc;
    proc.stdout?.setEncoding?.('utf8');
    let buffer = '';
    proc.stdout?.on('data', chunk => {
      buffer += chunk;
      // 单行 64KiB 闸：超了整块丢掉，不让坏 JSON 撑爆内存。
      while (true) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.length <= 64 * 1024) handleLine(line);
      }
      if (buffer.length > 64 * 1024) buffer = '';
    });
    proc.stdout?.on('error', () => {});
    proc.stderr?.on('data', () => { /* 只收错误码，不落内容。 */ });
    proc.stderr?.on('error', () => {});
    proc.on('error', error => {
      failAll(`剪贴板组件启动失败：${error?.message || error}`);
      settleStart(new Error(`剪贴板组件启动失败：${error?.message || error}`));
      setPhase('interrupted', { error: true });
    });
    proc.on('exit', (code, signal) => {
      const current = child === proc;
      if (current) child = undefined;
      listening = false;
      failAll('剪贴板组件已退出');
      // 主动 stop 已经清掉 child：退出事件只收尾，不把状态改回“已中断”。
      if (disposed || !current) return;
      setPhase('interrupted', { code, signal });
    });
  }

  async function start() {
    if (disposed) throw new Error('剪贴板服务已关闭');
    if (child && phase !== 'interrupted') return true;
    ensureSpool();
    // 启动时只清自己 spool 里已经陈旧的批次，不碰正在跑的。
    try { cleanStaleSpool(); } catch { /* 清理失败不影响启动。 */ }
    if (starting) return starting.promise;
    let resolveStart;
    let rejectStart;
    const promise = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    starting = { resolve: resolveStart, reject: rejectStart, promise };
    const timer = setTimeout(() => {
      settleStart(new Error('剪贴板组件启动超时'));
      try { child?.kill?.(); } catch { /* 已经结束。 */ }
      setPhase('interrupted', { error: true });
    }, timeoutMs);
    promise.then(() => clearTimeout(timer), () => clearTimeout(timer));
    try {
      const proc = spawn(helperPath, ['--watch', '--spool', spoolDir], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      attach(proc);
      await promise;
      // 关键：helper 就绪不等于在监听。不显式发 watch，它永远不会注册剪贴板监听，
      // 外部复制（文字/图片/文件）一条都不会进来。
      const watched = await command('watch').catch(() => null);
      // 启动过程里被 stop/dispose 抢断：不算启动失败，也不再动状态。
      if (!child) return true;
      if (!watched || watched.listening !== true) {
        setPhase('interrupted', { error: true });
        return false;
      }
      listening = true;
      setPhase('ready');
      pushExclusions();
      return true;
    } catch (error) {
      settleStart(error);
      throw error;
    }
  }

  // 暂停只退订监听，发布通道还在；历史仍可复制。
  async function pause() {
    if (!child) throw new Error('剪贴板组件没有在运行');
    const reply = await command('pause');
    if (reply.listening === true) throw new Error('剪贴板监听没能暂停');
    listening = false;
    setPhase('paused');
    return true;
  }

  async function resume() {
    if (!child) throw new Error('剪贴板组件没有在运行');
    const reply = await command('resume');
    if (reply.listening !== true) throw new Error('剪贴板监听没能恢复');
    listening = true;
    setPhase('ready');
    return true;
  }

  // 发布：字节先写进自己的 spool，再让 helper 在同一 STA 里发布；成功后才算复制完成。
  // 常驻 helper 不在（记录未启用/已停用）时走同一产物的单次 --publish 模式：
  // 不注册监听，只发这一次，历史复制与组文件复制在关闭记录后仍然可用。
  // spool 写盘不在主线程同步做：4K 图一次 20MB+，同步写会直接顶住事件循环。
  // 先 open('wx') 取得独占句柄，拿到句柄才登记“本次拥有”，再写、再关，最后统一异步删。
  // open 失败（含 EEXIST）不登记，也就不会误删不属于本次的文件。
  async function openSpoolFile(file) {
    const promises = fs && fs.promises;
    if (!promises || typeof promises.open !== 'function') throw new Error('剪贴板组件缺少异步写入能力');
    return promises.open(file, 'wx');
  }

  async function writeSpoolFile(handle, bytes) {
    await handle.writeFile(bytes);
  }

  async function closeHandle(handle) {
    try { await handle.close(); } catch { /* 已关闭就继续。 */ }
  }

  // 回收自己这次的 spool 文件：异步删，失败也不抛（可能已被原生接管）。
  async function dropWritten(files) {
    const promises = fs && fs.promises;
    for (const file of files) {
      try {
        if (promises && typeof promises.unlink === 'function') await promises.unlink(file);
        else fs.unlinkSync(file);
      } catch { /* 已被原生接管或已不在。 */ }
    }
  }

  async function publish(parts, { isCurrent = () => true } = {}) {
    if (disposed) throw new Error('剪贴板服务已关闭');
    if (!Array.isArray(parts) || !parts.length || parts.length > MAX_PARTS) throw new Error('复制内容无效');
    const check = () => {
      if (disposed) throw new Error('剪贴板服务已关闭');
      if (typeof isCurrent === 'function' && isCurrent() !== true) throw new Error('复制已取消');
    };
    const entries = [];
    const written = [];
    try {
      ensureSpool();
      for (const part of parts) {
        check();
        if (part.paths) {
          entries.push({ format: 'files', paths: part.paths.slice() });
          continue;
        }
        if (!Buffer.isBuffer(part.bytes) || part.bytes.length < 1) throw new Error('复制内容为空');
        const ext = part.format === 'text' ? '.txt' : part.format === 'html' ? '.html' : part.format === 'rtf' ? '.rtf'
          : part.format === 'png' ? '.png' : part.format === 'dib' ? '.dib' : part.format === 'gif' ? '.gif' : null;
        if (!ext) throw new Error('复制格式不支持');
        const name = `${Date.now()}-${crypto.randomUUID()}.${ext.slice(1)}`;
        if (!safeName(name)) throw new Error('复制临时文件无效');
        const full = path.join(spoolDir, name);
        const handle = await openSpoolFile(full);
        // 句柄到手才算本次拥有：后面写一半失败也能清掉自己这个文件。
        written.push(full);
        try {
          check();
          await writeSpoolFile(handle, part.bytes);
        } finally {
          await closeHandle(handle);
        }
        // 异步窗口里可能已被取消/关闭：这时还没进发布点，可以安全回收并如实报错。
        check();
        entries.push({ format: part.format, file: name });
      }
      check();
      if (child) {
        const reply = await command('publish', { entries });
        if (reply.published !== true) throw new Error('剪贴板拒绝接收这次复制');
      } else {
        await publishOnce(entries);
      }
      // 已越过发布点：native 把负载读进内存并 SetDataObject(copy=true)，成功 ACK 后
      // 本次自己写的 spool 副本就能回收。只删 written（本函数自己创建的文件），
      // 不碰 part.paths 指向的外部文件、组导出文件或 GIF 缓存；也不因 isCurrent 再报“已取消”。
      await dropWritten(written);
      return { ok: true, entries: entries.length, published: true };
    } catch (error) {
      // 只有自己刚写、还没交给系统的文件才回收；已发布的不动。
      await dropWritten(written);
      throw error;
    }
  }

  // 单次发布：spawn 一次 --publish，读完一行结果就结束；不注册监听、不留常驻进程。
  function publishOnce(entries) {
    const specName = `${Date.now()}-${crypto.randomUUID()}.json`;
    const specPath = path.join(spoolDir, specName);
    fs.writeFileSync(specPath, JSON.stringify(entries), { encoding: 'utf8', flag: 'wx' });
    return new Promise((resolve, reject) => {
      let proc;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        try { fs.unlinkSync(specPath); } catch { /* 可能已被接管。 */ }
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => {
        try { proc?.kill?.(); } catch { /* 已退出。 */ }
        finish(new Error('剪贴板组件响应超时'));
      }, timeoutMs);
      timer.unref?.();
      try {
        proc = spawn(helperPath, ['--publish', specPath, '--spool', spoolDir], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        clearTimeout(timer);
        finish(new Error(`剪贴板组件启动失败：${error?.message || error}`));
        return;
      }
      let output = '';
      proc.stdout?.setEncoding?.('utf8');
      proc.stdout?.on('data', chunk => { if (output.length < 64 * 1024) output += chunk; });
      proc.stderr?.on('data', () => { /* 只收错误码，不落内容。 */ });
      proc.on('error', error => { clearTimeout(timer); finish(new Error(`剪贴板组件启动失败：${error?.message || error}`)); });
      proc.on('exit', code => {
        clearTimeout(timer);
        let reply;
        try { reply = JSON.parse(output.trim().split(/\r?\n/).filter(Boolean).pop() || '{}'); } catch { reply = undefined; }
        if (code === 0 && reply?.ok === true) finish(null, true);
        else finish(new Error(code === 0 ? '剪贴板没有接收这次复制' : '剪贴板拒绝接收这次复制'));
      });
    });
  }

  // 事件里的 spool 文件：验证名字/类型/大小，读成白名单 entries；读取后回收自己拥有的文件。
  function readParts(event) {
    if (!event || !Array.isArray(event.formats)) return { entries: [], assetHash: undefined };
    if (event.formats.length > MAX_PARTS) throw new Error('剪贴板格式数量超过上限');
    const entries = [];
    const names = [];
    let pngBytes;
    let dibEntry;
    for (const part of event.formats) {
      const key = FORMAT_TO_KEY[part?.format];
      if (!key) continue;
      if (!Number.isSafeInteger(part.size) || part.size < 1) throw new Error('剪贴板格式大小无效');
      const full = safeName(part.file);
      if (!full) throw new Error('剪贴板临时文件无效');
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.size !== part.size || stat.size > (key === 'files' ? 262144 : 148 * 1024 * 1024)) {
        throw new Error('剪贴板临时文件与声明不符');
      }
      names.push(full);
      if (key === 'files') {
        const text = fs.readFileSync(full, 'utf8');
        const paths = text.split(/\r\n|\n/).filter(item => item.length > 0);
        if (paths.length > 1024) throw new Error('剪贴板文件列表超过上限');
        entries.push({ key: 'files', paths });
        continue;
      }
      const bytes = fs.readFileSync(full);
      if (key === 'png') { pngBytes = bytes; entries.push({ key: 'png', bytes }); continue; }
      if (key === 'dib') { dibEntry = { key: 'dib', bytes }; continue; }
      entries.push({ key, bytes });
    }
    // 有 PNG 就不再存等价的大 DIB；只有 DIB 时保留 DIB 原件，PNG 副本来自 helper。
    if (!pngBytes && dibEntry) entries.push(dibEntry);
    for (const full of names) { try { fs.unlinkSync(full); } catch { /* 自己的文件，删失败只留待清理。 */ } }
    const assetHash = pngBytes ? model.sha256(pngBytes) : undefined;
    return { entries, assetHash };
  }

  function handleClip(event) {
    // 所有早退分支（暂停/已排除/系统标记/格式异常）都要回收自己这次已经写出的 spool。
    const owned = ownedSpoolFiles(event);
    try {
      if (phase !== 'ready') return; // 暂停/中断时不消费事件
      if (event.excluded === true) return;
      const sourceName = normalizeProcessName(event.source?.name);
      if (sourceName && excluded.has(sourceName)) {
        try { onStatus?.({ phase, excluded: sourceName }); } catch { /* 提示失败不影响。 */ }
        return;
      }
      let parts;
      try { parts = readParts(event); } catch (error) {
        try { onStatus?.({ phase, error: true, code: error.message }); } catch { /* 忽略。 */ }
        return;
      }
      if (!parts.entries.length) return;
      // 迟到事件不能重新开始记录：只在自己仍 ready 时交上层。
      try { onEvent?.({ ...parts, source: event.source?.name || '', pid: event.source?.pid || 0, seq: event.seq }); }
      catch (error) { try { onStatus?.({ phase, error: true, code: error.message }); } catch { /* 忽略。 */ } }
    } finally {
      dropOwned(owned);
    }
  }

  // 定向粘贴：只有调用方给了呼出前目标窗口才试，helper 自己核 HWND/PID 与前台才发键。
  async function paste({ hwnd, pid, timeout = 3000 } = {}) {
    if (!child || phase === 'interrupted') return { pasted: false, reason: 'no-service' };
    if (!Number.isInteger(hwnd) || hwnd <= 0 || !Number.isInteger(pid) || pid <= 0) return { pasted: false, reason: 'invalid' };
    try {
      const reply = await command('paste', { hwnd, pid }, timeout);
      // reason 只用于诊断：ok / not-window / pid-mismatch / self / no-foreground
      return { pasted: reply.pasted === true, reason: typeof reply.reason === 'string' ? reply.reason : '',
        fg: Number.isFinite(reply.fgwnd) ? reply.fgwnd : undefined };
    } catch { return { pasted: false, reason: 'timeout' }; }
  }

  // 停止常驻 helper：只停监听进程，保留单次 --publish 能力（关闭记录后历史仍可复制）。
  // 真正的销毁走 dispose()；退出后迟到操作不能把服务重新拉起来。
  async function stop({ timeout = 4000 } = {}) {
    const proc = child;
    child = undefined;
    listening = false;
    failAll('剪贴板服务已停止');
    setPhase('stopped');
    if (!proc) return true;
    try { proc.stdin?.write(`${JSON.stringify({ id: nextId(), cmd: 'quit' })}\n`); } catch { /* 可能已断。 */ }
    await new Promise(resolve => {
      const timer = setTimeout(() => { try { proc.kill?.(); } catch { /* 已退出。 */ } resolve(false); }, timeout);
      proc.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
    return true;
  }

  // 最终销毁：之后 publish 一律拒绝，不再 spawn 任何 helper。
  async function dispose() {
    if (disposed) return true;
    disposed = true;
    return stop();
  }

  // 显式继续：使用者点“继续记录”才重启，不自动无限重试。
  async function restart() {
    if (disposed) throw new Error('剪贴板服务已关闭');
    if (child) { try { child.kill(); } catch { /* 已退出。 */ } child = undefined; }
    setPhase('stopped');
    return start();
  }

  return {
    start, stop, dispose, pause, resume, publish, paste, readParts, restart,
    status: () => ({ phase, pid: child?.pid || 0, listening }),
    isReady: () => phase === 'ready',
    isAlive: () => Boolean(child),
    setExcludedApps(list) {
      excluded.clear();
      for (const item of Array.isArray(list) ? list : []) {
        const name = normalizeProcessName(item);
        if (name) excluded.add(name);
      }
      pushExclusions();
      return excluded.size;
    }
  };
}

module.exports = { createClipboardService, FORMAT_TO_KEY, ALLOWED_EXT };
