'use strict';
// GIF 录制控制页：只读主进程推来的状态与最终 GIF 字节。
// 这一页不采屏、不做直播预览、不请求任意 IPC；文字只走 textContent，图片只走 blob: URL。
const MAX_GIF_BYTES = 48 * 1024 * 1024;
const MAX_EDGE = 4096;
const MAX_PIXELS = 4_000_000;
const MODES = new Set(['starting', 'recording', 'finishing', 'preview', 'saving', 'error']);
const LABELS = { starting: '准备中…', recording: '录制中', finishing: '正在生成 GIF…', preview: 'GIF 预览', saving: '正在保存…', error: '录制未完成' };
const MESSAGES = { starting: '正在准备录制，请稍候', recording: '选区内正在录制 · 「停止」或 Esc 结束',
  finishing: '正在编码 GIF，请稍候', preview: '', saving: '正在保存 GIF，请稍候', error: '这次录制没有完成，可以重新录制或关闭' };

const recordSection = document.querySelector('#record');
const previewSection = document.querySelector('#preview');
const heading = document.querySelector('#mode');
const timer = document.querySelector('#timer');
const stopButton = document.querySelector('#stop');
const cancelButton = document.querySelector('#cancel');
const recordRetry = document.querySelector('#record-retry');
const sizeText = document.querySelector('#size');
const message = document.querySelector('#message');
const previewImage = document.querySelector('#image');
const previewStatus = document.querySelector('#preview-status');
const saveButton = document.querySelector('#save');
const saveAsButton = document.querySelector('#save-as');
const copyButton = document.querySelector('#copy');
const retryButton = document.querySelector('#retry');
const closeButton = document.querySelector('#close');

let mode = 'starting';
let elapsedMs = 0;
let busy = false;
let actionError = '';
let serverMessage = '';
let sizeLabel = '等待选区';
let blobUrl = '';
let shot = null;
let previewBytes = null;
const editButton = document.querySelector('#edit');
const editorRoot = document.querySelector('#gif-editor');
let gifEditor = null;

const bridge = window.gifRecorder && typeof window.gifRecorder.ready === 'function' ? window.gifRecorder : null;
if (editorRoot && bridge && typeof window.createGifEditor === 'function') {
  gifEditor = window.createGifEditor({ root: editorRoot, bridge,
    onClose: () => render(), onStatus: text => { actionError=text; render(); } });
}
const isEdge = value => Number.isSafeInteger(value) && value > 0 && value <= MAX_EDGE;
const formatElapsed = ms => {
  const seconds = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};
const formatBytes = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

function revokeShot() {
  if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch { /* 已经回收过 */ } blobUrl = ''; }
  if (typeof previewImage.removeAttribute === 'function') previewImage.removeAttribute('src');
  else previewImage.src = '';
  shot = null; previewBytes = null;
}

function render() {
  const inPreview = mode === 'preview' || mode === 'saving';
  // 生成/保存中只留一个取消出口，让主进程判断能不能打断；不靠本地猜测。
  const disabled = busy || mode === 'saving' || Boolean(gifEditor?.isOpen);
  const editing = Boolean(gifEditor?.isOpen && !gifEditor?.isLoading);
  recordSection.hidden = inPreview || editing;
  previewSection.hidden = !inPreview || editing;
  if (editButton) editButton.disabled = disabled || editing || !shot?.sourceId || !gifEditor || !window.ImageDecoder || typeof bridge?.edit !== 'function';
  heading.textContent = (mode === 'saving' && serverMessage) || LABELS[mode] || LABELS.starting;
  timer.hidden = mode === 'starting' || inPreview;
  timer.textContent = formatElapsed(elapsedMs);
  sizeText.textContent = sizeLabel;
  message.textContent = (inPreview ? '' : actionError) || (mode === 'error' && serverMessage ? serverMessage : MESSAGES[mode] || '');
  stopButton.hidden = mode !== 'recording';
  stopButton.disabled = disabled;
  recordRetry.hidden = mode !== 'error';
  recordRetry.disabled = disabled;
  cancelButton.hidden = inPreview;
  cancelButton.disabled = disabled;
  cancelButton.textContent = mode === 'error' ? '关闭' : '取消';
  saveButton.disabled = disabled;
  saveAsButton.disabled = disabled;
  copyButton.disabled = disabled;
  retryButton.disabled = disabled;
  closeButton.disabled = disabled;
  // 预览/保存时 #message 在被隐藏的录制段里，错误与主进程消息必须落到可见的 #preview-status：
  // 顺序是「本次动作的错误 > 主进程消息（如取消保存）> 尺寸/时长/体积」，一趟 filter 拼完，不隐藏预览。
  previewStatus.textContent = [mode === 'saving' ? (serverMessage || '正在保存 GIF，请稍候') : (actionError || (inPreview ? serverMessage : '')),
    shot ? `${shot.width} × ${shot.height} 像素` : '',
    shot ? formatElapsed(shot.elapsedMs) : '',
    shot ? formatBytes(shot.bytes) : ''].filter(Boolean).join(' · ') || '—';
}

