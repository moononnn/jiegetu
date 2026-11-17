'use strict';
// 长截图 Electron 侧基线：真实 Worker（renderer/scroll-match-worker.mjs）与真实编辑宿主（main/image-editor-window.cjs）。
//
// 约束：隐藏窗口（show:false，类替身只拦 show() 不上屏）、独立 userData、纯合成像素；
// 不采桌面、不读剪贴板、不写用户目录、不显示窗口、不碰现用进程与现用 userData、不打包不发布。
//
// 用法（必须由 scripts/run-bench-longshot-worker.ps1 起，才能拿到真实退出码与残留核查）：
//   electron scripts/bench-longshot-worker.cjs --phase=worker [--scene=small-steps]
//   electron scripts/bench-longshot-worker.cjs --phase=lifecycle [--rounds=3]
//
// 口径：
// - 进程内存来自 app.getAppMetrics()（workingSetSize，KB），按 PID/类型分开记；跨进程合计会重复计算共享页，
//   不把它当“去重后的整链峰值”。主进程 process.memoryUsage() 另列，不能与 workingSet 混成同一个量。
// - Worker 侧 `sample.durationMs` 由 Worker 自己上报，但它的计时起点在 accept 之前、终点在 checkpoint 之后
//   （`renderer/scroll-match-worker.mjs`：started → accept → checkpoint → durationMs），所以它是
//   「accept + checkpoint + 回包前计数/判定」的合计，**不是纯 accept**。生产 Worker 没有给 checkpoint 单独计时，
//   本脚本也不拿往返差去倒推检查点耗时；检查点的独立耗时只在 core 基准里直接计时。
// - 生命周期区分「返回预览（host.close 只隐藏，DOM 保留）」与「真正销毁（host.dispose 销毁窗口）」。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, screen, nativeImage } = require('electron');

