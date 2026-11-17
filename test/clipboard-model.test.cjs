'use strict';
// 剪贴板纯规则：格式顺序无关的去重键、分类、安全预览、CF_HTML 偏移、分页与配额。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  FORMATS, MAX_FILE_ITEMS, PAGE_SIZE,
  normalizeEntries, dedupeKey, classify, isSingleLink,
  htmlToText, rtfToText, readCfHtmlHeader, buildCfHtml,
  previewOf, normalizeQuery, pageWindow, quotaState, cleanupOrder,
  textOf, decodeTextBytes, encodeTextBytes
} = require('../core/clipboard-model.cjs');

const utf8 = text => Buffer.from(text, 'utf8');
// text 键按 CF_UNICODETEXT 契约：UTF-16LE + 终止符；HTML/RTF 仍是 UTF-8。
const textBytes = value => Buffer.concat([Buffer.from(value, 'utf16le'), Buffer.from([0, 0])]);

test('格式集合顺序不影响去重键，同内容同键', () => {
  const a = normalizeEntries([{ key: 'text', bytes: textBytes('你好') }, { key: 'html', bytes: utf8('<p>你好</p>') }]);
  const b = normalizeEntries([{ key: 'html', bytes: utf8('<p>你好</p>') }, { key: 'text', bytes: textBytes('你好') }]);
  assert.equal(dedupeKey(a), dedupeKey(b));
  assert.deepEqual(a.map(item => item.key), ['text', 'html'], '永远按稳定顺序排');
  assert.notEqual(dedupeKey(a), dedupeKey(normalizeEntries([{ key: 'text', bytes: textBytes('你好') }])),
    '少一种格式就是另一条，不能合并');
});

test('元数据不参与去重：来源/时间/备注只在行上，不进键', () => {
  const normalized = normalizeEntries([{ key: 'text', bytes: textBytes('同一段字') }]);
  const key = dedupeKey(normalized);
  // dedupeKey 只吃 normalizeEntries 的输出，字段里没有来源与时间，任何附加元数据都进不来。
  assert.equal(dedupeKey(normalizeEntries([{ key: 'text', bytes: textBytes('同一段字') }])), key);
  assert.equal(typeof key, 'string');
  assert.equal(key.length, 64);
});

test('仅文本相同不代表整条相同：HTML 变化要算另一条', () => {
  const base = normalizeEntries([{ key: 'text', bytes: textBytes('标题') }, { key: 'html', bytes: utf8('<b>标题</b>') }]);
  const changed = normalizeEntries([{ key: 'text', bytes: textBytes('标题') }, { key: 'html', bytes: utf8('<i>标题</i>') }]);
  assert.notEqual(dedupeKey(base), dedupeKey(changed));
});

test('空、超限、重复格式、未知格式都明确拒绝，不悄悄截断', () => {
  assert.throws(() => normalizeEntries([]), /为空/);
  assert.throws(() => normalizeEntries([{ key: 'png', bytes: Buffer.alloc(0) }]), /为空/);
  assert.throws(() => normalizeEntries([{ key: 'text', bytes: textBytes('a') }, { key: 'text', bytes: textBytes('b') }]), /重复/);
  assert.throws(() => normalizeEntries([{ key: 'bogus', bytes: utf8('a') }]), /不支持/);
  const big = Buffer.alloc(16 * 1024 * 1024 + 1, 0x61);
  assert.throws(() => normalizeEntries([{ key: 'text', bytes: big }]), /16.*字节上限/i);
});

test('文件列表只存路径，数量与字符总量分别限制', () => {
  const ok = normalizeEntries([{ key: 'files', paths: ['C:\\a\\b.txt', 'C:\\c d\\e.png'] }]);
  assert.equal(ok[0].key, 'files');
  assert.equal(dedupeKey(ok), dedupeKey(normalizeEntries([{ key: 'files', paths: ['C:\\a\\b.txt', 'C:\\c d\\e.png'] }])));
  assert.throws(() => normalizeEntries([{ key: 'files', paths: [] }]), /为空/);
  const many = Array.from({ length: MAX_FILE_ITEMS + 1 }, (_, i) => `C:\\f${i}.txt`);
  assert.throws(() => normalizeEntries([{ key: 'files', paths: many }]), /上限/);
  assert.throws(() => normalizeEntries([{ key: 'files', paths: [''] }]), /路径无效/);
  assert.throws(() => normalizeEntries([{ key: 'files', paths: ['C:\\a\0b'] }]), /路径无效/);
});

