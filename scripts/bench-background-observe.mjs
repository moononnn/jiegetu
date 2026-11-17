// 背景观察 A/B：同一批合成帧，分别喂给「基线版」和「改动版」的 core/background-model.mjs，
// 逐帧比较全部可观察字段，并给出多轮耗时。只测这一个函数，不碰会话、Worker 或采集。
//
// 用法：
//   node scripts/bench-background-observe.mjs --baseline=_backups/.../background-model.mjs \
//     [--live=core/background-model.mjs] [--rounds=3] [--reps=5] [--only=名字,名字]
//
// 口径：
// - 两个模块各自 import，输入帧完全相同；每次比较都用新建 model，避免状态互相污染。
// - 「可观察字段」= data/valid/streak/blocked/movingColumns/edgeColumns/edgeData 的 SHA-256、
//   validCount/blockedCount/observations、掩码 SHA-256、backgroundSummary/backgroundReady。
// - 计时只包住 observeBackground 调用，不含建帧与哈希；每轮 A/B 交替先后，给中位数与范围。
// - 合成帧按需生成、用完即弃；不采屏、不读剪贴板、不写用户目录。
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--([^=]+)=(.*)$/.exec(arg);
  return match ? [match[1], match[2]] : [arg.replace(/^--/, ''), true];
}));

const sha = (data, width, height) => createHash('sha256')
  .update(Buffer.from(data.buffer, data.byteOffset, width * height * (data.BYTES_PER_ELEMENT ?? 1)))
  .digest('hex').slice(0, 16);
const round2 = value => Number(value.toFixed(2));

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 合成一帧：纸张底色 + 随滚动移动的字形块 + 固定壁纸带 + 固定遮挡。
 * 壁纸带与遮挡只依赖屏幕坐标，因此两帧之间逐字节相同；字形块依赖 scroll，会移动。
 */
function makeFrame({ width, height, seed, scroll, glyph, paper, band, overlay }) {
  const data = new Uint8ClampedArray(width * height * 4);
  const rng = mulberry32(seed);
  const base = paper ?? [250, 249, 246];
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const index = row + x * 4;
      data[index] = base[0]; data[index + 1] = base[1]; data[index + 2] = base[2]; data[index + 3] = 255;
    }
  }
  // 字形块：按文档行 + 滚动位移决定位置，跨帧会移动；dense 时铺满整行。
  if (glyph) {
    const step = glyph.dense ? 4 : 26;
    for (let y = 0; y < height; y++) {
      const docRow = y + scroll;
      const rowSeed = mulberry32(seed + docRow * 7919);
      for (let x = glyph.margin; x < width - glyph.margin; x += step) {
        if (rowSeed() < (glyph.dense ? 0.45 : 0.06)) {
          const shade = 20 + Math.floor(rowSeed() * 80);
          const index = (y * width + x) * 4;
          data[index] = shade; data[index + 1] = shade + 6; data[index + 2] = shade + 12; data[index + 3] = 255;
        }
      }
    }
  }
  // 固定壁纸带：只依赖屏幕坐标，跨帧完全相同，带内缓变纹理。
  if (band) {
    for (const side of ['left', 'right']) {
      const from = side === 'left' ? 0 : width - band.width;
      const to = side === 'left' ? band.width : width;
      for (let x = from; x < to; x++) {
        for (let y = 0; y < height; y++) {
          const index = (y * width + x) * 4;
          const v = 40 + 30 * Math.sin(y / 17 + band.phase) + 18 * Math.sin(y / 5.3 + x / 3);
          data[index] = 120 + v / 4; data[index + 1] = 100 + v / 3; data[index + 2] = 80 + v / 2; data[index + 3] = 255;
        }
      }
    }
  }
  // 固定遮挡：屏幕坐标不变，跨帧相同；颜色由 overlay.color 决定。
  if (overlay) {
    for (let y = overlay.top; y < overlay.top + overlay.height; y++) {
      for (let x = overlay.left; x < overlay.left + overlay.width; x++) {
        const index = (y * width + x) * 4;
        data[index] = overlay.color[0]; data[index + 1] = overlay.color[1]; data[index + 2] = overlay.color[2]; data[index + 3] = 255;
      }
    }
  }
  return { width, height, data };
}

const SMALL = { width: 1600, height: 900 };
const PROD = { width: 2119, height: 1200 };

