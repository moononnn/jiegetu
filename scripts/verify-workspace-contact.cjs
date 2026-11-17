/* 「再指一处 + 复制对照」端到端验收：真实 workspace-window + 真实页面 + 合成指针事件 + 假 publish。
   1) 在图1 拖框写一条意见；2) 点「再指一处」在图2 拖框；3) 点「复制对照」，
   检查剪贴板回包同时带 PNG 和文字，说明里两处都归到同一条意见。 */
'use strict';
const { app, BrowserWindow, ipcMain, screen, dialog } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const ROOT = path.join(__dirname, '..');
const { createClipboardStore } = require(path.join(ROOT, 'main', 'clipboard-store.cjs'));
const { installWorkspaceWindow } = require(path.join(ROOT, 'main', 'workspace-window.cjs'));

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

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-contact-'));
  const a = makePng(300, 200, (x, y) => (x < 100 ? [230, 240, 233] : [250, 248, 240]));
  const b = makePng(200, 200, () => [240, 245, 250]);

  const store = createClipboardStore({ root: path.join(dir, 'store') });
  await store.open();
  await store.addEntry({ entries: [{ key: 'png', bytes: a }], source: 'test' });
  await store.addEntry({ entries: [{ key: 'png', bytes: b }], source: 'test' });
  const listed = await store.list({ page: 1, size: 10 });
  const ids = (listed.rows || []).map(row => row.id);

  const published = [];
  const service = { publish: async parts => { published.push(parts); return { ok: true }; } };
  const workspace = installWorkspaceWindow({
    BrowserWindow, ipcMain, screen, dialog, theme: undefined,
    rendererFile: path.join(ROOT, 'renderer', 'workspace.html'),
    preloadFile: path.join(ROOT, 'main', 'workspace-preload.cjs'),
    iconFile: path.join(ROOT, 'assets', 'app-icon.ico'),
    store, service, settings: { getClipboard: () => ({ enabled: false }) },
    onStatus: () => {}, exportRoot: path.join(dir, 'out'), showWindow: false, now: () => new Date()
  });

  const opened = await workspace.openFromEntries([ids[0], ids[1]]);
  const win = workspace.getWindow(opened.groupId);
  const run = code => win.webContents.executeJavaScript(code, true);
  await sleep(2200);

  const dragIn = (index, f1, f2) => run(`(() => {
    const stage = document.getElementById('stage');
    const nodes = [...document.querySelectorAll('.ws-image')];
    const el = nodes[${index}];
    if (!el) return 'no-node';
    const r = el.getBoundingClientRect();
    const send = (type, fx, fy) => stage.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 11, button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: r.left + r.width * fx, clientY: r.top + r.height * fy }));
    send('pointerdown', ${f1[0]}, ${f1[1]});
    send('pointermove', ${f2[0]}, ${f2[1]});
    send('pointerup', ${f2[0]}, ${f2[1]});
    return 'ok';
  })()`);

  await run(`document.querySelector('.ws-tool[data-tool="annotate"]').click()`);
  await sleep(120);
  await dragIn(0, [0.08, 0.12], [0.42, 0.68]);
  await sleep(220);
  const composerOpen = await run(`!document.getElementById('composer').hidden`);
  check('拖框后弹出输入框', composerOpen === true, composerOpen);
  await run(`document.getElementById('composerText').value = '这块要换成图2 的样子'; document.getElementById('composerSubmit').click()`);
  await sleep(450);

  let state = await run(`window.workspaceHost.state()`);
  check('第一条意见只有一个目标', state.document.notes.length === 1 && state.document.notes[0].targets.length === 1,
    JSON.stringify(state.document.notes.map(note => note.targets.length)));

  // 选中那条意见：回到选择工具点它的框。
  await run(`document.querySelector('.ws-tool[data-tool="select"]').click()`);
  await sleep(80);
  await dragIn(0, [0.25, 0.4], [0.25, 0.4]);
  await sleep(250);
  const aimVisible = await run(`!document.getElementById('aimTarget').disabled`);
  check('选中后出现「再指一处」', aimVisible === true, aimVisible);

  await run(`document.getElementById('aimTarget').click()`);
  await sleep(120);
  await dragIn(1, [0.1, 0.1], [0.7, 0.7]);
  await sleep(500);

  state = await run(`window.workspaceHost.state()`);
  const targets = state.document.notes[0]?.targets ?? [];
  check('点一下就关联成两处', state.document.notes.length === 1 && targets.length === 2,
    JSON.stringify(targets.map(target => target.imageId)));
  check('两处分属两张图', targets.length === 2 && targets[0].imageId !== targets[1].imageId,
    JSON.stringify(targets.map(t => t.imageId)));
  const composerStillClosed = await run(`document.getElementById('composer').hidden`);
  check('再指一处不弹输入框', composerStillClosed === true, composerStillClosed);

  await run(`document.getElementById('copyContact').click()`);
  const deadline = Date.now() + 20000;
  while (!published.length && Date.now() < deadline) await sleep(200);
  check('点「复制对照」就发布', published.length === 1, published.length);
  if (published.length) {
    const parts = published[0];
    check('一次同时带图和文字', parts.length === 2 && parts[0].format === 'png' && parts[1].format === 'text',
      parts.map(part => part.format).join(','));
    const png = parts.find(part => part.format === 'png');
    const text = parts.find(part => part.format === 'text');
    const value = text ? Buffer.from(text.bytes).toString('utf16le').replace(/\u0000+$/, '') : '';
    check('说明写清两处归一条意见并带原图坐标', /意见1（涉及：图1 框 \([-\d., ]+\)、图2 框 \([-\d., ]+\)）/.test(value), value.replace(/\r\n/g, ' | ').slice(0, 200));
    check('说明带用户原话', /换成图2 的样子/.test(value), value.slice(0, 120));
    if (png) fs.writeFileSync(path.join(process.env.TEMP, 'ws-contact.png'), png.bytes);
  }

  console.log(JSON.stringify({ results, failures }, null, 1));
  await store.close?.();
  app.exit(failures.length ? 1 : 0);
}).catch(error => { console.error('FAIL', error); app.exit(1); });
