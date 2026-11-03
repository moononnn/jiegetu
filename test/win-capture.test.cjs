'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { createWinCapture, queryMonitorBounds, queryMonitorWorkArea, parseMonitorBounds, fitSelectionWindow, fitHiddenWindow, handleToDecimal } = require('../main/win-capture.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// 真跑原生产物，不只信假 spawn：JS 测试过了但 exe 没重编时这里必须失败。
const nativeExe = path.join(__dirname, '..', 'native', 'wgc-capture.exe');
const nativeSkip = process.platform !== 'win32' ? '仅 Windows 运行 WGC 原生回归' :
  !fs.existsSync(nativeExe) ? '尚未构建 native/wgc-capture.exe' : false;
function runNative(args) {
  return spawnSync(nativeExe, args, { windowsHide: true, timeout: 15000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const region = { x: -20, y: 5, width: 2, height: 2 };
function packet({ sequence = 1, fresh = true, width = 2, height = 2, magic = 'JGC2', flags = fresh ? 1 : 0 } = {}) {
  const header = Buffer.alloc(20); header.write(magic); header.writeUInt32LE(width, 4); header.writeUInt32LE(height, 8);
  header.writeUInt32LE(sequence, 12); header.writeUInt32LE(flags, 16);
  return fresh ? Buffer.concat([header, Buffer.from([1,2,3,255,4,5,6,255,7,8,9,255,10,11,12,255])]) : header;
}
function harness(options = {}) {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.writes = []; child.kills = 0; child.stdin.write = value => child.writes.push(value.toString());
  child.stdin.end = value => child.writes.push(value.toString()); child.kill = () => { child.kills++; };
  let called;
  const source = createWinCapture(region, { ...options, spawn: (...args) => { called = args; return child; } });
  return { source, child, called };
}
test('只用隐藏控制台的独立原生进程，无 shell，物理 ROI 不缩放', async () => {
  const h = harness(); assert.deepEqual(h.called[1], ['-20','5','2','2']);
  assert.equal(h.called[2].windowsHide, true); assert.equal(h.called[2].shell, undefined);
  const waiting = h.source.next(); assert.deepEqual(h.child.writes, ['N']); h.child.stdout.emit('data', packet());
  const image = await waiting; assert.equal(image.fresh, true); assert.equal(image.sequence, 1); assert.equal(image.data.length, 16);
  assert.deepEqual([...image.data], [1,2,3,255,4,5,6,255,7,8,9,255,10,11,12,255]); h.source.stop();
});
test('任意管道拆包均可拼成完整帧，返回像素拥有独立内存', async () => {
  const h = harness(), p = h.source.next(), bytes = packet();
  for (const byte of bytes) h.child.stdout.emit('data', Buffer.from([byte]));
  const image = await p; const next = h.source.next(); const second = packet({ sequence: 2 }); second[20] = 77;
  h.child.stdout.emit('data', second); assert.equal((await next).data[0], 77); assert.equal(image.data[0], 1); h.source.stop();
});
test('无新帧只返回标记，无缓存像素，不能冒充新帧', async () => {
  const h = harness(); let p = h.source.next(); h.child.stdout.emit('data', packet()); await p;
  p = h.source.next(); h.child.stdout.emit('data', packet({ fresh: false }));
  assert.deepEqual(await p, { fresh: false, sequence: 1, width: 2, height: 2 }); h.source.stop();
});
test('全屏新帧但选区逐字节未变时，不重复传像素给匹配队列', async () => {
  const h = harness(); let p = h.source.next(); h.child.stdout.emit('data', packet()); await p;
  for (let sequence = 2; sequence <= 20; sequence++) {
    p = h.source.next(); h.child.stdout.emit('data', packet({ sequence }));
    assert.deepEqual(await p, { fresh: false, sequence, width: 2, height: 2 });
  }
  h.source.stop();
});
test('一个通道变化也保留，改动后回到原图同样是新画面', async () => {
  const h = harness(); let p = h.source.next(); h.child.stdout.emit('data', packet()); const first = await p;
  p = h.source.next(); const second = packet({ sequence: 2 }); second[35] = 254; h.child.stdout.emit('data', second);
  const changed = await p; assert.equal(changed.fresh, true); assert.equal(changed.data[15], 254);
  p = h.source.next(); h.child.stdout.emit('data', packet({ sequence: 3 }));
  const returned = await p; assert.equal(returned.fresh, true); assert.deepEqual(returned.data, first.data); h.source.stop();
});
test('调用方不能改写去重参照，静止标记也不能清掉参照', async () => {
  const h = harness(); let p = h.source.next(); h.child.stdout.emit('data', packet()); const first = await p;
  first.data.fill(0);
  p = h.source.next(); h.child.stdout.emit('data', packet({ fresh: false })); assert.equal((await p).fresh, false);
  p = h.source.next(); h.child.stdout.emit('data', packet({ sequence: 2 })); assert.equal((await p).fresh, false); h.source.stop();
});
test('普通快照是一次性取帧：同样字节也各带像素，不留整帧参照', async () => {
  const h = harness({ purpose: 'snapshot' }); assert.deepEqual(h.called[1], ['-20','5','2','2','--snapshot']);
  let p = h.source.next(); h.child.stdout.emit('data', packet()); const first = await p;
  assert.equal(first.fresh, true); assert.equal(first.data.length, 16);
  // 旧实现会把首帧拷成参照并因此把第二帧判成 fresh:false；一次性取帧不该留这份副本。
  for (let sequence = 2; sequence <= 5; sequence++) {
    p = h.source.next(); h.child.stdout.emit('data', packet({ sequence }));
    const again = await p; assert.equal(again.fresh, true, 'sequence ' + sequence); assert.deepEqual([...again.data], [...first.data]);
  }
  h.source.stop();
});
test('普通快照仍严格校验帧头、序号与新鲜度', async () => {
  let h = harness({ purpose: 'snapshot' }), p = h.source.next(); h.child.stdout.emit('data', packet()); await p;
  p = h.source.next(); h.child.stdout.emit('data', packet()); await assert.rejects(p, /帧头或顺序/); assert.equal(h.child.kills, 1);
  h = harness({ purpose: 'snapshot' }); p = h.source.next(); h.child.stdout.emit('data', packet({ fresh: false }));
  await assert.rejects(p, /帧头或顺序/); assert.equal(h.child.kills, 1);
  h = harness({ purpose: 'snapshot' }); p = h.source.next(); h.child.stdout.emit('data', packet({ magic: 'BAD!' }));
  await assert.rejects(p, /帧头或顺序/); assert.equal(h.child.kills, 1);
  h = harness({ purpose: 'snapshot' }); p = h.source.next(); h.child.stdout.emit('data', Buffer.concat([packet(), Buffer.from([1])]));
  await assert.rejects(p, /像素/); assert.equal(h.child.kills, 1);
});
test('scroll 与 record 的逐字节去重与私有参照未受影响', async () => {
  for (const purpose of ['scroll', 'record']) {
    const h = harness({ purpose });
    let p = h.source.next(); h.child.stdout.emit('data', packet()); const first = await p;
    assert.equal(first.fresh, true);
    p = h.source.next(); h.child.stdout.emit('data', packet({ sequence: 2 }));
    assert.deepEqual(await p, { fresh: false, sequence: 2, width: 2, height: 2 }, purpose);
    // 单通道变化仍是新帧；调用方改写像素后，参照仍能把改回的原图判成静止。
    p = h.source.next(); const changed = packet({ sequence: 3 }); changed[20] = 9; h.child.stdout.emit('data', changed);
    const image = await p; assert.equal(image.fresh, true); assert.equal(image.data[0], 9); image.data.fill(0);
    p = h.source.next(); const sameAgain = packet({ sequence: 4 }); sameAgain[20] = 9; h.child.stdout.emit('data', sameAgain);
    assert.equal((await p).fresh, false, purpose); // 参照是私有副本，调用方改写像素不影响去重
    p = h.source.next(); h.child.stdout.emit('data', packet({ sequence: 5 }));
    assert.equal((await p).fresh, true, purpose); // 改回原图同样是新画面
    h.source.stop();
  }
});
test('同一时刻只有一次原生采样，并发请求不会增加内存或发第二条指令', async () => {
  const h = harness(), p = h.source.next(); await assert.rejects(h.source.next(), /上一帧/);
  assert.deepEqual(h.child.writes, ['N']); h.child.stdout.emit('data', packet()); await p; h.source.stop();
});
for (const [name, options] of [['magic',{magic:'BAD!'}],['size',{width:1}],['flags',{flags:2}],['zero-sequence',{sequence:0}]]) {
  test(`非法 ${name} 立即停原生源，不猜测像素`, async () => {
    const h = harness(), p = h.source.next(); h.child.stdout.emit('data', packet(options));
    await assert.rejects(p, /帧头或顺序/); assert.equal(h.child.kills, 1); await assert.rejects(h.source.next());
  });
}
test('回退的帧序号和首次无新帧不能通过', async () => {
  for (const firstStale of [false, true]) {
    const h = harness(); let p = h.source.next();
    h.child.stdout.emit('data', packet({ fresh: !firstStale }));
    if (firstStale) await assert.rejects(p, /顺序/);
    else { await p; p = h.source.next(); h.child.stdout.emit('data', packet()); await assert.rejects(p, /顺序/); }
  }
});
test('多余像素或无新帧夹带像素都拒收', async () => {
  for (const stale of [false, true]) {
    const h = harness(); let p = h.source.next(); h.child.stdout.emit('data', packet()); await p;
    p = h.source.next(); h.child.stdout.emit('data', Buffer.concat([packet({ sequence: stale ? 1 : 2, fresh: !stale }), Buffer.from([1])]));
    await assert.rejects(p, /像素/); assert.equal(h.child.kills, 1);
  }
});
test('进程中断/半帧 EOF 不会输出不完整像素', async () => {
  const h = harness(), p = h.source.next(); h.child.stdout.emit('data', packet().subarray(0, 25));
  h.child.stderr.emit('data', Buffer.from('capture-helper:monitor-changed')); h.child.stdout.emit('end'); h.child.emit('close', 1, null);
  await assert.rejects(p, /monitor-changed（exit code=1 signal=null）/); assert.equal(h.child.kills, 1);
});
test('EOF 后只在 close 结案，退出码与 stderr 尾部一起到', async () => {
  const h = harness(), source = h.source.next();
  let settled = false;
  const tracked = source.then(value => { settled = true; return value; }, error => { settled = true; throw error; });
  h.child.stdout.emit('end');
  await delay(50); // 比旧 25ms 竞速窗口更久，不能在这里提前结案
  assert.equal(settled, false, 'EOF 后进程未 close 就不能抢答');
  h.child.stderr.emit('data', Buffer.from('capture-helper:frame-broken'));
  h.child.emit('exit', 3, null);
  h.child.emit('close', 3, null);
  await assert.rejects(tracked, /frame-broken（exit code=3 signal=null）/);
});
test('EOF 但进程不退由 next 超时兜底，取消后 close 不重复拒绝', async () => {
  const stale = harness({ timeoutMs: 40 }), pending = stale.source.next();
  stale.child.stdout.emit('end');
  await assert.rejects(pending, /超时/);
  assert.equal(stale.child.kills, 1);
  const cancelled = harness(), aborted = cancelled.source.next();
  cancelled.source.stop();
  cancelled.child.stderr.emit('data', Buffer.from('capture-helper:late'));
  cancelled.child.emit('close', 0, null);
  await assert.rejects(aborted, /已取消/);
  await assert.rejects(cancelled.source.next(), /已取消/);
});
test('信号结束同样带退出码与信号', async () => {
  const h = harness(), p = h.source.next();
  h.child.stderr.emit('data', Buffer.from('capture-helper:frame-broken'));
  h.child.emit('close', null, 'SIGTERM');
  await assert.rejects(p, /frame-broken（exit code=null signal=SIGTERM）/);
});
test('取消拒绝待采样，晚到回包不再处理，重复 stop 安全', async () => {
  const h = harness(), p = h.source.next(); h.source.stop(); h.source.stop();
  h.child.stdout.emit('data', packet()); await assert.rejects(p, /已取消/); await assert.rejects(h.source.next(), /已取消/);
  assert.deepEqual(h.child.writes, ['N','Q']); h.child.emit('exit', 0);
});
test('原生采样有超时，超时后终止子进程', async () => {
  const h = harness({ timeoutMs: 10 }); await assert.rejects(h.source.next(), /超时/); assert.equal(h.child.kills, 1);
});
test('启动失败与管道错误不会悬挂 Promise', async () => {
  for (const start of [true, false]) {
    const h = harness(), p = h.source.next();
    (start ? h.child : h.child.stdin).emit('error', new Error('fixture-error'));
    await assert.rejects(p, /fixture-error/); assert.equal(h.child.kills, 1);
  }
});
test('异常 ROI 在创建进程前拒绝', () => {
  for (const invalid of [{ ...region, x: NaN }, { ...region, width: 0 }, { ...region, height: 1.2 }, { ...region, width: 16000001 }]) {
    assert.throws(() => createWinCapture(invalid, { spawn: () => { throw new Error('should-not-spawn'); } }), /无效原生/);
  }
});
const hint = { x: 3840, y: 548, width: 1922, height: 1082 };
function fakeExecFile({ stdout = '', error = null, record } = {}) {
  return (file, args, options, callback) => {
    record?.push({ file, args, options });
    queueMicrotask(() => callback(error, stdout, error ? 'monitor-not-found' : ''));
  };
}
test('监视器矩形查询：参数与进程选项固定，返回真实 1920×1080', async () => {
  const calls = [];
  const bounds = await queryMonitorBounds(hint, { scaleFactor: 1.75, execFile: fakeExecFile({ stdout: '{"x":3840,"y":548,"width":1920,"height":1080}\n', record: calls }) });
  assert.deepEqual(bounds, { x: 3840, y: 548, width: 1920, height: 1080 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['--monitor-info', '3840', '548', '1922', '1082']);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.shell, undefined);
  assert.ok(calls[0].options.timeout <= 5000);
  assert.ok(calls[0].options.maxBuffer <= 4096, '回包上限必须小');
  assert.match(calls[0].file, /wgc-capture\.exe$/);
});
test('监视器矩形查询：hint 偏差容限跟随 ceil(缩放)，不是固定 2px', async () => {
  const reply = (x, y, width, height) => fakeExecFile({ stdout: JSON.stringify({ x, y, width, height }) });
  // 175%：ceil(1.75)=2，现场 1922→1920 的 2px 差异可接受。
  assert.deepEqual(await queryMonitorBounds(hint, { scaleFactor: 1.75, execFile: reply(3840, 548, 1920, 1080) }),
    { x: 3840, y: 548, width: 1920, height: 1080 });
  // 150%：ceil(1.5)=2，同样 2px 可接受；3px 已超出本屏取整误差。
  assert.deepEqual(await queryMonitorBounds(hint, { scaleFactor: 1.5, execFile: reply(3840, 548, 1920, 1080) }),
    { x: 3840, y: 548, width: 1920, height: 1080 });
  await assert.rejects(queryMonitorBounds(hint, { scaleFactor: 1.75, execFile: reply(3840, 548, 1919, 1080) }), /差异过大/);
  // 100%：ceil(1)=1，多 2px 必须拒；等同“不把 2px 写死”。
  await assert.rejects(queryMonitorBounds(hint, { scaleFactor: 1, execFile: reply(3840, 548, 1920, 1080) }), /差异过大/);
  // 明显错屏：整块平移。
  await assert.rejects(queryMonitorBounds(hint, { scaleFactor: 1.75, execFile: reply(1920, 548, 1920, 1080) }), /未包含查询中心|差异过大/);
  await assert.rejects(queryMonitorBounds(hint, { scaleFactor: 1.75, execFile: reply(4200, 548, 1920, 1080) }), /未包含查询中心|差异过大/);
  for (const scaleFactor of [undefined, 0, -1, NaN, 9]) {
    await assert.rejects(queryMonitorBounds(hint, { scaleFactor, execFile: () => { throw new Error('should-not-spawn'); } }), /缺少有效缩放/);
  }
});
test('监视器矩形查询：非零退出、畸形内容、多余字段、越界、中心不符均拒绝', async () => {
  const cases = [
    [{ error: new Error('exit 1') }, /显示器矩形查询失败/],
    [{ stdout: '' }, /长度异常/],
    [{ stdout: '{"x":3840,"y":548,"width":1920,"height":1080}{"x":0}' }, /无法解析/],
    [{ stdout: '{"x":3840,"y":548,"width":1920,"height":1080,"label":"屏"}' }, /字段异常/],
    [{ stdout: '{"x":3840,"y":548,"width":NaN,"height":1080}' }, /无法解析/],
    [{ stdout: '{"x":3840.5,"y":548,"width":1920,"height":1080}' }, /非整数/],
    [{ stdout: '{"x":null,"y":548,"width":1920,"height":1080}' }, /非整数/],
    [{ stdout: '{"x":3840,"y":548,"width":0,"height":1080}' }, /范围异常/],
    [{ stdout: '{"x":2000000,"y":548,"width":1920,"height":1080}' }, /范围异常/],
    [{ stdout: '{"x":0,"y":0,"width":1920,"height":1080}' }, /未包含查询中心/],
    [{ stdout: '[]' }, /格式不符/]
  ];
  for (const [response, pattern] of cases) {
    await assert.rejects(queryMonitorBounds(hint, { scaleFactor: 1.75, execFile: fakeExecFile(response) }), pattern, JSON.stringify(response));
  }
});
test('监视器矩形查询：hint 非法或启动失败时不拉起子进程', async () => {
  for (const invalid of [{ x: NaN, y: 0, width: 2, height: 2 }, { x: 0, y: 0, width: 0, height: 2 },
    { x: 0, y: 0, width: 2, height: 2.5 }, { x: 2000000, y: 0, width: 2, height: 2 }, null]) {
    await assert.rejects(queryMonitorBounds(invalid, { scaleFactor: 1, execFile: () => { throw new Error('should-not-spawn'); } }), /无效显示器矩形查询范围/);
  }
  await assert.rejects(queryMonitorBounds(hint, { scaleFactor: 1, execFile: () => { throw new Error('spawn-failed'); } }), /无法启动/);
});
test('parseMonitorBounds 只接受单一完整 JSON 对象', () => {
  assert.deepEqual(parseMonitorBounds(' {"x":-1920,"y":0,"width":1920,"height":1080} ', { x: -1920, y: 0, width: 1922, height: 1082 }, { scaleFactor: 1.75 }),
    { x: -1920, y: 0, width: 1920, height: 1080 });
  for (const bad of ['{"x":0,"y":0,"width":2,"height":2} extra', 'true', 'null', '{"x":0,"y":0,"width":2}']) {
    assert.throws(() => parseMonitorBounds(bad, { x: 0, y: 0, width: 2, height: 2 }, { scaleFactor: 1 }));
  }
});
test('原生 exe 元数据模式：只读返回真实监视器矩形，同屏 ±2px hint 都落到同一块', { skip: nativeSkip }, () => {
  // 包住整个桌面的大 hint 只用来选屏，不采任何像素，也不受采集预算限制。
  const wide = runNative(['--monitor-info', '-999999', '-999999', '1999998', '1999998']);
  assert.equal(wide.status, 0, wide.stderr);
  assert.equal(wide.stderr, '');
  const real = JSON.parse(wide.stdout);
  assert.deepEqual(Object.keys(real).sort(), ['height', 'width', 'x', 'y']);
  assert.ok([real.x, real.y, real.width, real.height].every(Number.isSafeInteger));
  assert.ok(real.width > 0 && real.height > 0);
  const exact = runNative(['--monitor-info', String(real.x), String(real.y), String(real.width), String(real.height)]);
  assert.equal(exact.status, 0, exact.stderr); assert.deepEqual(JSON.parse(exact.stdout), real, '同一块屏可重复查询');
  const bigger = runNative(['--monitor-info', String(real.x - 2), String(real.y - 2), String(real.width + 4), String(real.height + 4)]);
  assert.equal(bigger.status, 0, bigger.stderr); assert.deepEqual(JSON.parse(bigger.stdout), real, '元数据模式允许 hint 比监视器大 2px');
  // 同一 +2px 矩形交给真实采集仍必须在分配前被包含校验拒绝，元数据放宽不外溢。
  const capture = runNative([String(real.x), String(real.y), String(real.width + 2), String(real.height + 2), '--snapshot']);
  assert.equal(capture.status, 1); assert.match(capture.stderr, /region-outside-monitor/); assert.equal(capture.stdout, '');
  for (const args of [['--monitor-info', '0', '0', '1', '1', 'extra'], ['--monitor-info', '0', '0', '1.5', '1'], ['--monitor-info', '0', '0', '0', '1'],
    ['--monitor-info', '-2000000', '0', '10', '10']]) {
    const bad = runNative(args);
    assert.equal(bad.status, 1, args.join(' ')); assert.equal(bad.stdout, '', args.join(' '));
    assert.match(bad.stderr, /invalid-arguments|invalid-region/, args.join(' '));
  }
  for (const args of [['--monitor-info', '0', '0', '1', '1', '--snapshot'], ['--monitor-info', '0', '0', '1']]) {
    const bad = runNative(args);
    assert.equal(bad.status, 1, args.join(' ')); assert.match(bad.stderr, /invalid-arguments/, args.join(' ')); assert.equal(bad.stdout, '');
  }
});

const canonical = { x: 3840, y: 548, width: 1920, height: 1080 };
const nonce = '0123456789abcdef0123456789abcdef';
test('物理窗口适配：异步 execFile 传十进制 HWND/PID/nonce 与真实矩形，回读必须严格相等', async () => {
  const calls = [];
  const result = await fitSelectionWindow('1234567890', 4321, nonce, canonical, { execFile: fakeExecFile({ stdout: JSON.stringify(canonical), record: calls }) });
  assert.deepEqual(result, canonical);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['--fit-selection-window', '1234567890', '4321', nonce, '3840', '548', '1920', '1080']);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.shell, undefined);
  assert.ok(calls[0].options.timeout <= 5000);
  assert.ok(calls[0].options.maxBuffer <= 4096);
  assert.match(calls[0].file, /wgc-capture\.exe$/);
  // 跨进程 SetWindowPos 会同步发 WM_SIZE：必须异步，否则父 GUI 线程会被堵死。
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'main', 'win-capture.cjs'), 'utf8'), /execFileSync/);
});
test('物理窗口适配：回读差一像素、畸形内容、多余字段、进程失败一律拒绝', async () => {
  const cases = [
    [{ stdout: JSON.stringify({ ...canonical, width: 1922 }) }, /窗口物理矩形与目标不符/],
    [{ stdout: JSON.stringify({ ...canonical, x: 3841 }) }, /窗口物理矩形与目标不符/],
    [{ stdout: JSON.stringify({ ...canonical, extra: 1 }) }, /字段异常/],
    [{ stdout: '{"x":3840}' }, /字段异常/],
    [{ stdout: '' }, /长度异常/],
    [{ stdout: '{} {}' }, /无法解析/],
    [{ error: new Error('window-visible') }, /窗口物理布局失败/]
  ];
  for (const [response, pattern] of cases) {
    await assert.rejects(fitSelectionWindow('1234567890', 4321, nonce, canonical, { execFile: fakeExecFile(response) }), pattern, JSON.stringify(response));
  }
});
test('物理窗口适配：非法句柄、PID、nonce、目标矩形在拉起进程前拒绝', async () => {
  const never = () => { throw new Error('should-not-spawn'); };
  for (const handle of [1234567890, '0', '', ' 123', '0x10', '-5', '12.5', '123456789012345678901', null, undefined]) {
    await assert.rejects(fitSelectionWindow(handle, 4321, nonce, canonical, { execFile: never }), /无效窗口句柄/, String(handle));
  }
  for (const pid of [0, -1, 1.5, '4321', NaN, null, 4294967296]) {
    await assert.rejects(fitSelectionWindow('1234567890', pid, nonce, canonical, { execFile: never }), /无效进程标识/, String(pid));
  }
  // nonce 必须是 32 位小写十六进制：空、大写、短、非十六进制、带引号都不行。
  for (const bad of ['', 'ABCDEF0123456789ABCDEF0123456789', '0123456789abcdef0123456789abcde', '0123456789abcdef0123456789abcdeg',
    '0123456789abcdef0123456789abcdef ', null, 123, `${nonce}"`]) {
    await assert.rejects(fitSelectionWindow('1234567890', 4321, bad, canonical, { execFile: never }), /无效窗口标识/, String(bad));
  }
  for (const bounds of [null, { ...canonical, width: 0 }, { ...canonical, x: NaN }, { ...canonical, width: 4000001 }, { ...canonical, height: 2.5 }]) {
    await assert.rejects(fitSelectionWindow('1234567890', 4321, nonce, bounds, { execFile: never }), /无效窗口目标矩形/, JSON.stringify(bounds));
  }
  await assert.rejects(fitSelectionWindow('1234567890', 4321, nonce, canonical, { execFile: () => { throw new Error('spawn-failed'); } }), /无法启动/);
});
test('handleToDecimal：8 字节小端与 4 字节都转十进制，拒非 Buffer 与零值', () => {
  const wide = Buffer.alloc(8); wide.writeBigUInt64LE(0x1A2B3C4D5En, 0);
  assert.equal(handleToDecimal(wide), '112394521950');
  const narrow = Buffer.alloc(4); narrow.writeUInt32LE(0x12345678, 0);
  assert.equal(handleToDecimal(narrow), '305419896');
  for (const bad of [Buffer.alloc(6), Buffer.alloc(8), Buffer.from('123'), null, '305419896', 305419896]) {
    assert.throws(() => handleToDecimal(bad), /无效窗口句柄/);
  }
});

test('原生 exe 窗口适配模式：非法参数与已销毁 HWND 无动作失败，不回传矩形', { skip: nativeSkip }, () => {
  const bad = [
    [['--fit-selection-window', '1', '4', nonce, '0', '0', '100', '100'], /window-not-found/],
    [['--fit-hidden-window', '1', '4', nonce, '0', '0', '100', '100'], /window-not-found/],
    [['--fit-selection-window', '0', '4', nonce, '0', '0', '100', '100'], /invalid-window/],
    [['--fit-selection-window', '1234567890', '0', nonce, '0', '0', '100', '100'], /invalid-owner/],
    [['--fit-selection-window', '1', '4', 'ABCDEF0123456789ABCDEF0123456789', '0', '0', '100', '100'], /invalid-nonce/],
    [['--fit-selection-window', '1', '4', '0123456789abcdef0123456789abcde', '0', '0', '100', '100'], /invalid-nonce/],
    [['--fit-selection-window', '1', '4', nonce, '0', '0', '0', '100'], /invalid-region/],
    [['--fit-selection-window', '1', '4', nonce, '0', '0', '100'], /invalid-arguments/],
    [['--fit-selection-window', '1', '4', nonce, '0', '0', '100', '100', 'extra'], /invalid-arguments/],
    [['--fit-selection-window', 'abc', '4', nonce, '0', '0', '100', '100'], /invalid-window/]
  ];
  for (const [args, pattern] of bad) {
    const run = runNative(args);
    assert.equal(run.status, 1, args.join(' '));
    assert.equal(run.stdout, '', args.join(' '));
    assert.match(run.stderr, /capture-helper:Exception:/, args.join(' '));
    assert.match(run.stderr, pattern, args.join(' '));
  }
});

