'use strict';
/* 跨图批注工作台：一窗一组，普通窗口，独立于截图编辑宿主。
   主进程持有权威组文档、原件尺寸表与导出计划；页面只拿当前组授权内的 PNG 字节。
   导出走 shot:workspace-export-*，不套用旧图片文档 token，也不占 MAX_HOSTS。 */

const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const AnnotationGroup = require('../core/annotation-group.js');

const LOAD_TIMEOUT_MS = 8000;
const MIN_SIZE = { width: 860, height: 600 };
const MAX_SIZE = { width: 1400, height: 940 };
const WORK_RATIO = 0.92;
const COPIES_CACHE_BYTES = AnnotationGroup.LIMITS.copyCacheBytes;
const EXPORT_TIMEOUT_MS = 30000;
const IMAGE_BYTES = AnnotationGroup.LIMITS.imageBytes;
const TEXT_BYTES = AnnotationGroup.LIMITS.textBytes;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// 跨进程交来的二进制：Buffer、Uint8Array、ArrayBuffer 都归一成同视图的只读 Buffer。
// 不认字符串/数字/普通对象；带非零 byteOffset 的子视图必须按实际范围取。
function toBufferBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}

// 只读 PNG 头：签名 + IHDR。页面声明的尺寸一律不信，以这里为准。
function pngHeader(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33) return undefined;
  if (!Buffer.isBuffer(bytes) || bytes.length < 33) return undefined;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let index = 0; index < signature.length; index++) if (bytes[index] !== signature[index]) return undefined;
  if (bytes.readUInt32BE(8) !== 13) return undefined;
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!(width > 0) || !(height > 0)) return undefined;
  return { width, height };
}

// 默认两列摆开，留出连线与文字空间；图块只是摆位，不重采样原件。
// 每列宽度固定，按图自身长宽比等比缩到列宽；一列超过 1400 逻辑像素就换下一列。
function layoutFrames(images) {
  const GAP_X = 80, GAP_Y = 90, COL_W = 520, MAX_COL_H = 1400;
  const columns = [0, 0];
  let col = 0;
  return images.map(image => {
    const scale = Math.min(COL_W / image.width, 1);
    const width = Math.max(1, Math.round(image.width * scale * 100) / 100);
    const height = Math.max(1, Math.round(image.height * scale * 100) / 100);
    if (col === 0 && columns[0] > 0 && columns[0] + height > MAX_COL_H) col = 1;
    const frame = { x: col * (COL_W + GAP_X), y: columns[col], width, height };
    columns[col] += height + GAP_Y;
    return frame;
  });
}

function initialBounds(screen) {
  let area = { x: 0, y: 0, width: 1280, height: 800 };
  try { area = screen.getPrimaryDisplay().workArea || area; } catch { /* 无屏幕信息时用默认。 */ }
  const width = clamp(Math.floor(area.width * WORK_RATIO), Math.min(MIN_SIZE.width, area.width), Math.min(MAX_SIZE.width, area.width));
  const height = clamp(Math.floor(area.height * WORK_RATIO), Math.min(MIN_SIZE.height, area.height), Math.min(MAX_SIZE.height, area.height));
  return { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2),
    width, height, minWidth: Math.min(MIN_SIZE.width, width), minHeight: Math.min(MIN_SIZE.height, height) };
}

