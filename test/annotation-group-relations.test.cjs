'use strict';
// 第 2 版语义：先标后写的空文字目标、独立关系、完成度判定、版本不降级、成品拦截。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const G = require('../core/annotation-group.js');

const HASH_A = 'a'.repeat(64);
const SIZES = { [HASH_A]: { width: 1200, height: 800 } };

const baseGroup = (extra = {}) => ({
  schemaVersion: 1, id: 'group_rel', title: '关系测试', revision: 1,
  images: [{ id: 'img_a', assetHash: HASH_A, name: '图1', width: 1200, height: 800,
    frame: { x: 0, y: 0, width: 600, height: 400 }, masks: [] }],
  notes: [], relations: undefined, comment: '', view: { panX: 0, panY: 0, zoom: 1 },
  ...extra
});

const targetOf = (id, kind = 'point', body = { x: 40, y: 50 }) => ({
  id, imageId: 'img_a', kind,
  ...(kind === 'point' ? { point: body } : { rect: body })
});

const noteWith = (id, text, target) => ({ id, text, linked: false, targets: [target] });

// 两个空文字框 + 一条有字关系：可以直接满量导出的最小组合。
function twoEmptyBoxesWithRelation() {
  const group = G.validate(baseGroup());
  const one = G.addNote(group, noteWith('note_a', '', targetOf('t_a', 'region', { x: 10, y: 20, width: 100, height: 60 })));
  const two = G.addNote(one, noteWith('note_b', '', targetOf('t_b', 'point', { x: 300, y: 200 })));
  return G.addRelation(two, { id: 'rel_1', text: '这两处颜色一致',
    ends: [{ noteId: 'note_a', targetId: 't_a' }, { noteId: 'note_b', targetId: 't_b' }] });
}

test('版本：旧 1 版不含新语义照常读；带关系或空文字才升 2，升上去不降', () => {
  const old = G.validate(baseGroup());
  assert.equal(old.schemaVersion, 1);
  assert.deepEqual(old.relations, [], '旧组按空关系集合解释');
  // 旧版组不能自带独立关系：先拒绝，不静默丢字段。
  assert.throws(() => G.validate({ ...baseGroup(), relations: [{ id: 'rel_x', text: '', ends: [] }] }), /第 1 版/);
  // 旧组加空文字目标：同一次改动里原子升到 2。
  const promoted = G.addNote(old, noteWith('note_a', '', targetOf('t_a')));
  assert.equal(promoted.schemaVersion, 2);
  // 补齐文字不降版，删掉最后一条关系也不降版。
  const filled = G.updateNote(promoted, 'note_a', { text: '写好了' });
  assert.equal(filled.schemaVersion, 2);
  const twoEmpty = twoEmptyBoxesWithRelation();
  assert.equal(twoEmpty.schemaVersion, 2);
  assert.equal(G.deleteRelation(twoEmpty, 'rel_1').schemaVersion, 2);
  // 第 3 版及以后仍然拒绝，不猜。
  assert.throws(() => G.validate({ ...baseGroup(), schemaVersion: 3 }), /版本不支持/);
  assert.throws(() => G.validate({ ...baseGroup(), schemaVersion: 0 }), /版本不支持/);
});

test('空文字只在第 2 版合法：第 1 版仍要求写意见，长度/类型/坐标照旧逐项校验', () => {
  assert.throws(() => G.validate({ ...baseGroup(), notes: [noteWith('note_a', '   ', targetOf('t_a'))] }), /还没有填写/);
  const draft = G.validate({ ...baseGroup(), schemaVersion: 2, notes: [noteWith('note_a', '', targetOf('t_a'))] });
  assert.equal(draft.notes[0].text, '');
  assert.throws(() => G.validate({ ...baseGroup(), schemaVersion: 2,
    notes: [noteWith('note_a', '字'.repeat(2001), targetOf('t_a'))] }), /超过 2000 字/);
  assert.throws(() => G.validate({ ...baseGroup(), schemaVersion: 2,
    notes: [{ id: 'note_a', text: 3, linked: false, targets: [targetOf('t_a')] }] }), /无效/);
  assert.throws(() => G.validate({ ...baseGroup(), schemaVersion: 2,
    notes: [noteWith('note_a', '', targetOf('t_a', 'point', { x: 5000, y: 0 }))] }), /超出图片范围/);
});