test('物理子矩形适配：浮条用 --fit-hidden-window，校验与回读严格性同选区模式', async () => {
  const calls = [], target = { x: 4360, y: 548, width: 1400, height: 700 };
  const result = await fitHiddenWindow('1234567890', 4321, nonce, target, { execFile: fakeExecFile({ stdout: JSON.stringify(target), record: calls }) });
  assert.deepEqual(result, target);
  assert.deepEqual(calls[0].args, ['--fit-hidden-window', '1234567890', '4321', nonce, '4360', '548', '1400', '700']);
  const never = () => { throw new Error('should-not-spawn'); };
  await assert.rejects(fitHiddenWindow('1234567890', 4321, 'X', target, { execFile: never }), /无效窗口标识/);
  await assert.rejects(fitHiddenWindow('1234567890', 4321, nonce, { ...target, width: 0 }, { execFile: never }), /无效窗口目标矩形/);
  await assert.rejects(fitHiddenWindow('1234567890', 4321, nonce, target, { execFile: fakeExecFile({ stdout: JSON.stringify({ ...target, y: 549 }) }) }), /窗口物理矩形与目标不符/);
});

test('工作区查询：同一严格模板只换 --workarea-info，参数与解析一致', async () => {
  const calls = [];
  const work = { x: 3840, y: 548, width: 1920, height: 996 };
  const workHint = { x: 3840, y: 548, width: 1922, height: 998 };
  const result = await queryMonitorWorkArea(workHint, { scaleFactor: 1.75, execFile: fakeExecFile({ stdout: JSON.stringify(work), record: calls }) });
  assert.deepEqual(result, work);
  assert.deepEqual(calls[0].args, ['--workarea-info', '3840', '548', '1922', '998']);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.shell, undefined);
  assert.ok(calls[0].options.maxBuffer <= 4096);
  // 同一套拒绝：畸形内容、多余字段、中心不符、非整数、缺少缩放、非法 hint。
  const bad = [
    [{ stdout: '{"x":3840,"y":548,"width":1920,"height":996,"extra":1}' }, /字段异常/],
    [{ stdout: '{"x":3840,"y":548,"width":1920.5,"height":996}' }, /非整数/],
    [{ stdout: 'nope' }, /无法解析/],
    [{ stdout: '' }, /长度异常/],
    [{ stdout: '{"x":0,"y":0,"width":1920,"height":996}' }, /未包含查询中心/],
    [{ error: new Error('exit 1') }, /显示器矩形查询失败/]
  ];
  for (const [response, pattern] of bad) {
    await assert.rejects(queryMonitorWorkArea(workHint, { scaleFactor: 1.75, execFile: fakeExecFile(response) }), pattern);
  }
  await assert.rejects(queryMonitorWorkArea(workHint, { execFile: () => { throw new Error('should-not-spawn'); } }), /缺少有效缩放/);
  await assert.rejects(queryMonitorWorkArea({ ...workHint, width: 0 }, { scaleFactor: 1.75, execFile: () => { throw new Error('should-not-spawn'); } }), /无效显示器矩形查询范围/);
  // 拿监视器 hint 去查工作区会被边差异拒绝：工作区必须用自己的 hint。
  await assert.rejects(queryMonitorWorkArea(hint, { scaleFactor: 1.75, execFile: fakeExecFile({ stdout: JSON.stringify(work) }) }), /差异过大/);
});
test('原生 exe 工作区模式：真实工作区严格落在同一块监视器内', { skip: nativeSkip }, () => {
  const monitorRun = runNative(['--monitor-info', '-999999', '-999999', '1999998', '1999998']);
  assert.equal(monitorRun.status, 0, monitorRun.stderr);
  const monitor = JSON.parse(monitorRun.stdout);
  const workRun = runNative(['--workarea-info', String(monitor.x), String(monitor.y), String(monitor.width), String(monitor.height)]);
  assert.equal(workRun.status, 0, workRun.stderr);
  const work = JSON.parse(workRun.stdout);
  assert.deepEqual(Object.keys(work).sort(), ['height', 'width', 'x', 'y']);
  assert.ok(work.x >= monitor.x && work.y >= monitor.y);
  assert.ok(work.x + work.width <= monitor.x + monitor.width);
  assert.ok(work.y + work.height <= monitor.y + monitor.height);
  assert.ok(work.width > 0 && work.height > 0);
  // 参数错误和越界仍在本模式前被拒。
  for (const args of [['--workarea-info', '0', '0', '1.5', '1'], ['--workarea-info', '0', '0', '0', '1'], ['--workarea-info', '0', '0', '1']]) {
    const run = runNative(args);
    assert.equal(run.status, 1, args.join(' ')); assert.equal(run.stdout, '', args.join(' '));
    assert.match(run.stderr, /invalid-arguments|invalid-region/);
  }
});

