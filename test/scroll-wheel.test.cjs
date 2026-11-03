'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const source = fs.readFileSync(path.resolve(__dirname, '../main/scroll-wheel.cjs'), 'utf8');
const native = fs.readFileSync(path.resolve(__dirname, '../native/gdi-capture.cs'), 'utf8').replace(/\r\n/g, '\n');
const roi = { x: -1200, y: 300, width: 800, height: 600 };

// Fake children/timers only. This suite never loads a native executable or installs a hook.
function fixture({ region = roi, endThrows = false, exitOnEnd = false, spawnThrows = false,
  omitOnError = false, onErrorThrows = false, options = {} } = {}) {
  const child = new EventEmitter(), writes = [], ends = [], errors = [], spawns = [], timers = [];
  child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin.write = value => { writes.push(value); throw new Error('No arrow commands may be written'); };
  child.stdin.end = value => { ends.push(value); if (endThrows) throw new Error('end-failed'); if (exitOnEnd) child.emit('exit', 0); };
  child.stdout.resume = () => { child.resumed = true; };
  child.kill = () => { child.kills = (child.kills || 0) + 1; };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, __dirname: path.resolve(__dirname, '../main'),
    require: name => {
      if (name === 'node:child_process') return { spawn() { throw new Error('REAL SPAWN FORBIDDEN'); } };
      return require(name);
    },
    setTimeout: (fn, ms) => { const timer = { fn, ms, unref() { this.unreferenced = true; } }; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cleared = true; }
  });
  const config = { spawn: (exe, args, settings) => {
    spawns.push({ exe, args: Array.from(args), settings: JSON.parse(JSON.stringify(settings)) });
    if (spawnThrows) throw new Error('spawn-failed');
    return child;
  }, ...options };
  if (!omitOnError) config.onError = error => { errors.push(error); if (onErrorThrows) throw new Error('reporter-failed'); };
  const bridge = module.exports.createScrollWheel(region, config);
  return { bridge, child, writes, ends, errors, spawns, timers };
}

