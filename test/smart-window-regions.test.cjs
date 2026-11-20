'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {parseWindowRegions, parseWindowRegionDetails, mergeWindowRegionDetails, createWindowRegionDetailPatch,
  queryWindowRegions, queryWindowRegionDetails} = require('../main/win-capture.cjs');
const bounds = {x:-100,y:0,width:500,height:400};
const nativeDir = path.join(__dirname, '..', 'native');

// 真实 helper 自测只在「本机是 Windows 且该产物真的存在」时跑；缺产物时明确 skip，不伪装通过。
function nativePlan(name, {platform = process.platform, exists = fs.existsSync} = {}) {
  const exe = path.join(nativeDir, name);
  const available = platform === 'win32' && exists(exe);
  return {exe, available, skip: available ? false : '本机没有该原生产物，跳过真实 helper 自测'};
}

test('缺 helper 的 skip 谓词只认 Windows 且产物真在', () => {
  const fake = (platform, present) => nativePlan('wgc-capture.exe', {platform, exists: () => present});
  assert.equal(fake('win32', true).available, true);
  assert.equal(fake('win32', false).available, false);
  assert.equal(fake('linux', true).available, false);
  assert.equal(fake('win32', false).skip !== false, true);
  assert.equal(fake('win32', true).skip, false);
});

