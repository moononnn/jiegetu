/* 剪贴板历史的纯规则：格式白名单、去重键、分类、安全文本预览、CF_HTML 头、分页与配额。
   不碰 fs、不碰 SQLite、不碰 Electron，main / worker / 历史页共用同一份判定。
   这里不做网络识别：链接只是文本的一个展示分类，不发请求、不解析域名。 */
'use strict';

const crypto = require('node:crypto');

// 只认这些格式。未知/虚拟文件/句柄依赖格式一律不进历史，也不伪造恢复成功。
const FORMATS = Object.freeze({
  text: Object.freeze({ name: 'CF_UNICODETEXT', kind: 'text', limit: 16 * 1024 * 1024 }),
  html: Object.freeze({ name: 'CF_HTML', kind: 'text', limit: 16 * 1024 * 1024 }),
  rtf: Object.freeze({ name: 'RTF', kind: 'text', limit: 16 * 1024 * 1024 }),
  png: Object.freeze({ name: 'PNG', kind: 'image', limit: 148 * 1024 * 1024 }),
  dib: Object.freeze({ name: 'DIB', kind: 'image', limit: 148 * 1024 * 1024 }),
  files: Object.freeze({ name: 'CF_HDROP', kind: 'files', limit: 262144 })
});
// 稳定顺序：同样的格式集合无论到达顺序如何，排序后都必须得到同一个去重键。
const FORMAT_ORDER = Object.freeze(['text', 'html', 'rtf', 'png', 'dib', 'files']);
const MAX_RAW_TOTAL = 256 * 1024 * 1024;
const MAX_FILE_ITEMS = 1024;
const MAX_FILE_CHARS = 262144;
const MAX_PREVIEW_CHARS = 2000;
const MAX_COVER_TEXT = 120;
const PAGE_SIZE = 50;
const KINDS = Object.freeze(['text', 'link', 'image', 'files']);
const DEDUPE_VERSION = 'v1';

const isBytes = value => Buffer.isBuffer(value) || value instanceof Uint8Array;

function formatOf(key) {
  if (typeof key !== 'string' || !Object.hasOwn(FORMATS, key)) throw new Error('不支持的剪贴板格式');
  return FORMATS[key];
}
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

// 校验一组原始负载：只接受白名单 key、真实字节、非空、单格式不超限、总量不超限。
// 返回按稳定顺序排好的 [{key, bytes}]，调用方不能靠输入顺序决定存储顺序。
function normalizeEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('剪贴板内容为空');
  if (entries.length > FORMAT_ORDER.length) throw new Error('格式数量超过上限');
  const seen = new Set();
  let total = 0;
  const list = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') throw new Error('剪贴板格式项无效');
    const format = formatOf(entry.key);
    if (seen.has(entry.key)) throw new Error(`剪贴板格式重复：${entry.key}`);
    seen.add(entry.key);
    if (isBytes(entry.bytes)) {
      const size = entry.bytes.byteLength;
      if (size < 1) throw new Error(`${format.name} 内容为空`);
      if (size > format.limit) throw new Error(`${format.name} 超出 ${format.limit} 字节上限`);
      total += size;
      list.push({ key: entry.key, size, bytes: entry.bytes });
    } else if (Array.isArray(entry.paths)) {
      // 文件列表只存路径文本；数量与字符总量分别限制，超了明确拒绝，不悄悄截一半。
      const paths = entry.paths;
      if (!paths.length) throw new Error('文件列表为空');
      if (paths.length > MAX_FILE_ITEMS) throw new Error(`文件列表超过 ${MAX_FILE_ITEMS} 项上限`);
      let chars = 0;
      for (const item of paths) {
        if (typeof item !== 'string' || !item || item.includes('\0')) throw new Error('文件路径无效');
        chars += Array.from(item).length + 1;
      }
      if (chars > MAX_FILE_CHARS) throw new Error('文件路径总长度超出上限');
      total += chars;
      list.push({ key: 'files', size: chars, paths: paths.slice() });
    } else throw new Error(`${format.name} 缺少内容`);
  }
  if (total > MAX_RAW_TOTAL) throw new Error('这条内容总大小超出上限');
  return list.sort((a, b) => FORMAT_ORDER.indexOf(a.key) - FORMAT_ORDER.indexOf(b.key));
}