function installWorkspaceWindow({ BrowserWindow, ipcMain, screen, dialog, theme, rendererFile, preloadFile, iconFile,
  store, service, settings, onStatus, exportRoot, now = () => new Date(), limits = {}, showWindow = true,
  // 写盘可注入：只为测试把“写在途”做成可控时序，生产默认仍是 fs.promises.writeFile。
  writeFile = (file, bytes, options) => fs.promises.writeFile(file, bytes, options) } = {}) {
  // groupId → 记录；一窗一组，同组再打开只聚焦。
  const records = new Map();
  let disposed = false;
  const note = fields => { try { onStatus?.(fields); } catch { /* 状态提示失败不影响工作台。 */ } };

  function recordOfSender(event) {
    if (!event || !event.sender) return undefined;
    for (const record of records.values()) {
      const win = record.win;
      if (win && win.isDestroyed() !== true && event.sender === win.webContents) {
        if (win.webContents.mainFrame && event.senderFrame !== win.webContents.mainFrame) return undefined;
        return record;
      }
    }
    return undefined;
  }

  function wrap(name, handler) {
    ipcMain.handle(name, async (event, payload = {}) => {
      const record = recordOfSender(event);
      if (!record) throw new Error('工作台窗口已失效');
      const supplied = payload && typeof payload === 'object' ? payload.token : undefined;
      if (supplied !== record.token) throw new Error('工作台窗口已失效');
      const { token: _token, ...rest } = payload || {};
      return handler(record, rest);
    });
  }

  function stateOf(record) {
    const group = record.group;
    return {
      groupId: group.id, title: group.title, revision: record.revision,
      document: JSON.parse(JSON.stringify(group)),
      saving: Boolean(record.saving), saveFailed: Boolean(record.saveFailed),
      lastSavedAt: record.lastSavedAt || 0,
      images: group.images.map(image => ({ id: image.id, name: image.name, assetHash: image.assetHash, width: image.width, height: image.height }))
    };
  }

  function pushState(record) {
    const win = record.win;
    if (!win || win.isDestroyed() === true) return;
    try { win.webContents.send('ws:state', stateOf(record)); } catch { /* 页面暂时不可达。 */ }
  }

  async function assetSizesOf(group) {
    const hashes = [...new Set(group.images.map(image => image.assetHash))];
    const table = await store.assetSizes(hashes);
    for (const hash of hashes) {
      if (!table[hash]) throw new Error('组里有图片的原件已不可读，拒绝继续');
    }
    return table;
  }

  async function loadGroupDocument(groupId) {
    const row = await store.getGroup(groupId);
    if (!row) throw new Error('这个批注组已经不在了');
    const raw = JSON.parse(row.document);
    const sizes = await assetSizesOf(raw);
    const group = AnnotationGroup.validate(raw, { assetSizes: sizes });
    return { group: { ...group, revision: row.revision }, sizes, revision: row.revision };
  }

  // 选中的历史图 → 新组：至少 2 张、最多 16 张，全部必须是图片与可读原件。
  async function createFromEntries(entryIds) {
    const ids = [...new Set((Array.isArray(entryIds) ? entryIds : []).filter(value => Number.isInteger(value) && value > 0))];
    if (ids.length < 2) throw new Error('至少选两张图片才能一起批注');
    if (ids.length > AnnotationGroup.LIMITS.images) throw new Error(`一组最多 ${AnnotationGroup.LIMITS.images} 张图`);
    const images = [];
    for (const id of ids) {
      const row = await store.get(id);
      if (!row) throw new Error('选中的记录已经不在了，刷新一下再试');
      if (row.kind !== 'image' || !row.assetHash) throw new Error('只有静态图片能进批注组');
      if (!Number.isInteger(row.width) || !Number.isInteger(row.height)) throw new Error('这张图还没有可用的尺寸信息');
      images.push({ assetHash: row.assetHash, width: row.width, height: row.height, name: `图${images.length + 1}` });
    }
    const frames = layoutFrames(images);
    const stamp = now();
    const group = AnnotationGroup.createGroup({
      id: `group_${stamp.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      title: `批注组-${AnnotationGroup.formatStamp(stamp)}`,
      images: images.map((image, index) => ({
        id: randomUUID().replace(/-/g, '').slice(0, 24),
        assetHash: image.assetHash, name: image.name,
        width: image.width, height: image.height,
        frame: frames[index], masks: []
      }))
    });
    const sizes = await assetSizesOf(group);
    const validated = AnnotationGroup.validate(group, { assetSizes: sizes });
    const saved = await store.saveGroup({ id: validated.id, revision: 0, document: JSON.stringify(validated),
      assetHashes: [...new Set(validated.images.map(image => image.assetHash))] });
    return { group: { ...validated, revision: saved.revision }, sizes, revision: saved.revision };
  }

  async function pinGroup(record) {
    const hashes = [...new Set(record.group.images.map(image => image.assetHash))];
    for (const hash of hashes) {
      try { await store.pin(record.token, hash, 'workspace'); } catch { /* pin 失败不挡打开。 */ }
    }
  }

  function createWindow(record) {
    const bounds = initialBounds(screen);
    const win0 = new BrowserWindow({
      show: false, ...bounds, frame: true, roundedCorners: true, resizable: true,
      minimizable: true, maximizable: true, closable: true,
      // 与普通图片编辑窗一致：标题栏交给系统绘制，右上角就是最小化/最大化/关闭。
      titleBarStyle: 'hidden', titleBarOverlay: { color: '#e6f1e9', symbolColor: '#244e43', height: 36 },
      backgroundColor: '#f7faf6', autoHideMenuBar: true, icon: iconFile,
      title: record.group.title,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: preloadFile,
        additionalArguments: [`--ws-token=${record.token}`] }
    });
    record.win = win0;
    record.closing = false;
    try { theme?.bind?.(win0, { titleBarOverlay: true }); } catch { /* 主题不可用不影响窗口。 */ }
    win0.removeMenu?.();
    win0.on('close', event => {
      if (record.closing) return;
      // 还有没落定的修改：先让页面确认，不静默丢稿；页面不可达时不要把人锁在窗里。
      // 只有草稿（标好位置、还没写说明）也提示一次，但页面会说明“可以带草稿关”，不逼人填字。
      const drafts = (() => {
        try { return AnnotationGroup.pendingOf(record.group).length; } catch { return 0; }
      })();
      if (record.dirty === true || drafts > 0) {
        try {
          win0.webContents.send('ws:close-request');
          event.preventDefault();
        } catch { /* 页面已不可达：直接允许关闭。 */ }
      }
    });
    win0.on('closed', () => {
      if (record.win === win0) record.win = undefined;
      releaseRecord(record);
    });
    win0.webContents.on('render-process-gone', () => {
      if (record.win === win0) record.win = undefined;
      releaseRecord(record);
    });
    win0.once('ready-to-show', () => {
      if (record.win !== win0) return;
      // 隐藏验收不弹窗；生产默认照常显示。
      if (showWindow) { win0.show(); win0.focus(); }
    });
    win0.webContents.on('did-finish-load', () => {
      try { win0.webContents.send('ws:token', record.token); } catch { /* 忽略。 */ }
      pushState(record);
    });
    win0.loadFile(rendererFile);
    return win0;
  }

  async function show(record) {
    if (record.win && record.win.isDestroyed() !== true) {
      if (record.win.isMinimized()) record.win.restore();
      record.win.show();
      record.win.focus();
      pushState(record);
      return { groupId: record.group.id };
    }
    createWindow(record);
    return { groupId: record.group.id };
  }

  async function openFromEntries(entryIds) {
    if (disposed) throw new Error('工作台还没准备好');
    const created = await createFromEntries(entryIds);
    const record = { groupId: created.group.id, token: randomUUID(), group: created.group,
      revision: created.revision, sizes: created.sizes, dirty: false, saving: false, saveFailed: false,
      lastSavedAt: 0, export: undefined, releasing: false };
    records.set(record.groupId, record);
    await pinGroup(record);
    await show(record);
    note({ workspaceOpened: record.groupId });
    return { groupId: record.groupId, token: record.token };
  }

  async function openGroup(groupId) {
    if (disposed) throw new Error('工作台还没准备好');
    if (typeof groupId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(groupId)) throw new Error('组标识无效');
    const existing = records.get(groupId);
    if (existing) return show(existing);
    const loaded = await loadGroupDocument(groupId);
    const record = { groupId, token: randomUUID(), group: loaded.group, revision: loaded.revision,
      sizes: loaded.sizes, dirty: false, saving: false, saveFailed: false, lastSavedAt: 0, export: undefined };
    records.set(groupId, record);
    await pinGroup(record);
    await show(record);
    return { groupId, token: record.token };
  }

  function releaseRecord(record) {
    if (!record || record.releasing) return;
    record.releasing = true;
    records.delete(record.groupId);
    const owner = record.token;
    cancelExport(record, '窗口已关闭');
    Promise.resolve(store.release(owner)).catch(() => {});
  }

  // —— 保存 ——
  async function save(record, payload) {
    if (record.saving) throw new Error('上一次保存还没完成');
    const baseRevision = payload.baseRevision;
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new Error('保存修订号无效');
    // 页面交的基线必须就是本窗口已知的版本：不拿旧稿盖新稿。
    if (baseRevision !== record.revision) throw new Error('这个批注组已经在别处更新过，请重新打开');
    const raw = payload.document;
    if (!raw || typeof raw !== 'object') throw new Error('组文档无效');
    if (raw.id !== record.groupId) throw new Error('组文档与窗口不一致');
    const sizes = record.sizes;
    // 新加进来的图（同组复制粘贴现有图除外）必须先有权威尺寸；不允许页面自带尺寸蒙混。
    for (const image of Array.isArray(raw.images) ? raw.images : []) {
      if (!image || typeof image.assetHash !== 'string') throw new Error('组文档里有无效图片');
      if (!sizes[image.assetHash]) throw new Error('组文档引用了当前组之外的原件');
    }
    // 保存也是版本高水位：本窗口已经落过第 2 版，旧稿回泻也不把它拉回第 1 版。
    const group = AnnotationGroup.validate(AnnotationGroup.keepVersion(raw, record.group), { assetSizes: sizes });
    record.saving = true;
    record.saveFailed = false;
    try {
      const result = await store.saveGroup({
        id: group.id, revision: record.revision, document: JSON.stringify(group),
        assetHashes: [...new Set(group.images.map(image => image.assetHash))]
      });
      record.group = { ...group, revision: result.revision };
      record.revision = result.revision;
      record.lastSavedAt = Date.now();
      record.dirty = false;
      pushState(record);
      return { revision: result.revision, savedAt: record.lastSavedAt };
    } catch (error) {
      record.saveFailed = true;
      record.dirty = true;
      pushState(record);
      throw error;
    } finally {
      record.saving = false;
    }
  }

  // —— 导出计划 ——
  async function beginExport(record, kind) {
    if (record.export) throw new Error('上一次导出还没结束');
    if (!service || typeof service.publish !== 'function') throw new Error('当前不能发布到剪贴板');
    if (kind !== 'copy' && kind !== 'save' && kind !== 'contact') throw new Error('导出方式无效');
    const isContact = kind === 'contact';
    // 先同步占位：两个 begin 并发时第二个立刻被拒，不会各建一套 targetDir。
    const state = { token: randomUUID(), kind, plan: undefined, targetDir: undefined,
      written: [], bytes: 0, reservedBytes: 0, inflight: new Set(), state: 'preparing', expected: 0, batchLimit: 0 };
    record.export = state;
    try {
      // 冻结当前落库版本：不拿页面草稿当导出源，避免混两个编辑版本。
      const loaded = await loadGroupDocument(record.groupId);
      const plan = AnnotationGroup.planExport(loaded.group, loaded.sizes, { now: now() });
      let directory;
      if (kind === 'save' && typeof dialog?.showOpenDialog === 'function') {
        const win = record.win && record.win.isDestroyed() !== true ? record.win : undefined;
        const picked = await dialog.showOpenDialog(win, { title: '保存整组批注图片', buttonLabel: '用这个文件夹',
          properties: ['openDirectory', 'createDirectory'] });
        if (!picked || picked.canceled || !picked.filePaths?.[0]) {
          if (record.export === state) record.export = undefined;
          return { canceled: true };
        }
        directory = picked.filePaths[0];
      }
      const batchId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      // 对照图不落盘：一张 PNG + 一段文字直接交给剪贴板。
      let targetDir = isContact ? exportRoot
        : (kind === 'save' ? path.join(directory, `截个图批注-${AnnotationGroup.formatStamp(now())}`) : path.join(exportRoot, batchId));
      if (kind === 'save') {
        // 用户选的目录必须在；子目录用 wx 语义建，同一秒重复保存也绝不覆盖别人。
        await fs.promises.mkdir(directory, { recursive: true });
        try { await fs.promises.mkdir(targetDir, { recursive: false }); }
        catch (error) {
          if (error?.code !== 'EEXIST') throw error;
          targetDir = path.join(directory, `截个图批注-${AnnotationGroup.formatStamp(now())}-${randomUUID().slice(0, 4)}`);
          await fs.promises.mkdir(targetDir, { recursive: false });
        }
      }
      else if (!isContact) await fs.promises.mkdir(targetDir, { recursive: true });
      // 批次额度：默认按计划里的复制/保存两套预算；测试可注入小值真实触发。
      const batchLimit = kind === 'save'
        ? (Number.isSafeInteger(limits.saveBatchBytes) ? limits.saveBatchBytes : plan.budgets.saveBatchBytes)
        : (Number.isSafeInteger(limits.copyBatchBytes) ? limits.copyBatchBytes : plan.budgets.copyBatchBytes);
      // 目录建好之前被取消（或已换了批次）：不再写任何文件。
      if (record.export !== state) throw new Error('这次导出已经结束');
      const files = isContact ? [{ index: 0, name: '对照.png' }] : plan.files;
      state.plan = { ...plan, files };
      state.targetDir = targetDir;
      state.expected = isContact ? 1 : plan.images.length + 1;
      state.batchLimit = batchLimit;
      state.state = 'writing';
      record.group = loaded.group;
      record.revision = loaded.revision;
      const hashes = [...new Set(loaded.group.images.map(image => image.assetHash))];
      for (const hash of hashes) { try { await store.pin(state.token, hash, 'export'); } catch { /* 组引用已保护。 */ } }
      if (record.export !== state) throw new Error('这次导出已经结束');
      return {
        token: state.token, kind,
        plan: { ...state.plan, notesText: undefined },
        files: state.plan.files, modes: plan.modes,
        limits: { imageBytes: IMAGE_BYTES, copyBatchBytes: plan.budgets.copyBatchBytes, saveBatchBytes: plan.budgets.saveBatchBytes, textBytes: TEXT_BYTES }
      };
    } catch (error) {
      if (record.export === state) record.export = undefined;
      releaseExportPins(state);
      throw error;
    }
  }

  // 复制缓存总占用：清理与发布都不静默淘汰旧批次，只统计后拒绝；本批已算进 state.bytes 的不重复统计。
  function cacheBytes(excludeDir) {
    let total = 0;
    const walk = dir => {
      let items;
      try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const item of items) {
        const full = path.join(dir, item.name);
        if (excludeDir && path.resolve(full) === path.resolve(excludeDir)) continue;
        if (item.isDirectory()) walk(full);
        else { try { total += fs.statSync(full).size; } catch { /* 文件可能刚消失。 */ } }
      }
    };
    walk(exportRoot);
    return total;
  }

  // 缓存文件数（与字节分开算）：4096 个文件的上限也包含本批。
  function cacheFiles(excludeDir) {
    let total = 0;
    const walk = dir => {
      let items;
      try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const item of items) {
        const full = path.join(dir, item.name);
        if (excludeDir && path.resolve(full) === path.resolve(excludeDir)) continue;
        if (item.isDirectory()) walk(full);
        else total += 1;
      }
    };
    walk(exportRoot);
    return total;
  }

  function indexOfFile(plan, index) {
    // 对照图只有一张：尺寸取 planner 算好的拼合画布。
    if (plan.files.length === 1 && plan.sheet) {
      return { name: plan.files[0].name, width: plan.sheet.width, height: plan.sheet.height };
    }
    const expected = index === 0
      ? { name: plan.files[0].name, width: plan.overview.width, height: plan.overview.height }
      : (() => {
          const image = plan.images[index - 1];
          if (!image) return undefined;
          return { name: plan.files[index].name, width: image.width, height: image.height };
        })();
    return expected;
  }

  async function exportPart(record, payload) {
    const state = record.export;
    if (!state) throw new Error('没有正在进行的导出');
    if (payload.batch !== state.token) throw new Error('这次导出已经结束');
    if (state.state !== 'writing') throw new Error('这次导出已经结束');
    const index = payload.index;
    if (!Number.isInteger(index) || index < 0 || index >= state.expected) throw new Error('导出序号无效');
    // 页面经 contextBridge/IPC 交来的可能是 Buffer、Uint8Array 或 ArrayBuffer；
    // 先按类型与大小归一成只读 Buffer，再做 IHDR 精确尺寸校验（不因为兼容放宽像素闸）。
    const bytes = toBufferBytes(payload.bytes);
    if (!bytes || !bytes.length) throw new Error('导出的图片为空');
    if (bytes.length > (Number.isSafeInteger(limits.imageBytes) ? limits.imageBytes : IMAGE_BYTES)) throw new Error('单张图片超过 148MiB');
    if (state.plan.files[index] === undefined) throw new Error('导出文件名无效');
    const expected = indexOfFile(state.plan, index);
    if (!expected) throw new Error('导出序号超出计划');
    const header = pngHeader(bytes);
    // 主进程只认自己计划里的精确尺寸，不接受页面宣称的 width/height。
    if (!header || header.width !== expected.width || header.height !== expected.height) {
      throw new Error(`第 ${index + 1} 张的尺寸与导出计划不一致，已停止`);
    }
    if (state.inflight.has(index)) throw new Error('这一张正在写入，不能重复提交');
    if (state.written.some(item => item.index === index)) throw new Error('这一张已经写过');
    // 对照图只活在内存里：不建目录、不写盘，发布失败也不留垃圾。
    if (state.kind === 'contact') {
      state.inflight.add(index);
      state.sheetBytes = bytes;
      state.inflight.delete(index);
      state.written.push({ index, file: '', bytes: bytes.length });
      state.bytes += bytes.length;
      if (record.export !== state || state.state !== 'writing') throw new Error('导出已取消');
      return { index, written: 1, expected: 1 };
    }
    const batchLimit = state.batchLimit ?? (state.kind === 'copy' ? state.plan.budgets.copyBatchBytes : state.plan.budgets.saveBatchBytes);
    // 额度先预留再写：两个并发 part 不能各自看到“还有空间”而双花。
    const used = state.bytes + state.reservedBytes;
    if (used + bytes.length > batchLimit) {
      throw new Error(state.kind === 'copy'
        ? '这组图片较大，请保存整组后发送'
        : '整组超过 3GiB 上限，已停止');
    }
    const cacheBytesLimit = Number.isSafeInteger(limits.copyCacheBytes) ? limits.copyCacheBytes : COPIES_CACHE_BYTES;
    const cacheFilesLimit = Number.isSafeInteger(limits.copyCacheFiles) ? limits.copyCacheFiles : 4096;
    if (state.kind === 'copy' && cacheBytes(state.targetDir) + used + bytes.length > cacheBytesLimit) {
      throw new Error('复制缓存已满，请保存整组后发送');
    }
    if (state.kind === 'copy' && cacheFiles(state.targetDir) + state.written.length + state.inflight.size + 1 > cacheFilesLimit) {
      throw new Error('复制缓存文件数已满，请保存整组后发送');
    }
    state.inflight.add(index);
    state.reservedBytes += bytes.length;
    const file = path.join(state.targetDir, expected.name);
    try {
      await writeFile(file, bytes, { flag: 'wx' });
    } catch (error) {
      state.inflight.delete(index);
      state.reservedBytes -= bytes.length;
      throw error;
    }
    state.inflight.delete(index);
    state.reservedBytes -= bytes.length;
    state.written.push({ index, file, bytes: bytes.length });
    state.bytes += bytes.length;
    // 写盘期间被取消：文件留着，数量如实报；不再接后续段。
    if (record.export !== state || state.state !== 'writing') throw new Error('导出已取消，已写的文件保留');
    return { index, written: state.written.length, expected: state.expected };
  }

  async function exportDone(record, payload) {
    const state = record.export;
    if (!state) throw new Error('没有正在进行的导出');
    if (payload.batch !== state.token) throw new Error('这次导出已经结束');
    if (state.state !== 'writing') throw new Error('这次导出已经结束');
    if (state.inflight.size) throw new Error('还有图片正在写入');
    if (state.written.length !== state.expected) throw new Error(`还差 ${state.expected - state.written.length} 张没有交上来`);
    const text = state.plan.notesText;
    const textSize = Buffer.byteLength(text);
    if (textSize > TEXT_BYTES) throw new Error('说明文本超过 1MiB');
    // 对照：一张拼合图 + 一段对应说明，一次进剪贴板，接收方粘一次就同时拿到图和字。
    if (state.kind === 'contact') {
      const pngBytes = state.sheetBytes;
      if (!Buffer.isBuffer(pngBytes) || !pngBytes.length) throw new Error('对照图没有交上来');
      const textBytes = Buffer.concat([Buffer.from(text, 'utf16le'), Buffer.from([0, 0])]);
      state.state = 'publishing';
      try {
        const published = await service.publish([{ format: 'png', bytes: pngBytes }, { format: 'text', bytes: textBytes }]);
        if (published?.ok !== true) throw new Error('剪贴板没有接收对照图');
        state.state = 'done';
        record.export = undefined;
        releaseExportPins(state);
        note({ workspaceExport: 'contact', files: 1 });
        return { ok: true, kind: 'contact', written: 1, pasted: false };
      } catch (error) {
        state.state = 'failed';
        record.export = undefined;
        releaseExportPins(state);
        throw error;
      }
    }
    // 说明.txt 也是输出的一部分：计入整批字节与缓存文件数（否则 17 张刚好满额时能越界）。
    const batchLimit = state.batchLimit ?? (state.kind === 'copy' ? state.plan.budgets.copyBatchBytes : state.plan.budgets.saveBatchBytes);
    if (state.bytes + textSize > batchLimit) throw new Error(state.kind === 'copy' ? '这组图片较大，请保存整组后发送' : '整组超过 3GiB 上限，已停止');
    const cacheBytesLimit = Number.isSafeInteger(limits.copyCacheBytes) ? limits.copyCacheBytes : COPIES_CACHE_BYTES;
    const cacheFilesLimit = Number.isSafeInteger(limits.copyCacheFiles) ? limits.copyCacheFiles : 4096;
    if (state.kind === 'copy' && cacheBytes(state.targetDir) + state.bytes + textSize > cacheBytesLimit) throw new Error('复制缓存已满，请保存整组后发送');
    if (state.kind === 'copy' && cacheFiles(state.targetDir) + state.written.length + state.inflight.size + 1 > cacheFilesLimit) throw new Error('复制缓存文件数已满，请保存整组后发送');
    const textFile = path.join(state.targetDir, state.plan.textFile);
    // finalizing：正在写 TXT，还可以取消；publishing：已交给系统发布，不可撤回。
    if (record.export !== state || state.state !== 'writing') throw new Error('这次导出已经结束');
    state.state = 'finalizing';
    try {
      await writeFile(textFile, text, { flag: 'wx' });
    } catch (error) {
      state.state = 'failed';
      if (record.export === state) record.export = undefined;
      releaseExportPins(state);
      throw error;
    }
    const ordered = [...state.written].sort((a, b) => a.index - b.index).map(item => item.file);
    const files = [...ordered, textFile];
    // TXT 写完到真正发布之间再核一次：这期间被取消就不发。
    if (record.export !== state || state.state !== 'finalizing') {
      state.state = 'aborted';
      if (record.export === state) record.export = undefined;
      releaseExportPins(state);
      throw new Error('这次导出已经结束');
    }
    if (state.kind === 'save') {
      state.state = 'done';
      record.export = undefined;
      releaseExportPins(state);
      note({ workspaceExport: 'save', files: files.length });
      return { ok: true, kind: 'save', written: state.written.length, directory: state.targetDir };
    }
    state.state = 'publishing';
    if (record.export !== state || state.state !== 'publishing') {
      state.state = 'aborted';
      record.export = undefined;
      releaseExportPins(state);
      throw new Error('这次导出已经结束');
    }
    try {
      // 发布前一瞬再核一次归属与终态；发布中不允许 abort 把批次改成“已取消”。
      const published = await service.publish([{ format: 'files', paths: files }]);
      if (published?.ok !== true) throw new Error('剪贴板没有接收整组文件');
      state.state = 'done';
      record.export = undefined;
      releaseExportPins(state);
      note({ workspaceExport: 'copy', files: files.length });
      return { ok: true, kind: 'copy', written: state.written.length, pasted: false };
    } catch (error) {
      // 已发布的旧批次不删；这一批未发布成功，登记为失败并保留文件，由使用者决定清理。
      state.state = 'failed';
      record.export = undefined;
      releaseExportPins(state);
      throw error;
    }
  }

  function releaseExportPins(state) {
    if (!state || state.released) return;
    state.released = true;
    Promise.resolve(store.release(state.token)).catch(() => {});
  }

  function cancelExport(record, reason) {
    const state = record.export;
    if (!state) return { ok: true };
    // 已经交给系统发布：不能承诺撤回，如实说“取消没生效”。
    if (state.state === 'publishing') {
      return { ok: false, published: true, message: '已经开始发布，这次取消没有生效' };
    }
    state.state = 'aborted';
    record.export = undefined;
    releaseExportPins(state);
    return { ok: true, written: state.written.length, message: reason || '导出已取消' };
  }

  // 复制说明：内容由 main 生成，不接收页面文本。
  // text 负载按 CF_UNICODETEXT 契约发：UTF-16LE + 终止符，与原生捕获/发布一致。
  async function copyNotes(record) {
    const loaded = await loadGroupDocument(record.groupId);
    const plan = AnnotationGroup.planExport(loaded.group, loaded.sizes, { now: now() });
    const bytes = Buffer.concat([Buffer.from(plan.notesText, 'utf16le'), Buffer.from([0, 0])]);
    if (bytes.length > TEXT_BYTES) throw new Error('说明文本超过 1MiB');
    await service.publish([{ format: 'text', bytes }]);
    return { ok: true };
  }

  // —— IPC ——
  wrap('shot:workspace-state', record => stateOf(record));
  wrap('shot:workspace-asset', async (record, payload) => {
    const hash = payload.assetHash;
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new Error('图片指纹无效');
    // 只允许当前组持有的原件：不能凭猜 hash 跨组读私有库。
    if (!record.group.images.some(image => image.assetHash === hash)) throw new Error('这张图不属于当前批注组');
    const bytes = await store.readBlob(hash);
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error('原图已不可读');
    return bytes;
  });
  wrap('shot:workspace-save', (record, payload) => save(record, payload));
  wrap('shot:workspace-dirty', (record, payload) => {
    record.dirty = payload.dirty === true;
    return { dirty: record.dirty };
  });
  wrap('shot:workspace-force-close', (record) => {
    record.closing = true;
    if (record.win && record.win.isDestroyed() !== true) record.win.close();
    return { ok: true };
  });
  wrap('shot:workspace-export-begin', (record, payload) => beginExport(record, payload.kind));
  wrap('shot:workspace-export-part', (record, payload) => exportPart(record, payload));
  wrap('shot:workspace-export-done', (record, payload) => exportDone(record, payload));
  wrap('shot:workspace-export-abort', (record, payload) => {
    const state = record.export;
    if (state && payload.batch !== state.token) throw new Error('这次导出已经结束');
    return cancelExport(record);
  });
  wrap('shot:workspace-copy-notes', record => copyNotes(record));
  wrap('shot:workspace-hide', record => {
    if (record.win && record.win.isDestroyed() !== true) record.win.hide();
    return { ok: true };
  });

  return {
    openFromEntries, openGroup,
    openGroups: () => [...records.keys()],
    stateOfGroup: groupId => {
      const record = records.get(groupId);
      return record ? stateOf(record) : undefined;
    },
    getWindow: groupId => records.get(groupId)?.win,
    dispose: () => {
      disposed = true;
      for (const record of [...records.values()]) {
        cancelExport(record, '程序退出');
        record.closing = true;
        if (record.win && record.win.isDestroyed() !== true) { try { record.win.destroy(); } catch { /* 已销毁。 */ } }
        Promise.resolve(store.release(record.token)).catch(() => {});
      }
      records.clear();
    }
  };
}

module.exports = { installWorkspaceWindow, pngHeader, layoutFrames, toBufferBytes };
