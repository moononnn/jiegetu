'use strict';
const height = document.querySelector('#height');
const message = document.querySelector('#message');
const finish = document.querySelector('#finish');
const cancel = document.querySelector('#cancel');
const preview = document.querySelector('#preview');
const previewImage = document.querySelector('#preview-image');
const previewFrame = document.querySelector('#preview-frame');
const previewNote = document.querySelector('#preview-note');
const viewport = document.querySelector('#viewport');
const positionStatus = document.querySelector('#position-status');
const reference = document.querySelector('#reference');
const referenceTitle = document.querySelector('#reference-title');
const referenceImage = document.querySelector('#reference-image');
let request = 0, target = null, displayed = null, currentViewport = null, receivedStatus = false, totalHeight = 0;
const positive = value => Number.isSafeInteger(value) && value > 0;

// Validate the PNG header before decoding; no screenshot pixels are logged or persisted.
function validPng(image, maxWidth, maxHeight) {
  if (!image || !positive(image.width) || image.width > maxWidth ||
      !positive(image.height) || image.height > maxHeight ||
      typeof image.dataUrl !== 'string' || image.dataUrl.length > 2000000 ||
      !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image.dataUrl) ||
      (image.dataUrl.length - 22) % 4 !== 0) return false;
  try {
    const bytes = atob(image.dataUrl.slice(22));
    const uint32 = offset => (bytes.charCodeAt(offset) * 16777216 + bytes.charCodeAt(offset + 1) * 65536 + bytes.charCodeAt(offset + 2) * 256 + bytes.charCodeAt(offset + 3));
    return bytes.length >= 33 && bytes.slice(0, 8) === '\x89PNG\r\n\x1a\n' &&
      uint32(8) === 13 && bytes.slice(12, 16) === 'IHDR' &&
      uint32(16) === image.width && uint32(20) === image.height;
  } catch { return false; }
}
function hideReference() {
  reference.hidden = true;
  referenceImage.removeAttribute('src');
}
function hidePreview(note) {
  displayed = null;
  preview.hidden = true;
  viewport.hidden = true;
  previewImage.removeAttribute('src');
  previewNote.textContent = note;
}
function drawViewport() {
  viewport.hidden = true;
  if (!displayed) return;
  // Encoding can lag behind capture. Even a dashed new viewport belongs to the
  // new output coordinates, so never draw it on a previously encoded image.
  if (displayed.sourceHeight !== totalHeight) {
    positionStatus.textContent = '待更新';
    return;
  }
  const view = currentViewport;
  const valid = view && Number.isSafeInteger(view.top) && view.top >= 0 && positive(view.height) && typeof view.matched === 'boolean';
  positionStatus.textContent = valid && view.matched ? '当前位置' : '待匹配';
  if (!valid) return;
  // object-fit:contain letterboxes both axes. Overlay only the actual painted image.
  const box = previewFrame.getBoundingClientRect();
  const scale = Math.min(box.width / displayed.width, box.height / displayed.height);
  if (!(scale > 0) || !Number.isFinite(scale)) return;
  const width = displayed.width * scale, imageHeight = displayed.height * scale;
  const frameHeight = Math.min(imageHeight, Math.max(6, Math.min(view.height / displayed.sourceHeight, 1) * imageHeight));
  const top = Math.max(0, Math.min(imageHeight - frameHeight, view.top / displayed.sourceHeight * imageHeight));
  viewport.style.left = `${(box.width - width) / 2}px`;
  viewport.style.top = `${(box.height - imageHeight) / 2 + top}px`;
  viewport.style.width = `${width}px`;
  viewport.style.height = `${frameHeight}px`;
  viewport.style.borderWidth = `${Math.min(2, width / 2, frameHeight / 2)}px`;
  viewport.setAttribute('data-matched', String(view.matched));
  viewport.hidden = false;
}
async function loadImage(image, token, full) {
  const decoded = new Image();
  try {
    decoded.src = image.dataUrl;
    await decoded.decode();
    if (token !== request) return;
    if (decoded.naturalWidth !== image.width || decoded.naturalHeight !== image.height) throw new Error('dimensions');
    if (full) {
      displayed = image;
      previewImage.src = image.dataUrl;
      preview.hidden = false;
      previewNote.textContent = '';
      drawViewport();
    } else {
      referenceImage.src = image.dataUrl;
      reference.hidden = false;
      previewNote.textContent = '';
    }
  } catch {
    if (token !== request) return;
    if (full) { target = null; hidePreview('长图预览暂不可用'); }
    else { hideReference(); previewNote.textContent = '局部参照暂不可用'; }
  }
}
function updatePreview(state) {
  // Missing viewport is unknown, not permission to retain an earlier match.
  currentViewport = state.viewport || null;
  if (Object.prototype.hasOwnProperty.call(state, 'preview')) {
    const image = state.preview;
    const valid = validPng(image, 240, 480) && positive(image.sourceHeight);
    const same = valid && target && target.dataUrl === image.dataUrl && target.width === image.width && target.height === image.height && target.sourceHeight === image.sourceHeight;
    if (same) { drawViewport(); return; }
    const token = ++request;
    target = valid ? {dataUrl:image.dataUrl, width:image.width, height:image.height, sourceHeight:image.sourceHeight} : null;
    hideReference();
    if (valid && displayed) {
      // 解码期间保留上一张图；若源高度不同，只暂时隐藏位置框，避免连续滚动时整图闪空。
      previewNote.textContent = '正在更新长图预览';
      drawViewport();
    } else hidePreview(valid ? '正在更新长图预览' : '长图预览暂不可用');
    if (valid) void loadImage(target, token, true);
    return;
  }
  if (target) {
    drawViewport();
    return;
  }
  // Legacy protocol only: never label the bottom sample as a complete image.
  const token = ++request;
  hideReference();
  hidePreview('等待长图预览');
  if (!validPng(state.reference, 960, 320)) return;
  referenceTitle.textContent = state.added > 0 ? '最后接上的局部参照 · 非完整图' : '起始局部参照 · 尚未接长';
  referenceImage.alt = referenceTitle.textContent;
  void loadImage({...state.reference}, token, false);
}
previewImage.onerror = () => { ++request; target = null; hidePreview('长图预览暂不可用'); };
referenceImage.onerror = hideReference;
new ResizeObserver(drawViewport).observe(previewFrame);
// No pointer passthrough or preview navigation: scroll with the mouse back in the selection.
document.addEventListener('contextmenu', event => { event.preventDefault(); cancel.click(); });
function show(state) {
  if (!state || typeof state !== 'object') return;
  if (Object.prototype.hasOwnProperty.call(state, 'height')) {
    totalHeight = Number.isSafeInteger(state.height) && state.height >= 0 ? state.height : 0;
  }
  height.textContent = `已截 ${totalHeight} 像素`;
  message.textContent = typeof state.message === 'string' ? state.message.slice(0, 500) : '';
  finish.disabled = state.canFinish !== true;
  updatePreview(state);
}
window.scrollBar.onStatus(state => { receivedStatus = true; show(state); });
window.scrollBar.state().then(state => { if (!receivedStatus) show(state); }).catch(() => {
  if (!receivedStatus) message.textContent = '状态暂不可用';
});
finish.onclick = async () => {
  finish.disabled = true;
  message.textContent = '正在生成长图，请稍候…';
  try { await window.scrollBar.finish(); }
  catch (error) { message.textContent = error.message; finish.disabled = false; }
};
cancel.onclick = () => window.scrollBar.cancel().catch(error => { message.textContent = error.message; });
