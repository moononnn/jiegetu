'use strict';
function diagnostic(name, fields = {}) {
  try { window.selection.diagnostic?.(name, fields)?.catch?.(() => {}); } catch { /* 诊断不影响框选。 */ }
}
window.addEventListener?.('error', event => diagnostic('renderer-error', { errorName: event.error?.name || 'Error', errorMessage: event.message }));
window.addEventListener?.('unhandledrejection', event => diagnostic('renderer-error', { errorName: event.reason?.name || 'Error', errorMessage: event.reason?.message || 'Unhandled rejection' }));
const image = document.querySelector('#desktop');
const box = document.querySelector('#box');
const veil = document.querySelector('#veil');
const hint = document.querySelector('#hint');
const toolbar = document.querySelector('#actions');
const save = document.querySelector('#save');
const saveAs = document.querySelector('#save-as');
const copy = document.querySelector('#copy');
const editButton = document.querySelector('#edit');
const recordGif = document.querySelector('#record-gif');
const recordVideo = document.querySelector('#record-video');
// 图片编辑在独立的普通窗口（有标题栏/任务栏）里进行：本页只负责把当前成图交出去、接回缩略图。
// 本页不再创建编辑器，编辑期间选区 DOM、冻结基准和选框都保持原样。
let editorDocument, editorLoading = false;
function editLocked() { return editorLoading; }
// 编辑窗口交回预览：主进程已收起编辑窗并显示本页，这里只更新预览小图与提示，不重建草稿。
function setPreviewFromEditor(payload) {
  if (!editorDocument || !payload || payload.token !== editorDocument.token) return;
  try {
    if (typeof payload.thumbnail === 'string' && payload.thumbnail.startsWith('data:image/')) {
      longPreview.src = payload.thumbnail;
      for (const [key, value] of Object.entries({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })) longPreview.style[key] = `${value}px`;
      longPreview.hidden = false;
      longPreview.alt = '当前成图，点击继续编辑';
      longPreview.title = '点击继续编辑完整原图，保存和复制包含当前标注';
      box.hidden = true; veil.hidden = false;
    }
    // 裁切后成图尺寸是编辑窗给的输出尺寸，不是原始文档尺寸（缺字段时回退源尺寸）。
    const outputSize = payload.outputSize && Number.isInteger(payload.outputSize.width) && Number.isInteger(payload.outputSize.height)
      ? payload.outputSize : { width: editorDocument.width, height: editorDocument.height };
    hint.textContent = `${outputSize.width} × ${outputSize.height} 像素 · ${longWarning ? `仅保留已接部分：${longWarning} · ` : ''}编辑已保留 · 保存或复制成功后退出`;
  } catch (error) {
    longPreview.hidden = true;
    hint.textContent = `缩略预览未更新：${error.message} · 编辑仍保留，点击「编辑」重试`;
  }
  placeToolbar(); editButton.focus();
}
async function openEditor() {
  clearCandidates();
  if (!ready || committing || exitPending || editorLoading || origin || !rect || rect.width < 2 || rect.height < 2) return;
  closeViewer();
  editorLoading = true;
  save.disabled = saveAs.disabled = copy.disabled = editButton.disabled = true;
  hint.textContent = '正在打开原图编辑…';
  try {
    if (editorDocument) {
      // 同 token 唤回：主进程只把编辑窗重新上屏，编辑窗里那份 DOM/草稿/历史都还在。
      await window.selection.editState(editorDocument.token, 'open');
    } else {
      // 只拿元数据：真正的原图由主进程交给独立编辑窗口。
      const source = await window.selection.editSource({ ...rect }, longToken, longWarning);
      if (!source || typeof source.token !== 'string') throw new Error('编辑来源无效');
      editorDocument = { token: source.token, width: source.width, height: source.height };
    }
    // 主进程已把编辑窗上屏、收起本页；本页不再持有编辑器。
    hint.textContent = '编辑在独立窗口中进行 · 返回预览后保存或复制';
    // 原尺寸浏览与编辑不同时保留两个解码副本。
    viewerImage.src = ''; fullSize = loadedToken = undefined;
    retake.hidden = false;
    document.body.style.cursor = 'default';
  } catch (error) {
    hint.textContent = `编辑未能打开：${error.message} · 成图仍保留`;
  } finally {
    editorLoading = false;
    save.disabled = saveAs.disabled = copy.disabled = editButton.disabled = false;
    updateActions();
  }
}
async function discardEditorAndClear(dismissSource) {
  editorLoading = true;
  save.disabled = saveAs.disabled = copy.disabled = editButton.disabled = true;
  try {
    await window.selection.editState(editorDocument.token, 'discard');
    editorDocument = undefined;
    clearSelection(dismissSource);
  } catch (error) { hint.textContent = `未能重新框选：${error.message} · 编辑仍保留`; }
  finally { editorLoading = false; save.disabled = saveAs.disabled = copy.disabled = editButton.disabled = false; }
}
editButton.addEventListener('click', openEditor);
// 编辑窗口交回预览时的缩略图/输出尺寸：只更新本页预览，不重建草稿。
try { window.selection.onEditorPreview?.(setPreviewFromEditor); } catch { /* 旧预载没有这个通道时不影响框选。 */ }
const longPreview = document.querySelector('#long-preview');
const retake = document.querySelector('#retake');
const viewer = document.querySelector('#image-viewer');
const viewport = document.querySelector('#viewer-scroll');
const viewerImage = document.querySelector('#viewer-image');
const viewerStatus = document.querySelector('#viewer-status');
const zoomLabel = document.querySelector('#zoom-label');
const zoomIn = document.querySelector('#zoom-in'), zoomOut = document.querySelector('#zoom-out');
const zoomFit = document.querySelector('#zoom-fit'), zoomOriginal = document.querySelector('#zoom-original');
let viewerEpoch = 0, zoom = 1, fullSize, loadedToken, previousHint, viewerDrag;
let longToken, longWarning = '';
function stopViewerDrag() {
  const drag = viewerDrag; viewerDrag = undefined;
  viewport.style.cursor = '';
  if (drag && viewport.hasPointerCapture(drag.id)) viewport.releasePointerCapture(drag.id);
}
viewport.addEventListener('pointerdown', event => {
  if (!ready || committing || viewer.hidden || !fullSize || viewerDrag || event.button !== 0 || event.isPrimary === false || event.target !== viewerImage) return;
  event.preventDefault(); viewport.focus({ preventScroll: true });
  viewport.setPointerCapture(event.pointerId);
  viewerDrag = { id: event.pointerId, x: event.clientX, y: event.clientY };
  viewport.style.cursor = 'grabbing';
});
viewport.addEventListener('pointermove', event => {
  if (!viewerDrag || viewerDrag.id !== event.pointerId) return;
  if ((event.buttons & 1) === 0) { stopViewerDrag(); return; }
  event.preventDefault();
  // Incremental deltas keep wheel movement and scroll-edge clamping from pulling the image back to an old anchor.
  viewport.scrollLeft = Math.max(0, viewport.scrollLeft + viewerDrag.x - event.clientX);
  viewport.scrollTop = Math.max(0, viewport.scrollTop + viewerDrag.y - event.clientY);
  viewerDrag.x = event.clientX; viewerDrag.y = event.clientY;
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) viewport.addEventListener(name, event => {
  if (viewerDrag?.id === event.pointerId) stopViewerDrag();
});
window.addEventListener?.('blur', stopViewerDrag);
function setZoom(value, reset = false) {
  stopViewerDrag();
  if (!fullSize) return;
  const old = zoom, cx = (viewport.scrollLeft + viewport.clientWidth / 2) / old,
    cy = (viewport.scrollTop + viewport.clientHeight / 2) / old;
  zoom = Math.max(.05, Math.min(4, value));
  viewerImage.style.width = `${fullSize.width * zoom}px`;
  viewerImage.style.height = `${fullSize.height * zoom}px`;
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  zoomOut.disabled = zoom <= .05; zoomIn.disabled = zoom >= 4;
  viewport.scrollLeft = reset ? 0 : Math.max(0, cx * zoom - viewport.clientWidth / 2);
  viewport.scrollTop = reset ? 0 : Math.max(0, cy * zoom - viewport.clientHeight / 2);
}
function fitWidth() { if (fullSize) setZoom(Math.min(1, (viewport.clientWidth - 32) / fullSize.width), true); }
function closeViewer() {
  if (viewer.hidden || committing) return;
  stopViewerDrag();
  ++viewerEpoch;
  viewer.hidden = true;
  toolbar.style.zIndex = '';
  hint.textContent = previousHint;
  placeToolbar();
  longPreview.focus();
}
async function openViewer() {
  if (editorDocument) return openEditor();
  if (!longToken || committing || !viewer.hidden) return;
  const epoch = ++viewerEpoch, token = longToken;
  previousHint = hint.textContent;
  viewer.hidden = false;
  fitPanelToScreen(viewer);
  toolbar.style.zIndex = '5';
  toolbar.style.left = `${Math.max(6, innerWidth - toolbar.offsetWidth - 16)}px`;
  toolbar.style.top = `${Math.max(6, innerHeight - toolbar.offsetHeight - 12)}px`;
  if (desktopMode) {
    const area = hostScreen();
    toolbar.style.left = `${Math.max(area.x + 6, area.right - toolbar.offsetWidth - 16)}px`;
    toolbar.style.top = `${Math.max(area.y + 6, area.bottom - toolbar.offsetHeight - 12)}px`;
  }
  viewerStatus.textContent = '正在读取原尺寸长图…尚未保存';
  for (const button of [zoomIn, zoomOut, zoomFit, zoomOriginal]) button.disabled = true;
  try {
    if (loadedToken !== token) {
      const result = await window.selection.previewImage(token);
      if (epoch !== viewerEpoch || token !== longToken) return;
      viewerImage.src = result.dataUrl;
      await viewerImage.decode();
      if (epoch !== viewerEpoch || token !== longToken) return;
      fullSize = { width: result.width, height: result.height }; loadedToken = token;
    }
    for (const button of [zoomIn, zoomOut, zoomFit, zoomOriginal]) button.disabled = false;
    fitWidth();
    viewerStatus.textContent = `${longWarning ? `仅保留已接部分：${longWarning} · ` : ''}按住图片拖动 · 滚轮查看 · Ctrl＋滚轮缩放 · Esc 返回 · 尚未保存`;
    viewport.focus();
  } catch (error) {
    if (epoch !== viewerEpoch || token !== longToken) return;
    viewerStatus.textContent = `原图未能打开：${error.message} · 可返回后重试，仍可保存或复制`;
  }
}
zoomIn.addEventListener('click', () => setZoom(zoom * 1.25));
zoomOut.addEventListener('click', () => setZoom(zoom / 1.25));
zoomFit.addEventListener('click', fitWidth);
zoomOriginal.addEventListener('click', () => setZoom(1));
document.querySelector('#viewer-close').addEventListener('click', closeViewer);
retake.addEventListener('click', () => { if (!committing && !editLocked()) clearSelection('retake'); });
let scrollEpoch = 0;
let origin;
let rect;
let pointerId;
let windowFrame, windowRegions = [], hoverCandidate, candidateDown;
// A late MSAA detail result is only queued here. Applying it straight away would let a click
// pick a region the user never saw hovered, so the visible fallback stays authoritative until a
// fresh pointer move adopts the new table.
let pendingWindowRegionDetail, pendingVisualPanels, pendingVisualControls;
let visualPanels = [], visualControls = [];
// The page goes away with the selection window: stop the frame worker with it.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', () => stopControlWorker());
}
function projectWindowRegion(r) {
  const f = windowFrame;
  if (!f || !(f.width > 0 && f.height > 0)) return undefined;
  const x = Math.max(r.x, f.x), y = Math.max(r.y, f.y);
  const right = Math.min(r.x + r.width, f.x + f.width), bottom = Math.min(r.y + r.height, f.y + f.height);
  if (right <= x || bottom <= y) return undefined;
  return {x:(x-f.x)*innerWidth/f.width,y:(y-f.y)*innerHeight/f.height,width:(right-x)*innerWidth/f.width,height:(bottom-y)*innerHeight/f.height};
}
const containsPoint = (r,p) => r && p.x >= r.x && p.y >= r.y && p.x < r.x+r.width && p.y < r.y+r.height;
function candidateAt(p, shift) {
  if (shift || rect || longToken || editorDocument) return undefined;
  // Z order first; never search a lower window's client through an occluding outer frame.
  for (const [index, row] of windowRegions.entries()) {
    const bounds = projectWindowRegion(row.bounds);
    if (!containsPoint(bounds,p)) continue;
    // Our own windows (settings page, parent selection page) occlude what is behind them but are never selectable.
    if (row.blocked) return undefined;
    // Element regions win over the plain client area: the smallest rectangle containing the
    // point is the control under the cursor, not the whole window.
    const regions = row.regions || [], panels = visualPanels[index] || [], controls = visualControls[index] || [];
    if (regions.length || panels.length || controls.length) {
      let best, bestArea = Infinity;
      for (const region of [...regions, ...panels, ...controls]) {
        const projected = projectWindowRegion(region);
        if (!containsPoint(projected,p)) continue;
        const area = projected.width * projected.height;
        if (area < bestArea) { bestArea = area; best = projected; }
      }
      if (best) return best;
    }
    const client = row.client && projectWindowRegion(row.client);
    const different = client && ['x','y','width','height'].some(k => Math.abs(client[k]-bounds[k]) >= 2);
    return different && containsPoint(client,p) ? client : bounds;
  }
}
function sameRegionRect(a, b) { return Boolean(a && b) && ['x', 'y', 'width', 'height'].every(key => a[key] === b[key]); }
function applyWindowRegionDetailPatch(patches) {
  if (!Array.isArray(patches) || patches.length > 2) return false;
  const indexes = new Set(), next = windowRegions.slice(), additions = [];
  let total = windowRegions.reduce((sum, row) => sum + (Array.isArray(row.regions) ? row.regions.length : 0), 0);
  for (const patch of patches) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).sort().join(',') !== 'bounds,client,index,regions' ||
        !Number.isSafeInteger(patch.index) || patch.index < 0 || patch.index >= windowRegions.length || indexes.has(patch.index)) return false;
    indexes.add(patch.index);
    const row = windowRegions[patch.index];
    if (!row || row.blocked === true || !sameRegionRect(row.bounds, patch.bounds) ||
        !(row.client === null ? patch.client === null : sameRegionRect(row.client, patch.client)) ||
        !Array.isArray(patch.regions) || patch.regions.length > 128) return false;
    const container = row.client || row.bounds, existing = new Set((row.regions || []).map(r => `${r.x},${r.y},${r.width},${r.height}`));
    const seen = new Set(), added = [];
    for (const region of patch.regions) {
      if (!region || typeof region !== 'object' || Array.isArray(region) || Object.keys(region).sort().join(',') !== 'height,width,x,y' ||
          !['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(region[key])) || region.width < 8 || region.height < 8 ||
          region.x < container.x || region.y < container.y || region.x + region.width > container.x + container.width || region.y + region.height > container.y + container.height) return false;
      // The whole client area is the fallback rectangle, never a new candidate.
      if (sameRegionRect(region, container)) return false;
      const key = `${region.x},${region.y},${region.width},${region.height}`;
      if (existing.has(key) || seen.has(key)) return false;
      seen.add(key); added.push({ ...region });
    }
    if ((row.regions?.length || 0) + added.length > 128 || total + added.length > 256) return false;
    total += added.length;
    additions.push({ index: patch.index, regions: added });
  }
  for (const update of additions) next[update.index] = { ...next[update.index], regions: [...(next[update.index].regions || []), ...update.regions] };
  windowRegions = next;
  return additions.length > 0;
}
// Windows that may be sampled for visual candidates: visible, not clipped, and not covered by
// another window, so a neighbour's border cannot become a candidate for this one.
function visualSampleWindows() {
  const frame = windowFrame;
  if (!frame) return [];
  const overlap = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const list = [];
  for (const [index, row] of windowRegions.entries()) {
    if (row.blocked) continue;
    const client = row.client || row.bounds;
    const x = Math.max(client.x, frame.x), y = Math.max(client.y, frame.y);
    const r = { x, y, width: Math.min(client.x + client.width, frame.x + frame.width) - x,
      height: Math.min(client.y + client.height, frame.y + frame.height) - y };
    const area = r.width * r.height;
    if (r.width < 320 || r.height < 210 || area < client.width * client.height * 0.98) continue;
    if (desktopMode && !desktopPhysicalScreens.some(s => overlap(r, { ...s, x: s.x + frame.x, y: s.y + frame.y }) === area)) continue;
    if (windowRegions.slice(0, index).some(other => overlap(r, other.bounds) > area * 0.1)) continue;
    list.push({ index, rect: r });
    if (list.length === 2) break;
  }
  return list;
}
// Draw one window region into a bounded sample (long edge 768) and return its pixels.
function sampleWindow(rect) {
  const frame = windowFrame;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const scale = Math.min(1, 768 / Math.max(rect.width, rect.height));
  const w = Math.round(rect.width * scale), h = Math.round(rect.height * scale);
  canvas.width = w; canvas.height = h;
  const sx = image.naturalWidth / frame.width, sy = image.naturalHeight / frame.height;
  ctx.drawImage(image, (rect.x-frame.x)*sx, (rect.y-frame.y)*sy, rect.width*sx, rect.height*sy, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, w, h };
}
// Map a sample space box back to screen space.
function sampleBoxToScreen(box, rect, w, h) {
  const x = Math.round(box.x*rect.width/w), y = Math.round(box.y*rect.height/h);
  return { x: rect.x+x, y: rect.y+y, width: Math.round((box.x+box.width)*rect.width/w)-x,
    height: Math.round((box.y+box.height)*rect.height/h)-y };
}
// Use the frozen frame. Skip clipped or substantially covered windows so another
// window's borders cannot become separator candidates for this one.
function findVisualPanels() {
  const detect = globalThis.detectPanelRegions, frame = windowFrame;
  if (typeof detect !== 'function' || !frame || frame.width < 1 || frame.height < 1 || !image.naturalWidth || !image.naturalHeight) return;
  const panels = [];
  for (const { index, rect } of visualSampleWindows()) {
    const sample = sampleWindow(rect);
    if (!sample) continue;
    panels[index] = detect(sample.data, sample.w, sample.h).map(box => sampleBoxToScreen(box, rect, sample.w, sample.h));
  }
  pendingVisualPanels = panels;
}
// Control sized rectangles (inputs, cards) from the same frozen frame: a window may have no
// accessibility provider at all. The geometry work runs in a worker, so the renderer keeps
// answering pointer events while it happens.
let controlWorker = null;
const controlRequests = new Map();
const controlBoxes = {};
let controlRequestId = 0;
function stopControlWorker() {
  if (controlWorker) { try { controlWorker.terminate(); } catch { /* already gone */ } }
  controlWorker = null;
  controlRequests.clear();
}
function ensureControlWorker() {
  if (controlWorker) return controlWorker;
  if (typeof Worker !== 'function') return null;
  try {
    const worker = new Worker('./control-regions-worker.js');
    worker.onmessage = event => {
      const { id, boxes } = event.data || {};
      const request = controlRequests.get(id);
      if (!request) return;
      controlRequests.delete(id);
      if (!Array.isArray(boxes) || !boxes.length) return;
      const { index, rect, w, h } = request;
      controlBoxes[index] = boxes.map(box => sampleBoxToScreen(box, rect, w, h));
      // Only queued here: the rectangles are adopted by the next eligible pointer move.
      pendingVisualControls = { ...controlBoxes };
    };
    // A worker that dies must not take the selection with it: the panel and MSAA paths stay.
    worker.onerror = worker.onmessageerror = stopControlWorker;
    controlWorker = worker;
  } catch { controlWorker = null; }
  return controlWorker;
}
function findVisualControls() {
  const worker = ensureControlWorker();
  if (!worker) return;   // no worker: no synchronous detector fallback in production
  const windows = visualSampleWindows();
  let next = 0;
  const step = () => {
    if (worker !== controlWorker || next >= windows.length) return;
    const { index, rect } = windows[next++];
    const sample = sampleWindow(rect);
    if (sample && sample.data && sample.data.buffer && sample.data.length) {
      const id = ++controlRequestId;
      controlRequests.set(id, { index, rect, w: sample.w, h: sample.h });
      try {
        // The sample buffer moves to the worker instead of being copied.
        worker.postMessage({ id, width: sample.w, height: sample.h, buffer: sample.data.buffer }, [sample.data.buffer]);
      } catch { controlRequests.delete(id); }
    }
    if (next < windows.length) setTimeout(step, 0);
  };
  setTimeout(step, 0);
}
function paintSelection(r) {
  box.style.left = `${r.x}px`; box.style.top = `${r.y}px`;
  box.style.width = `${r.width}px`; box.style.height = `${r.height}px`;
}
function clearCandidates() {
  document.body.classList.remove('window-hover');
  hoverCandidate = candidateDown = undefined;
  // 只在没有已固定选区时复位提示：固定框、长图与保存中的提示不能被预览态覆盖。
  if (!rect) { box.hidden = true; veil.hidden = false; toolbar.hidden = true; hint.textContent = initialHint; }
}
function hoverAt(event) {
  hoverCandidate = candidateAt(point(event),event.shiftKey);
  document.body.classList.toggle('window-hover', Boolean(hoverCandidate));
  if (rect) return;
  box.hidden = !hoverCandidate;
  // 预览期间始终保留蒙版：全屏候选的屏外阴影会被裁掉，靠蒙版与内侧描边才看得见。
  veil.hidden = false;
  toolbar.hidden = true;
  if (hoverCandidate) { paintSelection(hoverCandidate); hint.textContent = HOVER_HINT; }
  else hint.textContent = event.shiftKey ? 'Shift 手动框选' : initialHint;
}
let dragMode;
let dragRect;
let ready = false;
let committing = false;
// 成图退出确认：结果回来前锁住按钮与手势；保留时原草稿/标注/预览都不动。
let exitPending = false;
// GIF 录制：只有用户点按钮后才让主进程开始实时采屏；本页不碰录制窗口，也不做直播预览。
let recording = false;
// 跨屏普通截图：一扇窗盖住整组屏。屏幕矩形只用来把控件留在真实屏幕上，不参与取图坐标。
let desktopMode = false;
let desktopFrame;
let desktopPhysicalScreens;
let desktopScreens;
const CROSS_SCROLL_MESSAGE = '跨屏选区仅支持普通截图';
const RECORD_CROSS_MESSAGE = 'GIF 录制仅支持单屏内的选区';
const DESKTOP_PANEL_MIN = { width: 320, height: 240 };
let initialHint = '拖动框选 · Esc 退出';
// 命中候选时的提示：说清自动选区、点击固定、拖动重选与 Shift 手动。
const HOVER_HINT = '自动选区 · 点击固定 · 拖动重选 · Shift 手动 · Esc 退出';
const point = event => ({ x: Math.max(0, Math.min(innerWidth, event.clientX)),
  y: Math.max(0, Math.min(innerHeight, event.clientY)) });
