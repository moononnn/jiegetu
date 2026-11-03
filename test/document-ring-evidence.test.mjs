import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectDocumentRing, findDocumentRepairSource, RING_MIN_SAMPLES, RING_CONTROLS, REPAIR_MAX_PIXELS } from '../core/document-ring-evidence.mjs';

// 匿名合成原帧：没有任何夹具常量、没有真实截图。所有像素只由下面的生成规则决定。
const WIDTH = 48, HEIGHT = 40;
const LAYOUT = { top: 0, bottom: HEIGHT, left: 0, right: WIDTH };
const RECT = { top: 14, bottom: 20, left: 16, right: 28 };

const noise = (docRow, x) => (Math.imul(docRow + 1, 17389) ^ Math.imul(x + 3, 31337)) >>> 8 & 255;
const documentFill = (docRow, x) => { const v = noise(docRow, x); return [v, (v * 7) & 255, (v * 13) & 255]; };

function frame(id, offset, fill, width = WIDTH, height = HEIGHT) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b, a = 255] = fill(y, x, y + offset);
    const i = (y * width + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
  }
  return { id, offset, image: { width, height, data } };
}
// 目标帧在 offset 10、来源在 0（Δ=10 ≥ 框高 6 + 2），第三方在 20：三帧都覆盖环的文档坐标。
const ring = (options = {}) => {
  const fixedLeft = options.fixedLeft ?? 0;
  const fill = (screenY, x, docRow) => x < fixedLeft ? [90, 90, 90]
    : (options.fill ? options.fill(screenY, x, docRow) : documentFill(docRow, x));
  const target = frame(0, 10, fill);
  const source = frame(1, 0, (screenY, x, docRow) => (options.sourceFill ? options.sourceFill(screenY, x, docRow) : fill(screenY, x, docRow)));
  const third = frame(2, 20, fill);
  return { target, source, third, retained: [source, target, third] };
};
const inspect = (frames, extra = {}) => inspectDocumentRing({
  target: frames.target, source: frames.source, retained: frames.retained, rect: RECT, layout: LAYOUT,
  blocked: () => false, ...extra
});

test('正例：文档纹理环成立；环里混着屏幕固定壁纸也不影响文档证据', () => {
  const plain = inspect(ring());
  assert.equal(plain.supported, true, JSON.stringify(plain));
  assert.equal(plain.reason, 'ok');
  assert.equal(plain.unknownSamples, 0, '正例必须每一个采样点都能分类');
  assert.ok(plain.samples >= RING_MIN_SAMPLES, `样本不足：${plain.samples}`);
  assert.equal(plain.matched, plain.samples, '文档纹理应当与来源逐通道一致');
  assert.ok(plain.detailed >= 4, '需要有纹理点');
  assert.ok(plain.sampled <= 48);
  // 左侧 14 列是屏幕固定壁纸：那些点只进 fixedSamples，不进分母也不妨碍右侧文档证据。
  const mixed = inspect(ring({ fixedLeft: 15 }));
  assert.equal(mixed.supported, true, JSON.stringify(mixed));
  assert.equal(mixed.unknownSamples, 0, '固定区必须被完整归为 fixed，不能落进 unknown');
  assert.ok(mixed.fixedSamples > 0, '固定区必须被归为静态候选');
  assert.ok(mixed.matched >= RING_MIN_SAMPLES);
});

test('负例：同屏跨帧完全一致只是静态候选，少量同点不能自证 document', () => {
  const wallpaper = () => [110, 120, 130];
  const fixed = inspect(ring({ fill: wallpaper }));
  assert.equal(fixed.supported, false, JSON.stringify(fixed));
  assert.equal(fixed.samples, 0, '屏幕固定点不能进 document 分母');
  assert.ok(fixed.fixedSamples > 0);
  // 第三帧小范围闪烁：只有那几点“同屏有变化”，样本远少于门槛，不能靠排除 unknown 自证。
  const flicker = ring({ fill: wallpaper });
  for (const y of [12, 13]) for (let x = 16; x < 20; x++) {
    const i = (y * WIDTH + x) * 4;
    flicker.third.image.data[i] = 240; flicker.third.image.data[i + 1] = 20; flicker.third.image.data[i + 2] = 20;
  }
  const flickered = inspect(flicker);
  assert.equal(flickered.supported, false, JSON.stringify(flickered));
  assert.ok(flickered.samples < RING_MIN_SAMPLES, `少量同点自证：${flickered.samples}`);
});