test('静态源码契约：窗口元数据只读、排在采集之前、自窗只标 blocked', () => {
  const source = fs.readFileSync(path.join(__dirname, '../native/wgc-capture.cs'), 'utf8');
  assert.ok(source.indexOf('args[0]=="--window-regions"') < source.indexOf('GraphicsCaptureSession.IsSupported'),
    '窗口枚举必须在 WGC/D3D/像素初始化之前退出');
  assert.match(source, /visited<4096 && collection\.Rows\.Count<WindowRegionGeometry\.MaxRows/);
  assert.match(source, /pid==ownPid/, '本应用窗口按 PID 判定并保留在 Z 序里');
  assert.match(source, /row.Blocked=true/);
  assert.ok(!/pid!=excluded/.test(source), '不能再把本应用窗口整个过滤掉');
  const js = fs.readFileSync(path.join(__dirname, '../main/win-capture.cjs'), 'utf8');
  assert.match(js, /'blocked,bounds,client'/);
  assert.match(js, /'bounds,client,regions'/);
});
test('静态源码契约：MSAA探针先切PMv2再校验根；只序列化已完成的根；诊断只报阶段与计数', () => {
  const source = fs.readFileSync(path.join(__dirname, '../native/wgc-capture.cs'), 'utf8');
  const probe = source.slice(source.indexOf('static void Probe(Target target'), source.indexOf('// Only finalized targets are serialized'));
  const dpi = probe.indexOf('SetThreadDpiAwarenessContext(new IntPtr(-4))');
  const validate = probe.indexOf('ValidateRoot(target,out status)');
  assert.ok(dpi >= 0 && validate >= 0, '探针必须同时包含PMv2切换与根校验');
  assert.ok(dpi < validate, '根校验必须发生在PMv2上下文里，否则客户区是虚拟化坐标，永远匹配不上快照');
  // 容器角色（PANE/GROUPING）只有在矩形严格小于客户区时才算候选；窗口/客户区/文档/静态文本始终拒绝。
  assert.match(source, /public static bool IsContainerRole\(int role\)/);
  assert.match(source, /public static bool IsBlockedRole\(int role\)/);
  assert.match(source, /public static bool IsStrictSubrectangle\(Rect rect,Rect container\)/);
  const walk = source.slice(source.indexOf('static int Walk('), source.indexOf('static void ReleaseVariant'));
  assert.match(walk, /IsContainerRole\(role\)/, '容器角色必须单独判定');
  assert.match(walk, /IsStrictSubrectangle\(rect,container\)/, '容器角色必须要求严格子矩形');
  assert.match(walk, /IsBlockedRole\(role\)/, '窗口/客户区/文档/静态文本必须始终拒绝');
  assert.match(walk, /for \(int i=0;i<obtained;i\+\+\)/, '批次里的每个VARIANT都要走一遍');
  assert.match(walk, /ReleaseVariant\(value\);/, '截断后剩余的VARIANT也必须释放');
  // 陈旧基准：探针结束后再校验一次，窗口变了就丢掉这一根的结果。
  assert.match(probe, /post-validate/, '探针结束必须复校根窗口，陈旧结果不得输出');
  const buildJson = source.slice(source.indexOf('public static string BuildJson'), source.indexOf('// Runs the production probe jobs'));
  assert.match(buildJson, /if \(!target\.Finalized\) continue;/, '未完成的根不得被序列化');
  assert.match(source, /args\[0\]=="--window-regions-msaa-report"/);
  const report = source.slice(source.indexOf('public static string DescribeReport'), source.indexOf('public static void WriteReport'));
  const describe = source.slice(source.indexOf('public string Describe(bool finalized)'), source.indexOf('public sealed class Target'));
  for (const field of ['stage','status','comInitHr','objectHr','childCount','children','visited','visible','filtered','geometry','finalized']) {
    assert.ok(describe.includes(field), `报告缺少 ${field}`);
  }
  for (const forbidden of ['NativeKey','Bounds','Client','RawHwnd','Hwnd','Pid','Tid']) {
    assert.equal(report.includes(forbidden), false, `报告不得回显 ${forbidden}`);
    assert.equal(describe.includes(forbidden), false, `报告不得回显 ${forbidden}`);
  }
  const winCapture = fs.readFileSync(path.join(__dirname, '../main/win-capture.cjs'), 'utf8');
  assert.equal(winCapture.includes('--window-regions-msaa-report'), false, '诊断命令不得进入常规JS查询');
  assert.equal(winCapture.includes('--window-regions-uia-probe'), false, '实验性UIA探针不得进入常规JS查询');
  // 实验性面板探针：只报计数，不报几何；必须区分“跑完”与“预算内快照”。
  assert.match(source, /class UiaPanelProbe/);
  assert.match(source, /public static string Build\(IntPtr hwnd,Rect container,int budgetMs/);
  assert.match(source, /\\"usefulInterior\\":/);
  assert.match(source, /\\"distinctNormalized\\":/);
  assert.match(source, /\\"finished\\":/);
  assert.match(source, /args\[0\]=="--window-regions-uia-probe"/);
  const probeReport = source.slice(source.indexOf('class UiaPanelProbe'), source.indexOf('class UiaRegionProbe'));
  for (const forbidden of ['NativeKey','RawHwnd','Title','Name','Text']) {
    assert.equal(probeReport.includes(forbidden), false, `面板探针报告不得回显 ${forbidden}`);
  }
});

test('静态源码契约：常规查询只做快照，MSAA细节独立STA/PMv2且有界', () => {
  const source = fs.readFileSync(path.join(__dirname, '../native/wgc-capture.cs'), 'utf8');
  const captureBody = source.slice(source.indexOf('class WgcCapture {'), source.indexOf('class WindowRegionGeometry'));
  for (const type of ['AutomationElement', 'CacheRequest', 'ControlType', 'TreeWalker']) {
    assert.equal(captureBody.includes(type), false, `采集类里不能出现 UIA 类型 ${type}`);
  }
  const baseQuery = source.slice(source.indexOf('static void WriteWindowRegions(Stream output'), source.indexOf('// Diagnostic report:'));
  assert.match(baseQuery, /CollectWindowRegions\(ownPid,null,false\)/);
  assert.doesNotMatch(baseQuery, /WindowRegionPublisher\.Publish/, '普通查询不得等待 UIA/MSAA 细节');
  assert.match(baseQuery, /SerializeSnapshot/);
  const msaa = source.slice(source.indexOf('class MsaaWindowRegionQuery'), source.indexOf('// Counters of one region probe'));
  for (const token of ['AccessibleChildren', 'get_accRole', 'get_accState', 'accLocation', 'CoInitializeEx(IntPtr.Zero,2)',
    'SetApartmentState(ApartmentState.STA)', 'SetThreadDpiAwarenessContext(new IntPtr(-4))', 'StateInvisible=0x00008000', 'StateOffscreen=0x00010000']) {
    assert.ok(msaa.includes(token), `MSAA探针缺少 ${token}`);
  }
  assert.match(msaa, /public const int BudgetMs=350/);
  assert.match(msaa, /public const int MaxVisits=512/);
  assert.match(msaa, /public const int MaxDepth=32/);
  assert.match(msaa, /public const int MaxRoots=2/);
  assert.match(msaa, /public const int BatchSize=32/);
  assert.doesNotMatch(msaa, /accName|accValue|accDoDefaultAction|accSelect|accHitTest/, 'MSAA不得读取名字/值或执行动作');
  assert.match(source, /class UiaRegionProbe/, 'UIA仅保留显式计数诊断路径');
  const uiaBody = source.slice(source.indexOf('class UiaRegionProbe'));
  assert.equal(/\.Current\./.test(uiaBody), false, '诊断探查只读缓存属性');
  assert.match(source, /args.Length==1 && args\[0\]=="--window-regions-self-test"/);
  assert.match(source, /args\[0\]=="--window-regions-msaa"/);
  assert.match(source, /class WindowRegionReport/);
  assert.match(source, /\\"uiaHResult\\":/);
  const build = fs.readFileSync(path.join(__dirname, '../scripts/build-capture.cjs'), 'utf8');
  assert.match(build, /Accessibility\.dll/);
  assert.match(build, /UIAutomationClient\.dll/);
  assert.match(build, /没有尝试安装/);
  const winCapture = fs.readFileSync(path.join(__dirname, '../main/win-capture.cjs'), 'utf8');
  assert.equal(winCapture.includes('--window-regions-report'), false, '诊断报告命令不进入常规JS查询');
  assert.match(winCapture, /signal\?\.aborted/);
});

test('base parser 严格校验快照字段、私有 HWND key 与 blocked', () => {
  const row = {bounds, client:{x:0,y:20,width:100,height:100}};
  const key='0000007b:00000001:000000000000002a';
  assert.deepEqual(parseWindowRegions(JSON.stringify([row])), [row]);
  assert.deepEqual(parseWindowRegions(JSON.stringify([{...row,nativeKey:key}])), [{...row,nativeKey:key}]);
  assert.deepEqual(parseWindowRegions(JSON.stringify([{...row,nativeKey:key,detailRoot:true}])), [{...row,nativeKey:key,detailRoot:true}]);
  const blocked = {blocked:true, bounds, client:null};
  assert.deepEqual(parseWindowRegions(JSON.stringify([blocked])), [blocked]);
  assert.deepEqual(parseWindowRegions(JSON.stringify([{...row, blocked:true}])), [{blocked:true, bounds, client:row.client}]);
  for (const value of [
    [{...row, blocked:false}], [{...row, blocked:'true'}], [{...row, blocked:1}], [{blocked:false, bounds, client:null}],
    [{blocked:true, bounds}], [{blocked:true, bounds, client:null, extra:1}], [{bounds, client:null, title:'x'}],
    [{bounds, client:{...bounds, x:-101}}], [{...row,nativeKey:'123'}], [{...row,nativeKey:key,detailRoot:false}],
    [{...row,detailRoot:true}], [{...row,nativeKey:key},{...row,nativeKey:key}], Array(129).fill(row),
  ]) assert.throws(() => parseWindowRegions(JSON.stringify(value)));
  assert.throws(() => parseWindowRegions(' '.repeat(65537)));
});

test('窗口元素区域：正常行可带regions，字段/大小/包含关系/上限都严格校验', () => {
  const frame={x:0,y:0,width:1000,height:800};
  const row={bounds:frame,client:{x:0,y:0,width:1000,height:800},regions:[{x:10,y:10,width:100,height:50}]};
  assert.deepEqual(parseWindowRegions(JSON.stringify([row])),[row]);
  // 自己窗口（blocked）不得带元素区域。
  assert.throws(()=>parseWindowRegions(JSON.stringify([{blocked:true,bounds:frame,client:null,regions:[]}])));
  // 元素带多余字段、过小、越出客户区都要拒绝。
  assert.throws(()=>parseWindowRegions(JSON.stringify([{...row,regions:[{x:10,y:10,width:100,height:50,tag:'x'}]}])));
  assert.throws(()=>parseWindowRegions(JSON.stringify([{...row,regions:[{x:10,y:10,width:7,height:50}]}])));
  assert.throws(()=>parseWindowRegions(JSON.stringify([{...row,regions:[{x:10,y:10,width:1000,height:50}]}])));
  // 单行元素数与全局元素数都有上限。
  assert.throws(()=>parseWindowRegions(JSON.stringify([{...row,regions:Array.from({length:129},(_,i)=>({x:i*8,y:0,width:8,height:8}))}])));
  const many=Array.from({length:3},()=>({...row,regions:Array.from({length:100},(_,i)=>({x:i*8,y:0,width:8,height:8}))}));
  assert.throws(()=>parseWindowRegions(JSON.stringify(many)));
  // 完全重复的元素只留一个。
  const dup={...row,regions:[{x:10,y:10,width:100,height:50},{x:10,y:10,width:100,height:50}]};
  assert.equal(parseWindowRegions(JSON.stringify([dup]))[0].regions.length,1);
});
test('MSAA detail parser 与合并只绑定唯一 HWND key + 几何相同的 base 行', () => {
  const frame={x:0,y:0,width:1000,height:800}, client={x:10,y:20,width:900,height:700};
  const key1='0000007b:00000001:000000000000002a', key2='0000007c:00000002:000000000000003b';
  const region={x:40,y:50,width:100,height:60};
  const raw={nativeKey:key1,bounds:frame,client,regions:[region,region]};
  assert.deepEqual(parseWindowRegionDetails(JSON.stringify([raw])),[{nativeKey:key1,bounds:frame,client,regions:[region]}]);
  for (const value of [
    [{...raw,nativeKey:'bad'}], [{...raw,extra:true}], [{...raw,client:{...client,x:-1}}],
    [{...raw,regions:[{x:1,y:1,width:100,height:60}]}],
    [{...raw,regions:Array.from({length:129},(_,i)=>({x:20+i*8,y:30,width:8,height:8}))}],
    [raw,{...raw}], Array(3).fill(raw),
  ]) assert.throws(()=>parseWindowRegionDetails(JSON.stringify(value)));
  const base=[
    {bounds:frame,client,regions:[{x:10,y:20,width:8,height:8}],nativeKey:key1,detailRoot:true},
    {bounds:frame,client,nativeKey:key2,detailRoot:true},
    {blocked:true,bounds:{x:1200,y:0,width:200,height:100},client:null},
  ];
  const details=[{nativeKey:key1,bounds:frame,client,regions:[{...region}]},
    {nativeKey:key2,bounds:frame,client,regions:[{x:200,y:210,width:80,height:70}]}];
  const merged=mergeWindowRegionDetails(base,details);
  assert.notEqual(merged,base);
  assert.deepEqual(merged.map(row=>row.blocked===true),[false,false,true],'Z顺序与 blocker 行不变');
  assert.equal(merged[0].regions.length,2); assert.equal(merged[1].regions[0].x,200);
  assert.deepEqual(createWindowRegionDetailPatch(base,merged),[
    {index:0,bounds:frame,client,regions:[region]},
    {index:1,bounds:frame,client,regions:[{x:200,y:210,width:80,height:70}]},
  ]);
  assert.equal(mergeWindowRegionDetails(base,[]),base,'无提供方结果时保留原 fallback');
  assert.deepEqual(createWindowRegionDetailPatch(base,base),[]);
  assert.throws(()=>mergeWindowRegionDetails(base,[{...details[0],bounds:{...frame,x:1}}]),/几何已变化/);
  assert.throws(()=>mergeWindowRegionDetails(base,[{...details[0],nativeKey:'0000007d:00000003:000000000000004c'}]),/没有对应根窗口/);
  assert.throws(()=>mergeWindowRegionDetails([base[0],{...base[1],nativeKey:key1}],[details[0]]),/身份重复/);
});

test('detail parser 与合并拒绝等于客户区的矩形，只接受真正的子矩形', () => {
  const frame={x:0,y:0,width:1000,height:800}, client={x:10,y:20,width:900,height:700};
  const key='0000007b:00000001:000000000000002a';
  const proper={x:40,y:50,width:100,height:60};
  assert.deepEqual(parseWindowRegionDetails(JSON.stringify([{nativeKey:key,bounds:frame,client,regions:[proper]}])),
    [{nativeKey:key,bounds:frame,client,regions:[proper]}], 'proper子矩形正常解析');
  assert.throws(()=>parseWindowRegionDetails(JSON.stringify([{nativeKey:key,bounds:frame,client,regions:[client]}])),
    /等于客户区/, '等于客户区的矩形必须拒绝');
  const base=[{bounds:frame,client,nativeKey:key,detailRoot:true}];
  assert.throws(()=>mergeWindowRegionDetails(base,[{nativeKey:key,bounds:frame,client,regions:[client]}]),/等于客户区/);
  const merged=mergeWindowRegionDetails(base,[{nativeKey:key,bounds:frame,client,regions:[proper]}]);
  assert.deepEqual(createWindowRegionDetailPatch(base,merged),[{index:0,bounds:frame,client,regions:[proper]}]);
  // 陈旧基准：几何变了就不绑定，保留原 fallback。
  assert.throws(()=>mergeWindowRegionDetails(base,[{nativeKey:key,bounds:{...frame,x:1},client,regions:[proper]}]),/几何已变化/);
  assert.throws(()=>mergeWindowRegionDetails(base,[{nativeKey:key,bounds:frame,client:{...client,width:800},regions:[proper]}]),/几何已变化/);
});

test('detail helper参数有界；abort/timeout/error 即使带完整或部分 stdout 也不返数据', async () => {
  const key='0000007b:00000001:000000000000002a';
  const frame={x:0,y:0,width:1000,height:800}, client={x:10,y:20,width:900,height:700};
  const target={nativeKey:key,detailRoot:true,bounds:frame,client};
  const payload=JSON.stringify([{nativeKey:key,bounds:frame,client,regions:[{x:40,y:50,width:100,height:60}]}]);
  let calls=0;
  const execFile=(file,args,opts,cb)=>{
    calls++; assert.deepEqual(Array.from(args),['--window-regions-msaa','9',key,'0','0','1000','800','10','20','900','700']);
    assert.equal(opts.windowsHide,true); assert.equal(opts.timeout,650); assert.equal(opts.maxBuffer,65536); cb(null,payload);
  };
  assert.deepEqual(await queryWindowRegionDetails(9,[target],{execFile}),parseWindowRegionDetails(payload));
  assert.equal(calls,1);
  for(const pid of [0,-1,1.5,4294967296,'9']) await assert.rejects(queryWindowRegionDetails(pid,[target],{execFile}));
  await assert.rejects(queryWindowRegionDetails(9,[],{execFile}));
  await assert.rejects(queryWindowRegionDetails(9,[{...target,nativeKey:'00000009:00000001:000000000000002a'}],{execFile}),/本应用/);
  await assert.rejects(queryWindowRegionDetails(9,[target],{timeoutMs:1001,execFile}));
  const killed=new Error('timeout'); killed.killed=true; killed.signal='SIGTERM';
  await assert.rejects(queryWindowRegionDetails(9,[target],{execFile:(f,a,o,cb)=>cb(killed,payload)}));
  const controller=new AbortController(); let complete;
  const pending=queryWindowRegionDetails(9,[target],{signal:controller.signal,execFile:(f,a,o,cb)=>{assert.equal(o.signal,controller.signal);complete=cb;}});
  controller.abort(); complete(killed,payload);
  await assert.rejects(pending,/已取消/);
});

test('helper被杀但stdout已是完整严格JSON时按它接受，其它失败仍报错', async () => {
  const killed=new Error('killed'); killed.killed=true; killed.signal='SIGTERM';
  const rows=await queryWindowRegions(123,{execFile:(f,a,o,cb)=>cb(killed,'[{"bounds":{"x":0,"y":0,"width":100,"height":80},"client":null}]')});
  assert.equal(rows.length,1);
  await assert.rejects(queryWindowRegions(123,{execFile:(f,a,o,cb)=>cb(killed,'not json')}));
  await assert.rejects(queryWindowRegions(123,{execFile:(f,a,o,cb)=>cb(new Error('spawn ENOENT'),'')}));
  // 只有 signal 的异常退出不是超时，即使 stdout 看起来完整也必须报错。
  const crashed=new Error('crash'); crashed.signal='SIGSEGV';
  await assert.rejects(queryWindowRegions(123,{execFile:(f,a,o,cb)=>cb(crashed,'[{"bounds":{"x":0,"y":0,"width":100,"height":80},"client":null}]')}));
});
test('window query fixed args, timeout, buffer and rejection', async () => {
  let calls=0;
  const execFile=(file,args,opts,cb)=>{calls++;assert.deepEqual(args,['--window-regions','123']);assert.equal(opts.windowsHide,true);assert.equal(opts.timeout,800);assert.equal(opts.maxBuffer,65536);cb(null,'[]');};
  assert.deepEqual(await queryWindowRegions(123,{execFile}),[]);
  for(const pid of [0,-1,1.5,4294967296,'123']) await assert.rejects(queryWindowRegions(pid,{execFile}));
  assert.equal(calls,1);
  await assert.rejects(queryWindowRegions(123,{timeoutMs:12,execFile:(f,a,o,cb)=>{assert.equal(o.timeout,12);cb(new Error('timeout'));}}));
});

for (const name of ['wgc-capture.exe', 'wgc-record.exe']) {
  const plan = nativePlan(name);
  test(`窗口区域 helper 内存自测与非法参数（${name}，不读桌面）`, {skip: plan.skip}, () => {
    // Behavioural check through the real CLI: the self-test leaves a stuck background thread behind,
    // so the process must still exit promptly instead of waiting for the ordinary CLR shutdown.
    const startedAt = Date.now();
    const self = spawnSync(plan.exe, ['--window-regions-self-test'], {windowsHide:true, timeout:20000, encoding:'utf8' });
    const wallMs = Date.now() - startedAt;
    assert.equal(self.status, 0, self.stderr);
    const payload = JSON.parse(self.stdout);
    assert.equal(payload.ok, true);
    assert.ok(payload.checks >= 12, '自测必须覆盖裁剪、去重、上限、预算、挂起源与溢出反例');
    assert.ok(payload.stalledMs >= 300 && payload.stalledMs < 2000, '挂起源必须走完预算才放弃');
    assert.ok(wallMs < 2500, `带挂起源的进程必须及时退出（实际 ${wallMs}ms）`);
    for (const args of [['--window-regions'],['--window-regions','0'],['--window-regions','-1'],['--window-regions','4294967296'],['--window-regions','1','extra'],['--unknown']]) {
      const run = spawnSync(plan.exe, args, {windowsHide:true, timeout:5000, encoding:'utf8'});
      assert.equal(run.status, 1); assert.equal(run.stdout, ''); assert.match(run.stderr, /invalid-arguments/);
    }
    const bad = spawnSync(plan.exe, ['--window-regions-self-test', 'extra'], {windowsHide:true, timeout:20000, encoding:'utf8' });
    assert.equal(bad.status, 1); assert.equal(bad.stdout, ''); assert.match(bad.stderr, /invalid-arguments/);
    // Invalid MSAA arguments must fail before any HWND/provider access; no valid target is supplied here.
    for (const args of [['--window-regions-msaa'],['--window-regions-msaa','0'],['--window-regions-msaa','123'],['--window-regions-msaa','123','bad']]) {
      const detail = spawnSync(plan.exe, args, {windowsHide:true, timeout:5000, encoding:'utf8'});
      assert.equal(detail.status, 1, args.join(' ')); assert.equal(detail.stdout, ''); assert.match(detail.stderr, /invalid-arguments/);
    }
    // The count-only MSAA report answers with stage/status tokens and counters only. The target
    // here is a bogus handle, so the probe stops at the root validation without any provider work.
    const reportArgs=['--window-regions-msaa-report','1','0000007b:00000001:000000000000002a','0','0','100','100','0','0','100','100'];
    const reportRun=spawnSync(plan.exe,reportArgs,{windowsHide:true,timeout:10000,encoding:'utf8'});
    assert.equal(reportRun.status,0,reportRun.stderr);
    const reportPayload=JSON.parse(reportRun.stdout);
    assert.equal(reportPayload.mode,'msaa-report');
    assert.equal(reportPayload.targets.length,1);
    assert.equal(reportPayload.targets[0].stage,'validate');
    assert.equal(reportPayload.targets[0].status,'invalid-window');
    assert.equal(reportPayload.targets[0].finalized,true);
    for (const field of ['nativeKey','bounds','client','hwnd','pid','title','text','regions']) {
      assert.equal(reportRun.stdout.includes(field),false,`报告不得回显 ${field}`);
    }
    assert.equal(/[0-9a-f]{8}:[0-9a-f]{8}:[0-9a-f]{16}/.test(reportRun.stdout),false,'报告不得回显私有 key');
    for (const args of [['--window-regions-msaa-report'],['--window-regions-msaa-report','0'],['--window-regions-msaa-report','1','bad'],['--window-regions-msaa-report','1','0000007b:00000001:000000000000002a']]) {
      const bad=spawnSync(plan.exe,args,{windowsHide:true,timeout:10000,encoding:'utf8'});
      assert.equal(bad.status,1,args.join(' ')); assert.equal(bad.stdout,''); assert.match(bad.stderr,/invalid-arguments/);
    }
    // The diagnostic report command only rejects bad arguments here: running it with a valid pid
    // would enumerate the desktop, which this suite never does.
    for (const args of [['--window-regions-report'],['--window-regions-report','0'],['--window-regions-report','123','-1'],['--window-regions-report','123','x']]) {
      const report = spawnSync(plan.exe, args, {windowsHide:true, timeout:20000, encoding:'utf8' });
      assert.equal(report.status, 1, args.join(' '));
      assert.equal(report.stdout, ''); assert.match(report.stderr, /invalid-arguments/);
    }
  });
}