function idleChild() {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.writes = []; child.stdin.write = value => child.writes.push(value.toString());
  child.stdin.end = value => child.writes.push(value.toString()); child.kill = () => {};
  return child;
}
test('普通快照按 36M 预算启动，第五参数精确为 --snapshot', () => {
  for (const geometry of [{ width: 6016, height: 3384 }, { width: 6144, height: 3456 }, { width: 7680, height: 2160 }, { width: 6000, height: 6000 }]) {
    const child = idleChild(), calls = [];
    const source = createWinCapture({ x: 0, y: 0, ...geometry }, { purpose: 'snapshot', spawn: (...args) => { calls.push(args); return child; } });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][1], ['0', '0', String(geometry.width), String(geometry.height), '--snapshot']);
    assert.equal(calls[0][2].windowsHide, true); assert.equal(calls[0][2].shell, undefined);
    source.stop();
  }
});
test('延迟启动只允许快照：传 --snapshot-lazy，alive/status 能判断死源', () => {
  const child = idleChild(), calls = [];
  const source = createWinCapture({ x: 0, y: 0, width: 100, height: 100 },
    { purpose: 'snapshot', deferredStart: true, spawn: (...args) => { calls.push(args); return child; } });
  assert.deepEqual(calls[0][1], ['0', '0', '100', '100', '--snapshot-lazy']);
  assert.equal(source.deferred, true);
  assert.equal(source.alive, true);
  assert.equal(source.status, 'ready');
  child.exitCode = 1; child.emit('close', 1, null);
  assert.equal(source.alive, false);
  assert.equal(source.status, 'failed');
});
test('deferredStart 只用于 snapshot 且必须是布尔值，否则不启动进程', () => {
  const never = () => { throw new Error('should-not-spawn'); };
  assert.throws(() => createWinCapture({ x: 0, y: 0, width: 10, height: 10 }, { purpose: 'scroll', deferredStart: true, spawn: never }), /普通快照/);
  assert.throws(() => createWinCapture({ x: 0, y: 0, width: 10, height: 10 }, { purpose: 'snapshot', deferredStart: 'yes', spawn: never }), /启动方式/);
});
test('未指定或指定 scroll 时保持四参数，非快照进程协议不变', () => {
  for (const purpose of [undefined, 'scroll']) {
    const child = idleChild(), calls = [];
    const source = createWinCapture(region, { ...(purpose === undefined ? {} : { purpose }), spawn: (...args) => { calls.push(args); return child; } });
    assert.deepEqual(calls[0][1], ['-20', '5', '2', '2']); source.stop();
  }
});
test('16M/36M 边界：整值可启动，超一像素在创建进程前拒绝', () => {
  const launch = (geometry, purpose) => { const child = idleChild(); const source = createWinCapture({ x: 0, y: 0, ...geometry }, { purpose, spawn: () => child }); source.stop(); };
  const rejected = (geometry, purpose) => assert.throws(() => createWinCapture({ x: 0, y: 0, ...geometry }, { purpose, spawn: () => { throw new Error('should-not-spawn'); } }), /无效原生采集范围/);
  launch({ width: 4000, height: 4000 }, 'scroll'); launch({ width: 4000, height: 4000 });
  rejected({ width: 4000, height: 4001 }, 'scroll');
  launch({ width: 6000, height: 6000 }, 'snapshot');
  rejected({ width: 6000, height: 6001 }, 'snapshot');
  rejected({ width: 8000, height: 4600 }, 'snapshot');
  // 6K 桌面在默认（长截图）预算下仍拒绝，不因新增用途放宽滚动采样。
  rejected({ width: 6016, height: 3384 }, undefined); rejected({ width: 7680, height: 2160 });
});
test('用途只接受 scroll 与 snapshot，其余取值不启动进程', () => {
  for (const purpose of ['long', 'SNAPSHOT', '', 'toString', null, 0]) {
    assert.throws(() => createWinCapture(region, { purpose, spawn: () => { throw new Error('should-not-spawn'); } }), /无效原生采集用途/);
  }
});
test('原生 exe 预算：四参数 20M 拒绝，--snapshot 同尺寸只越界、不进入捕获', { skip: nativeSkip }, () => {
  // 1e6 坐标是合法范围但必不在本机监视器内：既不取桌面，也不会到 region-outside-monitor 之后。
  const scroll = runNative(['1000000', '1000000', '5000', '4000']);
  assert.equal(scroll.status, 1, scroll.stderr);
  assert.match(scroll.stderr, /capture-helper:Exception:invalid-region/, '默认预算仍是 1600 万');
  assert.doesNotMatch(scroll.stderr, /invalid-arguments/, '四参数必须被接受后才判区域');
  assert.equal(scroll.stdout, '', '拒绝不得回传帧');
  const snapshot = runNative(['1000000', '1000000', '5000', '4000', '--snapshot']);
  assert.equal(snapshot.status, 1, snapshot.stderr);
  assert.doesNotMatch(snapshot.stderr, /invalid-arguments/, '第五参数 --snapshot 必须被接受，否则说明 exe 未重编');
  assert.doesNotMatch(snapshot.stderr, /invalid-region/, '20M 在 36M 预算内，不能当越界预算拒');
  assert.match(snapshot.stderr, /capture-helper:Exception:region-outside-monitor/);
  assert.equal(snapshot.stdout, '', '越界在分配与捕获前停住，不回传像素');
  const lazy = runNative(['1000000', '1000000', '8000', '4600', '--snapshot-lazy']);
  assert.equal(lazy.status, 1, lazy.stderr);
  assert.doesNotMatch(lazy.stderr, /invalid-arguments/, '第五参数 --snapshot-lazy 必须被接受，否则说明 exe 未重编');
  assert.match(lazy.stderr, /capture-helper:Exception:invalid-region/);
  assert.equal(lazy.stdout, '');
});
test('原生 --snapshot-lazy：EOF 不取帧、不输出像素就退出', { skip: nativeSkip }, () => {
  const info = runNative(['--monitor-info', '-999999', '-999999', '1999998', '1999998']);
  if (info.status !== 0) return;
  const real = JSON.parse(info.stdout);
  const run = runNative([String(real.x), String(real.y), '64', '64', '--snapshot-lazy']);
  if (/wgc-not-supported/.test(run.stderr)) return; // 本会话不支持 WGC 时不当成失败
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '', '没有 N 就不应写任何帧/像素');
  assert.equal(run.stderr, '');
});
test('原生 exe 参数：非 --snapshot 的第五参数与非整数拒绝，36M 以上快照拒绝', { skip: nativeSkip }, () => {
  for (const args of [['1000000', '1000000', '100', '100', '--capture'], ['1000000', '1000000', '100', '100', '--SNAPSHOT'],
    ['1000000', '1000000', '100.5', '100']]) {
    const run = runNative(args);
    assert.equal(run.status, 1, args.join(' '));
    assert.match(run.stderr, /capture-helper:Exception:invalid-arguments/, args.join(' '));
    assert.equal(run.stdout, '', args.join(' '));
  }
  for (const args of [['1000000', '1000000', '8000', '4600', '--snapshot'], ['1000000', '1000000', '6000', '6001', '--snapshot']]) {
    const run = runNative(args);
    assert.equal(run.status, 1, args.join(' '));
    assert.match(run.stderr, /capture-helper:Exception:invalid-region/, args.join(' '));
    assert.equal(run.stdout, '', args.join(' '));
  }
});