test('接口仅stop，启动一个隐藏进程传mode与固定物理ROI，不注册JS按键或发U/D', () => {
  const h = fixture();
  assert.deepEqual(Object.keys(h.bridge), ['stop']); assert.equal(h.bridge.wheel, undefined);
  assert.equal(h.spawns.length, 1); assert.ok(h.spawns[0].exe.endsWith('gdi-capture.exe'));
  assert.deepEqual(h.spawns[0].args, ['--scroll-wheel', '-1200', '300', '800', '600', '0']);
  assert.deepEqual(h.spawns[0].settings, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(h.child.resumed, true); assert.deepEqual(h.writes, []); assert.deepEqual(h.ends, []);
  h.child.stdin.emit('drain'); h.child.stdout.emit('data', Buffer.from('UD'));
  assert.deepEqual(h.writes, []); assert.doesNotMatch(source, /globalShortcut|ipcMain|stdin\.write|function wheel/);
  h.bridge.stop(); assert.deepEqual(h.ends, ['Q']);
});

test('可显式指定路径，不经过shell', () => {
  const h = fixture({ options: { executable: 'C:/native helper/gdi-capture.exe' } });
  assert.equal(h.spawns[0].exe, 'C:/native helper/gdi-capture.exe');
  assert.equal(h.spawns[0].settings.shell, undefined); h.bridge.stop();
});

for (const region of [null, {}, { ...roi, x: 1.5 }, { ...roi, x: NaN }, { ...roi, y: Infinity },
  { ...roi, x: 1000001 }, { ...roi, y: -1000001 }, { ...roi, width: 0 }, { ...roi, height: -1 },
  { ...roi, width: 1.2 }, { ...roi, width: '800' }, { ...roi, width: 4001, height: 4000 },
  { ...roi, height: Number.MAX_SAFE_INTEGER + 1 }]) test(`非法ROI同步拒绝 ${JSON.stringify(region)}`, () => {
  assert.throws(() => fixture({ region }), /无效滚轮选区/);
});

test('可带上截图前的前台窗口句柄，供原生尽力把焦点还回去', () => {
  const h = fixture({ options: { foreground: 3211506 } });
  assert.deepEqual(h.spawns[0].args, ['--scroll-wheel', '-1200', '300', '800', '600', '3211506']);
  h.bridge.stop();
  assert.throws(() => fixture({ options: { foreground: -1 } }), /无效前台窗口句柄/);
  assert.throws(() => fixture({ options: { foreground: 1.5 } }), /无效前台窗口句柄/);
});

test('ROI最大像素及负原点边界可用，创建后不跟随外部ROI变化', () => {
  const region = { x: -1000000, y: 1000000, width: 4000, height: 4000 }, h = fixture({ region });
  region.x = 0; region.width = 1;
  assert.deepEqual(h.spawns[0].args, ['--scroll-wheel', '-1000000', '1000000', '4000', '4000', '0']); h.bridge.stop();
});

for (const options of [{ spawn: null }, { executable: '' }, { executable: 2 }, { onError: null }]) test(`非法选项同步拒绝 ${JSON.stringify(options)}`, () => {
  const module = { exports: {} }; let spawns = 0;
  vm.runInNewContext(source, { module, __dirname, require, setTimeout() { throw new Error('unexpected timer'); }, clearTimeout() {} });
  assert.throws(() => module.exports.createScrollWheel(roi, { spawn() { spawns++; }, ...options }), /无效滚轮桥选项/);
  assert.equal(spawns, 0);
});

test('stop幂等，只Q/EOF一次并设置250ms kill上限', () => {
  const h = fixture(); h.bridge.stop(); h.bridge.stop(); h.child.stdin.emit('drain');
  assert.deepEqual(h.ends, ['Q']); assert.deepEqual(h.writes, []);
  assert.equal(h.timers.length, 1); assert.equal(h.timers[0].ms, 250); assert.equal(h.timers[0].unreferenced, true);
  h.timers[0].fn(); assert.equal(h.child.kills, 1); assert.deepEqual(h.errors, []);
});

test('正常退出清理kill计时器，不误报手动停止', () => {
  const h = fixture(); h.bridge.stop(); h.child.emit('exit', 0, null);
  assert.equal(h.timers[0].cleared, true); h.timers[0].fn(); assert.equal(h.child.kills, undefined);
  assert.deepEqual(h.errors, []); assert.deepEqual(h.writes, []);
});

test('EOF同步退出不遗留定时器', () => {
  const h = fixture({ exitOnEnd: true }); h.bridge.stop(); h.bridge.stop();
  assert.deepEqual(h.ends, ['Q']); assert.equal(h.timers.length, 0); assert.deepEqual(h.errors, []);
});

test('Q/EOF抛错仍有kill兜底，kill抛错也不崩主进程', () => {
  const h = fixture({ endThrows: true }); assert.doesNotThrow(() => h.bridge.stop());
  assert.deepEqual(h.ends, ['Q']); assert.equal(h.timers[0].ms, 250);
  h.child.kill = () => { throw new Error('kill-failed'); };
  assert.doesNotThrow(() => h.timers[0].fn()); assert.deepEqual(h.errors, []);
});

for (const origin of ['child', 'stdin', 'stdout', 'stderr']) test(`${origin} error仅报告一次、停止helper，不Unhandled`, () => {
  const h = fixture(), emitter = origin === 'child' ? h.child : h.child[origin];
  assert.doesNotThrow(() => emitter.emit('error', new Error('pipe-failed')));
  assert.equal(h.errors.length, 1); assert.match(h.errors[0].message, /pipe-failed/); assert.deepEqual(h.ends, ['Q']);
  assert.doesNotThrow(() => { h.child.emit('error', new Error('late')); h.child.stdin.emit('error', new Error('late')); });
  h.child.emit('exit', 1); assert.equal(h.errors.length, 1); assert.deepEqual(h.writes, []);
});

test('手动停止后迟到错误与退出不再触发降级回调', () => {
  const h = fixture(); h.bridge.stop();
  assert.doesNotThrow(() => { h.child.emit('error', new Error('late')); h.child.stdin.emit('error', new Error('late')); });
  h.child.emit('exit', 1); assert.deepEqual(h.errors, []); assert.deepEqual(h.ends, ['Q']);
});

test('spawn同步失败通过onError报告，返回可幂等停止的接口', () => {
  const h = fixture({ spawnThrows: true }); assert.equal(h.errors.length, 1); assert.match(h.errors[0].message, /spawn-failed/);
  assert.deepEqual(Object.keys(h.bridge), ['stop']); assert.doesNotThrow(() => h.bridge.stop()); assert.equal(h.timers.length, 0);
});

test('意外退出即使exit=0也报告，有界stderr不无限积累', () => {
  const h = fixture(); h.child.stderr.emit('data', Buffer.from('x'.repeat(1000))); h.child.emit('exit', 0, null);
  assert.equal(h.errors.length, 1); assert.equal(h.errors[0].message.length, 600);
  assert.deepEqual(h.ends, []); assert.equal(h.timers.length, 0); h.bridge.stop(); assert.equal(h.errors.length, 1);
});

test('native注入失败通过stderr降级报告，不存在取消截图或补发按键协议', () => {
  const h = fixture(); h.child.stderr.emit('data', Buffer.from('gdi-capture:scroll-wheel-injection-failed'));
  h.child.emit('exit', 1); assert.equal(h.errors.length, 1); assert.match(h.errors[0].message, /injection-failed/);
  assert.deepEqual(h.writes, []); assert.deepEqual(h.ends, []); assert.deepEqual(Object.keys(h.bridge), ['stop']);
  assert.doesNotMatch(source, /cancel\s*\(|\.wheel\s*\(|globalShortcut/);
});

test('信号退出有明确错误信息', () => {
  const h = fixture(); h.child.emit('exit', null, 'SIGTERM');
  assert.equal(h.errors.length, 1); assert.match(h.errors[0].message, /SIGTERM/);
});

for (const config of [{ omitOnError: true }, { onErrorThrows: true }]) test(`省略或抛错的回调不会崩主进程 ${JSON.stringify(config)}`, () => {
  const h = fixture(config);
  assert.doesNotThrow(() => h.child.emit('error', new Error('failed')));
  assert.doesNotThrow(() => h.child.stdin.emit('error', new Error('late')));
  assert.doesNotThrow(() => h.child.emit('exit', 1)); h.bridge.stop();
});

// Native source guards are structural evidence, not a real hook/SendInput integration test.
function block(text, signature) {
  const start = text.indexOf(signature); assert(start >= 0, `missing ${signature}`);
  const open = text.indexOf('{', start); let depth = 1, end = open + 1;
  while (end < text.length && depth) { if (text[end] === '{') depth++; if (text[end] === '}') depth--; end++; }
  assert.equal(depth, 0); return text.slice(open + 1, end - 1);
}
const wheel = block(native, 'static int ScrollWheel(string[] args)');
const allowed = block(native, 'static bool WheelAllowed(');
const callback = block(wheel, 'callback=delegate(');

test('native原watch-cancel、JGC2采样及selftest源码保持原样，独立mode严格6参数', () => {
  const start = native.indexOf(' // Separate opt-in wheel bridge.');
  const end = native.indexOf(' [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();', start);
  assert(start >= 0 && end > start);
  let original = native.slice(0, start) + native.slice(end);
  const dispatch = '   if(args.Length>0&&args[0]=="--scroll-wheel") {\n    if(args.Length!=6)throw new Exception("invalid-arguments");\n    return ScrollWheel(args);\n   }\n   if(args.Length==1&&args[0]=="--fg") {\n    // Foreground HWND plus its process id: the caller drops its own window from the hand-back hint.\n    IntPtr owner=GetForegroundWindow();uint process;\n    GetWindowThreadProcessId(owner,out process);\n    Console.Out.Write(owner.ToInt64().ToString()+" "+process.ToString());\n    Console.Out.Flush();\n    return 0;\n   }\n';
  assert(original.includes(dispatch)); original = original.replace(dispatch, '');
  assert.equal(createHash('sha256').update(original).digest('hex'), 'e9e8a8514a034c25a36e39ff37ce76f60ea222c1f29bf290a67280cabf50609b');
});

test('native INPUT显式40字节union、mouse offset8，只发垂直±120滚轮', () => {
  assert.match(native, /LayoutKind\.Explicit,Size=40/); assert.match(native, /FieldOffset\(8\).*WheelMouseInput Mouse/);
  assert.match(wheel, /IntPtr\.Size!=8\|\|Marshal\.SizeOf\(typeof\(WheelInput\)\)!=40/);
  assert.match(callback, /MouseData=unchecked\(\(uint\)\(key\.Key==0x26\?120:-120\)\),Flags=0x0800/);
  assert.match(callback, /SendInput\(1,new WheelInput\[\]\{packet\},40\)!=1/);
  assert.doesNotMatch(wheel, /SetCursorPos|mouse_event|SetForegroundWindow|KEYEVENTF/);
});

test('native每次按键实时取前台，Activate 只做尽力焦点归还', () => {
  assert(wheel.indexOf('SetThreadDpiAwarenessContext(new IntPtr(-4))') < wheel.indexOf('Activate(new IntPtr(long.Parse(args[5])))'));
  assert.equal((wheel.match(/foreground=GetForegroundWindow\(\)/g) || []).length, 1);
  assert.match(wheel, /initialUnder=WindowFromPoint\(initialPoint\)/);
  assert(wheel.indexOf('scroll-wheel-target-mismatch') < wheel.indexOf('SetWindowsHookEx(13,'));
  assert.match(allowed, /DesktopName\(input\)!=desktop\|\|DesktopName\(GetThreadDesktop\(GetCurrentThreadId\(\)\)\)!=desktop/);
  // 不再把 spawn 那一刻的前台锁死：用户可能之后再点回页面。
  assert.match(allowed, /IntPtr foreground=GetForegroundWindow\(\)/);
  assert.doesNotMatch(allowed, /GetForegroundWindow\(\)!=foreground/);
  assert.match(allowed, /new int\[\]\{0x10,0x11,0x12,0x5B,0x5C\}/);
  assert.match(allowed, /GetAsyncKeyState\(key\)&0x8000/);
  assert.match(allowed, /GetPhysicalCursorPos\(out point\).*point.X<roi.Left.*point.X>=roi.Right.*point.Y<roi.Top.*point.Y>=roi.Bottom/);
  assert.match(allowed, /GetAncestor\(under,2\)==GetAncestor\(foreground,2\)/);
  assert.match(native, /static void Activate\(IntPtr target\)/);
  assert.match(native, /AttachThreadInput\(current,owner,true\)/);
  assert.match(native, /if\(IsIconic\(target\)\)ShowWindow\(target,9\)/);
  assert.match(native, /catch\{\/\* Focus hand-back is optional\. \*\/\}/);
  assert.match(native, /args.Length==1&&args\[0\]=="--fg"/);
});

test('native仅普通物理Up/Down；其它键、系统键、不符条件均CallNext', () => {
  assert.match(callback, /code!=0\|\|.*quitRequested/);
  assert.match(callback, /\(key.Flags&0x12\)!=0\|\|\(key.Key!=0x26&&key.Key!=0x28\).*return CallNextHookEx/);
  assert.match(callback, /action!=0x100&&action!=0x101.*swallowed\[index\]=false;return CallNextHookEx/);
  assert.match(callback, /if\(!allowed\)\{swallowed\[index\]=false;return CallNextHookEx/);
  assert(callback.indexOf('WheelAllowed(roi,foreground,root,desktop)') < callback.indexOf('SendInput('));
});

test('native keyup仅吞已成功配对且仍满足条件的键；80ms只节流已吞repeat', () => {
  const up = block(callback, 'if(action==0x101)');
  assert.match(up, /bool paired=swallowed\[index\];swallowed\[index\]=false/);
  assert.match(up, /paired&&allowed\?new IntPtr\(1\):CallNextHookEx/); assert.doesNotMatch(up, /SendInput/);
  assert.match(callback, /if\(swallowed\[index\]&&now-lastWheel\[index\]<80\)return new IntPtr\(1\)/);
  assert(callback.indexOf('now-lastWheel[index]<80') < callback.indexOf('SendInput('));
  assert(callback.indexOf('SendInput(') < callback.indexOf('swallowed[index]=true;lastWheel[index]=now;'));
});

test('native SendInput失败立即卸钩、退出并放行本次事件，不吞失败键', () => {
  assert.match(callback, /SendInput\(.*\)!=1\)throw new Exception\("scroll-wheel-injection-failed"\)/);
  const failure = block(callback, 'catch(Exception error)');
  assert.match(failure, /failure=error/); assert.match(failure, /UnhookWindowsHookEx\(hook\)/);
  assert.match(failure, /PostThreadMessage\(ownerThread,0x0012/); assert.match(failure, /return CallNextHookEx/);
  assert.doesNotMatch(failure, /return new IntPtr\(1\)/); assert.match(wheel, /if\(failure!=null\)throw failure/);
  assert.match(native, /Console.Error.WriteLine\("gdi-capture:"\+e.Message\)/);
});

test('native LL hook与消息循环共线程；stdin只读Q/EOF退出，finally卸钩保活delegate', () => {
  assert(wheel.indexOf('PeekMessage(') < wheel.indexOf('SetWindowsHookEx(13,callback,GetModuleHandle(null),0)'));
  assert(wheel.indexOf('SetWindowsHookEx(13,callback') < wheel.indexOf('inputThread.Start()'));
  assert.match(wheel, /while\(\(result=GetMessage\(out message,IntPtr.Zero,0,0\)\)>0\)/);
  const input = block(wheel, 'var inputThread=new System.Threading.Thread(() =>');
  assert.match(input, /while\(\(command=input.ReadByte\(\)\)>=0&&command!=81\)\{\}/);
  assert.match(input, /PostThreadMessage\(ownerThread,0x0012/); assert.doesNotMatch(input, /SendInput|UnhookWindowsHookEx|command==85|command==68/);
  assert.match(wheel, /finally \{\s*System.Threading.Interlocked.Exchange\(ref quitRequested,1\);\s*if\(hook!=IntPtr.Zero\)UnhookWindowsHookEx\(hook\);\s*GC.KeepAlive\(callback\)/);
});