test('分类：单链接归 link，图文混合靠 flags 说明，不吞掉文本', () => {
  assert.equal(classify(normalizeEntries([{ key: 'text', bytes: textBytes('https://example.com/a') }])).kind, 'link');
  assert.equal(classify(normalizeEntries([{ key: 'text', bytes: textBytes('看这个 https://a.cn') }])).kind, 'text');
  const mixed = classify(normalizeEntries([{ key: 'text', bytes: textBytes('说明') }, { key: 'png', bytes: utf8('PNG') }]));
  assert.equal(mixed.kind, 'image');
  assert.equal(mixed.hasText, true, '混合条目的文本必须可由调用方看到');
  const both = classify(normalizeEntries([{ key: 'text', bytes: textBytes('说明') }, { key: 'files', paths: ['C:\\x.txt'] }]));
  assert.equal(both.kind, 'files');
  assert.equal(both.hasText, true);
});

test('单链接判定：只认 http(s)/ftp 且无空白无控制字符，不发网络识别', () => {
  assert.equal(isSingleLink('https://example.com/x'), true);
  assert.equal(isSingleLink('  https://example.com/x  '), true);
  assert.equal(isSingleLink('https://example.com/a b'), false);
  assert.equal(isSingleLink('www.example.com'), false);
  assert.equal(isSingleLink('mailto:a@b.cn'), false);
  assert.equal(isSingleLink('javascript:alert(1)'), false);
  assert.equal(isSingleLink(null), false);
});

test('HTML 预览只抽文字：脚本/样式/标签消失，实体解码，远程资源不参与', () => {
  const html = '<html><head><style>p{color:red}</style><script>alert(1)</script></head><body><p>a &amp; b</p><p>第二段</p><img src="http://x/y.png"></body></html>';
  const text = htmlToText(html);
  assert.equal(text.includes('alert'), false);
  assert.equal(text.includes('color'), false);
  assert.equal(text.includes('<'), false);
  assert.equal(text.includes('http://x/y.png'), false, '图片地址不作为文字预览保留');
  assert.match(text, /a & b/);
  assert.match(text, /第二段/);
});

test('RTF 预览只留可见文字，不执行任何控制字', () => {
  const rtf = '{\\rtf1\\ansi{\\fonttbl{\\f0 宋体;}}\\f0 你好\\par 第二行\\u24352?}';
  const text = rtfToText(rtf);
  assert.match(text, /你好/);
  assert.match(text, /第二行/);
  assert.equal(text.includes('rtf1'), false);
  assert.equal(text.includes('fonttbl'), false);
});

test('CF_HTML 偏移按 UTF-8 字节算，中文与换行都对得上', () => {
  const fragment = '<p>中文</p>\n<p>第二行</p>\n<span>emoji 🙂</span>';
  const bytes = buildCfHtml(fragment);
  const header = readCfHtmlHeader(bytes);
  const slice = Buffer.from(bytes.subarray(header.startFragment, header.endFragment), 'utf8');
  assert.equal(slice.toString('utf8'), fragment);
  const whole = Buffer.from(bytes.subarray(header.startHtml, header.endHtml), 'utf8');
  assert.match(whole.toString('utf8'), /^<html><head>/);
  assert.ok(header.endHtml <= bytes.length);
  assert.equal(Buffer.from(bytes.subarray(0, header.startHtml), 'utf8').toString('utf8').startsWith('Version:0.9'), true);
});

test('CF_HTML 带来源地址时 base 被转义，读回头仍有效', () => {
  const bytes = buildCfHtml('<p>正文</p>', 'https://ex.com/?a=1&b="2"');
  const header = readCfHtmlHeader(bytes);
  assert.equal(Buffer.from(bytes.subarray(header.startFragment, header.endFragment), 'utf8').toString('utf8'), '<p>正文</p>');
  assert.match(bytes.toString('utf8'), /&amp;/);
});

test('CF_HTML 头损坏/缺版本时拒绝', () => {
  assert.throws(() => readCfHtmlHeader(Buffer.from('<p>x</p>', 'utf8')), /缺少版本/);
  assert.throws(() => readCfHtmlHeader(Buffer.from('Version:0.9\r\nStartHTML:abc\r\n', 'utf8')), /偏移无效/);
});

test('预览截取与文件失效提示：路径原样，不假装附件可用', () => {
  const preview = previewOf({ text: 'a\r\nb', files: ['C:\\gone.png'], width: 100, height: 20 });
  assert.equal(preview.text, 'a\nb');
  assert.deepEqual(preview.files, ['C:\\gone.png']);
  assert.equal(preview.fileCount, 1);
  const long = previewOf({ text: 'x'.repeat(5000) });
  assert.equal(Array.from(long.text).length, 2000);
});