test('关系校验：正好两处、引用现存目标、不自我连接、不重复、有上限', () => {
  const group = twoEmptyBoxesWithRelation();
  const pair = [{ noteId: 'note_a', targetId: 't_a' }, { noteId: 'note_b', targetId: 't_b' }];
  const raw = { ...group, relations: undefined };
  const withPair = (relation) => G.validate({ ...raw, relations: [relation] });
  assert.throws(() => withPair({ id: 'rel_x', text: '', ends: [pair[0]] }), /必须正好连着两处/);
  assert.throws(() => withPair({ id: 'rel_x', text: '', ends: [pair[0], pair[0]] }), /不能把一处连到它自己/);
  assert.throws(() => withPair({ id: 'rel_x', text: '', ends: [pair[0], { noteId: 'note_b', targetId: 'nope' }] }), /不存在的目标/);
  assert.throws(() => withPair({ id: 'rel_x', text: '', ends: [pair[0], { noteId: 'ghost', targetId: 't_b' }] }), /不存在的意见/);
  // 无向重复：反过来写也算同一条。
  assert.throws(() => G.validate({ ...raw, relations: [
    { id: 'rel_1', text: 'a', ends: pair },
    { id: 'rel_2', text: 'b', ends: [pair[1], pair[0]] }] }), /同一处两处只留一条关系/);
  assert.throws(() => G.validate({ ...raw, relations: [
    { id: 'rel_1', text: 'a', ends: pair }, { id: 'rel_1', text: 'b', ends: pair }] }), /标识重复/);
  assert.throws(() => withPair({ id: 'rel_x', text: '字'.repeat(2001), ends: pair }), /超过 2000 字/);
  const many = Array.from({ length: 101 }, (_, index) => ({ id: `rel_${index}`, text: 'x',
    ends: [{ noteId: 'note_a', targetId: 't_a' }, { noteId: 'note_b', targetId: 't_b' }] }));
  assert.throws(() => G.validate({ ...raw, relations: many }), /关系最多 100 条/);
});

test('完成度：目标自带文字，或被文字非空且两端有效的关系覆盖，都算说明过', () => {
  const complete = twoEmptyBoxesWithRelation();
  assert.deepEqual(G.pendingOf(complete), []);
  // 空文字框单独存在就是未完成，并报出位置。
  const lonely = G.addNote(G.validate(baseGroup()), noteWith('note_a', '', targetOf('t_a', 'region', { x: 10, y: 20, width: 100, height: 60 })));
  const pending = G.pendingOf(lonely);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, 'target');
  assert.match(pending[0].label, /意见1/);
  assert.match(pending[0].label, /图1 框 \(10, 20, 100, 60\)/);
  // 关系说明留空：两端不算被覆盖，自己也报未完成。
  const blank = G.updateRelation(complete, 'rel_1', { text: '   ' });
  const blankPending = G.pendingOf(blank);
  assert.equal(blankPending.length, 3);
  assert.equal(blankPending.filter(item => item.kind === 'relation').length, 1);
  // 关系文字有内容但端点失效的组根本过不了校验，不存在“假覆盖”。
  assert.throws(() => G.validate({ ...complete, relations: [{ id: 'rel_1', text: '有字',
    ends: [{ noteId: 'note_a', targetId: 't_a' }, { noteId: 'note_b', targetId: 'gone' }] }] }), /不存在的目标/);
});

test('成品导出拦未完成，并列出要补的位置；补齐后正常出计划', () => {
  const lonely = G.addNote(G.validate(baseGroup()), noteWith('note_a', '', targetOf('t_a')));
  assert.throws(() => G.planExport(lonely, SIZES), error => {
    assert.match(error.message, /还有 1 处没写说明/);
    assert.match(error.message, /意见1/);
    return true;
  });
  const blankRelation = G.updateRelation(twoEmptyBoxesWithRelation(), 'rel_1', { text: '' });
  assert.throws(() => G.planExport(blankRelation, SIZES), /关系1/);
  // 两个空框 + 一条有字关系：不强迫补字，直接出计划。
  const plan = G.planExport(twoEmptyBoxesWithRelation(), SIZES);
  assert.equal(plan.images.length, 1);
  assert.equal(plan.modes.withNotes, 1);
});

test('说明文本：目标带图号与源坐标、关系写清两处有关、无单独文字的目标指向关系', () => {
  const plan = G.planExport(twoEmptyBoxesWithRelation(), SIZES);
  const text = plan.notesText;
  assert.match(text, /意见1（涉及：图1 框 \(10, 20, 100, 60\)）/);
  assert.match(text, /意见2（涉及：图1 点 \(300, 200\)）/);
  assert.match(text, /意见1[\s\S]*这处没有单独文字，说明见 关系1/);
  assert.match(text, /关系1（两处有关：意见1 的 图1 框 \(10, 20, 100, 60\) ↔ 意见2 的 图1 点 \(300, 200\)）/);
  assert.match(text, /这两处颜色一致/);
  // 逐图页脚同样带关系全文，不只在说明.txt 里。
  const footer = plan.images[0].footer.map(line => line.text).join('\n');
  assert.match(footer, /关系1（两处有关）/);
  assert.match(footer, /这两处颜色一致/);
});

