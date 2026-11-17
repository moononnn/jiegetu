/* 验证用 preload：把工作台当成“真页面 + 内存里的主进程”，只用于隐藏窗口的像素验收。
   生产 preload（main/workspace-preload.cjs）不走这里，也不改变任何产品行为。 */
'use strict';
const { contextBridge } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const Group = require('../../core/annotation-group.js');

const arg = process.argv.find(item => item.startsWith('--ws-fixture='));
if (!arg) throw new Error('缺少 --ws-fixture');
const fixture = JSON.parse(fs.readFileSync(arg.slice('--ws-fixture='.length), 'utf8'));

function pngSize(bytes) {
  if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || bytes.toString('latin1', 12, 16) !== 'IHDR') throw new Error('坏 PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const assets = new Map();
const sizes = {};
for (const [hash, file] of Object.entries(fixture.assets || {})) {
  const bytes = fs.readFileSync(file);
  assets.set(hash, bytes);
  sizes[hash] = pngSize(bytes);
}

const report = { begun: [], parts: [], done: undefined, aborted: [], errors: [], saves: [],
  dirty: [], closed: 0, closeRequests: 0 };
let closeHandler;
// 挂起保存用的 resolver 不能放 report（函数无法 structured clone）。
let saveRelease = null;
const outDir = fixture.exportDir;
fs.mkdirSync(outDir, { recursive: true });
let batch;

function write(name, bytes) {
  const file = path.join(outDir, name);
  fs.writeFileSync(file, Buffer.from(bytes));
  return file;
}

const images = (fixture.document.images || []).map(image => ({ id: image.id, name: image.name,
  assetHash: image.assetHash, width: image.width, height: image.height }));

contextBridge.exposeInMainWorld('workspaceHost', {
  onState: () => {},
  onCloseRequest: handler => { closeHandler = handler; },
  state: async () => ({ groupId: fixture.document.id, title: fixture.document.title, revision: 1,
    document: fixture.document, saving: false, saveFailed: false, lastSavedAt: 0, images }),
  asset: async hash => {
    const bytes = assets.get(hash);
    if (!bytes) throw new Error('fixture 里没有这个原件');
    return bytes;
  },
  save: async (document, baseRevision) => {
    // 验证用：把这次保存挂起，直到 __releaseSave，用来测“保存 A 期间提交 B”的屏障。
    if (report.holdNextSave) {
      report.holdNextSave = false;
      await new Promise(resolve => { saveRelease = resolve; });
    }
    // 验证用：让某次保存失败，看页面会不会守在窗里而不是直接关。
    if (fixture.failSave || report.failNextSave) { report.failNextSave = false; throw new Error('磁盘写入失败（验证用）'); }
    report.saves.push({ revision: baseRevision + 1, document: JSON.stringify(document) });
    return { revision: baseRevision + 1, savedAt: Date.now() };
  },
  setDirty: async dirty => { report.dirty.push(dirty === true); return { dirty: dirty === true }; },
  forceClose: async () => { report.closed += 1; return { ok: true }; },
  __requestClose: () => { report.closeRequests += 1; if (typeof closeHandler === 'function') closeHandler(); },
  __failNextSave: () => { report.failNextSave = true; },
  __holdNextSave: () => { report.holdNextSave = true; },
  __releaseSave: () => {
    const release = saveRelease;
    saveRelease = null;
    if (typeof release === 'function') release();
  },
  hide: async () => ({ ok: true }),
  exportBegin: async kind => {
    // 验证用：让 begin 慢一点（模拟等目录/校验），腾出“begin 期间点停止”的窗口。
    if (fixture.delayBeginMs > 0) await new Promise(resolve => setTimeout(resolve, fixture.delayBeginMs));
    const plan = Group.planExport(fixture.document, sizes);
    batch = { kind, plan, index: 0 };
    report.begun.push({ kind, images: plan.images.length, modes: plan.modes,
      overview: { width: plan.overview.width, height: plan.overview.height },
      files: plan.files.map(item => item.name) });
    return { token: 'fixture-batch', kind, plan: { ...plan, notesText: undefined }, files: plan.files,
      modes: plan.modes, limits: {} };
  },
  exportPart: async (batchToken, index, bytes) => {
    if (batchToken !== 'fixture-batch' || !batch) throw new Error('导出批次无效');
    // 验证用：让“编码后的交付”慢一点，腾出点停止的窗口；默认不延迟。
    if (fixture.delayPartMs > 0) await new Promise(resolve => setTimeout(resolve, fixture.delayPartMs));
    const name = batch.plan.files[index].name;
    const file = write(name, bytes);
    report.parts.push({ index, name, file, bytes: bytes.byteLength || bytes.length,
      width: batch.plan.overview && index === 0 ? batch.plan.overview.width : batch.plan.images[index - 1].width,
      height: batch.plan.overview && index === 0 ? batch.plan.overview.height : batch.plan.images[index - 1].height });
    return { index, written: report.parts.length, expected: batch.plan.images.length + 1 };
  },
  exportDone: async batchToken => {
    if (batchToken !== 'fixture-batch' || !batch) throw new Error('导出批次无效');
    write(batch.plan.textFile, Buffer.from(batch.plan.notesText, 'utf8'));
    report.done = { kind: batch.kind, files: batch.plan.files.map(item => item.name).concat(batch.plan.textFile),
      notesText: batch.plan.notesText, modes: batch.plan.modes, images: batch.plan.images.map(image => ({
        index: image.index, mode: image.mode, width: image.width, height: image.height,
        bodyX: image.bodyX, bodyY: image.bodyY, sourceWidth: image.sourceWidth, sourceHeight: image.sourceHeight,
        masks: image.masks })) };
    return { ok: true, kind: batch.kind, written: report.parts.length };
  },
  exportAbort: async batchToken => { report.aborted.push(batchToken); batch = undefined; return { ok: true }; },
  copyNotes: async () => {
    // 记录调用时“已经落盘的那一版”，用来证明页面是先把输入存好再复制。
    const last = report.saves.length ? report.saves.at(-1) : undefined;
    report.copiedAtRevision = last ? last.revision : 0;
    report.copiedDocument = last ? last.document : undefined;
    report.copyNotesCalls = (report.copyNotesCalls || 0) + 1;
    return { ok: true };
  },
  __report: () => report
});
