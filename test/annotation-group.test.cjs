'use strict';
// 跨图批注纯模型：校验、三层坐标、组编辑、撤销/重做、导出计划（withNotes / bodyOnly）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const G = require('../core/annotation-group.js');

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

const image = (id, hash, width, height, frame, extra = {}) => ({
  id, assetHash: hash, name: extra.name || id, width, height,
  frame: frame || { x: 0, y: 0, width: width / 2, height: height / 2 },
  masks: extra.masks || []
});

const baseGroup = () => ({
  schemaVersion: 1, id: 'group_1', title: '批注组-测试', revision: 1,
  images: [
    image('img_a', HASH_A, 1200, 800, { x: 0, y: 0, width: 600, height: 400 }),
    image('img_b', HASH_B, 800, 600, { x: 640, y: 0, width: 400, height: 300 })
  ],
  notes: [{
    id: 'note_1', text: '颜色照这个改', linked: true,
    targets: [
      { id: 't_a', imageId: 'img_a', kind: 'region', rect: { x: 50, y: 60, width: 200, height: 100 } },
      { id: 't_b', imageId: 'img_b', kind: 'point', point: { x: 90, y: 120 } }
    ]
  }],
  comment: '', view: { panX: 0, panY: 0, zoom: 1 }
});
const SIZES = { [HASH_A]: { width: 1200, height: 800 }, [HASH_B]: { width: 800, height: 600 } };

test('两份图 + 跨图意见通过校验，只保留白名单字段', () => {
  const clean = G.validate(baseGroup());
  assert.equal(clean.images.length, 2);
  assert.equal(clean.notes[0].targets.length, 2);
  assert.equal(clean.notes[0].targets[1].kind, 'point');
  // 额外属性不得漏过去。
  const withJunk = baseGroup();
  withJunk.notes[0].extra = '不该存在';
  withJunk.images[0].token = 'x';
  const back = G.validate(withJunk);
  assert.equal(Object.hasOwn(back.notes[0], 'extra'), false);
  assert.equal(Object.hasOwn(back.images[0], 'token'), false);
});

test('同一原件可在同组出现两个图块，批注只认实例 id', () => {
  const group = {
    schemaVersion: 1, id: 'group_2', title: '同图两块', revision: 1,
    images: [
      image('inst_1', HASH_A, 1200, 800, { x: 0, y: 0, width: 300, height: 200 }),
      image('inst_2', HASH_A, 1200, 800, { x: 320, y: 0, width: 300, height: 200 })
    ],
    notes: [{ id: 'note_2', text: '对比左边', linked: false,
      targets: [{ id: 't_only', imageId: 'inst_1', kind: 'point', point: { x: 10, y: 10 } }] }],
    comment: '', view: { panX: 0, panY: 0, zoom: 1 }
  };
  assert.equal(G.validate(group).images.length, 2);
});

test('异常 id、指纹、非等比摆位、越界坐标整份拒绝，不夹取', () => {
  const bad = baseGroup();
  bad.images[0].id = 'bad id!';
  assert.throws(() => G.validate(bad), /标识无效/);
  assert.throws(() => G.validate({ ...baseGroup(), images: [{ ...baseGroup().images[0], assetHash: 'nope' }] }), /指纹无效/);
  const skewed = baseGroup();
  skewed.images[0].frame = { x: 0, y: 0, width: 600, height: 200 };
  assert.throws(() => G.validate(skewed), /比例与源图不一致/);
  const outside = baseGroup();
  outside.notes[0].targets[0].rect = { x: 1100, y: 700, width: 200, height: 200 };
  assert.throws(() => G.validate(outside), /超出图片范围/);
  const nan = baseGroup();
  nan.notes[0].targets[1].point = { x: Number.NaN, y: 10 };
  assert.throws(() => G.validate(nan), /坐标无效/);
});

test('数量与字数上限：16 图、100 条、每条 8 目标、2000/4000 码位', () => {
  const many = baseGroup();
  many.images = Array.from({ length: 17 }, (_, i) => image(`img_${i}`, HASH_A, 100, 100,
    { x: i * 60, y: 0, width: 50, height: 50 }));
  assert.throws(() => G.validate(many), /1–16/);
  const tooManyTargets = baseGroup();
  tooManyTargets.notes[0].targets = Array.from({ length: 9 }, (_, i) => ({ id: `t_${i}`, imageId: 'img_a', kind: 'point', point: { x: 5, y: 5 } }));
  assert.throws(() => G.validate(tooManyTargets), /目标超过 8 个/);
  const tooLong = baseGroup();
  tooLong.notes[0].text = '字'.repeat(2001);
  assert.throws(() => G.validate(tooLong), /超过 2000 字/);
  const emptyText = baseGroup();
  emptyText.notes[0].text = '   ';
  assert.throws(() => G.validate(emptyText), /还没有填写/);
  const longComment = baseGroup();
  longComment.comment = 'x'.repeat(4001);
  assert.throws(() => G.validate(longComment), /超过 4000 字/);
});

test('三层坐标往返：屏幕/世界/源图，交互提交精确到 0.01', () => {
  const group = G.validate(baseGroup());
  const img = group.images[0];
  const view = { panX: 37, panY: -12, zoom: 1.5 };
  const source = { x: 123.456, y: 78.9 };
  const world = G.worldOfSource(img, source);
  const screen = G.screenOfWorld(view, world);
  const back = G.sourceAtScreen(img, view, screen);
  assert.equal(back.x, 123.46);
  assert.equal(back.y, 78.9);
  // 贴右下边界：收口后仍是合法值，不因尾数越界。
  const edge = G.sourceAtScreen(img, { panX: 0, panY: 0, zoom: 1 }, G.screenOfWorld({ panX: 0, panY: 0, zoom: 1 }, G.worldOfSource(img, { x: 1200, y: 800 })));
  assert.deepEqual(edge, { x: 1200, y: 800 });
  const region = G.regionAtScreen(img, { panX: 0, panY: 0, zoom: 1 },
    G.screenOfWorld({ panX: 0, panY: 0, zoom: 1 }, G.worldOfSource(img, { x: 0.004, y: 0.004 })),
    G.screenOfWorld({ panX: 0, panY: 0, zoom: 1 }, G.worldOfSource(img, { x: 1200, y: 800 })));
  assert.deepEqual(region, { x: 0, y: 0, width: 1200, height: 800 });
});

test('拖放与缩放只改 frame，目标与遮盖的源坐标一位不动', () => {
  const group = G.validate(baseGroup());
  const before = JSON.stringify({ targets: group.notes[0].targets, masks: group.images[0].masks });
  const moved = G.setFrame(group, 'img_a', { x: 300, y: 200, width: 300, height: 200 });
  assert.equal(JSON.stringify({ targets: moved.notes[0].targets, masks: moved.images[0].masks }), before);
  assert.equal(G.sourceAtScreen(moved.images[0], { panX: 0, panY: 0, zoom: 1 },
    G.screenOfWorld({ panX: 0, panY: 0, zoom: 1 }, G.worldOfSource(moved.images[0], { x: 50, y: 60 }))).x, 50);
});

test('移出有关联的图先拒绝并报涉及条数，不删意见也不把 B 变 A', () => {
  const group = G.validate(baseGroup());
  assert.throws(() => G.removeImage(group, 'img_b'), error => {
    assert.equal(error.code, 'IMAGE_IN_USE');
    assert.equal(error.notes, 1);
    return true;
  });
  const solo = G.deleteNote(group, 'note_1');
  const after = G.removeImage(solo, 'img_b');
  assert.equal(after.images.length, 1);
  // 无关联图可直接移出，撤销由外层历史负责。
});

