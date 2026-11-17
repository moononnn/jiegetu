/* 剪贴板私有存储：SQLite 与 blobs 的串行执行体，跑在独立 worker 线程里。
   renderer 永远不接触数据库；main 只通过异步客户端发窄请求。
   临时 pin 的权威 Map 必须留在这个 worker 里：清理、引用、配额都在同一条串行路径上检查。 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const model = require('../core/clipboard-model.cjs');

const INLINE_LIMIT = 64 * 1024;
const DB_FILE = 'clipboard.sqlite';
const BLOB_DIR = 'blobs';
const PENDING_DIR = 'pending';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS content (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  asset_hash TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS content_part (
  content_key TEXT NOT NULL,
  format TEXT NOT NULL,
  size INTEGER NOT NULL,
  inline_bytes BLOB,
  blob_key TEXT,
  paths TEXT,
  PRIMARY KEY (content_key, format)
);
CREATE TABLE IF NOT EXISTS blob (
  key TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  asset_hash TEXT,
  source TEXT NOT NULL DEFAULT '',
  source_path TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  preview TEXT NOT NULL DEFAULT '',
  files TEXT NOT NULL DEFAULT '',
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  favorite INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS history_recent ON history (pinned DESC, last_used_at DESC);
CREATE INDEX IF NOT EXISTS history_content ON history (content_key);
CREATE INDEX IF NOT EXISTS history_asset ON history (asset_hash);
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS history_tags (
  history_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (history_id, tag_id)
);
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  revision INTEGER NOT NULL,
  document TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_assets (
  group_id TEXT NOT NULL,
  asset_hash TEXT NOT NULL,
  PRIMARY KEY (group_id, asset_hash)
);
`;

const fail = (message, code) => {
  const error = new Error(message);
  if (code) error.code = code;
  throw error;
};

function createStoreCore({ root, now = () => Date.now(), fsImpl = fs } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('剪贴板库目录必须为主进程私有绝对路径');
  fsImpl.mkdirSync(root, { recursive: true });
  fsImpl.mkdirSync(path.join(root, BLOB_DIR), { recursive: true });
  fsImpl.mkdirSync(path.join(root, PENDING_DIR), { recursive: true });
  const db = new DatabaseSync(path.join(root, DB_FILE));
  db.exec(SCHEMA);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  // 启动核对：只清理本模块自己的 pending（本次进程未接管），不碰 blobs 里的正式文件。
  for (const name of fsImpl.readdirSync(path.join(root, PENDING_DIR))) {
    try { fsImpl.unlinkSync(path.join(root, PENDING_DIR, name)); } catch { /* 已被别的清理拿走。 */ }
  }

  // 配额上限由调用方注入（测试/设置用），避免为触发配额造超大文件。
  let quotaLimit = 2 * 1024 * 1024 * 1024;

  const pins = new Map();
  const pinnedHash = hash => {
    for (const value of pins.values()) if (value.hash === hash) return true;
    return false;
  };

  const blobPathOf = hash => path.join(root, BLOB_DIR, `${hash}.bin`);

  function writeBlob(hash, bytes) {
    const target = blobPathOf(hash);
    try { if (fsImpl.statSync(target).size === bytes.length) return target; } catch { /* 不存在就写。 */ }
    const temp = path.join(root, PENDING_DIR, `${hash}-${randomUUID()}.part`);
    fsImpl.writeFileSync(temp, bytes, { flag: 'w' });
    try { fsImpl.renameSync(temp, target); }
    catch (error) {
      try { fsImpl.unlinkSync(temp); } catch { /* 临时文件清理失败不改变结果。 */ }
      if (!(error && error.code === 'EEXIST')) fail(`私有原件写入失败：${error?.message || error}`);
    }
    return target;
  }

  function readBlob(hash) {
    const file = blobPathOf(hash);
    try { return fsImpl.readFileSync(file); } catch { fail('私有原件已不可读', 'ASSET_BROKEN'); }
  }

  function dbBytes() {
    try { return fsImpl.statSync(path.join(root, DB_FILE)).size; } catch { return 0; }
  }
  function storedBytes() {
    const row = db.prepare('SELECT COALESCE(SUM(size),0) AS total FROM blob').get();
    return Number(row.total) || 0;
  }
  function historyCount() {
    return Number(db.prepare('SELECT COUNT(*) AS n FROM history').get().n) || 0;
  }
  function groupHashes() {
    return new Set(db.prepare('SELECT DISTINCT asset_hash AS hash FROM group_assets').all().map(row => row.hash).filter(Boolean));
  }

  // 显式删除一条历史：只动本模块管理的行，不删用户目录里的原文件。
  function removeHistory(id) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT * FROM history WHERE id = ?').get(id);
      if (!row) { db.exec('ROLLBACK'); fail('要删除的记录不存在'); }
      if (row.asset_hash && pinnedHash(row.asset_hash)) { db.exec('ROLLBACK'); fail('这条内容正被编辑或导出占用，稍后再删'); }
      db.prepare('DELETE FROM history_tags WHERE history_id = ?').run(id);
      db.prepare('DELETE FROM history WHERE id = ?').run(id);
      db.exec('COMMIT');
      return { id, contentKey: row.content_key };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* 已回滚。 */ }
      throw error;
    }
  }

  // 提交一条新复制。同内容只更新最近使用；格式不同就是另一条。
  // 每个格式的原始字节都要留住：复制时可以按原格式还原，不是只还原一个文本。
  function addEntry({ entries, source = '', sourcePath = '', assetHash } = {}) {
    const normalized = model.normalizeEntries(entries);
    const key = model.dedupeKey(normalized);
    const classification = model.classify(normalized);
    const text = previewTextOf(normalized);
    const files = filesOf(normalized);
    const png = normalized.find(item => item.key === 'png');
    const image = png ? pngSize(png.bytes) : { width: 0, height: 0 };
    const storedHash = classification.hasImage ? (assetHash || (png ? model.sha256(png.bytes) : null)) : null;
    if (storedHash && !/^[0-9a-f]{64}$/.test(storedHash)) fail('图片原件指纹无效');
    const stamp = now();

    const duplicate = db.prepare('SELECT key FROM content WHERE key = ?').get(key);
    const newBytes = duplicate ? 0 : normalized
      // 图片一律进 blob；文本只在超过内联阈值时才进 blob。
      .reduce((sum, item) => sum + (!item.paths && (item.key === 'png' || item.size > INLINE_LIMIT) ? item.size : 0), 0);
    // 配额上限由调用方注入（测试/设置用）；串行路径上没有并发窗口。
    if (!duplicate && storedBytes() + newBytes > quotaLimit) fail('剪贴板历史已满，先清理或调高上限', 'QUOTA_FULL');

    // 先把每个格式的字节落定（小文本内联，其余写 blob），再开事务。
    const parts = duplicate ? [] : normalized.map(item => {
      if (item.paths) return { format: item.key, size: item.size, paths: item.paths, inline: null, blobKey: null };
      if (item.key === 'png' || item.size > INLINE_LIMIT) {
        const hash = model.sha256(item.bytes);
        writeBlob(hash, item.bytes);
        return { format: item.key, size: item.size, paths: null, inline: null, blobKey: hash };
      }
      return { format: item.key, size: item.size, paths: null, inline: item.bytes, blobKey: null };
    });

    db.exec('BEGIN IMMEDIATE');
    try {
      if (!duplicate) {
        db.prepare('INSERT INTO content (key, kind, asset_hash, created_at) VALUES (?, ?, ?, ?)')
          .run(key, classification.kind, storedHash, stamp);
        for (const part of parts) {
          db.prepare(`INSERT INTO content_part (content_key, format, size, inline_bytes, blob_key, paths)
            VALUES (?, ?, ?, ?, ?, ?)`)
            .run(key, part.format, part.size, part.inline || null, part.blobKey,
              part.paths ? JSON.stringify(part.paths) : null);
          if (part.blobKey) {
            // 唯一 blob 只记一次体积：同 hash 共用一份文件，不重复计入预算。
            const known = db.prepare('SELECT size FROM blob WHERE key = ?').get(part.blobKey);
            if (!known) db.prepare('INSERT INTO blob (key, size, path) VALUES (?, ?, ?)')
              .run(part.blobKey, part.size, blobPathOf(part.blobKey));
          }
        }
      }
      const existing = db.prepare('SELECT id FROM history WHERE content_key = ?').get(key);
      if (existing) {
        db.prepare('UPDATE history SET last_used_at = ?, source = ?, source_path = ? WHERE id = ?')
          .run(stamp, source, sourcePath, existing.id);
        db.exec('COMMIT');
        return { id: existing.id, duplicate: true, key };
      }
      const preview = model.previewOf({ text, files, width: image.width, height: image.height });
      const result = db.prepare(`INSERT INTO history (content_key, kind, asset_hash, source, source_path, text, preview, files,
        width, height, note, favorite, pinned, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, 0, ?, ?)`)
        .run(key, classification.kind, storedHash, source, sourcePath, text,
          preview.text, JSON.stringify(files), image.width, image.height, stamp, stamp);
      db.exec('COMMIT');
      return { id: Number(result.lastInsertRowid), duplicate: false, key };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* 已回滚。 */ }
      throw error;
    }
  }

  function previewTextOf(normalized) {
    const html = normalized.find(item => item.key === 'html');
    const rtf = normalized.find(item => item.key === 'rtf');
    const text = normalized.find(item => item.key === 'text');
    // text 是 CF_UNICODETEXT 原字节（UTF-16LE）；HTML/RTF 才是 UTF-8。
    if (text) return model.decodeTextBytes(text.bytes);
    if (html) return model.htmlToText(decodeUtf8(html.bytes));
    if (rtf) return model.rtfToText(decodeUtf8(rtf.bytes));
    return '';
  }
  const decodeUtf8 = bytes => new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  function filesOf(normalized) {
    const item = normalized.find(entry => entry.paths);
    return item ? item.paths : [];
  }

  // 只读 PNG 头：签名/IHDR/宽高，不解码整图。坏头就是坏资产，明确拒绝。
  function pngSize(bytes) {
    const buf = Buffer.from(bytes);
    if (buf.length < 33 || buf.readUInt32BE(8) !== 13 || buf.toString('ascii', 12, 16) !== 'IHDR') fail('PNG 头无效', 'ASSET_BROKEN');
    const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
        width > 30000 || height > 30000 || width * height > 36000000) fail('PNG 尺寸超出编辑容量', 'ASSET_BROKEN');
    return { width, height };
  }

  function parseRow(row) {
    if (!row) return undefined;
    return {
      id: Number(row.id), kind: row.kind, source: row.source || '', sourcePath: row.source_path || '',
      text: row.text || '', preview: row.preview || '',
      files: parseFiles(row.files), width: Number(row.width) || 0, height: Number(row.height) || 0,
      note: row.note || '', favorite: row.favorite === 1, pinned: row.pinned === 1,
      createdAt: Number(row.created_at), lastUsedAt: Number(row.last_used_at),
      assetHash: row.asset_hash || null, tags: row.tags ? String(row.tags).split('\u001f').filter(Boolean) : []
    };
  }
  function parseFiles(value) {
    if (!value) return [];
    try { const list = JSON.parse(value); return Array.isArray(list) ? list.filter(item => typeof item === 'string') : []; }
    catch { return []; }
  }

  function list({ query, kind, source, favorite, page, pageSize, tag } = {}) {
    const where = [];
    const args = [];
    if (query !== undefined && query !== null && String(query).trim()) {
      const like = `%${model.normalizeQuery(String(query))}%`;
      where.push('(h.text LIKE ? ESCAPE \'\\\' OR h.note LIKE ? ESCAPE \'\\\' OR h.source LIKE ? ESCAPE \'\\\' OR h.preview LIKE ? ESCAPE \'\\\')');
      args.push(like, like, like, like);
    }
    if (kind !== undefined && kind !== null && kind !== '') {
      if (!model.KINDS.includes(kind)) fail('筛选类型无效');
      where.push('h.kind = ?'); args.push(kind);
    }
    if (typeof source === 'string' && source.trim()) { where.push('h.source LIKE ?'); args.push(`%${source.trim()}%`); }
    if (favorite === true) where.push('h.favorite = 1');
    if (typeof tag === 'string' && tag.trim()) {
      where.push('EXISTS (SELECT 1 FROM history_tags ht JOIN tags t ON t.id = ht.tag_id WHERE ht.history_id = h.id AND t.name = ?)');
      args.push(tag.trim());
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM history h ${clause}`).get(...args).n) || 0;
    const window = model.pageWindow(total, page);
    const size = Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 100 ? pageSize : window.pageSize;
    const rows = db.prepare(`SELECT h.*,
      (SELECT GROUP_CONCAT(t.name, char(31)) FROM history_tags ht JOIN tags t ON t.id = ht.tag_id WHERE ht.history_id = h.id) AS tags
      FROM history h ${clause}
      ORDER BY h.pinned DESC, h.last_used_at DESC, h.id DESC
      LIMIT ? OFFSET ?`).all(...args, size, window.offset);
    return { rows: rows.map(parseRow), total, ...window, pageSize: size };
  }

  function get(id) {
    const row = db.prepare(`SELECT h.*,
      (SELECT GROUP_CONCAT(t.name, char(31)) FROM history_tags ht JOIN tags t ON t.id = ht.tag_id WHERE ht.history_id = h.id) AS tags
      FROM history h WHERE h.id = ?`).get(id);
    return parseRow(row);
  }

  // 复制负载：按格式还原原始字节；文件格式给路径列表。
  function contentOf(id) {
    const row = db.prepare('SELECT c.key, c.kind, c.asset_hash FROM content c JOIN history h ON h.content_key = c.key WHERE h.id = ?').get(id);
    if (!row) fail('记录内容不存在');
    const parts = db.prepare('SELECT * FROM content_part WHERE content_key = ?').all(row.key).map(part => ({
      format: part.format, size: Number(part.size),
      bytes: part.inline_bytes ? Buffer.from(part.inline_bytes) : undefined,
      blobKey: part.blob_key || null,
      paths: part.paths ? parseFiles(part.paths) : []
    }));
    return { key: row.key, kind: row.kind, assetHash: row.asset_hash || null, parts };
  }

  function setFavorite(id, value) {
    if (!db.prepare('SELECT id FROM history WHERE id = ?').get(id)) fail('记录不存在');
    db.prepare('UPDATE history SET favorite = ? WHERE id = ?').run(value === true ? 1 : 0, id);
    return get(id);
  }
  function setPinned(id, value) {
    if (!db.prepare('SELECT id FROM history WHERE id = ?').get(id)) fail('记录不存在');
    db.prepare('UPDATE history SET pinned = ? WHERE id = ?').run(value === true ? 1 : 0, id);
    return get(id);
  }
  // 从历史再次复制：只把最近使用推到当前，不新建条目、不改原内容。
  function touch(id) {
    if (!Number.isSafeInteger(id) || id <= 0) fail('记录标识无效');
    const row = db.prepare('SELECT id FROM history WHERE id = ?').get(id);
    if (!row) fail('记录不存在');
    db.prepare('UPDATE history SET last_used_at = ? WHERE id = ?').run(now(), id);
    return { id };
  }
  function setNote(id, text) {
    if (typeof text !== 'string' || text.length > 4000) fail('备注无效或过长');
    if (!db.prepare('SELECT id FROM history WHERE id = ?').get(id)) fail('记录不存在');
    db.prepare('UPDATE history SET note = ? WHERE id = ?').run(text, id);
    return get(id);
  }
  function setTags(id, names) {
    if (!Array.isArray(names) || names.length > 20) fail('标签无效');
    const clean = [];
    for (const name of names) {
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 40) fail('标签无效');
      clean.push(name.trim());
    }
    if (!db.prepare('SELECT id FROM history WHERE id = ?').get(id)) fail('记录不存在');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM history_tags WHERE history_id = ?').run(id);
      for (const name of clean) {
        let tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(name);
        if (!tag) { const r = db.prepare('INSERT INTO tags (name) VALUES (?)').run(name); tag = { id: Number(r.lastInsertRowid) }; }
        db.prepare('INSERT OR IGNORE INTO history_tags (history_id, tag_id) VALUES (?, ?)').run(id, tag.id);
      }
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* 已回滚。 */ } throw error; }
    return get(id);
  }

  // 临时 pin 由这个 worker 持有。owner 是窗口代次或导出 requestId；释放按 owner 整组放。
  function pin(owner, hash, reason = '') {
    if (typeof owner !== 'string' || !owner) fail('pin 归属无效');
    if (!/^[0-9a-f]{64}$/.test(hash)) fail('pin 资产指纹无效');
    pins.set(`${owner}\u0000${hash}`, { owner, hash, reason, at: now() });
    return pins.size;
  }
  function release(owner) {
    let count = 0;
    for (const [key, value] of [...pins]) if (value.owner === owner) { pins.delete(key); count++; }
    return count;
  }

  function stats() {
    const contents = Number(db.prepare('SELECT COUNT(*) AS n FROM content').get().n) || 0;
    const groupsCount = Number(db.prepare('SELECT COUNT(*) AS n FROM groups').get().n) || 0;
    return { history: historyCount(), contents, blobs: storedBytes(), dbBytes: dbBytes(), groups: groupsCount, pins: pins.size };
  }

  // 清理：只删本模块自己的、没有任何持久/临时引用的内容；受保护项永远不动。
  function cleanup({ retentionDays, maxHistoryItems, maxStorageBytes, dryRun = false } = {}) {
    const rows = db.prepare('SELECT id, asset_hash, created_at, last_used_at, favorite, pinned FROM history').all();
    const cutoff = Number.isFinite(retentionDays) && retentionDays > 0 ? now() - retentionDays * 24 * 3600 * 1000 : undefined;
    const protectedByGroup = groupHashes();
    const candidates = [];
    for (const row of rows) {
      if (row.favorite === 1 || row.pinned === 1) continue;
      if (row.asset_hash && protectedByGroup.has(row.asset_hash)) continue;
      if (row.asset_hash && pinnedHash(row.asset_hash)) continue;
      candidates.push({ id: Number(row.id), lastUsedAt: Number(row.last_used_at), createdAt: Number(row.created_at),
        assetHash: row.asset_hash || null });
    }
    let selected = [];
    if (cutoff !== undefined) selected = candidates.filter(item => item.createdAt < cutoff).sort((a, b) => a.id - b.id);
    if (Number.isSafeInteger(maxHistoryItems) && maxHistoryItems > 0) {
      const rest = candidates.filter(item => !selected.includes(item)).sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.id - b.id);
      const remove = Math.max(0, historyCount() - selected.length - maxHistoryItems);
      selected = selected.concat(rest.slice(0, remove));
    }
    if (Number.isSafeInteger(maxStorageBytes) && maxStorageBytes > 0 && storedBytes() > maxStorageBytes) {
      const rest = candidates.filter(item => !selected.includes(item)).sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.id - b.id);
      let bytes = storedBytes();
      for (const item of rest) {
        if (bytes <= maxStorageBytes) break;
        const size = item.assetHash ? Number(db.prepare('SELECT size FROM blob WHERE key = ?').get(item.assetHash)?.size) || 0 : 0;
        bytes -= size;
        selected.push(item);
      }
    }
    const unique = [...new Map(selected.map(item => [item.id, item])).values()].sort((a, b) => a.id - b.id);
    if (dryRun) return { ids: unique.map(item => item.id), count: unique.length, bytes: storedBytes() };
    for (const item of unique) removeHistory(item.id);
    // 孤儿 blob：不再被任何内容（文本大文件）或历史/组图片引用，也没有临时 pin。
    const referenced = new Set(db.prepare('SELECT DISTINCT blob_key AS key FROM content_part WHERE blob_key IS NOT NULL').all().map(row => row.key));
    for (const hash of groupHashes()) referenced.add(hash);
    for (const row of db.prepare('SELECT key, size FROM blob').all()) {
      if (referenced.has(row.key) || pinnedHash(row.key)) continue;
      const inHistory = db.prepare('SELECT 1 AS ok FROM history WHERE asset_hash = ?').get(row.key);
      if (inHistory) continue;
      try { fsImpl.unlinkSync(blobPathOf(row.key)); } catch { /* 文件可能已经不在了。 */ }
      db.prepare('DELETE FROM blob WHERE key = ?').run(row.key);
    }
    const deadContent = db.prepare('SELECT key FROM content c WHERE NOT EXISTS (SELECT 1 FROM history h WHERE h.content_key = c.key)').all();
    for (const row of deadContent) {
      db.prepare('DELETE FROM content_part WHERE content_key = ?').run(row.key);
      db.prepare('DELETE FROM content WHERE key = ?').run(row.key);
    }
    return { removed: unique.length, orphans: 0 };
  }

  // 组保存：CAS + 引用差集，全部在一个事务里；提交成功才回“已保存”。
  function saveGroup({ id, revision, document, assetHashes } = {}) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) fail('组标识无效');
    if (!Number.isSafeInteger(revision) || revision < 0) fail('组修订号无效');
    if (typeof document !== 'string' || document.length > 1024 * 1024) fail('组文档无效或超过 1MiB');
    const hashes = Array.isArray(assetHashes) ? [...new Set(assetHashes)] : [];
    for (const hash of hashes) {
      if (!/^[0-9a-f]{64}$/.test(hash)) fail('组资产指纹无效');
      if (!db.prepare('SELECT 1 AS ok FROM blob WHERE key = ?').get(hash)) fail('组引用了不存在的私有原件', 'ASSET_BROKEN');
    }
    let parsed;
    try { parsed = JSON.parse(document); } catch { fail('组文档不是有效 JSON'); }
    if (parsed.id !== id) fail('组文档与组标识不一致');
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare('SELECT revision FROM groups WHERE id = ?').get(id);
      if (current) {
        if (Number(current.revision) !== revision) fail('这个批注组已经在别处更新过，请重新打开', 'REVISION_CONFLICT');
        const next = revision + 1;
        const result = db.prepare('UPDATE groups SET title = ?, revision = ?, document = ?, updated_at = ? WHERE id = ? AND revision = ?')
          .run(parsed.title || '', next, document, now(), id, revision);
        if (Number(result.changes) !== 1) fail('保存批次已被另一次写入抢先，请重试', 'REVISION_CONFLICT');
        db.prepare('DELETE FROM group_assets WHERE group_id = ?').run(id);
        for (const hash of hashes) db.prepare('INSERT OR IGNORE INTO group_assets (group_id, asset_hash) VALUES (?, ?)').run(id, hash);
        db.exec('COMMIT');
        return { id, revision: next };
      }
      db.prepare('INSERT INTO groups (id, title, revision, document, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, parsed.title || '', revision + 1, document, now());
      for (const hash of hashes) db.prepare('INSERT OR IGNORE INTO group_assets (group_id, asset_hash) VALUES (?, ?)').run(id, hash);
      db.exec('COMMIT');
      return { id, revision: revision + 1 };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* 已回滚。 */ }
      throw error;
    }
  }

  function getGroup(id) {
    const row = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
    if (!row) return undefined;
    return { id: row.id, title: row.title, revision: Number(row.revision), document: row.document, updatedAt: Number(row.updated_at) };
  }
  function listGroups() {
    return db.prepare('SELECT id, title, revision, updated_at FROM groups ORDER BY updated_at DESC').all()
      .map(row => ({ id: row.id, title: row.title, revision: Number(row.revision), updatedAt: Number(row.updated_at) }));
  }
  function deleteGroup(id) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM group_assets WHERE group_id = ?').run(id);
      db.prepare('DELETE FROM groups WHERE id = ?').run(id);
      db.exec('COMMIT');
      return true;
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* 已回滚。 */ } throw error; }
  }
  function groupAssetHashes(id) {
    return db.prepare('SELECT asset_hash FROM group_assets WHERE group_id = ?').all(id).map(row => row.asset_hash);
  }

  // 只读探尺寸：blob 表记体积，尺寸读 PNG 头，不解码整图。
  function assetSize(hash) {
    if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
    if (!db.prepare('SELECT 1 AS ok FROM blob WHERE key = ?').get(hash)) return undefined;
    try { return pngSize(readBlob(hash)); } catch { return undefined; }
  }
  function assetSizes(hashes) {
    const table = {};
    for (const hash of hashes) { const size = assetSize(hash); if (size) table[hash] = size; }
    return table;
  }

  function close() { try { db.close(); } catch { /* 已关闭。 */ } }

  return {
    root, addEntry, list, get, contentOf, setFavorite, setPinned, setNote, setTags, touch,
    pin, release, cleanup, stats, saveGroup, getGroup, listGroups, deleteGroup, groupAssetHashes,
    assetSize, assetSizes, removeHistory, readBlob, writeBlob, pngSize, close,
    // 配额上限可由调用方注入（测试用），避免为触发配额造 3GiB 文件。
    setQuota(maxStorageBytes) { if (!Number.isSafeInteger(maxStorageBytes) || maxStorageBytes < 1) fail('配额上限无效'); quotaLimit = maxStorageBytes; },
    getQuota() { return quotaLimit; }
  };
}

// worker 线程入口：窄 JSON 请求，串行执行；每条都回 requestId。
function startWorker() {
  const { parentPort, workerData } = require('node:worker_threads');
  const core = createStoreCore({ root: workerData.root });
  if (Number.isSafeInteger(workerData.maxStorageBytes) && workerData.maxStorageBytes > 0) core.setQuota(workerData.maxStorageBytes);
  parentPort.postMessage({ id: 0, ok: true, ready: true });
  let chain = Promise.resolve();
  parentPort.on('message', message => {
    const { id, method, params } = message || {};
    if (typeof id !== 'number' || typeof method !== 'string') return;
    chain = chain.then(() => {
      try {
        if (typeof core[method] !== 'function' || method === 'setQuota' || method === 'close') throw new Error('未知存储操作');
        const result = core[method](...(Array.isArray(params) ? params : [params]));
        parentPort.postMessage({ id, ok: true, result: serialize(result) });
      } catch (error) {
        parentPort.postMessage({ id, ok: false, error: { code: error?.code || 'STORE_ERROR', message: error?.message || '存储失败' } });
      }
    });
  });
}

// Buffer 不能直接过 postMessage 的 JSON 语义；二进制走 ArrayBuffer，其余原样。
function serialize(value) {
  if (Buffer.isBuffer(value)) return { __bytes: value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) };
  if (value instanceof Uint8Array) return { __bytes: value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) };
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = serialize(item);
    return out;
  }
  return value;
}

module.exports = { createStoreCore, INLINE_LIMIT, DB_FILE, BLOB_DIR, PENDING_DIR };

if (!require('node:worker_threads').isMainThread && require('node:worker_threads').workerData?.root) startWorker();
