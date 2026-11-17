/* 剪贴板图进编辑页后能不能正常关掉：真实 installScreenshot + 真实编辑宿主，
   只把发布、设置、状态换成替身，窗口全程不显示。验收 openExternalEditor → 点 × → 窗口销毁。 */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { installScreenshot } = require('../main/screenshot.cjs');

const results = [];
const failures = [];
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok), detail }); if (!ok) failures.push(name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makePng(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length, 0);
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const stride = width * 3;
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      rows[y * (stride + 1) + 1 + x * 3] = 220;
      rows[y * (stride + 1) + 2 + x * 3] = 235;
      rows[y * (stride + 1) + 3 + x * 3] = 225;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-exit-'));
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.disableHardwareAcceleration();
// 验收里只有编辑窗这一扇；默认“最后一个窗口关掉就退出”会把验收自己带跑。
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  console.log('STEP ready');
  let closedCalls = 0;
  const shots = installScreenshot({
    getControl: () => undefined,
    isProbeBusy: () => false,
    directory: path.join(userData, 'shots'),
    settings: { resolveSaveFolder: folder => folder, resolveAsFolder: folder => folder,
      getClipboard: () => ({ enabled: false }) },
    theme: undefined,
    onStatus: () => {},
    publishPng: async () => true,
    copyGif: async () => ({}),
    onExternalEditorClosed: () => { closedCalls += 1; }
  });
  await fs.promises.mkdir(path.join(userData, 'shots'), { recursive: true });
  console.log('STEP installed');

  const before = new Set(BrowserWindow.getAllWindows().map(win => win.id));
  const opened = await shots.openExternalEditor({ bytes: makePng(400, 300) });
  console.log('STEP opened ' + JSON.stringify(opened));
  check('外部编辑拿到会话', opened?.ok === true && typeof opened.token === 'string', JSON.stringify(opened));

  await sleep(2600);
  const win = BrowserWindow.getAllWindows().find(item => !before.has(item.id));
  console.log('STEP windows ' + BrowserWindow.getAllWindows().length);
  check('编辑窗口真的开了', Boolean(win), `窗口数 ${BrowserWindow.getAllWindows().length}`);
  if (!win) {
    console.log(JSON.stringify({ results, failures }, null, 1));
    app.exit(1);
    return;
  }
  check('编辑页加载完成', win.webContents.getURL().includes('image-editor-window.html'), win.webContents.getURL());

  // 模拟点窗口右上角 ×：会触发 win.on('close') → onExit('window-close')。
  win.close();
  await sleep(900);
  check('点 × 后编辑窗口被销毁', win.isDestroyed(), `destroyed=${win.isDestroyed()}`);
  check('关掉后通知剪贴板窗口回来', closedCalls === 1, `调用 ${closedCalls} 次`);

  console.log(JSON.stringify({ results, failures }, null, 1));
  app.exit(failures.length ? 1 : 0);
}).catch(error => { console.error('FAIL', error); app.exit(1); });
process.on('uncaughtException', error => { console.error('UNCAUGHT', error); app.exit(1); });
process.on('unhandledRejection', error => { console.error('UNHANDLED', error); });
