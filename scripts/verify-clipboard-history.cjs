/* 真实链路隐藏验收：真实 renderer/clipboard-history.html/.js + main/clipboard-preload.cjs +
   真实 main/clipboard-window.cjs + 真实 main/clipboard-store.cjs（临时 userData），
   只把剪贴板发布（service.publish）、监听状态与设置换成替身。
   证明“点了剪贴板历史→窗口能开、列表能出、复制能打到发布通道”，窗口全程不显示、不碰真实剪贴板。
   运行：node_modules\electron\dist\electron.exe scripts\verify-clipboard-history.cjs */
'use strict';
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createClipboardStore } = require('../main/clipboard-store.cjs');
const { installClipboardWindow } = require('../main/clipboard-window.cjs');

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
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      rows[y * (stride + 1) + 1 + x * 3] = r;
      rows[y * (stride + 1) + 2 + x * 3] = g;
      rows[y * (stride + 1) + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'clipboard-window-'));
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.disableHardwareAcceleration();

// 真窗口但永不显示：renderer 照常跑，桌面不被打扰。
let shownCount = 0;
class HiddenWindow extends BrowserWindow {
  constructor(options = {}) { super({ ...options, show: false }); }
  show() { shownCount += 1; }
  showInactive() { shownCount += 1; }
}