test('撤销/重做只回模型，不含像素；超过步数从头淘汰', () => {
  const group = G.validate(baseGroup());
  const history = G.createHistory({ steps: 10 });
  // 规范用法：在每次修改之前把当前状态记一次。
  history.remember(group);
  const renamed = G.setTitle(group, '改个名');
  history.remember(renamed);
  const again = G.setTitle(renamed, '再改一次');
  assert.equal(history.depth().undo, 2);
  const undone = history.undo(again);
  assert.equal(undone.title, '改个名');
  const redone = history.redo(undone);
  assert.equal(redone.title, '再改一次');
  assert.equal(JSON.stringify(redone).includes('data:image'), false);
  assert.equal(JSON.stringify(redone).includes('base64'), false);
  // 步数上限从头淘汰：只记两格时最早的 group 被丢掉。
  const tiny = G.createHistory({ steps: 2 });
  tiny.remember(group);
  tiny.remember(renamed);
  tiny.remember(again);
  assert.equal(tiny.depth().undo, 2);
});

test('十进字格折行不拆 grapheme，emoji 与组合字算一个', () => {
  assert.deepEqual(G.textLines('ab🙂👩‍👩‍👦cd', 3), ['ab🙂', '👩‍👩‍👦cd']);
  assert.deepEqual(G.textLines('第一行\n换行', 10), ['第一行', '换行']);
  assert.deepEqual(G.textLines('', 5), ['']);
});

test('导出计划：withNotes 的宽高来自权威表，非组 JSON', () => {
  const group = G.validate(baseGroup());
  const plan = G.planExport(group, SIZES);
  const pic = plan.images[0];
  assert.equal(pic.mode, 'withNotes');
  assert.equal(pic.width, 1200);
  assert.equal(pic.height, 48 + 800 + pic.footerH);
  assert.equal(pic.bodyY, 48);
  assert.equal(pic.bodyX, 0);
  assert.ok(pic.footer.length > 0);
  // 页脚第一行紧贴图体底部 + 48 间隔；最后一行底部正好等于 H。
  assert.equal(pic.footer[0].y, 48 + 800 + 48);
  assert.equal(pic.footer.at(-1).y + 28, pic.height);
  assert.equal(plan.files.length, 3, '总览 + 2 图');
  assert.equal(plan.textFile, '说明.txt');
  assert.equal(plan.modes.withNotes, 2);
  assert.equal(plan.modes.bodyOnly, 0);
});

test('窄图补到 720 宽，图体居中仍是 1:1', () => {
  const group = G.validate({
    schemaVersion: 1, id: 'group_narrow', title: '窄图', revision: 1,
    images: [image('narrow', HASH_D, 400, 300, { x: 0, y: 0, width: 200, height: 150 })],
    notes: [], comment: '', view: { panX: 0, panY: 0, zoom: 1 }
  });
  const pic = G.planExport(group, { [HASH_D]: { width: 400, height: 300 } }).images[0];
  assert.equal(pic.width, 720);
  assert.equal(pic.bodyX, 160, 'Math.floor((720-400)/2)');
  assert.equal(pic.sourceWidth, 400);
  assert.equal(pic.height, 48 + 300);
});

test('合法满额图：6000×6000=36M 加头脚超限时整张转 bodyOnly', () => {
  const group = G.validate({
    schemaVersion: 1, id: 'group_full', title: '满额', revision: 1,
    images: [image('full', HASH_C, 6000, 6000, { x: 0, y: 0, width: 300, height: 300 },
      { masks: [{ id: 'm1', rect: { x: 10, y: 20, width: 50, height: 40 }, color: '#ffffff' }] })],
    notes: [{ id: 'note_full', text: '这里盖住', linked: false,
      targets: [{ id: 't_full', imageId: 'full', kind: 'region', rect: { x: 10, y: 20, width: 50, height: 40 } }] }],
    comment: '总体说明', view: { panX: 0, panY: 0, zoom: 1 }
  });
  const plan = G.planExport(group, { [HASH_C]: { width: 6000, height: 6000 } });
  const pic = plan.images[0];
  assert.equal(pic.mode, 'bodyOnly');
  assert.equal(pic.width, 6000);
  assert.equal(pic.height, 6000, 'W/H 就是权威源图尺寸');
  assert.equal(pic.bodyX, 0);
  assert.equal(pic.bodyY, 0);
  assert.deepEqual(pic.masks[0].rect, { x: 10, y: 20, width: 50, height: 40 });
  assert.equal(Object.hasOwn(pic, 'refs'), false, 'bodyOnly 不再给页面画意见号小标记');
  assert.equal(plan.modes.bodyOnly, 1);
  // 全文仍在说明.txt，不靠页脚。
  assert.match(plan.notesText, /这里盖住/);
});

