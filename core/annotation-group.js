/* 跨图批注组的纯模型：校验、三层坐标、组编辑、撤销/重做、导出计划。
   不碰像素、DOM、IPC 或文件系统；main 与工作台页共用同一份判定。
   源图坐标永远是那张 PNG 的原像素；frame 只是工作台上的摆位，不重采样原件。
   越界整份拒绝，绝不静默夹取成另一个位置。 */
(function (host) {
  'use strict';

  const LIMITS = Object.freeze({
    images: 16, notes: 100, targets: 8, masks: 16, relations: 100,
    text: 2000, comment: 4000, id: 64, title: 120,
    frameOrigin: 1e6, frameSize: 60000, edge: 30000, pixels: 36000000,
    json: 1024 * 1024, undoSteps: 50, undoBytes: 8 * 1024 * 1024,
    overviewEdge: 4096, overviewPixels: 16000000,
    // 复制与保存是两条预算：复制要一次交给系统剪贴板，保存是逐张写盘。
    exportImages: 17, copyBatchBytes: 256 * 1024 * 1024, copyCacheBytes: 512 * 1024 * 1024,
    saveBatchBytes: 3 * 1024 * 1024 * 1024, textBytes: 1024 * 1024,
    imageBytes: 148 * 1024 * 1024,
    // 逐图输出固定版式（main 与页面共用，不依赖浏览器字体测量）。
    headerH: 48, footerGap: 48, cellW: 20, lineH: 28, fontSize: 18, sidePad: 24, minWidth: 720,
    labelW: 320, labelH: 28, overviewPad: 24,
    // 对照图：原尺寸纵向拼合，所以不需要缩略预算，只要一个画布上限。
    sheetPad: 32, sheetGap: 28, sheetTitleH: 34, sheetMaxEdge: 16000
  });

  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const HASH_RE = /^[0-9a-f]{64}$/;
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);
  // main 用 Buffer 量字节，页面没有 Buffer：同一份规则给两边用同一个 UTF-8 口径。
  const byteLength = text => (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function'
    ? Buffer.byteLength(text)
    : new TextEncoder().encode(text).length);
  const isPositiveSize = value => isFiniteNumber(value) && value > 0;
  const codePoints = value => Array.from(value).length;
  // 源坐标交互提交统一精确到 0.01 像素，避免 1e-14 尾数让贴边框变非法。
  const roundSource = value => Math.round(value * 100) / 100;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const fail = message => { throw new Error(message); };

  function idOf(value, label) {
    if (typeof value !== 'string' || !ID_RE.test(value)) fail(`${label}标识无效`);
    return value;
  }
  function hashOf(value, label) {
    if (typeof value !== 'string' || !HASH_RE.test(value)) fail(`${label}的原图指纹无效`);
    return value;
  }
  function textOf(value, max, label, required) {
    if (typeof value !== 'string') fail(`${label}无效`);
    if (required && !value.trim()) fail(`${label}还没有填写`);
    const count = codePoints(value);
    if (count > max) fail(`${label}超过 ${max} 字（当前 ${count} 字）`);
    // 原文保留：不 trim、不换行归一，说明.txt 与页面显示都用这份字。
    return value;
  }
  function pointOf(value, size, label) {
    if (!value || typeof value !== 'object' || !isFiniteNumber(value.x) || !isFiniteNumber(value.y)) fail(`${label}坐标无效`);
    if (value.x < 0 || value.y < 0 || value.x > size.width || value.y > size.height) fail(`${label}超出图片范围`);
    return { x: value.x, y: value.y };
  }
  function rectOf(value, size, label) {
    if (!value || typeof value !== 'object' || !['x', 'y', 'width', 'height'].every(key => isFiniteNumber(value[key])) ||
        value.width <= 0 || value.height <= 0) fail(`${label}范围无效`);
    const { x, y, width, height } = value;
    if (x < 0 || y < 0 || x + width > size.width || y + height > size.height) fail(`${label}范围超出图片范围`);
    return { x, y, width, height };
  }

  function sourceSizeOf(width, height, label) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        width > LIMITS.edge || height > LIMITS.edge || width * height > LIMITS.pixels) {
      fail(`${label}尺寸无效（边长 ≤ ${LIMITS.edge}，总计 ≤ ${LIMITS.pixels} 像素）`);
    }
    return { width, height };
  }

  // 图块允许多少缩放：只摆位，所以宽高比必须与源图一致，投斜了就拒绝。
  function frameOf(value, source, label) {
    if (!value || typeof value !== 'object') fail(`${label}摆位无效`);
    const { x, y, width, height } = value;
    if (![x, y, width, height].every(isFiniteNumber)) fail(`${label}摆位无效`);
    if (Math.abs(x) > LIMITS.frameOrigin || Math.abs(y) > LIMITS.frameOrigin) fail(`${label}摆位坐标超出上限`);
    if (width < 1 || height < 1 || width > LIMITS.frameSize || height > LIMITS.frameSize) fail(`${label}摆位尺寸无效`);
    const wanted = source.width / source.height;
    const got = width / height;
    if (Math.abs(got - wanted) > wanted * 0.01) fail(`${label}摆位比例与源图不一致`);
    return { x, y, width, height };
  }

  function maskOf(value, source, label) {
    if (!value || typeof value !== 'object') fail(`${label}遮盖无效`);
    if (typeof value.color !== 'string' || !COLOR_RE.test(value.color)) fail(`${label}遮盖颜色必须是 #rrggbb 不透明色`);
    return { id: idOf(value.id, `${label}遮盖`), rect: rectOf(value.rect, source), color: value.color.toLowerCase() };
  }

  function imageOf(value, index, assetSizes) {
    const label = `第 ${index + 1} 张图`;
    if (!value || typeof value !== 'object') fail(`${label}无效`);
    const source = sourceSizeOf(value.width, value.height, label);
    if (value.width !== source.width || value.height !== source.height) fail(`${label}尺寸必须是整数像素`);
    const hash = hashOf(value.assetHash, label);
    if (assetSizes && assetSizes[hash]) {
      const known = assetSizes[hash];
      if (known.width !== source.width || known.height !== source.height) fail(`${label}尺寸与私有原件不一致，拒绝导出`);
    }
    const masks = value.masks === undefined ? [] : value.masks;
    if (!Array.isArray(masks) || masks.length > LIMITS.masks) fail(`${label}遮盖数量超过 ${LIMITS.masks}`);
    return {
      id: idOf(value.id, label),
      assetHash: hash,
      name: typeof value.name === 'string' && value.name.trim() ? textOf(value.name, 60, `${label}名称`, false) : `图${index + 1}`,
      width: source.width, height: source.height,
      frame: frameOf(value.frame, source, label),
      masks: masks.map((mask, maskIndex) => maskOf(mask, source, `${label}第 ${maskIndex + 1} 处`))
    };
  }

  function targetOf(value, imagesById, label) {
    if (!value || typeof value !== 'object') fail(`${label}目标无效`);
    const id = idOf(value.id, `${label}目标`);
    const image = imagesById.get(value.imageId);
    if (!image) fail(`${label}目标引用了不存在的图`);
    const size = { width: image.width, height: image.height };
    if (value.kind === 'point') return { id, imageId: image.id, kind: 'point', point: pointOf(value.point, size, label) };
    if (value.kind === 'region') return { id, imageId: image.id, kind: 'region', rect: rectOf(value.rect, size, label) };
    fail(`${label}目标类型无效`);
  }

  // draft 允许先标后写：第 2 版起目标可以暂时没有文字，但长度、类型、坐标照样逐项校验。
  function noteOf(value, index, imagesById, { draft }) {
    const label = `第 ${index + 1} 条意见`;
    if (!value || typeof value !== 'object') fail(`${label}无效`);
    if (!Array.isArray(value.targets) || !value.targets.length) fail(`${label}缺少目标`);
    if (value.targets.length > LIMITS.targets) fail(`${label}目标超过 ${LIMITS.targets} 个`);
    const seen = new Set();
    const targets = value.targets.map((target, targetIndex) => {
      const clean = targetOf(target, imagesById, `${label}第 ${targetIndex + 1} 个`);
      if (seen.has(clean.id)) fail(`${label}目标标识重复`);
      seen.add(clean.id);
      return clean;
    });
    return {
      id: idOf(value.id, label),
      text: textOf(value.text, LIMITS.text, label, !draft),
      linked: Boolean(value.linked),
      targets
    };
  }

  // —— 独立关系：两个稳定端点引用 + 自己的文字，不复制几何 ——
  function endpointOf(value, notesById, label) {
    if (!value || typeof value !== 'object') fail(`${label}引用无效`);
    const noteId = idOf(value.noteId, `${label}意见`);
    const note = notesById.get(noteId);
    if (!note) fail(`${label}引用了不存在的意见`);
    const targetId = idOf(value.targetId, `${label}目标`);
    if (!note.targets.some(target => target.id === targetId)) fail(`${label}引用了这条意见里不存在的目标`);
    return { noteId, targetId };
  }

  function relationOf(value, index, notesById) {
    const label = `第 ${index + 1} 条关系`;
    if (!value || typeof value !== 'object') fail(`${label}无效`);
    if (!Array.isArray(value.ends) || value.ends.length !== 2) fail(`${label}必须正好连着两处`);
    const ends = value.ends.map((end, endIndex) => endpointOf(end, notesById, `${label}第 ${endIndex + 1} 处`));
    if (ends[0].noteId === ends[1].noteId && ends[0].targetId === ends[1].targetId) fail(`${label}不能把一处连到它自己`);
    return {
      id: idOf(value.id, label),
      text: textOf(value.text === undefined ? '' : value.text, LIMITS.text, `${label}说明`, false),
      ends
    };
  }

  // 无向端点对：换成固定顺序再比，让 1↔2 和 2↔1 算同一条。
  const endsKeyOf = ends => ends.map(end => `${end.noteId}:${end.targetId}`).sort().join('|');

  // 严格校验并返回只含白名单字段的副本：任何额外属性都不会流到存储或导出。
  // 版本：1 是旧版严格语义（每条意见必须有文字、没有独立关系）；
  // 2 起支持先标后写的空文字目标与独立关系。旧组引入任一新语义时由下面的编辑函数原子升到 2，
  // 一旦是 2 就不再降回去（删掉最后一条关系、把文字补齐都不降版）。
  const VERSIONS = Object.freeze([1, 2]);
  function validate(group, { assetSizes } = {}) {
    if (!group || typeof group !== 'object') fail('批注组无效');
    if (!VERSIONS.includes(group.schemaVersion)) fail('批注组版本不支持');
    const version = group.schemaVersion;
    const draft = version === 2;
    if (!Array.isArray(group.images) || group.images.length < 1 || group.images.length > LIMITS.images) {
      fail(`批注组需要 1–${LIMITS.images} 张图`);
    }
    const imageIds = new Set();
    const images = group.images.map((value, index) => {
      const image = imageOf(value, index, assetSizes);
      if (imageIds.has(image.id)) fail(`第 ${index + 1} 张图标识重复`);
      imageIds.add(image.id);
      // 同一原件可以在同组出现多个图块（同一张图引用两次），批注只认实例 id；
      // 但两个图块各自的 frame / masks / 意见完全独立。
      return image;
    });
    const imagesById = new Map(images.map(image => [image.id, image]));
    if (!Array.isArray(group.notes) || group.notes.length > LIMITS.notes) fail(`意见最多 ${LIMITS.notes} 条`);
    const noteIds = new Set();
    const notes = group.notes.map((value, index) => {
      const note = noteOf(value, index, imagesById, { draft });
      if (noteIds.has(note.id)) fail(`第 ${index + 1} 条意见标识重复`);
      noteIds.add(note.id);
      return note;
    });
    const relationSource = group.relations === undefined ? [] : group.relations;
    if (!Array.isArray(relationSource) || relationSource.length > LIMITS.relations) fail(`关系最多 ${LIMITS.relations} 条`);
    if (!draft && relationSource.length) fail('第 1 版的组不能带独立关系，先把它升到第 2 版');
    const notesById = new Map(notes.map(note => [note.id, note]));
    const relationIds = new Set();
    const pairs = new Set();
    const relations = relationSource.map((value, index) => {
      const relation = relationOf(value, index, notesById);
      if (relationIds.has(relation.id)) fail(`第 ${index + 1} 条关系标识重复`);
      relationIds.add(relation.id);
      const pair = endsKeyOf(relation.ends);
      if (pairs.has(pair)) fail(`第 ${index + 1} 条关系与前面重复：同一处两处只留一条关系`);
      pairs.add(pair);
      return relation;
    });
    const title = textOf(typeof group.title === 'string' ? group.title : '批注组', LIMITS.title, '组名', true);
    const comment = group.comment === undefined || group.comment === null ? '' : textOf(group.comment, LIMITS.comment, '总体说明', false);
    const view = viewOf(group.view);
    const clean = { schemaVersion: version, id: idOf(group.id, '批注组'), title, revision: revisionOf(group.revision),
      images, notes, relations, comment, view };
    // 文档字节上限是硬闸：超了明确拒绝，不靠删字段来凑。
    if (byteLength(JSON.stringify(clean)) > LIMITS.json) fail('批注组数据超过 1MiB 上限');
    return clean;
  }

  function revisionOf(value) {
    if (!Number.isSafeInteger(value) || value < 0) fail('批注组修订号无效');
    return value;
  }
  function viewOf(value) {
    if (value === undefined) return { panX: 0, panY: 0, zoom: 1 };
    if (!value || typeof value !== 'object') fail('视图状态无效');
    const { panX, panY, zoom } = value;
    if (![panX, panY, zoom].every(isFiniteNumber)) fail('视图状态无效');
    if (Math.abs(panX) > LIMITS.frameOrigin || Math.abs(panY) > LIMITS.frameOrigin) fail('视图平移超出上限');
    if (zoom < 0.05 || zoom > 8) fail('视图缩放超出范围');
    return { panX, panY, zoom };
  }

  // —— 三层坐标 ——
  // 屏幕 → 世界 → 源图。只有交互提交时取整到 0.01；读取/导出绝不再取整或夹取。
  const worldPoint = (image, view, screen) => ({
    x: (screen.x - view.panX) / view.zoom,
    y: (screen.y - view.panY) / view.zoom
  });
  const sourcePoint = (image, world) => ({
    x: (world.x - image.frame.x) * image.width / image.frame.width,
    y: (world.y - image.frame.y) * image.height / image.frame.height
  });
  const worldOfSource = (image, source) => ({
    x: image.frame.x + source.x * image.frame.width / image.width,
    y: image.frame.y + source.y * image.frame.height / image.height
  });
  const screenOfWorld = (view, world) => ({ x: world.x * view.zoom + view.panX, y: world.y * view.zoom + view.panY });

  function sourceAtScreen(image, view, screen) {
    if (!image || !view || !screen || !isFiniteNumber(screen.x) || !isFiniteNumber(screen.y)) fail('坐标无效');
    const world = worldPoint(image, view, screen);
    const source = sourcePoint(image, world);
    return { x: roundSource(source.x), y: roundSource(source.y) };
  }

  // 交互提交的矩形：两个边界各自收口后算宽高，再用整数百分之一单位验边界，不出现贴边 100.00000001。
  function regionAtScreen(image, view, start, end) {
    const a = sourceAtScreen(image, view, start);
    const b = sourceAtScreen(image, view, end);
    const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x);
    const top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
    const x = left, y = top, width = roundSource(right - left), height = roundSource(bottom - top);
    if (!(width > 0) || !(height > 0)) fail('框选范围太小');
    // 用百分之一单位比较，避免浮点尾数把合法贴边判成越界。
    const pct = value => Math.round(value * 100);
    if (pct(x) < 0 || pct(y) < 0 || pct(x) + pct(width) > pct(image.width) || pct(y) + pct(height) > pct(image.height)) {
      fail('框选超出图片范围');
    }
    return { x, y, width, height };
  }

  // 命中顺序按屏幕实际层级先问页面；这里只提供「这一点落在哪张图里」的几何判定。
  function imageAtWorld(images, world) {
    for (let index = images.length - 1; index >= 0; index--) {
      const image = images[index];
      const { x, y, width, height } = image.frame;
      if (world.x >= x && world.x <= x + width && world.y >= y && world.y <= y + height) return image;
    }
    return undefined;
  }

  // —— 组编辑：全部返回新副本，不改传进来的对象 —— ——
  const clone = group => JSON.parse(JSON.stringify(group));

  function createGroup({ id, title, images, now = () => new Date() } = {}) {
    const stamp = now();
    const created = {
      schemaVersion: 1, id: id || `group_${stamp.getTime().toString(36)}`,
      title: typeof title === 'string' && title.trim() ? title : `批注组-${formatStamp(stamp)}`,
      revision: 0, images: [], notes: [], relations: [], comment: '',
      view: { panX: 0, panY: 0, zoom: 1 }
    };
    const normalized = validate({ ...created, images: images || [] }, {});
    // 新建组允许第一版从 1 起：validate 只认 revision ≥ 0，落库时由存储层 CAS 到 1。
    return normalized;
  }

  function addImage(group, image) {
    const next = clone(group);
    if (next.images.length >= LIMITS.images) fail(`一组最多 ${LIMITS.images} 张图`);
    next.images.push(image);
    return validate(next);
  }

  function removeImage(group, imageId) {
    const next = clone(group);
    const index = next.images.findIndex(image => image.id === imageId);
    if (index < 0) fail('要移出的图不存在');
    const involved = next.notes.filter(note => note.targets.some(target => target.imageId === imageId));
    if (involved.length) {
      // 不自动删意见，也不把跨图意见悄悄降成单图：先让使用者处理这 N 条。
      const error = new Error(`这张图还牵着 ${involved.length} 条意见，先把它们处理掉再移出`);
      error.code = 'IMAGE_IN_USE';
      error.notes = involved.length;
      throw error;
    }
    next.images.splice(index, 1);
    return validate(next);
  }

  function renameImage(group, imageId, name) {
    const next = clone(group);
    const image = next.images.find(item => item.id === imageId);
    if (!image) fail('要改名的图不存在');
    image.name = name;
    return validate(next);
  }

  function setFrame(group, imageId, frame) {
    const next = clone(group);
    const image = next.images.find(item => item.id === imageId);
    if (!image) fail('要摆放的图不存在');
    image.frame = frame;
    // 只改摆位，targets / masks 一律不动。
    return validate(next);
  }

  function addMask(group, imageId, mask) {
    const next = clone(group);
    const image = next.images.find(item => item.id === imageId);
    if (!image) fail('要遮盖的图不存在');
    if (image.masks.length >= LIMITS.masks) fail(`一张图最多 ${LIMITS.masks} 处遮盖`);
    image.masks.push(mask);
    return validate(next);
  }

  function removeMask(group, imageId, maskId) {
    const next = clone(group);
    const image = next.images.find(item => item.id === imageId);
    if (!image) fail('要撤销遮盖的图不存在');
    const index = image.masks.findIndex(mask => mask.id === maskId);
    if (index < 0) fail('要撤销的遮盖不存在');
    image.masks.splice(index, 1);
    return validate(next);
  }

  // 第 1 版老组一旦引入空文字目标或独立关系，就在同一次改动里升到第 2 版，不先写半新半旧的数据。
  const promote = group => (group.schemaVersion === 2 ? group : { ...group, schemaVersion: 2 });

  function addNote(group, note) {
    let next = clone(group);
    if (next.notes.length >= LIMITS.notes) fail(`意见最多 ${LIMITS.notes} 条`);
    if (!String(note?.text ?? '').trim()) next = promote(next);
    next.notes.push(note);
    return validate(next);
  }

  function updateNote(group, noteId, patch) {
    const next = clone(group);
    const note = next.notes.find(item => item.id === noteId);
    if (!note) fail('要修改的意见不存在');
    if (patch && typeof patch.text === 'string') note.text = patch.text;
    if (patch && Array.isArray(patch.targets)) note.targets = patch.targets;
    // 把文字清空就是“先标后写”的草稿状态，同样要升版；反过来补齐文字不降版。
    return validate(typeof note.text === 'string' && !note.text.trim() ? promote(next) : next);
  }

  // 删意见时连同牵着它的关系一起移除；删多少条由调用方先用 relationsOfNote 报给使用者。
  function deleteNote(group, noteId) {
    const next = clone(group);
    const index = next.notes.findIndex(note => note.id === noteId);
    if (index < 0) fail('要删除的意见不存在');
    next.notes.splice(index, 1);
    next.relations = (next.relations || []).filter(relation => !relation.ends.some(end => end.noteId === noteId));
    return validate(next);
  }

  function relationsOfNote(group, noteId) {
    return (Array.isArray(group?.relations) ? group.relations : [])
      .filter(relation => relation.ends.some(end => end.noteId === noteId));
  }

  function addRelation(group, relation) {
    const next = promote(clone(group));
    next.relations = Array.isArray(next.relations) ? next.relations : [];
    if (next.relations.length >= LIMITS.relations) fail(`关系最多 ${LIMITS.relations} 条`);
    next.relations.push(relation);
    return validate(next);
  }

  function updateRelation(group, relationId, patch) {
    const next = clone(group);
    const relation = (next.relations || []).find(item => item.id === relationId);
    if (!relation) fail('要修改的关系不存在');
    if (patch && typeof patch.text === 'string') relation.text = patch.text;
    return validate(next);
  }

  function deleteRelation(group, relationId) {
    const next = clone(group);
    const index = (next.relations || []).findIndex(item => item.id === relationId);
    if (index < 0) fail('要解除的关系不存在');
    next.relations.splice(index, 1);
    // 解除关系只删这条关系，点/框与各自的文字都不动；版本也不降。
    return validate(next);
  }

  function setComment(group, comment) {
    const next = clone(group);
    next.comment = comment;
    return validate(next);
  }

  function setTitle(group, title) {
    const next = clone(group);
    next.title = title;
    return validate(next);
  }

  // —— 撤销/重做：只存模型快照，不含像素；步数与字节都有上限 ——
  // 版本是高水位：旧快照（第 1 版）不能把已经达到的第 2 版拉回去。
  // 这里的入出口就是统一恢复边界，undo / redo 同等适用；外部回填与保存边界用同一个函数。
  function keepVersion(restored, current) {
    if (!restored || typeof restored !== 'object') return restored;
    const floor = Math.max(Number(restored.schemaVersion) || 0, Number(current?.schemaVersion) || 0);
    if ((Number(restored.schemaVersion) || 0) >= floor) return restored;
    return { ...restored, schemaVersion: floor };
  }

  function createHistory({ steps = LIMITS.undoSteps, bytes = LIMITS.undoBytes } = {}) {
    let past = [];
    let future = [];
    let used = 0;
    const sizeOf = value => byteLength(JSON.stringify(value));
    return {
      // 在改动之前记录旧状态。超过字节上限时从头淘汰（最旧的先走）。
      remember(previous) {
        past.push({ state: previous, bytes: sizeOf(previous) });
        used += past[past.length - 1].bytes;
        while (past.length > steps || used > bytes) {
          const dropped = past.shift();
          if (!dropped) break;
          used -= dropped.bytes;
        }
        future = [];
      },
      undo(current) {
        const entry = past.pop();
        if (!entry) return undefined;
        used -= entry.bytes;
        future.push({ state: current, bytes: sizeOf(current) });
        return keepVersion(entry.state, current);
      },
      redo(current) {
        const entry = future.pop();
        if (!entry) return undefined;
        past.push({ state: current, bytes: sizeOf(current) });
        used += sizeOf(current);
        return keepVersion(entry.state, current);
      },
      depth: () => ({ undo: past.length, redo: future.length, bytes: used, steps })
    };
  }

  // —— 导出计划需要的文字排版（main 与页面共用，不依赖字体测量） ——
  let segmenter;
  function graphemes(text) {
    if (typeof text !== 'string') return [];
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      segmenter = segmenter || new Intl.Segmenter('zh', { granularity: 'grapheme' });
      return Array.from(segmenter.segment(text), part => part.segment);
    }
    return Array.from(text);
  }

  // 保留原换行；每行按字格硬折，不拆 grapheme。返回纯字符串行，行数即高度。
  function textLines(text, maxCols) {
    if (!Number.isInteger(maxCols) || maxCols < 1) fail('字格宽度无效');
    const rows = [];
    for (const paragraph of String(text ?? '').split(/\r\n|\r|\n/)) {
      const units = graphemes(paragraph);
      if (!units.length) { rows.push(''); continue; }
      for (let index = 0; index < units.length; index += maxCols) rows.push(units.slice(index, index + maxCols).join(''));
    }
    return rows;
  }

  const coordinateText = value => String(Math.round(value * 100) / 100);
  const targetLabelOf = (image, target, imageNumber) => {
    const index = image ? imageNumber.get(image.id) : undefined;
    if (target.kind === 'point') return `图${index} 点 (${coordinateText(target.point.x)}, ${coordinateText(target.point.y)})`;
    return `图${index} 框 (${coordinateText(target.rect.x)}, ${coordinateText(target.rect.y)}, ${coordinateText(target.rect.width)}, ${coordinateText(target.rect.height)})`;
  };
  // 端点 → “意见2 的 图1 框 (…)”：说明文字与成品拦截提示共用同一套定位写法。
  const targetOfEnd = (group, end) => {
    const note = group.notes.find(item => item.id === end?.noteId);
    return note && note.targets.find(item => item.id === end?.targetId);
  };
  const endpointLabelOf = (group, end, imageNumber) => {
    const noteIndex = group.notes.findIndex(note => note.id === end.noteId);
    const note = group.notes[noteIndex];
    const target = note && note.targets.find(item => item.id === end.targetId);
    if (!note || !target) return '一处已不存在的目标';
    return `意见${noteIndex + 1} 的 ${targetLabelOf(group.images.find(item => item.id === target.imageId), target, imageNumber)}`;
  };

  // 完成度：目标自己有文字，或被一条“文字非空且两端有效”的关系覆盖，就算已经说明过。
  // 两个空框配一条“两处颜色一致”可以完成；没被任何说明覆盖的空目标、以及空关系都算未完成。
  function pendingOf(group) {
    const notes = Array.isArray(group?.notes) ? group.notes : [];
    const relations = Array.isArray(group?.relations) ? group.relations : [];
    const imageNumber = new Map((group?.images || []).map((image, index) => [image.id, index + 1]));
    const notesById = new Map(notes.map(note => [note.id, note]));
    const validEnd = end => Boolean(end) && (() => {
      const note = notesById.get(end.noteId);
      return Boolean(note && Array.isArray(note.targets) && note.targets.some(target => target.id === end.targetId));
    })();
    const covered = new Set();
    for (const note of notes) {
      if (typeof note.text !== 'string' || !note.text.trim()) continue;
      for (const target of note.targets || []) covered.add(`${note.id}:${target.id}`);
    }
    for (const relation of relations) {
      if (typeof relation.text !== 'string' || !relation.text.trim()) continue;
      const ends = Array.isArray(relation.ends) ? relation.ends : [];
      if (!ends.every(validEnd)) continue;
      for (const end of ends) covered.add(`${end.noteId}:${end.targetId}`);
    }
    const pending = [];
    notes.forEach((note, noteIndex) => {
      for (const target of note.targets || []) {
        if (covered.has(`${note.id}:${target.id}`)) continue;
        pending.push({ kind: 'target', noteId: note.id, targetId: target.id, noteNumber: noteIndex + 1,
          label: `意见${noteIndex + 1} 的 ${targetLabelOf((group.images || []).find(item => item.id === target.imageId), target, imageNumber)}` });
      }
    });
    relations.forEach((relation, index) => {
      if (typeof relation.text === 'string' && relation.text.trim()) return;
      pending.push({ kind: 'relation', relationId: relation.id, relationNumber: index + 1, label: `关系${index + 1}` });
    });
    return pending;
  }

  function pendingMessageOf(pending) {
    const names = pending.slice(0, 3).map(item => item.label).join('、');
    const rest = pending.length > 3 ? ` 等 ${pending.length} 处` : '';
    return `还有 ${pending.length} 处没写说明：${names}${rest}`;
  }

  // 说明.txt 与逐图说明来自同一份映射：图号、意见号、目标位置都在这里定一次。
  function buildNotesText(group, { now = new Date() } = {}) {
    const imageNumber = new Map(group.images.map((image, index) => [image.id, index + 1]));
    const relations = Array.isArray(group.relations) ? group.relations : [];
    const lines = ['截个图 · 批注组说明', `组名：${group.title}`, `导出时间：${formatStamp(now)}`, ''];
    group.images.forEach((image, index) => {
      lines.push(`图${index + 1}：${image.name}（${image.width} × ${image.height}）`);
    });
    lines.push('');
    group.notes.forEach((note, index) => {
      const refs = note.targets.map(target => targetLabelOf(group.images.find(image => image.id === target.imageId), target, imageNumber));
      lines.push(`意见${index + 1}（涉及：${refs.join('、')}）`);
      if (note.text.trim()) {
        lines.push(note.text);
      } else {
        const covering = relations.map((relation, relationIndex) => ({ relation, number: relationIndex + 1 }))
          .filter(({ relation }) => relation.text.trim() && relation.ends.some(end => end.noteId === note.id))
          .map(({ number }) => `关系${number}`);
        lines.push(covering.length ? `（这处没有单独文字，说明见 ${covering.join('、')}）` : '（这处还没有写说明）');
      }
      lines.push('');
    });
    if (relations.length) {
      lines.push('关系');
      relations.forEach((relation, index) => {
        const ends = relation.ends.map(end => endpointLabelOf(group, end, imageNumber));
        lines.push(`关系${index + 1}（两处有关：${ends[0]} ↔ ${ends[1]}）`);
        lines.push(relation.text.trim() ? relation.text : '（这条关系还没有写说明）');
        lines.push('');
      });
    }
    if (group.comment.trim()) { lines.push('总体说明', group.comment, ''); }
    if (!group.notes.length && !group.comment.trim()) lines.push('（这一组没有写意见，只导出图片。）');
    lines.push('总览用于看关系，细节看组内图片。');
    return lines.join('\r\n');
  }

  // 对照图：所有图按原尺寸纵向排下来，标题在图上方。
  // 用途是“A 的这里改成 B 的那里”，所以不缩略、不加页脚，就让人一眼对上号。
  function buildSheet(group, sizes) {
    const pad = LIMITS.sheetPad, gap = LIMITS.sheetGap, titleH = LIMITS.sheetTitleH;
    const items = group.images.map((image, index) => {
      const size = sizes.get(image.assetHash);
      return { imageId: image.id, number: index + 1, assetHash: image.assetHash, title: image.name,
        sourceWidth: size.width, sourceHeight: size.height, masks: image.masks };
    });
    const maxW = items.reduce((max, item) => Math.max(max, item.sourceWidth), 0);
    let width = maxW + pad * 2;
    let cursor = pad;
    for (const item of items) {
      item.x = pad + Math.floor((maxW - item.sourceWidth) / 2);
      item.y = cursor + titleH;
      item.width = item.sourceWidth;
      item.height = item.sourceHeight;
      cursor += titleH + item.sourceHeight + gap;
    }
    let height = Math.max(titleH + pad * 2, cursor - gap + pad);
    // 画布有上限：超过就整体等比缩一次，宁可略小也不能出不来。
    const scale = Math.min(1, LIMITS.sheetMaxEdge / width, LIMITS.sheetMaxEdge / height);
    if (scale < 1) {
      width = Math.max(1, Math.floor(width * scale));
      height = Math.max(1, Math.floor(height * scale));
      for (const item of items) {
        item.x = Math.round(item.x * scale); item.y = Math.round(item.y * scale);
        item.width = Math.max(1, Math.round(item.width * scale));
        item.height = Math.max(1, Math.round(item.height * scale));
      }
    }
    return { width, height, scale, items };
  }

  function formatStamp(date) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }

  function fileNames(count) {
    const digits = Math.max(2, String(count).length);
    const list = [{ index: 0, name: '00-总览.png' }];
    for (let index = 0; index < count; index++) {
      list.push({ index: index + 1, name: `${String(index + 1).padStart(digits, '0')}-图${index + 1}.png` });
    }
    return list;
  }

  // 导出计划：main 用它持有权威尺寸，页面按同一份计划绘制，只回 index + PNG 字节。
  // assetSizes 必须由 main 从已验证原件尺寸表构造；组内尺寸不符或缺条目就直接拒绝。
  function planExport(group, assetSizes, { now = new Date() } = {}) {
    if (!assetSizes || typeof assetSizes !== 'object') fail('导出计划缺少原件尺寸表');
    const frozen = validate(group, { assetSizes });
    // 权威尺寸表是唯一来源：这里再核一遍，缺条目、组 JSON 与表不一致都拒导出。
    const sizes = new Map();
    for (const image of frozen.images) {
      const known = assetSizes[image.assetHash];
      if (!known || !Number.isInteger(known.width) || !Number.isInteger(known.height)) fail('导出计划缺少一张图的原件尺寸，拒绝导出');
      if (known.width !== image.width || known.height !== image.height) fail('组内尺寸与私有原件不一致，拒绝导出');
      sizes.set(image.assetHash, { width: known.width, height: known.height });
    }
    const noteNumber = new Map(frozen.notes.map((note, index) => [note.id, index + 1]));
    const imageNumber = new Map(frozen.images.map((image, index) => [image.id, index + 1]));
    // 成品导出不冒充“写完”：还有没被说明覆盖的空目标、或空关系，就明确列出缺哪几处。
    const pending = pendingOf(frozen);
    if (pending.length) fail(`${pendingMessageOf(pending)}。草稿已经存着，补好再导出。`);
    const payload = buildNotesText(frozen, { now });
    if (byteLength(payload) > LIMITS.textBytes) fail('说明文本超过 1MiB 上限');

    // —— 总览 bbox：所有图块、目标、标签矩形的 union，四边加 24 ——
    const boxes = [];
    for (const image of frozen.images) boxes.push(image.frame);
    for (const note of frozen.notes) {
      for (const target of note.targets) {
        const image = frozen.images.find(item => item.id === target.imageId);
        if (target.kind === 'point') {
          const world = worldOfSource(image, target.point);
          boxes.push({ x: world.x - 1, y: world.y - 1, width: 2, height: 2 });
        } else {
          const a = worldOfSource(image, { x: target.rect.x, y: target.rect.y });
          const b = worldOfSource(image, { x: target.rect.x + target.rect.width, y: target.rect.y + target.rect.height });
          boxes.push({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) });
        }
      }
    }
    // 关系两端在世界坐标里的位置：总览画线用，不复制几何。
    const endWorldOf = end => {
      const note = frozen.notes.find(item => item.id === end.noteId);
      const target = note && note.targets.find(item => item.id === end.targetId);
      if (!target) return undefined;
      const image = frozen.images.find(item => item.id === target.imageId);
      const source = target.kind === 'point'
        ? target.point
        : { x: target.rect.x + target.rect.width / 2, y: target.rect.y + target.rect.height / 2 };
      return worldOfSource(image, source);
    };
    const noteLabelBoxes = labelBoxesOf(frozen, imageNumber) || [];
    for (const box of noteLabelBoxes) boxes.push(box);
    const relationViews = frozen.relations.map((relation, index) => {
      const ends = relation.ends.map(endWorldOf);
      const mid = ends[0] && ends[1]
        ? { x: (ends[0].x + ends[1].x) / 2, y: (ends[0].y + ends[1].y) / 2 }
        : (ends[0] || ends[1]);
      return { relation, index, ends, mid };
    });
    const relationLabelBoxes = relationViews.map(view => ({
      x: view.mid.x + 10, y: view.mid.y - LIMITS.labelH - 8, width: LIMITS.labelW, height: LIMITS.labelH
    }));
    for (const box of relationLabelBoxes) boxes.push(box);
    const minX = Math.min(...boxes.map(box => box.x)) - LIMITS.overviewPad;
    const minY = Math.min(...boxes.map(box => box.y)) - LIMITS.overviewPad;
    const maxX = Math.max(...boxes.map(box => box.x + box.width)) + LIMITS.overviewPad;
    const maxY = Math.max(...boxes.map(box => box.y + box.height)) + LIMITS.overviewPad;
    const bw = maxX - minX, bh = maxY - minY;
    if (!(bw > 0) || !(bh > 0)) fail('总览范围无效');
    const scale = Math.min(1, LIMITS.overviewEdge / bw, LIMITS.overviewEdge / bh, Math.sqrt(LIMITS.overviewPixels / (bw * bh)));
    const overview = {
      width: Math.max(1, Math.floor(bw * scale)), height: Math.max(1, Math.floor(bh * scale)),
      bbox: { x: minX, y: minY, width: bw, height: bh }, scale,
      frames: frozen.images.map((image, index) => ({
        imageId: image.id, number: index + 1,
        x: (image.frame.x - minX) * scale, y: (image.frame.y - minY) * scale,
        width: image.frame.width * scale, height: image.frame.height * scale
      })),
      targets: frozen.notes.flatMap(note => note.targets.map(target => {
        const image = frozen.images.find(item => item.id === target.imageId);
        const world = target.kind === 'point' ? worldOfSource(image, target.point) : (() => {
          const a = worldOfSource(image, { x: target.rect.x, y: target.rect.y });
          const b = worldOfSource(image, { x: target.rect.x + target.rect.width, y: target.rect.y + target.rect.height });
          return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
        })();
        return {
          noteId: note.id, targetId: target.id, imageId: image.id,
          kind: target.kind,
          x: (world.x - minX) * scale, y: (world.y - minY) * scale,
          width: target.kind === 'region' ? world.width * scale : 0,
          height: target.kind === 'region' ? world.height * scale : 0
        };
      })),
      // 总览是专用关系图：允许框/线/文字短标签，不画批注数字徽章。
      relations: relationViews.map((view, index) => ({
        relationId: view.relation.id, text: shortLabel(view.relation.text),
        a: view.ends[0] ? { x: (view.ends[0].x - minX) * scale, y: (view.ends[0].y - minY) * scale } : undefined,
        b: view.ends[1] ? { x: (view.ends[1].x - minX) * scale, y: (view.ends[1].y - minY) * scale } : undefined,
        label: relationLabelBoxes[index] ? {
          x: (relationLabelBoxes[index].x - minX) * scale, y: (relationLabelBoxes[index].y - minY) * scale,
          width: relationLabelBoxes[index].width * scale, height: relationLabelBoxes[index].height * scale
        } : undefined
      })),
      labels: noteLabelBoxes.map((box, index) => {
        const note = frozen.notes[index];
        return { noteId: note.id, text: shortLabel(note.text),
          x: (box.x - minX) * scale, y: (box.y - minY) * scale,
          width: box.width * scale, height: box.height * scale };
      }).filter(label => label.text)
    };

    // —— 逐图输出：先算 withNotes（48 头 + 1:1 图体 + 字格说明区），越过 30000/36M 就整张转 bodyOnly ——
    const images = [];
    frozen.images.forEach((image, index) => {
      const size = sizes.get(image.assetHash);
      const width = Math.max(size.width, LIMITS.minWidth);
      const cols = Math.floor((width - LIMITS.sidePad * 2) / LIMITS.cellW);
      // 意见正文按真实字格重排：heading 行短，正文行按 cols 折。
      const restyled = [];
      for (const note of frozen.notes) {
        const mine = note.targets.some(target => target.imageId === image.id);
        if (!mine) continue;
        restyled.push({ text: `意见${noteNumber.get(note.id)}`, kind: 'heading' });
        // 主图不再烘标记，页脚必须自己说清“这几处”分别是哪张图的哪一块：图号 + 点坐标或框范围。
        const refs = note.targets.map(target =>
          targetLabelOf(frozen.images.find(item => item.id === target.imageId), target, imageNumber));
        for (const row of textLines(`位置：${refs.join('；')}`, cols)) restyled.push({ text: row, kind: 'meta' });
        if (note.text.trim()) {
          for (const row of textLines(note.text, cols)) restyled.push({ text: row, kind: 'body' });
        } else {
          const covering = frozen.relations.map((relation, relationIndex) => ({ relation, number: relationIndex + 1 }))
            .filter(({ relation }) => relation.text.trim() && relation.ends.some(end => end.noteId === note.id))
            .map(({ number }) => `关系${number}`);
          restyled.push({ text: covering.length ? `这处没单独文字，说明见 ${covering.join('、')}` : '这处还没写说明', kind: 'meta' });
        }
      }
      // 关系也属于这条图的说明：两端任一处在这张图上就写进来，并指出两端各自的图号与定位。
      frozen.relations.forEach((relation, relationIndex) => {
        const mine = relation.ends.some(end => targetOfEnd(frozen, end)?.imageId === image.id);
        if (!mine) return;
        restyled.push({ text: `关系${relationIndex + 1}（两处有关）`, kind: 'heading' });
        const ends = relation.ends.map(end => endpointLabelOf(frozen, end, imageNumber));
        for (const row of textLines(`两端：${ends[0]} ↔ ${ends[1]}`, cols)) restyled.push({ text: row, kind: 'meta' });
        for (const row of textLines(relation.text.trim() ? relation.text : '（还没有写关系说明）', cols)) {
          restyled.push({ text: row, kind: 'body' });
        }
      });
      // 总体说明只挂在本组最后一张图，避免每张都重复一遍。
      if (index === frozen.images.length - 1 && frozen.comment.trim()) {
        restyled.push({ text: '总体说明', kind: 'heading' });
        for (const row of textLines(frozen.comment, cols)) restyled.push({ text: row, kind: 'body' });
      }
      const footerH = restyled.length ? LIMITS.footerGap + LIMITS.lineH * restyled.length : 0;
      const fullH = LIMITS.headerH + size.height + footerH;
      const over = fullH > LIMITS.edge || width * fullH > LIMITS.pixels;
      const common = {
        index, imageId: image.id, assetHash: image.assetHash, number: index + 1,
        sourceWidth: size.width, sourceHeight: size.height,
        masks: image.masks.map(mask => ({ ...mask, rect: { ...mask.rect } }))
      };
      const grid = { cols, lineH: LIMITS.lineH, fontSize: LIMITS.fontSize, cellW: LIMITS.cellW, sidePad: LIMITS.sidePad };
      if (over) {
        // bodyOnly：W/H 就是权威源图尺寸，图体 1:1 铺满；只烘遮盖，不烘目标框/编号/连线，
        // 绝不是导出私有原 blob；完整文字与图号映射在同批说明.txt。
        images.push({ ...common, mode: 'bodyOnly', width: size.width, height: size.height,
          bodyX: 0, bodyY: 0, headerH: 0, footerH: 0, footer: [],
          badge: { x: 12, y: 12, width: 44, height: 28 }, grid });
        return;
      }
      images.push({ ...common, mode: 'withNotes', width, height: fullH,
        bodyX: Math.floor((width - size.width) / 2), bodyY: LIMITS.headerH,
        headerH: LIMITS.headerH, footerH,
        badge: { x: 12, y: 10, width: 44, height: 28 },
        footer: restyled.map((line, lineIndex) => ({ ...line,
          y: LIMITS.headerH + size.height + LIMITS.footerGap + lineIndex * LIMITS.lineH })),
        grid });
    });

    // 整批最多 17 张 PNG（总览 + 16 图）+ 1 份说明.txt；单张 148MiB、36M、30000 沿用编辑边界。
    const files = fileNames(images.length);
    if (files.length > LIMITS.exportImages) fail(`整组导出最多 ${LIMITS.exportImages} 张 PNG`);
    const modes = {
      withNotes: images.filter(image => image.mode === 'withNotes').length,
      bodyOnly: images.filter(image => image.mode === 'bodyOnly').length
    };
    return { groupId: frozen.id, revision: frozen.revision, title: frozen.title,
      snapshot: frozen, overview, sheet: buildSheet(frozen, sizes), images, files, notesText: payload, textFile: '说明.txt', modes,
      budgets: { copyBatchBytes: LIMITS.copyBatchBytes, copyCacheBytes: LIMITS.copyCacheBytes,
        saveBatchBytes: LIMITS.saveBatchBytes, imageBytes: LIMITS.imageBytes, textBytes: LIMITS.textBytes,
        exportImages: LIMITS.exportImages } };
  }

  function shortLabel(text) {
    const units = graphemes(String(text ?? '').replace(/\s+/g, ' ').trim());
    return units.length > 12 ? `${units.slice(0, 11).join('')}…` : units.join('');
  }

  // 每张图的短标签取主目标旁，planner 定尺寸，renderer 不得自改 bbox。
  function labelBoxesOf(group, imageNumber) {
    return group.notes.map(note => {
      const target = note.targets[0];
      const image = group.images.find(item => item.id === target.imageId);
      const anchor = target.kind === 'point'
        ? worldOfSource(image, target.point)
        : (() => {
            const a = worldOfSource(image, { x: target.rect.x, y: target.rect.y });
            const b = worldOfSource(image, { x: target.rect.x + target.rect.width, y: target.rect.y + target.rect.height });
            return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
          })();
      return { x: anchor.x + 10, y: anchor.y - LIMITS.labelH - 8, width: LIMITS.labelW, height: LIMITS.labelH };
    });
  }

  const api = {
    LIMITS, roundSource, validate, createGroup,
    addImage, removeImage, renameImage, setFrame, addMask, removeMask,
    addNote, updateNote, deleteNote, setComment, setTitle,
    addRelation, updateRelation, deleteRelation, relationsOfNote, keepVersion,
    pendingOf, pendingMessageOf, endpointLabelOf, targetLabelOf,
    worldPoint, sourcePoint, worldOfSource, screenOfWorld, sourceAtScreen, regionAtScreen, imageAtWorld,
    createHistory, textLines, graphemes, planExport, buildNotesText, fileNames, formatStamp
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else host.AnnotationGroup = api;
})(typeof window === 'object' ? window : globalThis);
