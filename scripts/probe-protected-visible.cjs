'use strict';
// 实验：窗口「显示后再」打开内容保护，它自己还看不看得见。
// 左上品红不保护，右下青色显示 1.2 秒后再保护；两个都停留 35 秒，人眼看、同时录屏对照。
// 只创建自己的色块窗口，不碰生产代码与用户数据。

const { app, BrowserWindow, screen } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

const W = 300;
const H = 150;
const HOLD_MS = 35000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function captureFrame(region) {
  const exe = path.join(__dirname, '..', 'native', 'wgc-record.exe');
  const bytes = region.width * region.height * 4;
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [region.x, region.y, region.width, region.height].map(String).concat('--record'),
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = Buffer.alloc(0);
    let requested = false;
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* 已退出。 */ }
      if (error) reject(error); else resolve(value);
    };
    const ask = () => {
      if (requested) return;
      requested = true;
      try { child.stdin.write(Buffer.from('N')); } catch { /* 管道可能已断。 */ }
    };
    const timer = setTimeout(() => finish(new Error('取帧超时')), 8000);
    child.stdout.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) !== 'JGC2') return finish(new Error('帧头不是 JGC2'));
      if (buffer.length < 20) return;
      if (buffer.readUInt32LE(16) !== 1) { requested = false; ask(); return; }
      if (buffer.length < 20 + bytes) return;
      finish(null, buffer.subarray(20, 20 + bytes));
    });
    child.on('error', error => finish(error));
    child.on('close', code => { if (!done) finish(new Error(`采集进程退出 code=${code}`)); });
    ask();
  });
}

function averageColor(pixels, width, height) {
  const spots = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]];
  const samples = spots.map(([fx, fy]) => {
    const x = Math.min(width - 1, Math.max(0, Math.round(width * fx)));
    const y = Math.min(height - 1, Math.max(0, Math.round(height * fy)));
    const index = (y * width + x) * 4;
    return [pixels[index], pixels[index + 1], pixels[index + 2]];
  });
  return [0, 1, 2].map(channel => Math.round(samples.reduce((sum, item) => sum + item[channel], 0) / samples.length));
}

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay();
  const scale = Number(display.scaleFactor) > 0 ? Number(display.scaleFactor) : 1;
  const area = display.workArea;

  const make = (color, x, y) => new BrowserWindow({
    x, y, width: W, height: H, frame: false, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, show: false, hasShadow: false,
    backgroundColor: color,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
  });

  const left = make('#ff00ff', area.x + 80, area.y + 80);
  const right = make('#00ffff', area.x + area.width - W - 80, area.y + area.height - H - 80);
  for (const [win, color] of [[left, '#ff00ff'], [right, '#00ffff']]) {
    await win.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;padding:0;background:${color}"></body>`));
    win.setAlwaysOnTop(true, 'screen-saver');
    win.showInactive();
  }

  // 关键差别：先让窗口正常显示、稳定下来，再开保护。
  await sleep(1200);
  right.setContentProtection(true);
  await sleep(1000);

  const regionOf = win => {
    const bounds = win.getBounds();
    return {
      x: Math.round(bounds.x * scale), y: Math.round(bounds.y * scale),
      width: Math.round(bounds.width * scale), height: Math.round(bounds.height * scale)
    };
  };
  const report = { scaleFactor: scale, visibleForMs: HOLD_MS, leftColor: 'magenta', rightColor: 'cyan' };
  try {
    const region = regionOf(left);
    report.leftRgb = averageColor(await captureFrame(region), region.width, region.height);
  } catch (error) { report.leftError = error.message; }
  try {
    const region = regionOf(right);
    report.rightRgb = averageColor(await captureFrame(region), region.width, region.height);
  } catch (error) { report.rightError = error.message; }

  console.log(JSON.stringify(report));
  await sleep(HOLD_MS);
  left.destroy();
  right.destroy();
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });