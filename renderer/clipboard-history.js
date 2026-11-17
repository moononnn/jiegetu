/* 剪贴板历史页：只通过窄 IPC 取列表与动作；不碰 fs、不拼绝对路径、不执行 HTML。
   交互模型：点行选中，双击或回车粘贴；复制/收藏/删除在行内，备注与置顶在底部选中条。
   搜索 200ms 防抖；旧查询结果不能覆盖新查询；过滤/翻页时明确清空选择。 */
(() => {
  'use strict';
  const host = window.clipboardHost;
  const el = id => document.getElementById(id);
  const list = el('list');
  const empty = el('empty');
  const statusLine = el('status');
  const statusDot = el('statusDot');
  const gate = el('gate');
  const search = el('search');
  const kinds = el('kinds');
  const prev = el('prev');
  const next = el('next');
  const pageInfo = el('pageInfo');
  const selectionBar = el('selectionBar');
  const selectionInfo = el('selectionInfo');
  const noteButton = el('note');
  const pinButton = el('pin');
  const annotateButton = el('annotate');
  const copyManyButton = el('copyMany');
  const sendManyButton = el('sendMany');
  const pickInfo = el('pickInfo');
  const panel = el('panel');
  const settingsModal = el('settingsModal');
  const staleRefresh = el('staleRefresh');
  const lightbox = el('lightbox');
  const stage = el('lightboxStage');
  const lightboxImage = el('lightboxImage');
  const toast = el('toast');
  let toastTimer;

  const state = {
    clipboard: undefined,
    phase: 'stopped',
    tab: 'history',
    query: '',
    kind: '',
    page: 1,
    rows: [],
    total: 0,
    pages: 1,
    selectedId: null,
    detail: undefined,
    // 多选只用于“一起批注”：选图不改变当前单击选中。
    picked: new Set(),
    groups: [],
    requestSeq: 0,
    objectUrls: new Map(),
    busy: false,
    revision: null,
    lightboxUrl: null,
    // 看大图时的缩放/平移：scale 相对“适应窗口”，1 就是刚打开看到的那个大小。
    view: { scale: 1, x: 0, y: 0, dragging: false, moved: false, lastDragAt: 0, startX: 0, startY: 0, originX: 0, originY: 0 },
    lightboxId: null,
    // 预览请求代次：关窗/关预览/另开一张都会 +1，晚到的 image/imageFull 回包对不上就丢弃。
    previewSeq: 0,
    fullRequested: false
  };
  let searchTimer;
  const KIND_MARK = { text: '字', link: '链', image: '图', files: '件' };
  const iconTemplates = el('iconTemplates');
  function iconNode(name) {
    const source = iconTemplates.content.querySelector(`[data-icon="${name}"]`);
    return source ? source.cloneNode(true) : null;
  }

  let transientUntil = 0;
  // 阶段状态：每次 syncChrome 都会刷新，不保留。
  function setStatus(text, tone = '') {
    transientUntil = 0;
    statusLine.textContent = text || '';
    statusLine.dataset.tone = tone;
    statusDot.dataset.tone = tone;
  }
  // 操作结果：停留几秒，期间 syncChrome 不覆盖。
  function setResult(text, tone = '', holdMs = 4200) {
    transientUntil = Date.now() + holdMs;
    statusLine.textContent = text || '';
    statusLine.dataset.tone = tone;
    statusDot.dataset.tone = tone;
  }

  // 贴在列表顶部的小提示，几秒后自己收；只用于失败这种“你已经看不到窗口”的事。
  function showToast(text, tone = '', ms = 3200) {
    if (!text) return;
    toast.textContent = text;
    toast.dataset.tone = tone;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, ms);
  }

  function formatTime(ms) {
    if (!Number.isFinite(ms)) return '';
    const date = new Date(ms);
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    const pad = value => String(value).padStart(2, '0');
    if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  }

  function phaseText() {
    const clipboard = state.clipboard;
    if (!clipboard || !clipboard.enabled) return { text: '记录未开启 · 历史仍可查看和复制', tone: 'warn' };
    if (state.phase === 'interrupted') return { text: '记录已中断 · 关掉再打开记录能重启监听', tone: 'warn' };
    if (clipboard.paused || state.phase === 'paused') return { text: '已暂停记录 · 新的复制不会入库', tone: 'warn' };
    if (state.phase === 'ready') return { text: '正在记录 · 只存在本机', tone: 'ok' };
    return { text: '正在准备监听…', tone: '' };
  }

  function syncChrome() {
    const clipboard = state.clipboard;
    const enabled = Boolean(clipboard && clipboard.enabled);
    gate.hidden = enabled;
    const status = phaseText();
    if (Date.now() >= transientUntil) setStatus(status.text, status.tone);

    const selected = state.rows.find(row => row.id === state.selectedId);
    const isGroups = state.tab === 'groups';
    selectionBar.hidden = !selected || isGroups;
    if (selected) {
      selectionInfo.textContent = `第 ${state.rows.findIndex(row => row.id === selected.id) + 1} 条`;
      pinButton.textContent = selected.pinned ? '取消置顶' : '置顶';
      pinButton.hidden = false;
      noteButton.hidden = false;
    }
    prev.disabled = state.page <= 1 || state.busy || isGroups;
    next.disabled = state.page >= state.pages || state.busy || isGroups;
    pageInfo.textContent = isGroups ? `共 ${state.groups.length} 个批注组` : `${state.page} / ${state.pages} 页 · ${state.total} 条`;

    const pickedImages = state.rows.filter(row => state.picked.has(row.id) && row.kind === 'image').length;
    annotateButton.disabled = state.busy || isGroups || pickedImages < 2;
    annotateButton.textContent = pickedImages ? `一起批注（${pickedImages}）` : '一起批注';
    copyManyButton.hidden = isGroups || state.picked.size === 0;
    copyManyButton.disabled = state.busy;
    copyManyButton.textContent = state.picked.size ? `复制所选（${state.picked.size}）` : '复制所选';
    sendManyButton.hidden = isGroups || state.picked.size === 0;
    sendManyButton.disabled = state.busy;
    sendManyButton.textContent = state.picked.size ? `发送所选（${state.picked.size}）` : '发送所选';
    pickInfo.textContent = state.picked.size ? `已勾 ${state.picked.size} 条` : '';
    kinds.hidden = isGroups;
  }

  function clearSelection() {
    state.selectedId = null;
    state.detail = undefined;
    state.picked.clear();
    for (const url of state.objectUrls.values()) { try { URL.revokeObjectURL(url); } catch { /* 已释放。 */ } }
    state.objectUrls.clear();
  }

  function revokeFor(id) {
    const url = state.objectUrls.get(id);
    if (url) { try { URL.revokeObjectURL(url); } catch { /* 已释放。 */ } state.objectUrls.delete(id); }
  }

  async function refresh() {
    const seq = ++state.requestSeq;
    state.busy = true;
    syncChrome();
    try {
      if (state.tab === 'groups') {
        const groups = await host.groups();
        if (seq !== state.requestSeq) return;
        state.groups = Array.isArray(groups) ? groups : [];
        state.rows = [];
        renderGroups();
        return;
      }
      const result = await host.list({
        query: state.query, kind: state.kind, favorite: state.tab === 'favorite', page: state.page
      });
      if (seq !== state.requestSeq) return; // 旧查询结果直接丢弃
      state.rows = Array.isArray(result.rows) ? result.rows : [];
      state.total = result.total || 0;
      state.pages = result.pages || 1;
      state.page = result.page || 1;
      render();
      if (state.tab === 'history' || state.tab === 'favorite') staleRefresh.hidden = true;
    } catch (error) {
      if (seq !== state.requestSeq) return;
      state.rows = [];
      state.total = 0;
      state.pages = 1;
      render();
      setResult(`读取历史失败：${error?.message || error}`, 'warn');
    } finally {
      if (seq === state.requestSeq) { state.busy = false; syncChrome(); }
    }
  }

  function buildThumb(row) {
    const thumb = document.createElement('div');
    thumb.className = 'clip-thumb';
    thumb.dataset.id = String(row.id);
    const mark = document.createElement('span');
    mark.className = 'clip-mark';
    mark.textContent = row.kind === 'image' ? '图' : (KIND_MARK[row.kind] || '字');
    thumb.append(mark);
    if (row.kind === 'image') {
      thumb.classList.add('zoomable');
      thumb.title = '点开看大图';
      thumb.addEventListener('click', event => { event.stopPropagation(); openLightbox(row.id); });
    }
    return thumb;
  }

  // —— 看大图 ——
  const ZOOM_MIN = 0.3, ZOOM_MAX = 8, ZOOM_STEP = 1.18;
  // 拖动不能把图拖出去：图片大于舞台时才允许平移，并且边缘不能进到舞台里面。
  // 这就是“看大图该有的手感”：没放大时拖不动（因为整张已经看得见），缩小到适应时自动居回来。
  function clampView() {
    const view = state.view;
    const rect = stage.getBoundingClientRect();
    const baseW = (lightboxImage.offsetWidth || 0) * view.scale;
    const baseH = (lightboxImage.offsetHeight || 0) * view.scale;
    if (!baseW || !baseH || !rect.width || !rect.height) { view.x = 0; view.y = 0; return false; }
    const maxX = Math.max(0, (baseW - rect.width) / 2);
    const maxY = Math.max(0, (baseH - rect.height) / 2);
    view.x = Math.min(maxX, Math.max(-maxX, view.x));
    view.y = Math.min(maxY, Math.max(-maxY, view.y));
    return maxX > 0 || maxY > 0;
  }
  function applyView() {
    const view = state.view;
    // 整张都看得见就不该能拖，光标也不该是抓手。
    const pannable = clampView();
    lightboxImage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    const percent = Math.round(view.scale * 100);
    el('zoomReset').textContent = view.scale === 1 ? '适应' : `${percent}%`;
    stage.classList.toggle('zoomed', view.scale > 1.02);
    stage.classList.toggle('pannable', pannable);
  }
  function resetView() {
    state.view.scale = 1; state.view.x = 0; state.view.y = 0;
    applyView();
  }
  // 以指针为不动点缩放：放大时指着哪里，哪里就留在原地。
  function zoomAt(nextScale, offsetX, offsetY) {
    const view = state.view;
    const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nextScale));
    if (scale === view.scale) return;
    const ratio = scale / view.scale;
    view.x = offsetX - (offsetX - view.x) * ratio;
    view.y = offsetY - (offsetY - view.y) * ratio;
    view.scale = scale;
    applyView();
    // 放大超过一点就换原图：预览图最长边只有 1600，再放就是糊的。
    if (scale > 1.2) ensureFullImage();
  }
  // 原图按需加载，只取一次；拿不到就继续用预览图，不报错。
  async function ensureFullImage() {
    if (state.fullRequested) return;
    const id = state.lightboxId;
    if (!id || typeof host.imageFull !== 'function') return;
    state.fullRequested = true;
    const seq = state.previewSeq;
    let bytes;
    try { bytes = await host.imageFull(id); }
    catch { return; }
    // 先守住空/无效字节：空响应不能顶掉已经在看的那张预览。
    if (!bytes || !bytes.length) return;
    // 期间关掉了预览/换了图/收回窗口：晚到的回包不能把大图又打开。
    if (seq !== state.previewSeq || state.lightboxId !== id || lightbox.hidden) return;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    const previous = state.lightboxUrl;
    state.lightboxUrl = url;
    lightboxImage.src = url;
    if (previous) { try { URL.revokeObjectURL(previous); } catch { /* 已释放。 */ } }
  }
  function centerOffset() {
    const rect = stage.getBoundingClientRect();
    return { x: rect.width / 2, y: rect.height / 2, rect };
  }
  async function openLightbox(id) {
    const row = state.rows.find(item => item.id === id);
    if (!row || row.kind !== 'image') return;
    const seq = ++state.previewSeq;
    let bytes;
    try { bytes = await host.image(id); }
    catch (error) {
      // 这次请求已经作废（关了预览/换了图/收了窗口）就别用旧错误去盖当前状态。
      if (seq === state.previewSeq) setResult(`大图没读出来：${error?.message || error}`, 'warn');
      return;
    }
    // 读图期间关掉预览、关窗或另开了一张：这次回包作废。
    if (seq !== state.previewSeq) return;
    if (!bytes || !bytes.length) { setResult('这张图读不出来，可能原件已经不在了。', 'warn'); return; }
    closeLightbox();
    state.lightboxId = id;
    state.fullRequested = false;
    state.lightboxUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    lightboxImage.src = state.lightboxUrl;
    // 图还没布局时 offsetWidth 是 0，居中与边界要等它真出尺寸再算一次。
    // 只重算不重置：放大后换原图也会触发 onload，那一下把使用者刚放大的视图回正很吓人。
    lightboxImage.onload = () => { if (state.lightboxId === id) applyView(); };
    el('lightboxMeta').textContent = `${row.width || '?'} × ${row.height || '?'} · ${formatTime(row.lastUsedAt || row.createdAt)}`;
    lightbox.hidden = false;
    resetView();
    el('lightboxEdit').hidden = !host.openEditor;
    // 不再把焦点给已删除的关闭按钮：让舞台自己接键盘，Esc 照样能收。
    try { stage.focus?.({ preventScroll: true }); } catch { /* 拿不到焦点也不影响看图。 */ }
  }
  function closeLightbox() {
    // 无论原本开没开，关一次就作废所有在途的 image/imageFull 回包。
    state.previewSeq += 1;
    if (lightbox.hidden) return false;
    lightbox.hidden = true;
    state.lightboxId = null;
    resetView();
    if (state.lightboxUrl) { try { URL.revokeObjectURL(state.lightboxUrl); } catch { /* 已释放。 */ } state.lightboxUrl = null; }
    lightboxImage.removeAttribute('src');
    return true;
  }

  function buildActions(row) {
    const actions = document.createElement('div');
    actions.className = 'clip-actions';
    const make = (act, title, icon, extra = '') => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `clip-act${extra}`;
      button.dataset.act = act;
      button.title = title;
      button.setAttribute('aria-label', title);
      const node = icon ? iconNode(icon) : null;
      if (node) button.append(node);
      return button;
    };
    actions.append(
      make('paste', '粘贴到刚才的窗口', 'paste'),
      make('copy', '复制到剪贴板', 'copy'),
      make('favorite', '收藏', null, ' star'),
      make('remove', '删除这条', 'remove', ' clip-act-danger')
    );
    const star = actions.querySelector('[data-act="favorite"]');
    star.textContent = '★';
    star.setAttribute('aria-pressed', row.favorite ? 'true' : 'false');
    return actions;
  }

  function render() {
    list.textContent = '';
    list.hidden = state.rows.length === 0;
    for (const id of [...state.objectUrls.keys()]) revokeFor(id);
    if (!state.rows.length) {
      empty.hidden = false;
      empty.textContent = state.query || state.kind || state.tab === 'favorite'
        ? '这个筛选下还没有记录。'
        : (state.clipboard && state.clipboard.enabled ? '还没有记录。复制点什么，它会自己出现在这里。' : '记录未开启，所以这里还是空的。');
    } else empty.hidden = true;

    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const node = entry.target;
        observer.unobserve(node);
        const id = Number(node.dataset.id);
        if (id) loadThumb(id, node);
      }
    }, { root: list, threshold: 0.01 });

    state.rows.forEach(row => {
      const item = document.createElement('article');
      item.className = 'clip-row';
      item.setAttribute('role', 'option');
      item.dataset.id = String(row.id);
      item.dataset.pinned = row.pinned ? 'true' : 'false';
      item.setAttribute('aria-selected', state.selectedId === row.id ? 'true' : 'false');
      item.setAttribute('tabindex', '-1');

      const pick = document.createElement('input');
      pick.type = 'checkbox';
      pick.className = 'clip-pick';
      pick.checked = state.picked.has(row.id);
      pick.title = row.kind === 'image' ? '勾上用于一起批注' : '这条不是图片，不会进批注组';
      pick.addEventListener('click', event => { event.stopPropagation(); togglePick(row.id, pick.checked); });

      const thumb = buildThumb(row);
      if (row.kind === 'image') observer.observe(thumb);

      const main = document.createElement('div');
      main.className = 'clip-main';
      const preview = document.createElement('p');
      preview.className = 'clip-preview';
      const text = row.kind === 'files'
        ? (row.files?.length ? `${row.files.length} 个文件 · ${row.files[0]}` : '文件列表')
        : (row.preview || row.text);
      if (text) preview.textContent = text;
      else if (row.kind === 'image') preview.textContent = '图片';
      else { preview.textContent = '（没有文字）'; preview.classList.add('empty'); }

      const meta = document.createElement('div');
      meta.className = 'clip-meta';
      const source = document.createElement('span');
      source.textContent = row.source ? row.source.replace(/\.exe$/i, '') : '来源未知';
      meta.append(source);
      const time = document.createElement('span');
      time.textContent = formatTime(row.lastUsedAt || row.createdAt);
      meta.append(time);
      if (row.kind === 'image' && row.width && row.height) {
        const size = document.createElement('span');
        size.textContent = `${row.width} × ${row.height}`;
        meta.append(size);
      }
      for (const tag of row.tags || []) {
        const chip = document.createElement('span');
        chip.className = 'tag';
        chip.textContent = tag;
        meta.append(chip);
      }
      if (row.note) {
        const note = document.createElement('span');
        note.textContent = row.note;
        meta.append(note);
      }
      main.append(preview, meta);

      item.append(pick, thumb, main, buildActions(row));
      item.addEventListener('click', () => select(row.id));
      item.addEventListener('dblclick', event => {
        if (event.target instanceof Element && event.target.closest('.clip-act')) return;
        select(row.id);
        pasteSelected();
      });
      list.append(item);
    });
    syncChrome();
  }

  // 行内动作统一走委托：按钮是每次渲染新建的，不逐个挂监听。
  list.addEventListener('click', event => {
    const action = event.target instanceof Element ? event.target.closest('.clip-act') : null;
    if (!action) return;
    event.stopPropagation();
    const item = action.closest('.clip-row');
    const id = Number(item?.dataset.id);
    if (!id) return;
    const row = state.rows.find(entry => entry.id === id);
    if (!row) return;
    switch (action.dataset.act) {
      case 'paste': select(id); pasteById(id); break;
      case 'copy': select(id); copyById(id); break;
      case 'favorite': toggleFavorite(id, !row.favorite); break;
      case 'remove': removeById(id); break;
      default: break;
    }
  });

  async function loadThumb(id, node) {
    if (state.objectUrls.has(id)) return;
    try {
      const bytes = await host.thumb(id);
      if (!bytes || !bytes.length) return;
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      state.objectUrls.set(id, url);
      node.textContent = '';
      const image = document.createElement('img');
      image.src = url;
      image.alt = '';
      node.append(image);
    } catch { /* 缩略图失败不影响文字列表。 */ }
  }

  function togglePick(id, on) {
    if (on) state.picked.add(id); else state.picked.delete(id);
    syncChrome();
  }

  function renderGroups() {
    list.textContent = '';
    list.hidden = state.groups.length === 0;
    for (const id of [...state.objectUrls.keys()]) revokeFor(id);
    if (!state.groups.length) {
      empty.hidden = false;
      empty.textContent = '还没有批注组。勾选两张以上图片，点“一起批注”。';
    } else empty.hidden = true;
    for (const group of state.groups) {
      const item = document.createElement('article');
      item.className = 'clip-row clip-group';
      item.dataset.id = String(group.id);
      item.setAttribute('role', 'option');
      item.setAttribute('tabindex', '-1');
      const thumb = document.createElement('div');
      thumb.className = 'clip-thumb';
      const mark = document.createElement('span');
      mark.className = 'clip-mark';
      mark.textContent = '组';
      thumb.append(mark);
      const main = document.createElement('div');
      main.className = 'clip-main';
      const title = document.createElement('p');
      title.className = 'clip-preview';
      title.textContent = group.title || '批注组';
      const meta = document.createElement('div');
      meta.className = 'clip-meta';
      const time = document.createElement('span');
      time.textContent = `上次保存 ${formatTime(group.updatedAt)} · 第 ${group.revision} 版`;
      meta.append(time);
      main.append(title, meta);
      item.append(thumb, main);
      item.addEventListener('click', () => openGroup(group.id));
      list.append(item);
    }
    syncChrome();
  }

  async function openGroup(groupId) {
    try { await host.openGroup(groupId); setResult('已打开这个批注组。', 'ok'); }
    catch (error) { setResult(`没能打开批注组：${error?.message || error}`, 'warn'); }
  }

  async function annotatePicked() {
    const images = state.rows.filter(row => state.picked.has(row.id) && row.kind === 'image');
    const others = state.picked.size - images.length;
    if (others > 0) setResult(`其中 ${others} 条不是静态图片，没有带进批注组。`, 'warn');
    if (images.length < 2) return;
    if (images.length > 16) { setResult('一组最多 16 张图，先少勾几张。', 'warn'); return; }
    state.busy = true;
    syncChrome();
    try {
      await host.openWorkspace(images.map(row => row.id));
      setResult(`已在新工作台里打开 ${images.length} 张图。`, 'ok');
    } catch (error) { setResult(`没能打开工作台：${error?.message || error}`, 'warn'); }
    finally { state.busy = false; syncChrome(); }
  }

  function select(id) {
    state.selectedId = id;
    for (const node of list.querySelectorAll('.clip-row')) {
      node.setAttribute('aria-selected', node.dataset.id === String(id) ? 'true' : 'false');
    }
    syncChrome();
    host.get(id).then(row => {
      if (state.selectedId !== id) return;
      state.detail = row;
      if (row?.missingFiles?.length) {
        setResult(`这条文件里有 ${row.missingFiles.length} 个已经不在原位置了；复制只会给出旧路径。`, 'warn');
      }
    }).catch(() => {});
  }

  function moveSelection(step) {
    if (!state.rows.length) return;
    const index = state.rows.findIndex(row => row.id === state.selectedId);
    const nextIndex = Math.max(0, Math.min(state.rows.length - 1,
      index < 0 ? (step > 0 ? 0 : state.rows.length - 1) : index + step));
    select(state.rows[nextIndex].id);
    const node = list.querySelector(`.clip-row[data-id="${state.rows[nextIndex].id}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }

  async function copyById(id) {
    state.busy = true; syncChrome();
    try {
      const result = await host.copy(id);
      setResult(result?.copied ? '已复制到系统剪贴板。' : '复制没有完成。', result?.copied ? 'ok' : 'warn');
    } catch (error) { setResult(`复制失败：${error?.message || error}`, 'warn'); }
    finally { state.busy = false; syncChrome(); }
  }

  async function pasteById(id) {
    state.busy = true; syncChrome();
    // 粘贴时窗口会先收起来，成功与否当场看不到，所以成功不吐提示，只在没粘进去时提醒。
    try {
      const result = await host.paste(id);
      if (result?.pasted) return;
      const message = result?.message || '内容已复制；目标窗口没接住，自己按 Ctrl+V 就行。';
      setResult(message, 'warn');
      showToast(message, 'warn');
    } catch (error) {
      const message = `粘贴没有完成：${error?.message || error}`;
      setResult(message, 'warn');
      showToast(message, 'warn');
    } finally {
      state.busy = false;
      syncChrome();
    }
  }

  function copySelected() { if (state.selectedId) copyById(state.selectedId); }
  function pasteSelected() { if (state.selectedId) pasteById(state.selectedId); }

  // 多条合并复制：文本拼成一段，多张图只能作为文件，粘进聊天窗就是多个文件。
  // send=true 时复制完直接粘到呼出历史窗前的那个窗口。
  async function copyPicked(send = false) {
    const ids = state.rows.filter(row => state.picked.has(row.id)).map(row => row.id);
    if (!ids.length || state.busy) return;
    state.busy = true;
    syncChrome();
    setResult(`正在${send ? '合并发送' : '合并复制'} ${ids.length} 条…`);
    try {
      const result = await host.copyMany(ids, { paste: send });
      if (result?.pasted) return;
      const note = result?.imagesAsFiles ? `，其中 ${result.images} 张图已存成文件` : '';
      const where = result?.folder ? `（在 ${result.folder}）` : '';
      const message = result?.message || `已复制 ${ids.length} 条${note}，按 Ctrl+V 粘贴。`;
      setResult(result?.message ? message : `${message}${where}`, result?.message ? 'warn' : 'ok');
    } catch (error) {
      setResult(`复制失败：${error?.message || error}`, 'warn');
    } finally {
      state.busy = false;
      syncChrome();
    }
  }

  async function toggleFavorite(id, value) {
    try { await host.favorite(id, value); await refresh(); }
    catch (error) { setResult(`收藏没改成功：${error?.message || error}`, 'warn'); }
  }

  async function removeById(id) {
    const row = state.rows.find(entry => entry.id === id);
    const hint = row?.favorite || row?.pinned ? '这条已经收藏或置顶，删了也一起没。' : '它不会删你磁盘上的原文件。';
    if (!window.confirm(`删掉这条历史？${hint}`)) return;
    try {
      await host.remove(id);
      if (state.selectedId === id) clearSelection();
      await refresh();
      setResult('已删除这条历史。', 'ok');
    } catch (error) { setResult(`删除失败：${error?.message || error}`, 'warn'); }
  }

  // —— 备注/标签模态 ——
  function openPanel() {
    const row = state.rows.find(item => item.id === state.selectedId);
    if (!row) return;
    el('noteInput').value = state.detail?.note ?? row.note ?? '';
    el('tagInput').value = (state.detail?.tags ?? row.tags ?? []).join(', ');
    el('panelHint').textContent = '';
    panel.hidden = false;
    el('noteInput').focus();
  }
  function closePanel() { panel.hidden = true; }
  async function savePanel() {
    if (!state.selectedId) return;
    const tags = el('tagInput').value.split(/[,，]/).map(item => item.trim()).filter(Boolean).slice(0, 20);
    try {
      await host.note(state.selectedId, el('noteInput').value.slice(0, 4000));
      await host.tags(state.selectedId, tags);
      closePanel();
      setResult('备注和标签已保存。', 'ok');
      await refresh();
    } catch (error) { el('panelHint').textContent = `没保存成功：${error?.message || error}`; }
  }

  // —— 设置模态 ——
  function readSeg(id) {
    const seg = el(id);
    const on = seg.querySelector('button[aria-selected="true"]');
    return on ? Number(on.dataset.value) : null;
  }
  function setSeg(id, value) {
    const seg = el(id);
    const buttons = [...seg.querySelectorAll('button')];
    const values = buttons.map(button => Number(button.dataset.value));
    let target = values.includes(Number(value)) ? Number(value) : null;
    // 旧设置可能停在不在档位里的值：就近落到不小于它的一档，没有就取最大档。
    if (target === null) {
      target = values.find(item => item >= Number(value));
      if (target === undefined) target = values[values.length - 1];
    }
    for (const button of buttons) {
      button.setAttribute('aria-selected', Number(button.dataset.value) === target ? 'true' : 'false');
    }
  }
  function bindSeg(id) {
    el(id).addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest('button[data-value]') : null;
      if (!button) return;
      for (const other of el(id).querySelectorAll('button')) {
        other.setAttribute('aria-selected', other === button ? 'true' : 'false');
      }
    });
  }

  async function openSettings() {
    const clipboard = state.clipboard || {};
    setSeg('retention', clipboard.retentionDays || 30);
    setSeg('maxItems', clipboard.maxHistoryItems || 1000);
    setSeg('maxBytes', clipboard.maxStorageBytes || 2147483648);
    el('clipHotkey').value = clipboard.hotkey || 'Ctrl+Alt+V';
    el('excluded').value = (clipboard.excludedApps || []).join('\n');
    el('cleanupRun').disabled = true;
    el('clipHotkey').setAttribute('aria-invalid', 'false');
    settingsModal.hidden = false;
    updateUsage();
    el('clipHotkey').focus();
  }
  function closeSettings() { settingsModal.hidden = true; }
  async function updateUsage() {
    try {
      const stats = await host.stats();
      const size = value => (value >= 1073741824
        ? `${(value / 1073741824).toFixed(1)} GB`
        : `${Math.max(1, Math.round(value / 1048576))} MB`);
      el('usageInfo').textContent = `现在存了 ${stats.history} 条，原件占 ${size(stats.blobs)}，数据库 ${size(stats.dbBytes)}。`;
    } catch { el('usageInfo').textContent = '暂时读不到占用信息。'; }
  }
  async function saveSettings() {
    const hotkey = el('clipHotkey').value.trim() || 'Ctrl+Alt+V';
    const excludedApps = el('excluded').value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
    try {
      await host.updateClipboard({
        retentionDays: readSeg('retention'),
        maxHistoryItems: readSeg('maxItems'),
        maxStorageBytes: readSeg('maxBytes'),
        hotkey,
        excludedApps
      });
      closeSettings();
      setResult('设置已保存。', 'ok');
      await refresh();
    } catch (error) {
      el('clipHotkey').setAttribute('aria-invalid', 'true');
      el('usageInfo').textContent = `设置没保存成功：${error?.message || error}`;
    }
  }
  async function cleanupPreview() {
    try {
      const result = await host.cleanupPreview();
      const count = result?.count || 0;
      el('cleanupRun').disabled = count <= 0;
      el('usageInfo').textContent = count
        ? `按现在的范围可以清掉 ${count} 条旧记录。收藏、置顶、被批注组引用的不会动。`
        : '按现在的范围，没有需要清理的记录。';
    } catch (error) { el('usageInfo').textContent = `清理预检出错了：${error?.message || error}`; }
  }
  async function cleanupRun() {
    if (!window.confirm('清理后这些旧记录找不回来了；收藏、置顶和被批注组引用的不会删。继续吗？')) return;
    try {
      const result = await host.cleanup();
      setResult(`已清理 ${result?.removed || 0} 条旧记录。`, 'ok');
      await updateUsage();
      await refresh();
    } catch (error) { el('usageInfo').textContent = `清理失败：${error?.message || error}`; }
  }

  // —— 事件绑定 ——
  el('close').addEventListener('click', () => {
    // 看大图时，× 先退回历史列表（窗口还在用）；列表状态才真收起窗口。
    if (closeLightbox()) { syncChrome(); return; }
    host.hide();
  });
  for (const tab of document.querySelectorAll('.clip-tabs button')) {
    tab.addEventListener('click', () => {
      state.tab = tab.dataset.tab;
      for (const other of document.querySelectorAll('.clip-tabs button')) other.setAttribute('aria-selected', other === tab ? 'true' : 'false');
      state.page = 1;
      clearSelection();
      refresh();
    });
  }
  kinds.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest('button[data-kind]') : null;
    if (!button) return;
    state.kind = button.dataset.kind || '';
    for (const other of kinds.querySelectorAll('button')) other.setAttribute('aria-selected', other === button ? 'true' : 'false');
    state.page = 1;
    clearSelection();
    refresh();
  });
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = search.value.trim();
      state.page = 1;
      clearSelection();
      refresh();
    }, 200);
  });
  prev.addEventListener('click', () => { if (state.page > 1) { state.page -= 1; clearSelection(); refresh(); } });
  next.addEventListener('click', () => { if (state.page < state.pages) { state.page += 1; clearSelection(); refresh(); } });
  pinButton.addEventListener('click', async () => {
    const row = state.rows.find(item => item.id === state.selectedId);
    if (!row) return;
    try { await host.pinned(row.id, !row.pinned); await refresh(); setResult(row.pinned ? '已取消置顶。' : '已置顶。', 'ok'); }
    catch (error) { setResult(`置顶没改成功：${error?.message || error}`, 'warn'); }
  });
  noteButton.addEventListener('click', openPanel);
  annotateButton.addEventListener('click', annotatePicked);
  copyManyButton.addEventListener('click', () => copyPicked(false));
  sendManyButton.addEventListener('click', () => copyPicked(true));
  el('enable').addEventListener('click', async () => {
    try { await host.setEnabled(true); setResult('记录已开启；从现在开始的复制会存进本机历史。', 'ok'); await refresh(); }
    catch (error) { setResult(`开启失败：${error?.message || error}`, 'warn'); }
  });
  el('stay-off').addEventListener('click', () => { gate.hidden = true; });
  el('panelClose').addEventListener('click', closePanel);
  el('panelCancel').addEventListener('click', closePanel);
  el('panelSave').addEventListener('click', savePanel);
  el('openSettings').addEventListener('click', openSettings);
  el('settingsClose').addEventListener('click', closeSettings);
  el('settingsCancel').addEventListener('click', closeSettings);
  el('settingsSave').addEventListener('click', saveSettings);
  el('cleanupPreview').addEventListener('click', cleanupPreview);
  el('cleanupRun').addEventListener('click', cleanupRun);
  for (const id of ['retention', 'maxItems', 'maxBytes']) bindSeg(id);
  staleRefresh.addEventListener('click', () => { clearSelection(); refresh(); });
  // 关闭入口就是窗口右上角那个 ×，外加点空白与 Esc；栏里不再放重复的“关闭”。
  // 滚轮缩放：以指针为中心；按住拖动平移；双击在适应与 2 倍之间切换。
  stage.addEventListener('wheel', event => {
    if (lightbox.hidden) return;
    event.preventDefault();
    const { x, y, rect } = centerOffset();
    const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    zoomAt(state.view.scale * factor, event.clientX - rect.left - x, event.clientY - rect.top - y);
  }, { passive: false });
  stage.addEventListener('pointerdown', event => {
    if (lightbox.hidden || event.button !== 0) return;
    // 整张都看得见时拖不动：按住也不该进入拖拽态。
    if (!stage.classList.contains('pannable')) return;
    const view = state.view;
    view.dragging = true; view.moved = false;
    view.startX = event.clientX; view.startY = event.clientY;
    view.originX = view.x; view.originY = view.y;
    stage.classList.add('dragging');
    try { stage.setPointerCapture?.(event.pointerId); } catch { /* 没捕获也能拖。 */ }
  });
  stage.addEventListener('pointermove', event => {
    const view = state.view;
    if (!view.dragging) return;
    const dx = event.clientX - view.startX;
    const dy = event.clientY - view.startY;
    // 超过几个像素就当成拖拽，松手时那次 click 不算“点空白”。
    if (Math.abs(dx) + Math.abs(dy) > 4) view.moved = true;
    view.x = view.originX + dx;
    view.y = view.originY + dy;
    applyView();
  });
  const stopDrag = () => {
    if (!state.view.dragging) return;
    state.view.dragging = false;
    // 用时间戳而不是一次性的布尔：万一 click 没来，350 毫秒后自动失效，不会把下一次点空白挡掉。
    if (state.view.moved) state.view.lastDragAt = Date.now();
    stage.classList.remove('dragging');
  };
  stage.addEventListener('pointerup', stopDrag);
  stage.addEventListener('pointercancel', stopDrag);
  stage.addEventListener('dblclick', event => {
    if (lightbox.hidden) return;
    event.preventDefault();
    if (state.view.scale > 1.02) resetView();
    else { const { rect } = centerOffset(); zoomAt(2, event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2); }
  });
  el('zoomIn').addEventListener('click', () => { const { x, y } = centerOffset(); zoomAt(state.view.scale * ZOOM_STEP, x, y); });
  el('zoomOut').addEventListener('click', () => { const { x, y } = centerOffset(); zoomAt(state.view.scale / ZOOM_STEP, x, y); });
  el('zoomReset').addEventListener('click', resetView);
  el('lightboxEdit').addEventListener('click', async () => {
    const id = state.lightboxId;
    if (!id) return;
    closeLightbox();
    try { await host.openEditor(id); }
    catch (error) { setResult(`没打开编辑页：${error?.message || error}`, 'warn'); }
  });
  lightbox.addEventListener('click', event => {
    // 拖完松手也会跟一次 click；刚拖过的这一下不算点空白，否则一拖就把图关了。
    if (Date.now() - state.view.lastDragAt < 350) return;
    // 点图片本身不关，点周围空白才关。
    if (event.target === lightbox || event.target === stage) closeLightbox();
  });
  // 点遮罩收起模态，点卡片内部不关。
  for (const modal of [settingsModal, panel]) {
    modal.addEventListener('click', event => { if (event.target === modal) modal.hidden = true; });
  }

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (closeLightbox()) { event.preventDefault(); return; }
      if (!panel.hidden) { closePanel(); event.preventDefault(); return; }
      if (!settingsModal.hidden) { closeSettings(); event.preventDefault(); return; }
      host.hide();
      event.preventDefault();
      return;
    }
    if (event.target && (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA' || event.target.tagName === 'SELECT')) return;
    if (!panel.hidden || !settingsModal.hidden || !lightbox.hidden) return;
    if (event.key === 'ArrowDown') { moveSelection(1); event.preventDefault(); }
    else if (event.key === 'ArrowUp') { moveSelection(-1); event.preventDefault(); }
    else if (event.key === 'Enter') { pasteSelected(); event.preventDefault(); }
    else if (event.key === 'Delete' && state.selectedId) { removeById(state.selectedId); event.preventDefault(); }
  });

  host.onState(next => {
    const wasEnabled = state.clipboard && state.clipboard.enabled;
    const previousRevision = state.revision;
    state.clipboard = next.clipboard;
    state.phase = next.phase;
    if (Number.isFinite(next.historyRevision)) state.revision = next.historyRevision;
    syncChrome();
    if (!wasEnabled && next.clipboard && next.clipboard.enabled) refresh();
    if (wasEnabled && next.clipboard && !next.clipboard.enabled) { clearSelection(); refresh(); }
    // 新记录入库：干净的第一页就直接重拉，手上正选着东西或正在筛选就不抢她的位置，只提示一句。
    if (previousRevision !== null && state.revision !== previousRevision) {
      const calm = state.tab === 'history' && !state.query && !state.kind && state.page === 1
        && !state.selectedId && !state.busy;
      if (calm) refresh();
      else staleRefresh.hidden = false;
    }
  });

  // 窗口每次重新呼出：先清掉上一次的预览（含在途请求），不把旧大图带到新一次里。
  // 也不碰搜索/筛选/选中/分页这些列表状态。
  if (typeof host.onShown === 'function') {
    host.onShown(() => { closeLightbox(); });
  }
  // 原生关闭/Alt+F4 也走这里：预览开着就先回列表，不直接收起窗口。
  if (typeof host.onCloseRequest === 'function') {
    host.onCloseRequest(id => {
      // 预览开着：只关预览，回执 stay，窗口留着用。
      if (closeLightbox()) {
        syncChrome();
        try { host.ackCloseRequest?.(id, 'stay'); } catch { /* 回执失败不影响已关的预览。 */ }
        return;
      }
      // 列表状态：告诉主进程可以收起；收起动作由主进程做，两边不重复 hide。
      try { host.ackCloseRequest?.(id, 'hide'); } catch { /* 回执失败时主进程会超时收起。 */ }
    });
  }

  // 窗口收起：同样作废在途请求；晚到的图不能在看不到的时候把预览打开。
  if (typeof host.onHidden === 'function') {
    host.onHidden(() => { closeLightbox(); });
  }

  // 初次加载：先拿状态，再拉列表。
  host.state().then(next => {
    state.clipboard = next.clipboard;
    state.phase = next.phase;
    if (Number.isFinite(next.historyRevision)) state.revision = next.historyRevision;
    syncChrome();
    refresh();
  }).catch(error => setResult(`历史窗没准备好：${error?.message || error}`, 'warn'));
})();