// 去重键：格式名 + 实际字节指纹，带版本前缀。来源/时间/备注/标签都不参与。
// 只文本相同不代表整条相同：HTML 变了就是另一条。
function dedupeKey(normalized) {
  const parts = [DEDUPE_VERSION];
  for (const item of normalized) {
    if (item.paths) {
      // 文件列表以路径的规范字符串参与，不做大小写或分隔符归一，避免把两个真实不同路径合并。
      parts.push(`files:${item.paths.join('\u0000')}`);
    } else parts.push(`${item.key}:${item.size}:${sha256(item.bytes)}`);
  }
  return sha256(parts.join('|'));
}

function textOf(normalized, key) {
  const item = normalized.find(entry => entry.key === key);
  if (!item) return undefined;
  if (item.paths) return item.paths.join('\r\n');
  // text 键就是 CF_UNICODETEXT 的原始字节（UTF-16LE，可带尾部终止符 NUL），
  // 展示/搜索/分类一律按这个契约解码，不靠“含很多 NUL”去猜编码。
  if (item.key === 'text') return decodeTextBytes(item.bytes);
  try { return new TextDecoder('utf-8', { fatal: false }).decode(item.bytes); } catch { return undefined; }
}

// CF_UNICODETEXT：去掉尾部成对的 0x00 0x00 终止符，内容本身不 trim、不替换。
function decodeTextBytes(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let end = buffer.length;
  while (end >= 2 && buffer[end - 1] === 0 && buffer[end - 2] === 0) end -= 2;
  return buffer.subarray(0, end).toString('utf16le');
}

// 本工具自己生成 text 负载时（如复制说明）用这个：UTF-16LE + 终止符，与原生捕获同一契约。
function encodeTextBytes(text) {
  return Buffer.concat([Buffer.from(String(text ?? ''), 'utf16le'), Buffer.from([0, 0])]);
}

// 单个 http(s) 绝对地址且没有空白才算链接。不解析 host、不发请求、不展开短链。
function isSingleLink(text) {
  if (typeof text !== 'string') return false;
  const value = text.trim();
  if (!value || value.length > 4000 || /\s/.test(value)) return false;
  if (!/^(?:https?|ftp):\/\/[^/]+/i.test(value)) return false;
  // 只接受可打印 ASCII 与常见 Unicode 路径字符；出现控制字符就不当链接。
  return !/[\u0000-\u001f\u007f]/.test(value);
}

// 分类用于筛选与「能不能入组」。主类型按 files > image > text 排；
// 混合内容靠 flags 说明，调用方不能因为 kind 是 image 就悄悄吞掉同一条里的文本。
function classify(normalized) {
  const keys = new Set(normalized.map(entry => entry.key));
  const hasImage = keys.has('png') || keys.has('dib');
  const hasFiles = keys.has('files');
  const hasText = keys.has('text') || keys.has('html') || keys.has('rtf');
  const link = !hasImage && !hasFiles && hasText && isSingleLink(textOf(normalized, 'text'));
  const kind = hasFiles ? 'files' : hasImage ? 'image' : link ? 'link' : 'text';
  return { kind, hasImage, hasFiles, hasText, link };
}

// 列表用的安全预览：HTML/RTF 只抽出纯文字，绝不给页面 innerHTML，也不加载远程资源。
function htmlToText(html) {
  let text = String(html ?? '');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(script|style|template|iframe|object|embed|svg)\b[\s\S]*?<\/\1>/gi, ' ');
  text = text.replace(/<(script|style|meta|link)[^>]*>/gi, ' ');
  text = text.replace(/<\/?(?:p|div|br|tr|li|h[1-6])\b[^>]*>/gi, '\n');
  text = text.replace(/<[^>]*>/g, ' ');
  text = decodeEntities(text);
  text = text.replace(/\r\n?/g, '\n').replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  return clip(text.trim(), MAX_PREVIEW_CHARS);
}