function applyStatus(status) {
  if (!status || typeof status !== 'object' || !MODES.has(status.mode)) return;
  mode = status.mode;
  if (Number.isFinite(status.elapsedMs)) elapsedMs = Math.max(0, status.elapsedMs);
  if (isEdge(status.width) && isEdge(status.height)) sizeLabel = `${status.width} × ${status.height} 像素`;
  serverMessage = typeof status.message === 'string' ? status.message : '';
  if (mode !== 'error') actionError = '';
  // 状态通知不能抢先释放尚未回包的动作；busy 由 request 的 finally 收尾。
  render();
}

// 只认有界 Uint8Array 的 GIF 字节与合法尺寸；不合规就保持原界面，不设 src。
function applyPreview(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const bytes = payload.bytes;
  if (!ArrayBuffer.isView(bytes) || bytes.BYTES_PER_ELEMENT !== 1) return false;
  const length = bytes.byteLength;
  if (length === 0 || length > MAX_GIF_BYTES) return false;
  if (!isEdge(payload.width) || !isEdge(payload.height) || payload.width * payload.height > MAX_PIXELS) return false;
  gifEditor?.reset({ committed: true });
  revokeShot();
  previewBytes = new Uint8Array(bytes);
  const blob = new Blob([bytes], { type: 'image/gif' });
  blobUrl = URL.createObjectURL(blob);
  previewImage.src = blobUrl;
  shot = { sourceId: typeof payload.sourceId === 'string' ? payload.sourceId : null, width: payload.width, height: payload.height, bytes: length,
    elapsedMs: Number.isFinite(payload.elapsedMs) && payload.elapsedMs > 0 ? payload.elapsedMs : elapsedMs };
  mode = 'preview';
  actionError = '';
  render();
  return true;
}

async function request(action) {
  if (!bridge || busy || mode === 'saving' || gifEditor?.isOpen) return false;
  busy = true;
  actionError = '';
  render();
  let ok = true;
  try {
    await bridge.action(action);
  } catch (error) {
    ok = false;
    actionError = `操作未完成：${error && error.message ? error.message : '请重试'}`;
  } finally {
    busy = false;
    render();
  }
  return ok;
}

async function requestRetry() {
  if (!bridge || busy || mode === 'saving' || gifEditor?.isOpen) return;
  // 先放掉上一段 GIF，再请主进程重来：失败也不会留着一个指向已释放 URL 的图。
  revokeShot();
  mode = 'starting';
  elapsedMs = 0;
  // 重录没成也要留出口：回到错误态，重录与关闭两个按钮都还能按。
  if (!await request('retry')) { mode = 'error'; render(); }
}

editButton?.addEventListener('click', async () => {
  if (editButton.disabled || !shot || !previewBytes) return;
  editButton.disabled=true;
  await gifEditor.open({ ...shot, bytes:previewBytes }); render();
});
stopButton.addEventListener('click', () => request('stop'));
cancelButton.addEventListener('click', () => request('cancel'));
recordRetry.addEventListener('click', requestRetry);
saveButton.addEventListener('click', () => request('save-quick'));
saveAsButton.addEventListener('click', () => request('save'));
copyButton.addEventListener('click', () => request('copy'));
retryButton.addEventListener('click', requestRetry);
closeButton.addEventListener('click', () => request('cancel'));

// Esc 只在录制中停止、预览中关闭；其余阶段交给主进程判断，也不抢默认 Tab 焦点。
document.addEventListener('keydown', event => {
  if (gifEditor?.isOpen || gifEditor?.busy) return;
  if (event.key !== 'Escape' || event.repeat) return;
  if (mode === 'recording') { event.preventDefault(); request('stop'); return; }
  if (mode === 'preview') { event.preventDefault(); request('cancel'); }
});
window.addEventListener('beforeunload', revokeShot);

if (!bridge) {
  mode = 'error';
  actionError = '录制界面未能连接主进程，请关闭后重试';
} else {
  // 先订阅再 ready：ready 只回当前状态，已在预览时主进程会另发一次 preview。
  bridge.onStatus(applyStatus);
  bridge.onPreview(applyPreview);
  (async () => {
    try {
      const status = await bridge.ready();
      if (status) applyStatus(status);
    } catch (error) {
      actionError = `无法读取录制状态：${error && error.message ? error.message : '请重试'}`;
      render();
    }
  })();
}
render();