app.whenReady().then(async () => {
  const store = createClipboardStore({ root: path.join(userData, 'clipboard') });
  await store.open();
  const published = [];
  const settingsState = { enabled: false, paused: false, hotkey: 'Ctrl+Alt+V', retentionDays: 30,
    maxHistoryItems: 1000, maxStorageBytes: 2 * 1024 * 1024 * 1024, excludedApps: [] };
  const service = {
    status: () => ({ phase: 'ready' }),
    publish: async parts => { published.push(parts.map(part => part.format).sort()); return { published: true }; },
    paste: async () => true,
    setExcludedApps: () => {}
  };
  const settings = {
    getClipboard: () => ({ ...settingsState, excludedApps: [] }),
    updateClipboard: patch => { Object.assign(settingsState, patch); return { ...settingsState, excludedApps: [] }; }
  };

  await store.addEntry({ entries: [{ key: 'text', bytes: Buffer.from('验收用的文字', 'utf16le') }], source: 'verify' });
  await store.addEntry({ entries: [{ key: 'png', bytes: makePng(120, 80, (x, y) => (y < 40 ? [200, 60, 80] : [240, 240, 235])) }], source: 'verify' });

  const statusCallbacks = [];
  const windowHost = installClipboardWindow({
    BrowserWindow: HiddenWindow, ipcMain, theme: undefined, nativeImage,
    rendererFile: path.join(ROOT, 'renderer', 'clipboard-history.html'),
    preloadFile: path.join(ROOT, 'main', 'clipboard-preload.cjs'),
    iconFile: path.join(ROOT, 'assets', 'app-icon.ico'),
    store, service, settings,
    onStatus: status => { statusCallbacks.push(status); }, getPasteTarget: () => undefined,
    getRevision: () => 0,
    multiCopyDir: path.join(userData, 'clipboard', 'multi-copy'),
    onOpenWorkspace: () => ({ ok: true }), onOpenGroup: () => ({ ok: true })
  });

  let gone = false;
  const handle = await windowHost.show();
  const win = windowHost.getWindow();
  win.webContents.on('render-process-gone', () => { gone = true; });
  const consoleErrors = [];
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) consoleErrors.push(message); });
  await sleep(1200);

  const run = code => win.webContents.executeJavaScript(code, true);
  check('窗口拿到 token', typeof handle?.token === 'string' && handle.token.length > 10);
  check('窗口没有真的弹到桌面上', win.isVisible() === false, `show 调用 ${shownCount} 次、isVisible=${win.isVisible()}`);
  check('渲染进程存活', gone === false);
  check('页面无运行时错误', consoleErrors.length === 0, consoleErrors.slice(0, 3));

  const dom = await run(`(() => ({
    bridge: typeof window.clipboardHost?.list === 'function',
    gateHidden: document.getElementById('gate').hidden,
    status: document.getElementById('status').textContent,
    rows: document.querySelectorAll('#list .clip-row[data-id]').length,
    bodyText: document.getElementById('list').textContent.slice(0, 120)
  }))()`);
  check('preload 桥就绪', dom.bridge === true);
  check('记录未开启时先给开启引导', dom.gateHidden === false);
  check('未开启时状态栏说不记录', dom.status.includes('记录未开启'), dom.status);

  // 点“开启记录”：走 clip:set-enabled → onStatus → 页面状态跟着变。
  await run(`document.getElementById('enable').click()`);
  await sleep(500);
  const afterEnable = await run(`(() => ({
    gateHidden: document.getElementById('gate').hidden,
    status: document.getElementById('status').textContent
  }))()`);
  check('开启记录写到设置', settingsState.enabled === true);
  check('开启记录通知主进程', statusCallbacks.some(status => status?.clipboardChanged === true),
    JSON.stringify(statusCallbacks));
  check('开启后引导消失', afterEnable.gateHidden === true, String(afterEnable.gateHidden));
  // 开启后先显示操作结果，几秒后才回到阶段状态；两者都说明记录已开。
  check('状态栏说明记录已开', /记录已开启|正在记录/.test(afterEnable.status), afterEnable.status);

  const listed = await run(`(() => ({
    rows: document.querySelectorAll('#list .clip-row[data-id]').length,
    bodyText: document.getElementById('list').textContent.slice(0, 120)
  }))()`);
  check('列表出现两条历史', listed.rows === 2, `rows=${listed.rows}`);
  check('列表带出真实内容', listed.bodyText.includes('验收用的文字'), listed.bodyText);

  // 单击第一条（图片）：行内操作按钮出现，点“复制”应打到 service.publish 替身。
  await run(`(() => {
    const rows = [...document.querySelectorAll('#list .clip-row[data-id]')];
    const image = rows.find(row => row.textContent.includes('图')) || rows[0];
    image.click();
  })()`);
  await sleep(250);
  const selected = await run(`(() => {
    const row = document.querySelector('#list .clip-row[aria-selected="true"]');
    return Boolean(row && row.querySelector('[data-act="copy"]'));
  })()`);
  check('选中后行内出现复制按钮', selected === true);
  await run(`document.querySelector('#list .clip-row[aria-selected="true"] [data-act="copy"]').click()`);
  await sleep(400);
  check('复制打到发布通道', published.length === 1, JSON.stringify(published));
  check('发布的是原格式负载', JSON.stringify(published[0] || []) === '["png"]', JSON.stringify(published[0]));

  // 点缩略图看大图
  await run(`document.querySelector('#list .clip-thumb.zoomable').click()`);
  await sleep(600);
  const lightboxState = await run(`(() => ({
    hidden: document.getElementById('lightbox').hidden,
    hasSrc: (document.getElementById('lightboxImage').src || '').startsWith('blob:'),
    meta: document.getElementById('lightboxMeta').textContent
  }))()`);
  check('点缩略图打开大图', lightboxState.hidden === false, JSON.stringify(lightboxState));
  check('大图拿到 blob 地址', lightboxState.hasSrc === true, lightboxState.hasSrc);
  check('大图带尺寸与时间', /\d+ × \d+/.test(lightboxState.meta), lightboxState.meta);
  // 关闭入口只留窗口 × 、点空白和 Esc，栏里不再放重复按钮。
  await run(`(() => {
    document.getElementById('lightboxStage').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  })()`);
  await sleep(200);
  const closed = await run(`document.getElementById('lightbox').hidden`);
  check('点空白后大图收起', closed === true, String(closed));

  // 多选合并复制：勾一图一文，应该能一键复制成“文字 + 文件”
  await run(`(() => { for (const box of document.querySelectorAll('#list .clip-pick')) box.click(); })()`);
  await sleep(250);
  const manyState = await run(`(() => ({
    hidden: document.getElementById('copyMany').hidden,
    label: document.getElementById('copyMany').textContent
  }))()`);
  check('勾选后出现复制所选', manyState.hidden === false, JSON.stringify(manyState));
  check('复制所选带上数量', /复制所选（\d）/.test(manyState.label), manyState.label);
  const sendState = await run(`(() => ({
    hidden: document.getElementById('sendMany').hidden,
    label: document.getElementById('sendMany').textContent
  }))()`);
  check('勾选后出现发送所选', sendState.hidden === false, JSON.stringify(sendState));
  check('发送所选带上数量', /发送所选（\d）/.test(sendState.label), sendState.label);
  await run(`document.getElementById('copyMany').click()`);
  await sleep(800);
  const merged = published.at(-1) || [];
  check('合并复制带上文字与文件', merged.includes('text') && merged.includes('files'), JSON.stringify(merged));
  const copiedStatus = await run(`document.getElementById('status').textContent`);
  check('复制结果提示留在状态栏', /已复制/.test(copiedStatus), copiedStatus);
  await run(`document.getElementById('sendMany').click()`);
  await sleep(800);
  const sendStatus = await run(`document.getElementById('status').textContent`);
  check('没有目标窗口时发送降级成提示', /没有可恢复的前台窗口|已复制/.test(sendStatus), sendStatus);

  console.log(JSON.stringify({ results, failures, consoleErrors, published, userData }, null, 2));
  try { windowHost.dispose(); } catch { /* 已销毁。 */ }
  await store.close?.();
  app.exit(failures.length ? 1 : 0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});

setTimeout(() => { console.error('超时退出'); app.exit(2); }, 40000);