const root = path.resolve(__dirname, '..');
const logs = path.join(root, 'logs');
const userData = path.join(logs, 'bench-userdata-' + process.pid);
const reportFile = path.join(logs, `bench-longshot-worker-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);

const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--([^=]+)=(.*)$/.exec(arg);
  return match ? [match[1], match[2]] : [arg.replace(/^--/, ''), true];
}));

const report = {
  kind: 'electron-bench', phase: options.phase ?? 'both', startedAt: new Date().toISOString(),
  electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
  platform: process.platform, arch: process.arch, pid: process.pid,
  userData: path.relative(root, userData), notes: [], errors: [], timings: {},
  hardware: { cpus: os.cpus().length, model: os.cpus()[0]?.model ?? null, totalMemMB: Math.round(os.totalmem() / 1048576) },
};

const ms = () => Number(process.hrtime.bigint() / 1000000n);
const round2 = value => Number(value.toFixed(2));
const mb = value => Math.round(value / 1048576);

// —— 进程内存采样：只报 app.getAppMetrics() 的实测读数 ——
const sampling = { timer: null, byPid: new Map(), samples: 0 };
function sampleMetrics() {
  sampling.samples++;
  for (const metric of app.getAppMetrics()) {
    const entry = sampling.byPid.get(metric.pid) ?? { pid: metric.pid, type: metric.type, name: metric.name,
      maxWorkingSetKB: 0, maxPeakWorkingSetKB: 0, lastWorkingSetKB: 0 };
    const workingSetKB = metric.memory?.workingSetSize ?? 0;
    entry.lastWorkingSetKB = workingSetKB;
    entry.maxWorkingSetKB = Math.max(entry.maxWorkingSetKB, workingSetKB);
    entry.maxPeakWorkingSetKB = Math.max(entry.maxPeakWorkingSetKB, metric.memory?.peakWorkingSetSize ?? 0);
    entry.name = metric.name || entry.name;
    entry.type = metric.type || entry.type;
    sampling.byPid.set(metric.pid, entry);
  }
}
function startSampling(intervalMs = 200) {
  sampleMetrics();
  sampling.timer = setInterval(sampleMetrics, intervalMs);
}
function stopSampling() { if (sampling.timer) clearInterval(sampling.timer); sampling.timer = null; }
function metricsSnapshot(label) {
  return { label, atMs: round2(performance.now()),
    processes: app.getAppMetrics().map(metric => ({ pid: metric.pid, type: metric.type, name: metric.name,
      workingSetMB: Math.round((metric.memory?.workingSetSize ?? 0) / 1024),
      peakWorkingSetMB: Math.round((metric.memory?.peakWorkingSetSize ?? 0) / 1024) })),
    main: (() => { const usage = process.memoryUsage();
      return { rssMB: mb(usage.rss), heapUsedMB: mb(usage.heapUsed), externalMB: mb(usage.external), arrayBuffersMB: mb(usage.arrayBuffers) }; })() };
}
function sampledPeaks() {
  return { samples: sampling.samples,
    processes: [...sampling.byPid.values()].map(entry => ({ pid: entry.pid, type: entry.type, name: entry.name,
      maxWorkingSetMB: Math.round(entry.maxWorkingSetKB / 1024), lastWorkingSetMB: Math.round(entry.lastWorkingSetKB / 1024),
      maxPeakWorkingSetMB: Math.round(entry.maxPeakWorkingSetKB / 1024) })),
    note: 'app.getAppMetrics() 采样最大值；跨进程相加会重复计算共享页，不是去重后的整链峰值' };
}
const sleep = duration => new Promise(resolve => setTimeout(resolve, duration));

// —— 阶段一：真实 Worker 喂帧 ——
const SCENES = {
  'small-steps': { width: 2119, bodyHeight: 1200, step: 40, count: 60 },
  near16m: { width: 2119, bodyHeight: 1200, step: 160, count: 40 },
  'fixed-cleared': { width: 2119, bodyHeight: 1200, step: 40, count: 60, overlay: { left: 300, top: 500, width: 120, height: 160 } },
};

async function runWorkerPhase() {
  const sceneName = options.scene ?? 'small-steps';
  const spec = SCENES[sceneName];
  if (!spec) throw new Error(`未知场景：${sceneName}`);
  const workerUrl = pathToFileURL(path.join(root, 'renderer', 'scroll-match-worker.mjs')).href;
  const scenesUrl = pathToFileURL(path.join(root, 'test', 'fixtures', 'auto-scenes.mjs')).href;
  const harness = path.join(root, 'test', 'fixtures', 'worker-bench.html');
  const win = new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  report.worker = { scene: sceneName, spec, windowPid: win.webContents.getOSProcessId(), window: { show: false, sandbox: true } };
  const started = ms();
  await win.loadFile(harness, { query: { worker: workerUrl, scenes: scenesUrl, spec: JSON.stringify({ ...spec, seed: 20261104 }) } });
  report.timings.loadHarnessMs = ms() - started;
  startSampling(200);
  const deadline = Date.now() + 600000;
  let bench = null;
  while (Date.now() < deadline) {
    bench = await win.webContents.executeJavaScript('window.__bench');
    if (bench && (bench.state === 'done' || bench.state === 'error')) break;
    await sleep(300);
  }
  stopSampling();
  report.timings.workerTotalMs = ms() - started;
  if (!bench || bench.state !== 'done') {
    report.errors.push(`worker 阶段未完成：${bench?.state ?? 'no-bench'} ${bench?.message ?? ''}`.trim());
  }
  // 帧级明细留报告，便于核对检查点与耗时；像素一律不落盘。
  report.worker.result = bench ? { state: bench.state, message: bench.message ?? null, workerReadyMs: bench.workerReadyMs ?? null,
    summary: bench.summary ?? null, frames: bench.frames ?? null, checkpoints: bench.checkpoints ?? null } : null;
  report.worker.memory = { sampledPeaks: sampledPeaks(),
    snapshots: [metricsSnapshot('worker-done')] };
  report.worker.windowPidAlive = !win.isDestroyed();
  win.destroy();
  await sleep(1500);
  report.worker.memory.afterWindowDestroy = metricsSnapshot('worker-window-destroyed');
  return bench;
}

// —— 阶段二：真实编辑宿主生命周期 ——
function buildLongBitmap(width, height) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const r = Math.floor(y / 256) % 256, g = y % 256;
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const index = row + x * 4;
      const marked = y % 200 === 0 && x >= 100 && x < 460;
      data[index] = marked ? 250 : r; data[index + 1] = marked ? 40 : g; data[index + 2] = 120; data[index + 3] = 255;
    }
  }
  return data;
}

async function runLifecyclePhase() {
  const rounds = Number(options.rounds ?? 3);
  const width = Number(options.width ?? 2119), height = Number(options.height ?? 11275);
  const rendererFile = path.join(root, 'renderer', 'image-editor-window.html');
  const preloadFile = path.join(root, 'main', 'image-editor-preload.cjs');
  const iconFile = path.join(root, 'assets', 'app-icon.ico');
  // 真实 BrowserWindow 类，只拦 show()/hide()：产品逻辑看到 isVisible() 为真或假，但窗口从不上屏。
  // 必须让 hide() 真的把 isVisible() 变回 false，否则 close() 的“仍在前台”校验会失败（那是产品自检，不能绕过）。
  const NativeWindow = BrowserWindow;
  class HiddenWindow extends NativeWindow {
    show() { this.__shown = true; }
    hide() { this.__shown = false; }
    isVisible() { return Boolean(this.__shown); }
    focus() { this.__focused = (this.__focused ?? 0) + 1; }
  }
  const host = require(path.join(root, 'main', 'image-editor-window.cjs')).installImageEditorWindow({
    BrowserWindow: HiddenWindow, screen, ipcMain, rendererFile, preloadFile, iconFile, theme: null,
    showDirectory: async () => ({ canceled: true }), onLifecycle: () => {}, onStatus: () => {},
    onCommit: async () => ({ ok: true }), onClose: async () => true, onExit: async () => false, canInteract: () => true,
  });
  let bitmapStarted = ms();
  const bitmap = buildLongBitmap(width, height);
  const source = nativeImage.createFromBitmap(bitmap, { width, height });
  report.timings.buildBitmapMs = ms() - bitmapStarted;
  bitmapStarted = ms();
  const dataUrl = source.toDataURL();
  report.timings.encodeDataUrlMs = ms() - bitmapStarted;
  report.lifecycle = { image: { width, height, pixels: width * height, rgbaMB: Math.round(width * height * 4 / 1048576) },
    rounds: [], dataUrlLength: dataUrl.length,
    note: '每轮：open(真实 IPC 进编辑宿主) → export PNG 只取字节 → close(只隐藏，DOM 保留) → 1/5/15 秒采样 → dispose(真正销毁窗口) → 1/5 秒采样' };
  startSampling(200);
  report.lifecycle.baseline = metricsSnapshot('baseline');
  for (let round = 1; round <= rounds; round++) {
    const token = `bench-round-${round}`;
    const row = { round, token };
    const doc = { token, width, height, rect: { x: 0, y: 0, width, height }, presentation: 'long-result', longToken: `bench-long-${round}` };
    let openedAt = ms();
    try {
      await host.open(doc, { dataUrl, warning: '', checkRegions: { total: 0, truncated: false, rects: [] } });
      row.openMs = ms() - openedAt;
      await sleep(900);
      row.afterOpen = metricsSnapshot(`round-${round}-open`);
      openedAt = ms();
      const exported = await host.export(token, 'png');
      row.exportMs = ms() - openedAt;
      row.exportBytes = exported?.png ? exported.png.length : 0;
      row.exportSha = exported?.png ? crypto.createHash('sha256').update(Buffer.from(exported.png)).digest('hex').slice(0, 16) : null;
      row.afterExport = metricsSnapshot(`round-${round}-export`);
      openedAt = ms();
      row.closeReturned = await host.close(token);
      row.closeMs = ms() - openedAt;
      row.afterClose = metricsSnapshot(`round-${round}-close`);
      await sleep(1000); row.hidden1s = metricsSnapshot(`round-${round}-hidden-1s`);
      await sleep(4000); row.hidden5s = metricsSnapshot(`round-${round}-hidden-5s`);
      await sleep(10000); row.hidden15s = metricsSnapshot(`round-${round}-hidden-15s`);
    } catch (error) {
      row.error = String(error?.message || error);
      report.errors.push(`第 ${round} 轮失败：${row.error}`);
    }
    const disposeAt = ms();
    try { host.dispose(); } catch (error) { report.errors.push(`dispose 失败：${error?.message || error}`); }
    row.disposeMs = ms() - disposeAt;
    await sleep(1000); row.destroyed1s = metricsSnapshot(`round-${round}-destroyed-1s`);
    await sleep(4000); row.destroyed5s = metricsSnapshot(`round-${round}-destroyed-5s`);
    report.lifecycle.rounds.push(row);
  }
  stopSampling();
  report.lifecycle.sampledPeaks = sampledPeaks();
  try { host.dispose(); } catch { /* 收尾重复 dispose 无害。 */ }
  return report.lifecycle;
}

async function run() {
  await app.whenReady();
  if (report.phase === 'worker' || report.phase === 'both') {
    await runWorkerPhase();
    await sleep(2000);
  }
  if (report.phase === 'lifecycle' || report.phase === 'both') {
    await runLifecyclePhase();
  }
  report.finishedAt = new Date().toISOString();
  report.ok = report.errors.length === 0;
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 1)}\n`);
  console.log(`REPORT ${reportFile}`);
  console.log(JSON.stringify({ ok: report.ok, phase: report.phase, errors: report.errors,
    worker: report.worker?.result?.summary ?? null, lifecycleRounds: report.lifecycle?.rounds?.length ?? 0 }));
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* 残留目录留在 logs 也不影响产品。 */ }
  app.exit(report.ok ? 0 : 1);
}

app.on('window-all-closed', () => { /* 由脚本自己退出。 */ });
run().catch(error => {
  report.errors.push(`脚本异常：${error?.stack || error}`);
  report.ok = false;
  try { fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 1)}\n`); } catch { /* 报告写不出也不掩盖失败。 */ }
  console.error(error);
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
  app.exit(1);
});