const dimensions = () => `${Math.round(rect.width * image.naturalWidth / innerWidth)} × ${Math.round(rect.height * image.naturalHeight / innerHeight)} 像素`;
function releasePointer() {
  const released = pointerId;
  pointerId = undefined;
  if (released !== undefined && document.body.hasPointerCapture(released)) document.body.releasePointerCapture(released);
}
function clearSelection(dismissSource) {
  clearCandidates();
  if (editorDocument) return discardEditorAndClear(dismissSource);
  diagnostic('selection-dismiss', { dismissSource, hasLongImage: Boolean(longToken), hasRect: Boolean(rect), accepted: true });
  stopViewerDrag();
  closeViewer();
  ++viewerEpoch;
  fullSize = loadedToken = undefined;
  viewerImage.src = '';
  retake.hidden = true;
  longWarning = '';
  longPreview.title = '点击查看完整长图；预览缩放不会改变保存或复制的图片尺寸';
  longPreview.alt = '点击放大查看已接长图';
  origin = undefined;
  dragMode = undefined;
  dragRect = undefined;
  rect = undefined;
  longToken = undefined;
  longPreview.hidden = true;
  releasePointer();
  box.hidden = true;
  veil.hidden = false;
  toolbar.hidden = true;
  document.body.style.cursor = 'crosshair';
  hint.textContent = initialHint;
  if (desktopMode) { syncLongCaptureState(); placeDesktopChrome(); }
  updateActions();
}
function placeToolbar() {
  toolbar.hidden = false;
  const width = toolbar.offsetWidth;
  const height = toolbar.offsetHeight;
  // 单屏时 area 就是整个视口，和原来的 6px 边距完全一致；跨屏时收紧到宿主屏，不画进两屏之间的黑洞。
  const area = hostScreen() ?? { x: 0, y: 0, right: innerWidth, bottom: innerHeight };
  const left = Math.max(area.x + 6, Math.min(area.right - width - 6, rect.x + rect.width - width));
  const below = rect.y + rect.height + 10;
  const top = Math.max(area.y + 6, Math.min(area.bottom - height - 6,
    below + height <= area.bottom - 6 ? below : rect.y - height - 10));
  toolbar.style.left = `${left}px`;
  toolbar.style.top = `${top}px`;
  placeDesktopChrome();
  updateActions();
}