const NAMED_ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—' });
function decodeEntities(text) {
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (all, dec, hex, name) => {
    if (name) return Object.hasOwn(NAMED_ENTITIES, name.toLowerCase()) ? NAMED_ENTITIES[name.toLowerCase()] : all;
    const code = dec ? Number(dec) : Number.parseInt(hex, 16);
    if (!Number.isInteger(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return all;
    try { return String.fromCodePoint(code); } catch { return all; }
  });
}
function clip(text, max) {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
}

// RTF 预览：去掉控制字与分组，只保留可见文字。不做完整 RTF 渲染，宁可少显示也不执行任何东西。
function rtfToText(rtf) {
  let text = String(rtf ?? '');
  text = text.replace(/\\'([0-9a-f]{2})/gi, (all, hex) => {
    const code = Number.parseInt(hex, 16);
    return code >= 0x20 ? String.fromCharCode(code) : ' ';
  });
  text = text.replace(/\\u(-?\d+)\??/g, (all, dec) => {
    const code = Number(dec);
    return Number.isInteger(code) && code >= 0 && code <= 0xffff ? String.fromCharCode(code) : '';
  });
  text = text.replace(/\{\\\*[\s\S]*?\}/g, ' ');
  text = text.replace(/\\par[d]?\b/g, '\n');
  text = text.replace(/\\[a-z]+-?\d* ?/gi, ' ');
  text = text.replace(/[{}]/g, ' ');
  text = text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  return clip(text.trim(), MAX_PREVIEW_CHARS);
}

// CF_HTML：原字节按原样保存/恢复；新建时必须给出正确的 UTF-8 字节偏移头。
const CF_HTML_HEAD = /^Version:([^\r\n]+)\r\n(?:StartHTML:([^\r\n]+)\r\n)?(?:EndHTML:([^\r\n]+)\r\n)?(?:StartFragment:([^\r\n]+)\r\n)?(?:EndFragment:([^\r\n]+)\r\n)?/;
function readCfHtmlHeader(value) {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  if (!isBytes(bytes)) throw new Error('CF_HTML 内容无效');
  const text = Buffer.from(bytes).toString('utf8');
  const match = CF_HTML_HEAD.exec(text);
  if (!match) throw new Error('CF_HTML 缺少版本头');
  const num = raw => (raw === undefined ? undefined : Number(raw.trim()));
  const header = { version: match[1].trim(), startHtml: num(match[2]), endHtml: num(match[3]),
    startFragment: num(match[4]), endFragment: num(match[5]) };
  for (const [key, value2] of Object.entries(header)) {
    if (key === 'version') continue;
    if (value2 !== undefined && !(Number.isInteger(value2) && value2 >= 0)) throw new Error('CF_HTML 偏移无效');
  }
  return header;
}

