'use strict';
// 实验：setContentProtection 能否让窗口从 WGC 录制里消失。
// 只起一个自己的色块窗口、录自己的屏幕小块，不碰生产代码、不动用户数据。
// 对照组不开保护，应当录到品红；实验组开保护，看录到的是品红（失败）、纯黑（黑块模式）还是桌面背景（成功）。

const { app, BrowserWindow, screen } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

const WIN_W = 390;
const WIN_H = 94;
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
      const flags = buffer.readUInt32LE(16);
      if (flags !== 1) { requested = false; ask(); return; }
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

function classify([r, g, b]) {
  if (r > 170 && b > 170 && g < 90) return 'magenta';
  if (r < 25 && g < 25 && b < 25) return 'black';
  return 'other';
}

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay();
  const scale = Number(display.scaleFactor) > 0 ? Number(display.scaleFactor) : 1;
  const area = display.workArea;
  const dipX = Math.round(area.x + (area.width - WIN_W) / 2);
  const dipY = Math.round(area.y + (area.height - WIN_H) / 2);
  const win = new BrowserWindow({
    x: dipX, y: dipY, width: WIN_W, height: WIN_H, frame: false, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, show: false, hasShadow: false,
    backgroundColor: '#ff00ff',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  await win.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;padding:0;background:#ff00ff"></body>'));
  win.showInactive();
  await sleep(1200);

  const region = {
    x: Math.round(dipX * scale), y: Math.round(dipY * scale),
    width: Math.round(WIN_W * scale), height: Math.round(WIN_H * scale)
  };
  const report = { region, scaleFactor: scale, electron: process.versions.electron, windows: process.getSystemVersion?.() };

  try {
    const control = await captureFrame(region);
    report.controlRgb = averageColor(control, region.width, region.height);
    report.controlKind = classify(report.controlRgb);

    win.setContentProtection(true);
    await sleep(1500);

    const guarded = await captureFrame(region);
    report.protectedRgb = averageColor(guarded, region.width, region.height);
    report.protectedKind = classify(report.protectedRgb);

    report.verdict = report.controlKind === 'magenta'
      ? (report.protectedKind === 'other' ? 'excluded' : report.protectedKind === 'black' ? 'black-block' : 'still-captured')
      : 'control-broken';
  } catch (error) {
    report.error = error.message;
    report.verdict = 'error';
  }

  console.log(JSON.stringify(report, null, 2));
  win.destroy();
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });