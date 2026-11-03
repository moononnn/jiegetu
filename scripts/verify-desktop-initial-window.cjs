'use strict';
// 跨屏隐藏窗的一次性集成验证（只读生产代码）：验证「初始只按 anchor.bounds 单屏大小建窗，
// 再用原生 --fit-desktop-window 撑到整组屏 union」之后，Chromium 的视口 / 合成面到底是不是 union，
// 以及 HWND 是否被回弹。对照组：初始就按 union 的 DIP 尺寸建窗；另附「先 load 再 fit」顺序对照。
//
// 边界：不采真实屏幕像素、不显示窗口（全程 show:false）、不控鼠标键盘、不改生产源码、不关任何在用软件。
// 运行：node scripts/verify-desktop-initial-window.cjs
const path = require('node:path');
const root = path.join(__dirname, '..');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const electronPath = require(path.join(root, 'node_modules', 'electron'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electronPath, [__filename, ...process.argv.slice(2)],
    { stdio: 'inherit', env, windowsHide: true, timeout: 180000, cwd: root });
  if (result.error) { console.error(`INITIAL_WINDOW_SPAWN_FAILED ${result.error.message}`); process.exit(1); }
  process.exit(result.status ?? 1);
}

const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { app, BrowserWindow, screen } = require('electron');
const { queryMonitorBounds, handleToDecimal, fitDesktopWindow, checkDesktopWindow } = require(path.join(root, 'main', 'win-capture.cjs'));

app.setPath('userData', path.join(os.tmpdir(), 'jgc-desktop-initial-window'));
app.on('window-all-closed', () => {});
const timer = setTimeout(() => { console.error('INITIAL_WINDOW_TIMEOUT'); app.exit(1); }, 170000);

const lines = [];
const say = text => { lines.push(text); console.log(text); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const rect = value => ({ x: value.x, y: value.y, width: value.width, height: value.height });
const sameRect = (a, b) => ['x', 'y', 'width', 'height'].every(key => a[key] === b[key]);
const json = value => JSON.stringify(value);

// 纯合成页：色带 + 网格 + 四角标记；不加载生产 renderer，也不解码任何真实像素。
const PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent([
  '<!doctype html><meta charset="utf-8"><title>initial-window-probe</title><style>',
  'html,body{margin:0;height:100%;overflow:hidden;background:#101820}',
  'body{background-image:repeating-linear-gradient(90deg,rgba(0,0,0,.45) 0 1px,transparent 1px 64px),',
  'repeating-linear-gradient(0deg,rgba(0,0,0,.45) 0 1px,transparent 1px 64px),',
  'repeating-linear-gradient(90deg,#ff3b30 0 25%,#34c759 25% 50%,#32ade6 50% 75%,#ffcc00 75% 100%)}',
  '#t{position:fixed;inset:0;border:8px solid #ffffff80}',
  '</style><div id="t"></div>'
].join(''));

const PROBE = `(() => ({
  innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio,
  screenWidth: screen.width, screenHeight: screen.height,
  visualWidth: visualViewport ? visualViewport.width : null,
  visualHeight: visualViewport ? visualViewport.height : null,
  zoom: window.devicePixelRatio
}))()`;

// 生产 openDesktopWindow 的选项原样复制（transparent/alwaysOnTop/skipTaskbar 等；生产没有设
// focusable/hasShadow，这里也不加）。preload 省掉：这里加载的是 data: 合成页，不需要 selection 桥。
function createWindow(options) {
  return new BrowserWindow({
    ...options,
    show: false, frame: false, resizable: false, movable: false,
    roundedCorners: false, thickFrame: false, enableLargerThanScreen: true,
    alwaysOnTop: true, skipTaskbar: true, transparent: true, backgroundColor: '#00000000',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }
  });
}

function measurements(win) {
  return { bounds: rect(win.getBounds()), content: rect(win.getContentBounds()), visible: win.isVisible() };
}

// 生产同款「建窗提示」：按 anchor 缩放换算，并夹到 anchor.bounds（这就是单屏初始尺寸的来源）。
function productionHint(union, anchor) {
  return { x: anchor.bounds.x, y: anchor.bounds.y,
    width: Math.max(1, Math.min(Math.round(union.width / anchor.scaleFactor), anchor.bounds.width)),
    height: Math.max(1, Math.min(Math.round(union.height / anchor.scaleFactor), anchor.bounds.height)) };
}

