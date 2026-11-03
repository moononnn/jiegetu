'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const path = require('node:path');
const { createGifClipboard } = require('../main/gif-clipboard.cjs');
const directory = path.resolve('test-cache-中文 空格');
const helperPath = path.resolve('native/gif-clipboard.exe');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const gif = () => Buffer.from([71,73,70,56,57,97,1,0,1,0,128,0,0,0,0,0,255,255,255,33,249,4,4,10,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,59]);
function harness(options = {}) {
  const files = new Map(), calls = [], children = [];
  let sequence = 0;
  const fs = {
    async access(file) { calls.push(['access', file]); },
    async mkdir(file, opts) { calls.push(['mkdir', file, opts]); },
    async readdir() { return [...files.keys()]; },
    async lstat(file) { const entry = files.get(path.basename(file)); return { isFile: () => !entry.nonfile, size: entry.bytes?.length || entry.size || 0 }; },
    async writeFile(file, bytes, opts) {
      calls.push(['writeFile', file, opts]);
      if (files.has(path.basename(file))) throw new Error('EEXIST');
      assert.equal(opts.flag, 'wx'); files.set(path.basename(file), { bytes: Buffer.from(bytes) });
    }
  };
  const spawn = (exe, args, opts) => {
    calls.push(['spawn', exe, args, opts]);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.killed = 0; child.kill = () => { child.killed++; };
    children.push(child);
    if (!options.manual) queueMicrotask(() => { child.stdout.write('{"ok":true}\n'); child.emit('close', 0, null); });
    return child;
  };
  const service = createGifClipboard({ directory, helperPath, fs, spawn, uuid: () => id(++sequence), ...options });
  return { service, fs, files, calls, children };
}
async function spawned(h) {
  // Drain the finite mocked fs promise chain; never touches a process or real clipboard.
  for (let i = 0; i < 20 && !h.children.length; i++) await Promise.resolve();
  assert.equal(h.children.length, 1); return h.children[0];
}
test('copies exact GIF bytes to exclusive unique Unicode paths; retains files and never sends bytes on stdin', async () => {
  const h = harness(), bytes = gif(), original = Buffer.from(bytes);
  const first = await h.service.copy(bytes), second = await h.service.copy(new Uint8Array(bytes));
  assert.notEqual(first.file, second.file); assert.ok(path.isAbsolute(first.file));
  assert.deepEqual(bytes, original); assert.equal(h.files.size, 2);
  for (const entry of h.files.values()) assert.deepEqual(entry.bytes, original);
  assert.deepEqual(h.calls.find(c => c[0] === 'mkdir').slice(1), [directory, { recursive: true }]);
  const spawn = h.calls.find(c => c[0] === 'spawn');
  assert.equal(spawn[1], helperPath); assert.deepEqual(spawn[2], ['--publish', first.file]);
  assert.deepEqual(spawn[3], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(h.children[0].stdin.readableLength, 0);
  assert.equal(h.children[0].listenerCount('close'), 0);
});
test('stale preview is refused before filesystem work', async () => {
  const h = harness(); await assert.rejects(h.service.copy(gif(), { isCurrent: () => false }), /预览已关闭/);
  assert.equal(h.calls.length, 0); assert.equal(h.children.length, 0);
});
test('preview closed during helper check never writes a cache or clipboard', async () => {
  const h = harness(); let live = true; h.fs.access = async () => { live = false; };
  await assert.rejects(h.service.copy(gif(), { isCurrent: () => live }), /预览已关闭/);
  assert.equal(h.files.size, 0); assert.equal(h.children.length, 0);
});
test('preview closed during cache write never starts clipboard helper, leaves file safe', async () => {
  const h = harness(); let live = true; const write = h.fs.writeFile;
  h.fs.writeFile = async (...args) => { await write(...args); live = false; };
  await assert.rejects(h.service.copy(gif(), { isCurrent: () => live }), /预览已关闭/);
  assert.equal(h.children.length, 0); assert.equal(h.files.size, 1);
  // The rejected operation must release the single-flight latch.
  await h.service.copy(gif()); assert.equal(h.children.length, 1);
});
test('snapshots bytes before awaiting filesystem', async () => {
  const h = harness(), bytes = gif(), expected = Buffer.from(bytes);
  const result = h.service.copy(bytes); bytes.fill(0); await result;
  assert.deepEqual([...h.files.values()][0].bytes, expected);
});
for (const [name, bytes] of [ ['empty', Buffer.alloc(0)], ['not typed bytes', []], ['PNG', Buffer.from('PNG')],
  ['truncated', gif().subarray(0, 25)], ['oversize', new Uint8Array(48 * 1024 * 1024 + 1)],
  ['dimension', (() => { const b = gif(); b[6] = 1; b[7] = 17; return b; })()],
  ['pixel count', (() => { const b = gif(); b.writeUInt16LE(2001, 6); b.writeUInt16LE(2000, 8); return b; })()] ]) {
  test(`reject ${name} before disk/spawn`, async () => { const h = harness(); await assert.rejects(h.service.copy(bytes)); assert.equal(h.calls.length, 0); });
}
test('GIF87a header is accepted without transforming bytes', async () => {
  const h = harness(), bytes = gif(); bytes.write('GIF87a'); await h.service.copy(bytes);
  assert.deepEqual([...h.files.values()][0].bytes, bytes);
});
for (const operation of ['access', 'mkdir', 'readdir', 'lstat', 'writeFile']) {
  test(`filesystem ${operation} failure rejects without deleting old files`, async () => {
    const h = harness(); h.files.set(`GIF-${id(88)}.gif`, { size: 12 });
    h.fs[operation] = async () => { throw new Error('fixture failure'); };
    await assert.rejects(h.service.copy(gif()), /fixture failure/);
    assert.equal(h.files.size, 1); assert.equal(h.children.length, 0);
  });
}
test('missing helper is checked before mkdir/write', async () => {
  const h = harness(); h.fs.access = async () => { throw new Error('ENOENT'); };
  await assert.rejects(h.service.copy(gif()), /ENOENT/); assert.equal(h.calls.length, 0);
});
for (const limit of [{ maxCacheFiles: 1 }, { maxCacheBytes: gif().length + 9 }]) {
  test(`cache refuses added file beyond ${JSON.stringify(limit)}`, async () => {
    const h = harness(limit); h.files.set(`GIF-${id(99)}.gif`, { size: 10 });
    await assert.rejects(h.service.copy(gif()), error => error.message.includes(directory) && /保存\/另存/.test(error.message));
    assert.equal(h.files.size, 1); assert.equal(h.children.length, 0);
  });
}
test('counts only own regular filenames, permits exact limit, leaves PNG/unrelated files/symlinks untouched', async () => {
  const h = harness({ maxCacheFiles: 1, maxCacheBytes: gif().length });
  for (const name of ['image.png', 'other.gif', 'GIF-fake.gif']) h.files.set(name, { size: 99999999 });
  h.files.set(`GIF-${id(77)}.gif`, { nonfile: true, size: 99999999 });
  await h.service.copy(gif()); assert.equal(h.files.size, 5);
});
test('wx collision never overwrites or removes existing file', async () => {
  const h = harness(); h.files.set(`GIF-${id(1)}.gif`, { bytes: Buffer.from('old') });
  await assert.rejects(h.service.copy(gif()), /EEXIST/);
  assert.equal(h.files.get(`GIF-${id(1)}.gif`).bytes.toString(), 'old');
});
test('single flight rejects concurrent copy, releases after success', async () => {
  const h = harness({ manual: true }); const pending = h.service.copy(gif());
  await assert.rejects(h.service.copy(gif()), /正在复制/); const child = await spawned(h);
  child.stdout.write('{"ok":true}'); child.emit('close', 0); await pending;
  assert.equal(h.files.size, 1);
});
for (const scenario of ['nonzero', 'signal', 'bad-json', 'false', 'empty', 'stdout-limit', 'stderr-limit', 'error', 'stdin-error', 'stdout-error', 'stderr-error']) {
  test(`helper ${scenario}: rejects, retains file, clears listeners`, async () => {
    const h = harness({ manual: true }); const pending = h.service.copy(gif());
    const rejected = assert.rejects(pending, /组件失败/); const child = await spawned(h);
    if (scenario === 'error') child.emit('error', new Error('spawn'));
    else if (scenario.endsWith('-error')) child[scenario.split('-')[0]].emit('error', new Error('stream'));
    else if (scenario === 'stdout-limit') child.stdout.write('a'.repeat(16385));
    else if (scenario === 'stderr-limit') child.stderr.write('a'.repeat(4097));
    else {
      child.stdout.write(scenario === 'bad-json' ? 'bad' : scenario === 'false' ? '{"ok":false}' : scenario === 'empty' ? '' : '{"ok":true}');
      child.emit('close', scenario === 'nonzero' ? 1 : 0, scenario === 'signal' ? 'SIGTERM' : null);
    }
    await rejected; assert.equal(h.files.size, 1); assert.equal(child.killed, 1);
    assert.equal(child.stdout.listenerCount('data'), 0);
    if (child.listenerCount('close')) {
      child.stdin.emit('error', new Error('late EPIPE'));
      child.emit('error', new Error('late process error'));
    }
    child.emit('close', 0); // Late success cannot change the settled failure.
    assert.equal(child.listenerCount('close'), 0); assert.equal(child.listenerCount('error'), 0);
    assert.equal(child.stdin.listenerCount('error'), 0);
  });
}
test('timeout kills only owned child, retains cache, late success cannot win, service can retry', async () => {
  const h = harness({ manual: true, timeoutMs: 15 });
  const pending = h.service.copy(gif()); const rejected = assert.rejects(pending, /超时/);
  const child = await spawned(h); await rejected;
  child.stdin.emit('error', new Error('late EPIPE'));
  child.stdout.write('{"ok":true}'); child.emit('close', 0);
  assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.killed, 1); assert.equal(h.files.size, 1);
  const next = h.service.copy(gif());
  for (let i = 0; i < 20 && h.children.length < 2; i++) await Promise.resolve();
  h.children[1].stdout.write('{"ok":true}'); h.children[1].emit('close', 0); await next;
  assert.equal(h.files.size, 2);
});
test('synchronous spawn throw retains final GIF', async () => {
  const h = harness({ spawn: () => { throw new Error('spawn'); } });
  await assert.rejects(h.service.copy(gif()), /组件失败/); assert.equal(h.files.size, 1);
});
test('requires absolute private directory and safe injected uuid', async () => {
  assert.throws(() => createGifClipboard({ directory: 'relative' }), /绝对路径/);
  const h = harness({ uuid: () => '../escape' }); await assert.rejects(h.service.copy(gif()), /文件名/);
  assert.equal(h.files.size, 0);
});