test('总览保留框线与文字短标签，但不带意见号数字徽章', () => {
  const plan = G.planExport(twoEmptyBoxesWithRelation(), SIZES);
  const overview = plan.overview;
  assert.equal(overview.targets.length, 2);
  for (const target of overview.targets) {
    assert.equal(Object.hasOwn(target, 'label'), false, '总览目标不带 1A/1B 这类数字标签');
    assert.equal(Object.hasOwn(target, 'noteNumber'), false);
  }
  for (const label of overview.labels) assert.equal(Object.hasOwn(label, 'noteNumber'), false);
  assert.equal(overview.relations.length, 1);
  assert.equal(overview.relations[0].relationId, 'rel_1');
  assert.equal(overview.relations[0].text, '这两处颜色一致');
  assert.ok(overview.relations[0].a && overview.relations[0].b, '总览保留两端位置画线');
  assert.ok(overview.relations[0].label.width > 0, 'planner 给出标签框');
});

test('删意见连带移除它的关系，撤销快照能整份恢复', () => {
  const group = twoEmptyBoxesWithRelation();
  assert.equal(G.relationsOfNote(group, 'note_a').length, 1);
  const after = G.deleteNote(group, 'note_a');
  assert.deepEqual(after.relations, []);
  assert.equal(after.notes.length, 1);
  // 历史是整份快照：关系、空文字、版本都跟着回来。
  const history = G.createHistory();
  history.remember(group);
  const undone = history.undo(after);
  assert.deepEqual(undone.relations, group.relations);
  assert.equal(undone.schemaVersion, 2);
  assert.deepEqual(history.redo(undone).relations, []);
});

test('关系引用稳定：改文字、挪摆位、改标题后端点仍指向同一处，不复制几何', () => {
  const group = twoEmptyBoxesWithRelation();
  const moved = G.setFrame(group, 'img_a', { x: 120, y: 80, width: 300, height: 200 });
  assert.deepEqual(moved.relations[0].ends, group.relations[0].ends);
  const retitled = G.setTitle(moved, '改个名');
  const edited = G.updateRelation(retitled, 'rel_1', { text: '两处配色统一' });
  assert.equal(edited.relations[0].ends[0].targetId, 't_a');
  assert.equal(edited.relations[0].text, '两处配色统一');
  // 关系里没有 rect/point 副本：端点只存引用。
  assert.deepEqual(Object.keys(edited.relations[0]).sort(), ['ends', 'id', 'text']);
  assert.deepEqual(Object.keys(edited.relations[0].ends[0]).sort(), ['noteId', 'targetId']);
});

test('逐图页脚自带定位：每个目标有图号与坐标，关系两端能对上号', () => {
  // 小花给的最小复现：100×100、两个空点 (10,20) / (70,80)、一条“这两处一致”。
  const hash = 'e'.repeat(64);
  const group = G.validate({
    schemaVersion: 2, id: 'group_footer', title: '页脚定位', revision: 1,
    images: [{ id: 'i1', assetHash: hash, name: '图1', width: 100, height: 100,
      frame: { x: 0, y: 0, width: 200, height: 200 }, masks: [] }],
    notes: [
      { id: 'n1', text: '', linked: false, targets: [{ id: 't1', imageId: 'i1', kind: 'point', point: { x: 10, y: 20 } }] },
      { id: 'n2', text: '', linked: false, targets: [{ id: 't2', imageId: 'i1', kind: 'point', point: { x: 70, y: 80 } }] }
    ],
    relations: [{ id: 'r1', text: '这两处一致', ends: [
      { noteId: 'n1', targetId: 't1' }, { noteId: 'n2', targetId: 't2' }] }],
    comment: '', view: { panX: 0, panY: 0, zoom: 1 }
  });
  const plan = G.planExport(group, { [hash]: { width: 100, height: 100 } });
  const footer = plan.images[0].footer;
  const text = footer.map(line => line.text).join('');
  assert.match(text, /意见1/);
  assert.match(text, /位置：图1 点 \(10, 20\)/, `意见 1 的定位要进页脚：${text}`);
  assert.match(text, /位置：图1 点 \(70, 80\)/, `意见 2 的定位要进页脚：${text}`);
  assert.match(text, /关系1（两处有关）/);
  assert.match(text, /两端：意见1 的 图1 点 \(10, 20\) ↔ 意见2 的 图1 点 \(70, 80\)/, `关系两端要能对上号：${text}`);
  assert.match(text, /这两处一致/);
  // 每一行都不超过 planner 的字格宽度（换行由 textLines 负责，页面不自作主张）。
  assert.ok(footer.every(line => Array.from(line.text).length <= plan.images[0].grid.cols),
    `页脚行超出字格：${footer.map(line => Array.from(line.text).length).join(',')}`);
});