test('查询规范化转义 LIKE 通配符，空查询返回 undefined', () => {
  assert.equal(normalizeQuery('  '), undefined);
  assert.equal(normalizeQuery(42), undefined);
  assert.equal(normalizeQuery('a%_b\\c'), 'a\\%\\_b\\\\c');
  assert.equal(normalizeQuery(' 你好 '), '你好');
});

test('分页固定每页条数，越界夹回最后一页', () => {
  const first = pageWindow(120, 1);
  assert.deepEqual(first, { page: 1, pageSize: PAGE_SIZE, pages: 3, offset: 0, total: 120 });
  assert.equal(pageWindow(120, 99).page, 3);
  assert.equal(pageWindow(120, 99).offset, 100);
  assert.equal(pageWindow(0, 2).page, 1);
  assert.equal(pageWindow(0, 2).pages, 1);
  assert.throws(() => pageWindow(-1, 1), /总数无效/);
});

test('配额同时看字节与条数，超了就说超了，不把条数当磁盘上限', () => {
  const state = quotaState({ bytes: 10, count: 99, maxStorageBytes: 100, maxHistoryItems: 100 });
  assert.equal(state.full, false);
  assert.equal(state.freeBytes, 90);
  assert.equal(state.freeItems, 1);
  const over = quotaState({ bytes: 150, count: 120, maxStorageBytes: 100, maxHistoryItems: 100 });
  assert.equal(over.full, true);
  assert.equal(over.overBytes, 50);
  assert.equal(over.overItems, 20);
  assert.throws(() => quotaState({ bytes: -1, count: 0, maxStorageBytes: 1, maxHistoryItems: 1 }), /配额参数无效/);
});

test('清理候选只排未受保护的，最久未用在前', () => {
  const ordered = cleanupOrder([
    { id: 3, lastUsedAt: 30, protected: false },
    { id: 1, lastUsedAt: 10, protected: false },
    { id: 2, lastUsedAt: 20, protected: true },
    { id: 4, lastUsedAt: 30, protected: false }
  ]);
  assert.deepEqual(ordered.map(item => item.id), [1, 3, 4]);
});

test('格式白名单覆盖计划要求的六类，PNG 优先于 DIB 的说明写在导出侧', () => {
  assert.deepEqual(Object.keys(FORMATS).sort(), ['dib', 'files', 'html', 'png', 'rtf', 'text']);
});

// —— text 字节契约：CF_UNICODETEXT 原字节（UTF-16LE），不靠“有 NUL 就猜” ——
test('text 契约：中文/无 ASCII/emoji/URL 都按 UTF-16LE 解码，不误判', () => {
  assert.equal(decodeTextBytes(encodeTextBytes('中文说明')), '中文说明');
  assert.equal(decodeTextBytes(encodeTextBytes('纯中文没有ASCII')), '纯中文没有ASCII');
  assert.equal(decodeTextBytes(encodeTextBytes('表情 🙂👍 尾巴')), '表情 🙂👍 尾巴');
  assert.equal(textOf(normalizeEntries([{ key: 'text', bytes: encodeTextBytes('你好') }]), 'text'), '你好');
  assert.equal(classify(normalizeEntries([{ key: 'text', bytes: encodeTextBytes('https://例子.cn/路径?q=中文') }])).kind, 'link');
  assert.equal(classify(normalizeEntries([{ key: 'text', bytes: encodeTextBytes('看这个 https://a.cn') }])).kind, 'text');
});

test('text 终止符：尾部 NUL 去掉，内容里的字一个不改', () => {
  const withOne = Buffer.concat([Buffer.from('带尾巴', 'utf16le'), Buffer.from([0, 0])]);
  const withTwo = Buffer.concat([withOne, Buffer.from([0, 0])]);
  const bare = Buffer.from('带尾巴', 'utf16le');
  assert.equal(decodeTextBytes(withOne), '带尾巴');
  assert.equal(decodeTextBytes(withTwo), '带尾巴');
  assert.equal(decodeTextBytes(bare), '带尾巴');
  // 原字节不为解码服务：入库后字节长度与内容都不变。
  const bytes = encodeTextBytes('  原样  ');
  const normalized = normalizeEntries([{ key: 'text', bytes }]);
  assert.equal(normalized[0].bytes, bytes);
  assert.equal(normalized[0].size, bytes.length);
  assert.equal(textOf(normalized, 'text'), '  原样  ');
  // 生成侧固定以 UTF-16LE + 终止符交付，长度 = 2×UTF-16 码元 + 2。
  const made = encodeTextBytes('abc');
  assert.equal(made.length, 3 * 2 + 2);
  assert.equal(made.readUInt16LE(made.length - 2), 0);
});
