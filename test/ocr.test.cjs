'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installOcrIpc, MAX_PNG_BYTES } = require('../main/ocr.cjs');

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// 只造 IHDR 头：解码由夹具代替，尺寸校验走真实字节。
function pngHeader(width, height, { length = 13, type = 'IHDR', extra = 0 } = {}) {
  const bytes = Buffer.alloc(33 + extra);
  PNG_SIGNATURE.copy(bytes, 0);
  bytes.writeUInt32BE(length, 8); bytes.write(type, 12, 'ascii');
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  bytes[24] = 8; bytes[25] = 6;
  return new Uint8Array(bytes);
}
function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.chunks = []; child.stdin.ended = false;
  child.stdin.end = value => { child.stdin.chunks.push(Buffer.from(value)); child.stdin.ended = true; };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = 0;
  child.kill = () => { child.killed += 1; };
  return child;
}
function harness({ platform = 'win32', exists = () => true, timeoutMs = 200, decodeSize, decodeFails = false } = {}) {
  const handlers = new Map();
  const spawns = [];
  const session = { phase: 'selecting', editorOpen: true, editDocument: { token: 'doc-token', width: 8, height: 6 } };
  let allowedOk = true;
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
  const nativeImage = { createFromBuffer: bytes => {
    if (decodeFails) return { isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) };
    const size = decodeSize ?? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    return { isEmpty: () => false, getSize: () => ({ ...size }) };
  } };
  const api = installOcrIpc({ ipcMain, allowed: () => allowedOk, getActive: () => session, nativeImage, platform, exists, timeoutMs,
    spawn: (file, args, options) => { const child = fakeChild(); spawns.push({ file, args, options, child }); return child; } });
  const event = { sender: 'selection', senderFrame: 'main' };
  const call = payload => handlers.get('shot:recognize-text')(event, payload);
  return { api, session, spawns, call, setAllowed: value => { allowedOk = value; }, handlers };
}
const reply = (child, value) => {
  child.stdout.emit('data', Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8'));
  child.emit('close', 0, null);
};
const okReply = (width = 8, height = 6, text = '保存按钮', language = 'zh-Hans-CN') => ({ ok: true, text, language, width, height });
const valid = (h, overrides = {}) => ({ token: 'doc-token', png: pngHeader(8, 6), width: 8, height: 6, ...overrides });

test('固定 exe + 无用户参数：识别成功只回 text/language，PNG 整块走 stdin', async () => {
  const h = harness();
  const pending = h.call(valid(h));
  assert.equal(h.spawns.length, 1);
  assert.deepEqual(h.spawns[0].args, []);
  assert.deepEqual({ ...h.spawns[0].options }, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  assert.match(h.spawns[0].file, /ocr-helper\.exe$/);
  assert.equal(h.spawns[0].child.stdin.ended, true);
  assert.deepEqual([...h.spawns[0].child.stdin.chunks[0]], [...Buffer.from(pngHeader(8, 6))]);
  reply(h.spawns[0].child, okReply());
  assert.deepEqual({ ...(await pending) }, { text: '保存按钮', language: 'zh-Hans-CN' });
  assert.equal(h.session.ocrJob, undefined, '结束后自己的 job 必须清干净');
});

test('守卫：非法 sender、非框选态、编辑器关闭、文档缺失、token 不符一律拒绝且不起进程', async () => {
  const h = harness();
  h.setAllowed(false);
  await assert.rejects(h.call(valid(h)), /识别请求已失效/);
  h.setAllowed(true);
  for (const patch of [{ phase: 'saving' }, { editorOpen: false }, { editDocument: undefined }]) {
    Object.assign(h.session, { phase: 'selecting', editorOpen: true, editDocument: { token: 'doc-token', width: 8, height: 6 } }, patch);
    await assert.rejects(h.call(valid(h)), /识别请求已失效/, JSON.stringify(patch));
  }
  Object.assign(h.session, { phase: 'selecting', editorOpen: true, editDocument: { token: 'doc-token', width: 8, height: 6 } });
  await assert.rejects(h.call(valid(h, { token: 'other-token' })), /识别请求已失效/);
  await assert.rejects(h.call(valid(h, { token: 42 })), /识别请求已失效/);
  assert.equal(h.spawns.length, 0);
});

test('PNG 头与字节上限：空图、非字节、超 8 MiB、坏 IHDR、0 边、超边/超像素、声明不符都在起进程前拒绝', async () => {
  const h = harness();
  await assert.rejects(h.call(valid(h, { png: new Uint8Array(0) })), /识别图片为空/);
  await assert.rejects(h.call(valid(h, { png: 'not-bytes' })), /识别图片格式无效/);
  const huge = new Uint8Array(MAX_PNG_BYTES + 1);
  Buffer.from(pngHeader(8, 6)).copy(Buffer.from(huge.buffer), 0);
  await assert.rejects(h.call(valid(h, { png: huge })), /8 MiB/);
  await assert.rejects(h.call(valid(h, { png: pngHeader(8, 6, { length: 12 }) })), /识别图片格式无效/);
  await assert.rejects(h.call(valid(h, { png: pngHeader(8, 6, { type: 'IDAT' }) })), /识别图片格式无效/);
  const badSignature = pngHeader(8, 6); badSignature[0] = 0;
  await assert.rejects(h.call(valid(h, { png: badSignature })), /识别图片格式无效/);
  await assert.rejects(h.call(valid(h, { png: new Uint8Array(20) })), /识别图片格式无效/);
  await assert.rejects(h.call(valid(h, { png: pngHeader(0, 6), width: 0 })), /识别图片格式无效/);
  await assert.rejects(h.call(valid(h, { png: pngHeader(2049, 6), width: 2049 })), /识别图片尺寸超出上限/);
  await assert.rejects(h.call(valid(h, { png: pngHeader(2001, 2000), width: 2001, height: 2000 })), /识别图片尺寸超出上限/);
  await assert.rejects(h.call(valid(h, { width: 9 })), /尺寸声明不符/);
  await assert.rejects(h.call(valid(h, { height: 7 })), /尺寸声明不符/);
  assert.equal(h.spawns.length, 0);
});

test('解码真实尺寸与声明不一致或解不出来时拒绝', async () => {
  const mismatched = harness({ decodeSize: { width: 8, height: 5 } });
  await assert.rejects(mismatched.call(valid(mismatched)), /识别图片内容尺寸不符/);
  const broken = harness({ decodeFails: true });
  await assert.rejects(broken.call(valid(broken)), /识别图片无法解码/);
  assert.equal(mismatched.spawns.length + broken.spawns.length, 0);
});

test('helper 缺失或非 Windows 只说明不可用，不起进程', async () => {
  const missing = harness({ exists: () => false });
  await assert.rejects(missing.call(valid(missing)), /离线文字识别组件缺失/);
  assert.equal(missing.spawns.length, 0);
  const other = harness({ platform: 'darwin' });
  await assert.rejects(other.call(valid(other)), /本机不支持离线文字识别/);
  assert.equal(other.spawns.length, 0);
});

test('超时与输出上限：本次子进程被终止，错误是固定中文', async () => {
  const timeout = harness({ timeoutMs: 20 });
  const slow = timeout.call(valid(timeout));
  await assert.rejects(slow, /文字识别超时/);
  assert.equal(timeout.spawns[0].child.killed, 1);
  assert.equal(timeout.session.ocrJob, undefined);

  const flood = harness();
  const pending = flood.call(valid(flood));
  flood.spawns[0].child.stdout.emit('data', Buffer.alloc(64 * 1024 + 1, 0x41));
  await assert.rejects(pending, /识别结果超出上限/);
  assert.equal(flood.spawns[0].child.killed, 1);
});

test('坏 JSON、字段缺失、helper 失败码都收口成固定中文，原始码不外泄', async () => {
  const bad = harness();
  const first = bad.call(valid(bad));
  reply(bad.spawns[0].child, 'SECRET-NOT-JSON');
  await assert.rejects(first, error => { assert.equal(error.message, '识别结果格式异常'); return true; });

  const noText = harness();
  const second = noText.call(valid(noText));
  reply(noText.spawns[0].child, { ok: true, width: 8, height: 6 });
  await assert.rejects(second, /识别结果格式异常/);

  const wrongSize = harness();
  const third = wrongSize.call(valid(wrongSize));
  reply(wrongSize.spawns[0].child, okReply(9, 6));
  await assert.rejects(third, /识别结果格式异常/);

  const refusal = harness();
  const fourth = refusal.call(valid(refusal));
  reply(refusal.spawns[0].child, { ok: false, reason: 'too-large' });
  await assert.rejects(fourth, error => { assert.equal(error.message, '识别图片尺寸超出上限'); return true; });

  const unknown = harness();
  const fifth = unknown.call(valid(unknown));
  reply(unknown.spawns[0].child, { ok: false, reason: 'SECRET-CODE' });
  await assert.rejects(fifth, error => { assert.equal(error.message, '文字识别失败，请稍后再试'); assert.doesNotMatch(error.message, /SECRET/); return true; });
});

test('文字超过 2000 码位明确报错而不是静默截断；空文本不算失败', async () => {
  const long = harness();
  const pending = long.call(valid(long));
  reply(long.spawns[0].child, okReply(8, 6, '字'.repeat(2001)));
  await assert.rejects(pending, /识别文字过长/);

  const empty = harness();
  const second = empty.call(valid(empty));
  reply(empty.spawns[0].child, okReply(8, 6, ''));
  assert.deepEqual({ ...(await second) }, { text: '', language: 'zh-Hans-CN' });
});

test('单飞：同会话重复请求直接报正忙，不杀旧进程也不再起第二个', async () => {
  const h = harness();
  const first = h.call(valid(h));
  await assert.rejects(h.call(valid(h)), /识别正忙/);
  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0].child.killed, 0);
  reply(h.spawns[0].child, okReply());
  assert.equal((await first).text, '保存按钮');
  // 结束后可以再识别一次。
  const again = h.call(valid(h));
  assert.equal(h.spawns.length, 2);
  reply(h.spawns[1].child, okReply());
  assert.equal((await again).text, '保存按钮');
});