// 覆盖：纯色多数行、密集文字、固定壁纸、移动前景、边缘、上接长、遮挡/预算退让。
const SCENARIOS = [
  { name: 'paper-solid', size: SMALL, glyph: { margin: 120, dense: false }, band: null, overlay: null,
    scrolls: [0, 40, 80, 40], bandSpec: null, note: '纯色多数行（纸张占多数，只有稀疏字块）' },
  { name: 'paper-dense', size: SMALL, glyph: { margin: 40, dense: true }, band: null, overlay: null,
    scrolls: [0, 24, 48, 72], bandSpec: null, note: '密集文字纹理' },
  { name: 'wallpaper-static', size: SMALL, glyph: { margin: 260, dense: false }, band: { width: 90, phase: 0 }, overlay: null,
    scrolls: [0, 40, 80, 120], bandSpec: null, note: '左右固定壁纸带 + 移动正文' },
  { name: 'moving-foreground', size: SMALL, glyph: { margin: 120, dense: false }, band: null,
    overlay: { left: 400, top: 300, width: 420, height: 320, color: [220, 30, 40], shift: 60 },
    scrolls: [0, 40, 80, 40], bandSpec: null, note: '移动前景块（每帧换屏幕位置）' },
  { name: 'edges-intrude', size: SMALL, glyph: { margin: 260, dense: false }, band: { width: 70, phase: 1.7 }, overlay: null,
    scrolls: [0, 32, 64, 96], bandSpec: null, edgeIntrude: true, note: '壁纸带被正文侵入，边缘列应退出' },
  { name: 'upward-band', size: SMALL, glyph: { margin: 260, dense: false }, band: { width: 90, phase: 0.9 }, overlay: null,
    scrolls: [0, 30, 60, 90], bandSpec: { start: 0, rows: 300 }, note: '向上接长（band 在顶部）' },
  { name: 'occlusion-blocked', size: SMALL, glyph: { margin: 260, dense: false }, band: { width: 90, phase: 2.3 },
    overlay: { left: 500, top: 260, width: 360, height: 380, color: [18, 22, 30], conflictAt: 2 },
    scrolls: [0, 36, 72, 108], bandSpec: null, note: '壁纸带先被学成背景，再被同坐标异色覆盖（停用路径）' },
  { name: 'paper-prod', size: PROD, glyph: { margin: 60, dense: true }, band: null, overlay: null,
    scrolls: [0, 40, 80, 120], bandSpec: null, note: '生产帧面积（2119×1200）密集文字' },
  { name: 'wallpaper-prod', size: PROD, glyph: { margin: 260, dense: false }, band: { width: 100, phase: 0.4 }, overlay: null,
    scrolls: [0, 40, 80, 120], bandSpec: { start: 900, rows: 300 }, note: '生产帧面积 + 壁纸带（对照组）' },
];

function buildFrames(scenario) {
  const { width, height } = scenario.size;
  return scenario.scrolls.map((scroll, index) => {
    const overlay = scenario.overlay && (!scenario.overlay.conflictAt || index >= scenario.overlay.conflictAt)
      ? { ...scenario.overlay,
        left: scenario.overlay.left + (scenario.overlay.shift ? index * scenario.overlay.shift : 0),
        color: scenario.overlay.conflictAt ? [200, 180, 20] : scenario.overlay.color }
      : null;
    const frame = makeFrame({ width, height, seed: 20261104, scroll, glyph: scenario.glyph, band: scenario.band, overlay });
    if (scenario.edgeIntrude && index === scenario.framesIntrudeAt) {
      // 在壁纸带内画一条竖向文字，模拟正文侵入，触发 edgeColumns 退出。
      for (let y = 200; y < 700; y++) {
        const x = 20;
        const value = (y * 37) % 255;
        const index = (y * width + x) * 4;
        frame.data[index] = value; frame.data[index + 1] = 255 - value; frame.data[index + 2] = 40; frame.data[index + 3] = 255;
      }
    }
    return frame;
  });
}

function snapshot(mod, model, mask) {
  return {
    data: sha(model.data, model.width, model.height),
    valid: sha(model.valid, model.width, model.height),
    streak: sha(model.streak, model.width, model.height),
    blocked: sha(model.blocked, model.width, model.height),
    movingColumns: sha(model.movingColumns, model.width, 1),
    edgeColumns: sha(model.edgeColumns, model.width, 1),
    edgeData: model.edgeData ? sha(model.edgeData, model.width, model.height) : null,
    validCount: model.validCount, blockedCount: model.blockedCount, observations: model.observations,
    mask: mask ? sha(mask, model.width, 1) : null,
    summary: mod.backgroundSummary(model), ready: mod.backgroundReady(model),
  };
}

