/* 剪贴板历史窗：单窗、按需创建；所有 IPC 都核 sender 主 frame 与窗口 token。
   renderer 只拿 entryId 与窄动作，读不到绝对路径、也拿不到 store/service 实例。 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

function installClipboardWindow({ BrowserWindow, ipcMain, rendererFile, preloadFile, iconFile, theme, nativeImage,
  store, service, settings, onStatus, getPasteTarget, getProcessName, onLifecycle, onOpenWorkspace, onOpenGroup,
  getRevision, multiCopyDir, openEditor } = {}) {
  let win;
  let token;
  let hiddenByUser = false;
  let visibilityRevision = 0;
  let disposed = false;
  // 缩略图是可丢的派生缓存：不超过 64MiB、单张不超过 2M 像素，满了从头退。
  const thumbs = new Map();
  let thumbBytes = 0;
  const THUMB_MAX_BYTES = 64 * 1024 * 1024;
  const THUMB_MAX_PIXELS = 2_000_000;
  // 看大图用的预览图：比缩略图大得多，但仍有天花板，长图按像素上限等比缩。
  const previews = new Map();
  let previewBytes = 0;
  const PREVIEW_MAX_BYTES = 96 * 1024 * 1024;
  const PREVIEW_MAX_WIDTH = 1600;
  const PREVIEW_MAX_PIXELS = 6_000_000;

  function stateOf() {
    const clipboard = settings?.getClipboard ? settings.getClipboard() : {
      enabled: false, paused: false, hotkey: 'Ctrl+Alt+V', retentionDays: 30,
      maxHistoryItems: 1000, maxStorageBytes: 2 * 1024 * 1024 * 1024, excludedApps: []
    };
    const phase = service?.status ? service.status().phase : 'stopped';
    // historyRevision 只用于“有新记录没显示”的判定，不带任何内容。
    return { clipboard, phase, listening: phase === 'ready', ready: Boolean(win && !win.isDestroyed()),
      historyRevision: typeof getRevision === 'function' ? getRevision() : 0 };
  }

  async function pushState() {
    if (!win || win.isDestroyed()) return;
    try { win.webContents.send('clip:state', stateOf()); } catch { /* 页面暂时不可达。 */ }
  }

  function alive() { return Boolean(win && !win.isDestroyed()); }

  function senderOf(event) {
    if (!alive() || !event || !event.sender) return undefined;
    const contents = win.webContents;
    if (event.sender !== contents) return undefined;
    if (contents.mainFrame && event.senderFrame !== contents.mainFrame) return undefined;
    return { token };
    }

  function wrap(name, fn) {
    ipcMain.handle(name, async (event, payload = {}) => {
      const sender = senderOf(event);
      const supplied = payload && typeof payload === 'object' ? payload.token : undefined;
      if (!sender || supplied !== sender.token) throw new Error('剪贴板窗口已失效');
      const { token: _token, ...rest } = payload || {};
      return fn(rest, sender);
    });
  }

  async function payloadOf(id) {
    const content = await store.contentOf(id);
    const parts = [];
    for (const part of content.parts) {
      if (part.format === 'files') {
        if (!Array.isArray(part.paths) || !part.paths.length) continue;
        parts.push({ format: 'files', paths: part.paths.slice() });
        continue;
      }
      const bytes = part.bytes || (part.blobKey ? await store.readBlob(part.blobKey) : undefined);
      if (!bytes || !bytes.length) throw new Error('这条内容的本机原件已不可读');
      parts.push({ format: part.format, bytes });
    }
    if (!parts.length) throw new Error('这条内容没有可复制的格式');
    return parts;
  }

  // —— 多条合并复制 ——
  // 文本按顺序拼成一段；多张图片只能变成多个临时文件（剪贴板一次只能带一张“图片”）。
  function multiCopyTempDir() {
    if (typeof multiCopyDir === 'string' && multiCopyDir) return multiCopyDir;
    return path.join(path.dirname(multiCopyDir || '.'), 'multi-copy');
  }

  // 只清自己目录下的 multi-*.png，超过一天且是普通文件才删。
  function cleanMultiCopy(ageMs = 7 * 24 * 60 * 60 * 1000) {
    const dir = multiCopyTempDir();
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    const now = Date.now();
    for (const name of names) {
      if (!/^(jiegetu-multi-\d{8}-\d{6}-[0-9a-z]{8}|multi-[0-9a-zA-Z-]+)\.png$/.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const stat = fs.lstatSync(full);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        if (now - stat.mtimeMs > ageMs) fs.unlinkSync(full);
      } catch { /* 被占用就算了，下次再清。 */ }
    }
  }

  // 文件名用纯 ASCII：别的程序读这个路径时不再碰到中文/空格/间隔号。
  function multiCopyName() {
    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `jiegetu-multi-${stamp}-${randomUUID().replace(/-/g, '').slice(0, 8)}.png`;
  }

  function writeMultiPng(bytes) {
    const dir = multiCopyTempDir();
    fs.mkdirSync(dir, { recursive: true });
    const full = path.join(dir, multiCopyName());
    fs.writeFileSync(full, bytes, { flag: 'wx' });
    return full;
  }

  async function copyMany(ids, { paste = false } = {}) {
    const origin = win, revision = visibilityRevision;
    if (!Array.isArray(ids) || !ids.length) throw new Error('没有勾选内容');
    if (ids.length > 50) throw new Error('一次最多合并 50 条');
    cleanMultiCopy();
    const texts = [];
    const filePaths = [];
    const images = [];
    for (const id of ids) {
      if (!Number.isInteger(id)) continue;
      const content = await store.contentOf(id).catch(() => null);
      if (!content) continue;
      for (const part of content.parts) {
        if (part.format === 'files') {
          if (Array.isArray(part.paths)) for (const item of part.paths) if (typeof item === 'string' && item) filePaths.push(item);
          continue;
        }
        const bytes = part.bytes || (part.blobKey ? await store.readBlob(part.blobKey).catch(() => null) : null);
        if (!bytes || !bytes.length) continue;
        // 契约：text 负载是 UTF-16LE 原字节；拼接前先当文本读出来。
        if (part.format === 'text') texts.push(Buffer.from(bytes).toString('utf16le').replace(/\u0000+$/g, ''));
        else if (part.format === 'png') images.push(bytes);
      }
    }
    const parts = [];
    const imagesAsFiles = images.length > 0 && !(images.length === 1 && !texts.length && !filePaths.length);
    if (texts.length) parts.push({ format: 'text', bytes: Buffer.from(texts.join('\n'), 'utf16le') });
    if (!imagesAsFiles && images.length === 1) {
      // 只勾了一张图、也没别的：直接给图片，粘出来是图而不是文件。
      parts.push({ format: 'png', bytes: images[0] });
    } else if (imagesAsFiles) {
      for (const bytes of images) filePaths.push(writeMultiPng(bytes));
    }
    if (filePaths.length) parts.push({ format: 'files', paths: filePaths });
    if (!parts.length) throw new Error('勾选的这些内容没有可复制的格式');
    try {
      await service.publish(parts);
    } catch (error) {
      onLifecycle?.('clipboard-copy-many', { ok: false, ids: ids.length, texts: texts.length,
        images: images.length, files: filePaths.length, error: error?.message || String(error) });
      throw error;
    }
    onLifecycle?.('clipboard-copy-many', { ok: true, ids: ids.length, texts: texts.length,
      images: images.length, files: filePaths.length, imagesAsFiles });
    for (const id of ids) { if (Number.isInteger(id)) { try { await store.touch(id); } catch { /* 最近使用不更新不影响复制。 */ } } }
    try { await pushState(); } catch { /* 页面暂时不可达。 */ }
    const counts = { texts: texts.length, images: images.length, files: filePaths.length, imagesAsFiles };
    if (imagesAsFiles && filePaths.length) counts.folder = multiCopyTempDir();
    if (!paste) { hideCopiedWindow(origin, revision); return { ok: true, copied: true, ...counts }; }
    return { ...counts, ...await pasteToRecentTarget(`这 ${ids.length} 条`) };
  }

  // 把刚发布的内容定向粘到呼出历史窗前的那个窗口。单条和多条共用。
  async function pasteToRecentTarget(label = '内容') {
    const target = typeof getPasteTarget === 'function' ? getPasteTarget() : undefined;
    if (!target || !target.hwnd || !target.pid) {
      return { ok: true, copied: true, pasted: false, message: '已复制；没有可恢复的前台窗口，请自行粘贴' };
    }
    // 先把历史窗收起来，避免粘贴键发给自家窗口；窗口真收起再发，否则前台锁会拦住切换。
    try { win.hide(); } catch { /* 窗口不可达时照样尝试目标窗口。 */ }
    await new Promise(resolve => setTimeout(resolve, 90));
    // 进程名查询和粘贴并行，不让查名字拖慢粘贴。
    const nameTask = (async () => {
      try { return typeof getProcessName === 'function' ? await getProcessName(target.pid) : ''; } catch { return ''; }
    })();
    const pastedResult = await service.paste({ hwnd: target.hwnd, pid: target.pid })
      .catch(() => ({ pasted: false, reason: 'error' }));
    const pasted = pastedResult?.pasted === true;
    const reason = pastedResult?.reason || '';
    const name = await nameTask;
    try { onLifecycle?.('clipboard-paste', { ok: pasted, target: name || 'unknown', reason: reason || undefined,
      hwnd: target.hwnd, fg: pastedResult?.fg, many: label !== '内容' }); } catch { /* 日志失败不影响粘贴。 */ }
    if (pasted) {
      return { ok: true, copied: true, pasted: true, message: name ? `已粘贴到 ${name}` : '已粘贴到刚才的窗口' };
    }
    if (alive()) { try { win.show(); win.focus(); } catch { /* 显示失败不影响已复制内容。 */ } }
    const who = name ? name.replace(/\.exe$/i, '') : '刚才那个窗口';
    const why = reason === 'no-foreground'
      ? '系统不让后台程序抢前台'
      : (reason === 'not-window' || reason === 'pid-mismatch' ? '那个窗口已经不在原来的位置了' : '');
    const message = why
      ? `没粘进 ${who}（${why}），${label}已经复制好了，按 Ctrl+V 就行`
      : `没粘进 ${who}，${label}已经复制好了，按 Ctrl+V 就行`;
    return { ok: true, copied: true, pasted: false, reason, message };
  }

  async function copyEntry(id, { paste = false } = {}) {
    const origin = win, revision = visibilityRevision;
    const parts = await payloadOf(id);
    await service.publish(parts);
    // 复制成功后才记录最近使用；发布失败不改历史。
    try { await store.touch(id); } catch { /* 最近使用不更新不影响这次复制。 */ }
    if (!paste) {
      try { await pushState(); } catch { /* 页面暂时不可达。 */ }
      hideCopiedWindow(origin, revision);
      return { ok: true, copied: true, pasted: false };
    }
    return await pasteToRecentTarget();
  }

  // 关窗请求：发出后等页面明确回执；没回执（未就绪/卡住/无监听）就走安全回退收起，
  // 不把人锁在一个关不掉的窗里。回执带请求号，晚到的旧回执不会误伤新的那一次。
  const CLOSE_ACK_TIMEOUT = 320;
  let closeRequestSeq = 0;
  let pendingClose = null;
  function settleClose(id) {
    if (!pendingClose || pendingClose.id !== id) return false;
    clearTimeout(pendingClose.timer);
    pendingClose = null;
    return true;
  }
  // 生命周期一变（显式 show/hide/销毁/窗口没了）就作废未完成的关窗请求：
  // 否则旧超时或旧 ack 会把刚又被呼出的窗口重新藏起来。
  function clearPendingClose() {
    if (!pendingClose) return;
    clearTimeout(pendingClose.timer);
    pendingClose = null;
  }
  function hideCopiedWindow(target, revision) {
    // 在途复制不能把后来重新呼出的面板藏掉；失败根本不会到这里。
    if (target && win === target && visibilityRevision === revision && alive()) hide();
  }
  function fallbackHide(target) {
    if (!target || target.isDestroyed?.() === true) return;
    try { target.hide(); } catch { return; }
    hiddenByUser = true; visibilityRevision += 1;
    notifyHidden(target);
  }

  function createWindow() {
    if (alive()) return win;
    token = randomUUID();
    const win0 = new BrowserWindow({
      show: false, width: 760, height: 640, minWidth: 560, minHeight: 460,
      frame: false, roundedCorners: true, resizable: true, backgroundColor: '#f7faf6',
      autoHideMenuBar: true, icon: iconFile,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: preloadFile }
    });
    win = win0;
    try { theme?.bind?.(win0); } catch { /* 主题不可用不影响窗口。 */ }
    win0.removeMenu?.();
    win0.on('close', event => {
      if (disposed) return;
      event.preventDefault();
      // 先问页面：预览开着就只关预览（窗口继续用）；列表状态才真正收起。
      // 回执有超时：页面未就绪/卡住/无监听时按“收起”回退，不把窗锁死。
      const id = closeRequestSeq += 1;
      clearPendingClose();
      let sent = false;
      try { win0.webContents.send('clip:close-request', id); sent = true; } catch { /* 页面不可达。 */ }
      if (!sent) { fallbackHide(win0); return; }
      const timer = setTimeout(() => {
        if (!pendingClose || pendingClose.id !== id) return;
        pendingClose = null;
        fallbackHide(win0);
      }, CLOSE_ACK_TIMEOUT);
      pendingClose = { id, timer };
    });
    win0.on('closed', () => { clearPendingClose(); if (win === win0) win = undefined; });
    win0.webContents.on('render-process-gone', () => {
      clearPendingClose();
      if (win === win0) { win = undefined; }
    });
    win0.once('ready-to-show', () => {
      if (!disposed && win === win0) { win0.show(); win0.focus(); }
      try { win0.webContents.send('clip:token', token); } catch { /* 页面尚未就绪，did-finish-load 再发。 */ }
      try { win0.webContents.send('clip:shown'); } catch { /* 忽略。 */ }
      pushState();
    });
    win0.webContents.on('did-finish-load', () => {
      try { win0.webContents.send('clip:token', token); } catch { /* 忽略。 */ }
      pushState();
    });
    win0.loadFile(rendererFile);
    return win0;
  }

  async function show() {
    if (disposed) throw new Error('剪贴板窗口已关闭');
    clearPendingClose(); visibilityRevision += 1;
    const win0 = createWindow();
    if (win0.isMinimized()) win0.restore();
    if (!win0.isVisible()) win0.show();
    win0.focus();
    hiddenByUser = false;
    try { win0.webContents.send('clip:token', token); } catch { /* 等加载完成再发。 */ }
    // 重新呼出：让页面先清掉上一次的预览（含在途请求），不残留旧大图。
    try { win0.webContents.send('clip:shown'); } catch { /* 页面暂时不可达。 */ }
    await pushState();
    return { token };
  }

  function hide() {
    if (!alive()) return false;
    clearPendingClose();
    win.hide(); visibilityRevision += 1;
    hiddenByUser = true;
    notifyHidden(win);
    return true;
  }

  // 窗口收起时告诉页面：作废在途的大图请求，不留到下一次呼出。
  function notifyHidden(target) {
    if (!target || target.isDestroyed?.() === true) return;
    try { target.webContents.send('clip:hidden'); } catch { /* 页面暂时不可达。 */ }
  }

  async function thumbOf(id) {
    if (!nativeImage) return undefined;
    const cached = thumbs.get(id);
    if (cached) { thumbs.delete(id); thumbs.set(id, cached); return cached.bytes; }
    const row = await store.get(id);
    if (!row || !row.assetHash) return undefined;
    const source = await store.readBlob(row.assetHash);
    const image = nativeImage.createFromBuffer(source);
    if (image.isEmpty()) return undefined;
    const size = image.getSize();
    if (!size.width || !size.height) return undefined;
    // 缩略图按最长边 480 生成：列表格 60px、DPR 2 要 120px，扁图（如 1462×122）
    // 用 220 宽会被 cover 放大三倍，糊成一团根本认不出是哪张。
    const longest = Math.max(size.width, size.height);
    const scale = Math.min(1, 480 / longest);
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    if (width * height > THUMB_MAX_PIXELS) return undefined;
    const bytes = image.resize({ width, height, quality: 'good' }).toPNG();
    if (bytes.length > THUMB_MAX_BYTES) return undefined;
    thumbs.set(id, { bytes, size: bytes.length });
    thumbBytes += bytes.length;
    while (thumbBytes > THUMB_MAX_BYTES && thumbs.size > 1) {
      const oldest = thumbs.keys().next().value;
      const dropped = thumbs.get(oldest);
      thumbs.delete(oldest);
      thumbBytes -= dropped?.size || 0;
    }
    return bytes;
  }

  // 看大图：宽不超过 1600、像素不超过 6M；本来就够小就原样给，不做无谓重编码。
  async function previewOf(id) {
    if (!nativeImage) return undefined;
    const cached = previews.get(id);
    if (cached) { previews.delete(id); previews.set(id, cached); return cached.bytes; }
    const row = await store.get(id);
    if (!row || !row.assetHash) return undefined;
    const source = await store.readBlob(row.assetHash);
    const image = nativeImage.createFromBuffer(source);
    if (image.isEmpty()) return undefined;
    const size = image.getSize();
    if (!size.width || !size.height) return undefined;
    let bytes;
    const pixels = size.width * size.height;
    if (size.width <= PREVIEW_MAX_WIDTH && pixels <= PREVIEW_MAX_PIXELS) {
      bytes = image.toPNG();
    } else {
      const scale = Math.min(1, PREVIEW_MAX_WIDTH / size.width, Math.sqrt(PREVIEW_MAX_PIXELS / pixels));
      const width = Math.max(1, Math.round(size.width * scale));
      const height = Math.max(1, Math.round(size.height * scale));
      bytes = image.resize({ width, height, quality: 'good' }).toPNG();
    }
    if (!bytes || !bytes.length || bytes.length > PREVIEW_MAX_BYTES) return undefined;
    previews.set(id, { bytes, size: bytes.length });
    previewBytes += bytes.length;
    while (previewBytes > PREVIEW_MAX_BYTES && previews.size > 1) {
      const oldest = previews.keys().next().value;
      const dropped = previews.get(oldest);
      previews.delete(oldest);
      previewBytes -= dropped?.size || 0;
    }
    return bytes;
  }

  // 原图：放大看细节时用。不重编码（本来就是 PNG 就原样给），受总缓存上限约束。
  const FULL_MAX_BYTES = 256 * 1024 * 1024;
  const fullCache = new Map();
  let fullBytes = 0;
  async function fullImageOf(id) {
    if (!nativeImage) return undefined;
    const cached = fullCache.get(id);
    if (cached) { fullCache.delete(id); fullCache.set(id, cached); return cached.bytes; }
    const row = await store.get(id);
    if (!row || !row.assetHash) return undefined;
    let bytes = await store.readBlob(row.assetHash);
    if (!bytes || !bytes.length) return undefined;
    // 缓存的可能是 JPEG 原件；页面只认一种格式，这里统一成 PNG。
    if (!(bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) {
      const image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) return undefined;
      bytes = image.toPNG();
    }
    if (bytes.length > FULL_MAX_BYTES) return undefined;
    fullCache.set(id, { bytes, size: bytes.length });
    fullBytes += bytes.length;
    while (fullBytes > FULL_MAX_BYTES && fullCache.size > 1) {
      const oldest = fullCache.keys().next().value;
      const dropped = fullCache.get(oldest);
      fullCache.delete(oldest);
      fullBytes -= dropped?.size || 0;
    }
    return bytes;
  }

  // —— 窄 IPC ——
  wrap('clip:state', async () => stateOf());
  wrap('clip:list', payload => store.list({
    query: typeof payload.query === 'string' ? payload.query : undefined,
    kind: typeof payload.kind === 'string' ? payload.kind : undefined,
    source: typeof payload.source === 'string' ? payload.source : undefined,
    favorite: payload.favorite === true,
    tag: typeof payload.tag === 'string' ? payload.tag : undefined,
    page: Number.isInteger(payload.page) ? payload.page : 1
  }));
  wrap('clip:get', async payload => {
    if (!Number.isInteger(payload.id)) throw new Error('记录标识无效');
    const row = await store.get(payload.id);
    if (!row) return row;
    // 文件条目只记路径：源文件没了就明说失效，不假装附件可用。
    if (row.files && row.files.length) {
      const fsModule = require('node:fs');
      row.missingFiles = row.files.filter(file => { try { return !fsModule.statSync(file).isFile(); } catch { return true; } });
    }
    return row;
  });
  wrap('clip:copy-many', payload => copyMany(Array.isArray(payload.ids) ? payload.ids : [],
    { paste: payload.paste === true }));
  wrap('clip:copy', payload => {
    if (!Number.isInteger(payload.id)) throw new Error('记录标识无效');
    return copyEntry(payload.id, { paste: false });
  });
  wrap('clip:paste', payload => {
    if (!Number.isInteger(payload.id)) throw new Error('记录标识无效');
    return copyEntry(payload.id, { paste: true });
  });
  wrap('clip:favorite', payload => {
    if (!Number.isInteger(payload.id) || typeof payload.value !== 'boolean') throw new Error('收藏参数无效');
    return store.setFavorite(payload.id, payload.value);
  });
  wrap('clip:note', payload => {
    if (!Number.isInteger(payload.id) || typeof payload.text !== 'string' || payload.text.length > 4000) throw new Error('备注无效');
    return store.setNote(payload.id, payload.text);
  });
  wrap('clip:tags', payload => {
    if (!Number.isInteger(payload.id) || !Array.isArray(payload.tags) || payload.tags.length > 20) throw new Error('标签无效');
    return store.setTags(payload.id, payload.tags);
  });
  wrap('clip:pinned', payload => {
    if (!Number.isInteger(payload.id) || typeof payload.value !== 'boolean') throw new Error('置顶参数无效');
    return store.setPinned(payload.id, payload.value);
  });
  // 批注组列表：只给标题/修订/更新时间，不把组文档塞进列表。
  wrap('clip:groups', () => store.listGroups());
  wrap('clip:open-group', payload => {
    if (typeof payload.groupId !== 'string' || !payload.groupId) throw new Error('组标识无效');
    if (typeof onOpenGroup !== 'function') throw new Error('工作台还没准备好');
    return onOpenGroup(payload.groupId);
  });
  wrap('clip:thumb', async payload => {
    if (!Number.isInteger(payload.id)) throw new Error('记录标识无效');
    return thumbOf(payload.id) || null;
  });
  wrap('clip:image', async payload => {
    if (!Number.isInteger(payload.id)) throw new Error('记录标识无效');
    return previewOf(payload.id) || null;
  });
  // 原图只在用户真放大时才要，所以单独一条，不合进预览缓存。
  wrap('clip:image-full', async payload => {
    if (!Number.isInteger(payload.id)) throw new Error('记录标识无效');
    return fullImageOf(payload.id) || null;
  });
  // 送去编辑页：图进去之前先把窗口收起，编辑页关掉时由 index 把这里叫回来。
  wrap('clip:open-editor', async payload => {
    if (!Number.isInteger(payload.id)) throw new Error('记录标识无效');
    if (typeof openEditor !== 'function') throw new Error('这个版本还不能编辑剪贴板图片');
    const bytes = await fullImageOf(payload.id);
    if (!bytes || !bytes.length) throw new Error('这张图读不出来，可能原件已经不在了');
    hide();
    try { return await openEditor(bytes); }
    catch (error) { show(); throw error; }
  });
  wrap('clip:remove', payload => {
    if (!Number.isInteger(payload.id)) throw new Error('记录标识无效');
    return store.removeHistory(payload.id);
  });
  wrap('clip:stats', () => store.stats());
  wrap('clip:cleanup-preview', async () => {
    const clipboard = settings.getClipboard();
    try { return await store.cleanup({ retentionDays: clipboard.retentionDays, maxHistoryItems: clipboard.maxHistoryItems,
      maxStorageBytes: clipboard.maxStorageBytes, dryRun: true }); }
    catch (error) { throw new Error(`清理预检失败：${error?.message || error}`); }
  });
  wrap('clip:cleanup', async () => {
    const clipboard = settings.getClipboard();
    // 只有明确确认过范围才真删；预检数字与这里用的是同一份设置。
    const result = await store.cleanup({ retentionDays: clipboard.retentionDays, maxHistoryItems: clipboard.maxHistoryItems,
      maxStorageBytes: clipboard.maxStorageBytes });
    await pushState();
    return result;
  });
  wrap('clip:update-clipboard', async payload => {
    const patch = payload.patch;
    if (!patch || typeof patch !== 'object') throw new Error('设置参数无效');
    const clipboard = settings.updateClipboard(patch, { strict: true });
    try { service?.setExcludedApps?.(clipboard.excludedApps); } catch { /* 排除列表下次启动同样生效。 */ }
    await pushState();
    return clipboard;
  });
  // 首次开启/暂停/继续：只改持久开关，真实监听由主进程按状态启动或退订。
  wrap('clip:set-enabled', async payload => {
    if (typeof payload.enabled !== 'boolean') throw new Error('开关参数无效');
    const clipboard = settings.updateClipboard({ enabled: payload.enabled, paused: false }, { strict: true });
    if (typeof onStatus === 'function') onStatus({ clipboardChanged: true });
    await pushState();
    return clipboard;
  });
  wrap('clip:set-paused', async payload => {
    if (typeof payload.paused !== 'boolean') throw new Error('暂停参数无效');
    const clipboard = settings.updateClipboard({ paused: payload.paused }, { strict: true });
    if (typeof onStatus === 'function') onStatus({ clipboardChanged: true });
    await pushState();
    return clipboard;
  });
  wrap('clip:open-workspace', payload => {
    if (typeof onOpenWorkspace !== 'function') throw new Error('工作台还没准备好');
    const ids = Array.isArray(payload.ids) ? payload.ids.filter(item => Number.isInteger(item)) : [];
    return onOpenWorkspace(ids);
  });
  wrap('clip:hide', () => hide());
  // 页面收到关窗请求后的回执：stay=预览已关、窗口留着；hide=可以收起窗口。
  wrap('clip:close-ack', payload => {
    const id = Number(payload?.id);
    if (!Number.isInteger(id)) throw new Error('关窗回执无效');
    const settled = settleClose(id);
    if (!settled) return { applied: false };
    if (payload?.action === 'hide') { hide(); return { applied: true, action: 'hide' }; }
    return { applied: true, action: 'stay' };
  });

  return {
    show, hide, pushState,
    isVisible: () => Boolean(alive() && win.isVisible()),
    token: () => token,
    state: stateOf,
    getWindow: () => win,
    dispose: () => {
      disposed = true;
      clearPendingClose();
      token = undefined;
      if (alive()) { try { win.destroy(); } catch { /* 已销毁。 */ } }
      win = undefined;
    }
  };
}

module.exports = { installClipboardWindow };