test('源图 30000 高：加 48 头就超 30000，自动 bodyOnly', () => {
  const group = G.validate({
    schemaVersion: 1, id: 'group_tall', title: '超高', revision: 1,
    images: [image('tall', HASH_C, 1200, 30000, { x: 0, y: 0, width: 60, height: 1500 })],
    notes: [], comment: '', view: { panX: 0, panY: 0, zoom: 1 }
  });
  const plan = G.planExport(group, { [HASH_C]: { width: 1200, height: 30000 } });
  assert.equal(plan.images[0].mode, 'bodyOnly');
  assert.equal(plan.images[0].height, 30000);
});

test('小图 + 长意见把 footer 挤爆 30000，整张转 bodyOnly（不是截字）', () => {
  const notes = Array.from({ length: 20 }, (_, i) => ({
    id: `note_${i}`, text: '长'.repeat(2000), linked: false,
    targets: [{ id: `t_${i}`, imageId: 'small', kind: 'point', point: { x: 10 + i, y: 10 } }]
  }));
  const group = G.validate({
    schemaVersion: 1, id: 'group_long', title: '长文', revision: 1,
    images: [image('small', HASH_D, 400, 300, { x: 0, y: 0, width: 200, height: 150 })],
    notes, comment: '', view: { panX: 0, panY: 0, zoom: 1 }
  });
  const plan = G.planExport(group, { [HASH_D]: { width: 400, height: 300 } });
  assert.equal(plan.images[0].mode, 'bodyOnly');
  assert.equal(plan.images[0].footer.length, 0);
  // 全文必须完整留在说明.txt，一个字都不能被截。
  assert.equal((plan.notesText.match(/长{2000}/g) || []).length, 20);
});

test('原件尺寸表缺条目、或与组 JSON 不符，拒绝导出', () => {
  const group = G.validate(baseGroup());
  assert.throws(() => G.planExport(group, { [HASH_A]: { width: 1200, height: 800 } }), /缺少一张图的原件尺寸/);
  assert.throws(() => G.planExport(group, { [HASH_A]: { width: 1200, height: 800 }, [HASH_B]: { width: 800, height: 601 } }),
    /不一致/);
  assert.throws(() => G.planExport(group, { [HASH_A]: { width: 1201, height: 800 }, [HASH_B]: { width: 800, height: 600 } }),
    /不一致/);
});

test('16 图 + 总览 = 17 PNG，附 1 份说明.txt；复制/保存预算分开', () => {
  const images = Array.from({ length: 16 }, (_, i) => image(`i_${i}`, HASH_A, 100, 100, { x: i * 60, y: 0, width: 50, height: 50 }));
  const group = G.validate({ schemaVersion: 1, id: 'group_16', title: '16图', revision: 1, images, notes: [], comment: '', view: { panX: 0, panY: 0, zoom: 1 } });
  // 同一原件 16 个图块：权威表只有一条，逐图仍按各自实例。
  const plan = G.planExport(group, { [HASH_A]: { width: 100, height: 100 } });
  assert.equal(plan.files.length, 17);
  assert.equal(plan.files[0].name, '00-总览.png');
  assert.equal(plan.files.at(-1).name, '16-图16.png');
  assert.equal(plan.textFile, '说明.txt');
  assert.equal(plan.budgets.copyBatchBytes, 256 * 1024 * 1024);
  assert.equal(plan.budgets.copyCacheBytes, 512 * 1024 * 1024);
  assert.equal(plan.budgets.saveBatchBytes, 3 * 1024 * 1024 * 1024);
  assert.equal(plan.budgets.imageBytes, 148 * 1024 * 1024);
});