async function inspect({ label, union, anchor, initial, order }) {
  const win = createWindow({ ...initial.rect });
  const handle = handleToDecimal(win.getNativeWindowHandle());
  const pid = process.pid;
  const nonce = randomBytes(16).toString('hex');
  const row = { label, anchorScaleFactor: anchor.scaleFactor, anchorBounds: rect(anchor.bounds), order,
    initialRect: rect(initial.rect), steps: {} };
  try {
    say(`## ${label}`);
    say(`  anchor=${json(rect(anchor.bounds))}@${anchor.scaleFactor}  初始建窗=${json(rect(initial.rect))}  union=${json(union)}`);
    row.steps.afterCreate = measurements(win);
    say(`  create 回读 bounds=${json(row.steps.afterCreate.bounds)} content=${json(row.steps.afterCreate.content)} visible=${win.isVisible()}`);

    if (order === 'fit-before-load') {
      win.setTitle(nonce);
      const fitted = await fitDesktopWindow(handle, pid, nonce, union);
      row.steps.afterFit = { readback: rect(fitted), ...measurements(win) };
      say(`  fit 回读=${json(rect(fitted))}  getBounds=${json(row.steps.afterFit.bounds)}  getContentBounds=${json(row.steps.afterFit.content)}`);
      await win.loadURL(PAGE);
    } else {
      await win.loadURL(PAGE);
      win.setTitle(nonce);
      const fitted = await fitDesktopWindow(handle, pid, nonce, union);
      row.steps.afterFit = { readback: rect(fitted), ...measurements(win) };
      say(`  load 后 fit 回读=${json(rect(fitted))}  getBounds=${json(row.steps.afterFit.bounds)}  getContentBounds=${json(row.steps.afterFit.content)}`);
    }

    await delay(350);
    const probe = await win.webContents.executeJavaScript(PROBE);
    const afterLoad = measurements(win);
    const checkNonce = randomBytes(16).toString('hex');
    win.setTitle(checkNonce);
    const checkReadback = await checkDesktopWindow(handle, pid, checkNonce, union);
    const image = await win.webContents.capturePage();
    const size = image.getSize();
    const surfacePixels = size.width * size.height;
    const unionPixels = union.width * union.height;
    row.steps.afterLoad = { ...afterLoad, viewport: probe, checkReadback: rect(checkReadback),
      surface: { width: size.width, height: size.height, empty: image.isEmpty() } };
    row.steps.probeViewport = probe;

    const coveredWidth = probe.innerWidth * probe.devicePixelRatio;
    const coveredHeight = probe.innerHeight * probe.devicePixelRatio;
    row.verdict = {
      hwndEqualUnion: sameRect(rect(checkReadback), union),
      boundsEqualUnionDIP: afterLoad.bounds.width * probe.devicePixelRatio,
      viewportPhysicalWidth: coveredWidth, viewportPhysicalHeight: coveredHeight,
      viewportCoversWidth: coveredWidth === union.width, viewportCoversHeight: coveredHeight === union.height,
      surfaceCoversUnion: surfacePixels === unionPixels,
      surfaceIsAnchorSized: surfacePixels === Math.round(anchor.bounds.width * anchor.scaleFactor) *
        Math.round(anchor.bounds.height * anchor.scaleFactor)
    };
    say(`  getBounds=${json(afterLoad.bounds)}  getContentBounds=${json(afterLoad.content)}  visible=${afterLoad.visible}`);
    say(`  视口 innerWidth/Height=${probe.innerWidth}x${probe.innerHeight}  dpr=${probe.devicePixelRatio}  ` +
      `→ 物理覆盖 ${coveredWidth}x${coveredHeight}（union ${union.width}x${union.height}）`);
    say(`  outer=${probe.outerWidth}x${probe.outerHeight}  screen=${probe.screenWidth}x${probe.screenHeight}  ` +
      `visualViewport=${probe.visualWidth}x${probe.visualHeight}`);
    say(`  load 后纯读 HWND=${json(rect(checkReadback))}  合成面=${size.width}x${size.height}${image.isEmpty() ? '（空）' : ''}`);
    say(`  判定：HWND=${row.verdict.hwndEqualUnion ? 'OK' : 'FAIL'}  ` +
      `视口=${row.verdict.viewportCoversWidth && row.verdict.viewportCoversHeight ? 'OK' : 'FAIL'}  ` +
      `合成面=${row.verdict.surfaceCoversUnion ? 'OK' : 'FAIL'}`);

    await delay(900);
    const lateProbe = await win.webContents.executeJavaScript(PROBE);
    row.steps.afterSettle = { ...measurements(win), viewport: lateProbe };
    say(`  +900ms 复核：bounds=${json(row.steps.afterSettle.bounds)} 视口=${lateProbe.innerWidth}x${lateProbe.innerHeight}` +
      `@${lateProbe.devicePixelRatio}  visible=${row.steps.afterSettle.visible}`);
    return row;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

// 单屏兜底：真 union 需要两块屏，缺屏时用「把窗口撑到屏幕外 1.5 倍宽」的合成矩形，单独看
// Chromium 的视口/合成面会不会跟着一个大于初始尺寸、也大于任何一屏的隐藏窗走。原生 fit 只接受
// 真实 union，这里用 Electron 的 setBounds（同一条 SetWindowPos 路径）当代理，标注清楚。
async function inspectOversize({ label, union, screenPhysical, anchor, direct = false }) {
  const dip = { x: 0, y: 0, width: Math.round(union.width / anchor.scaleFactor), height: Math.round(union.height / anchor.scaleFactor) };
  const start = direct ? dip
    : { x: 0, y: 0, width: Math.min(dip.width, anchor.bounds.width), height: Math.min(dip.height, anchor.bounds.height) };
  const win = createWindow(start);
  try {
    say(`## ${label}`);
    say(`  合成矩形 ${json(union)}（真屏 ${json(screenPhysical)}）DIP=${json(dip)}@${anchor.scaleFactor}`);
    const created = measurements(win);
    say(`  create 回读 bounds=${json(created.bounds)}`);
    if (!direct) win.setBounds(dip);
    await delay(250);
    const applied = measurements(win);
    if (!direct) say(`  setBounds 回读 bounds=${json(applied.bounds)} content=${json(applied.content)}`);
    else say(`  直接按 DIP 建窗后 bounds=${json(applied.bounds)} content=${json(applied.content)}`);
    await win.loadURL(PAGE);
    await delay(350);
    const probe = await win.webContents.executeJavaScript(PROBE);
    const image = await win.webContents.capturePage();
    const size = image.getSize();
    const after = measurements(win);
    say(`  load 后 getBounds=${json(after.bounds)}  getContentBounds=${json(after.content)}  visible=${after.visible}`);
    say(`  视口 ${probe.innerWidth}x${probe.innerHeight}@${probe.devicePixelRatio} → 物理 ` +
      `${probe.innerWidth * probe.devicePixelRatio}x${probe.innerHeight * probe.devicePixelRatio}（合成矩形 ${union.width}x${union.height}）`);
    say(`  合成面 ${size.width}x${size.height}${image.isEmpty() ? '（空）' : ''}  ` +
      `判定：视口${probe.innerWidth * probe.devicePixelRatio === union.width && probe.innerHeight * probe.devicePixelRatio === union.height ? 'OK' : 'FAIL'} ` +
      `合成面${size.width * size.height === union.width * union.height ? 'OK' : 'FAIL'}`);
    await delay(900);
    const late = await win.webContents.executeJavaScript(PROBE);
    say(`  +900ms 复核：bounds=${json(win.getBounds())} 视口=${late.innerWidth}x${late.innerHeight}@${late.devicePixelRatio}`);
    return { label, probe, late, bounds: after.bounds, content: after.content, surface: { width: size.width, height: size.height } };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

app.whenReady().then(async () => {
  say('');
  say('## 跨屏隐藏窗：初始单屏尺寸 → 原生 fit → Chromium 视口/合成面实测');
  say(`Electron ${process.versions.electron} / Chrome ${process.versions.chrome} / ${process.platform} / ` +
    `${process.arch} / node ${process.versions.node}`);

  const displays = [];
  for (const display of screen.getAllDisplays()) {
    const physical = await queryMonitorBounds(screen.dipToScreenRect(null, display.bounds), { scaleFactor: display.scaleFactor });
    displays.push({ id: display.id, scaleFactor: display.scaleFactor, bounds: rect(display.bounds),
      workArea: rect(display.workArea), physical });
    say(`  display ${display.id} scaleFactor=${display.scaleFactor} dip=${json(rect(display.bounds))} physical=${json(physical)}`);
  }
  if (displays.length < 2) {
    // 缺第二块屏时不能伪造 native union（helper 会按真实监视器 union 拒绝），改用 setBounds 代理试验。
    const only = displays[0];
    const synthetic = { x: only.physical.x, y: only.physical.y,
      width: Math.round(only.physical.width * 1.5), height: only.physical.height };
    say('## 本机当前只有一块屏：真 union 无法成立，改跑「撑到屏幕外」代理试验（结论力度有限）');
    const oversize = [];
    oversize.push(await inspectOversize({ label: 'P1 初始单屏 → setBounds 到 1.5 屏宽 → load', union: synthetic,
      screenPhysical: only.physical, anchor: only }));
    oversize.push(await inspectOversize({ label: 'P2 对照：直接按 1.5 屏宽的 DIP 建窗 → load', union: synthetic,
      screenPhysical: only.physical, anchor: only, direct: true }));
    say('');
    say('DETAIL_JSON ' + JSON.stringify({ union: synthetic, displays, singleDisplayFallback: true, oversize }));
    say('');
    say('INITIAL_WINDOW_DONE_SINGLE_DISPLAY');
    clearTimeout(timer);
    app.exit(0);
    return;
  }
  const unionBox = displays.reduce((box, row) => {
    const right = Math.max(box.right, row.physical.x + row.physical.width);
    const bottom = Math.max(box.bottom, row.physical.y + row.physical.height);
    return { x: Math.min(box.x, row.physical.x), y: Math.min(box.y, row.physical.y), right, bottom };
  }, { x: Infinity, y: Infinity, right: -Infinity, bottom: -Infinity });
  const union = { x: unionBox.x, y: unionBox.y, width: unionBox.right - unionBox.x, height: unionBox.bottom - unionBox.y };
  const byId = id => displays.find(row => row.id === id);
  const pointerDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  say(`  union=${json(union)}  ${union.width * union.height} 像素`);
  say(`  指针所在屏（生产 anchor 规则）= ${pointerDisplay.id}@${pointerDisplay.scaleFactor}`);

  const results = [];
  results.push(await inspect({ label: 'A 生产顺序：初始单屏（指针所在屏 anchor）→ fit → load', union,
    anchor: byId(pointerDisplay.id), initial: { rect: productionHint(union, byId(pointerDisplay.id)) }, order: 'fit-before-load' }));

  // anchor 换到另一块屏：同样单屏初始尺寸，但 scaleFactor 不同 —— 单独隔离「anchor 缩放」的影响。
  const other = displays.find(row => row.id !== pointerDisplay.id &&
    row.scaleFactor !== byId(pointerDisplay.id).scaleFactor) ||
    displays.find(row => row.id !== pointerDisplay.id);
  results.push(await inspect({ label: `B 生产顺序：初始单屏（另一块屏 ${other.id} anchor）→ fit → load`, union,
    anchor: other, initial: { rect: productionHint(union, other) }, order: 'fit-before-load' }));

  // 对照：初始就按 union 的 DIP 尺寸建窗（anchor scaleFactor 换算，不夹到单屏），再 fit → load。
  const anchor = byId(pointerDisplay.id);
  const unionDip = { x: anchor.bounds.x, y: anchor.bounds.y,
    width: Math.round(union.width / anchor.scaleFactor), height: Math.round(union.height / anchor.scaleFactor) };
  results.push(await inspect({ label: 'C 对照：初始即 union DIP 尺寸 → fit → load', union,
    anchor, initial: { rect: unionDip }, order: 'fit-before-load' }));

  // 对照：顺序反过来（先 load 再 fit），看视口是不是在 load 时被定形。
  results.push(await inspect({ label: 'D 对照：初始单屏 → load → fit（顺序相反）', union,
    anchor, initial: { rect: productionHint(union, anchor) }, order: 'load-before-fit' }));

  const summarize = row => `${row.label.split(' ')[0]}: HWND=${row.verdict.hwndEqualUnion ? 'OK' : 'FAIL'} ` +
    `视口物理=${row.verdict.viewportPhysicalWidth}x${row.verdict.viewportPhysicalHeight} ` +
    `(${row.verdict.viewportCoversWidth && row.verdict.viewportCoversHeight ? 'OK' : 'FAIL'}) ` +
    `合成面=${row.steps.afterLoad.surface.width}x${row.steps.afterLoad.surface.height} ` +
    `(${row.verdict.surfaceCoversUnion ? 'OK' : 'FAIL'})`;
  say('');
  say('## 汇总');
  for (const row of results) say(`  ${summarize(row)}`);
  say('');
  say('DETAIL_JSON ' + JSON.stringify({ union, displays, results: results.map(row => ({ label: row.label,
    initialRect: row.initialRect, probe: row.steps.probeViewport, verdict: row.verdict,
    afterLoadBounds: row.steps.afterLoad.bounds, afterLoadContent: row.steps.afterLoad.content,
    checkReadback: row.steps.afterLoad.checkReadback, surface: row.steps.afterLoad.surface,
    afterSettleBounds: row.steps.afterSettle.bounds, afterSettleViewport: row.steps.afterSettle.viewport })) }));
  say('');
  say('INITIAL_WINDOW_DONE');
  clearTimeout(timer);
  app.exit(0);
}).catch(error => {
  say(`INITIAL_WINDOW_FAIL ${error && error.message ? error.message : error}`);
  if (error && error.stack) say(error.stack);
  clearTimeout(timer);
  app.exit(1);
});