test('负例：±8 周期别名判 ambiguous，±1 错位也必须拒', () => {
  const alias = ring({ fill: (screenY, x, docRow) => documentFill(docRow % 8, x) });
  const result = inspect(alias);
  assert.equal(result.supported, false, JSON.stringify(result));
  assert.equal(result.reason, 'ambiguous', '±8 对照同样通过时必须判 ambiguous');
  assert.deepEqual([...RING_CONTROLS], [-8, -1, 1, 8]);
});

test('负例：双列错位（来源只对一个列对）与低纹理', () => {
  // 页面有两列各自滚动：用只对左列对齐的来源，右半列必然不一致，过不了 95%。
  const skew = inspect(ring({ sourceFill: (screenY, x, docRow) => documentFill(x >= WIDTH / 2 ? docRow - 5 : docRow, x) }));
  assert.equal(skew.supported, false, JSON.stringify(skew));
  assert.equal(skew.reason, 'match-rate', JSON.stringify(skew));
  // 竖直缓坡：文档处一致但邻域差 2 < 12，纹理点不足。
  const ramp = inspect(ring({ fill: (screenY, x, docRow) => [docRow * 2 & 255, docRow * 2 & 255, docRow * 2 & 255] }));
  assert.equal(ramp.supported, false, JSON.stringify(ramp));
  assert.equal(ramp.reason, 'texture', JSON.stringify(ramp));
});

test('负例：仅 alpha 差、源区被遮挡、整环都是动态 UI', () => {
  // 只差 alpha：逐通道（含 alpha）比较必须拒。
  const alpha = inspect(ring({ sourceFill: (screenY, x, docRow) => [...documentFill(docRow, x).slice(0, 3), 250] }));
  assert.equal(alpha.supported, false, JSON.stringify(alpha));
  assert.equal(alpha.matched, 0, 'alpha 不同就不能算一致');
  // 来源整框任何一处被已知遮挡覆盖就整块拒。
  const blocked = inspect(ring(), { blocked: (record, box) => record.id === 1 && box.top <= 24 && box.bottom >= 24 });
  assert.equal(blocked.supported, false);
  assert.equal(blocked.reason, 'blocked-source');
  // 整环都是动态 UI：同屏每帧都变，但文档处从不一致，不能形成一个 document 样本。
  const dynamic = inspect(ring({ fill: (screenY, x) => [noise(screenY * 7919 + x * 131, x), 30, 60] }));
  assert.equal(dynamic.supported, false, JSON.stringify(dynamic));
  assert.equal(dynamic.samples, 0);
});

test('负例：target 半边错位不得靠把点归入 unknown 过关', () => {
  // 目标自己右半列与第三方见证不一致：那些点变成 unknown，本阶段零容忍直接作废。
  const targetSkew = ring();
  const skewFill = (screenY, x, docRow) => documentFill(x >= WIDTH / 2 ? docRow - 5 : docRow, x);
  const rebuilt = frame(0, 10, skewFill);
  const result = inspect({ ...targetSkew, target: rebuilt, retained: [targetSkew.source, rebuilt, targetSkew.third] });
  assert.equal(result.supported, false, JSON.stringify(result));
  assert.equal(result.reason, 'unknown-evidence');
  assert.ok(result.unknownSamples > 0, '错位半边必须落进 unknown 而不是被静默丢弃');
});

test('负例：复制同 offset 的来源不能冒充第三方见证', () => {
  const base = ring();
  // 三个不同 offset（10/0/20）：其中 offset=20 的帧是乱码，真正提供“文档见证”的只有一份同 offset 的拷贝。
  const junk = frame(3, 20, (screenY, x) => [noise(screenY * 7919 + x * 131, x), 30, 60]);
  const impostor = { ...base.source, id: 9 };
  const result = inspect({ ...base, retained: [base.target, base.source, impostor, junk] });
  assert.equal(result.supported, false, JSON.stringify(result));
  assert.equal(result.samples, 0, '同 offset 的帧不能形成第三方见证');
  assert.equal(result.reason, 'unknown-evidence');
});

test('负例：环上 target/source 点被已知遮挡盖住就记 unknown 并拒', () => {
  const frames = ring();
  const targetHit = inspect(frames, { blocked: (record, box) => record === frames.target && box.top === RECT.top - 2 && box.left === RECT.left });
  assert.equal(targetHit.supported, false);
  assert.equal(targetHit.reason, 'unknown-evidence');
  assert.equal(targetHit.unknownSamples, 1);
  const sourceHit = inspect(frames, { blocked: (record, box) => record === frames.source && box.left === RECT.right + 1 });
  assert.equal(sourceHit.supported, false);
  assert.equal(sourceHit.reason, 'unknown-evidence');
  assert.ok(sourceHit.unknownSamples > 0);
});