// 原始物理矩形（相对 union 原点）→ 控件用 CSS 投影；视口变化后重算，不缓存旧比例。
function remapDesktopScreens() {
  if (!desktopMode || !desktopFrame || !desktopPhysicalScreens?.length) return;
  desktopScreens = mapDesktopScreens(desktopFrame, desktopPhysicalScreens);
}
function mapDesktopScreens(frame, screens) {
  // 物理 union → 本页 CSS：只做比例映射，保留小数（取整会把控件推出真实屏幕边界）。
  if (!frame || !(frame.width > 0) || !(frame.height > 0) || !Array.isArray(screens) || screens.length === 0) {
    throw new Error('跨屏屏幕信息缺失');
  }
  const sx = innerWidth / frame.width; const sy = innerHeight / frame.height;
  return screens.map(screen => ({ x: screen.x * sx, y: screen.y * sy, width: screen.width * sx, height: screen.height * sy,
    right: (screen.x + screen.width) * sx, bottom: (screen.y + screen.height) * sy }));
}
// 只有完全落在一块屏上的选框才能接长图：按 core/coordinates 的 toPixels 同款 round 左右端点换成物理像素，
// 再要求恰好一块物理屏包住它。边跨 1 像素、屏间空洞、两屏重复覆盖一律拒绝，也不替用户裁框。
function crossScreenSelection() {
  if (!desktopMode || !rect || !desktopFrame || !desktopPhysicalScreens?.length) return false;
  const scaleX = desktopFrame.width / innerWidth, scaleY = desktopFrame.height / innerHeight;
  const left = Math.round(rect.x * scaleX), top = Math.round(rect.y * scaleY);
  const right = Math.round((rect.x + rect.width) * scaleX), bottom = Math.round((rect.y + rect.height) * scaleY);
  if (!(right > left && bottom > top)) return false;
  const owners = desktopPhysicalScreens.filter(screen => screen.x <= left && screen.y <= top &&
    screen.x + screen.width >= right && screen.y + screen.height >= bottom);
  return owners.length !== 1;
}
// 滚轮、↑↓、startScrolling 和长截图提示条统一读这一个状态，拖动/缩放/重框后都能回切。
function syncLongCaptureState() {
  if (desktopMode) document.body.classList.toggle('desktop-cross-selection', crossScreenSelection());
  // 跨屏/单屏切换时录制资格也跟着变，不能等下一次拖框才刷新按钮。
  updateActions();
}
// 录制资格：只要普通、已固定、单屏内的矩形；成图/编辑/长截/录制/忙都不行。
function canRecordGif() {
  return Boolean(ready && !committing && !recording && !editorLoading && !editLocked() && !origin &&
    rect && rect.width >= 2 && rect.height >= 2 && !longToken && !editorDocument && viewer.hidden && !crossScreenSelection());
}
// 录制按钮只跟这套资格走，不改动保存/复制/编辑各自的分工。
function updateActions() {
  if (recordGif) recordGif.disabled = !canRecordGif();
}
function overlapArea(area, screen) {
  const width = Math.min(area.x + area.width, screen.right) - Math.max(area.x, screen.x);
  const height = Math.min(area.y + area.height, screen.bottom) - Math.max(area.y, screen.y);
  return width > 0 && height > 0 ? width * height : 0;
}
function largestScreen() {
  return desktopScreens.reduce((best, screen) =>
    (screen.width * screen.height > best.width * best.height ? screen : best), desktopScreens[0]);
}
// 先选与选区交集最大的屏；选区全在黑洞里就退到指针所在屏；都没有就用面积最大的屏。
function hostScreen() {
  if (!desktopMode || !desktopScreens?.length) return undefined;
  if (rect) {
    let found, best = 0;
    for (const screen of desktopScreens) {
      const area = overlapArea(rect, screen);
      if (area > best) { best = area; found = screen; }
    }
    if (found) return found;
  }
  return largestScreen();
}
// 提示条也跟着宿主屏，不跑到另一块屏或中间的黑底上。
function placeDesktopChrome() {
  if (!desktopMode || !desktopScreens?.length) return;
  const host = hostScreen();
  const room = Math.max(160, host.right - host.x - 32);
  hint.style.maxWidth = `${Math.min(room, innerWidth - 32)}px`;
  hint.style.left = `${(host.x + host.right) / 2}px`;
  hint.style.top = `${host.y + 18}px`;
  hint.style.transform = 'translateX(-50%)';
  if (!viewer.hidden) fitPanelToScreen(viewer);
}
// 整块面板（预览/编辑）只落在一块真实屏幕上；宿主屏放不下就先选最大那块。
function fitPanelToScreen(node) {
  if (!desktopMode || !desktopScreens?.length || !node) return;
  const host = hostScreen();
  const target = host && host.width >= DESKTOP_PANEL_MIN.width && host.height >= DESKTOP_PANEL_MIN.height ? host : largestScreen();
  node.style.left = `${target.x}px`;
  node.style.top = `${target.y}px`;
  node.style.width = `${target.width}px`;
  node.style.height = `${target.height}px`;
  node.style.right = 'auto';
  node.style.bottom = 'auto';
}
const cursors = { new: 'crosshair', move: 'move', n: 'ns-resize', s: 'ns-resize',
  e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };
function hitTest(p) {
  if (!rect || longToken) return 'new';
  const right = rect.x + rect.width, bottom = rect.y + rect.height;
  // 小框也给中间留出移动区，避免两侧命中带把整框占满。
  const marginX = Math.min(8, rect.width / 4), marginY = Math.min(8, rect.height / 4);
  if (p.x < rect.x - marginX || p.x > right + marginX || p.y < rect.y - marginY || p.y > bottom + marginY) return 'new';
  const horizontal = Math.min(Math.abs(p.x - rect.x), Math.abs(p.x - right)) <= marginX
    ? (Math.abs(p.x - rect.x) <= Math.abs(p.x - right) ? 'w' : 'e') : '';
  const vertical = Math.min(Math.abs(p.y - rect.y), Math.abs(p.y - bottom)) <= marginY
    ? (Math.abs(p.y - rect.y) <= Math.abs(p.y - bottom) ? 'n' : 's') : '';
  return vertical + horizontal || 'move';
}
function update(event) {
  const end = point(event), dx = end.x - origin.x, dy = end.y - origin.y;
  if (dragMode === 'new') {
    rect = { x: Math.min(origin.x, end.x), y: Math.min(origin.y, end.y),
      width: Math.abs(dx), height: Math.abs(dy) };
  } else if (dragMode === 'move') {
    rect = { ...dragRect, x: Math.max(0, Math.min(innerWidth - dragRect.width, dragRect.x + dx)),
      y: Math.max(0, Math.min(innerHeight - dragRect.height, dragRect.y + dy)) };
  } else {
    let left = dragRect.x, top = dragRect.y, right = left + dragRect.width, bottom = top + dragRect.height;
    if (dragMode.includes('w')) left = Math.max(0, Math.min(right - 2, left + dx));
    if (dragMode.includes('e')) right = Math.min(innerWidth, Math.max(left + 2, right + dx));
    if (dragMode.includes('n')) top = Math.max(0, Math.min(bottom - 2, top + dy));
    if (dragMode.includes('s')) bottom = Math.min(innerHeight, Math.max(top + 2, bottom + dy));
    rect = { x: left, y: top, width: right - left, height: bottom - top };
  }
  syncLongCaptureState();
  box.style.left = `${rect.x}px`;
  box.style.top = `${rect.y}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
  hint.textContent = `${dimensions()} · 松手固定 · 右键清框`;
}
async function commit(action) {
  if (!ready || committing || exitPending || editorLoading || origin || !rect || rect.width < 2 || rect.height < 2) return;
  clearCandidates();
  stopViewerDrag();
  committing = true;
  save.disabled = saveAs.disabled = copy.disabled = editButton.disabled = true;
  updateActions();
  hint.textContent = action === 'copy' ? '正在复制…' : action === 'save' ? '正在另存并复制…' : '正在保存并复制…';
  // 看长图原图预览时按钮在预览上方，那里也要看到“正在复制…”，否则像点了没反应。
  if (!viewer.hidden) viewerStatus.textContent = hint.textContent;
  try {
    // 编辑文档的成图由主进程向隐藏的编辑窗口取导出结果（同一条合成出口），本页只提交选区与动作。
    const result = await window.selection.commit({ ...rect }, action, longToken);
    if (result?.canceled) {
      committing = false;
      save.disabled = saveAs.disabled = copy.disabled = editButton.disabled = false;
      updateActions();
      hint.textContent = result.message || '已取消保存 · 成图保留，可重新保存或复制';
      if (!viewer.hidden) viewerStatus.textContent = hint.textContent;
      return;
    }
    if (!result?.ok) {
      committing = false;
      save.disabled = saveAs.disabled = copy.disabled = editButton.disabled = false;
      updateActions();
      // 部分成功也要说清楚：主进程给的消息里已带“已保存到…／已复制…”，不笼统说失败。
      hint.textContent = `${result?.message || result?.errors?.join('；') || '操作未完成，请重试'} · 可重试`;
      if (!viewer.hidden) viewerStatus.textContent = hint.textContent;
      return;
    }
  } catch (error) {
    committing = false;
    save.disabled = saveAs.disabled = copy.disabled = editButton.disabled = false;
    updateActions();
    hint.textContent = `未完成：${error.message} · 可重试保存或复制`;
    if (!viewer.hidden) viewerStatus.textContent = hint.textContent;
  } finally {
    // The frame worker has no work left once the selection is committed.
    stopControlWorker();
  }
}
// 成图退出确认：已有成图或编辑文档时，右键和 Esc 不再被忽略，也不再直接丢弃，
// 而是交给主进程弹一次确认。结果回来前锁住按钮与手势；保留时草稿、标注与预览都原样留着，不 reset。
async function requestExit(source) {
  if (exitPending || committing || editLocked()) return false;
  const token = editorDocument?.token ?? longToken;
  if (!token) return false;
  exitPending = true;
  save.disabled = saveAs.disabled = copy.disabled = editButton.disabled = true;
  updateActions();
  try {
    const exited = await window.selection.requestExit(token, source);
    if (exited !== true) hint.textContent = '已保留成图与批注 · 保存或复制成功后退出；重来请点「重新框选」';
    return exited === true;
  } catch (error) {
    hint.textContent = `退出没能确认：${error.message} · 成图与批注仍保留`;
    return false;
  } finally {
    exitPending = false;
    // 退出成功时窗口已销毁，这里重写按钮无副作用；提交中则留给 commit 自己收尾。
    if (!committing) { save.disabled = saveAs.disabled = copy.disabled = editButton.disabled = false; }
    updateActions();
  }
}
(async () => {
  let errorCode = 'selection-init';
  try {
    const payload = await window.selection.init();
    errorCode = 'image-decode';
    if (payload.bmpBytes) {
      // 直接收原图字节做 Blob，省掉一长串 base64 data URL 的解析；解码完立刻回收。
      const blobUrl = URL.createObjectURL(new Blob([payload.bmpBytes], { type: 'image/bmp' }));
      image.src = blobUrl;
      try { await image.decode(); } finally { URL.revokeObjectURL(blobUrl); }
    } else {
      image.src = payload.dataUrl;
      await image.decode();
    }
    windowFrame = payload.windowFrame;
    windowRegions = Array.isArray(payload.windowRegions) ? payload.windowRegions : [];
    if (windowRegions.length) { initialHint = '点击选窗口 · 拖动框选 · Shift 手动 · Esc 退出'; hint.textContent = initialHint; }
    errorCode = 'selection-ready';
    if (payload.mode === 'desktop') {
      // 跨屏：屏幕矩形只用于把控件留在真实屏上，框选坐标仍是本页局部坐标。
      desktopFrame = payload.frame;
      // 原始物理矩形另存一份；控件布局用 CSS 投影，长图判定绝不从投影反推。
      desktopPhysicalScreens = payload.screens.map(({ x, y, width, height }) => ({ x, y, width, height }));
      desktopMode = true;
      remapDesktopScreens();
      initialHint = windowRegions.length ? '点击选窗口 · 拖动框选 · Shift 手动 · Esc 退出' : '拖动框选，可跨屏；选区内滚动接长图 · Esc 退出';
      hint.textContent = initialHint;
      document.body.classList.add('desktop-mode');
      syncLongCaptureState();
    }
    await window.selection.ready();
    ready = true;
    if (typeof globalThis.detectPanelRegions === 'function') setTimeout(() => {
      try { findVisualPanels(); } catch { /* visual fallback is optional */ }
    }, 0);
    if (typeof Worker === 'function') setTimeout(() => {
      try { findVisualControls(); } catch { /* visual fallback is optional */ }
    }, 0);
    // The bounded native MSAA query may still be pending. Pull only after ready and queue the
    // result: the table is adopted by the next eligible pointer move, never by a late repaint.
    try {
      Promise.resolve(window.selection.windowRegionsDetailed?.()).then(patches => {
        if (ready && Array.isArray(patches) && patches.length) pendingWindowRegionDetail = patches;
      }).catch(() => {});
    } catch { /* optional detail failure keeps the fast fallback and is deliberately silent */ }
    updateActions();
    if (desktopMode) {
      // ready 之后窗口才定到 union 尺寸，视口比例可能变，重投影并重算长图入口。
      remapDesktopScreens();
      syncLongCaptureState();
      placeDesktopChrome();
    }
  } catch (error) {
    diagnostic('renderer-error', { errorName: error.name, errorCode });
    await window.selection.cancel('failed');
  }
})();
document.addEventListener('pointerdown', event => {
  if (!ready || committing || exitPending || editLocked() || event.button !== 0 || toolbar.contains(event.target) || !viewer.hidden) return;
  if (longToken || editorDocument) {
    const p = point(event);
    if (p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height) openViewer();
    return;
  }
  if (origin) return;
  origin = point(event);
  candidateDown = candidateAt(origin, event.shiftKey);
  hoverCandidate = undefined;
  dragMode = hitTest(origin);
  dragRect = rect ? { ...rect } : undefined;
  longToken = undefined;
  longPreview.hidden = true;
  document.body.style.cursor = cursors[dragMode];
  pointerId = event.pointerId;
  document.body.setPointerCapture(pointerId);
  toolbar.hidden = true;
  box.hidden = false;
  document.body.classList.toggle('window-hover', Boolean(candidateDown));
  // 候选待定态保留蒙版（配内侧描边）；转手动或固定后才回到旧的「隐藏蒙版 + 外阴影」。
  if (candidateDown) { paintSelection(candidateDown); veil.hidden = false; }
  else { veil.hidden = true; update(event); }
});
document.addEventListener('pointermove', event => {
  if (!ready || committing || exitPending || editLocked() || !viewer.hidden) return;
  if (origin) {
    if (event.pointerId !== pointerId) return;
    if (candidateDown && Math.hypot(event.clientX-origin.x,event.clientY-origin.y) > 3) candidateDown = undefined;
    if (!candidateDown) {
      document.body.classList.remove('window-hover');
      veil.hidden = true;
      update(event);
    }
  } else {
    // Adopt a queued detail result here and only here: no fixed rectangle, no manual Shift, no
    // editor document and no viewer, so this move can show the new table without contradicting
    // a selection the user already made from the visible fallback.
    if (pendingVisualPanels && !rect && !event.shiftKey && !longToken && !editorDocument) {
      visualPanels = pendingVisualPanels; pendingVisualPanels = undefined;
    }
    if (pendingVisualControls && !rect && !event.shiftKey && !longToken && !editorDocument) {
      visualControls = pendingVisualControls; pendingVisualControls = undefined;
    }
    if (pendingWindowRegionDetail && !rect && !event.shiftKey && !longToken && !editorDocument) {
      const patch = pendingWindowRegionDetail;
      pendingWindowRegionDetail = undefined;
      applyWindowRegionDetailPatch(patch);
    }
    hoverAt(event);
    document.body.style.cursor = longToken || editorDocument ? 'default' : cursors[hitTest(point(event))];
  }
});
document.addEventListener('pointerup', event => {
  if (!origin || committing || event.button !== 0 || event.pointerId !== pointerId) return;
  if (candidateDown && Math.hypot(event.clientX-origin.x,event.clientY-origin.y) <= 3) {
    rect = { ...candidateDown }; paintSelection(rect); syncLongCaptureState();
  } else update(event);
  // 固定后沿用旧路径：蒙版隐藏、框用外阴影，和手动框选完全一致。
  veil.hidden = true;
  clearCandidates();
  diagnostic('selection-input', { width: rect.width, height: rect.height, mode: dragMode });
  origin = undefined;
  dragMode = undefined;
  dragRect = undefined;
  releasePointer();
  document.body.style.cursor = cursors[hitTest(point(event))];
  if (rect.width < 2 || rect.height < 2) {
    clearSelection('tiny-selection');
    hint.textContent = '选区太小，重新拖动框选 · 右键 / Esc 退出';
    return;
  }
  // 松手只固定选区；只有显式点击或回车才触发文件／剪贴板写入。
  hint.textContent = crossScreenSelection()
    ? `${dimensions()} · ${CROSS_SCROLL_MESSAGE} · 回车复制 · Esc 退出`
    : `${dimensions()} · 回车复制并退出 · Esc 退出`;
  placeToolbar();
});
function cancelSelectionGesture(event) {
  if (event && pointerId !== undefined && event.pointerId !== pointerId) return;
  if (origin && !committing) clearSelection('pointer-cancel');
  else clearCandidates();
}
document.addEventListener('pointercancel', cancelSelectionGesture);
document.addEventListener('lostpointercapture', event => { if (pointerId !== undefined) cancelSelectionGesture(event); });
window.addEventListener?.('blur', () => { stopViewerDrag(); cancelSelectionGesture(); });
// 录制取消后主进程会把选区页重新亮出来：恢复工具条，让用户能重选或再录一次。
window.addEventListener?.('focus', () => {
  if (!recording) return;
  recording = false;
  committing = false;
  save.disabled = saveAs.disabled = copy.disabled = editButton.disabled = false;
  updateActions();
  hint.textContent = '已退出录制，可以重新选择或再录一次';
});
document.addEventListener('contextmenu', event => {
  event.preventDefault();
  if (!ready || committing || exitPending || editLocked() || !viewer.hidden) return;
  // 成图/编辑稿：右键不再被忽略，也不再直接清图，而是申请一次带确认的退出。
  // 主进程先问「保留截图 / 放弃退出」，确认后才按取消语义结束；拒绝时选框、标注和预览都不动。
  if (longToken || editorDocument) { diagnostic('selection-dismiss', { dismissSource: 'context-menu', hasLongImage: true, accepted: false }); requestExit('context-menu'); return; }
  if (origin || rect) clearSelection('context-menu');
  else window.selection.cancel('context-menu');
});
document.addEventListener('keyup', event => {
  if (event.key === 'Shift' && ready && !committing && !exitPending && !origin && !rect) hint.textContent = initialHint;
});
document.addEventListener('keydown', event => {
  if (event.key === 'Shift' && ready && !committing && !exitPending && !editLocked() && !rect) {
    if (origin) {
      // 候选待定态里按 Shift：立刻转手动，回到旧的遮罩路径，框回到按下点由下一次移动重画。
      candidateDown = undefined;
      document.body.classList.remove('window-hover');
      veil.hidden = true;
      paintSelection({x: origin.x, y: origin.y, width: 0, height: 0});
    } else clearCandidates();
    hint.textContent = 'Shift 手动框选';
  }
  // 退出确认期间不接任何快捷键：结果回来前不能重框、重开、提交或二次申请。
  if (exitPending) { if (['Escape', 'Enter', ' '].includes(event.key)) event.preventDefault(); return; }
  if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
    if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey ||
        !ready || committing || origin || !rect || longToken || editorDocument || !viewer.hidden || editLocked() ||
        toolbar.contains(event.target)) return;
    event.preventDefault();
    if (crossScreenSelection()) { hint.textContent = CROSS_SCROLL_MESSAGE; return; }
    return startScrolling({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  }
  if (editLocked()) { if (['Escape', 'Enter'].includes(event.key)) event.preventDefault(); return; }
  if (editorDocument && event.key === 'Escape') {
    event.preventDefault(); if (!event.repeat && !committing) requestExit('escape-key'); return;
  }
  if (event.target === editButton) return;
  if (!viewer.hidden && event.key === 'Tab') {
    const controls = [zoomOut, zoomIn, zoomFit, zoomOriginal, document.querySelector('#viewer-close'), viewport, retake, editButton, save, copy]
      .filter(node => !node.hidden && !node.disabled);
    const at = controls.indexOf(event.target);
    if (at < 0 || (!event.shiftKey && at === controls.length - 1) || (event.shiftKey && at === 0)) {
      event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0].focus();
    }
    return;
  }
  if (longToken && event.key === 'Escape') {
    event.preventDefault();
    if (event.repeat || committing) return;
    if (!viewer.hidden) closeViewer(); else requestExit('escape-key');
    return;
  }
  if ((longToken || editorDocument) && event.target === longPreview && ['Enter', ' '].includes(event.key)) {
    event.preventDefault(); if (!event.repeat) openViewer(); return;
  }
  if (event.key !== 'Enter' || event.repeat || viewer.contains(event.target) || event.target === retake) return;
  // 焦点在保存按钮时，保留原生回车激活保存；其余位置默认复制。
  if (event.target === save || event.target === saveAs) return;
  event.preventDefault();
  commit('copy');
});
save.addEventListener('click', () => commit('save-quick'));
saveAs.addEventListener('click', () => commit('save'));
copy.addEventListener('click', () => commit('copy'));
recordGif.addEventListener('click', startRecording);
recordVideo?.addEventListener('click', startVideoRecording);

document.addEventListener('wheel', async event => {
  if (exitPending || editLocked()) return;
  if (editorDocument && viewer.hidden) { event.preventDefault(); hint.textContent = '成图与编辑已保留 · 点击「编辑」查看或继续标注；重来请点「重新框选」'; return; }
  if (!viewer.hidden) {
    stopViewerDrag();
    if (event.ctrlKey || event.metaKey) { event.preventDefault(); setZoom(zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15)); }
    return;
  }
  const p = point(event);
  const inside = Boolean(rect && p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height);
  diagnostic('wheel', { ready, drawing: Boolean(origin), committing, inside, hasRect: Boolean(rect), hasLongImage: Boolean(longToken),
    accepted: Boolean(ready && !committing && !origin && rect && event.deltaY !== 0 && inside && !toolbar.contains(event.target) && !longToken) });
  if (!ready || committing || origin || !rect || !event.deltaY || toolbar.contains(event.target)) return;
  if (p.x < rect.x || p.x > rect.x + rect.width || p.y < rect.y || p.y > rect.y + rect.height) return;
  event.preventDefault();
  // 先看成图：视口比例变化可能让原框重算成跨屏，不能把完成图或未完整警告盖成跨屏提示。
  if (longToken) { hint.textContent = longWarning ? `本次长图仅保留已接部分：${longWarning} · 保存或复制成功后退出；重来请点「重新框选」。` : '本次长图已完成 · 保存或复制成功后退出；重来请点「重新框选」。'; return; }
  // 选框跨了屏或落进屏间空洞：合成图不是可滚动窗口，滚轮不接长图；静态保存/复制照常。
  if (crossScreenSelection()) { hint.textContent = CROSS_SCROLL_MESSAGE; return; }
  return startScrolling(p);
}, { passive: false });
async function startRecording(event) {
  clearCandidates();
  // 有编辑稿时不能悄悄丢掉转去录制：先把选择交回给用户。
  if (editorDocument) {
    hint.textContent = '编辑内容尚未保存，不能直接转 GIF 录制：请先保存或复制，或点「重新框选」';
    return;
  }
  // 与长截图同一套前置门：成图/编辑中/忙/拖动中都不接，防双击。
  if (!ready || committing || recording || origin || !rect || rect.width < 2 || rect.height < 2 ||
      longToken || !viewer.hidden || editLocked()) return;
  if (crossScreenSelection()) { hint.textContent = RECORD_CROSS_MESSAGE; return; }
  recording = true;
  committing = true;
  document.body.style.cursor = 'default';
  save.disabled = saveAs.disabled = copy.disabled = editButton.disabled = true;
  updateActions();
  hint.textContent = '正在开启 GIF 录制…';
  try {
    // 只交选区：主进程隐藏本窗、开独立录制浮条，本页不操纵录制窗口。
    const result = await window.selection.beginRecord({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    // 两段式：主进程先建窗、亮出录制浮条，等用户在浮条上点「开始」才真正采屏。
    if (result?.ready !== true && result?.started !== true) throw new Error('录制没有开始，请重试');
    // 进入录制准备：把本页的工具条和提示收掉，屏上只留选区框与录制浮条。
    toolbar.hidden = true;
    hint.textContent = 'GIF 录制已就绪 · 在浮条上点「开始」才开录';
  } catch (error) {
    recording = false;
    committing = false;
    document.body.style.cursor = event ? cursors[hitTest(point(event))] : 'default';
    save.disabled = saveAs.disabled = copy.disabled = editButton.disabled = false;
    updateActions();
    hint.textContent = `GIF 录制未开始：${error.message}`;
  }
}
async function startVideoRecording(event) {
  clearCandidates();
  // 与 GIF 录制同一套前置门：有编辑稿、成图中、拖动中都不接，防双击。
  if (editorDocument) {
    hint.textContent = '编辑内容尚未保存，不能直接转视频录制：请先保存或复制，或点「重新框选」';
    return;
  }
  if (!ready || committing || recording || origin || !rect || rect.width < 2 || rect.height < 2 ||
      longToken || !viewer.hidden || editLocked()) return;
  // 视频录制只支持单屏内的选区：跨屏不合成一块画面。
  if (crossScreenSelection()) { hint.textContent = '视频录制只支持单屏内的选区'; return; }
  recording = true;
  committing = true;
  document.body.style.cursor = 'default';
  save.disabled = saveAs.disabled = copy.disabled = editButton.disabled = true;
  updateActions();
  hint.textContent = '正在开启视频录制…';
  try {
    const result = await window.selection.beginVideo({
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
    if (result?.started !== true) throw new Error('录制没有开始，请重试');
    hint.textContent = '视频录制已准备 · 请在指示条选择声音并开始';
  } catch (error) {
    recording = false;
    committing = false;
    document.body.style.cursor = event ? cursors[hitTest(point(event))] : 'default';
    save.disabled = saveAs.disabled = copy.disabled = editButton.disabled = false;
    updateActions();
    const message = String(error?.message || '请重试').replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
    hint.textContent = `视频录制未开始：${message}`;
  }
}
async function startScrolling(p) {
  clearCandidates();
  // 旧资格门先退：已成图/编辑中/采集中都不改提示、不重开。
  if (!ready || committing || origin || !rect || longToken || editorDocument || !viewer.hidden || editLocked()) return;
  if (crossScreenSelection()) { hint.textContent = CROSS_SCROLL_MESSAGE; return; }
  const epoch = ++scrollEpoch;
  document.body.style.cursor = 'default';
  committing = true;
  save.disabled = saveAs.disabled = copy.disabled = true;
  updateActions();
  hint.textContent = '正在开启长截图，等选区界面收起后，鼠标放正文内用滚轮或 ↑↓ 滚动；用浮条或托盘完成。';
  try {
    const result = await window.selection.beginScroll({ ...rect });
    if(result?.canceled&&epoch===scrollEpoch){
      committing=false;document.body.style.cursor=cursors[hitTest(p)];save.disabled=saveAs.disabled=copy.disabled=false;updateActions();
      hint.textContent='已返回框选 · 可再试长截图';return;
    }
    if (!result?.started && epoch === scrollEpoch) throw new Error('长截图没有开始，请重试');
  } catch (error) {
    if (epoch !== scrollEpoch) return;
    committing = false;
    document.body.style.cursor = cursors[hitTest(p)];
    save.disabled = saveAs.disabled = copy.disabled = false;
    updateActions();
    diagnostic('worker-error', { errorName: error.name, errorMessage: error.message });
    hint.textContent = `长截图未开始：${error.message}`;
  }
}
// 屏幕重置或视口变化后，物理↔CSS 比例与控件位置都要重算。
window.addEventListener?.('resize', () => {
  cancelSelectionGesture();
  if (!desktopMode) return;
  remapDesktopScreens();
  syncLongCaptureState();
  if (rect && !toolbar.hidden) placeToolbar(); else placeDesktopChrome();
});
window.selection.onScrollComplete(async result => {
  const epoch = ++scrollEpoch;
  if (!result.ok) {
    committing = false;
    save.disabled = saveAs.disabled = copy.disabled = false;
    updateActions();
    hint.textContent = result.message;
    return;
  }
  committing = true;
  save.disabled = saveAs.disabled = copy.disabled = true;
  updateActions();
  let errorCode = 'preview-layout';
  try {
    if (!rect) throw new Error('预览选区已失效');
    longToken = result.token;
    longWarning = result.warning || '';
    longPreview.src = result.preview;
    longPreview.style.left = `${rect.x}px`;
    longPreview.style.top = `${rect.y}px`;
    longPreview.style.width = `${rect.width}px`;
    longPreview.style.height = `${rect.height}px`;
    longPreview.hidden = false;
    // 框选阴影随选框一起隐藏，缩略图阶段改由底层暗幕隔开背景；成图仍绘制在暗幕上方。
    veil.hidden = false;
    box.hidden = true;
    document.body.style.cursor = 'default';
    hint.textContent = '正在打开长图预览…尚未保存';
    placeToolbar();
    errorCode = 'preview-decode';
    let thumbnailFailed = false;
    try { await longPreview.decode(); }
    catch (error) {
      if (epoch !== scrollEpoch) return;
      thumbnailFailed = true;
      longPreview.alt = '缩略图未能显示，点击查看原图';
      diagnostic('renderer-error', { errorName: error.name, errorCode });
    }
    if (epoch !== scrollEpoch) return;
    errorCode = 'preview-layout';
    await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
    if (epoch !== scrollEpoch) return;
    if (!await window.selection.previewReady(result.token)) throw new Error('预览事务已失效');
    if (epoch !== scrollEpoch) return;
    committing = false;
    save.disabled = saveAs.disabled = copy.disabled = false;
    retake.hidden = false;
    updateActions();
    hint.textContent = `${result.width} × ${result.height} 像素 · ${result.warning ? `仅保留已接部分：${result.warning} · ` : ''}${thumbnailFailed ? '缩略图未能显示，点击查看原图；仍可保存或复制' : '长图已完成 · 点击图片放大查看'} · 尚未保存`;
  } catch (error) {
    if (epoch !== scrollEpoch) return;
    diagnostic('renderer-error', { errorName: error.name, errorCode });
    await window.selection.cancel('failed').catch(() => {});
  }
});