test('cancel：终止本次子进程、清掉自己的 job，之后可再起且无残留', async () => {
  const h = harness();
  const pending = h.call(valid(h));
  assert.equal(h.session.ocrJob === undefined, false);
  assert.equal(h.api.cancel(h.session), true);
  await assert.rejects(pending, /文字识别已取消/);
  assert.equal(h.spawns[0].child.killed, 1);
  assert.equal(h.session.ocrJob, undefined);
  assert.equal(h.api.cancel(h.session), false, '没有在途任务时取消是空操作');
  // 迟到的 close 不能再改结果：再起一次仍正常。
  h.spawns[0].child.emit('close', 1, null);
  const again = h.call(valid(h));
  reply(h.spawns[1].child, okReply());
  assert.equal((await again).text, '保存按钮');
});

test('多次 close / 退出错误只结案一次；错误发生在先时后续成功不再翻盘', async () => {
  const h = harness();
  const pending = h.call(valid(h));
  const child = h.spawns[0].child;
  child.emit('close', 1, null);
  await assert.rejects(pending, /文字识别失败，请稍后再试/);
  child.emit('close', 0, null);
  child.emit('error', new Error('SECRET-EPIPE'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.session.ocrJob, undefined);

  const success = harness();
  const second = success.call(valid(success));
  const secondChild = success.spawns[0].child;
  reply(secondChild, okReply());
  secondChild.emit('close', 0, null);
  secondChild.emit('error', new Error('SECRET-LATE'));
  assert.equal((await second).text, '保存按钮');
});

test('非正常退出即使 stdout 伪造 ok 也拒绝，不用半载结果', async () => {
  const nonzero = harness();
  const first = nonzero.call(valid(nonzero));
  nonzero.spawns[0].child.stdout.emit('data', Buffer.from(JSON.stringify(okReply()), 'utf8'));
  nonzero.spawns[0].child.emit('close', 3, null);
  await assert.rejects(first, error => { assert.equal(error.message, '文字识别失败，请稍后再试'); return true; });

  const signaled = harness();
  const second = signaled.call(valid(signaled));
  signaled.spawns[0].child.stdout.emit('data', Buffer.from(JSON.stringify(okReply()), 'utf8'));
  signaled.spawns[0].child.emit('close', null, 'SIGKILL');
  await assert.rejects(second, /文字识别失败，请稍后再试/);

  const emptyExit = harness();
  const third = emptyExit.call(valid(emptyExit));
  emptyExit.spawns[0].child.emit('close', 0, null);
  await assert.rejects(third, /识别结果格式异常/);
});

test('stale：await 回来时会话已失效就丢弃结果；finally 只清自己的 job，不擦后继', async () => {
  const h = harness();
  const pending = h.call(valid(h));
  const job = h.session.ocrJob;
  const successor = { cancel: () => {} };
  h.session.editorOpen = false;
  h.session.ocrJob = successor;
  reply(h.spawns[0].child, okReply());
  await assert.rejects(pending, /识别请求已失效/);
  assert.equal(h.session.ocrJob, successor, '后继任务不能被前一条的 finally 擦掉');
  assert.equal(job === successor, false);
});

test('识别文本与路径不落日志：正常与失败路径都不写控制台', async () => {
  const calls = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const key of Object.keys(saved)) console[key] = (...args) => calls.push({ key, args });
  try {
    const h = harness();
    const first = h.call(valid(h));
    reply(h.spawns[0].child, okReply(8, 6, '机密文本'));
    assert.equal((await first).text, '机密文本');
    const second = harness();
    const failing = second.call(valid(second));
    second.spawns[0].child.stderr.emit('data', Buffer.from('SECRET-STDERR', 'utf8'));
    reply(second.spawns[0].child, { ok: false, reason: 'bad-image' });
    await assert.rejects(failing, /识别图片格式无效/);
  } finally {
    for (const key of Object.keys(saved)) console[key] = saved[key];
  }
  assert.deepEqual(calls, []);
});