function runSequence(mod, scenario, frames) {
  const { width, height } = scenario.size;
  const model = mod.createBackgroundModel(width, height);
  const steps = [];
  let budgetCalls = 0;
  const checkBudget = () => { budgetCalls++; };
  for (let index = 0; index < frames.length - 1; index++) {
    const mask = mod.observeBackground(model, frames[index], frames[index + 1], scenario.bandSpec, checkBudget);
    steps.push(snapshot(mod, model, mask));
  }
  return { steps, budgetCalls };
}

function timeSequence(mod, scenario, frames) {
  const { width, height } = scenario.size;
  const model = mod.createBackgroundModel(width, height);
  const started = performance.now();
  for (let index = 0; index < frames.length - 1; index++) {
    mod.observeBackground(model, frames[index], frames[index + 1], scenario.bandSpec, null);
  }
  return performance.now() - started;
}

const stats = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pick = q => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
  return { n: sorted.length, min: round2(sorted[0]), p50: round2(pick(0.5)), max: round2(sorted.at(-1)) };
};

async function main() {
  const baselinePath = path.resolve(project, args.baseline);
  const livePath = path.resolve(project, args.live ?? 'core/background-model.mjs');
  const A = await import(pathToFileURL(baselinePath).href);
  const B = await import(pathToFileURL(livePath).href);
  const rounds = Number(args.rounds ?? 3), reps = Number(args.reps ?? 5);
  const names = args.only ? String(args.only).split(',') : SCENARIOS.map(row => row.name);
  const report = {
    kind: 'background-observe-ab', generatedAt: new Date().toISOString(), node: process.version,
    baseline: path.relative(project, baselinePath), live: path.relative(project, livePath),
    baselineSha: createHash('sha256').update(fs.readFileSync(baselinePath)).digest('hex'),
    liveSha: createHash('sha256').update(fs.readFileSync(livePath)).digest('hex'),
    rounds, reps, forcedGc: typeof global.gc === 'function',
    note: '计时只包 observeBackground；A/B 每轮交替先后；合成帧用完即弃',
    scenarios: [], mismatch: [],
  };
  for (const scenario of SCENARIOS.filter(row => names.includes(row.name))) {
    if (scenario.edgeIntrude) scenario.framesIntrudeAt = 2;
    const frames = buildFrames(scenario);
    const a = runSequence(A, scenario, frames);
    const b = runSequence(B, scenario, frames);
    const differences = [];
    for (let index = 0; index < a.steps.length; index++) {
      const left = JSON.stringify(a.steps[index]), right = JSON.stringify(b.steps[index]);
      if (left !== right) differences.push({ frame: index, a: a.steps[index], b: b.steps[index] });
    }
    if (a.budgetCalls !== b.budgetCalls) differences.push({ budgetCalls: { a: a.budgetCalls, b: b.budgetCalls } });
    // 预热一次，随后多轮交替计时。
    timeSequence(A, scenario, frames); timeSequence(B, scenario, frames);
    const timesA = [], timesB = [];
    for (let round = 0; round < rounds; round++) {
      const order = round % 2 === 0 ? ['A', 'B'] : ['B', 'A'];
      for (let rep = 0; rep < reps; rep++) {
        for (const side of order) {
          global.gc?.();
          const ms = side === 'A' ? timeSequence(A, scenario, frames) : timeSequence(B, scenario, frames);
          (side === 'A' ? timesA : timesB).push(ms);
        }
      }
    }
    const aStats = stats(timesA), bStats = stats(timesB);
    const changePct = aStats.p50 > 0 ? round2((bStats.p50 - aStats.p50) / aStats.p50 * 100) : null;
    const row = { scenario: scenario.name, note: scenario.note, width: scenario.size.width, height: scenario.size.height,
      frames: frames.length, pixels: scenario.size.width * scenario.size.height, differences: differences.length,
      equivalent: differences.length === 0, budgetCalls: a.budgetCalls,
      a: aStats, b: bStats, medianChangePct: changePct };
    report.scenarios.push(row);
    if (differences.length) report.mismatch.push({ scenario: scenario.name, differences: differences.slice(0, 3) });
    console.log(`[${scenario.name}] equal=${row.equivalent} budgetCalls=${a.budgetCalls} A p50=${aStats.p50} B p50=${bStats.p50} change=${changePct}%`);
  }
  report.ok = report.mismatch.length === 0;
  const file = path.join(project, 'logs', `bench-background-observe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 1)}\n`);
  console.log(`REPORT ${file}`);
  if (!report.ok) process.exitCode = 1;
}

await main();