test('跨图与同一条多目标：每张图的页脚都写全所有目标与关系两端', () => {
  const hashA = 'a'.repeat(64), hashB = 'b'.repeat(64);
  const group = G.validate({
    schemaVersion: 2, id: 'group_cross', title: '跨图页脚', revision: 1,
    images: [
      { id: 'ia', assetHash: hashA, name: '图1', width: 400, height: 300, frame: { x: 0, y: 0, width: 200, height: 150 }, masks: [] },
      { id: 'ib', assetHash: hashB, name: '图2', width: 300, height: 200, frame: { x: 220, y: 0, width: 150, height: 100 }, masks: [] }
    ],
    notes: [
      // 一条意见挂了三个目标：两张图各一处框 + 图1 一个点。
      { id: 'n_multi', text: '整组配色照这里', linked: true, targets: [
        { id: 't_a', imageId: 'ia', kind: 'region', rect: { x: 10, y: 20, width: 100, height: 60 } },
        { id: 't_b', imageId: 'ib', kind: 'point', point: { x: 50, y: 60 } },
        { id: 't_c', imageId: 'ia', kind: 'point', point: { x: 200, y: 120 } }
      ] },
      { id: 'n_other', text: '', linked: false, targets: [{ id: 't_d', imageId: 'ib', kind: 'region', rect: { x: 5, y: 8, width: 40, height: 30 } }] }
    ],
    relations: [{ id: 'r_cross', text: '两处对比着看', ends: [
      { noteId: 'n_other', targetId: 't_d' }, { noteId: 'n_multi', targetId: 't_b' }] }],
    comment: '', view: { panX: 0, panY: 0, zoom: 1 }
  });
  const sizes = { [hashA]: { width: 400, height: 300 }, [hashB]: { width: 300, height: 200 } };
  const plan = G.planExport(group, sizes);
  const footerOf = index => plan.images[index].footer.map(line => line.text).join('');
  const first = footerOf(0), second = footerOf(1);
  // 图1 页脚：多目标意见的三个位置全都列出来（含另一张图那处）。
  assert.match(first, /位置：图1 框 \(10, 20, 100, 60\)；图2 点 \(50, 60\)；图1 点 \(200, 120\)/, first);
  // 图2 页脚同样列全，不因“不是本图”就省掉。
  assert.match(second, /位置：图1 框 \(10, 20, 100, 60\)；图2 点 \(50, 60\)；图1 点 \(200, 120\)/, second);
  // 关系两端都在图2：图2 页脚写清两端，图1 页脚不插与它无关的关系。
  assert.match(second, /两端：意见2 的 图2 框 \(5, 8, 40, 30\) ↔ 意见1 的 图2 点 \(50, 60\)/, second);
  assert.match(second, /两处对比着看/);
  assert.equal(/关系1/.test(first), false, '一条关系不碰图1 时，图1 页脚不硬插它');
});

test('版本高水位：撤销/重做不把已升到第 2 版的组拉回第 1 版', () => {
  const v1 = G.validate(baseGroup());
  assert.equal(v1.schemaVersion, 1);
  const history = G.createHistory();
  history.remember(v1);
  const promoted = G.addNote(v1, noteWith('note_a', '', targetOf('t_a')));
  assert.equal(promoted.schemaVersion, 2);
  const undone = history.undo(promoted);
  assert.equal(undone.schemaVersion, 2, '撤销后仍是第 2 版，保存不会降级');
  assert.equal(undone.notes.length, 0, '内容确实退回去了');
  const redone = history.redo(undone);
  assert.equal(redone.schemaVersion, 2);
  assert.equal(redone.notes.length, 1);
  // 两条都是旧版时互相不动版本。
  const plain = G.keepVersion(v1, v1);
  assert.equal(plain.schemaVersion, 1);
  // 外部回填同理：旧文档不能盖掉高水位。
  assert.equal(G.keepVersion(v1, promoted).schemaVersion, 2);
});