test('负例：保留集含 null 或不同几何时返回 invalid-input 而不是抛异常', () => {
  const frames = ring();
  const withNull = inspect({ ...frames, retained: [...frames.retained, null] });
  assert.equal(withNull.supported, false);
  assert.equal(withNull.reason, 'invalid-input');
  const wide = frame(7, 30, (screenY, x) => [1, 2, 3], WIDTH + 4, HEIGHT);
  const mismatched = inspect({ ...frames, retained: [...frames.retained, wide] });
  assert.equal(mismatched.reason, 'invalid-input');
  const broken = inspect({ ...frames, retained: [...frames.retained, { id: 8, offset: 30, image: { width: WIDTH, height: HEIGHT, data: [1, 2, 3] } }] });
  assert.equal(broken.reason, 'invalid-input');
});

test('采样有界：23×23 框每边最多 12 个位置，总数不超过 48', () => {
  const width = 64, height = 128;
  const fill = (screenY, x, docRow) => documentFill(docRow, x);
  const target = frame(0, 40, fill, width, height);
  const source = frame(1, 0, fill, width, height);
  const third = frame(2, 20, fill, width, height);
  const rect = { top: 20, bottom: 43, left: 20, right: 43 };
  const result = inspectDocumentRing({ target, source, retained: [source, target, third], rect,
    layout: { top: 0, bottom: height, left: 0, right: width }, blocked: () => false });
  assert.equal(result.sampled, 48, `23×23 框应采 48 点，实际 ${result.sampled}`);
  assert.ok(result.sampled <= 48);
  assert.equal(result.unknownSamples, 0, JSON.stringify(result));
  assert.equal(result.supported, true, JSON.stringify(result));
  // 12 宽的框不能退回 23 个点；小框也只是 36 点上限。
  assert.equal(inspect(ring()).sampled, 36);
});

test('负例：只有两帧、已淘汰的 target/source、来源整框跑出正文区', () => {
  const two = ring();
  const shortRing = inspect({ ...two, retained: [two.source, two.target] });
  assert.equal(shortRing.supported, false);
  assert.equal(shortRing.reason, 'offset-count', '至少三个不同 offset 才能形成第三方见证');
  const evicted = ring();
  const evictedResult = inspectDocumentRing({ target: { ...evicted.target, id: 99 }, source: evicted.source, retained: evicted.retained,
    rect: RECT, layout: LAYOUT, blocked: () => false });
  assert.equal(evictedResult.supported, false);
  assert.equal(evictedResult.reason, 'retained-missing');
  const outside = inspect(ring(), { layout: { top: 0, bottom: RECT.top + 10 + 4, left: 0, right: WIDTH } });
  assert.equal(outside.supported, false);
  assert.equal(outside.reason, 'source-outside');
});

test('正文域边界：source 或第三方的环不能借用固定页头页尾作见证', () => {
  const sourceFooter = inspect(ring(), { layout: { ...LAYOUT, bottom: RECT.bottom + 11 } });
  assert.equal(sourceFooter.supported, false, JSON.stringify(sourceFooter));
  assert.equal(sourceFooter.reason, 'unknown-evidence');
  const witnessHeader = inspect(ring(), { layout: { ...LAYOUT, top: 4 } });
  assert.equal(witnessHeader.supported, false, JSON.stringify(witnessHeader));
  assert.equal(witnessHeader.reason, 'unknown-evidence');
});

test('预算：guard 抛错原样上抛，不当成通过；采样次数有界', () => {
  const budget = new RangeError('遮挡分析超出预算');
  budget.code = 'analysis-budget';
  assert.throws(() => inspect(ring(), { guard: () => { throw budget; } }), error => error === budget && error.code === 'analysis-budget');
  let calls = 0;
  const ok = inspect(ring(), { guard: () => { calls++; } });
  assert.equal(ok.supported, true);
  assert.ok(calls > 0 && calls <= 600, `采样次数无界：${calls}`);
});

