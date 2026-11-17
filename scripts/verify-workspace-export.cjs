/* 隐藏窗口里的工作台导出像素验收：真实 renderer/workspace.js + core 导出计划，
   用 test/fixtures/workspace-host-stub.cjs 取代主进程，只写临时目录，不碰生产 userData。
   运行：node_modules\electron\dist\electron.exe scripts\verify-workspace-export.cjs
   退出码 0 = 全部断言通过；结果以 JSON 打到 stdout。 */
'use strict';
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { planExport } = require('../core/annotation-group.js');

const ROOT = path.join(__dirname, '..');
const STUB = path.join(ROOT, 'test/fixtures/workspace-host-stub.cjs');
const PAGE = path.join(ROOT, 'renderer/workspace.html');
const results = [];
const failures = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures.push(name);
};

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
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const stride = width * 3;
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    rows[base] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      rows[base + 1 + x * 3] = r;
      rows[base + 2 + x * 3] = g;
      rows[base + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function sha256(buffer) {
  return require('node:crypto').createHash('sha256').update(buffer).digest('hex');
}

// nativeImage.toBitmap() 在 Windows 上是 BGRA；只比集合/全等白色，不依赖通道顺序。
function bitmapOf(file) {
  const image = nativeImage.createFromPath(file);
  const size = image.getSize();
  return { size, data: image.toBitmap() };
}
function bitmapOfBuffer(buffer) {
  const image = nativeImage.createFromBuffer(buffer);
  const size = image.getSize();
  return { size, data: image.toBitmap() };
}
// 主图安全合成像素逐点对照：遮住的地方必须是纯白，其余每个采样点必须与原件一模一样。
// 这比“扫一个已知颜色”强：任何多画上去的框/编号/连线都会让对应点对不上。
function compareBodyToSource(bitmap, body, source, masks) {
  const inside = (x, y) => (masks || []).some(mask => x >= mask.rect.x && x < mask.rect.x + mask.rect.width &&
    y >= mask.rect.y && y < mask.rect.y + mask.rect.height);
  const step = Math.max(1, Math.floor(Math.min(body.sourceWidth, body.sourceHeight) / 60));
  let mismatches = 0, samples = 0, maskSamples = 0;
  const firstBad = [];
  for (let y = 2; y < body.sourceHeight - 2; y += step) {
    for (let x = 2; x < body.sourceWidth - 2; x += step) {
      const actual = pixelAt(bitmap, body.bodyX + x, body.bodyY + y);
      samples += 1;
      if (inside(x, y)) {
        maskSamples += 1;
        if (!isWhite(actual)) { mismatches += 1; if (firstBad.length < 3) firstBad.push({ x, y, actual, want: 'white' }); }
        continue;
      }
      const want = pixelAt(source, x, y);
      const off = Math.max(Math.abs(actual[0] - want[0]), Math.abs(actual[1] - want[1]), Math.abs(actual[2] - want[2]));
      if (off > 2) { mismatches += 1; if (firstBad.length < 3) firstBad.push({ x, y, actual: actual.slice(0, 3), want: want.slice(0, 3) }); }
    }
  }
  return { mismatches, samples, maskSamples, firstBad };
}
function countInk(bitmap) {
  let ink = 0;
  for (let y = 0; y < bitmap.size.height; y += 3) {
    for (let x = 0; x < bitmap.size.width; x += 3) {
      const pixel = pixelAt(bitmap, x, y);
      if (pixel[0] < 120 && pixel[1] < 120 && pixel[2] < 120) ink += 1;
    }
  }
  return ink;
}
function pixelAt(bitmap, x, y) {
  const offset = (y * bitmap.size.width + x) * 4;
  return [bitmap.data[offset], bitmap.data[offset + 1], bitmap.data[offset + 2], bitmap.data[offset + 3]];
}
function isWhite(pixel) { return pixel[0] === 255 && pixel[1] === 255 && pixel[2] === 255; }
function isColor(pixel, rgb) {
  const set = [pixel[0], pixel[1], pixel[2]].sort((a, b) => a - b);
  const wanted = [...rgb].sort((a, b) => a - b);
  return set[0] === wanted[0] && set[1] === wanted[1] && set[2] === wanted[2];
}
// 需求批注的主色：编辑态的粉红描边/高亮与浅色底。主图里一个像素都不许出现。
const ANNOTATION_ACCENT = [212, 119, 143];
function isAnnotationAccent(pixel) {
  return Math.abs(pixel[0] - ANNOTATION_ACCENT[0]) <= 12
    && Math.abs(pixel[1] - ANNOTATION_ACCENT[1]) <= 12
    && Math.abs(pixel[2] - ANNOTATION_ACCENT[2]) <= 12;
}
function scanAnnotationAccent(bitmap, x0, y0, width, height) {
  let hits = 0, samples = 0;
  for (let y = Math.max(0, Math.ceil(y0)); y < Math.min(bitmap.size.height, y0 + height); y += 2) {
    for (let x = Math.max(0, Math.ceil(x0)); x < Math.min(bitmap.size.width, x0 + width); x += 2) {
      samples += 1;
      if (isAnnotationAccent(pixelAt(bitmap, x, y))) hits += 1;
    }
  }
  return { hits, samples };
}

function writePng(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

const COLOR_BG_A = [0x10, 0x20, 0x30];
const COLOR_RED = [0xff, 0x00, 0x00];
const COLOR_BG_B = [0x20, 0x40, 0x30];
const COLOR_GREEN = [0x00, 0xff, 0x00];

async function runCase({ name, document, assets, expect, kind = 'copy' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ws-export-${name}-`));
  const assetFiles = {};
  for (const [hash, buffer] of Object.entries(assets)) {
    assetFiles[hash] = writePng(path.join(dir, 'assets', `${hash.slice(0, 8)}.png`), buffer);
  }
  const outDir = path.join(dir, 'out');
  const fixtureFile = path.join(dir, 'fixture.json');
  fs.writeFileSync(fixtureFile, JSON.stringify({ document, assets: assetFiles, exportDir: outDir }));
  const win = new BrowserWindow({
    show: false, width: 1100, height: 800,
    webPreferences: { contextIsolation: true, sandbox: false, nodeIntegration: false,
      preload: STUB, additionalArguments: [`--ws-fixture=${fixtureFile}`], backgroundThrottling: false }
  });
  const consoleLines = [];
  win.webContents.on('console-message', (event, level, message) => { consoleLines.push(`${level}: ${message}`); });
  win.webContents.on('preload-error', (event, preloadPath, error) => { consoleLines.push(`preload-error: ${error}`); });
  const loaded = new Promise((resolve, reject) => {
    win.webContents.once('did-finish-load', resolve);
    win.webContents.once('did-fail-load', (event, code, description) => reject(new Error(`${code} ${description}`)));
  });
  await win.loadFile(PAGE);
  await loaded;
  await new Promise(resolve => setTimeout(resolve, 600));
  const rendered = await win.webContents.executeJavaScript(`(() => {
    const rows = document.querySelectorAll('.ws-image').length;
    const save = document.getElementById('saveState')?.textContent;
    const layer = document.getElementById('images');
    return { rows, save, layerChildren: layer ? layer.children.length : -1,
      hint: document.getElementById('hint')?.textContent,
      html: document.getElementById('images')?.innerHTML.slice(0, 120) };
  })()`);
  check(`${name}: 页面渲染出全部图块`, rendered.rows === document.images.length, { ...rendered, consoleLines });
  await win.webContents.executeJavaScript(`document.getElementById('${kind === 'contact' ? 'copyContact' : 'copyAll'}').click()`);
  const textFile = path.join(outDir, '说明.txt');
  const deadline = Date.now() + 90000;
  while (!fs.existsSync(textFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
  const report = await win.webContents.executeJavaScript('window.workspaceHost.__report()');
  check(`${name}: 导出走到完成`, Boolean(report.done), { parts: report.parts.length, aborted: report.aborted });
  check(`${name}: 没有导出报错`, (report.errors || []).length === 0, report.errors);
  await new Promise(resolve => setTimeout(resolve, 300));
  win.destroy();

  const sizes = {};
  for (const [hash, buffer] of Object.entries(assets)) {
    sizes[hash] = { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  const plan = planExport(document, sizes);
  // 主图不再烘标记，逐图页脚必须自己能定位：每个目标带图号与坐标，关系带两端映射。
  for (const image of plan.images) {
    if (image.mode !== 'withNotes') continue;
    const footerText = (image.footer || []).map(line => line.text).join('');
    const mineNotes = plan.snapshot.notes.filter(note => note.targets.some(target => target.imageId === image.imageId));
    if (mineNotes.length) {
      check(`${name}: 图${image.number} 页脚写清每处目标位置`,
        /位置：图\d+ (点 \(|框 \()/.test(footerText), footerText.slice(0, 160));
    }
    const mineRelations = (plan.snapshot.relations || []).filter(relation => relation.ends.some(end => {
      const note = plan.snapshot.notes.find(item => item.id === end.noteId);
      return Boolean(note && note.targets.some(target => target.id === end.targetId && target.imageId === image.imageId));
    }));
    if (mineRelations.length) {
      check(`${name}: 图${image.number} 页脚写清关系两端`,
        /两端：意见\d+ 的 图\d+ /.test(footerText), footerText.slice(0, 240));
    }
  }
  const summary = { name, dir, outDir, modes: plan.modes, files: fs.readdirSync(outDir) };
  if (!report.done) return { ...summary, failed: true };
  const sourceBitmaps = new Map(Object.entries(assets).map(([hash, buffer]) => [hash, bitmapOfBuffer(buffer)]));
  if (kind === 'contact') {
    // 对照图：截图本体必须与原件逐点一致，遮盖处纯白，不带任何需求批注覆盖。
    const sheetFile = path.join(outDir, plan.files[0].name);
    const sheet = bitmapOf(sheetFile);
    check(`${name}: 对照图尺寸与计划一致`,
      sheet.size.width === plan.sheet.width && sheet.size.height === plan.sheet.height,
      { got: sheet.size, want: { width: plan.sheet.width, height: plan.sheet.height } });
    for (const item of plan.sheet.items) {
      const source = sourceBitmaps.get(item.assetHash);
      const info = compareBodyToSource(sheet,
        { bodyX: item.x, bodyY: item.y, sourceWidth: item.sourceWidth, sourceHeight: item.sourceHeight }, source, item.masks);
      check(`${name}: 对照图里图${item.number} 与原件逐点一致（遮盖处纯白）`, info.mismatches === 0,
        { number: item.number, ...info });
    }
    return { ...summary, sheet: sheet.size };
  }
  check(`${name}: 输出文件数与计划一致`, report.done.files.length === plan.images.length + 2,
    { files: report.done.files });

  const overviewFile = path.join(outDir, plan.files[0].name);
  const overview = bitmapOf(overviewFile);
  check(`${name}: 总览尺寸与计划一致`, overview.size.width === plan.overview.width && overview.size.height === plan.overview.height,
    { got: overview.size, want: { width: plan.overview.width, height: plan.overview.height } });
  const overviewInk = countInk(overview);
  check(`${name}: 总览仍有可读的文字短标签`, overviewInk > 0, overviewInk);

  const perImage = [];
  const bodyBitmaps = new Map();
  for (const image of plan.images) {
    const file = path.join(outDir, plan.files[image.index + 1].name);
    const bitmap = bitmapOf(file);
    bodyBitmaps.set(image.index, bitmap);
    check(`${name}: 图${image.number} 尺寸精确等于计划`,
      bitmap.size.width === image.width && bitmap.size.height === image.height,
      { got: bitmap.size, want: { width: image.width, height: image.height }, mode: image.mode });
    const info = { number: image.number, mode: image.mode, size: bitmap.size,
      bodyX: image.bodyX, bodyY: image.bodyY, masks: image.masks.length };
    if (image.mode === 'withNotes') {
      // 主图区域不许出现需求批注的主色（框/编号/连线），也不能有数字徽章。
      const bodyScan = scanAnnotationAccent(bitmap, image.bodyX, image.bodyY, image.sourceWidth, image.sourceHeight);
      info.bodyScan = bodyScan;
      check(`${name}: 图${image.number} 主图没有批注叠层像素`, bodyScan.samples > 0 && bodyScan.hits === 0, bodyScan);
      // 页头是米白底，图体从 bodyY 开始；遮盖内必须全白，原色一个像素都不许漏。
      for (const mask of image.masks) {
        const x0 = image.bodyX + mask.rect.x, y0 = image.bodyY + mask.rect.y;
        let white = 0, total = 0;
        for (let y = Math.ceil(y0); y < y0 + mask.rect.height; y += 3) {
          for (let x = Math.ceil(x0); x < x0 + mask.rect.width; x += 3) {
            total += 1;
            if (isWhite(pixelAt(bitmap, x, y))) white += 1;
          }
        }
        info.mask = { x0, y0, white, total };
        info.maskCenter = pixelAt(bitmap, Math.round(x0 + mask.rect.width / 2), Math.round(y0 + mask.rect.height / 2));
        // 意见框会半透明叠在遮盖上，边界描边也会扫到；内缩 3px 采样。
        let originalPixel = 0, bright = 0, samples = 0;
        for (let y = Math.ceil(y0) + 3; y < y0 + mask.rect.height - 3; y += 3) {
          for (let x = Math.ceil(x0) + 3; x < x0 + mask.rect.width - 3; x += 3) {
            const pixel = pixelAt(bitmap, x, y);
            const channels = [pixel[0], pixel[1], pixel[2]];
            const max = Math.max(...channels), min = Math.min(...channels);
            samples += 1;
            if ((max >= 200 && min <= 60) || max < 80) originalPixel += 1;
            if (min > 200) bright += 1;
          }
        }
        info.maskClean = { originalPixel, bright, samples };
        check(`${name}: 图${image.number} 遮盖区无原像素`, samples > 0 && originalPixel === 0, info.maskClean);
        check(`${name}: 图${image.number} 遮盖区三通道都到白底`, samples > 0 && bright >= samples * 0.99, { bright, samples });
      }
      // 图体左上角 6,6 处应是原图背景色（没被页头/遮盖污染）。
      const probe = pixelAt(bitmap, image.bodyX + 6, image.bodyY + 6);
      info.probe = probe;
      check(`${name}: 图${image.number} 图体像素仍是原色`, isColor(probe, expect[image.number].bg), probe);
    } else {
      // bodyOnly：整张就是图体，遮盖区不许有原像素，四角仍是原色；也不许有批注主色。
      const bodyScan = scanAnnotationAccent(bitmap, 0, 0, image.width, image.height);
      info.bodyScan = bodyScan;
      check(`${name}: bodyOnly 图${image.number} 主图没有批注叠层像素`, bodyScan.hits === 0, bodyScan);
      const mask = image.masks[0];
      let originalPixel = 0, bright = 0, samples = 0;
      for (let y = mask.rect.y + 6; y < mask.rect.y + mask.rect.height - 6; y += 7) {
        for (let x = mask.rect.x + 6; x < mask.rect.x + mask.rect.width - 6; x += 7) {
          const pixel = pixelAt(bitmap, x, y);
          const channels = [pixel[0], pixel[1], pixel[2]];
          const max = Math.max(...channels), min = Math.min(...channels);
          samples += 1;
          if ((max >= 200 && min <= 60) || max < 80) originalPixel += 1;
          if (min > 200) bright += 1;
        }
      }
      info.mask = { originalPixel, bright, samples };
      check(`${name}: bodyOnly 图${image.number} 遮盖区无原像素`, samples > 0 && originalPixel === 0, info.mask);
      check(`${name}: bodyOnly 图${image.number} 遮盖区到白底`, samples > 0 && bright >= samples * 0.99, { bright, samples });
      check(`${name}: bodyOnly 图${image.number} 没有页头（左上角就是图体）`, isColor(pixelAt(bitmap, 2, 2), expect[image.number].bg), pixelAt(bitmap, 2, 2));
    }
    perImage.push(info);
  }

  // 安全合成逐点对照：除了遮盖处应为纯白，每个采样点都要和原件一模一样。
  // 多画的框、编号、连线、半透明填充都会在这里露馅，不靠“没扫到已知颜色”反推。
  for (const image of plan.images) {
    const bitmap = bodyBitmaps.get(image.index);
    const source = sourceBitmaps.get(image.assetHash);
    const diff = compareBodyToSource(bitmap, image, source, image.masks);
    check(`${name}: 图${image.number} 主图与安全合成逐点一致（遮盖处纯白）`, diff.mismatches === 0,
      { number: image.number, ...diff });
  }

  const text = fs.readFileSync(textFile, 'utf8');
  check(`${name}: 说明.txt 含意见全文`, text.includes(expect.note), text.slice(0, 120));
  check(`${name}: 说明.txt 不含临时目录路径`, !text.includes(dir) && !text.includes(os.tmpdir()), '');
  check(`${name}: 说明.txt 标了图号与意见号`, text.includes('图1') && text.includes('意见1'), '');
  return { ...summary, overview: overview.size, perImage, text: text.slice(0, 400) };
}

function groupDocument({ id, title, images, notes, comment, version, relations }) {
  const document = { schemaVersion: version || 1, id, title, revision: 1, images, notes,
    comment: comment || '', view: { panX: 0, panY: 0, zoom: 1 } };
  if (Array.isArray(relations)) document.relations = relations;
  return document;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-export-fixtures-'));
  // 总览是专用关系图：允许框线/文字短标签，但不应再有任何数字徽章绘制。
  const rendererSource = fs.readFileSync(path.join(__dirname, '../renderer/workspace.js'), 'utf8');
  const overviewStart = rendererSource.indexOf('async function renderOverview');
  const sheetStart = rendererSource.indexOf('async function renderSheet');
  const overviewFn = overviewStart > 0 && sheetStart > overviewStart ? rendererSource.slice(overviewStart, sheetStart) : '';
  check('总览绘制里没有数字徽章/意见号调用', overviewFn.length > 0 && !/badge\(|noteNumber/.test(overviewFn),
    overviewFn.slice(0, 80));
  // —— 用例 1：两张中等图，不同摆位/缩放，跨图意见 + 遮盖，走 withNotes 版式 ——
  const a1 = makePng(500, 300, (x, y) => (x >= 100 && x < 200 && y >= 80 && y < 160 ? COLOR_RED : COLOR_BG_A));
  const b1 = makePng(400, 260, (x, y) => (x >= 40 && x < 120 && y >= 30 && y < 100 ? COLOR_GREEN : COLOR_BG_B));
  const hashA1 = sha256(a1), hashB1 = sha256(b1);
  writePng(path.join(dir, 'a1.png'), a1);
  writePng(path.join(dir, 'b1.png'), b1);
  const doc1 = groupDocument({
    id: 'group_verify_one', title: '验证组一',
    images: [
      { id: 'image_one', assetHash: hashA1, name: '图1', width: 500, height: 300,
        frame: { x: 0, y: 0, width: 250, height: 150 },
        masks: [{ id: 'mask_one', rect: { x: 100, y: 80, width: 100, height: 80 }, color: '#ffffff' }] },
      { id: 'image_two', assetHash: hashB1, name: '图2', width: 400, height: 260,
        frame: { x: 320, y: 40, width: 200, height: 130 }, masks: [] }
    ],
    notes: [
      { id: 'note_cross', text: '颜色照这个', linked: true, targets: [
        { id: 'target_a', imageId: 'image_one', kind: 'region', rect: { x: 100, y: 80, width: 100, height: 80 } },
        { id: 'target_b', imageId: 'image_two', kind: 'point', point: { x: 60, y: 50 } }
      ] },
      { id: 'note_second', text: '这里再收一点', linked: false, targets: [
        { id: 'target_c', imageId: 'image_two', kind: 'region', rect: { x: 200, y: 120, width: 80, height: 60 } }
      ] }
    ],
    comment: '整组一起看，颜色以第一张为准。'
  });
  const case1 = await runCase({ name: 'withNotes', document: doc1,
    assets: { [hashA1]: a1, [hashB1]: b1 },
    expect: { note: '颜色照这个', 1: { bg: COLOR_BG_A }, 2: { bg: COLOR_BG_B } } });
  // 同一份数据走「复制对照」：拼好的图里截图本体必须干净，遮盖保留。
  const caseContact = await runCase({ name: 'contact', document: doc1, kind: 'contact',
    assets: { [hashA1]: a1, [hashB1]: b1 },
    expect: { note: '颜色照这个', 1: { bg: COLOR_BG_A }, 2: { bg: COLOR_BG_B } } });

  // —— 用例 2：6000×6000（36M 像素）加页头即越界 → 必须整张转 bodyOnly，遮盖仍烧进新 PNG ——
  const big = makePng(6000, 6000, (x, y) => (x >= 2400 && x < 2700 && y >= 2400 && y < 2700 ? COLOR_RED : COLOR_BG_A));
  const hashBig = sha256(big);
  writePng(path.join(dir, 'big.png'), big);
  const doc2 = groupDocument({
    id: 'group_verify_two', title: '验证组二',
    images: [{ id: 'image_big', assetHash: hashBig, name: '长图', width: 6000, height: 6000,
      frame: { x: 0, y: 0, width: 600, height: 600 },
      masks: [{ id: 'mask_big', rect: { x: 2400, y: 2400, width: 300, height: 300 }, color: '#ffffff' }] }],
    notes: [{ id: 'note_big', text: '这一块遮掉', linked: false, targets: [
      { id: 'target_big', imageId: 'image_big', kind: 'region', rect: { x: 2400, y: 2400, width: 300, height: 300 } }
    ] }],
    comment: ''
  });
  let case2;
  try {
    case2 = await runCase({ name: 'bodyOnly', document: doc2, assets: { [hashBig]: big },
      expect: { note: '这一块遮掉', 1: { bg: COLOR_BG_A } } });
  } catch (error) {
    case2 = { name: 'bodyOnly', failed: true, error: String(error?.stack || error) };
    check('bodyOnly: 用例跑通', false, String(error?.message || error));
  }

  // —— 用例 3：两个空框 + 一条有字关系（第 2 版）—— 不逼每框填字，主图仍干净 ——
  const c1 = makePng(300, 200, () => COLOR_BG_A);
  const c2 = makePng(260, 180, () => COLOR_BG_B);
  const hashC1 = sha256(c1), hashC2 = sha256(c2);
  writePng(path.join(dir, 'c1.png'), c1);
  writePng(path.join(dir, 'c2.png'), c2);
  const doc3 = groupDocument({
    id: 'group_verify_three', title: '验证组三', version: 2,
    images: [
      { id: 'image_left', assetHash: hashC1, name: '图1', width: 300, height: 200,
        frame: { x: 0, y: 0, width: 150, height: 100 }, masks: [] },
      { id: 'image_right', assetHash: hashC2, name: '图2', width: 260, height: 180,
        frame: { x: 200, y: 20, width: 130, height: 90 }, masks: [] }
    ],
    notes: [
      { id: 'note_left', text: '', linked: false, targets: [
        { id: 'target_left', imageId: 'image_left', kind: 'region', rect: { x: 20, y: 30, width: 80, height: 60 } }] },
      { id: 'note_right', text: '', linked: false, targets: [
        { id: 'target_right', imageId: 'image_right', kind: 'point', point: { x: 120, y: 80 } }] }
    ],
    relations: [{ id: 'rel_same', text: '这两处颜色一致', ends: [
      { noteId: 'note_left', targetId: 'target_left' },
      { noteId: 'note_right', targetId: 'target_right' }] }],
    comment: ''
  });
  let case3;
  try {
    case3 = await runCase({ name: 'relation', document: doc3, assets: { [hashC1]: c1, [hashC2]: c2 },
      expect: { note: '这两处颜色一致', 1: { bg: COLOR_BG_A }, 2: { bg: COLOR_BG_B } } });
  } catch (error) {
    case3 = { name: 'relation', failed: true, error: String(error?.stack || error) };
    check('relation: 用例跑通', false, String(error?.message || error));
  }

  console.info(JSON.stringify({ ok: failures.length === 0, failures, results, case1, caseContact, case2, case3 }, null, 2));
  app.exit(failures.length === 0 ? 0 : 1);
}

// 独立临时 profile：在 app ready 之前把 userData/sessionData 指到本次临时目录，
// 不读也不写真实 APPDATA，也不加载生产 main/index.cjs。
const e2eProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-export-profile-'));
const e2eSession = path.join(e2eProfile, 'session');
fs.mkdirSync(e2eSession, { recursive: true });
app.setPath('userData', e2eProfile);
app.setPath('sessionData', e2eSession);

app.disableHardwareAcceleration();
// 两个用例之间会关窗；默认的 window-all-closed 会 app.quit() 打断下一个加载。
app.on('window-all-closed', () => {});
app.whenReady().then(main).catch(error => {
  console.error(JSON.stringify({ ok: false, error: String(error?.stack || error) }));
  app.exit(2);
});