test('总览只保留缩略范围：最长边 ≤4096、≤16M 像素', () => {
  const group = G.validate(baseGroup());
  const overview = G.planExport(group, SIZES).overview;
  assert.ok(overview.width <= 4096 && overview.height <= 4096);
  assert.ok(overview.width * overview.height <= 16000000);
  assert.ok(overview.scale > 0 && overview.scale <= 1);
  const huge = G.validate({
    schemaVersion: 1, id: 'group_huge', title: '大布局', revision: 1,
    images: [
      image('h1', HASH_A, 1200, 800, { x: 0, y: 0, width: 6000, height: 4000 }),
      image('h2', HASH_B, 800, 600, { x: 6000, y: 4000, width: 4000, height: 3000 })
    ],
    notes: [], comment: '', view: { panX: 0, panY: 0, zoom: 1 }
  });
  const big = G.planExport(huge, SIZES).overview;
  assert.ok(big.width <= 4096 && big.height <= 4096);
  assert.ok(big.scale < 1);
});

test('说明.txt 不带本机路径/来源窗口，图号与意见映射一致', () => {
  const group = G.validate(baseGroup());
  const text = G.buildNotesText(group, { now: new Date(2026, 10, 5, 8, 14, 0) });
  assert.match(text, /组名：批注组-测试/);
  assert.match(text, /图1：img_a（1200 × 800）/);
  assert.match(text, /图2：img_b（800 × 600）/);
  assert.match(text, /意见1（涉及：图1 框 \(50, 60, 200, 100\)、图2 点 \(90, 120\)）/);
  assert.match(text, /颜色照这个改/);
  assert.equal(text.includes('C:\\'), false);
  assert.equal(text.includes('AppData'), false);
});

test('文件命名零填充，图号稳定', () => {
  assert.deepEqual(G.fileNames(2).map(f => f.name), ['00-总览.png', '01-图1.png', '02-图2.png']);
  assert.equal(G.fileNames(16).at(-1).name, '16-图16.png');
});

// 浮点边界：交互提交的贴边框再交给 validator，不能因为 1e-14 尾数被拒；也不放宽 validator。
test('贴边提交与校验口径一致：常见源宽的全宽框往返不误拒', () => {
  for (const width of [1, 100, 1812, 2049, 2134, 6000, 30000]) {
    const height = Math.max(1, Math.min(width, 5000, Math.floor(36_000_000 / width)));
    const image = { id: 'img_edge', assetHash: 'a'.repeat(64), name: '图1', width, height,
      frame: { x: 0, y: 0, width: 400, height: Math.max(1, 400 * height / width) }, masks: [] };
    const view = { panX: 0, panY: 0, zoom: 1 };
    const start = G.screenOfWorld(view, G.worldOfSource(image, { x: 0, y: 0 }));
    const end = G.screenOfWorld(view, G.worldOfSource(image, { x: width, y: height }));
    const rect = G.regionAtScreen(image, view, start, end);
    assert.equal(rect.x, 0);
    assert.equal(rect.y, 0);
    assert.equal(rect.width, width);
    assert.equal(rect.height, height);
    const group = G.validate({ schemaVersion: 1, id: 'group_edge', title: '边界', revision: 1,
      images: [{ ...image, masks: [{ id: 'mask_edge', rect, color: '#ffffff' }] }], notes: [], comment: '', view });
    const mask = group.images[0].masks[0].rect;
    assert.equal(Math.round((mask.x + mask.width) * 100), width * 100);
    assert.equal(Math.round((mask.y + mask.height) * 100), height * 100);
  }
});
