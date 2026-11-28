'use strict';
// 剪贴板存储：去重、收藏标签备注、分页搜索、pending 恢复、配额、组引用清理、CAS、worker 串行。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createStoreCore, INLINE_LIMIT } = require('../main/clipboard-store-worker.cjs');
const { createClipboardStore } = require('../main/clipboard-store.cjs');
// text 键按 CF_UNICODETEXT 契约：UTF-16LE + 终止符；HTML/RTF 仍是 UTF-8。
const textBytes = value => Buffer.concat([Buffer.from(value, 'utf16le'), Buffer.from([0, 0])]);

const roots = [];
function tempRoot() {
  const root = path.join(os.tmpdir(), `cg-store-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  roots.push(root);
  return root;
}
// 最小合法 PNG：真签名 + IHDR + IDAT，可被 pngSize 读出头。
function pngBytes(width, height, rgb = [12, 34, 56]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = crc32(body);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length, 0);
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc, 0);
    return Buffer.concat([length, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2]; }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

process.on('exit', () => { for (const root of roots) { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} } });

test('去重：同内容只留一条，重复复制只更新最近使用', () => {
  const core = createStoreCore({ root: tempRoot() });
  try {
    const first = core.addEntry({ entries: [{ key: 'text', bytes: textBytes('同一句话') }], source: 'notepad' });
    const second = core.addEntry({ entries: [{ key: 'text', bytes: textBytes('同一句话') }], source: 'chrome' });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.id, first.id);
    const list = core.list({});
    assert.equal(list.total, 1);
    assert.equal(list.rows[0].source, 'chrome', '来源更新到最近一次');
  } finally { core.close(); }
});

test('仅文本相同不代表整条相同：HTML 变了就是另一条', () => {
  const core = createStoreCore({ root: tempRoot() });
  try {
    const a = core.addEntry({ entries: [{ key: 'text', bytes: textBytes('标题') }, { key: 'html', bytes: Buffer.from('<b>标题</b>') }] });
    const b = core.addEntry({ entries: [{ key: 'text', bytes: textBytes('标题') }, { key: 'html', bytes: Buffer.from('<i>标题</i>') }] });
    assert.notEqual(a.id, b.id);
    assert.equal(core.list({}).total, 2);
  } finally { core.close(); }
});

test('每个格式的原始字节都留住，复制时能按原格式还原', () => {
  const core = createStoreCore({ root: tempRoot() });
  try {
    const text = Buffer.from('你好', 'utf8');
    const html = Buffer.from('<p>你好</p>', 'utf8');
    const rtf = Buffer.from('{\\rtf1 你好}', 'utf8');
    const added = core.addEntry({ entries: [{ key: 'text', bytes: text }, { key: 'html', bytes: html }, { key: 'rtf', bytes: rtf }] });
    const parts = core.contentOf(added.id).parts;
    assert.deepEqual(parts.map(part => part.format).sort(), ['html', 'rtf', 'text']);
    const byFormat = new Map(parts.map(part => [part.format, part]));
    assert.equal(byFormat.get('text').bytes.toString('utf8'), '你好');
    assert.equal(byFormat.get('html').bytes.toString('utf8'), '<p>你好</p>');
    assert.equal(byFormat.get('rtf').bytes.toString('utf8'), '{\\rtf1 你好}');
  } finally { core.close(); }
});

test('收藏、置顶、备注、标签都可持久，重开还在', () => {
  const root = tempRoot();
  let core = createStoreCore({ root });
  const added = core.addEntry({ entries: [{ key: 'text', bytes: textBytes('收藏我') }] });
  core.setFavorite(added.id, true);
  core.setPinned(added.id, true);
  core.setNote(added.id, '这条常用');
  core.setTags(added.id, ['工作', '模板']);
  core.close();
  core = createStoreCore({ root });
  try {
    const row = core.get(added.id);
    assert.equal(row.favorite, true);
    assert.equal(row.pinned, true);
    assert.equal(row.note, '这条常用');
    assert.deepEqual(row.tags.sort(), ['工作', '模板'].sort());
    assert.equal(core.list({ favorite: true }).total, 1);
    assert.equal(core.list({ tag: '工作' }).total, 1);
  } finally { core.close(); }
});

test('分页固定每页 50 条，搜索与类型筛选按真实总数', () => {
  const core = createStoreCore({ root: tempRoot() });
  try {
    for (let index = 0; index < 120; index++) {
      core.addEntry({ entries: [{ key: 'text', bytes: textBytes(`记录 ${index}`) }], source: index % 2 ? 'chrome' : 'notepad' });
    }
    const first = core.list({ page: 1 });
    assert.equal(first.total, 120);
    assert.equal(first.pages, 3);
    assert.equal(first.rows.length, 50);
    const third = core.list({ page: 3 });
    assert.equal(third.rows.length, 20);
    assert.equal(core.list({ query: '记录 119' }).total, 1);
    assert.equal(core.list({ source: 'chrome' }).total, 60);
    assert.equal(core.list({ kind: 'text' }).total, 120);
    assert.throws(() => core.list({ kind: 'bogus' }), /筛选类型无效/);
  } finally { core.close(); }
});

test('查询转义 LIKE 通配符，不会把 % 当任意串', () => {
  const core = createStoreCore({ root: tempRoot() });
  try {
    core.addEntry({ entries: [{ key: 'text', bytes: textBytes('100% 完成') }] });
    core.addEntry({ entries: [{ key: 'text', bytes: textBytes('100 完成') }] });
    assert.equal(core.list({ query: '100%' }).total, 1);
  } finally { core.close(); }
});

test('pending 恢复：启动时只清本模块未完成文件，不动正式 blob', () => {
  const root = tempRoot();
  let core = createStoreCore({ root });
  const added = core.addEntry({ entries: [{ key: 'png', bytes: pngBytes(2, 2) }] });
  const hash = core.get(added.id).assetHash;
  core.close();
  const pendingFile = path.join(root, 'pending', 'leftover.part');
  fs.writeFileSync(pendingFile, 'x');
  const blobsBefore = fs.readdirSync(path.join(root, 'blobs'));
  core = createStoreCore({ root });
  try {
    assert.equal(fs.existsSync(pendingFile), false, '未完成的 pending 被清掉');
    assert.deepEqual(fs.readdirSync(path.join(root, 'blobs')), blobsBefore, '正式原件没被牵连');
    assert.ok(fs.existsSync(path.join(root, 'blobs', `${hash}.bin`)));
  } finally { core.close(); }
});

test('磁盘失败不留下成功记录，也不留半条内容', () => {
  const root = tempRoot();
  const fakeFs = Object.create(fs);
  fakeFs.writeFileSync = () => { const error = new Error('磁盘满了'); error.code = 'ENOSPC'; throw error; };
  const core = createStoreCore({ root, fsImpl: fakeFs });
  try {
    assert.throws(() => core.addEntry({ entries: [{ key: 'png', bytes: pngBytes(3, 3) }] }), /磁盘满/);
    assert.equal(core.list({}).total, 0, '失败不留历史');
    assert.equal(core.stats().blobs, 0);
  } finally { core.close(); }
});

test('配额可注入：超过上限明说 QUOTA_FULL，不加半条', () => {
  const root = tempRoot();
  const core = createStoreCore({ root });
  try {
    // 小阈值 + 真实大文本（>64KiB 走 blob），不造大文件垃圾。
    core.setQuota(150 * 1024);
    const big = Buffer.from('y'.repeat(100 * 1024));
    core.addEntry({ entries: [{ key: 'text', bytes: big }] });
    assert.throws(() => core.addEntry({ entries: [{ key: 'text', bytes: textBytes('z'.repeat(100 * 1024)) }], source: '另一份' }), error => {
      assert.equal(error.code, 'QUOTA_FULL');
      return true;
    });
    assert.equal(core.list({}).total, 1);
  } finally { core.close(); }
});

test('组保存 CAS：旧 revision 被拒，新 revision 成功并更新引用差集', () => {
  const core = createStoreCore({ root: tempRoot() });
  try {
    const pngA = pngBytes(4, 4);
    const pngB = pngBytes(5, 5, [200, 10, 10]);
    const entryA = core.addEntry({ entries: [{ key: 'png', bytes: pngA }] });
    const entryB = core.addEntry({ entries: [{ key: 'png', bytes: pngB }] });
    const hashA = core.get(entryA.id).assetHash;
    const hashB = core.get(entryB.id).assetHash;
    const group = { id: 'group_cas', title: '组', revision: 0, images: [{ id: 'i1', assetHash: hashA }], notes: [], comment: '', view: {} };
    const saved = core.saveGroup({ id: 'group_cas', revision: 0, document: JSON.stringify(group), assetHashes: [hashA] });
    assert.equal(saved.revision, 1, '首存从 0 变 1');
    assert.throws(() => core.saveGroup({ id: 'group_cas', revision: 0, document: JSON.stringify(group), assetHashes: [hashA] }),
      error => error.code === 'REVISION_CONFLICT');
    const group2 = { ...group, revision: 1, images: [{ id: 'i1', assetHash: hashA }, { id: 'i2', assetHash: hashB }] };
    const second = core.saveGroup({ id: 'group_cas', revision: 1, document: JSON.stringify(group2), assetHashes: [hashA, hashB] });
    assert.equal(second.revision, 2);
    assert.deepEqual(core.groupAssetHashes('group_cas').sort(), [hashA, hashB].sort());
    assert.equal(core.assetSize(hashA).width, 4);
    assert.equal(core.getGroup('group_cas').revision, 2);
  } finally { core.close(); }
});

test('组引用保护：被组引用的图不被清理，未引用的待清理项才走', () => {
  const root = tempRoot();
  const old = Date.now() - 40 * 24 * 3600 * 1000;
  let core = createStoreCore({ root, now: () => old });
  const png = pngBytes(6, 6);
  const entry = core.addEntry({ entries: [{ key: 'png', bytes: png }] });
  const hash = core.get(entry.id).assetHash;
  const plain = core.addEntry({ entries: [{ key: 'text', bytes: textBytes('旧文本') }] });
  core.saveGroup({ id: 'group_protect', revision: 1, title: '保护组', document: JSON.stringify({ id: 'group_protect', title: '保护组', revision: 1, images: [{ id: 'i1', assetHash: hash }], notes: [], comment: '', view: {} }), assetHashes: [hash] });
  core.close();
  core = createStoreCore({ root, now: () => Date.now() });
  try {
    const result = core.cleanup({ retentionDays: 30 });
    assert.equal(result.removed, 1, '只清掉那条没有引用的旧文本');
    assert.ok(core.get(entry.id), '被组引用的图还在');
    assert.equal(core.get(plain.id), undefined);
    assert.ok(fs.existsSync(path.join(root, 'blobs', `${hash}.bin`)));
  } finally { core.close(); }
});

test('临时 pin 由存储 worker 持有：清理跳过 pin，按 owner 释放', () => {
  const root = tempRoot();
  let clock = Date.now() - 40 * 24 * 3600 * 1000;
  const core = createStoreCore({ root, now: () => clock });
  try {
    const entry = core.addEntry({ entries: [{ key: 'png', bytes: pngBytes(7, 7) }] });
    const hash = core.get(entry.id).assetHash;
    core.pin('export-1', hash, '导出');
    clock = Date.now();
    assert.equal(core.cleanup({ retentionDays: 30 }).removed, 0, 'pin 还在，不删');
    core.release('export-1');
    assert.equal(core.cleanup({ retentionDays: 30 }).removed, 1, '释放后才清');
  } finally { core.close(); }
});

test('5000 条一页查询：只读一页，不全量解码', () => {
  const root = tempRoot();
  const core = createStoreCore({ root });
  try {
    for (let index = 0; index < 5000; index++) {
      core.addEntry({ entries: [{ key: 'text', bytes: textBytes(`批量 ${index}`) }], source: index % 3 ? 'chrome' : 'notepad' });
    }
    const started = process.hrtime.bigint();
    const page = core.list({ page: 2 });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(page.total, 5000);
    assert.equal(page.rows.length, 50);
    assert.ok(ms < 500, `一页查询应远小于 500ms，实际 ${ms.toFixed(1)}ms`);
    const filtered = core.list({ query: '批量 4999' });
    assert.equal(filtered.total, 1);
  } finally { core.close(); }
});

test('worker 客户端：ready、窄请求、二进制往返、关闭后拒绝', async () => {
  const root = tempRoot();
  const store = createClipboardStore({ root });
  try {
    assert.equal(await store.open(), true);
    const added = await store.addEntry({ entries: [{ key: 'png', bytes: pngBytes(8, 8) }] });
    assert.equal(added.duplicate, false);
    const row = await store.get(added.id);
    assert.equal(row.width, 8);
    const png = await store.readBlob(row.assetHash);
    assert.ok(Buffer.isBuffer(png));
    assert.equal(png.length, pngBytes(8, 8).length);
    const page = await store.list({ page: 1 });
    assert.equal(page.total, 1);
    await store.close();
    await assert.rejects(() => store.list({ page: 1 }), /存储已关闭/);
  } finally { await store.close(); }
});

test('worker 查询期间主线程定时器仍在跑：同步 DB 不堵主进程', async () => {
  const root = tempRoot();
  // 先同步建 5000 条，再用 worker 查询。
  const core = createStoreCore({ root });
  for (let index = 0; index < 5000; index++) {
    core.addEntry({ entries: [{ key: 'text', bytes: textBytes(`并发 ${index}`) }] });
  }
  core.close();
  const store = createClipboardStore({ root });
  try {
    await store.open();
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 5);
    // 连续发 30 个查询，强制 worker 在后台忙一段时间。
    const batch = (async () => { for (let round = 0; round < 30; round++) await store.list({ page: 3, query: '并发' }); })();
    await Promise.all([batch, new Promise(resolve => setTimeout(resolve, 80))]);
    clearInterval(timer);
    assert.ok(ticks >= 5, `主线程在等待查询时应有心跳，实际 ${ticks} 次`);
  } finally { await store.close(); }
});

test('text 预览按 UTF-16LE 解码：中文与 emoji 不乱码，中文搜索命中，原字节去重', () => {
  const core = createStoreCore({ root: tempRoot() });
  try {
    const bytes = textBytes('会议纪要：周五发版 🙂');
    const added = core.addEntry({ entries: [{ key: 'text', bytes }], source: 'notepad' });
    const row = core.get(added.id);
    assert.equal(row.text, '会议纪要：周五发版 🙂');
    assert.equal(row.kind, 'text');
    assert.equal(row.preview, '会议纪要：周五发版 🙂');
    assert.equal(core.list({ query: '发版' }).total, 1);
    assert.equal(core.list({ query: '周五' }).total, 1);
    const again = core.addEntry({ entries: [{ key: 'text', bytes: textBytes('会议纪要：周五发版 🙂') }] });
    assert.equal(again.duplicate, true, '同一份 UTF-16LE 字节应当去重');
  } finally { core.close(); }
});

test('关闭时有在途请求：先等在途落定再终止 worker，之后不再接新请求', async () => {
  const { EventEmitter } = require('node:events');
  let terminated = false;
  const worker = new EventEmitter();
  worker.postMessage = message => {
    setTimeout(() => worker.emit('message', { id: message.id, ok: true, result: { rows: [], total: 0, pages: 1, page: 1 } }), 120);
  };
  worker.terminate = async () => { terminated = true; };
  const store = createClipboardStore({ root: tempRoot(), workerFactory: () => {
    setTimeout(() => worker.emit('message', { id: 0, ok: true, ready: true }), 5);
    return worker;
  } });
  await store.open();
  const pending = store.list({ page: 1 });
  const started = Date.now();
  const closing = store.close({ timeout: 3000 });
  const result = await pending;
  assert.equal(result.page, 1, '在途查询要先拿到结果，不能直接被打断');
  await closing;
  assert.ok(Date.now() - started >= 90, '确实等过在途请求');
  assert.equal(terminated, true, '结束后才 terminate');
  await assert.rejects(() => store.list({ page: 1 }), /已关闭/);
});

// ——— FIX-01：剪贴板配额、孤儿 blob 与引用清理 ———
const DAY = 24 * 3600 * 1000;
const blobFile = (root, hash) => path.join(root, 'blobs', `${hash}.bin`);

test('FIX-01 清理一轮即可回收本轮新孤儿，不等下一轮', () => {
  const root = tempRoot();
  const old = Date.now() - 40 * DAY;
  let core = createStoreCore({ root, now: () => old });
  const entry = core.addEntry({ entries: [{ key: 'png', bytes: pngBytes(9, 9) }] });
  const hash = core.get(entry.id).assetHash;
  core.close();
  assert.ok(fs.existsSync(blobFile(root, hash)), '清理前原件在');
  core = createStoreCore({ root, now: () => Date.now() });
  try {
    const result = core.cleanup({ retentionDays: 30 });
    assert.equal(result.removed, 1);
    assert.equal(core.get(entry.id), undefined);
    assert.equal(fs.existsSync(blobFile(root, hash)), false, '一轮就回收，不留到下一轮');
    assert.equal(core.stats().blobs, 0);
  } finally { core.close(); }
});

test('FIX-01 超过内联阈值的文本 blob 计入配额回收与预检', () => {
  const root = tempRoot();
  const old = Date.now() - 40 * DAY;
  let core = createStoreCore({ root, now: () => old });
  const big = textBytes('q'.repeat(100 * 1024)); // UTF-16LE 200KiB，走 blob
  core.addEntry({ entries: [{ key: 'text', bytes: big }] });
  const before = core.stats().blobs;
  assert.ok(before > INLINE_LIMIT, '这条文本确实落了 blob');
  core.close();
  core = createStoreCore({ root, now: () => Date.now() });
  try {
    const preview = core.cleanup({ maxStorageBytes: 1024, dryRun: true });
    assert.ok(preview.count >= 1, '预检应选中这条大文本，而不是因为 asset_hash 为空漏掉');
    assert.ok(preview.freedBytes > 0, '预检应给出可回收字节');
    const result = core.cleanup({ maxStorageBytes: 1024 });
    assert.equal(result.removed, 1);
    assert.ok(core.stats().blobs < before, '实际占用下降');
  } finally { core.close(); }
});

test('FIX-01 共享 blob 在最后一个引用删除后才回收，不误删', () => {
  const root = tempRoot();
  const old = Date.now() - 40 * DAY;
  let core = createStoreCore({ root, now: () => old });
  const png = pngBytes(10, 10);
  const a = core.addEntry({ entries: [{ key: 'png', bytes: png }], source: 'a' });
  const b = core.addEntry({ entries: [{ key: 'png', bytes: png }, { key: 'text', bytes: textBytes('附注') }], source: 'b' });
  assert.notEqual(a.id, b.id);
  const hash = core.get(a.id).assetHash;
  assert.equal(core.get(b.id).assetHash, hash, '两条共享同一 blob');
  core.setFavorite(b.id, true);
  core.close();
  core = createStoreCore({ root, now: () => Date.now() });
  try {
    assert.equal(core.cleanup({ retentionDays: 30 }).removed, 1, '只删 a');
    assert.ok(fs.existsSync(blobFile(root, hash)), 'b 还引用，blob 保留');
    core.setFavorite(b.id, false);
    assert.equal(core.cleanup({ retentionDays: 30 }).removed, 1, '删 b');
    assert.equal(fs.existsSync(blobFile(root, hash)), false, '最后一个引用消失才回收');
  } finally { core.close(); }
});

test('FIX-01 删除文件失败保留可重试记录，下次重启能回收', () => {
  const root = tempRoot();
  const old = Date.now() - 40 * DAY;
  let core = createStoreCore({ root, now: () => old });
  const entry = core.addEntry({ entries: [{ key: 'png', bytes: pngBytes(11, 11) }] });
  const hash = core.get(entry.id).assetHash;
  core.close();
  const failFs = Object.create(fs);
  let failed = false;
  failFs.unlinkSync = function (p) {
    if (!failed && p === blobFile(root, hash)) { failed = true; const e = new Error('拒绝访问'); e.code = 'EACCES'; throw e; }
    return fs.unlinkSync(p);
  };
  core = createStoreCore({ root, now: () => Date.now(), fsImpl: failFs });
  try {
    assert.equal(core.cleanup({ retentionDays: 30 }).removed, 1);
    assert.equal(failed, true);
    assert.ok(core.stats().blobs > 0, 'unlink 失败，记录保留待重试');
    assert.ok(fs.existsSync(blobFile(root, hash)));
  } finally { core.close(); }
  core = createStoreCore({ root, now: () => Date.now() });
  try {
    core.cleanup({ retentionDays: 30 });
    assert.equal(core.stats().blobs, 0, '恢复后重试回收成功');
  } finally { core.close(); }
});

test('FIX-01 容量清理下共享 blob 的最后引用被删后才释放', () => {
  const root = tempRoot();
  const core = createStoreCore({ root });
  try {
    const png = pngBytes(15, 15);
    const hash = core.get(core.addEntry({ entries: [{ key: 'png', bytes: png }] }).id).assetHash;
    // 三条不同 content_key 但共享同一 blob：附加文本让去重键不同。
    core.addEntry({ entries: [{ key: 'png', bytes: png }, { key: 'text', bytes: textBytes('甲') }] });
    core.addEntry({ entries: [{ key: 'png', bytes: png }, { key: 'text', bytes: textBytes('乙') }] });
    const before = core.stats().blobs;
    assert.ok(before > 0);
    // 容量压到远小于这份 blob：必须把三条引用全删掉才能真正释放。
    const result = core.cleanup({ maxStorageBytes: 1 });
    assert.equal(result.removed, 3, '三条共享引用都进入删除集合');
    assert.equal(core.stats().blobs, 0, '最后引用消失，blob 释放');
    assert.equal(fs.existsSync(blobFile(root, hash)), false);
  } finally { core.close(); }
});

test('FIX-01 写入预算不重复计入已存在的共享 blob', () => {
  const root = tempRoot();
  const core = createStoreCore({ root });
  try {
    const png = pngBytes(12, 12);
    const size = png.length;
    // 只容得下一份 blob 原件；第二条复用同一张图，若重复计费就必然 QUOTA_FULL。
    core.setQuota(size);
    assert.equal(core.addEntry({ entries: [{ key: 'png', bytes: png }] }).duplicate, false);
    const b = core.addEntry({ entries: [{ key: 'png', bytes: png }, { key: 'text', bytes: textBytes('附注') }] });
    assert.equal(b.duplicate, false, '新 content key');
    assert.equal(core.list({}).total, 2, '共享 blob 不该被重复计预算挡住');
    assert.equal(core.stats().blobs, size, '磁盘上只有一份 blob');
  } finally { core.close(); }
});

test('FIX-01 事务失败残留的未登记 blob 文件被安全对账回收', () => {
  const root = tempRoot();
  const core = createStoreCore({ root });
  try {
    const stray = 'a'.repeat(64);
    fs.writeFileSync(blobFile(root, stray), Buffer.from('orphan'));
    const entry = core.addEntry({ entries: [{ key: 'png', bytes: pngBytes(13, 13) }] });
    const hash = core.get(entry.id).assetHash;
    const result = core.cleanup({});
    assert.ok(result.orphans >= 1, '回收了未登记文件');
    assert.equal(fs.existsSync(blobFile(root, stray)), false);
    assert.ok(fs.existsSync(blobFile(root, hash)), '被引用的 blob 不动');
  } finally { core.close(); }
});

test('FIX-01 清理预检与执行结果一致', () => {
  const root = tempRoot();
  const old = Date.now() - 40 * DAY;
  let core = createStoreCore({ root, now: () => old });
  core.addEntry({ entries: [{ key: 'png', bytes: pngBytes(14, 14) }] });
  const keep = core.addEntry({ entries: [{ key: 'text', bytes: textBytes('保留') }] });
  core.setPinned(keep.id, true);
  core.close();
  core = createStoreCore({ root, now: () => Date.now() });
  try {
    const preview = core.cleanup({ retentionDays: 30, dryRun: true });
    const result = core.cleanup({ retentionDays: 30 });
    assert.equal(preview.count, result.removed);
    assert.deepEqual(preview.ids, result.ids);
    assert.ok(core.get(keep.id), '置顶项始终保留');
  } finally { core.close(); }
});
