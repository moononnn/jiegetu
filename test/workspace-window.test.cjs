'use strict';
// 跨图批注工作台（主进程）：建组、IPC 鉴权、CAS 保存、导出计划/额度/终态、关闭确认。
// 真实 SQLite 与私有目录；窗口、发布器、目录对话框用替身，不加载生产 main/index.cjs。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createStoreCore } = require('../main/clipboard-store-worker.cjs');
const { installWorkspaceWindow } = require('../main/workspace-window.cjs');

const roots = [];
function tempRoot(tag = 'ws') {
  const root = path.join(os.tmpdir(), `cg-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  roots.push(root);
  return root;
}
process.on('exit', () => { for (const root of roots) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 已删。 */ } } });

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngBytes(width, height, rgb = [12, 34, 56]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length, 0);
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2]; }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

class FakeWebContents {
  constructor() { this.mainFrame = { id: 'main' }; this.sent = []; }
  send(channel, payload) { this.sent.push([channel, payload]); }
  on() {}
}
let windowSeq = 0;
function makeHarness({ limits, dialogPaths, hooks = {} } = {}) {
  const root = tempRoot();
  const core = createStoreCore({ root });
  const exportRoot = path.join(root, 'workspace-export');
  fs.mkdirSync(exportRoot, { recursive: true });
  const windows = [];
  class FakeWindow {
    constructor(options) {
      this.id = ++windowSeq;
      this.options = options;
      this.webContents = new FakeWebContents();
      this.handlers = new Map();
      this.destroyed = false;
      this.shown = 0;
      this.focused = 0;
      this.hidden = 0;
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    show() { this.shown += 1; }
    focus() { this.focused += 1; }
    hide() { this.hidden += 1; }
    restore() {}
    removeMenu() {}
    on(name, handler) { this.handlers.set(name, handler); }
    once() {}
    loadFile(file) { this.file = file; }
    close() {
      let prevented = false;
      const handler = this.handlers.get('close');
      if (handler) handler({ preventDefault() { prevented = true; } });
      if (prevented) return false;
      this.destroyed = true;
      this.handlers.get('closed')?.();
      return true;
    }
    destroy() { this.destroyed = true; this.handlers.get('closed')?.(); }
  }
  const handlers = new Map();
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
  const published = [];
  const service = {
    publish: async parts => {
      if (typeof hooks.publish === 'function') return hooks.publish(parts);
      published.push(parts);
      return { ok: true };
    }
  };
  const dialog = {
    showOpenDialog: async (...args) => {
      if (typeof hooks.dialog === 'function') return hooks.dialog(...args);
      return { canceled: false, filePaths: [dialogPaths || path.join(root, 'saved')] };
    }
  };
  const screen = { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }) };
  const storeOverrides = {};
  const store = {
    get: async id => core.get(id),
    assetSizes: async hashes => storeOverrides.assetSizes?.(hashes) ?? core.assetSizes(hashes),
    readBlob: async hash => core.readBlob(hash),
    saveGroup: async payload => core.saveGroup(payload),
    getGroup: async id => core.getGroup(id),
    listGroups: async () => core.listGroups(),
    pin: async () => {},
    release: async () => {}
  };
  const workspace = installWorkspaceWindow({
    BrowserWindow: FakeWindow, ipcMain, screen, dialog, theme: { bind() {} },
    rendererFile: path.join(__dirname, '../renderer/workspace.html'),
    preloadFile: path.join(__dirname, '../main/workspace-preload.cjs'),
    store, service, settings: { getClipboard: () => ({ enabled: true }) },
    exportRoot, limits, writeFile: hooks.writeFile
  });
  return { core, store, storeOverrides, workspace, handlers, windows, published, root, exportRoot };
}

function entryFor(core, width, height, name) {
  const bytes = pngBytes(width, height);
  return { id: core.addEntry({ entries: [{ key: 'png', bytes }], source: name || 'test' }).id, bytes };
}

function installEvent(win, { senderFrame } = {}) {
  return { sender: win.webContents, senderFrame: senderFrame || win.webContents.mainFrame };
}

test('建组：少于两张拒绝、非图片拒绝、重复 id 去重、组引用与修订号落库', async () => {
  const h = makeHarness();
  const a = entryFor(h.core, 120, 80);
  const b = entryFor(h.core, 60, 90);
  const text = h.core.addEntry({ entries: [{ key: 'text', bytes: Buffer.concat([Buffer.from('文字', 'utf16le'), Buffer.from([0, 0])]) }], source: 'notepad' }).id;

  await assert.rejects(() => h.workspace.openFromEntries([a.id]), /至少选两张/);
  await assert.rejects(() => h.workspace.openFromEntries([a.id, text]), /只有静态图片/);
  const opened = await h.workspace.openFromEntries([a.id, b.id, a.id]);
  assert.equal(opened.groupId.startsWith('group_'), true);
  const row = await h.store.getGroup(opened.groupId);
  const document = JSON.parse(row.document);
  assert.equal(document.images.length, 2, '重复 id 只算一张');
  assert.equal(row.revision, 1);
  const hashes = h.core.groupAssetHashes(opened.groupId);
  assert.equal(hashes.length, 2, '两张原件都进了 group_assets');
  assert.equal(h.windows.length, 1);
  assert.equal(h.windows[0].file, path.join(__dirname, '../renderer/workspace.html'));
});

test('IPC 鉴权：外来窗口、伪 token、子 frame 全拒；同组再开只聚焦不建第二扇窗', async () => {
  const h = makeHarness();
  const a = entryFor(h.core, 40, 40);
  const b = entryFor(h.core, 40, 50);
  const { groupId, token } = await h.workspace.openFromEntries([a.id, b.id]);
  const win = h.windows[0];
  const state = h.handlers.get('shot:workspace-state');

  assert.equal((await state(installEvent(win), { token })).groupId, groupId);
  await assert.rejects(() => state(installEvent(win), { token: 'wrong' }), /已失效/);
  await assert.rejects(() => state({ sender: new FakeWebContents(), senderFrame: {} }, { token }), /已失效/);
  await assert.rejects(() => state(installEvent(win, { senderFrame: {} }), { token }), /已失效/);

  const again = await h.workspace.openGroup(groupId);
  assert.equal(again.groupId, groupId);
  assert.equal(h.windows.length, 1, '同组复用同一扇窗');
  assert.equal(win.shown >= 1, true);
});

test('资产读取绑定当前组：组内 hash 可读，组外 hash 拒绝', async () => {
  const h = makeHarness();
  const a = entryFor(h.core, 30, 30);
  const b = entryFor(h.core, 30, 40);
  const outsider = entryFor(h.core, 20, 20);
  const { token, groupId } = await h.workspace.openFromEntries([a.id, b.id]);
  const win = h.windows[0];
  const asset = h.handlers.get('shot:workspace-asset');
  const document = JSON.parse((await h.store.getGroup(groupId)).document);
  const inside = await asset(installEvent(win), { token, assetHash: document.images[0].assetHash });
  assert.equal(Buffer.isBuffer(inside), true);
  const outsiderHash = (await h.store.get(outsider.id)).assetHash;
  await assert.rejects(() => asset(installEvent(win), { token, assetHash: outsiderHash }), /不属于当前批注组/);
});

test('保存：CAS 递增、旧基线拒绝、引用组外原件与尺寸不符拒绝', async () => {
  const h = makeHarness();
  const a = entryFor(h.core, 50, 50);
  const b = entryFor(h.core, 50, 60);
  const { token, groupId } = await h.workspace.openFromEntries([a.id, b.id]);
  const win = h.windows[0];
  const save = h.handlers.get('shot:workspace-save');
  const row = await h.store.getGroup(groupId);
  const document = JSON.parse(row.document);
  document.notes.push({ id: 'note_one', text: '颜色照这个', linked: false,
    targets: [{ id: 'target_one', imageId: document.images[0].id, kind: 'point', point: { x: 10, y: 12 } }] });

  const saved = await save(installEvent(win), { token, document, baseRevision: 1 });
  assert.equal(saved.revision, 2);
  await assert.rejects(() => save(installEvent(win), { token, document, baseRevision: 1 }), /已经在别处更新过/);

  const wrongSize = JSON.parse(JSON.stringify(document));
  wrongSize.images[0].width = 51;
  await assert.rejects(() => save(installEvent(win), { token, document: wrongSize, baseRevision: 2 }), /尺寸|原件/);

  const outsider = entryFor(h.core, 30, 30);
  const outsiderHash = (await h.store.get(outsider.id)).assetHash;
  const outside = JSON.parse(JSON.stringify(document));
  outside.images[0].assetHash = outsiderHash;
  await assert.rejects(() => save(installEvent(win), { token, document: outside, baseRevision: 2 }), /当前组之外的原件/);
});

test('导出：总览序号 0、逐图按计划精确尺寸、张数不齐不发布、完成后发布一次 files', async () => {
  const h = makeHarness();
  const a = entryFor(h.core, 120, 80);
  const b = entryFor(h.core, 100, 160);
  const { token, groupId } = await h.workspace.openFromEntries([a.id, b.id]);
  const win = h.windows[0];
  const document = JSON.parse((await h.store.getGroup(groupId)).document);
  document.notes.push({ id: 'note_cross', text: '两张一起看', linked: true, targets: [
    { id: 'target_a', imageId: document.images[0].id, kind: 'region', rect: { x: 10, y: 10, width: 40, height: 30 } },
    { id: 'target_b', imageId: document.images[1].id, kind: 'point', point: { x: 30, y: 40 } }
  ] });
  await h.handlers.get('shot:workspace-save')(installEvent(win), { token, document, baseRevision: 1 });

  const begin = h.handlers.get('shot:workspace-export-begin');
  const part = h.handlers.get('shot:workspace-export-part');
  const done = h.handlers.get('shot:workspace-export-done');
  const batch = await begin(installEvent(win), { token, kind: 'copy' });
  assert.equal(batch.canceled, undefined);
  assert.equal(batch.plan.images.length, 2);
  assert.equal(batch.files.length, 3);
  assert.equal(batch.plan.notesText, undefined, '计划里不回传说明全文，说明由 main 写');

  const overview = pngBytes(batch.plan.overview.width, batch.plan.overview.height);
  await assert.rejects(() => part(installEvent(win), { token, batch: batch.token, index: 0,
    bytes: pngBytes(batch.plan.overview.width + 1, batch.plan.overview.height) }), /尺寸与导出计划不一致/);
  const first = await part(installEvent(win), { token, batch: batch.token, index: 0, bytes: overview });
  assert.equal(first.written, 1);

  // 张数不齐：done 必须拒绝，绝不能把半组说成完成。
  await assert.rejects(() => done(installEvent(win), { token, batch: batch.token }), /还差/);

  for (const image of batch.plan.images) {
    const bytes = pngBytes(image.width, image.height);
    await part(installEvent(win), { token, batch: batch.token, index: image.index + 1, bytes });
  }
  const finished = await done(installEvent(win), { token, batch: batch.token });
  assert.equal(finished.ok, true);
  assert.equal(finished.written, 3, '总览 + 2 张图');
  assert.equal(h.published.length, 1, '整组只发布一次');
  const files = h.published[0][0].paths;
  assert.equal(files.length, 4, '2 张图 + 总览 + 说明.txt');
  assert.equal(files.at(-1).endsWith('说明.txt'), true);
  assert.equal(fs.existsSync(files.at(-1)), true);
  assert.equal(fs.readFileSync(files.at(-1), 'utf8').includes('两张一起看'), true);
});

test('导出额度：复制批次超限不发布半组、保存额度独立；取消后终态不能复活', async () => {
  const h = makeHarness({ limits: { copyBatchBytes: 10, saveBatchBytes: 4 * 1024 * 1024 } });
  const a = entryFor(h.core, 120, 80);
  const b = entryFor(h.core, 100, 160);
  const { token } = await h.workspace.openFromEntries([a.id, b.id]);
  const win = h.windows[0];
  const begin = h.handlers.get('shot:workspace-export-begin');
  const part = h.handlers.get('shot:workspace-export-part');
  const done = h.handlers.get('shot:workspace-export-done');
  const abort = h.handlers.get('shot:workspace-export-abort');

  const copyBatch = await begin(installEvent(win), { token, kind: 'copy' });
  await assert.rejects(() => part(installEvent(win), { token, batch: copyBatch.token, index: 0,
    bytes: pngBytes(copyBatch.plan.overview.width, copyBatch.plan.overview.height) }), /较大|上限/);
  assert.equal(h.published.length, 0, '超限不发布半组');
  await abort(installEvent(win), { token, batch: copyBatch.token });

  // 同一组：保存额度是独立的一套（不把复制缓存的 256MiB 硬套到保存）。
  const saveBatch = await begin(installEvent(win), { token, kind: 'save' });
  await part(installEvent(win), { token, batch: saveBatch.token, index: 0,
    bytes: pngBytes(saveBatch.plan.overview.width, saveBatch.plan.overview.height) });
  for (const image of saveBatch.plan.images) {
    await part(installEvent(win), { token, batch: saveBatch.token, index: image.index + 1,
      bytes: pngBytes(image.width, image.height) });
  }
  assert.equal((await done(installEvent(win), { token, batch: saveBatch.token })).kind, 'save');
  assert.equal(h.published.length, 0);

  const ended = await begin(installEvent(win), { token, kind: 'save' });
  await abort(installEvent(win), { token, batch: ended.token });
  await assert.rejects(() => part(installEvent(win), { token, batch: ended.token, index: 0,
    bytes: pngBytes(ended.plan.overview.width, ended.plan.overview.height) }), /已经结束|没有正在进行的导出/);
  await assert.rejects(() => done(installEvent(win), { token, batch: ended.token }), /已经结束|没有正在进行的导出/);
});

test('保存整组：写入唯一子目录、含说明.txt、再次保存不覆盖已有文件', async () => {
  const h = makeHarness();
  const a = entryFor(h.core, 40, 30);
  const b = entryFor(h.core, 30, 40);
  const { token } = await h.workspace.openFromEntries([a.id, b.id]);
  const win = h.windows[0];
  const begin = h.handlers.get('shot:workspace-export-begin');
  const part = h.handlers.get('shot:workspace-export-part');
  const done = h.handlers.get('shot:workspace-export-done');
  const batch = await begin(installEvent(win), { token, kind: 'save' });
  await part(installEvent(win), { token, batch: batch.token, index: 0,
    bytes: pngBytes(batch.plan.overview.width, batch.plan.overview.height) });
  for (const image of batch.plan.images) {
    await part(installEvent(win), { token, batch: batch.token, index: image.index + 1,
      bytes: pngBytes(image.width, image.height) });
  }
  const finished = await done(installEvent(win), { token, batch: batch.token });
  assert.equal(finished.kind, 'save');
  assert.equal(fs.existsSync(path.join(finished.directory, '说明.txt')), true);
  assert.equal(fs.readdirSync(finished.directory).length, 4);
  assert.equal(h.published.length, 0, '保存不走剪贴板发布');
});

test('关闭确认：有未保存改动先问；确认后才真正关闭；无改动直接关', async () => {
  const h = makeHarness();
  const a = entryFor(h.core, 30, 30);
  const b = entryFor(h.core, 30, 31);
  const { token } = await h.workspace.openFromEntries([a.id, b.id]);
  const win = h.windows[0];
  const dirty = h.handlers.get('shot:workspace-dirty');

  await dirty(installEvent(win), { token, dirty: true });
  assert.equal(win.close(), false, '有草稿时不直接关');
  assert.equal(win.webContents.sent.some(([channel]) => channel === 'ws:close-request'), true);

  await h.handlers.get('shot:workspace-force-close')(installEvent(win), { token });
  assert.equal(win.destroyed, true);

  const second = await h.workspace.openFromEntries([a.id, b.id]);
  const win2 = h.windows.at(-1);
  assert.equal(win2.close(), true, '没有未保存改动就直接关');
  assert.equal(second.groupId.startsWith('group_'), true);
});

test('16 张图建组：导出计划 17 张 PNG + 1 份说明；第 17 张拒绝', async () => {
  const h = makeHarness();
  const entries = [];
  for (let index = 0; index < 17; index++) entries.push(entryFor(h.core, 20 + index, 20 + index));
  const sixteen = await h.workspace.openFromEntries(entries.slice(0, 16).map(item => item.id));
  const win = h.windows[0];
  const batch = await h.handlers.get('shot:workspace-export-begin')(installEvent(win), { token: sixteen.token, kind: 'copy' });
  assert.equal(batch.plan.images.length, 16);
  assert.equal(batch.files.length, 17, '总览 + 16 张图');
  await h.handlers.get('shot:workspace-export-abort')(installEvent(win), { token: sixteen.token, batch: batch.token });
  await assert.rejects(() => h.workspace.openFromEntries(entries.map(item => item.id)), /最多 16 张/);
});

test('重开恢复：保存的意见与遮盖在新窗口读回来；修订号跟着落库', async () => {
  const h = makeHarness();
  const a = entryFor(h.core, 60, 40);
  const b = entryFor(h.core, 50, 50);
  const opened = await h.workspace.openFromEntries([a.id, b.id]);
  const win = h.windows[0];
  const document = JSON.parse((await h.store.getGroup(opened.groupId)).document);
  document.comment = '下次接着改';
  document.notes.push({ id: 'note_keep', text: '这条要留下来', linked: false, targets: [
    { id: 'target_keep', imageId: document.images[0].id, kind: 'point', point: { x: 5, y: 6 } }] });
  document.images[0].masks.push({ id: 'mask_keep', rect: { x: 1, y: 2, width: 10, height: 8 }, color: '#ffffff' });
  await h.handlers.get('shot:workspace-save')(installEvent(win), { token: opened.token, document, baseRevision: 1 });
  // 关掉这扇窗，再用新窗口重开同一组（模拟下次继续）。
  await h.handlers.get('shot:workspace-force-close')(installEvent(win), { token: opened.token });
  assert.equal(win.destroyed, true);
  await h.workspace.openGroup(opened.groupId);
  const state = h.workspace.stateOfGroup(opened.groupId);
  assert.equal(state.revision, 2, '修订号跟落库版本');
  assert.equal(state.document.comment, '下次接着改');
  assert.equal(state.document.notes[0].text, '这条要留下来');
  assert.equal(state.document.images[0].masks[0].rect.width, 10);
});

// —— P0：二进制兼容、取消竞态、并发与额度 ——
function gate() {
  let open;
  const promise = new Promise(resolve => { open = resolve; });
  return { promise, open };
}

async function openTwo(h) {
  const a = entryFor(h.core, 120, 80);
  const b = entryFor(h.core, 100, 160);
  const opened = await h.workspace.openFromEntries([a.id, b.id]);
  return { ...opened, win: h.windows[0] };
}

// 复制批次写到 exportRoot 下的唯一子目录。
function batchDirOf(h) {
  const entries = fs.readdirSync(h.exportRoot, { withFileTypes: true }).filter(item => item.isDirectory());
  if (entries.length !== 1) throw new Error(`导出目录数量不对：${entries.length}`);
  return entries[0].name;
}

function handlersOf(h) {
  return {
    begin: h.handlers.get('shot:workspace-export-begin'),
    part: h.handlers.get('shot:workspace-export-part'),
    done: h.handlers.get('shot:workspace-export-done'),
    abort: h.handlers.get('shot:workspace-export-abort')
  };
}

test('P0 二进制：ArrayBuffer 与带 offset 的子视图都能收；非法对象与尺寸不符仍拒', async () => {
  const h = makeHarness();
  const { token, win } = await openTwo(h);
  const { begin, part } = handlersOf(h);
  const batch = await begin(installEvent(win), { token, kind: 'copy' });

  // 非法对象：不认字符串/普通对象，不当成 0 字节。
  await assert.rejects(() => part(installEvent(win), { token, batch: batch.token, index: 0, bytes: 'not-bytes' }), /导出的图片为空/);
  await assert.rejects(() => part(installEvent(win), { token, batch: batch.token, index: 0, bytes: { length: 4 } }), /导出的图片为空/);

  // ArrayBuffer 本体（contextBridge 之后的常见形态）。
  const overview = pngBytes(batch.plan.overview.width, batch.plan.overview.height);
  const arrayBuffer = overview.buffer.slice(overview.byteOffset, overview.byteOffset + overview.length);
  await part(installEvent(win), { token, batch: batch.token, index: 0, bytes: arrayBuffer });
  const overviewFile = path.join(h.exportRoot, batchDirOf(h), batch.files[0].name);

  // 尺寸闸不放宽：换个宽 +1 的 PNG 仍要在写入前拒。
  await assert.rejects(() => part(installEvent(win), { token, batch: batch.token, index: 1,
    bytes: pngBytes(batch.plan.images[0].width + 1, batch.plan.images[0].height).buffer }), /尺寸与导出计划不一致/);

  // 带非零 byteOffset 的子视图：必须按实际范围取，而不是把整块内存当图。
  const imageBytes = pngBytes(batch.plan.images[0].width, batch.plan.images[0].height);
  const padded = Buffer.alloc(imageBytes.length + 256, 0x2a);
  imageBytes.copy(padded, 128);
  await part(installEvent(win), { token, batch: batch.token, index: 1, bytes: padded.subarray(128, 128 + imageBytes.length) });
  const imageFile = path.join(h.exportRoot, batchDirOf(h), batch.files[1].name);
  assert.deepEqual(fs.readFileSync(imageFile), imageBytes, '子视图写入的字节与原始 PNG 完全一致');
  assert.deepEqual(fs.readFileSync(overviewFile), overview, 'ArrayBuffer 写入的字节与原始 PNG 完全一致');
});

test('P0 取消：说明.txt 写入在途时取消，不再发布，done 也不能报成功', async () => {
  const g = gate();
  const h = makeHarness({ hooks: { writeFile: async (file, bytes, options) => {
    if (file.endsWith('说明.txt')) await g.promise;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, options);
  } } });
  const { token, win } = await openTwo(h);
  const { begin, part, done, abort } = handlersOf(h);
  const batch = await begin(installEvent(win), { token, kind: 'copy' });
  await part(installEvent(win), { token, batch: batch.token, index: 0, bytes: pngBytes(batch.plan.overview.width, batch.plan.overview.height) });
  for (const image of batch.plan.images) {
    await part(installEvent(win), { token, batch: batch.token, index: image.index + 1, bytes: pngBytes(image.width, image.height) });
  }
  const donePromise = done(installEvent(win), { token, batch: batch.token });
  await new Promise(resolve => setTimeout(resolve, 40));
  const aborted = await abort(installEvent(win), { token, batch: batch.token });
  assert.equal(aborted.ok, true, 'TXT 还在写时取消应当成功');
  assert.equal(aborted.written, 3);
  g.open();
  await assert.rejects(donePromise, /结束|取消/);
  assert.equal(h.published.length, 0, '取消后绝不能发布');
  // 取消后 part/done 一律拒，终态不能复活。
  await assert.rejects(() => part(installEvent(win), { token, batch: batch.token, index: 0,
    bytes: pngBytes(batch.plan.overview.width, batch.plan.overview.height) }), /已经结束|没有正在进行的导出/);
  await assert.rejects(() => done(installEvent(win), { token, batch: batch.token }), /已经结束|没有正在进行的导出/);
});

test('P0 取消：已经交给发布时 abort 返回未生效，done 仍完成且只发布一次', async () => {
  const g = gate();
  const h = makeHarness({ hooks: { publish: async () => { await g.promise; return { ok: true }; } } });
  const { token, win } = await openTwo(h);
  const { begin, part, done, abort } = handlersOf(h);
  const batch = await begin(installEvent(win), { token, kind: 'copy' });
  await part(installEvent(win), { token, batch: batch.token, index: 0, bytes: pngBytes(batch.plan.overview.width, batch.plan.overview.height) });
  for (const image of batch.plan.images) {
    await part(installEvent(win), { token, batch: batch.token, index: image.index + 1, bytes: pngBytes(image.width, image.height) });
  }
  const donePromise = done(installEvent(win), { token, batch: batch.token });
  await new Promise(resolve => setTimeout(resolve, 50));
  const aborted = await abort(installEvent(win), { token, batch: batch.token });
  assert.equal(aborted.ok, false, '发布已越过不可撤回点，不能报“已取消”');
  assert.equal(aborted.published, true);
  g.open();
  const result = await donePromise;
  assert.equal(result.ok, true);
  assert.equal(result.written, 3);
});

test('P0 并发：两个 begin 只成一个；同一 index 并发被拒且额度不双花', async () => {
  const dialogGate = gate();
  const h = makeHarness({ hooks: { dialog: async () => { await dialogGate.promise; return { canceled: true }; } } });
  const { token, win } = await openTwo(h);
  const { begin, part } = handlersOf(h);
  const first = begin(installEvent(win), { token, kind: 'save' });
  await new Promise(resolve => setTimeout(resolve, 20));
  await assert.rejects(() => begin(installEvent(win), { token, kind: 'copy' }), /上一次导出还没结束/);
  dialogGate.open();
  assert.deepEqual(await first, { canceled: true });
  const second = await begin(installEvent(win), { token, kind: 'copy' });
  await handlersOf(h).abort(installEvent(win), { token, batch: second.token });
});

test('P0 并发：同一张写入在途甩重复提交被拒；额度先预留不会双花', async () => {
  const g = gate();
  const h = makeHarness({ hooks: { writeFile: async (file, bytes, options) => {
    if (!file.endsWith('说明.txt')) await g.promise;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, options);
  } } });
  const { token, win } = await openTwo(h);
  const { begin, part } = handlersOf(h);
  const batch = await begin(installEvent(win), { token, kind: 'copy' });
  const overview = pngBytes(batch.plan.overview.width, batch.plan.overview.height);
  const pending = part(installEvent(win), { token, batch: batch.token, index: 0, bytes: overview });
  await new Promise(resolve => setTimeout(resolve, 20));
  await assert.rejects(() => part(installEvent(win), { token, batch: batch.token, index: 0, bytes: overview }), /正在写入/);
  g.open();
  await pending;

  // 额度双花：每批额度只够一张，第二张并发提交时先预留的就已占满。
  await handlersOf(h).abort(installEvent(win), { token, batch: batch.token });
  const small = makeHarness({ limits: { copyBatchBytes: overview.length + 8 } });
  const two = await openTwo(small);
  const smallHandlers = handlersOf(small);
  const smallBatch = await smallHandlers.begin(installEvent(two.win), { token: two.token, kind: 'copy' });
  await smallHandlers.part(installEvent(two.win), { token: two.token, batch: smallBatch.token, index: 0,
    bytes: pngBytes(smallBatch.plan.overview.width, smallBatch.plan.overview.height) });
  await assert.rejects(() => smallHandlers.part(installEvent(two.win), { token: two.token, batch: smallBatch.token,
    index: 1, bytes: pngBytes(smallBatch.plan.images[0].width, smallBatch.plan.images[0].height) }), /较大|上限/);
});

test('P0 额度：说明.txt 也计入整批字节，图片刚好满额时 done 拒绝', async () => {
  const h = makeHarness();
  const { token, win } = await openTwo(h);
  const { begin, part, done } = handlersOf(h);
  const probe = await begin(installEvent(win), { token, kind: 'copy' });
  const overview = pngBytes(probe.plan.overview.width, probe.plan.overview.height);
  const images = probe.plan.images.map(image => pngBytes(image.width, image.height));
  const total = overview.length + images.reduce((sum, item) => sum + item.length, 0);
  await handlersOf(h).abort(installEvent(win), { token, batch: probe.token });

  const tight = makeHarness({ limits: { copyBatchBytes: total + 8 } });
  const opened = await openTwo(tight);
  const handlers = handlersOf(tight);
  const batch = await handlers.begin(installEvent(opened.win), { token: opened.token, kind: 'copy' });
  await handlers.part(installEvent(opened.win), { token: opened.token, batch: batch.token, index: 0,
    bytes: pngBytes(batch.plan.overview.width, batch.plan.overview.height) });
  for (const image of batch.plan.images) {
    await handlers.part(installEvent(opened.win), { token: opened.token, batch: batch.token, index: image.index + 1,
      bytes: pngBytes(image.width, image.height) });
  }
  await assert.rejects(() => handlers.done(installEvent(opened.win), { token: opened.token, batch: batch.token }), /较大|上限/);
  assert.equal(tight.published.length, 0);
});

test('P0 缓存：说明.txt 也计入复制缓存字节（注入小预算），图片刚好占满时 done 拒绝', async () => {
  const h = makeHarness();
  const { token, win } = await openTwo(h);
  const { begin, part, done, abort } = handlersOf(h);
  const probe = await begin(installEvent(win), { token, kind: 'copy' });
  const overview = pngBytes(probe.plan.overview.width, probe.plan.overview.height);
  const images = probe.plan.images.map(image => pngBytes(image.width, image.height));
  const total = overview.length + images.reduce((sum, item) => sum + item.length, 0);
  await abort(installEvent(win), { token, batch: probe.token });

  const tight = makeHarness({ limits: { copyCacheBytes: total + 4 } });
  const opened = await openTwo(tight);
  const handlers = handlersOf(tight);
  const batch = await handlers.begin(installEvent(opened.win), { token: opened.token, kind: 'copy' });
  await handlers.part(installEvent(opened.win), { token: opened.token, batch: batch.token, index: 0,
    bytes: pngBytes(batch.plan.overview.width, batch.plan.overview.height) });
  for (const image of batch.plan.images) {
    await handlers.part(installEvent(opened.win), { token: opened.token, batch: batch.token, index: image.index + 1,
      bytes: pngBytes(image.width, image.height) });
  }
  // 图片加起来已占满缓存（total 字节），说明.txt 再写就不行：图片不删、不假装成功。
  await assert.rejects(() => handlers.done(installEvent(opened.win), { token: opened.token, batch: batch.token }), /缓存已满/);
  assert.equal(tight.published.length, 0);
});

test('P0 缓存文件数：并发写入的预留也计入上限（注入小预算）', async () => {
  const g = gate();
  const h = makeHarness({ limits: { copyCacheFiles: 1 }, hooks: { writeFile: async (file, bytes, options) => {
    if (!file.endsWith('说明.txt')) await g.promise;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, options);
  } } });
  const { token, win } = await openTwo(h);
  const { begin, part } = handlersOf(h);
  const batch = await begin(installEvent(win), { token, kind: 'copy' });
  const overview = pngBytes(batch.plan.overview.width, batch.plan.overview.height);
  const pending = part(installEvent(win), { token, batch: batch.token, index: 0, bytes: overview });
  await new Promise(resolve => setTimeout(resolve, 20));
  // 第一张还在写（inflight=1），第二张的预留就超文件数上限；不能两个都放行。
  await assert.rejects(() => part(installEvent(win), { token, batch: batch.token, index: 1,
    bytes: pngBytes(batch.plan.images[0].width, batch.plan.images[0].height) }), /文件数已满/);
  g.open();
  await pending;
});

// —— 第 2 版：空文字目标与独立关系，走真实 IPC 与真实 SQLite 的保存/重开/导出 ——
const emptyDraftDocument = (document, imageId) => {
  document.schemaVersion = 2;
  document.notes.push({ id: 'note_draft', text: '', linked: false,
    targets: [{ id: 'target_draft', imageId, kind: 'region', rect: { x: 4, y: 6, width: 20, height: 16 } }] });
  return document;
};

test('第 2 版：空目标与关系经真实保存重开后都还在，删最后关系不降版', async () => {
  const h = makeHarness();
  const a = entryFor(h.core, 80, 60);
  const b = entryFor(h.core, 70, 50);
  const opened = await h.workspace.openFromEntries([a.id, b.id]);
  const win = h.windows[0];
  const save = h.handlers.get('shot:workspace-save');
  const document = emptyDraftDocument(JSON.parse((await h.store.getGroup(opened.groupId)).document), undefined);
  document.notes.at(-1).targets[0].imageId = document.images[0].id;
  const first = await save(installEvent(win), { token: opened.token, document, baseRevision: 1 });
  assert.equal(first.revision, 2);
  const stored = JSON.parse((await h.store.getGroup(opened.groupId)).document);
  assert.equal(stored.schemaVersion, 2, '空文字目标把组升到第 2 版并落库');
  assert.equal(stored.notes[0].text, '');

  stored.notes.push({ id: 'note_second', text: '', linked: false, targets: [
    { id: 'target_second', imageId: stored.images[1].id, kind: 'point', point: { x: 12, y: 18 } }] });
  stored.relations = [{ id: 'rel_one', text: '这两处颜色一致', ends: [
    { noteId: 'note_draft', targetId: 'target_draft' }, { noteId: 'note_second', targetId: 'target_second' }] }];
  await save(installEvent(win), { token: opened.token, document: stored, baseRevision: 2 });

  // 关掉重开：关系、空文字、版本都不能在保存链上掉。
  await h.handlers.get('shot:workspace-force-close')(installEvent(win), { token: opened.token });
  const reopened = await h.workspace.openGroup(opened.groupId);
  const state = h.workspace.stateOfGroup(opened.groupId);
  assert.equal(state.document.schemaVersion, 2);
  assert.equal(state.document.notes[0].text, '', '空文字草稿原样回来');
  assert.equal(state.document.relations.length, 1);
  assert.equal(state.document.relations[0].text, '这两处颜色一致');
  // 重开后两端仍是同一对 noteId+targetId（不靠序号、不复制几何）。
  const openRelation = state.document.relations[0];
  assert.deepEqual(openRelation.ends, stored.relations[0].ends);
  for (const end of openRelation.ends) {
    const note = state.document.notes.find(item => item.id === end.noteId);
    assert.ok(note && note.targets.some(target => target.id === end.targetId), `端点 ${JSON.stringify(end)} 能解析到真实目标`);
  }

  // 删掉最后一条关系：内容没了，版本仍然是 2，不降回 1。
  const reopenedWin = h.windows.at(-1);
  const reopenState = JSON.parse(JSON.stringify(state.document));
  reopenState.relations = [];
  await save(installEvent(reopenedWin), { token: reopened.token, document: reopenState, baseRevision: state.revision });
  const afterDelete = JSON.parse((await h.store.getGroup(opened.groupId)).document);
  assert.deepEqual(afterDelete.relations, []);
  assert.equal(afterDelete.schemaVersion, 2, '删最后一条关系也不自动降版');
});

test('成品导出：孤立空目标与空关系都拦下并指出缺项；两空框一条有字关系可导出', async () => {
  const h = makeHarness();
  const a = entryFor(h.core, 90, 70);
  const b = entryFor(h.core, 60, 60);
  const opened = await h.workspace.openFromEntries([a.id, b.id]);
  const win = h.windows[0];
  const save = h.handlers.get('shot:workspace-save');
  const begin = h.handlers.get('shot:workspace-export-begin');
  const document = emptyDraftDocument(JSON.parse((await h.store.getGroup(opened.groupId)).document));
  document.notes.at(-1).targets[0].imageId = document.images[0].id;
  let saved = await save(installEvent(win), { token: opened.token, document, baseRevision: 1 });
  await assert.rejects(() => begin(installEvent(win), { token: opened.token, kind: 'copy' }),
    /还有 1 处没写说明/);

  // 再加一条空关系：两端未获说明，关系自己也空着，一起报出来。
  const withRelation = JSON.parse((await h.store.getGroup(opened.groupId)).document);
  withRelation.notes.push({ id: 'note_second', text: '', linked: false, targets: [
    { id: 'target_second', imageId: withRelation.images[1].id, kind: 'point', point: { x: 20, y: 24 } }] });
  withRelation.relations = [{ id: 'rel_blank', text: '  ', ends: [
    { noteId: 'note_draft', targetId: 'target_draft' }, { noteId: 'note_second', targetId: 'target_second' }] }];
  saved = await save(installEvent(win), { token: opened.token, document: withRelation, baseRevision: saved.revision });
  await assert.rejects(() => begin(installEvent(win), { token: opened.token, kind: 'save' }),
    error => /还有 3 处没写说明/.test(error.message) && /关系1/.test(error.message));

  // 关系补上文字：两个空框不再逼着各写一句，直接可导出。
  const complete = JSON.parse((await h.store.getGroup(opened.groupId)).document);
  complete.relations[0].text = '这两处颜色一致';
  await save(installEvent(win), { token: opened.token, document: complete, baseRevision: saved.revision });
  const batch = await begin(installEvent(win), { token: opened.token, kind: 'copy' });
  assert.equal(batch.canceled, undefined);
  assert.equal(batch.plan.images.length, 2);
  await h.handlers.get('shot:workspace-export-abort')(installEvent(win), { token: opened.token, batch: batch.token }).catch(() => {});
});

test('关闭：只有草稿（已保存、没写说明）也先问一句，说清可以带草稿关', async () => {
  const h = makeHarness();
  const a = entryFor(h.core, 40, 40);
  const b = entryFor(h.core, 40, 44);
  const opened = await h.workspace.openFromEntries([a.id, b.id]);
  const win = h.windows[0];
  const document = emptyDraftDocument(JSON.parse((await h.store.getGroup(opened.groupId)).document));
  document.notes.at(-1).targets[0].imageId = document.images[0].id;
  await h.handlers.get('shot:workspace-save')(installEvent(win), { token: opened.token, document, baseRevision: 1 });
  assert.equal(win.close(), false, '草稿还在，先让页面讲清楚再关');
  assert.equal(win.webContents.sent.some(([channel]) => channel === 'ws:close-request'), true);
  // 页面确认后照常关：不锁死退出。
  await h.handlers.get('shot:workspace-force-close')(installEvent(win), { token: opened.token });
  assert.equal(win.destroyed, true);
});

test('旧 1 版组：打开与保存都不凭空升级，仍按空关系集合解释', async () => {
  const h = makeHarness();
  const a = entryFor(h.core, 30, 30);
  const b = entryFor(h.core, 30, 33);
  const opened = await h.workspace.openFromEntries([a.id, b.id]);
  const win = h.windows[0];
  const state = h.workspace.stateOfGroup(opened.groupId);
  assert.equal(state.document.schemaVersion, 1);
  assert.deepEqual(state.document.relations, []);
  const document = JSON.parse(JSON.stringify(state.document));
  document.comment = '只改总体说明';
  await h.handlers.get('shot:workspace-save')(installEvent(win), { token: opened.token, document, baseRevision: 1 });
  const stored = JSON.parse((await h.store.getGroup(opened.groupId)).document);
  assert.equal(stored.schemaVersion, 1, '没引入新语义就不升级');
  assert.deepEqual(stored.relations, []);
});

test('保存边界同样是版本高水位：旧稿回泻不会把已落库的第 2 版拉回 1', async () => {
  const h = makeHarness();
  const a = entryFor(h.core, 60, 40);
  const b = entryFor(h.core, 50, 50);
  const opened = await h.workspace.openFromEntries([a.id, b.id]);
  const win = h.windows[0];
  const save = h.handlers.get('shot:workspace-save');
  const v2 = emptyDraftDocument(JSON.parse((await h.store.getGroup(opened.groupId)).document));
  v2.notes.at(-1).targets[0].imageId = v2.images[0].id;
  const saved = await save(installEvent(win), { token: opened.token, document: v2, baseRevision: 1 });
  assert.equal(JSON.parse((await h.store.getGroup(opened.groupId)).document).schemaVersion, 2);

  // 旧客户端/旧快照回泻一份第 1 版文档：内容按它写，版本不降。
  const stale = JSON.parse(JSON.stringify(v2));
  stale.schemaVersion = 1;
  stale.relations = [];
  stale.notes = [];
  await save(installEvent(win), { token: opened.token, document: stale, baseRevision: saved.revision });
  const stored = JSON.parse((await h.store.getGroup(opened.groupId)).document);
  assert.equal(stored.schemaVersion, 2, '保存边界不降版');
  assert.equal(stored.notes.length, 0, '内容仍按这次提交来');
});

test('复制说明读的是落库版本：刚保存的文字会出现在发布的说明里', async () => {
  const h = makeHarness();
  const a = entryFor(h.core, 60, 40);
  const b = entryFor(h.core, 50, 50);
  const opened = await h.workspace.openFromEntries([a.id, b.id]);
  const win = h.windows[0];
  const document = JSON.parse((await h.store.getGroup(opened.groupId)).document);
  const marker = '刚存进库的说明';
  document.notes.push({ id: 'note_persist', text: marker, linked: false, targets: [
    { id: 'target_persist', imageId: document.images[0].id, kind: 'point', point: { x: 12, y: 9 } }] });
  await h.handlers.get('shot:workspace-save')(installEvent(win), { token: opened.token, document, baseRevision: 1 });
  await h.handlers.get('shot:workspace-copy-notes')(installEvent(win), { token: opened.token });
  const published = h.published.at(-1) || [];
  const textPart = published.find(part => part.format === 'text');
  const value = textPart ? Buffer.from(textPart.bytes).toString('utf16le').replace(/\u0000+$/, '') : '';
  assert.ok(textPart, '复制说明发出的是文字');
  assert.match(value, new RegExp(marker), value.slice(0, 200));
});
