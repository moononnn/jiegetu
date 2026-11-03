'use strict';
const { BrowserWindow, ipcMain, nativeImage, globalShortcut, screen, dialog } = require('electron');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { toPixels, outsideMask } = require('../core/coordinates.cjs');
const MAX_PIXELS = 16_000_000;
const MAX_HEIGHT = 30000;

function installScrolling({ getActive, allowed, cancel, onStatus, diagnostics, resolveSelection,
  // 主进程成图窗口的交接入口（会话层注入）：成图成功后先试这个，成功就由普通窗接管；不注入沿用旧同步预览。
  onLongResult = null,
  // 主题（可选）：只给不透明浮条上色；透明遮罩/选区窗不绑。
  theme = null,
  createCapture = region => require(path.join(__dirname, 'win-capture.cjs')).createWinCapture(region, { executable: path.join(__dirname, '..', 'native', 'gdi-capture.exe') }),
  // 本进程自己新建的隐藏窗拟合到真实物理矩形；测试可注入替身。
  // mode=monitor 用于选区/遮罩（必须整块等于监视器），mode=inside 用于浮条子矩形。
  fitWindow = (win, nonce, bounds, mode = 'monitor') => {
    const mod = require(path.join(__dirname, 'win-capture.cjs'));
    const handle = mod.handleToDecimal(win.getNativeWindowHandle());
    return mode === 'inside' ? mod.fitHiddenWindow(handle, process.pid, nonce, bounds)
      : mod.fitSelectionWindow(handle, process.pid, nonce, bounds);
  },
  createCancelWatcher = (onCancel, onError) => require('./scroll-cancel.cjs').watchScrollCancel(onCancel, onError),
  createWheelScroller = (region, onError, foreground = 0) => require('./scroll-wheel.cjs').createScrollWheel(region, { onError, foreground }) }) {
  const isSession = (event, token) => {
    const current = getActive();
    return current && allowed(event) && current.scroll && current.scroll.token === token &&
      ['scroll-starting', 'scrolling', 'scroll-finishing'].includes(current.phase) ? current : undefined;
  };
  const isBar = event => {
    const current = getActive();
    return current?.scroll?.bar && !current.scroll.bar.isDestroyed() &&
      event.sender === current.scroll.bar.webContents && event.senderFrame === current.scroll.bar.webContents.mainFrame ? current : undefined;
  };
  function barCaptureSafe(scroll) {
    const bar = scroll.bar;
    if (!bar || bar.isDestroyed()) return !scroll.protectedBar;
    const b = bar.getBounds(), a = scroll.barArea, r = scroll.barRoi;
    return ['x', 'y', 'width', 'height'].every(key => Number.isInteger(b[key])) && b.width > 0 && b.height > 0 &&
      b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height &&
      (scroll.protectedBar ? bar.isContentProtected() :
        (b.x + b.width <= r.x || b.x >= r.x + r.width || b.y + b.height <= r.y || b.y >= r.y + r.height));
  }
  function omitUnsafeBar(current) {
    const scroll = current.scroll;
    if (barCaptureSafe(scroll)) return;
    const bar = scroll.bar; scroll.bar = undefined;
    if (bar && !bar.isDestroyed()) bar.destroy();
    diagnostics?.record('bar-omitted', { hidden: true, reason: 'invalid', protectedBar: Boolean(scroll.protectedBar), remoteVisibility: 'unobserved' });
    throw new Error(scroll.protectedBar ? '长截图浮条排除状态或位置异常，已停止采集，请重新框选' : '长截图提示位置异常，已停止采集，请重新框选');
  }
  function physicalBarRect(env, placement) {
    const canonical = env.nativeBounds, bounds = env.display.bounds, scale = env.display.scaleFactor;
    // 真实工作区优先（任务栏/保留区由系统给出）；内部合成无此值时退回监视器。
    const work = env.nativeWorkArea || canonical;
    if (!canonical || !work || !Number.isFinite(scale) || scale <= 0) return undefined;
    if (work.x < canonical.x || work.y < canonical.y ||
        work.x + work.width > canonical.x + canonical.width || work.y + work.height > canonical.y + canonical.height) return undefined;
    const width = Math.round(placement.width * scale), height = Math.round(placement.height * scale);
    if (!(width > 0 && height > 0 && width <= work.width && height <= work.height)) return undefined;
    const x = canonical.x + Math.round((placement.x - bounds.x) * scale);
    const y = canonical.y + Math.round((placement.y - bounds.y) * scale);
    return { x: Math.min(Math.max(x, work.x), work.x + work.width - width),
      y: Math.min(Math.max(y, work.y), work.y + work.height - height), width, height };
  }
  function cleanup(current) {
    const scroll = current.scroll;
    if (!scroll) return;
    diagnostics?.record('scroll-cleanup', { phase: current.phase, barRaises: scroll.barRaises ?? 0 });
    clearTimeout(scroll.timer);
    clearInterval(scroll.barTimer);
    scroll.capture?.stop();
    scroll.cancelWatcher?.stop();
    scroll.wheelScroller?.stop();
    if (scroll.escapeRegistered) globalShortcut.unregister('Escape');
    if (scroll.cancelRegistered) globalShortcut.unregister('CommandOrControl+Alt+Escape');
    if (current.win && !current.win.isDestroyed()) current.win.webContents.send('shot:scroll-abort', scroll.token);
    current.scroll = undefined;
    if (scroll.bar && !scroll.bar.isDestroyed()) scroll.bar.destroy();
    if (scroll.mask && !scroll.mask.isDestroyed()) scroll.mask.destroy();
  }
  function fail(current, message, reason = 'failed') {
    if (getActive() !== current) return;
    diagnostics?.record('scroll-failure', { phase: current.phase, reason, errorMessage: message });
    // 失败不重新盖回全屏冻结图；统一销毁选区、浮条并结束事务。
    cancel(reason);
    onStatus({ message: `${message} 已收回截图，按 F1 重新框选。`, error: true });
  }
  function finish() {
    const current = getActive();
    if (!current?.scroll || current.phase !== 'scrolling') return false;
    current.phase = 'scroll-finishing';
    current.scroll.wheelScroller?.stop(); current.scroll.wheelScroller = undefined;
    // Stop is asynchronous: one renderer request may already be in IPC but not yet handled here.
    current.scroll.nativeTailAllowed = !current.scroll.nativePending;
    current.scroll.status = { ...current.scroll.status, message: '正在合成长图…', canFinish: false };
    current.scroll.bar?.webContents.send('scroll-bar:status', current.scroll.status);
    current.win.webContents.send('shot:scroll-stop', current.scroll.token);
    onStatus({ message: '正在合成长图…请稍候。' });
    return true;
  }
  ipcMain.handle('shot:scroll-begin', async (event, rect) => {
    const current = getActive();
    if (!allowed(event) || current.phase !== 'selecting') throw new Error('当前不能接长图');
    try { diagnostics?.startAutomatic?.(); } catch { /* 后台记录不可用不阻断正常截图。 */ }
    let pixels, env, rejectedContent = false;
    try {
      if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) throw new Error('无效选区');
      // 手动固定栏入口已撤除；旧调用方带来的正文范围参数必须显式拒绝，不能静默按自动识别继续。
      if (rect.content !== undefined) { rejectedContent = true; throw new Error('长截图已改为自动识别，不再接收手动正文范围'); }
      if (current.mode === 'desktop') {
        // 跨屏合成图是一张静态快照，不是一扇可滚动的窗：只有恰好落在一块冻结真实屏内的选区才允许继续，
        // 归属与局部像素全由主进程算，绝不自报 owner，也不误落回 union 基准。
        const resolved = typeof resolveSelection === 'function' ? await resolveSelection(current, rect) : undefined;
        // resolver 会重读页面视口：等回包期间取消/重截就不能再造浮条、遮罩或开启采集。
        if (getActive() !== current || current.phase !== 'selecting') throw new Error('选区会话已失效，请重新框选');
        if (!resolved) throw new Error('选区跨屏或包含屏幕空隙，仅支持普通截图');
        ({ pixels, env } = resolved);
      } else {
        // 选区局部坐标的唯一基准是页面实际视口（ready 时由主进程读到），不是窗口回读的 display.bounds。
        const basis = current.selectionBounds;
        const latest = screen.getAllDisplays().find(item => item.id === current.display.id);
        if (!latest || latest.scaleFactor !== current.display.scaleFactor ||
            ['x', 'y', 'width', 'height'].some(key => latest.bounds[key] !== current.display.bounds[key] ||
              latest.workArea[key] !== current.display.workArea[key])) throw new Error('显示器配置发生变化，请重新框选');
        if (!basis) throw new Error('选区视口基准缺失，请重新框选');
        pixels = toPixels(rect, basis, current.image.getSize());
        // 单屏环境：旧语义原样冻结到 env，后续一律读 env，不再回头拿会话字段。
        env = { display: current.display, frame: current.image.getSize(), nativeBounds: current.nativeBounds,
          nativeHint: current.nativeHint, nativeWorkArea: current.nativeWorkArea, nativeWorkHint: current.nativeWorkHint };
      }
      if (pixels.width < 48 || pixels.height < 96 || pixels.width * pixels.height > MAX_PIXELS) throw new Error('长截图选区至少 48 × 96 像素，且不能超过 1600 万像素');
    } catch (error) {
      diagnostics?.record('scroll-failure', { phase: current.phase, reason: rejectedContent ? 'manual-content' : 'invalid', errorName: error.name, errorMessage: error.message });
      throw error;
    }
    diagnostics?.record('scroll-request', { phase: current.phase, displayId: env.display.id, width: rect?.width, height: rect?.height,
      frameWidth: env.frame.width, frameHeight: env.frame.height, scaleFactor: env.display.scaleFactor });
    const area = env.display.workArea, frame = env.frame, bounds = env.display.bounds;
    // 提示区（barRoi）从已确认像素反推回全局 DIP：四边向外取整成保守包络，保证浮条永远压不进真正采到的像素。
    // 像素→DIP 只能用该屏的 DPI 比例：physicalBarRect 的定义是 canonical + (DIP - bounds.origin) * scale，
    // 只有 pixels / scale + bounds.origin 才是它的逆；frame/basis 得出的是 CSS 比例，不是 DIP 比例。
    const scale = env.display.scaleFactor;
    const left = bounds.x + Math.floor(pixels.x / scale), top = bounds.y + Math.floor(pixels.y / scale);
    const right = bounds.x + Math.ceil((pixels.x + pixels.width) / scale);
    const bottom = bounds.y + Math.ceil((pixels.y + pixels.height) / scale);
    const roi = { x: left, y: top, width: right - left, height: bottom - top };
    // 优先侧边长图预览；空间不足才回退宽条/短条，所有候选仍严格留在选区外。
    let placement;
    for (const size of [{ width: 240, height: 520 }, { width: 240, height: 400 }, { width: 200, height: 320 },
      { width: 800, height: 400 }, { width: 640, height: 320 }, { width: 440, height: 280 },
      { width: 440, height: 180 }, { width: 240, height: 180 },
      { width: 440, height: 96 }, { width: 240, height: 104 }]) {
      const { width, height } = size;
      const x = Math.max(area.x, Math.min(area.x + area.width - width, Math.round(roi.x)));
      const y = Math.max(area.y, Math.min(area.y + area.height - height, Math.round(roi.y)));
      const side = [{ x: Math.ceil(roi.x + roi.width + 10), y }, { x: Math.floor(roi.x - width - 10), y }];
      const vertical = [{ x, y: Math.ceil(roi.y + roi.height + 10) }, { x, y: Math.floor(roi.y - height - 10) }];
      const position = (width <= 240 && height >= 320 ? [...side, ...vertical] : [...vertical, ...side]).find(p => p.x >= area.x && p.y >= area.y && p.x + width <= area.x + area.width && p.y + height <= area.y + area.height &&
        (p.x + width <= roi.x || p.x >= roi.x + roi.width || p.y + height <= roi.y || p.y >= roi.y + roi.height));
      if (position) { placement = { ...position, width, height }; break; }
    }
    let protectedBar = false;
    if (!placement) {
      if (area.width < 240 || area.height < 104) throw new Error('工作区不足以显示浮条，请扩大可用工作区后重试');
      const width = Math.min(800, area.width), height = Math.min(400, area.height);
      placement = { x: Math.floor(area.x + area.width - width), y: Math.ceil(area.y), width, height };
      protectedBar = true;
    }
    current.longImage = undefined; current.longToken = undefined;
    current.phase = 'scroll-starting';
    const scroll = { token: randomUUID(), pixels, rect, env, noBar: !placement, protectedBar, status: { height: pixels.height, added: 0, message: '正在准备屏幕流，请稍候…', canFinish: false } };
    current.scroll = scroll;
    try {
      try { scroll.escapeRegistered = globalShortcut.register('Escape', () => {
        if (getActive() === current && current.scroll === scroll) finish();
      }); } catch { scroll.escapeRegistered = false; }
      try { scroll.cancelRegistered = globalShortcut.register('CommandOrControl+Alt+Escape', () => {
        if (getActive() !== current || current.scroll !== scroll) return;
        cancel('cancelled'); onStatus({ message: '已取消长截图，未保存或复制。' });
      }); } catch { scroll.cancelRegistered = false; }
      if(scroll.noBar || scroll.protectedBar){
        if(!scroll.escapeRegistered||!scroll.cancelRegistered){
          cleanup(current);current.phase='selecting';
          throw new Error('全屏长截图快捷键未能注册，可能被其他程序占用；已保留选框，请释放 Esc 和 Ctrl+Alt+Esc 后重试');
        }
        diagnostics?.record('bar-omitted',{hidden:true,reason:'no-space',escapeRegistered:true,cancelRegistered:true,noBar:true});
      }
      scroll.barArea = area; scroll.barRoi = roi;
      const preparationTimeout = () => {
        if (current.scroll === scroll) fail(current, scroll.mask && !scroll.maskPrepared ? '采集范围提示准备超时。' : '屏幕流准备超时。', 'timeout');
      };
      scroll.timer = setTimeout(preparationTimeout, 15000);
      if (placement) {
        try {
          scroll.bar = new BrowserWindow({ ...placement, frame: false, resizable: false, movable: false,
            thickFrame: false, hasShadow: false, roundedCorners: false, show: false,
            alwaysOnTop: true, skipTaskbar: true, focusable: false, backgroundColor: '#f7faf6',
            webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false,
              preload: path.join(__dirname, 'scroll-bar-preload.cjs') } });
          scroll.bar.setBounds(placement);
          // 浮条是不透明 UI 窗：按当前主题上色并跟随系统变化。
          theme?.bind?.(scroll.bar);
          // 操作窗始终接受点击，不依赖透传鼠标移动再异步恢复命中。
          scroll.bar.setIgnoreMouseEvents(false);
          // Above other always-on-top app windows: a foreground app must not swallow the bar clicks.
          scroll.bar.setAlwaysOnTop(true, 'screen-saver');
          scroll.bar.setContentProtection(scroll.protectedBar);
          // getter是设置状态护栏；底图像素是否真被恢复，另由本机原生取屏集成验证。
          if (scroll.protectedBar && !scroll.bar.isContentProtected()) throw new Error('窗口排除未开启');
        } catch (error) {
          if (!scroll.protectedBar) throw error;
          const failedBar = scroll.bar; scroll.bar = undefined;
          if (failedBar && !failedBar.isDestroyed()) failedBar.destroy();
          clearTimeout(scroll.timer); scroll.timer = undefined;
          let answer;
          try { answer = await dialog.showMessageBox(current.win, { type:'warning', title:'浮条排除不可用',
            message:'无法安全显示浮条，要改用无浮条模式吗？',
            detail:'无浮条模式不显示进度。Esc（全局）完成，Ctrl+Alt+Esc 取消；采集中避免菜单或弹窗。',
            buttons:['无浮条开始','返回框选'], defaultId:1, cancelId:1, noLink:true }); }
          catch { answer = { response:1 }; }
          if (getActive() !== current || current.scroll !== scroll) return { started:false };
          if (answer.response !== 0) {
            cleanup(current); current.phase = 'selecting';
            throw new Error('长截图浮条排除不可用，已保留选框，请缩小选区或重试');
          }
          scroll.protectedBar = false; scroll.noBar = true;
          scroll.timer = setTimeout(preparationTimeout, 15000);
        }
        if (scroll.bar) {
        if (scroll.protectedBar) {
          const bar = scroll.bar;
          bar.on('closed', () => { if (current.scroll === scroll && scroll.bar === bar) fail(current, '长截图浮条异常，已停止。'); });
          bar.on('hide', () => {
            if (current.scroll === scroll && scroll.bar === bar && ['scrolling', 'scroll-finishing'].includes(current.phase)) fail(current, '长截图浮条已隐藏，已停止。');
          });
        }
        scroll.bar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        scroll.bar.webContents.on('will-navigate', e => e.preventDefault());
        scroll.bar.webContents.on('render-process-gone', () => { if (current.scroll === scroll && scroll.bar) fail(current, '长截图浮条异常。'); });
        // 浮条也只操作自己新建的隐藏窗：先按真实物理矩形拟合，避免 DIP 取整让它多占 1 DIP 而被安全护栏拒绝。
        if (env.nativeBounds) {
          const barRect = physicalBarRect(env, placement);
          if (barRect) {
            const barNonce = randomUUID().replace(/-/g, '');
            scroll.bar.setTitle(barNonce);
            await fitWindow(scroll.bar, barNonce, barRect, 'inside');
            if (getActive() !== current || current.scroll !== scroll || !scroll.bar || scroll.bar.isDestroyed()) return { started: false };
          }
        }
        await scroll.bar.loadFile(path.join(__dirname, '..', 'renderer', 'scroll-bar.html'));
        if (getActive() !== current || current.scroll !== scroll) return { started: false };
        omitUnsafeBar(current);
        }
      }
      // 这里只用 outsideMask 决定「要不要建提示层」；色块由提示页按它自己的视口生成，
      // 主进程只交已确认的物理帧与选区像素，不再替页面做 DIP 投影。
      // 尺子只用本屏帧（owner 本地），不与 union 基准的尺寸混用。
      const regions = outsideMask(pixels, frame, frame);
      if (regions.length) {
        scroll.mask = new BrowserWindow({ ...env.display.bounds, frame: false, transparent: true,
          backgroundColor: '#00000000', hasShadow: false, roundedCorners: false, thickFrame: false,
          enableLargerThanScreen: true, resizable: false, movable: false, show: false,
          alwaysOnTop: true, skipTaskbar: true, focusable: false, paintWhenInitiallyHidden: true,
          webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
        const painted = new Promise(resolve => {
          scroll.mask.once('ready-to-show', () => resolve(true));
          scroll.mask.once('closed', () => resolve(false));
        });
        scroll.mask.setBounds(env.display.bounds);
        scroll.mask.setIgnoreMouseEvents(true);
        // Same raised level as the bar: handing focus back to the page must not let a
        // topmost app window paint over the hint. Input still passes through.
        scroll.mask.setAlwaysOnTop(true, 'screen-saver');
        scroll.mask.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        scroll.mask.webContents.on('will-navigate', e => e.preventDefault());
        scroll.mask.webContents.on('render-process-gone', () => { if (current.scroll === scroll) fail(current, '采集范围提示异常，已停止。'); });
        scroll.mask.on('closed', () => { if (current.scroll === scroll) fail(current, '采集范围提示异常，已停止。'); });
        scroll.mask.on('hide', () => {
          if (current.scroll === scroll && ['scrolling', 'scroll-finishing'].includes(current.phase)) fail(current, '采集范围提示已隐藏，已停止。');
        });
        // 175% 副屏：DIP 建立后回读会多 1 DIP，遮罩也必须先按真实物理矩形拟合，
        // 否则后面保留的严格 checks（getBounds == display.bounds）会拒绝。
        if (env.nativeBounds) {
          const maskNonce = randomUUID().replace(/-/g, '');
          scroll.mask.setTitle(maskNonce);
          await fitWindow(scroll.mask, maskNonce, env.nativeBounds);
          if (getActive() !== current || current.scroll !== scroll || !scroll.mask || scroll.mask.isDestroyed()) return { started: false };
        }
        await scroll.mask.loadFile(path.join(__dirname, '..', 'renderer', 'scroll-mask.html'), { query: { layout: JSON.stringify({
          frame, pixels }) } });
        if (getActive() !== current || current.scroll !== scroll) return { started: false };
        const isPainted = await painted;
        if (getActive() !== current || current.scroll !== scroll) return { started: false };
        if (!isPainted) throw new Error('采集范围提示未就绪');
        const actual = scroll.mask.getBounds(), expected = env.display.bounds;
        if (['x', 'y', 'width', 'height'].some(key => actual[key] !== expected[key])) throw new Error('采集范围提示窗口尺寸不符');
        const domReady = await scroll.mask.webContents.executeJavaScript('window.regionMaskReady === true');
        if (getActive() !== current || current.scroll !== scroll) return { started: false };
        if (!domReady) throw new Error('采集范围提示未就绪');
        scroll.maskPrepared = true;
      }
      // 通过 Electron 的正式 userGesture 参数，在仍有焦点的选区页启动媒体请求。
      current.win.focus();
      diagnostics?.record('worker-call', { focused: current.win.isFocused() });
      await current.win.webContents.executeJavaScript('window.startScrollCapture()', true);
      return { started: getActive() === current && current.scroll === scroll && current.phase === 'scrolling' };
    } catch (error) {
      if (current.scroll === scroll) fail(current, `长截图未开始：${error.message}`);
      throw error;
    }
  });
  ipcMain.handle('shot:scroll-config', event => {
    const current = getActive();
    if (!allowed(event) || current?.phase !== 'scroll-starting') throw new Error('无效长截图请求');
    return { token: current.scroll.token, pixels: current.scroll.pixels, frame: current.scroll.env.frame };
  });
  function nativeRegion(current) {
    // 单屏语义一律读本轮冻结的 env：跨屏会话的 owner 可能根本不是 current.display。
    const env = current.scroll.env;
    const original = env.display, display = screen.getAllDisplays().find(value => value.id === original.id);
    if (!display || display.scaleFactor !== original.scaleFactor || ['x', 'y', 'width', 'height'].some(key => display.bounds[key] !== original.bounds[key])) {
      throw new Error('显示器分辨率或缩放发生变化，后续内容没有拼入');
    }
    // Electron supplies the real Windows physical origin, including mixed-DPI/negative-origin monitors.
    const physical = screen.dipToScreenRect(null, display.bounds), frame = env.frame, pixels = current.scroll.pixels;
    // 工作区变化同样会使旧的工作区夹取失效，先复核 DIP→物理投影。
    if (env.nativeWorkHint) {
      const workNow = screen.dipToScreenRect(null, display.workArea);
      if (!workNow || !['x', 'y', 'width', 'height'].every(key => Number.isInteger(workNow[key])) ||
          ['x', 'y', 'width', 'height'].some(key => workNow[key] !== env.nativeWorkHint[key])) throw new Error('显示器工作区发生变化，后续内容没有拼入');
    }
    // 真实 Windows 快照用查询到的显示器矩形作物理基准；Electron 的 physical 只用于复核映射没变。
    // 每帧只做内存计算，不再启动元数据程序；原生源自己在每帧前查监视器是否变更。
    const canonical = env.nativeBounds;
    if (canonical && !['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(canonical[key]))) throw new Error('缺少显示器物理矩形，未缩放拼接');
    if (canonical) {
      const hint = env.nativeHint;
      if (!physical || !hint || !['x', 'y', 'width', 'height'].every(key => Number.isInteger(physical[key])) ||
          ['x', 'y', 'width', 'height'].some(key => physical[key] !== hint[key])) throw new Error('显示器物理映射发生变化，后续内容没有拼入');
      if (canonical.width !== frame.width || canonical.height !== frame.height) throw new Error('原生显示器尺寸不匹配，未缩放拼接');
      return { x: canonical.x + pixels.x, y: canonical.y + pixels.y, width: pixels.width, height: pixels.height };
    }
    // 内部合成实验没有真实矩形时保留旧的严格同等比较；真实 Windows 查询失败不会走到这里。
    if (!physical || !['x', 'y', 'width', 'height'].every(key => Number.isInteger(physical[key])) ||
        physical.width !== frame.width || physical.height !== frame.height) throw new Error('原生显示器尺寸不匹配，未缩放拼接');
    return { x: physical.x + pixels.x, y: physical.y + pixels.y, width: pixels.width, height: pixels.height };
  }
  ipcMain.handle('shot:scroll-frame', async (event, token) => {
    const current = isSession(event, token);
    if (!current || (current.phase !== 'scrolling' && !(current.phase === 'scroll-finishing' && current.scroll.nativeTailAllowed)) ||
        current.scroll.nativePending) throw new Error('当前不能采样');
    const scroll = current.scroll, region = nativeRegion(current);
    if (!barCaptureSafe(scroll)) throw new Error(scroll.protectedBar ? '长截图浮条排除已失效，未接收画面' : '操作浮条偏入采集范围，未接收画面');
    scroll.nativeTailAllowed = false;
    if (scroll.capturePaused) return { fresh: false };
    if (!scroll.capture) { scroll.nativeRegion = region; scroll.capture = createCapture(region); }
    if (['x', 'y', 'width', 'height'].some(key => region[key] !== scroll.nativeRegion[key])) throw new Error('采集范围发生变化，后续内容没有拼入');
    scroll.nativePending = true;
    const source = scroll.capture, epoch = scroll.captureEpoch || 0;
    try {
      const frame = await source.next();
      if (isSession(event, token) !== current || current.scroll !== scroll) throw new Error('长截图已失效');
      if (epoch !== (scroll.captureEpoch || 0)) return { fresh: false };
      scroll.nativeHasFrame = true;
      const after = nativeRegion(current);
      if (!barCaptureSafe(scroll)) throw new Error(scroll.protectedBar ? '长截图浮条排除已失效，未接收画面' : '操作浮条偏入采集范围，未接收画面');
      if (['x', 'y', 'width', 'height'].some(key => after[key] !== region[key])) throw new Error('显示器采集范围已改变');
      return frame;
    } catch (error) {
      // 暂停主动终止在途源；旧代的成功/失败都不能污染恢复后的会话。
      if (isSession(event, token) === current && current.scroll === scroll && epoch !== (scroll.captureEpoch || 0)) return { fresh: false };
      throw error;
    } finally { scroll.nativePending = false; }
  });
  ipcMain.handle('shot:scroll-ready', (event, token) => {
    const current = isSession(event, token);
    if (!current || current.phase !== 'scroll-starting') throw new Error('长截图已失效');
    current.win.hide();
    if (current.scroll.mask) {
      current.scroll.mask.showInactive();
      current.scroll.mask.moveTop();
      const visible = current.scroll.mask.isVisible();
      diagnostics?.record('mask-ready', { ready: visible, hidden: !visible, remoteVisibility: 'unobserved' });
      if (!visible) { fail(current, '采集范围提示未显示，已停止。'); return false; }
    }
    clearTimeout(current.scroll.timer);
    current.phase = 'scrolling';
    const sessionScroll = current.scroll;
    const watcherError = error => {
      if (getActive() !== current || current.scroll !== sessionScroll) return;
      diagnostics?.record('worker-error', { phase: current.phase, errorName: error.name, errorMessage: `右键取消监听：${String(error.message).slice(0, 180)}` });
      sessionScroll.cancelWarning = `右键取消暂不可用，${sessionScroll.noBar ? '请按 Ctrl+Alt+Esc' : sessionScroll.cancelRegistered ? '请点取消或按 Ctrl+Alt+Esc' : '请点浮条取消'}。`;
      sessionScroll.status = { ...sessionScroll.status, message: sessionScroll.cancelWarning };
      sessionScroll.bar?.webContents.send('scroll-bar:status', sessionScroll.status);
      onStatus({ message: sessionScroll.cancelWarning, error: true });
    };
    try {
      sessionScroll.cancelWatcher = createCancelWatcher(() => {
        if (getActive() !== current || current.scroll !== sessionScroll || current.phase !== 'scrolling') return;
        cancel('cancelled'); onStatus({ message: '已右键取消长截图，未保存或复制。' });
      }, watcherError);
    } catch (error) { watcherError(error); }
    omitUnsafeBar(current);
    if (current.scroll.bar) {
      // 先收起全屏选区，再把操作浮条提到前面；不抢正文焦点。
      current.scroll.bar.showInactive();
      current.scroll.bar.moveTop();
      omitUnsafeBar(current);
      if (!current.scroll.bar.isVisible()) throw new Error('长截图提示未显示，已停止采集');
      if (current.scroll.bar) diagnostics?.record('bar-ready', { barProtected: current.scroll.bar.isContentProtected(),
        hidden: !current.scroll.bar.isVisible(), accepted: true, remoteVisibility: 'unobserved' });
    }
    const wheelError = error => {
      if (getActive() !== current || current.scroll !== sessionScroll || current.phase !== 'scrolling') return;
      diagnostics?.record('worker-error', { phase: current.phase, errorName: error.name, errorMessage: `方向键滚动：${String(error.message).slice(0, 180)}` });
      sessionScroll.wheelWarning = '↑↓ 暂不可用，请用鼠标滚轮';
      sessionScroll.status = { ...sessionScroll.status, message: sessionScroll.wheelWarning };
      sessionScroll.bar?.webContents.send('scroll-bar:status', sessionScroll.status);
      onStatus({ message: sessionScroll.wheelWarning, error: false });
    };
    try {
      const region = nativeRegion(current);
      sessionScroll.wheelScroller = createWheelScroller(region, wheelError, current.foregroundHwnd || 0);
    } catch (error) { wheelError(error); }
    current.scroll.status = { height: current.scroll.pixels.height, added: 0,
      message: (current.scroll.noBar ? '全屏长截图：鼠标放正文内，用滚轮 / ↑↓ 滚动 · Esc 完成 · Ctrl+Alt+Esc 取消' : `鼠标放正文内，用滚轮 / ↑↓ 滚动 · ${current.scroll.escapeRegistered ? 'Esc 或完成收工' : '点完成收工'}`) + (sessionScroll.wheelWarning ? ` · ${sessionScroll.wheelWarning}` : ''), canFinish: true };
    current.scroll.bar?.webContents.send('scroll-bar:status', current.scroll.status);
    onStatus({ message: current.scroll.noBar ? '全屏长截图进行中：Esc（全局）完成并预览，Ctrl+Alt+Esc 取消；请勿打开菜单或弹窗。' : `正在接长图；${current.scroll.escapeRegistered ? 'Esc 或' : ''}托盘「完成长截图」收工，停住不会自动结束。` });
    diagnostics?.record('window-hidden', { hidden: !current.win.isVisible(), escapeRegistered: Boolean(current.scroll.escapeRegistered), cancelRegistered: Boolean(current.scroll.cancelRegistered), noBar: current.scroll.noBar, protectedBar: current.scroll.protectedBar, barProtected: Boolean(current.scroll.bar?.isContentProtected()), remoteVisibility: 'unobserved' });
    // 其他置顶窗口可能盖住非聚焦浮条；仅维护已有可见浮条的层级，不抢焦点、不复活隐藏窗口。
    const scroll=current.scroll;
    if(!scroll.bar)return true;
    scroll.barTimer=setInterval(()=>{
      if(getActive()!==current||current.scroll!==scroll||current.phase!=='scrolling')return;
      // The hint window has no timer of its own; keep it above the page after any focus change.
      if(scroll.mask&&!scroll.mask.isDestroyed()&&scroll.mask.isVisible()){try{scroll.mask.moveTop();}catch{/* 提示层抬层失败不结束采集。 */}}
      if(!scroll.bar||scroll.bar.isDestroyed()||!scroll.bar.isVisible())return;
      try{if(!barCaptureSafe(scroll))return;scroll.bar.moveTop();scroll.barRaises=(scroll.barRaises??0)+1;}
      catch{/* 显示维护失败不结束截图；实际取帧仍由原有几何护栏拒绝污染画面。 */}
    },800);
    scroll.barTimer.unref?.();
    // 两秒后再报一次提示层状态：首次 mask-ready 只能证明开始采集那一刻可见。
    setTimeout(()=>{
      if(getActive()!==current||current.scroll!==scroll||current.phase!=='scrolling')return;
      if(!scroll.mask||scroll.mask.isDestroyed())return;
      const visible=scroll.mask.isVisible();
      diagnostics?.record('mask-ready',{ready:visible,hidden:!visible,remoteVisibility:'unobserved'});
    },2000).unref?.();
    return true;
  });
  ipcMain.handle('shot:scroll-finishing', (event, token) => {
    const current = isSession(event, token);
    if (!current || !['scrolling', 'scroll-finishing'].includes(current.phase)) throw new Error('长截图已失效');
    current.phase = 'scroll-finishing';
    current.scroll.wheelScroller?.stop(); current.scroll.wheelScroller = undefined;
    current.scroll.nativeTailAllowed = false;
    current.scroll.capture?.stop();
    current.scroll.status = { ...current.scroll.status, message: '正在合成长图…', canFinish: false };
    current.scroll.bar?.webContents.send('scroll-bar:status', current.scroll.status);
  });
  ipcMain.handle('shot:scroll-progress', (event, token, state) => {
    const current = isSession(event, token);
    if (!current || current.phase !== 'scrolling') return;
    if (!Number.isInteger(state?.height) || state.height < current.scroll.pixels.height || state.height > MAX_HEIGHT || typeof state.message !== 'string') return;
    let reference = current.scroll.status.reference;
    const candidate = state.reference;
    // 只接收有界PNG缩略参照；仅流转到本轮浮条，不进诊断或磁盘。
    if (candidate && Number.isInteger(candidate.width) && candidate.width > 0 && candidate.width <= 960 &&
        Number.isInteger(candidate.height) && candidate.height > 0 && candidate.height <= 320 &&
        typeof candidate.dataUrl === 'string' && candidate.dataUrl.length <= 2000000 && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(candidate.dataUrl)) {
      // 浮条已有同一张已验证参照时不再重复解码；换图或改尺寸仍走完整PNG校验。
      if (reference?.dataUrl !== candidate.dataUrl || reference.width !== candidate.width || reference.height !== candidate.height) {
        try {
          const bytes = Buffer.from(candidate.dataUrl.slice('data:image/png;base64,'.length), 'base64');
          if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
              bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' ||
              bytes.readUInt32BE(16) !== candidate.width || bytes.readUInt32BE(20) !== candidate.height) throw new Error('无效参照尺寸');
          const image = nativeImage.createFromDataURL(candidate.dataUrl), size = image.getSize();
          if (!image.isEmpty() && size.width === candidate.width && size.height === candidate.height) {
            reference = { dataUrl: candidate.dataUrl, width: size.width, height: size.height };
          }
        } catch { /* 非法参照不替换已有可信参照。 */ }
      }
    }
    let preview = current.scroll.status.preview;
    const map = state.preview;
    // 完整长图仅接受有界PNG，不接收原始大图；来源高度绑定到同一进度快照。
    if (map && Number.isInteger(map.width) && map.width > 0 && map.width <= 240 &&
        Number.isInteger(map.height) && map.height > 0 && map.height <= 480 && map.sourceHeight === state.height &&
        typeof map.dataUrl === 'string' && map.dataUrl.length <= 1000000 && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(map.dataUrl)) {
      try {
        if (preview?.dataUrl !== map.dataUrl || preview.width !== map.width || preview.height !== map.height) {
          const bytes = Buffer.from(map.dataUrl.slice('data:image/png;base64,'.length), 'base64');
          if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
              bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' ||
              bytes.readUInt32BE(16) !== map.width || bytes.readUInt32BE(20) !== map.height) throw new Error('无效预览尺寸');
          const image = nativeImage.createFromDataURL(map.dataUrl), size = image.getSize();
          if (image.isEmpty() || size.width !== map.width || size.height !== map.height) throw new Error('无效预览图片');
        }
        preview = { dataUrl: map.dataUrl, width: map.width, height: map.height, sourceHeight: map.sourceHeight };
      } catch { /* 保留最后可信预览，不让损坏图片中断采集。 */ }
    }
    const view = state.viewport;
    let viewport;
    if (view && Number.isInteger(view.top) && view.top >= 0 && Number.isInteger(view.height) && view.height > 0 &&
        view.top + view.height <= state.height && typeof view.matched === 'boolean') {
      viewport = { top: view.top, height: view.height, matched: view.matched && preview?.sourceHeight === state.height };
    } else if (current.scroll.status.viewport && preview?.sourceHeight === state.height) {
      viewport = { ...current.scroll.status.viewport, matched: false };
    }
    current.scroll.status = { height: state.height, added: state.height - current.scroll.pixels.height,
      message: state.message.slice(0, current.scroll.wheelWarning ? 140 : 200) + (current.scroll.wheelWarning ? ` · ${current.scroll.wheelWarning}` : ''), canFinish: true, reference, preview, viewport };
    current.scroll.bar?.webContents.send('scroll-bar:status', current.scroll.status);
  });
  // 旧同步预览：发 complete、显示原选区窗。生产交接成功时不走这里；失败回退时保留警告与错误提示。
  function showLegacyPreview(current, packet, size, warning, handoffFailed = false) {
    if (getActive() !== current || current.phase !== 'selecting' || !current.longImage) return false;
    current.win.webContents.send('shot:scroll-complete', packet);
    diagnostics?.record('preview-sent', { width: size.width, height: size.height, partial: Boolean(warning) });
    current.win.show(); current.win.focus();
    const detail = warning ? `：${warning}` : '';
    const message = handoffFailed
      ? `成图窗口未能打开，已回到预览，图片保留${detail} · 仍需保存或复制。`
      : warning ? `仅保留已接部分${detail} · 尚未保存，请点保存或复制。`
        : `长图已生成（${size.height} 像素）· 尚未保存，请在预览出现后选保存或复制。`;
    onStatus({ message, error: Boolean(warning) || handoffFailed });
    return true;
  }
  ipcMain.handle('shot:scroll-result', (event, token, packet) => {
    const current = isSession(event, token);
    if (!current) return false;
    try {
      diagnostics?.record('result-received', { bytes: packet?.png?.byteLength });
      if (!(packet?.png instanceof ArrayBuffer) || packet.png.byteLength > 128_000_000) throw new Error('长图编码无效或过大');
      const warning = typeof packet.warning === 'string' ? packet.warning.slice(0, 240) : '';
      const image = nativeImage.createFromBuffer(Buffer.from(packet.png));
      const size = image.getSize();
      if (image.isEmpty() || size.width !== current.scroll.pixels.width || size.height < current.scroll.pixels.height ||
        size.height > MAX_HEIGHT || size.width * size.height > MAX_PIXELS) throw new Error('长图尺寸无效');
      // 只有采集端明确标记的异常恢复，且带具体警告，才允许首屏高度进预览；正常结束仍按零增长处理。
      if (size.height === current.scroll.pixels.height && !(packet.recovered === true && warning.trim())) {
        fail(current, '未接长：没有新增内容，未保存或复制。', 'no-growth');
        return false;
      }
      const ratio = Math.min(1, 320 / size.width, 900 / size.height);
      const preview = image.resize({ width: Math.max(1, Math.round(size.width * ratio)), height: Math.max(1, Math.round(size.height * ratio)) }).toDataURL();
      // cleanup 会清掉 current.scroll：原始选区先把一份取出来，交给主进程成图窗口用它重算同一份像素。
      const rect = { ...current.scroll.rect };
      current.longImage = image; current.longToken = token; current.longPreviewPending = true;
      cleanup(current);
      current.phase = 'selecting';
      const legacyPacket = { ok: true, token, ...size, preview, warning };
      // 生产：主进程注入交接，成功后由普通成图窗口接管（不发旧 complete、不 show 旧窗）。
      // 交接返回 false 或抛错都保留已生成的 longImage，回退原来的同步预览（warning 与错误提示都保留）。
      if (typeof onLongResult === 'function') {
        return Promise.resolve()
          .then(() => onLongResult({ current, token, image, size, preview, warning, rect }))
          .then(handed => handed === true
            ? (diagnostics?.record('preview-sent', { width: size.width, height: size.height, partial: Boolean(warning) }), true)
            : showLegacyPreview(current, legacyPacket, size, warning, true))
          .catch(() => showLegacyPreview(current, legacyPacket, size, warning, true));
      }
      return showLegacyPreview(current, legacyPacket, size, warning);
    } catch (error) { fail(current, `长图未完成：${error.message}`); return false; }
  });
  ipcMain.handle('shot:scroll-error', (event, token, message, reason) => {
    const current = isSession(event, token);
    if (current) {
      if (['no-growth', 'resolution-changed', 'media-ended', 'sample-error', 'size-limit'].includes(reason)) fail(current, `未接长：${String(message || '没有新增内容').slice(0, 160)}。未保存或复制。`, reason);
      else fail(current, `长截图已停止：${String(message).slice(0, 200)}`);
    }
  });
  ipcMain.handle('scroll-bar:state', event => {
    const current = isBar(event);
    if (!current) throw new Error('无效浮条');
    return { ...current.scroll.status, capturePaused: Boolean(current.scroll.capturePaused) };
  });
  // 本地诊断：真正关闭/重建原生取屏，窗口和已确认正文保持不动。
  ipcMain.handle('scroll-bar:toggle-capture', event => {
    const current = isBar(event);
    if (!current) throw new Error('无效浮条排查请求');
    const scroll = current.scroll;
    if (current.phase !== 'scrolling' || !scroll.nativeHasFrame) throw new Error('当前不能切换取屏，请等准备完成');
    scroll.capturePaused = !scroll.capturePaused;
    if (scroll.capturePaused) {
      scroll.captureEpoch = (scroll.captureEpoch || 0) + 1;
      const source = scroll.capture; scroll.capture = undefined; source?.stop();
    }
    diagnostics?.record('capture-toggle', { phase: current.phase, paused: scroll.capturePaused, accepted: true });
    return { paused: scroll.capturePaused };
  });
  ipcMain.handle('scroll-bar:finish', event => {
    if (!isBar(event)) throw new Error('无效浮条');
    if (!finish()) throw new Error('当前不能完成长截图');
  });
  ipcMain.handle('scroll-bar:cancel', event => {
    if (!isBar(event)) throw new Error('无效浮条');
    cancel('cancelled'); onStatus({ message: '已取消长截图，未保存或复制。' });
  });
  return { cleanup, finish, captureRequest: frame => {
    const current = getActive();
    return current?.scroll && ['scroll-starting', 'scrolling'].includes(current.phase) &&
      !current.win.isDestroyed() && frame === current.win.webContents.mainFrame ? { displayId: current.scroll.env.display.id, token: current.scroll.token } : undefined;
  } };
}
module.exports = { installScrolling };