// 生成 CF_HTML 原始字节：偏移按 UTF-8 字节算，中文与换行都必须对得上。
// 头长度本身依赖内容，所以先写占位宽度再回填，保证 StartHTML 等偏移指向真实字节。
function buildCfHtml(fragment, sourceUrl = '') {
  if (typeof fragment !== 'string') throw new Error('CF_HTML 片段无效');
  if (fragment.length > 16 * 1024 * 1024) throw new Error('CF_HTML 片段过大');
  const source = typeof sourceUrl === 'string' && /^(?:https?|file):\/\//i.test(sourceUrl) ? sourceUrl : '';
  const head = html => `Version:0.9\r\nStartHTML:${pad(html.start)}\r\nEndHTML:${pad(html.end)}` +
    `\r\nStartFragment:${pad(html.fragStart)}\r\nEndFragment:${pad(html.fragEnd)}\r\n`;
  const prefix = `<html><body>\r\n<!--StartFragment-->`;
  const suffix = `<!--EndFragment-->\r\n</body></html>`;
  const sourceLine = source ? `<meta http-equiv="Content-Type" content="text/html; charset=utf-8"><base href="${escapeAttribute(source)}">` : `<meta http-equiv="Content-Type" content="text/html; charset=utf-8">`;
  // 头里数字是固定 10 位，用 9 个前导 0 的估算法会随内容变化；这里多算一轮直到稳定。
  let draft = '';
  for (let round = 0; round < 3; round++) {
    const headText = head({ start: 0, end: 0, fragStart: 0, fragEnd: 0 });
    const bodyText = `<html><head>${sourceLine}</head><body>\r\n<!--StartFragment-->${fragment}<!--EndFragment-->\r\n</body></html>`;
    const startHtml = Buffer.byteLength(headText, 'utf8');
    const startFrag = startHtml + Buffer.byteLength(`<html><head>${sourceLine}</head><body>\r\n<!--StartFragment-->`, 'utf8');
    const endFrag = startFrag + Buffer.byteLength(fragment, 'utf8');
    const endHtml = startHtml + Buffer.byteLength(`<html><head>${sourceLine}</head><body>\r\n<!--StartFragment-->${fragment}<!--EndFragment-->\r\n</body></html>`, 'utf8');
    draft = head({ start: startHtml, end: endHtml, fragStart: startFrag, fragEnd: endFrag }) +
      `<html><head>${sourceLine}</head><body>\r\n<!--StartFragment-->${fragment}<!--EndFragment-->\r\n</body></html>`;
  }
  const bytes = Buffer.from(draft, 'utf8');
  // 自检：写出来的头必须能读回，且偏移真的指向片段与整段边界。
  const back = readCfHtmlHeader(bytes);
  const frag = Buffer.from(fragment, 'utf8');
  const decoded = Buffer.from(bytes.subarray(0, back.endHtml), 'utf8');
  const slice = Buffer.from(bytes.subarray(back.startFragment, back.endFragment), 'utf8');
  if (!slice.equals(frag) || back.endFragment > decoded.length) throw new Error('CF_HTML 偏移自校验失败');
  return bytes;
}
const pad = value => String(value).padStart(10, '0');
const escapeAttribute = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 历史列表预览：图给尺寸，文件给前几个名字，文本给安全抽出的字。
function previewOf(row) {
  if (!row || typeof row !== 'object') return { text: '', files: [], width: 0, height: 0 };
  const paths = Array.isArray(row.files) ? row.files.filter(item => typeof item === 'string' && item) : [];
  const text = typeof row.text === 'string' ? row.text : '';
  return { text: clip(text.replace(/\r\n?/g, '\n'), MAX_PREVIEW_CHARS), files: paths.slice(0, 8),
    fileCount: paths.length, width: row.width | 0, height: row.height | 0 };
}

// SQLite LIKE 的查询规范化：去首尾空白、限长、转义通配符。空查询返回 undefined。
function normalizeQuery(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return clip(text, 200).replace(/[\\%_]/g, match => `\\${match}`);
}

// 分页：页从 1 起，越界按真实总数夹回最后一页；每页条数固定，不接受页面自行放大。
function pageWindow(total, requested) {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('总数无效');
  const last = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Number.isInteger(requested) && requested >= 1 ? Math.min(requested, last) : 1;
  return { page, pageSize: PAGE_SIZE, pages: last, offset: (page - 1) * PAGE_SIZE, total };
}

// 配额：只算唯一 blob 的真实字节；条数限制与磁盘上限是两件事，不能混说。
// 返回值说明还能不能接纳新内容，以及超了多少。
function quotaState({ bytes, count, maxStorageBytes, maxHistoryItems }) {
  for (const value of [bytes, count, maxStorageBytes, maxHistoryItems]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('配额参数无效');
  }
  const overBytes = Math.max(0, bytes - maxStorageBytes);
  const overItems = Math.max(0, count - maxHistoryItems);
  return { full: overBytes > 0 || overItems > 0, overBytes, overItems,
    freeBytes: Math.max(0, maxStorageBytes - bytes), freeItems: Math.max(0, maxHistoryItems - count) };
}

// 待清理候选的排序：最久未用在前；受保护项（收藏/置顶/组引用/临时pin）永远不进候选。
function cleanupOrder(candidates) {
  if (!Array.isArray(candidates)) throw new Error('清理候选无效');
  return candidates
    .filter(item => item && !item.protected && Number.isSafeInteger(item.id))
    .sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0) || a.id - b.id);
}

module.exports = {
  FORMATS, FORMAT_ORDER, KINDS, PAGE_SIZE, DEDUPE_VERSION,
  MAX_RAW_TOTAL, MAX_FILE_ITEMS, MAX_FILE_CHARS, MAX_PREVIEW_CHARS, MAX_COVER_TEXT,
  normalizeEntries, dedupeKey, classify, isSingleLink, textOf, decodeTextBytes, encodeTextBytes,
  htmlToText, rtfToText, readCfHtmlHeader, buildCfHtml,
  previewOf, normalizeQuery, pageWindow, quotaState, cleanupOrder, sha256
};
