'use strict';
// 剪贴板服务：假 spawn / 假系统 API。不启动真实 helper、不注册监听、不读写系统剪贴板。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createClipboardService } = require('../main/clipboard-service.cjs');

const roots = [];
function tempSpool() {
  const root = path.join(os.tmpdir(), `cg-svc-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  roots.push(root);
  fs.mkdirSync(root, { recursive: true });
  return root;
}
process.on('exit', () => { for (const root of roots) { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} } });

function pngBytes(width = 2, height = 2) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length, 0);
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc, 0);
    return Buffer.concat([length, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y++) rows.push(Buffer.alloc(1 + width * 3, 40));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

// 假 spawn：把 stdin 的 JSONL 命令解析成回复，测试自己决定何时 ready / 发事件。
function fakeSpawn({ publishOk = true } = {}) {
  const { EventEmitter } = require('node:events');
  const proc = new EventEmitter();
  const stdin = new EventEmitter();
  stdin.destroyed = false;
  stdin.write = line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    setImmediate(() => {
      if (message.cmd === 'pause') emit(`{"v":1,"id":${message.id},"ok":true,"listening":false}`);
      else if (message.cmd === 'resume') emit(`{"v":1,"id":${message.id},"ok":true,"listening":true}`);
      else if (message.cmd === 'watch') emit(`{"v":1,"id":${message.id},"ok":true,"listening":true}`);
      else if (message.cmd === 'publish') emit(`{"v":1,"id":${message.id},"ok":true,"published":${publishOk ? 'true' : 'false'}}`);
      else if (message.cmd === 'quit') { emit(`{"v":1,"id":${message.id},"ok":true,"stopped":true}`); setImmediate(() => proc.emit('exit', 0, null)); }
      else emit(`{"v":1,"id":${message.id},"ok":true}`);
    });
  };
  const stdout = new EventEmitter();
  stdout.setEncoding = () => {};
  const stderr = new EventEmitter();
  proc.stdin = stdin; proc.stdout = stdout; proc.stderr = stderr; proc.pid = 4321;
  proc.kill = () => proc.emit('exit', 0, null);
  function emit(line) { stdout.emit('data', `${line}\n`); }
  return { proc, emit, ready: () => emit('{"v":1,"event":"ready","pid":4321,"listening":false}') };
}

// 单次 --publish 模式的假进程：只回一行结果就退出，不注册监听。
function onceProc(result = '{"v":1,"ok":true}') {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough(); proc.stdout.setEncoding = () => {};
  proc.stderr = new PassThrough();
  proc.pid = 5001;
  proc.kill = () => proc.emit('exit', 0);
  setTimeout(() => { proc.stdout.write(`${result}\n`); proc.emit('exit', 0); }, 5);
  return proc;
}

test('默认不启动：没有 start 就不 spawn，也不注册监听', () => {
  let spawned = false;
  const service = createClipboardService({ spoolDir: tempSpool(), spawn: () => { spawned = true; return fakeSpawn().proc; } });
  assert.equal(spawned, false);
  assert.equal(service.status().phase, 'stopped');
  assert.equal(service.isReady(), false);
});

test('start 等到 helper ready 才算就绪；超时不假装成功', async () => {
  const fake = fakeSpawn();
  const service = createClipboardService({ spoolDir: tempSpool(), spawn: () => fake.proc, timeoutMs: 500 });
  const started = service.start();
  setTimeout(() => fake.ready(), 20);
  assert.equal(await started, true);
  assert.equal(service.status().phase, 'ready');
  await service.stop();

  const silent = fakeSpawn();
  const slow = createClipboardService({ spoolDir: tempSpool(), spawn: () => silent.proc, timeoutMs: 200 });
  await assert.rejects(() => slow.start(), /启动超时/);
  assert.equal(slow.status().phase, 'interrupted');
});

test('ready 之前的事件不消费；暂停后事件也不消费', async () => {
  const fake = fakeSpawn();
  const events = [];
  const service = createClipboardService({ spoolDir: tempSpool(), spawn: () => fake.proc, onEvent: event => events.push(event) });
  fake.emit('{"v":1,"event":"clip","seq":1,"excluded":false,"source":{"name":"notepad","pid":9},"formats":[]}');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.length, 0, '未 ready 时事件不消费');
  service.start();
  fake.ready();
  await new Promise(resolve => setTimeout(resolve, 10));
  await service.pause();
  assert.equal(service.status().phase, 'paused');
  fake.emit('{"v":1,"event":"clip","seq":2,"excluded":false,"source":{"name":"notepad","pid":9},"formats":[]}');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.length, 0, '暂停后不采集');
  await service.resume();
  assert.equal(service.status().phase, 'ready');
  await service.stop();
});

test('忽略标记与应用排除：都不入库，状态如实说被排除', async () => {
  const spool = tempSpool();
  const fake = fakeSpawn();
  const events = [];
  const statuses = [];
  const service = createClipboardService({ spoolDir: spool, spawn: () => fake.proc, excludedApps: ['Chrome.exe'],
    onEvent: event => events.push(event), onStatus: status => statuses.push(status) });
  service.start(); fake.ready();
  await new Promise(resolve => setTimeout(resolve, 10));
  // 系统忽略标记：直接丢弃。
  fake.emit('{"v":1,"event":"clip","seq":3,"excluded":true,"source":{"name":"keepass","pid":9},"formats":[]}');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.length, 0);
  // 应用排除：不写 spool，只提示。
  const textName = 'abc-123.txt';
  fs.writeFileSync(path.join(spool, textName), Buffer.from('不该进来', 'utf8'));
  fake.emit(`{"v":1,"event":"clip","seq":4,"excluded":false,"source":{"name":"chrome","pid":9},"formats":[{"format":"text","file":"${textName}","size":${Buffer.byteLength('不该进来', 'utf8')}}]}`);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.length, 0, '被排除的应用不入库');
  assert.ok(statuses.some(status => status.excluded === 'chrome'), '要明确说被排除的是谁');
  await service.stop();
});

test('正常外部复制不被自身写入抑制误吞', async () => {
  const spool = tempSpool();
  const fake = fakeSpawn();
  const events = [];
  const service = createClipboardService({ spoolDir: spool, spawn: () => fake.proc, onEvent: event => events.push(event) });
  service.start(); fake.ready();
  await new Promise(resolve => setTimeout(resolve, 10));
  await service.publish([{ format: 'text', bytes: Buffer.from('历史内容', 'utf8') }]);
  // 发布成功后再来一条完全不同的外部事件：序列不同，不能被抑制逻辑误伤。
  const name = 'def-456.txt';
  const bytes = Buffer.from('外部复制', 'utf8');
  fs.writeFileSync(path.join(spool, name), bytes);
  fake.emit(`{"v":1,"event":"clip","seq":99,"excluded":false,"source":{"name":"notepad","pid":8},"formats":[{"format":"text","file":"${name}","size":${bytes.length}}]}`);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.length, 1, '外部复制必须入库');
  assert.equal(events[0].entries[0].bytes.toString('utf8'), '外部复制');
  await service.stop();
});

test('readParts：PNG 优先、只有 DIB 时保留原件；文件列表与大小不符都拒绝', async () => {
  const spool = tempSpool();
  const fake = fakeSpawn();
  const service = createClipboardService({ spoolDir: spool, spawn: () => fake.proc });
  service.start(); fake.ready();
  const png = pngBytes();
  fs.writeFileSync(path.join(spool, 'aa.png'), png);
  const parts = service.readParts({ formats: [{ format: 'png', file: 'aa.png', size: png.length }] });
  assert.equal(parts.entries.length, 1);
  assert.equal(parts.assetHash.length, 64);
  assert.equal(fs.existsSync(path.join(spool, 'aa.png')), false, '读完后回收自己的 spool 文件');
  // 名字不合法直接拒。
  assert.throws(() => service.readParts({ formats: [{ format: 'png', file: '../x.png', size: 10 }] }), /临时文件无效/);
  fs.writeFileSync(path.join(spool, 'bb.png'), png);
  assert.throws(() => service.readParts({ formats: [{ format: 'png', file: 'bb.png', size: png.length + 1 }] }), /与声明不符/);
  await service.stop();
});

test('publish：成功 ACK 后只回收本次 spool 副本，外部 files 路径不动；失败才回收自己写的', async () => {
  // 常驻发布成功：text 的 spool 副本要删，part.paths 指向的外部文件不能动。
  const spool = tempSpool();
  const fake = fakeSpawn();
  const service = createClipboardService({ spoolDir: spool, spawn: () => fake.proc });
  service.start(); fake.ready();
  const external = path.join(spool, 'external-keep.txt');
  fs.writeFileSync(external, '外部文件');
  const bytes = Buffer.concat([Buffer.from('发布内容 🙂', 'utf16le'), Buffer.from([0, 0])]);
  const result = await service.publish([{ format: 'text', bytes }, { format: 'files', paths: [external] }]);
  assert.equal(result.ok, true);
  assert.equal(result.published, true);
  assert.deepEqual(fs.readdirSync(spool), ['external-keep.txt'], '本次 spool 副本回收，外部文件原样保留');

  // 单次 --publish 模式成功：同样不留本次负载副本。
  const singleSpool = tempSpool();
  const single = createClipboardService({ spoolDir: singleSpool, spawn: () => onceProc() });
  const singleResult = await single.publish([{ format: 'text', bytes }]);
  assert.equal(singleResult.published, true);
  assert.deepEqual(fs.readdirSync(singleSpool), [], '单次发布成功后 spool 归零');
  await single.dispose();

  // 发布被拒：自己刚写的文件回收，不留垃圾。
  const failSpool = tempSpool();
  const failingFake = fakeSpawn({ publishOk: false });
  const failing = createClipboardService({ spoolDir: failSpool, spawn: () => failingFake.proc });
  const failingStart = failing.start();
  failingFake.ready();
  await failingStart;
  await assert.rejects(() => failing.publish([{ format: 'text', bytes }]), /拒绝接收/);
  assert.deepEqual(fs.readdirSync(failSpool), [], '失败时回收自己写的负载');

  // 取消：在检查点抛错，并回收还没交给系统的文件。
  await assert.rejects(() => service.publish([{ format: 'text', bytes }], { isCurrent: () => false }), /复制已取消/);
  await service.stop();
  await failing.dispose();
});

test('helper 异常退出：状态变记录已中断，发布走单次模式不重启监听，不无限重启', async () => {
  const spool = tempSpool();
  const fake = fakeSpawn();
  const statuses = [];
  const spawnArgs = [];
  const service = createClipboardService({ spoolDir: spool, onStatus: status => statuses.push(status),
    spawn: (bin, args) => {
      spawnArgs.push(args.slice());
      if (args.includes('--publish')) {
        // 单次发布：只回一行结果就退出，不注册监听。
        const { EventEmitter } = require('node:events');
        const { PassThrough } = require('node:stream');
        const proc = new EventEmitter();
        proc.stdin = new PassThrough();
        proc.stdout = new PassThrough(); proc.stdout.setEncoding = () => {};
        proc.stderr = new PassThrough();
        proc.pid = 5001;
        proc.kill = () => proc.emit('exit', 0);
        setTimeout(() => { proc.stdout.write('{"v":1,"ok":true}\n'); proc.emit('exit', 0); }, 5);
        return proc;
      }
      return fake.proc;
    } });
  service.start(); fake.ready();
  await new Promise(resolve => setTimeout(resolve, 10));
  fake.proc.emit('exit', 1, null);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(service.status().phase, 'interrupted');
  assert.ok(statuses.some(status => status.phase === 'interrupted'));
  assert.equal(service.isReady(), false);
  // 记录中断后仍可从旧历史复制：同一产物的 --publish 单次模式，不把监听重新开起来。
  const result = await service.publish([{ format: 'text', bytes: Buffer.from('x') }]);
  assert.equal(result.ok, true);
  assert.equal(spawnArgs.length, 2, '只多了一次单次发布，没有重启常驻 helper');
  assert.equal(spawnArgs[1].includes('--publish'), true);
  assert.equal(service.status().phase, 'interrupted', '发布不把服务说成正在记录');
  assert.equal(service.isAlive(), false);
});

test('关闭记录（stop）后历史复制仍可走单次 --publish；dispose 后一律拒绝', async () => {
  const spool = tempSpool();
  const fake = fakeSpawn();
  const spawns = [];
  const service = createClipboardService({ spoolDir: spool, spawn: (bin, args) => {
    spawns.push(args.slice());
    if (args.includes('--publish')) return onceProc();
    return fake.proc;
  } });
  service.start(); fake.ready();
  await service.stop();
  assert.equal(service.status().phase, 'stopped');
  assert.equal(spawns.length, 1, '停止只关常驻进程');
  // 关闭记录后：历史复制仍可用，但不重新开监听。
  const result = await service.publish([{ format: 'text', bytes: Buffer.from('旧内容', 'utf16le') }]);
  assert.equal(result.ok, true);
  assert.equal(spawns.length, 2);
  assert.equal(spawns[1].includes('--publish'), true);
  assert.equal(spawns[1].includes('--watch'), false, '单次发布不注册监听');
  // 最终销毁：之后不再 spawn，也不假装复制成功。
  await service.dispose();
  await assert.rejects(() => service.publish([{ format: 'text', bytes: Buffer.from('x', 'utf16le') }]), /已关闭/);
  assert.equal(spawns.length, 2, 'dispose 后不再 spawn');
});

test('spool 回收：暂停/排除/系统标记/半读取失败都回收自己的文件，不删未知文件', async () => {
  const spool = tempSpool();
  const fake = fakeSpawn();
  const events = [];
  const statuses = [];
  const service = createClipboardService({ spoolDir: spool, spawn: () => fake.proc,
    onEvent: event => events.push(event), onStatus: status => statuses.push(status) });
  service.start(); fake.ready();
  const write = (name, bytes) => { fs.writeFileSync(path.join(spool, name), bytes); return name; };
  const clip = extra => JSON.stringify({ event: 'clip', seq: 7, excluded: false, source: { name: 'chrome', pid: 88 }, ...extra });

  // 1) 暂停时来的事件：文件也要回收。
  await service.pause();
  const paused = write('aaaa-1111.txt', Buffer.from('暂停内容', 'utf16le'));
  fake.emit(clip({ formats: [{ format: 'text', file: paused, size: fs.statSync(path.join(spool, paused)).size }] }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(path.join(spool, paused)), false, '暂停事件的 spool 回收');
  assert.equal(events.length, 0);
  await service.resume();

  // 2) 系统忽略标记。
  const ignored = write('bbbb-2222.txt', Buffer.from('秘密', 'utf16le'));
  fake.emit(clip({ excluded: true, formats: [{ format: 'text', file: ignored, size: 4 }] }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(path.join(spool, ignored)), false, '忽略标记的 spool 回收');

  // 3) 来源排除（JS 兜底）：不删别人的文件。
  service.setExcludedApps(['chrome']);
  const excludedFile = write('cccc-3333.txt', Buffer.from('排除', 'utf16le'));
  const stranger = write('notours.bin', Buffer.from('x'));
  fake.emit(clip({ formats: [{ format: 'text', file: excludedFile, size: 4 }] }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(path.join(spool, excludedFile)), false, '排除来源的 spool 回收');
  assert.equal(fs.existsSync(path.join(spool, stranger)), true, '非本工具扩展名的文件不能顺手删');
  assert.ok(statuses.some(status => status.excluded === 'chrome'), '状态如实说被排除');
  service.setExcludedApps([]);

  // 4) 半读取失败：两个文件一个合法一个大小不符，两个都要回收。
  const good = write('dddd-4444.txt', Buffer.from('好', 'utf16le'));
  const bad = write('eeee-5555.png', Buffer.from('坏图'));
  fake.emit(clip({ formats: [
    { format: 'text', file: good, size: fs.statSync(path.join(spool, good)).size },
    { format: 'png', file: bad, size: 999 }
  ] }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(path.join(spool, good)), false, '半读取失败也要回收已读文件');
  assert.equal(fs.existsSync(path.join(spool, bad)), false, '失败的那个也回收');
  assert.ok(statuses.some(status => status.error === true));

  // 5) 陈旧批次恢复清理：只删自己的旧文件，新文件留着。
  const old = write('ffff-6666.txt', Buffer.from('旧', 'utf16le'));
  const fresh = write('9999-7777.txt', Buffer.from('新', 'utf16le'));
  const longAgo = new Date(Date.now() - 20 * 60 * 1000);
  fs.utimesSync(path.join(spool, old), longAgo, longAgo);
  await service.dispose();
  // 新实例启动时清陈旧批次；ready 要等 start 之后再发。
  const again = fakeSpawn();
  const third = createClipboardService({ spoolDir: spool, spawn: () => again.proc });
  const starting = third.start();
  again.ready();
  assert.equal(await starting, true);
  assert.equal(fs.existsSync(path.join(spool, old)), false, '启动时清陈旧批次');
  assert.equal(fs.existsSync(path.join(spool, fresh)), true, '新批次不碰');
  await third.dispose();
});

test('显式 restart 才重新启动，默认不自动重启', async () => {
  let spawnCount = 0;
  const spool = tempSpool();
  const fake = fakeSpawn();
  const service = createClipboardService({ spoolDir: spool, spawn: () => { spawnCount++; return fake.proc; } });
  service.start(); fake.ready();
  assert.equal(spawnCount, 1);
  fake.proc.emit('exit', 1, null);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(spawnCount, 1, '退出后不自动重开');
  const restarted = service.restart();
  setTimeout(() => fake.ready(), 10);
  assert.equal(await restarted, true);
  assert.equal(spawnCount, 2);
  await service.stop();
});

// —— 异步 spool 写：open('wx') 独占 → 登记 → 写 → 关 → 统一删 ——
// 门控 open，测试自己决定何时拿到句柄、句柄怎么写/怎么失败。
function gatedFs() {
  const real = require('node:fs');
  const gates = [];
  const promises = Object.create(real.promises);
  Object.defineProperty(promises, 'open', { value: (file, flags) => new Promise((resolve, reject) => {
    gates.push({
      file, flags, reject,
      give(handle) { resolve(handle); },
      async giveReal(overrides = {}) {
        const realHandle = await real.promises.open(file, flags);
        resolve({
          writeFile: overrides.writeFile ? bytes => overrides.writeFile(realHandle, bytes) : bytes => realHandle.writeFile(bytes),
          close: () => realHandle.close()
        });
      }
    });
  }) });
  const wrapper = Object.create(real);
  Object.defineProperty(wrapper, 'promises', { value: promises, enumerable: true });
  return { fs: wrapper, gates };
}

test('publish 的 spool 写是异步的：写完才开始发布，慢写期间不占主线程', async () => {
  const spool = tempSpool();
  const fake = fakeSpawn();
  const { fs: gated, gates } = gatedFs();
  let publishSeen = null;
  const proc = fake.proc;
  const originalWrite = proc.stdin.write;
  proc.stdin.write = line => {
    try { const parsed = JSON.parse(line); if (parsed.cmd === 'publish') publishSeen = parsed; } catch { /* 非 JSON 不管。 */ }
    return originalWrite(line);
  };
  const service = createClipboardService({ spoolDir: spool, spawn: () => proc, fs: gated });
  service.start(); fake.ready();
  let settled = false;
  const pending = service.publish([{ format: 'text', bytes: Buffer.from('慢写', 'utf8') }]).then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gates.length, 1, '先发起一次异步 open');
  assert.equal(gates[0].flags, 'wx', '独占创建');
  assert.equal(publishSeen, null, '句柄没拿到前不许发布');
  assert.equal(settled, false);
  await gates[0].giveReal();
  const result = await pending;
  assert.equal(result.published, true);
  assert.ok(publishSeen && publishSeen.cmd === 'publish', '写完才发 publish 命令');
  assert.deepEqual(fs.readdirSync(spool), [], '成功后回收自己的负载');
  await service.dispose();
});

test('创建成功但写到一半失败：自己这个文件被清掉，不发布', async () => {
  const spool = tempSpool();
  let spawned = false;
  const { fs: gated, gates } = gatedFs();
  const service = createClipboardService({ spoolDir: spool, spawn: () => { spawned = true; throw new Error('不该发布'); }, fs: gated });
  const pending = service.publish([{ format: 'png', bytes: Buffer.alloc(1024, 7) }]);
  await new Promise(resolve => setImmediate(resolve));
  await gates[0].giveReal({
    writeFile: async (handle, bytes) => {
      await handle.write(bytes.subarray(0, 10));   // 只写进去一小截
      throw Object.assign(new Error('磁盘写了半截就满'), { code: 'ENOSPC' });
    }
  });
  await assert.rejects(() => pending, /磁盘写了半截就满|ENOSPC/);
  assert.equal(spawned, false, '写失败不进发布');
  assert.deepEqual(fs.readdirSync(spool), [], '部分写失败也不留半截文件');
});

test('先有同名文件：open 报 EEXIST，不登记也不删别人的文件', async () => {
  const spool = tempSpool();
  const existing = path.join(spool, '别人的文件.png');
  fs.writeFileSync(existing, '原有内容');
  const { fs: gated, gates } = gatedFs();
  const service = createClipboardService({ spoolDir: spool, spawn: () => { throw new Error('不该发布'); }, fs: gated });
  const pending = service.publish([{ format: 'png', bytes: Buffer.from('x') }]);
  await new Promise(resolve => setImmediate(resolve));
  gates[0].reject(Object.assign(new Error('已有同名文件'), { code: 'EEXIST' }));
  await assert.rejects(() => pending, /已有同名文件|EEXIST/);
  assert.equal(fs.readFileSync(existing, 'utf8'), '原有内容', '别人的文件原样不动');
});

test('写完之后被取消/服务被关：回收文件并如实报错，不发布', async () => {
  const spool = tempSpool();
  let spawned = false;
  const { fs: gated, gates } = gatedFs();
  let current = true;
  const service = createClipboardService({ spoolDir: spool, spawn: () => { spawned = true; throw new Error('不该发布'); }, fs: gated });
  const pending = service.publish([{ format: 'png', bytes: Buffer.from('x') }], { isCurrent: () => current });
  await new Promise(resolve => setImmediate(resolve));
  current = false;   // 写完但还没进发布点的窗口里被取消
  await gates[0].giveReal();
  await assert.rejects(() => pending, /复制已取消/);
  assert.equal(spawned, false);
  assert.deepEqual(fs.readdirSync(spool), [], '取消后回收自己写的文件');

  const second = gatedFs();
  const service2 = createClipboardService({ spoolDir: spool, spawn: () => { spawned = true; throw new Error('不该发布'); }, fs: second.fs });
  const pending2 = service2.publish([{ format: 'png', bytes: Buffer.from('y') }]);
  await new Promise(resolve => setImmediate(resolve));
  const closing = service2.dispose();
  await second.gates[0].giveReal();
  await assert.rejects(() => pending2, /已关闭/);
  await closing;
  assert.deepEqual(fs.readdirSync(spool), [], '关闭后回收自己写的文件');
});

test('ACK 失败：清理本次文件并报错', async () => {
  const spool = tempSpool();
  const fake = fakeSpawn({ publishOk: false });
  const service = createClipboardService({ spoolDir: spool, spawn: () => fake.proc });
  const started = service.start();
  fake.ready();
  await started;
  await assert.rejects(() => service.publish([{ format: 'png', bytes: Buffer.from('z') }]), /拒绝接收/);
  assert.deepEqual(fs.readdirSync(spool), [], 'ACK 失败也清理自己写的负载');
  await service.dispose();
});

test('成功 ACK 之后 isCurrent 变 false：仍然如实返回成功，不假报取消', async () => {
  const spool = tempSpool();
  const fake = fakeSpawn();
  let cancelled = false;
  const proc = fake.proc;
  const originalWrite = proc.stdin.write;
  // 一发出 publish 命令就算“已越过取消点”，此后的取消不能再把已成功的复制改判失败。
  proc.stdin.write = line => {
    try { const parsed = JSON.parse(line); if (parsed.cmd === 'publish') cancelled = true; } catch { /* 忽略。 */ }
    return originalWrite(line);
  };
  const service = createClipboardService({ spoolDir: spool, spawn: () => proc });
  service.start(); fake.ready();
  const result = await service.publish([{ format: 'png', bytes: Buffer.from('k') }], { isCurrent: () => !cancelled });
  assert.equal(result.published, true);
  assert.equal(result.ok, true);
  assert.equal(cancelled, true, '发布命令确实发出过，之后才置为取消');
  assert.deepEqual(fs.readdirSync(spool), [], '成功之后照常回收');
  await service.dispose();
});