test('整框双源查询：两张同文档整框一致才返回现有记录，任何差异整份拒', () => {
  const frames = ring();
  const query = extra => findDocumentRepairSource({ target: frames.target, retained: frames.retained, rect: RECT, layout: LAYOUT, blocked: () => false, ...extra });
  const source = query({});
  assert.equal(source, frames.source, '必须返回 retained 里的原记录本身');
  assert.ok(frames.retained.includes(source));
  // 第二个来源整框内差 1 个像素：整份拒。
  const pixel = ((RECT.top + 10 - 20) * WIDTH + RECT.left) * 4;
  const diff = ring();
  diff.third.image.data[pixel] = (diff.third.image.data[pixel] + 97) & 255;
  assert.equal(findDocumentRepairSource({ target: diff.target, retained: diff.retained, rect: RECT, layout: LAYOUT, blocked: () => false }), null);
  // alpha 差 1 也拒。
  const alpha = ring();
  alpha.third.image.data[pixel + 3] = 250;
  assert.equal(findDocumentRepairSource({ target: alpha.target, retained: alpha.retained, rect: RECT, layout: LAYOUT, blocked: () => false }), null);
  // 同 offset 的拷贝充当第二来源：不独立，拒。
  const copy = ring();
  const junk = frame(3, 20, (screenY, x) => [noise(screenY * 7919 + x * 131, x), 30, 60]);
  const duplicated = { ...copy, retained: [copy.target, copy.source, { ...copy.source, id: 9 }, junk] };
  assert.equal(findDocumentRepairSource({ target: duplicated.target, retained: duplicated.retained, rect: RECT, layout: LAYOUT, blocked: () => false }), null);
  // 被淘汰（不在 retained 里）或不足三帧：拒。
  const evicted = ring();
  assert.equal(findDocumentRepairSource({ target: evicted.target, retained: [evicted.target, evicted.source], rect: RECT, layout: LAYOUT, blocked: () => false }), null);
  // unknown/遮挡盖住第二来源整框：拒。
  const blocked = ring();
  assert.equal(findDocumentRepairSource({ target: blocked.target, retained: blocked.retained, rect: RECT, layout: LAYOUT,
    blocked: (record, box) => record === blocked.third && box.top <= 4 && box.bottom >= 4 }), null);
  // 整框超过模板总点预算：拒。
  assert.equal(findDocumentRepairSource({ target: frames.target, retained: frames.retained, rect: { top: 0, bottom: 600, left: 0, right: 600 },
    layout: LAYOUT, blocked: () => false }), null);
  assert.equal(REPAIR_MAX_PIXELS, 262144);
});

test('整框双源查询：guard 抛错原样上抛，且不碰任何原帧字节', () => {
  const frames = ring();
  const before = [...frames.retained].map(record => Buffer.from(record.image.data).toString('base64'));
  const budget = new RangeError('遮挡分析超出预算');
  budget.code = 'analysis-budget';
  let calls = 0;
  assert.throws(() => findDocumentRepairSource({ target: frames.target, retained: frames.retained, rect: RECT, layout: LAYOUT,
    blocked: () => false, guard: () => { if (++calls === 2) throw budget; } }), error => error === budget);
  const after = [...frames.retained].map(record => Buffer.from(record.image.data).toString('base64'));
  assert.deepEqual(after, before, '核验抛错时不得改写任何原帧或目标');
});

// 已知局限：双整框相等只能说明两处来源字节相同，**不能单独证明框内是文档内容**。
// 这个用例钉住当前实际行为（接受），不是“会拒”的验收；调用方必须把它当实验性修补。
test('已知局限（当前会被接受，不得当成干净证明）：两处屏幕行压着同样的未识别固定 UI 时双整框仍一致', () => {
  const frames = ring();
  const paint = (record, top) => {
    for (let r = 0; r < 6; r++) for (let x = RECT.left; x < RECT.right; x++) {
      const i = ((top + r) * WIDTH + x) * 4;
      record.image.data[i] = 200; record.image.data[i + 1] = 40; record.image.data[i + 2] = 90; record.image.data[i + 3] = 255;
    }
  };
  // 两张来源的框在屏幕上分别落在 24..30 与 4..10（不同屏幕行），却压着同一块固定 UI；环区仍是真实正文。
  paint(frames.source, RECT.top + frames.target.offset - frames.source.offset);
  paint(frames.third, RECT.top + frames.target.offset - frames.third.offset);
  const source = findDocumentRepairSource({ target: frames.target, retained: frames.retained, rect: RECT, layout: LAYOUT, blocked: () => false });
  assert.equal(source, frames.source, '当前实现接受：两处来源字节相同但都可能是未识别固定 UI');
  assert.ok(frames.retained.includes(source));
});
