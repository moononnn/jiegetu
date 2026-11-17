/* 真实链路隐藏验收：真实 renderer/workspace.js + 真实 main/workspace-preload.cjs +
   真实 ipcMain 与 main/workspace-window.cjs，只把系统发布（service.publish）与目录对话框换成替身。
   证明 renderer → contextBridge → ipcRenderer.invoke → main → PNG 文件 → 假 publish 整条走通。
   不加载生产 main/index.cjs，不碰真实 userData、剪贴板与桌面。
   运行：node_modules\electron\dist\electron.exe scripts\verify-workspace-ipc.cjs */
'use strict';
const { app, BrowserWindow, ipcMain, screen, nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { createClipboardStore } = require('../main/clipboard-store.cjs');
const { installWorkspaceWindow } = require('../main/workspace-window.cjs');

const ROOT = path.join(__dirname, '..');
const results = [];
const failures = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures.push(name);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makePng(width, height, paint) {
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
    const base = y * (stride + 1);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      rows[base + 1 + x * 3] = r; rows[base + 2 + x * 3] = g; rows[base + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
function pngSize(bytes) {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ipc-'));
  const store = createClipboardStore({ root: path.join(root, 'library') });
  await store.open();

  const red = [220, 40, 60], blue = [30, 60, 200];
  const pngA = makePng(300, 200, (x, y) => (x >= 60 && x < 160 && y >= 40 && y < 120 ? red : [240, 240, 235]));
  const pngB = makePng(240, 180, (x, y) => (y < 90 ? blue : [245, 245, 240]));
  const entryA = await store.addEntry({ entries: [{ key: 'png', bytes: pngA }], source: 'verify' });
  const entryB = await store.addEntry({ entries: [{ key: 'png', bytes: pngB }], source: 'verify' });

  // 发布替身：只记录，不碰系统剪贴板。
  const published = [];
  const service = { publish: async parts => { published.push(parts); return { ok: true }; } };
  const exportRoot = path.join(root, 'export');
  fs.mkdirSync(exportRoot, { recursive: true });

  const workspace = installWorkspaceWindow({
    BrowserWindow, ipcMain, screen,
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    theme: { bind() {} },
    rendererFile: path.join(ROOT, 'renderer/workspace.html'),
    preloadFile: path.join(ROOT, 'main/workspace-preload.cjs'),
    iconFile: path.join(ROOT, 'assets/app-icon.ico'),
    store, service, settings: { getClipboard: () => ({ enabled: false }) },
    exportRoot, showWindow: false
  });

  const opened = await workspace.openFromEntries([entryA.id, entryB.id]);
  const win = workspace.getWindow(opened.groupId);
  check('真实工作台窗口创建', Boolean(win) && !win.isDestroyed(), { groupId: opened.groupId });

  const consoleLines = [];
  win.webContents.on('console-message', (event, level, message) => consoleLines.push(`${level}: ${message}`));
  win.webContents.on('preload-error', (event, file, error) => consoleLines.push(`preload-error: ${error}`));

  for (let index = 0; index < 80 && win.webContents.isLoading(); index++) await sleep(100);
  await sleep(900);

  // 页面必须是通过真实 preload 拿到 workspaceHost，而不是被注入的替身。
  const bridge = await win.webContents.executeJavaScript(`(() => {
    const host = window.workspaceHost;
    return { has: Boolean(host), methods: host ? Object.keys(host).sort() : [],
      rows: document.querySelectorAll('.ws-image').length,
      selfTest: typeof host?.exportPart === 'function' };
  })()`);
  check('真实 preload 暴露了窄接口', bridge.has && bridge.selfTest && bridge.methods.includes('asset') && bridge.methods.includes('exportPart'), bridge);
  check('页面渲染出两张图块', bridge.rows === 2, bridge.rows);

  // 手写一条意见，让说明.txt 有内容（真实 renderer 的保存走 IPC）。
  await win.webContents.executeJavaScript(`(() => {
    const title = document.getElementById('groupTitle');
    title.value = 'IPC 验证组';
    title.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(700);

  await win.webContents.executeJavaScript(`document.getElementById('copyAll').click()`);
  const deadline = Date.now() + 60000;
  while (!published.length && Date.now() < deadline) await sleep(200);
  check('真实链路完成一次发布', published.length === 1, { published: published.length, consoleLines });
  if (!published.length) {
    console.info(JSON.stringify({ ok: false, failures, results, consoleLines }, null, 2));
    await store.close();
    app.exit(1);
    return;
  }

  const parts = published[0];
  const files = parts[0]?.paths || [];
  check('发布的是文件列表且含说明.txt', parts[0]?.format === 'files' && files.at(-1)?.endsWith('说明.txt'), { format: parts[0]?.format, files });
  check('文件数 = 总览 + 2 图 + 说明', files.length === 4, files);
  const existsAll = files.every(file => fs.existsSync(file));
  check('四个文件都真实落在磁盘上', existsAll, files);
  if (existsAll) {
    const sizes = files.slice(0, 3).map(file => pngSize(fs.readFileSync(file)));
    const sourceSizes = [{ width: 300, height: 200 }, { width: 240, height: 180 }];
    check('逐图输出尺寸由 main 计划冻结（不是 renderer 自报）',
      sizes[1].width >= sourceSizes[0].width && sizes[1].width === Math.max(sourceSizes[0].width, 720) &&
      sizes[2].width === Math.max(sourceSizes[1].width, 720), sizes);
    const text = fs.readFileSync(files.at(-1), 'utf8');
    check('说明.txt 是 main 自己写的（含组名）', text.includes('IPC 验证组'), text.slice(0, 80));
    // 抽查图1 的图体像素：左上角仍是原图底色，说明没有把内存错位数据写进去。
    const image = nativeImage.createFromPath(files[1]);
    const bitmap = image.toBitmap();
    const size = image.getSize();
    const offset = (60 * size.width + 130) * 4;
    const channels = [bitmap[offset], bitmap[offset + 1], bitmap[offset + 2]];
    check('图1 图体像素来自正确视图（背景色对）', Math.max(...channels) > 200 && Math.min(...channels) > 200, channels);
  }
  check('发布只发生一次，没有双发', published.length === 1, published.length);
  check('页面没有脚本错误', consoleLines.filter(line => line.startsWith('preload-error') || line.startsWith('3:')).length === 0, consoleLines);

  // 三轮开/关：每轮都是新页面，预览缓存从 0 起且不超预算；关窗后不再持有窗口。
  for (let round = 1; round <= 3; round++) {
    win.destroy();
    await sleep(200);
    const again = await workspace.openGroup(opened.groupId);
    const reopened = workspace.getWindow(again.groupId);
    for (let index = 0; index < 80 && reopened.webContents.isLoading(); index++) await sleep(100);
    await sleep(700);
    const stats = await reopened.webContents.executeJavaScript('window.__workspaceStats()');
    check(`第 ${round} 轮重开：预览缓存有界且从零起`, stats.previews <= 2 && stats.previewBytes <= 64 * 1024 * 1024, stats);
    check(`第 ${round} 轮重开：图块仍在`, await reopened.webContents.executeJavaScript(`document.querySelectorAll('.ws-image').length`) === 2, undefined);
    reopened.destroy();
    await sleep(200);
    check(`第 ${round} 轮关闭后不再持有窗口`, workspace.getWindow(opened.groupId) === undefined, undefined);
  }
  const stillWorks = await store.list({ page: 1 });
  check('三轮之后存储仍可用', stillWorks.pages >= 1, { pages: stillWorks.pages });

  win.destroy();
  await sleep(150);
  await workspace.dispose?.();
  await store.close();
  console.info(JSON.stringify({ ok: failures.length === 0, failures, results, bootstrap: root }, null, 2));
  app.exit(failures.length === 0 ? 0 : 1);
}

// 独立临时 profile：在 app ready 之前把 userData/sessionData 指到本次临时目录，
// 不读也不写真实 APPDATA，也不加载生产 main/index.cjs。
const e2eProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ipc-profile-'));
const e2eSession = path.join(e2eProfile, 'session');
fs.mkdirSync(e2eSession, { recursive: true });
app.setPath('userData', e2eProfile);
app.setPath('sessionData', e2eSession);

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(main).catch(error => {
  console.error(JSON.stringify({ ok: false, error: String(error?.stack || error) }));
  app.exit(2);
});
