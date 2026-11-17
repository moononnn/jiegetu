/* 跨图批注工作台页面：所有像素合成都在这里，main 只持权威组与导出计划。
   预览与导出共用同一个“先画原图、再烧遮盖、最后画框/编号”的顺序，
   没有任何一路直接拿私有原 blob 绕开 mask。 */
(() => {
  'use strict';
  const Group = window.AnnotationGroup;
  const host = window.workspaceHost;
  const el = id => document.getElementById(id);

  const stage = el('stage');
  const world = el('world');
  const imagesLayer = el('images');
  const links = el('links');
  const composer = el('composer');
  const composerText = el('composerText');
  const composerHint = el('composerHint');
  const saveState = el('saveState');
  const titleInput = el('groupTitle');
  const hint = el('hint');
  const banner = el('banner');
  const bannerText = el('bannerText');
  const fileInfo = el('fileInfo');
  const exportInfo = el('exportInfo');
  const zoomLabel = el('zoomLabel');
  const maskColor = '#ffffff';
  const LINK_PAD = 60;

  const state = {
    group: undefined,
    revision: 0,
    view: { panX: 0, panY: 0, zoom: 1 },
    tool: 'select',
    activeImageId: undefined,
    activeNoteId: undefined,
    activeTargetId: undefined,
    // 选中的目标（最多两处）：常规点击单选，Shift 点击加/取消，用来“关联所选”。
    selection: [],
    // 已选中的关系：两端一起高亮，可以改文字或解除。
    activeRelationId: undefined,
    bits: new Map(),
    draft: undefined,
    drag: undefined,
    linking: undefined,
    // 已点「关联…」：下一次点到已有目标就把它当作另一端。
    linkPick: undefined,
    // 已点「再指一处」：下一笔落在图上就归到这条意见。
    aim: undefined,
    editing: undefined,
    // 输入框里有还没提交的字：这也要让主进程知道有未保存编辑，否则标题×关窗会连问都不问。
    inputDirty: false,
    history: Group.createHistory(),
    saving: false,
    // 保存工作者：并发请求只跑一个循环；保存屏障 await 它。
    saveWorker: undefined,
    saveWanted: false,
    // 模型代次：每次模型变化 +1，回包对不上就不算存好了。
    modelSeq: 0,
    // 上一次保存失败时的代次：模型没再变就先不重试，免得“重试成功”掩盖真问题。
    failedSeq: -1,
    saveTimer: undefined,
    dirty: false,
    saveFailed: false,
    busy: false,
    space: false,
    lastSaveAt: 0,
    loaded: false,
    // 导出代次：每次开始 +1，停止也 +1；异步回来看到对不上就丢弃。
    exportGen: 0,
    exportCanceled: false,
    exportBatch: undefined
  };

  const nodeMap = new Map(); // imageId -> {root, base, marks, label}
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // —— 坐标 ——
  const toWorld = (screenX, screenY) => ({ x: (screenX - state.view.panX) / state.view.zoom, y: (screenY - state.view.panY) / state.view.zoom });
  const toScreen = worldPoint => ({ x: worldPoint.x * state.view.zoom + state.view.panX, y: worldPoint.y * state.view.zoom + state.view.panY });
  const stagePointOf = event => {
    const rect = stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const imageById = id => state.group?.images.find(image => image.id === id);
  const imageNumberOf = id => (state.group.images.findIndex(image => image.id === id) + 1);
  const noteNumberOf = id => (state.group.notes.findIndex(note => note.id === id) + 1);

  // —— 状态栏 ——
  function setSaveState(tone, detail) {
    const map = { saved: '已保存', saving: '正在保存…', failed: '保存失败', dirty: '还没保存' };
    saveState.textContent = map[tone] || '';
    saveState.dataset.tone = tone;
    if (tone === 'failed') saveState.title = detail ? String(detail.message || detail) : '保存失败';
    else saveState.title = '';
  }
  function setHint(text) { hint.textContent = text; }
  function setExportInfo(text, tone) {
    exportInfo.textContent = text || '';
    exportInfo.dataset.tone = tone || '';
  }

  // —— 模型应用 ——
  function pushDirty() {
    host.setDirty(state.dirty === true || state.inputDirty === true).catch(() => {});
  }

  function apply(next, { remember = true, save = true } = {}) {
    const validated = Group.validate(next);
    if (remember) state.history.remember(state.group);
    state.group = validated;
    state.modelSeq += 1;
    // state.revision 只跟主进程落库的版本走；文档里的 revision 不是本地版本号。
    state.dirty = true;
    pushDirty();
    setSaveState('dirty');
    renderAll();
    if (save) scheduleSave();
    return validated;
  }

  function scheduleSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => { requestSave(); }, 350);
  }

  // —— 保存：单一工作者 + 代次校验 ——
  // 模型每改一次 modelSeq +1；保存回包时只有代次没变才能把 dirty 清掉，
  // 否则把这次保存当成旧结果，继续存下一轮（否则“存 A 时改了 B”会把 B 当已存）。
  function requestSave() {
    state.saveWanted = true;
    if (!state.saveWorker) {
      state.saveWorker = runSaveLoop().finally(() => { state.saveWorker = undefined; });
    }
    return state.saveWorker;
  }

  async function runSaveLoop() {
    while (state.saveWanted) {
      state.saveWanted = false;
      if (!state.group || !state.dirty) continue;
      // 上次失败且模型没再改过：不自动重试（不让磁存恢复前的计时器静默“修好”），
      // 只在用户又改了、或显式保存屏障里才再试一次。
      if (state.saveFailed && state.modelSeq === state.failedSeq) continue;
      const gen = state.modelSeq;
      state.saving = true;
      setSaveState('saving');
      try {
        const document_ = { ...state.group, revision: state.revision };
        const result = await host.save(document_, state.revision);
        state.revision = result.revision;
        state.group.revision = result.revision;
        state.lastSaveAt = result.savedAt || Date.now();
        const recovered = state.saveFailed === true;
        state.saveFailed = false;
        if (recovered) setHint('之前没存上的修改，现在已经存好了。');
        if (state.modelSeq === gen) {
          state.dirty = false;
          setSaveState('saved');
        } else {
          // 保存途中模型又变了：这轮不算数，接着存最新模型。
          state.saveWanted = true;
          setSaveState('dirty');
        }
      } catch (error) {
        state.saveFailed = true;
        state.failedSeq = state.modelSeq;
        state.dirty = true;
        setSaveState('failed', error);
        setHint(`没能保存：${error?.message || error}。修改还在这扇窗里，别急着关。`);
        break; // 失败就停，不自动重试
      } finally {
        state.saving = false;
        // 保存成功不代表输入框也干净：输入里还有字时仍要算未保存编辑。
        pushDirty();
      }
    }
  }

  // 保存屏障：等当前模型的改动全部落盘；返回 true 才允许关窗/导出/复制说明。
  // 失败后不自动重试；只有模型又改过（failedSeq 对不上）才在下次屏障里再试一次。
  async function waitForSave() {
    if (!state.group) return false;
    const retryAllowed = !state.saveFailed || state.modelSeq !== state.failedSeq;
    if (state.dirty && retryAllowed) requestSave();
    while (state.saveWorker) await state.saveWorker;
    return !state.dirty && state.saveFailed === false;
  }

  // —— 视图 ——
  function worldBounds() {
    const frames = state.group.images.map(image => image.frame);
    if (!frames.length) return { x: 0, y: 0, width: 1, height: 1 };
    const minX = Math.min(...frames.map(frame => frame.x));
    const minY = Math.min(...frames.map(frame => frame.y));
    const maxX = Math.max(...frames.map(frame => frame.x + frame.width));
    const maxY = Math.max(...frames.map(frame => frame.y + frame.height));
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  function applyView() {
    const { panX, panY, zoom } = state.view;
    world.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    drawLinks();
  }

  function fitView() {
    if (!state.group) return;
    const bounds = worldBounds();
    const rect = stage.getBoundingClientRect();
    const pad = 48;
    const zoom = clamp(Math.min((rect.width - pad * 2) / Math.max(1, bounds.width), (rect.height - pad * 2) / Math.max(1, bounds.height), 1), 0.05, 2);
    state.view.zoom = zoom;
    state.view.panX = (rect.width - bounds.width * zoom) / 2 - bounds.x * zoom;
    state.view.panY = (rect.height - bounds.height * zoom) / 2 - bounds.y * zoom;
    state.view.panY = Math.max(24, state.view.panY);
    applyView();
  }

  function zoomBy(factor, anchor) {
    const before = toWorld(anchor.x, anchor.y);
    state.view.zoom = clamp(state.view.zoom * factor, 0.08, 4);
    const after = toWorld(anchor.x, anchor.y);
    state.view.panX += (after.x - before.x) * state.view.zoom;
    state.view.panY += (after.y - before.y) * state.view.zoom;
    applyView();
  }

  // —— 预览位图（有界）：单张预览 ≤ 2M 像素，全局 ≤ 64MiB，LRU 淘汰并在途去重 ——
  const PREVIEW_BUDGET = 64 * 1024 * 1024;
  const PREVIEW_PIXELS = 2_000_000;
  const previewCache = new Map(); // key -> { bitmap, width, height, bytes, lastUsed }
  const previewInflight = new Map();
  let previewBytes = 0;
  let previewClock = 0;

  function previewTarget(image) {
    const byWidth = Math.max(64, Math.ceil(image.frame.width * 2));
    const scale = Math.min(1, byWidth / image.width, Math.sqrt(PREVIEW_PIXELS / (image.width * image.height)));
    return { width: Math.max(1, Math.round(image.width * scale)), height: Math.max(1, Math.round(image.height * scale)) };
  }

  function previewKeyOf(image) {
    const target = previewTarget(image);
    return `${image.assetHash}:${target.width}`;
  }

  function releasePreview(key) {
    const entry = previewCache.get(key);
    if (!entry) return;
    try { entry.bitmap.close?.(); } catch { /* 已关闭。 */ }
    previewCache.delete(key);
    previewBytes -= entry.bytes;
  }

  function releaseAssetPreviews(assetHash) {
    for (const key of [...previewCache.keys()]) if (key.startsWith(`${assetHash}:`)) releasePreview(key);
  }

  function clearPreviews() {
    for (const key of [...previewCache.keys()]) releasePreview(key);
    previewBytes = 0;
  }

  function evictPreviews(keepKey) {
    while (previewBytes > PREVIEW_BUDGET && previewCache.size > 1) {
      let oldestKey;
      let oldest = Infinity;
      for (const [key, entry] of previewCache) {
        if (key === keepKey) continue;
        if (entry.lastUsed < oldest) { oldest = entry.lastUsed; oldestKey = key; }
      }
      if (!oldestKey) break;
      releasePreview(oldestKey);
    }
  }

  async function ensurePreview(image) {
    const target = previewTarget(image);
    const key = `${image.assetHash}:${target.width}`;
    const cached = previewCache.get(key);
    if (cached && cached.width === target.width) { cached.lastUsed = ++previewClock; return cached; }
    if (cached) releasePreview(key);
    if (previewInflight.has(key)) return previewInflight.get(key);
    const task = (async () => {
      const bytes = await host.asset(image.assetHash);
      const blob = new Blob([bytes], { type: 'image/png' });
      let bitmap;
      // 先按显示尺寸解；失败就退到更小的尺寸，绝不把 36M 全图常驻当预览。
      try { bitmap = await createImageBitmap(blob, { resizeWidth: target.width, resizeHeight: target.height, resizeQuality: 'medium' }); }
      catch {
        const half = { width: Math.max(1, Math.floor(target.width / 2)), height: Math.max(1, Math.floor(target.height / 2)) };
        bitmap = await createImageBitmap(blob, { resizeWidth: half.width, resizeHeight: half.height, resizeQuality: 'low' });
      }
      const entry = { bitmap, width: bitmap.width, height: bitmap.height,
        bytes: bitmap.width * bitmap.height * 4, lastUsed: ++previewClock };
      if (entry.bytes > PREVIEW_BUDGET) return entry; // 单张就超全局预算：只给当前图用，不进缓存
      previewCache.set(key, entry);
      previewBytes += entry.bytes;
      evictPreviews(key);
      return entry;
    })();
    previewInflight.set(key, task);
    try { return await task; } finally { previewInflight.delete(key); }
  }

  // 预览与导出的唯一安全底图：原图 → 不透明遮盖。任何出口都必须经过它。
  function paintSafeBase(ctx, bitmap, image, dx, dy, dw, dh) {
    ctx.drawImage(bitmap, dx, dy, dw, dh);
    const sx = dw / image.width, sy = dh / image.height;
    for (const mask of image.masks) {
      ctx.fillStyle = mask.color;
      ctx.fillRect(dx + mask.rect.x * sx, dy + mask.rect.y * sy, mask.rect.width * sx, mask.rect.height * sy);
    }
  }

  // —— 渲染图块 ——
  function renderAll() {
    renderImages();
    applyView();
    syncChrome();
  }

  function renderImages() {
    const alive = new Set(state.group.images.map(image => image.id));
    for (const [id, node] of nodeMap) {
      if (!alive.has(id)) { node.root.remove(); nodeMap.delete(id); }
    }
    state.group.images.forEach((image, index) => {
      let node = nodeMap.get(image.id);
      if (!node) node = createImageNode(image);
      nodeMap.set(image.id, node);
      const { root, base, marks } = node;
      root.style.left = `${image.frame.x}px`;
      root.style.top = `${image.frame.y}px`;
      root.style.width = `${image.frame.width}px`;
      root.style.height = `${image.frame.height}px`;
      root.dataset.active = state.activeImageId === image.id ? 'true' : 'false';
      node.labelText.textContent = `图${index + 1} · ${image.name === `图${index + 1}` ? '双击改名' : image.name}`;
      // 拖动时用临时 frame 撑开 canvas，不碰模型。
      const frame = state.dragFrame && state.dragFrame.imageId === image.id ? state.dragFrame.frame : image.frame;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      for (const canvas of [base, marks]) {
        const width = Math.max(1, Math.round(frame.width * dpr));
        const height = Math.max(1, Math.round(frame.height * dpr));
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      }
      drawNode(image, node, frame);
    });
    drawLinks();
  }

  function createImageNode(image) {
    const root = document.createElement('div');
    root.className = 'ws-image';
    root.dataset.id = image.id;
    const base = document.createElement('canvas');
    base.className = 'ws-pic';
    const marks = document.createElement('canvas');
    marks.className = 'ws-marks';
    const label = document.createElement('div');
    label.className = 'ws-label';
    const labelText = document.createElement('span');
    labelText.className = 'ws-label-text';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ws-remove';
    remove.textContent = '×';
    remove.title = '把这张图移出组（不会删历史原件）';
    label.append(labelText, remove);
    const handle = document.createElement('div');
    handle.className = 'ws-handle';
    handle.title = '等比缩放摆位（不改原图像素）';
    root.append(base, marks, label, handle);
    imagesLayer.append(root);

    label.addEventListener('pointerdown', event => {
      if (event.target === remove) return;
      event.stopPropagation();
      beginFrameDrag(event, image.id, 'move');
    });
    remove.addEventListener('click', event => {
      event.stopPropagation();
      removeImage(image.id);
    });
    handle.addEventListener('pointerdown', event => {
      event.stopPropagation();
      beginFrameDrag(event, image.id, 'resize');
    });
    marks.addEventListener('pointerdown', event => { event.stopPropagation(); onStagePointerDown(event); });
    base.addEventListener('pointerdown', event => { event.stopPropagation(); onStagePointerDown(event); });
    return { root, base, marks, label, labelText };
  }

  async function drawNode(image, node, frameOverride) {
    const { base, marks } = node;
    const frame = frameOverride || image.frame;
    const dpr = base.width / Math.max(1, frame.width);
    let entry;
    try { entry = await ensurePreview(image); }
    catch { entry = undefined; }
    const ctx = base.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, base.width, base.height);
    if (!entry) {
      // 解码失败：画占位，不把未解码的原图当背景。
      ctx.fillStyle = '#f2efe6';
      ctx.fillRect(0, 0, base.width, base.height);
    } else {
      ctx.save();
      ctx.scale(dpr, dpr);
      paintSafeBase(ctx, entry.bitmap, { masks: image.masks, width: image.width, height: image.height }, 0, 0, frame.width, frame.height);
      ctx.restore();
    }

    const markCtx = marks.getContext('2d');
    markCtx.setTransform(1, 0, 0, 1, 0, 0);
    markCtx.clearRect(0, 0, marks.width, marks.height);
    markCtx.save();
    markCtx.scale(dpr, dpr);
    drawImageMarks(markCtx, image, frame);
    drawDraft(markCtx, image, frame);
    drawLinkHandles(markCtx, image, frame);
    markCtx.restore();
  }

  // 目标框/点与意见号；源坐标 → 图块逻辑坐标。
  // 编辑态用轮廓、选中、序号辨认位置，这些只在交互层，不进任何图片输出。
  const isSelected = (noteId, targetId) => state.selection.some(item => item.noteId === noteId && item.targetId === targetId);
  const isRelationEnd = (noteId, targetId) => {
    if (!state.activeRelationId) return false;
    const relation = state.group.relations.find(item => item.id === state.activeRelationId);
    return Boolean(relation && relation.ends.some(end => end.noteId === noteId && end.targetId === targetId));
  };
  function drawImageMarks(ctx, image, frame) {
    const view = frame || image.frame;
    const sx = view.width / image.width, sy = view.height / image.height;
    state.group.notes.forEach((note, noteIndex) => {
      for (const target of note.targets) {
        if (target.imageId !== image.id) continue;
        const active = isSelected(note.id, target.id);
        const inRelation = isRelationEnd(note.id, target.id);
        ctx.lineWidth = active ? 3 : 2;
        ctx.strokeStyle = inRelation ? '#b0742c' : active ? '#4f8f77' : '#d4778f';
        ctx.fillStyle = inRelation ? 'rgba(176,116,44,.16)' : active ? 'rgba(79,143,119,.14)' : 'rgba(212,119,143,.12)';
        if (target.kind === 'region') {
          const x = target.rect.x * sx, y = target.rect.y * sy, w = target.rect.width * sx, h = target.rect.height * sy;
          ctx.fillRect(x, y, w, h);
          ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
          badge(ctx, noteIndex + 1, x, y);
        } else {
          const x = target.point.x * sx, y = target.point.y * sy;
          ctx.beginPath(); ctx.arc(x, y, active ? 7 : 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          badge(ctx, noteIndex + 1, x + 7, y - 7);
        }
      }
    });
  }

  function badge(ctx, number, x, y) {
    const text = String(number);
    ctx.save();
    ctx.font = 'bold 12px "Microsoft YaHei UI", sans-serif';
    const width = Math.max(16, ctx.measureText(text).width + 8);
    ctx.fillStyle = '#d4778f';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y - 16, width, 16, 8) : ctx.rect(x, y - 16, width, 16);
    ctx.fill();
    ctx.fillStyle = '#fffdf7';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 4, y - 8);
    ctx.restore();
  }

  function drawDraft(ctx, image, frame) {
    if (!state.draft || state.draft.imageId !== image.id) return;
    const view = frame || image.frame;
    const sx = view.width / image.width, sy = view.height / image.height;
    const { start, current, mode } = state.draft;
    if (mode === 'mask') {
      ctx.fillStyle = maskColor;
      ctx.fillRect(Math.min(start.x, current.x) * sx, Math.min(start.y, current.y) * sy,
        Math.abs(current.x - start.x) * sx, Math.abs(current.y - start.y) * sy);
      return;
    }
    ctx.strokeStyle = '#4f8f77';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(Math.min(start.x, current.x) * sx, Math.min(start.y, current.y) * sy,
      Math.abs(current.x - start.x) * sx, Math.abs(current.y - start.y) * sy);
    ctx.setLineDash([]);
  }

  // 选中框的四边连接把手：从这里拖到另一张图。
  const handlePoints = target => {
    const { x, y, width, height } = target.rect;
    return [{ x: x + width, y: y + height / 2 }, { x, y: y + height / 2 }, { x: x + width / 2, y }, { x: x + width / 2, y: y + height }];
  };
  function drawLinkHandles(ctx, image, frame) {
    const target = activeTarget();
    if (!target || target.imageId !== image.id || target.kind !== 'region') return;
    const view = frame || image.frame;
    const sx = view.width / image.width, sy = view.height / image.height;
    ctx.fillStyle = '#4f8f77';
    ctx.strokeStyle = '#fffdf7';
    ctx.lineWidth = 2;
    for (const point of handlePoints(target)) {
      ctx.beginPath();
      ctx.arc(point.x * sx, point.y * sy, 6, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    }
  }

  // —— 跨图线（SVG，世界坐标） ——
  function targetCenter(target) {
    const image = imageById(target.imageId);
    if (!image) return undefined;
    const point = target.kind === 'point' ? target.point : {
      x: target.rect.x + target.rect.width / 2, y: target.rect.y + target.rect.height / 2
    };
    return Group.worldOfSource(image, point);
  }

  function drawLinks() {
    if (!state.group) return;
    const bounds = worldBounds();
    const x = bounds.x - LINK_PAD, y = bounds.y - LINK_PAD;
    const width = Math.max(1, bounds.width + LINK_PAD * 2), height = Math.max(1, bounds.height + LINK_PAD * 2);
    links.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
    links.style.left = `${x}px`;
    links.style.top = `${y}px`;
    links.style.width = `${width}px`;
    links.style.height = `${height}px`;
    const parts = [];
    // 独立关系：两端各自定位，线上叠一条史的粗路径当点击区，不改两端几何。
    state.group.relations.forEach(relation => {
      const first = targetEndPoint(relation.ends[0]);
      const second = targetEndPoint(relation.ends[1]);
      if (!first || !second) return;
      const selected = state.activeRelationId === relation.id;
      const cls = selected ? 'ws-relation ws-relation-on' : 'ws-relation';
      parts.push(`<path class="ws-relation-hit" data-relation-id="${escapeXml(relation.id)}" d="M ${first.x} ${first.y} L ${second.x} ${second.y}" />`);
      parts.push(`<path class="${cls}" d="M ${first.x} ${first.y} L ${second.x} ${second.y}" />`);
      const text = shortLabel(relation.text);
      if (text) {
        parts.push(`<text class="ws-relation-text" data-relation-id="${escapeXml(relation.id)}" x="${(first.x + second.x) / 2 + 10}" y="${(first.y + second.y) / 2 + 4}">${escapeXml(text)}</text>`);
      }
    });
    state.group.notes.forEach((note, noteIndex) => {
      const centers = note.targets.map(targetCenter).filter(Boolean);
      for (let index = 1; index < centers.length; index++) {
        const a = centers[index - 1], b = centers[index];
        parts.push(`<path class="ws-link" d="M ${a.x} ${a.y} L ${b.x} ${b.y}" />`);
      }
      const first = centers[0];
      if (first) {
        const complete = note.text.trim();
        const text = complete ? shortLabel(note.text) : '还没写说明';
        parts.push(`<text class="ws-note${complete ? '' : ' ws-note-empty'}" x="${first.x + 12}" y="${first.y - 10}">${escapeXml(`${noteIndex + 1}. ${text}`)}</text>`);
      }
    });
    if (state.linking) {
      parts.push(`<path class="ws-draft" d="M ${state.linking.from.x} ${state.linking.from.y} L ${state.linking.to.x} ${state.linking.to.y}" />`);
    }
    if (state.linkPick) {
      const from = targetEndPoint(state.linkPick.end);
      if (from) parts.push(`<circle class="ws-pick" cx="${from.x}" cy="${from.y}" r="9" />`);
    }
    links.innerHTML = parts.join('');
  }

  function targetEndPoint(end) {
    const note = state.group.notes.find(item => item.id === end?.noteId);
    const target = note?.targets.find(item => item.id === end?.targetId);
    return target ? targetCenter(target) : undefined;
  }

  function shortLabel(text) {
    const units = Group.graphemes(String(text || '').replace(/\s+/g, ' ').trim());
    return units.length > 12 ? `${units.slice(0, 11).join('')}…` : units.join('');
  }
  function escapeXml(text) {
    return String(text).replace(/[<>&"']/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]));
  }

  // —— 命中 ——
  function activeTarget() {
    if (!state.activeNoteId || !state.activeTargetId) return undefined;
    const note = state.group.notes.find(item => item.id === state.activeNoteId);
    return note?.targets.find(item => item.id === state.activeTargetId);
  }

  // 命中优先级：点（小而明确）> 框边线（嵌套时内框边更近）> 框内部（面积小的优先）。
  // 这样先放点、再用大框圈住点，点仍然选得中；嵌套框也能各自选到。
  function targetAt(image, sourcePoint) {
    const slack = 6 / Math.max(0.2, state.view.zoom) * (image.width / image.frame.width);
    const candidates = [];
    state.group.notes.forEach((note) => {
      for (const target of note.targets) {
        if (target.imageId !== image.id) continue;
        if (target.kind === 'point') {
          const distance = Math.hypot(sourcePoint.x - target.point.x, sourcePoint.y - target.point.y);
          if (distance <= 8 + slack) candidates.push({ note, target, rank: 0, metric: distance });
          continue;
        }
        const { x, y, width, height } = target.rect;
        const inside = sourcePoint.x >= x - slack && sourcePoint.x <= x + width + slack &&
          sourcePoint.y >= y - slack && sourcePoint.y <= y + height + slack;
        if (!inside) continue;
        // 到最近一条边的距离（不是到矩形的距离），所以内部点不会误判成“贴边”。
        const edge = Math.min(Math.abs(sourcePoint.x - x), Math.abs(sourcePoint.x - (x + width)),
          Math.abs(sourcePoint.y - y), Math.abs(sourcePoint.y - (y + height)));
        const onBorder = edge <= slack;
        candidates.push({ note, target, rank: onBorder ? 1 : 2,
          metric: onBorder ? edge : width * height });
      }
    });
    if (!candidates.length) return undefined;
    candidates.sort((a, b) => a.rank - b.rank || a.metric - b.metric);
    return { note: candidates[0].note, target: candidates[0].target };
  }

  function handleAt(image, sourcePoint) {
    const target = activeTarget();
    if (!target || target.imageId !== image.id || target.kind !== 'region') return undefined;
    const slack = 10 / Math.max(0.2, state.view.zoom) * (image.width / image.frame.width);
    for (const point of handlePoints(target)) {
      if (Math.hypot(sourcePoint.x - point.x, sourcePoint.y - point.y) <= slack) return point;
    }
    return undefined;
  }

  const targetRefOf = (noteId, targetId) => {
    const note = state.group?.notes.find(item => item.id === noteId);
    const target = note?.targets.find(item => item.id === targetId);
    return note && target ? { note, target } : undefined;
  };
  const refFromHit = hit => ({ noteId: hit.note.id, targetId: hit.target.id });
  const sameRef = (a, b) => Boolean(a && b) && a.noteId === b.noteId && a.targetId === b.targetId;
  const selectedRefs = () => state.selection.map(item => targetRefOf(item.noteId, item.targetId)).filter(Boolean);
  const kindWord = target => (target.kind === 'region' ? '框' : '点');
  const refLabel = ref => `意见 ${noteNumberOf(ref.note.id)} 的${kindWord(ref.target)}`;

  function selectionHint() {
    const refs = selectedRefs();
    if (!refs.length) return defaultHint();
    if (refs.length === 1) return `已选中${refLabel(refs[0])}；点「关联…」再点另一处，或按住 Shift 再选一处。`;
    return `已选两处：${refLabel(refs[0])} 与 ${refLabel(refs[1])}；点「关联所选」写这两处的关系。`;
  }
  // 常规点击单选，Shift 点击加选/取消（最多两处）；点空白或 Esc 清掉选中。
  function select(targetInfo, { add = false } = {}) {
    const ref = targetInfo ? refFromHit(targetInfo) : undefined;
    if (!ref) {
      state.selection = [];
      state.activeNoteId = undefined;
      state.activeTargetId = undefined;
      state.activeRelationId = undefined;
      state.aim = undefined;
      state.linkPick = undefined;
      renderImages();
      drawLinks();
      syncChrome();
      setHint(defaultHint());
      return;
    }
    if (add) {
      const index = state.selection.findIndex(item => sameRef(item, ref));
      if (index >= 0) state.selection.splice(index, 1);
      else if (state.selection.length >= 2) { state.selection.shift(); state.selection.push(ref); }
      else state.selection.push(ref);
      if (!state.selection.length) { select(undefined); return; }
    } else {
      state.selection = [ref];
    }
    state.activeRelationId = undefined;
    const last = state.selection.at(-1);
    const resolved = last ? targetRefOf(last.noteId, last.targetId) : undefined;
    state.activeNoteId = resolved?.note.id;
    state.activeTargetId = resolved?.target.id;
    state.activeImageId = resolved?.target.imageId;
    renderImages();
    drawLinks();
    syncChrome();
    setHint(selectionHint());
  }
  const defaultHint = () => '拖动图标题摆位、拖右下角缩放；框选批注后直接写；按住空格临时平移。';

  // 选中一条意见后点「再指一处」：下一笔落在任何图的框或点都归到这条意见，不用拖线。
  function beginAim() {
    if (!state.activeNoteId) return;
    if (!finishComposerOnLeave()) return;
    state.aim = { noteId: state.activeNoteId };
    state.linkPick = undefined;
    const number = noteNumberOf(state.activeNoteId);
    setHint(`去另一张图上框一块，或点一下；这一处会归到意见 ${number}。Esc 取消。`);
    drawLinks();
  }

  function cancelAim() {
    if (!state.aim) return;
    state.aim = undefined;
    setHint('已取消关联；这条意见的原有目标没有改动。');
    drawLinks();
  }

  // —— 关联已有目标：不动几何、不重画 ——
  // 不要求先切回选择工具：进了这一步之后，命中任一处就是第二端。
  function beginLinkPick() {
    if (!finishComposerOnLeave()) return;
    const refs = selectedRefs();
    if (!refs.length) { setHint('先选一处要关联的点或框。'); return; }
    const last = state.selection.at(-1);
    state.linkPick = { end: { noteId: last.noteId, targetId: last.targetId } };
    state.aim = undefined;
    setHint('再点一处已有的点或框，就把它和这一处关联起来（不用先切工具）。Esc 取消。');
    renderImages();
    drawLinks();
    syncChrome();
  }

  function cancelLinkPick() {
    if (!state.linkPick) return;
    state.linkPick = undefined;
    renderImages();
    drawLinks();
    syncChrome();
    setHint('已取消，没有建立关系；两处和各自的文字都没动。');
  }

  function pickSecond(ref) {
    const first = state.linkPick.end;
    state.linkPick = undefined;
    if (sameRef(first, ref)) {
      setHint('同一处不能和自己关联；换一处。');
      renderImages();
      drawLinks();
      syncChrome();
      return;
    }
    openRelationComposer([first, ref]);
  }

  function associateSelection() {
    const refs = selectedRefs();
    if (refs.length !== 2) { setHint('先选两处（Shift 点击加选），再点「关联所选」。'); return; }
    const ends = state.selection.slice(0, 2).map(item => ({ noteId: item.noteId, targetId: item.targetId }));
    openRelationComposer(ends);
  }
  function selectRelation(relationId) {
    const relation = state.group.relations.find(item => item.id === relationId);
    if (!relation) return;
    state.activeRelationId = relationId;
    state.selection = relation.ends.map(end => ({ noteId: end.noteId, targetId: end.targetId }));
    state.activeNoteId = undefined;
    state.activeTargetId = undefined;
    state.aim = undefined;
    state.linkPick = undefined;
    renderImages();
    drawLinks();
    syncChrome();
    setHint(`已选中关系 ${relationNumberOf(relationId)}，两端一起高亮；可以改文字或解除关系。`);
  }

  const relationNumberOf = id => (state.group.relations.findIndex(item => item.id === id) + 1);

  function deleteRelation() {
    if (!state.activeRelationId) return;
    if (!finishComposerOnLeave()) return;
    const number = relationNumberOf(state.activeRelationId);
    try {
      apply(Group.deleteRelation(state.group, state.activeRelationId));
      state.activeRelationId = undefined;
      state.selection = [];
      renderImages();
      drawLinks();
      syncChrome();
      setHint(`关系 ${number} 已解除；两处和各自的文字都还在。`);
    } catch (error) { setHint(`解除不了：${error?.message || error}`); }
  }

  // 选中一处就能改它的说明（关系有单独按钮；等第二端时不换输入目标）。
  function editNote() {
    const refs = selectedRefs();
    if (refs.length !== 1) return;
    if (!finishComposerOnLeave()) return;
    const note = state.group.notes.find(item => item.id === refs[0].note.id);
    if (!note) return;
    openNoteComposer(note);
  }

  function editRelation() {
    if (!state.activeRelationId) return;
    const relation = state.group.relations.find(item => item.id === state.activeRelationId);
    if (!relation) return;
    // openRelationComposer 会先收下当前输入；失败就留在原输入框，不覆盖。
    openRelationComposer(relation.ends.map(end => ({ ...end })), relation);
  }

  // —— 指针交互 ——
  function onStagePointerDown(event) {
    if (!state.group || state.busy) return;
    if (event.button === 2) return;
    // 关系线/标签只是可有可无的额外入口：只在选择工具的普通单击里认，
    // 不能抢在工具、空格平移、Shift 多选、选第二端前面把整个画布吞了。
    const relationHit = event.target?.closest?.('[data-relation-id]');
    // 合成事件/无活动指针时 setPointerCapture 会抛，指针捕获只是锦上添花。
    try { stage.setPointerCapture?.(event.pointerId); } catch { /* 没捕获也能拖。 */ }
    const screen = stagePointOf(event);
    const point = toWorld(screen.x, screen.y);
    const image = Group.imageAtWorld(state.group.images, point);
    const panMode = state.space || state.tool === 'select' || event.button === 1;

    // 任何后续动作前先把输入框里的字安全收下；校验失败就停在这里，不丢现场。
    if (!finishComposerOnLeave()) return;

    if (image) {
      const source = Group.sourceAtScreen(image, state.view, screen);
      const handle = handleAt(image, source);
      if (handle && !state.linkPick) {
        state.linking = { noteId: state.activeNoteId, targetId: state.activeTargetId, imageId: image.id,
          from: Group.worldOfSource(image, handle), to: point };
        drawLinks();
        return;
      }
      const hit = targetAt(image, source);
      // 「关联…」等第二端时，命中任一处就直接选它为另一端，不要求先切回选择工具。
      if (hit && state.linkPick) { pickSecond(refFromHit(hit)); return; }
      if (hit && state.tool === 'select' && !state.space) {
        select(hit, { add: event.shiftKey === true });
        return;
      }
      if (state.tool === 'annotate' || state.tool === 'mask' || state.aim) {
        // 等第二端却没点到目标：不在这里新建标记，说清楚就收。
        if (state.linkPick) { cancelLinkPick(); return; }
        state.activeImageId = image.id;
        state.draft = { imageId: image.id, mode: state.aim ? 'annotate' : (state.tool === 'mask' ? 'mask' : 'annotate'),
          start: clampSource(image, source), current: clampSource(image, source) };
        state.drag = { kind: 'draw', imageId: image.id, pointerId: event.pointerId };
        return;
      }
      if (!hit) {
        if (state.linkPick) cancelLinkPick();
        else select(undefined);
      }
    } else if (state.linkPick) {
      cancelLinkPick();
    }

    // 点到关系线/关系标签：只在选择工具的普通单击里选中这条关系。
    if (relationHit && state.tool === 'select' && !state.space && !state.aim && !state.linkPick) {
      const relationId = relationHit.getAttribute('data-relation-id');
      if (!state.drag && relationId) { selectRelation(relationId); return; }
    }


    if (panMode) {
      state.drag = { kind: 'pan', startScreen: screen, startPan: { ...state.view } };
      stage.dataset.panning = 'true';
      return;
    }
    state.drag = { kind: 'pan', startScreen: screen, startPan: { ...state.view } };
  }

  function onStagePointerMove(event) {
    if (!state.group) return;
    const screen = stagePointOf(event);

    if (state.linking) {
      state.linking.to = toWorld(screen.x, screen.y);
      drawLinks();
      return;
    }

    const drag = state.drag;
    if (!drag) return;
    if (drag.kind === 'pan') {
      state.view.panX = drag.startPan.panX + (screen.x - drag.startScreen.x);
      state.view.panY = drag.startPan.panY + (screen.y - drag.startScreen.y);
      applyView();
      return;
    }
    if (drag.kind === 'draw') {
      const image = imageById(drag.imageId);
      if (!image) return;
      state.draft.current = clampSource(image, Group.sourceAtScreen(image, state.view, screen));
      drawNode(image, nodeMap.get(image.id));
      return;
    }
    if (drag.kind === 'frame') {
      const image = imageById(drag.imageId);
      if (!image) return;
      const point = toWorld(screen.x, screen.y);
      if (drag.mode === 'move') {
        state.dragFrame = { imageId: drag.imageId, frame: { ...drag.origin,
          x: drag.origin.x + (point.x - drag.startWorld.x), y: drag.origin.y + (point.y - drag.startWorld.y) } };
      } else {
        const anchor = { x: drag.origin.x, y: drag.origin.y };
        const ratio = image.width / image.height;
        const rawWidth = Math.max(24, point.x - anchor.x);
        const rawHeight = Math.max(24, point.y - anchor.y);
        const width = Math.max(24, Math.min(rawWidth, rawHeight * ratio));
        state.dragFrame = { imageId: drag.imageId, frame: { ...drag.origin, width, height: width / ratio } };
      }
      moveFrameLive(image, state.dragFrame.frame);
    }
  }

  function onStagePointerUp(event) {
    if (state.linking) {
      finishLink(toWorld(stagePointOf(event).x, stagePointOf(event).y));
      return;
    }
    const drag = state.drag;
    state.drag = undefined;
    delete stage.dataset.panning;
    if (!drag) return;
    if (drag.kind === 'draw') {
      const draft = state.draft;
      state.draft = undefined;
      if (draft) finishDraw(draft);
      return;
    }
    if (drag.kind === 'frame') {
      const image = imageById(drag.imageId);
      const frame = state.dragFrame && state.dragFrame.imageId === drag.imageId ? state.dragFrame.frame : undefined;
      state.dragFrame = undefined;
      if (image && frame) {
        try { apply(Group.setFrame(state.group, image.id, frame)); }
        catch (error) { setHint(`这个摆位不能用：${error?.message || error}`); renderImages(); }
      }
    }
  }

  function clampSource(image, point) {
    return { x: clamp(point.x, 0, image.width), y: clamp(point.y, 0, image.height) };
  }

  // 拖动中的摆位：只改 DOM，不着模型；松手再一次性提交（撤销才有意义）。
  function moveFrameLive(image, frame) {
    const node = nodeMap.get(image.id);
    if (!node) return;
    node.root.style.left = `${frame.x}px`;
    node.root.style.top = `${frame.y}px`;
    node.root.style.width = `${frame.width}px`;
    node.root.style.height = `${frame.height}px`;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const canvas of [node.base, node.marks]) {
      const width = Math.max(1, Math.round(frame.width * dpr));
      const height = Math.max(1, Math.round(frame.height * dpr));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    }
    drawNode(image, node, frame);
    drawLinks();
  }

  function beginFrameDrag(event, imageId, mode) {
    if (state.busy) return;
    const image = imageById(imageId);
    if (!image) return;
    event.preventDefault();
    try { stage.setPointerCapture?.(event.pointerId); } catch { /* 没捕获也能拖。 */ }
    state.activeImageId = imageId;
    const screen = stagePointOf(event);
    state.drag = { kind: 'frame', mode, imageId, pointerId: event.pointerId,
      startWorld: toWorld(screen.x, screen.y), origin: { ...image.frame } };
  }

  // —— 画目标 / 创建意见 ——
  function finishDraw(draft) {
    const image = imageById(draft.imageId);
    if (!image) return;
    const dx = Math.abs(draft.current.x - draft.start.x);
    const dy = Math.abs(draft.current.y - draft.start.y);
    const screenScale = image.frame.width / image.width;
    if (draft.mode === 'mask') {
      if (dx * screenScale < 3 || dy * screenScale < 3) { setHint('遮盖太小了，重新圈一块。'); renderImages(); return; }
      const rect = Group.regionAtScreen(image, state.view,
        Group.screenOfWorld(state.view, Group.worldOfSource(image, draft.start)),
        Group.screenOfWorld(state.view, Group.worldOfSource(image, draft.current)));
      try {
        const mask = { id: newId('mask'), rect, color: maskColor };
        apply(Group.addMask(state.group, image.id, mask));
        setHint('已加一块不透明遮盖；历史里的原图不动，导出时会盖掉。');
      } catch (error) { setHint(`没加成功：${error?.message || error}`); }
      renderImages();
      return;
    }
    const isPoint = dx * screenScale < 4 && dy * screenScale < 4;
    const target = isPoint
      ? { id: newId('target'), imageId: image.id, kind: 'point', point: { x: round2(draft.start.x), y: round2(draft.start.y) } }
      : (() => {
          try {
            const rect = Group.regionAtScreen(image, state.view,
              Group.screenOfWorld(state.view, Group.worldOfSource(image, draft.start)),
              Group.screenOfWorld(state.view, Group.worldOfSource(image, draft.current)));
            return { id: newId('target'), imageId: image.id, kind: 'region', rect };
          } catch (error) { setHint(`这个框不能用：${error?.message || error}`); return undefined; }
        })();
    renderImages();
    if (!target) return;
    // 正在「再指一处」：直接把这一处追加到那条意见，不再弹输入框。
    if (state.aim) {
      const noteId = state.aim.noteId;
      state.aim = undefined;
      const note = state.group.notes.find(item => item.id === noteId);
      if (!note) { setHint('那条意见已经不在了，这一处没有加进去。'); return; }
      if (note.targets.length >= 8) { setHint('一条意见最多关联 8 处，先把旧的删掉。'); return; }
      try {
        const next = Group.updateNote(state.group, note.id, { targets: [...note.targets, target] });
        apply(next);
        const saved = state.group.notes.find(item => item.id === note.id);
        select({ note: saved, target: saved.targets.at(-1) });
        setHint(`已归到意见 ${noteNumberOf(note.id)}；现在共 ${saved.targets.length} 处，都在同一号下。`);
      } catch (error) {
        setHint(`没关联成：${error?.message || error}`);
      }
      return;
    }
    // 先标后写：这一处立刻成为正式目标（文字先空着），再在旁边等它写说明。
    try {
      const note = { id: newId('note'), text: '', linked: false, targets: [target] };
      apply(Group.addNote(state.group, note));
    } catch (error) {
      setHint(`这一处没加成功：${error?.message || error}`);
      return;
    }
    const created = state.group.notes.at(-1);
    select({ note: created, target: created.targets[0] });
    openNoteComposer(created, { fresh: true });
  }

  function round2(value) { return Math.round(value * 100) / 100; }
  function newId(prefix) {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  function placeComposer(screen) {
    const rect = stage.getBoundingClientRect();
    composer.style.left = `${clamp(screen.x + 16, 12, Math.max(12, rect.width - 336))}px`;
    composer.style.top = `${clamp(screen.y - 40, 12, Math.max(12, rect.height - 150))}px`;
  }

  // 目标刚标好：输入框只是“顺手写一句”，空着也能先放着。
  function openNoteComposer(note, { fresh = false } = {}) {
    const target = note.targets[0];
    state.editing = { kind: 'note', noteId: note.id };
    composer.hidden = false;
    composerText.value = note.text;
    composerHint.textContent = fresh
      ? '这一处已经标好了；说明不写也行，之后再补 · Enter 收起 · Esc 收起并保留已写的字'
      : `改意见 ${noteNumberOf(note.id)} 的文字 · Enter 收起 · Esc 收起并保留已写的字`;
    if (target) placeComposer(toScreen(targetCenter(target)));
    composerText.focus();
    syncInputDirty();
  }

  // 打开另一条关系说明前，先把当前输入安全收好；失败就留现场，不往下走。
  function openRelationComposer(ends, relation) {
    if (!finishComposerOnLeave()) return false;
    state.editing = { kind: 'relation', ends, relationId: relation?.id };
    composer.hidden = false;
    composerText.value = relation ? relation.text : '';
    composerHint.textContent = relation
      ? '改这两处的关系说明 · Enter 保存 · Esc 取消（原文不变）'
      : '写清这两处的关系，之后也能补 · Enter 保存 · Esc 取消不建关系';
    const points = ends.map(end => targetEndPoint(end)).filter(Boolean).map(point => toScreen(point));
    const at = points.length === 2
      ? { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 }
      : (points[0] || { x: 0, y: 0 });
    placeComposer(at);
    composerText.focus();
    syncInputDirty();
    return true;
  }

  function closeComposer() {
    state.editing = undefined;
    composer.hidden = true;
    composerText.value = '';
    state.inputDirty = false;
    pushDirty();
    renderImages();
    syncChrome();
  }

  // 输入框里是否还有没进模型的字：纯比较，不发请求。
  function inputDiffersFromModel() {
    const editing = state.editing;
    if (!editing) return false;
    if (editing.kind === 'relation') {
      if (editing.relationId) {
        const relation = state.group?.relations.find(item => item.id === editing.relationId);
        return Boolean(relation) && relation.text !== composerText.value;
      }
      return composerText.value.trim() !== '';
    }
    const note = state.group?.notes.find(item => item.id === editing.noteId);
    return Boolean(note) && note.text !== composerText.value;
  }

  function syncInputDirty() {
    const next = inputDiffersFromModel();
    if (state.inputDirty === next) return;
    state.inputDirty = next;
    pushDirty();
  }

  // 离开输入框的统一收尾：有改动就提交，成功才允许后续动作；失败留现场并停住。
  function finishComposerOnLeave() {
    const editing = state.editing;
    if (!editing) return true;
    if (!inputDiffersFromModel()) {
      // 没写关系文字就是放弃这条关系（明确告知），不是默默丢掉输入。
      if (editing.kind === 'relation' && !editing.relationId) setHint('这次没有写关系文字，也没有建关系。');
      closeComposer();
      return true;
    }
    return commitComposer() === true;
  }

  function commitComposer() {
    const editing = state.editing;
    if (!editing) return false;
    const text = composerText.value;
    if (editing.kind === 'relation') {
      try {
        if (editing.relationId) {
          const relationId = editing.relationId;
          const next = Group.updateRelation(state.group, relationId, { text });
          closeComposer();
          apply(next);
          selectRelation(relationId);
          setHint(text.trim() ? `关系 ${relationNumberOf(relationId)} 的文字已保存。` : '关系文字清空了；导出前补上才算完成。');
          return true;
        }
        const relation = { id: newId('relation'), text, ends: editing.ends };
        const next = Group.addRelation(state.group, relation);
        closeComposer();
        apply(next);
        selectRelation(relation.id);
        setHint(text.trim() ? '两处已建立关系，各自原来的文字一个字都没动。' : '两处已建立关系，说明还空着；导出前要补上。');
        return true;
      } catch (error) {
        composerHint.textContent = `没存上：${error?.message || error}`;
        return false;
      }
    }
    // 意见文字：空着是允许的草稿状态，不逼人写假字。
    const note = state.group.notes.find(item => item.id === editing.noteId);
    if (!note) { composerHint.textContent = '这条意见已经不在了，Esc 收起。'; return false; }
    if (text === note.text) { closeComposer(); return true; }
    try {
      const next = Group.updateNote(state.group, note.id, { text });
      closeComposer();
      apply(next);
      const saved = state.group.notes.find(item => item.id === note.id);
      select({ note: saved, target: saved.targets[0] });
      setHint(text.trim() ? '这条说明已保存。' : '这条只标了位置，说明还空着；导出前要补。');
      return true;
    } catch (error) {
      composerHint.textContent = `没存上：${error?.message || error}`;
      return false;
    }
  }

  // —— 跨图连线 ——
  function finishLink(worldPoint) {
    const linking = state.linking;
    state.linking = undefined;
    drawLinks();
    if (!linking) return;
    const image = Group.imageAtWorld(state.group.images, worldPoint);
    if (!image) { setHint('线落在画布空白处，没有建立关联；原来的意见和草稿都还在。'); renderImages(); return; }
    const source = Group.sourceAtScreen(image, state.view, Group.screenOfWorld(state.view, worldPoint));
    const hit = targetAt(image, source);
    if (hit) {
      // 拖到已有目标上：建的是“两处有关”的引用关系，不动两边几何和各自文字。
      const from = { noteId: linking.noteId, targetId: linking.targetId };
      const to = refFromHit(hit);
      if (sameRef(from, to)) { setHint('同一处不能和自己关联；拖到另一处。'); return; }
      openRelationComposer([from, to]);
      return;
    }
    const note = state.group.notes.find(item => item.id === linking.noteId);
    if (!note) { setHint('选中的意见已经不在了，请重新选一个框。'); return; }
    let target;
    try { target = { id: newId('target'), imageId: image.id, kind: 'point', point: { x: round2(source.x), y: round2(source.y) } }; }
    catch { return; }
    try {
      const targets = [...note.targets, target];
      const next = Group.updateNote(state.group, note.id, { targets });
      const updated = { ...next, notes: next.notes.map(item => item.id === note.id ? { ...item, linked: targets.length > 1 } : item) };
      apply(updated);
      select({ note: state.group.notes.find(item => item.id === note.id), target: state.group.notes.find(item => item.id === note.id).targets.at(-1) });
      setHint(`已在这条意见下加到图 ${imageNumberOf(image.id)} 的这一点。`);
    } catch (error) { setHint(`没连上：${error?.message || error}`); }
  }

  // —— 图块管理 ——
  function removeImage(imageId) {
    const image = imageById(imageId);
    const assetHash = image?.assetHash;
    try {
      apply(Group.removeImage(state.group, imageId));
      // 这张原件在组里已无图块引用：释放它的预览位图。
      if (assetHash && !state.group.images.some(item => item.assetHash === assetHash)) releaseAssetPreviews(assetHash);
      setHint('这张图已移出组，历史里的原件还在。');
    } catch (error) {
      setHint(error?.code === 'IMAGE_IN_USE'
        ? `这张图还牵着 ${error.notes || '几'} 条意见，先把它们处理掉再移出。`
        : `移不出去：${error?.message || error}`);
    }
  }

  function renameImage(imageId, name) {
    const text = String(name || '').trim();
    if (!text) return;
    try { apply(Group.renameImage(state.group, imageId, text.slice(0, 60))); }
    catch (error) { setHint(`改名没成功：${error?.message || error}`); }
  }

  // —— 撤销 / 重做 ——
  function undo() {
    const previous = state.history.undo(state.group);
    if (!previous) { setHint('没有可以撤销的步数了。'); return; }
    state.group = previous;
    state.modelSeq += 1;
    state.dirty = true;
    host.setDirty(true).catch(() => {});
    setSaveState('dirty');
    pruneSelection();
    renderImages();
    drawLinks();
    syncChrome();
    scheduleSave();
    setHint('已撤销一步。');
  }
  function redo() {
    const next = state.history.redo(state.group);
    if (!next) { setHint('没有可以重做的步数了。'); return; }
    state.group = next;
    state.modelSeq += 1;
    state.dirty = true;
    host.setDirty(true).catch(() => {});
    setSaveState('dirty');
    pruneSelection();
    renderImages();
    drawLinks();
    syncChrome();
    scheduleSave();
    setHint('已重做一步。');
  }

  // 撤销/重做/删除后，选中的目标或关系可能已经不在了：只清指针，不重建。
  function pruneSelection() {
    if (!state.group) return;
    state.selection = state.selection.filter(item => {
      const note = state.group.notes.find(entry => entry.id === item.noteId);
      return Boolean(note && note.targets.some(target => target.id === item.targetId));
    });
    const last = state.selection.at(-1);
    const resolved = last ? targetRefOf(last.noteId, last.targetId) : undefined;
    state.activeNoteId = resolved?.note.id;
    state.activeTargetId = resolved?.target.id;
    if (state.activeRelationId && !state.group.relations.some(item => item.id === state.activeRelationId)) {
      state.activeRelationId = undefined;
    }
  }

  // —— 输出 ——
  async function fullBitmap(assetHash) {
    const bytes = await host.asset(assetHash);
    const blob = new Blob([bytes], { type: 'image/png' });
    return createImageBitmap(blob);
  }

  // 逐图导出：主图只留安全底图（含遮盖与真实笔迹），不烘目标框/编号/连线；说明在下方页脚。
  // 全分辨率位图用完立即 close，canvas 由调用方 toBlob 后清理。
  async function renderSingle(plan, image) {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, image.width, image.height);
    let bitmap;
    try {
      bitmap = await fullBitmap(image.assetHash);
      paintSafeBase(ctx, bitmap, { masks: image.masks, width: image.sourceWidth, height: image.sourceHeight },
        image.bodyX, image.bodyY, image.sourceWidth, image.sourceHeight);
      if (image.mode === 'withNotes') {
        drawHeader(ctx, plan, image);
        drawFooter(ctx, image);
      }
      // bodyOnly：不画页头也不画标记；完整文字与图号映射在同批说明.txt。
      return canvas;
    } finally {
      try { bitmap?.close?.(); } catch { /* 已释放。 */ }
    }
  }

  function drawHeader(ctx, plan, image) {
    ctx.save();
    ctx.fillStyle = '#24322c';
    ctx.font = '600 18px "KaiTi", "STKaiti", "楷体", serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(`图${image.number} · ${plan.title}`.slice(0, 120), 12, (image.headerH || 28) / 2 + 2);
    ctx.restore();
  }

  function drawFooter(ctx, image) {
    ctx.save();
    ctx.fillStyle = '#24322c';
    ctx.textBaseline = 'alphabetic';
    for (const line of image.footer || []) {
      const font = line.kind === 'heading' ? '600 18px "Microsoft YaHei UI", sans-serif' : '18px "Microsoft YaHei UI", sans-serif';
      ctx.font = font;
      const units = Group.graphemes(line.text);
      units.forEach((unit, index) => {
        ctx.fillText(unit, 24 + index * image.grid.cellW, line.y + 20, image.grid.cellW);
      });
    }
    ctx.restore();
  }

  async function renderOverview(plan) {
    const canvas = document.createElement('canvas');
    canvas.width = plan.overview.width;
    canvas.height = plan.overview.height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const snapshotImages = new Map(plan.snapshot.images.map(image => [image.id, image]));
    for (const frame of plan.overview.frames) {
      const image = snapshotImages.get(frame.imageId);
      if (!image) continue;
      // 总览用有界预览位图（≤ 2M 像素）绘制，再按源坐标比例烧遮盖；不为了缩图全量解码。
      let entry;
      try { entry = await ensurePreview(image); } catch { entry = undefined; }
      if (entry) paintSafeBase(ctx, entry.bitmap, image, frame.x, frame.y, frame.width, frame.height);
      else { ctx.fillStyle = '#f2efe6'; ctx.fillRect(frame.x, frame.y, frame.width, frame.height); }
      ctx.strokeStyle = '#d9ddcd';
      ctx.lineWidth = 1;
      ctx.strokeRect(frame.x, frame.y, frame.width, frame.height);
    }
    // 跨图线：同一条意见的目标按顺序连起来（不改目标几何）。
    const targetsOf = new Map();
    for (const target of plan.overview.targets) {
      if (!targetsOf.has(target.noteId)) targetsOf.set(target.noteId, []);
      targetsOf.get(target.noteId).push(target);
    }
    ctx.save();
    ctx.strokeStyle = '#d4778f';
    ctx.lineWidth = 2;
    for (const list of targetsOf.values()) {
      for (let index = 1; index < list.length; index++) {
        const a = list[index - 1], b = list[index];
        ctx.beginPath();
        ctx.moveTo(a.x + a.width / 2, a.y + a.height / 2);
        ctx.lineTo(b.x + b.width / 2, b.y + b.height / 2);
        ctx.stroke();
      }
    }
    // 独立关系：两端直接连，文字短标签由 planner 定框；不画批注数字徽章。
    ctx.strokeStyle = '#b0742c';
    for (const relation of plan.overview.relations || []) {
      if (!relation.a || !relation.b) continue;
      ctx.beginPath();
      ctx.moveTo(relation.a.x, relation.a.y);
      ctx.lineTo(relation.b.x, relation.b.y);
      ctx.stroke();
    }
    ctx.restore();
    for (const target of plan.overview.targets) {
      ctx.strokeStyle = '#d4778f';
      ctx.lineWidth = 2;
      if (target.kind === 'region') ctx.strokeRect(target.x, target.y, target.width, target.height);
      else { ctx.beginPath(); ctx.arc(target.x, target.y, 4, 0, Math.PI * 2); ctx.stroke(); }
    }
    // 短标签：planner 定了位置和尺寸，页面不改 bbox；标签只有文字，不带意见号。
    ctx.save();
    ctx.font = '13px "Microsoft YaHei UI", sans-serif';
    ctx.textBaseline = 'middle';
    const labelBox = (label, text, fill) => {
      ctx.fillStyle = '#fffdf7';
      ctx.strokeStyle = '#d9ddcd';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(label.x, label.y, label.width, label.height);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = fill;
      ctx.fillText(text.slice(0, 24), label.x + 6, label.y + label.height / 2);
    };
    for (const label of plan.overview.labels) labelBox(label, label.text, '#24322c');
    for (const relation of plan.overview.relations || []) {
      if (relation.label && relation.text) labelBox(relation.label, relation.text, '#8a5517');
    }
    ctx.restore();
    // 图号（图块标题，不是批注编号）
    ctx.save();
    ctx.font = '600 13px "KaiTi", "楷体", serif';
    ctx.fillStyle = '#4f8f77';
    for (const frame of plan.overview.frames) ctx.fillText(`图${frame.number}`, frame.x + 4, Math.max(12, frame.y - 6));
    ctx.restore();
    return canvas;
  }

  // 对照图：原尺寸纵向拼接，标题在上。截图本体不带需求批注，图号只写在标题行。
  async function renderSheet(plan) {
    const sheet = plan.sheet;
    const canvas = document.createElement('canvas');
    canvas.width = sheet.width;
    canvas.height = sheet.height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const item of sheet.items) {
      const source = plan.snapshot.images.find(image => image.id === item.imageId);
      if (!source) continue;
      ctx.save();
      ctx.fillStyle = '#24322c';
      ctx.font = '600 16px "Microsoft YaHei UI", sans-serif';
      ctx.textBaseline = 'alphabetic';
      const extra = item.title && item.title !== `图${item.number}` ? ` · ${item.title}` : '';
      ctx.fillText(`图${item.number}${extra} · ${item.sourceWidth} × ${item.sourceHeight}`, item.x, item.y - 10);
      ctx.restore();
      let bitmap;
      try { bitmap = await fullBitmap(item.assetHash); } catch { bitmap = undefined; }
      if (bitmap) {
        paintSafeBase(ctx, bitmap, { masks: source.masks, width: item.sourceWidth, height: item.sourceHeight },
          item.x, item.y, item.width, item.height);
        try { bitmap.close?.(); } catch { /* 已释放。 */ }
      } else {
        ctx.fillStyle = '#f2efe6';
        ctx.fillRect(item.x, item.y, item.width, item.height);
      }
      // 截图本体不再叠加目标框/编号：对照图靠上方标题行的图号对号，说明在说明.txt 里。
      ctx.strokeStyle = '#d9ddcd';
      ctx.lineWidth = 1;
      ctx.strokeRect(item.x + .5, item.y + .5, Math.max(1, item.width - 1), Math.max(1, item.height - 1));
    }
    return canvas;
  }

  // 取消与失败分开：取消不自动重试、不自动再交后续图；已写好的文件留在磁盘上如实说明。
  class ExportCanceled extends Error {}

  function cleanupCanvas(canvas) {
    try { canvas.width = 0; canvas.height = 0; } catch { /* 已释放。 */ }
  }

  async function sendPart(batch, index, canvas, canceled) {
    try {
      if (canceled()) throw new ExportCanceled();
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('图片编码失败');
      const bytes = await blob.arrayBuffer();
      // 编码/取字节都可能耗时，交出去之前再查一次代次。
      if (canceled()) throw new ExportCanceled();
      await host.exportPart(batch.token, index, bytes);
    } finally {
      cleanupCanvas(canvas);
    }
  }

  // 取消一个批次：幂等（已结束的批次 abort 也当成功）；返回主进程的真实结果。
  async function abortBatch(token) {
    if (!token) return undefined;
    try { return await host.exportAbort(token); }
    catch { return undefined; }
  }

  function stopExport() {
    if (!state.busy) return;
    state.exportCanceled = true;
    state.exportGen += 1;
    const batch = state.exportBatch;
    setExportInfo('正在停止导出…', 'warn');
    // begin 还没回来时没有批次可退：只让本地代次失效，runExport 拿到 batch 后会立刻补退。
    if (!batch) return;
    abortBatch(batch.token).then(result => {
      state.exportAbortResult = result;
      if (result && result.published) setExportInfo('已经开始发布，这次停止没有生效；已经交出去的文件收不回来。', 'warn');
      else setExportInfo('已停止导出；已经写好的文件保留。', 'warn');
    });
  }

  // 完成度：成品导出（复制/保存/对照/复制说明）共用一道路，不静默漏掉没写完的标记。
  function pendingNow() {
    try { return Group.pendingOf(state.group); } catch { return []; }
  }
  function blockIfIncomplete(prefix) {
    const pending = pendingNow();
    if (!pending.length) return false;
    setExportInfo(`${prefix}${Group.pendingMessageOf(pending)}。草稿已经存着，补好再来。`, 'warn');
    return true;
  }

  async function runExport(kind) {
    if (state.busy) return;
    // 输入框里还没提交的字先入模型：导出不能偷偷落下它；校验不过就停。
    if (!finishComposerOnLeave()) return;
    if (blockIfIncomplete(kind === 'save' ? '还不能保存成品：' : '还不能导出：')) return;
    // 导出读的是落库版本（main 会重新读库），所以先等最新模型全部存好。
    if (!(await waitForSave())) {
      setExportInfo('还有修改没存进这一组，导出没开始（避免导出到旧文字）。', 'warn');
      return;
    }
    const gen = ++state.exportGen;
    state.exportCanceled = false;
    state.exportAbortResult = undefined;
    const canceled = () => gen !== state.exportGen || state.exportCanceled === true;
    state.busy = true;
    syncChrome();
    let batch;
    try {
      batch = await host.exportBegin(kind);
    } catch (error) {
      state.busy = false; syncChrome();
      setExportInfo(`没能开始导出：${error?.message || error}`, 'warn');
      return;
    }
    if (batch?.canceled) { state.busy = false; syncChrome(); return; }
    // 先登记再查取消：begin 期间（可能在校验/等目录）点的停止，不能把批次漏在 main 里。
    state.exportBatch = batch;
    if (canceled()) {
      const result = await abortBatch(batch.token);
      state.exportBatch = undefined;
      state.busy = false;
      syncChrome();
      setExportInfo(result && result.published
        ? '已经开始发布，这次停止没有生效；已经交出去的文件收不回来。'
        : '已停止导出；没有开始画图，也没有交出新文件。', 'warn');
      return;
    }
    setExportInfo(kind === 'save' ? '正在保存整组…' : kind === 'contact' ? '正在生成对照图…' : '正在准备整组图片…');
    try {
      if (kind === 'contact') {
        const sheetCanvas = await renderSheet(batch.plan);
        if (canceled()) { cleanupCanvas(sheetCanvas); throw new ExportCanceled(); }
        await sendPart(batch, 0, sheetCanvas, canceled);
        if (canceled()) throw new ExportCanceled();
        const done = await host.exportDone(batch.token);
        setExportInfo(done?.written ? '对照已复制：粘一次，拼好的图和对应说明会一起带过去。' : '对照图没导出成功。', done?.written ? 'ok' : 'warn');
        return;
      }
      const total = batch.plan.images.length + 1;
      const overview = await renderOverview(batch.plan);
      if (canceled()) { cleanupCanvas(overview); throw new ExportCanceled(); }
      await sendPart(batch, 0, overview, canceled);
      setExportInfo(`已准备 1 / ${total} 个文件`);
      for (const image of batch.plan.images) {
        if (canceled()) throw new ExportCanceled();
        const canvas = await renderSingle(batch.plan, image);
        if (canceled()) { cleanupCanvas(canvas); throw new ExportCanceled(); }
        await sendPart(batch, image.index + 1, canvas, canceled);
        if (canceled()) throw new ExportCanceled();
        setExportInfo(`已准备 ${image.index + 2} / ${total} 个文件`);
      }
      if (canceled()) throw new ExportCanceled();
      const done = await host.exportDone(batch.token);
      setExportInfo(kind === 'save'
        ? `已保存 ${done.written} 张图片和说明.txt。`
        : '整组图片已复制；在接收应用里粘贴即可（有些应用只接文字，可用“复制说明”）。', 'ok');
    } catch (error) {
      if (error instanceof ExportCanceled || canceled()) {
        // 幂等补退：begin 之后、渲染之后任何位置被取消，都不能把批次留在 main 里。
        const result = await abortBatch(batch.token);
        const published = (result && result.published) || (state.exportAbortResult && state.exportAbortResult.published);
        setExportInfo(published
          ? '已经开始发布，这次停止没有生效；已经交出去的文件收不回来。'
          : '已停止导出；已经写好的文件保留。', 'warn');
      } else {
        setExportInfo(`导出没完成：${error?.message || error}`, 'warn');
        try { await host.exportAbort(batch.token); } catch { /* 可能已经结束。 */ }
      }
    } finally {
      state.exportBatch = undefined;
      state.busy = false;
      syncChrome();
    }
  }

  // —— UI 状态 ——
  function syncChrome() {
    for (const button of document.querySelectorAll('.ws-tool')) {
      button.setAttribute('aria-pressed', button.dataset.tool === state.tool ? 'true' : 'false');
    }
    const disabled = state.busy || !state.group;
    for (const id of ['copyAll', 'saveAll', 'copyNotes', 'copyContact', 'undo', 'redo']) el(id).disabled = disabled;
    el('copyAll').textContent = state.busy ? '正在准备…' : '复制这组图片';
    el('saveAll').textContent = state.busy ? '正在准备…' : '保存整组';
    el('stopExport').hidden = !state.busy;
    const refs = selectedRefs();
    const relation = state.activeRelationId ? state.group?.relations.find(item => item.id === state.activeRelationId) : undefined;
    // 按钮一直占位（disabled 而不是 hidden）：工具栏不因选中状态变宽变窄，画布不会跳。
    el('aimTarget').disabled = disabled || !refs.length;
    el('editNote').disabled = disabled || refs.length !== 1 || Boolean(state.linkPick) || Boolean(relation);
    el('linkPick').disabled = disabled || !refs.length || Boolean(state.linkPick);
    el('linkSelected').disabled = disabled || refs.length !== 2 || Boolean(state.linkPick);
    el('editRelation').disabled = disabled || !relation;
    el('dropRelation').disabled = disabled || !relation;
    el('aimTarget').textContent = state.aim ? '取消再指' : '再指一处';
    const pending = state.group ? pendingNow().length : 0;
    fileInfo.textContent = state.group
      ? `${state.group.images.length} 张图 · ${state.group.notes.length} 条意见 · ${state.group.relations.length} 条关系 · 第 ${state.revision} 版`
        + `${pending ? ` · ${pending} 处待补说明` : ''}${state.saveFailed ? ' · 有修改没保存' : ''}`
      : '';
  }

  function dismissCloseRequest() {
    banner.hidden = true;
    el('bannerNo')?.blur();
  }

  // 关闭时的提示：未保存优先；只有草稿（未写说明）就说明草稿会留在组里，不拷人也不锁死退出。
  // 输入框里还没提交的字先归位；存不住就留现场，不让人是在不知情下关掉。
  function requestClose() {
    if (!finishComposerOnLeave()) {
      bannerText.textContent = '输入框里还有字没存进这一组（没通过检查），先处理再关。';
      banner.hidden = false;
      el('bannerNo')?.focus();
      return;
    }
    const pending = state.group ? pendingNow().length : 0;
    bannerText.textContent = state.saveFailed
      ? '这组还有修改没保存成功，关掉就找不回来了。'
      : state.dirty || state.saving
        ? '还有修改没保存完，关掉会丢这次改动。'
        : pending
          ? `还有 ${pending} 处只有标记没写说明，会作为草稿留着；现在关也能再打开继续，不会丢。`
          : '关掉工作台？没保存完的改动会丢。';
    banner.hidden = false;
    // 弹出来先把焦点给“继续编辑”，回车不会误关。
    el('bannerNo')?.focus();
  }

  // 真关窗前的最后一道：把输入收进模型、把模型落到盘（等到最新一轮存完）；存不住就不关。
  async function closeNow() {
    if (!finishComposerOnLeave()) return;
    if (!(await waitForSave())) {
      setHint('没能保存成功，先别关；改动还在这扇窗里。');
      setSaveState('failed');
      return;
    }
    host.forceClose();
  }

  // —— 绑定 ——
  for (const button of document.querySelectorAll('.ws-tool')) {
    button.addEventListener('click', () => {
      // 切工具也是离开当前输入框：先安全收尾，失败就留在原处。
      if (!finishComposerOnLeave()) return;
      state.tool = button.dataset.tool;
      // 切到圈点批注时保留选中的意见：这就是“再圈一处”的追加目标入口；遮盖不需要选中。
      if (state.tool === 'mask') select(undefined);
      setHint(state.tool === 'annotate' ? '在图里拖一个框，或点一下放个点；标好几处再回头选两处建立关系。'
        : state.tool === 'mask' ? '圈一块就盖成纯色；原图仍在本机历史里。'
        : defaultHint());
      syncChrome();
    });
  }
  el('undo').addEventListener('click', () => { if (finishComposerOnLeave()) undo(); });
  el('redo').addEventListener('click', () => { if (finishComposerOnLeave()) redo(); });
  el('fit').addEventListener('click', fitView);
  el('zoomIn').addEventListener('click', () => {
    const rect = stage.getBoundingClientRect();
    zoomBy(1.2, { x: rect.width / 2, y: rect.height / 2 });
  });
  el('zoomOut').addEventListener('click', () => {
    const rect = stage.getBoundingClientRect();
    zoomBy(1 / 1.2, { x: rect.width / 2, y: rect.height / 2 });
  });
  el('copyAll').addEventListener('click', () => runExport('copy'));
  el('copyContact').addEventListener('click', () => runExport('contact'));
  el('saveAll').addEventListener('click', () => runExport('save'));
  el('stopExport').addEventListener('click', stopExport);
  el('copyNotes').addEventListener('click', async () => {
    if (!finishComposerOnLeave()) return;
    if (blockIfIncomplete('还不能复制说明：')) return;
    // main 的 copyNotes 会重新读库生成说明，所以先等最新模型落盘，否则会复制到旧文字。
    if (!(await waitForSave())) {
      setExportInfo('还有修改没存进这一组，说明没复制（避免复制到旧文字）。', 'warn');
      return;
    }
    try { await host.copyNotes(); setExportInfo('说明已复制到剪贴板。', 'ok'); }
    catch (error) { setExportInfo(`说明没复制成：${error?.message || error}`, 'warn'); }
  });
  el('hide')?.addEventListener('click', () => host.hide());
  el('aimTarget').addEventListener('click', () => { if (state.aim) cancelAim(); else beginAim(); });
  el('linkPick').addEventListener('click', beginLinkPick);
  el('editNote').addEventListener('click', editNote);
  el('linkSelected').addEventListener('click', associateSelection);
  el('editRelation').addEventListener('click', editRelation);
  el('dropRelation').addEventListener('click', deleteRelation);
  el('composerSubmit').addEventListener('click', () => commitComposer());
  el('bannerYes').addEventListener('click', () => { closeNow(); });
  el('bannerNo').addEventListener('click', dismissCloseRequest);
  // 关闭确认开着时，Esc 等同“继续编辑”，回车也不默认放弃。
  document.addEventListener('keydown', event => {
    if (banner.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); dismissCloseRequest(); }
    else if (event.key === 'Enter' && document.activeElement === el('bannerYes')) {
      event.preventDefault(); event.stopImmediatePropagation(); closeNow();
    }
  }, true);

  titleInput.addEventListener('change', () => {
    const text = titleInput.value.trim();
    if (!text || !state.group) { titleInput.value = state.group?.title || ''; return; }
    try { apply(Group.setTitle(state.group, text)); }
    catch (error) { setHint(`组名没改成：${error?.message || error}`); titleInput.value = state.group.title; }
  });

  // 双击标题栏文字：给图改名。
  imagesLayer.addEventListener('dblclick', event => {
    const label = event.target.closest?.('.ws-label');
    if (!label) return;
    const id = label.closest('.ws-image')?.dataset.id;
    const image = imageById(id);
    if (!image) return;
    const name = window.prompt('给这张图起个名字（只影响组内显示）', image.name);
    if (name !== null) renameImage(image.id, name);
  });

  stage.addEventListener('pointerdown', event => {
    if (event.target === composer || composer.contains(event.target)) return;
    onStagePointerDown(event);
  });
  stage.addEventListener('pointermove', onStagePointerMove);
  stage.addEventListener('pointerup', onStagePointerUp);
  // 指针被系统/窗口抢走：取消当前草稿与拖拽，不把半截当提交。
  stage.addEventListener('pointercancel', () => {
    const had = Boolean(state.draft || state.drag || state.linking);
    state.draft = undefined;
    state.drag = undefined;
    state.dragFrame = undefined;
    state.linking = undefined;
    delete stage.dataset.panning;
    renderImages();
    if (had) setHint('这次拖动被打断了，没有提交。');
  });
  stage.addEventListener('wheel', event => {
    if (!state.group) return;
    event.preventDefault();
    const screen = stagePointOf(event);
    zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1, screen);
  }, { passive: false });

  composerText.addEventListener('keydown', event => {
    // 输入法 composing 时 Enter 不提交。
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      event.stopPropagation();
      commitComposer();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      // 别让文档级 Esc 接着清掉刚选中的目标（双击处理会让人以为“关掉输入框就丢选中”）。
      event.stopPropagation();
      // 关系：Esc 是明确的“取消”，不建不改，也说清这次输入作废；
      // 意见文字：Esc 收起但保留已写的字，不静默丢输入。
      if (state.editing?.kind === 'relation') {
        const editingExisting = Boolean(state.editing.relationId);
        closeComposer();
        setHint(editingExisting ? '已取消，这条关系的原文没有改；刚才输入的字已作废。' : '这次关系没有建立，原来两处都没动。');
      } else {
        if (state.editing) finishComposerOnLeave(); else closeComposer();
        setHint('已收起；已写的字存下来了。');
      }
    }
  });
  composerText.addEventListener('input', () => {
    // 输入也算未保存编辑：标题×关窗时主进程要能拦住并问一句。
    syncInputDirty();
    const count = Array.from(composerText.value).length;
    if (count >= 2000) composerHint.textContent = `已经 ${count} 字，到上限了，再长会写不进去。`;
  });

  document.addEventListener('keydown', event => {
    const inField = event.target && (event.target.tagName === 'TEXTAREA' || event.target.tagName === 'INPUT');
    if (event.code === 'Space' && !inField) { state.space = true; stage.dataset.space = 'true'; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !inField) {
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
      return;
    }
    if (event.key === 'Escape') {
      // 输入框自己的 Esc 由它自己收尾（保留已写的字），文档级不再插手。
      if (inField) return;
      // 先取消正在进行的草稿/拖拽/连线，不要 Esc 一下就把选中丢了。
      if (state.aim && !state.draft && !state.drag) {
        cancelAim();
        event.preventDefault();
        return;
      }
      if (state.linkPick && !state.draft && !state.drag) {
        cancelLinkPick();
        event.preventDefault();
        return;
      }
      if (state.draft || state.drag || state.linking) {
        state.draft = undefined;
        state.drag = undefined;
        state.dragFrame = undefined;
        state.linking = undefined;
        state.aim = undefined;
        state.linkPick = undefined;
        renderImages();
        drawLinks();
        syncChrome();
        setHint('这次拖动或框选已取消。');
        event.preventDefault();
        return;
      }
      if (!state.editing) {
        select(undefined);
        setHint(defaultHint());
      }
    }
    if (event.key === 'Delete' && state.activeRelationId && !inField) {
      deleteRelation();
      return;
    }
    if (event.key === 'Delete' && state.activeNoteId && !inField) {
      try {
        const noteId = state.activeNoteId;
        const attached = Group.relationsOfNote(state.group, noteId).length;
        apply(Group.deleteNote(state.group, noteId));
        pruneSelection();
        renderImages();
        drawLinks();
        syncChrome();
        setHint(attached
          ? `这条意见已删掉，连同它牵着的 ${attached} 条关系；Ctrl+Z 可以撤销。`
          : '这条意见已删掉；Ctrl+Z 可以撤销。');
      } catch (error) { setHint(`删不掉：${error?.message || error}`); }
    }
  });
  document.addEventListener('keyup', event => {
    if (event.code === 'Space') { state.space = false; delete stage.dataset.space; }
  });
  window.addEventListener('blur', () => { state.space = false; delete stage.dataset.space; });
  // 页面销毁/换组时释放预览位图，不让 img/bitmap 堆到进程退出。
  window.addEventListener('unload', clearPreviews);
  window.addEventListener('beforeunload', clearPreviews);

  // 只读诊断：只报预览缓存与导出代次，不参与业务，供隐藏验收核对预算。
  window.__workspaceStats = () => ({ previews: previewCache.size, previewBytes, exportGen: state.exportGen, busy: state.busy });
  // 只读诊断：把一次屏幕坐标的命中结果算出来（不修改任何状态），供隐藏验收核对命中优先级。
  window.__workspaceHitTest = (clientX, clientY) => {
    const screen = stagePointOf({ clientX, clientY });
    const point = toWorld(screen.x, screen.y);
    const image = Group.imageAtWorld(state.group.images, point);
    if (!image) return { imageId: undefined };
    const source = Group.sourceAtScreen(image, state.view, screen);
    const handle = handleAt(image, source);
    const hit = targetAt(image, source);
    const stageRect = stage.getBoundingClientRect();
    return { imageId: image.id, source, handle,
      stage: { left: stageRect.left, top: stageRect.top, width: stageRect.width, height: stageRect.height },
      pan: { x: state.view.panX, y: state.view.panY },
      hit: hit ? { noteId: hit.note.id, targetId: hit.target.id, kind: hit.target.kind } : undefined };
  };

  // 只读诊断：选中/工具/输入状态，供隐藏验收断言真实状态，不提供任何修改能力。
  window.__workspaceDebug = () => ({
    tool: state.tool, space: state.space, zoom: state.view.zoom,
    selection: state.selection.map(item => ({ noteId: item.noteId, targetId: item.targetId })),
    activeNoteId: state.activeNoteId, activeTargetId: state.activeTargetId,
    relationId: state.activeRelationId, linkPick: Boolean(state.linkPick), aim: Boolean(state.aim),
    linking: state.linking ? { noteId: state.linking.noteId, targetId: state.linking.targetId } : undefined,
    editing: state.editing ? { kind: state.editing.kind, relationId: state.editing.relationId, noteId: state.editing.noteId } : undefined,
    inputDirty: state.inputDirty, dirty: state.dirty,
    frame: state.activeImageId ? imageById(state.activeImageId)?.frame : undefined,
    sourceWidth: state.activeImageId ? imageById(state.activeImageId)?.width : undefined,
    activeRect: activeTarget()?.rect,
    drag: state.drag ? state.drag.kind : undefined,
    targets: state.group ? state.group.notes.flatMap((note, index) => note.targets.map(target => ({
      noteNumber: index + 1, id: target.id, imageId: target.imageId, kind: target.kind,
      rect: target.rect, point: target.point
    }))) : []
  });

  // 页面状态推送（主进程保存/导出后的权威回填）。
  host.onState(next => {
    if (!next || !next.document) return;
    // 只在没有本地未保存改动时接受外部回填，避免把正在写的草稿覆盖掉。
    if (state.dirty) return;
    const incomingRevision = next.revision;
    if (incomingRevision === state.revision && state.group) return;
    // 外部回填也不降版：旧推送不能把已达到的第 2 版拉回第 1 版。
    state.group = Group.keepVersion(Group.validate(next.document), state.group);
    state.modelSeq += 1;
    state.revision = incomingRevision || state.group.revision || 0;
    titleInput.value = state.group.title;
    renderAll();
    if (!state.loaded) { state.loaded = true; fitView(); }
  });
  host.onCloseRequest(requestClose);

  // 首次加载。
  host.state().then(next => {
    state.group = Group.validate(next.document);
    state.revision = next.revision;
    state.loaded = true;
    titleInput.value = state.group.title;
    renderAll();
    fitView();
    setSaveState(next.saveFailed ? 'failed' : 'saved');
    setHint(defaultHint());
    if (next.saveFailed) setExportInfo('上次保存没有成功，改动可能没落定；先再改一下或重开这组。', 'warn');
  }).catch(error => {
    setHint(`工作台没准备好：${error?.message || error}`);
  });
})();
