// 长截图核心（纯 JS 会话）性能基线：真实 createAutoScrollSession + 真实合成夹具。
//
// 目的：把「检查点是否真的贵」从先验变成可复现数据。这里只跑 core，不含 Electron renderer/Worker/GPU；
// 进程内存只是 Node 子进程口径，不能当整链峰值。真实 Worker/IPC 口径见 scripts/bench-longshot-worker.cjs。
//
// 用法：
//   单场景（独立子进程）：node scripts/bench-longshot-core.mjs --scene=small --budget=inf [--seed=0]
//   串行全跑（父进程按规模从小到大逐个子进程，每个有超时）：
//     node scripts/bench-longshot-core.mjs --all [--budget=inf] [--timeout=900] [--only=small,near16m]
//
// 口径：
// - checkpoint 只在生产 Worker 会要的时候调用：update.added > 0 或证据版本变化，且 update.complete，
//   且 update.height === update.capturedHeight。这里不重写一套近似判定，逐字照 renderer/scroll-match-worker.mjs。
// - 每次 checkpoint 返回的是新分配的整图 RGBA（compose 的独占副本）。累计字节 = 各次成功快照之和，
//   不等于同时驻留；同时驻留只算「成图 + 一张快照」。
// - analysisBudgetMs 默认 Infinity：本基线比的是算法成本，不受生产 4 秒预算截断干扰。
// - 大帧按需生成、用完即弃；常驻的只有 64 宽小夹具。
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '..');
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_SHA = createHash('sha256').update(fs.readFileSync(SCRIPT_PATH)).digest('hex');

// 视口宽 2119 与旧 20M 验收一致；小图用 1600 便于先验证链路。
// near16m/m24/near32m 走「每帧推进固定步长」，检查点频率随帧数线性增长；
// small-steps 用同样的小步长但更多帧，专门暴露「多次小增量接长」的重复整图复制。
const SCENARIOS = {
  small: { width: 1600, bodyHeight: 900, step: 96, count: 8, ball: null, note: '小图基线' },
  near16m: { width: 2119, bodyHeight: 1200, step: 160, count: 40, ball: null, note: '接近 16M 像素' },
  m24: { width: 2119, bodyHeight: 1200, step: 200, count: 52, ball: null, note: '约 24M 像素' },
  near32m: { width: 2119, bodyHeight: 1200, step: 240, count: 58, ball: null, note: '接近 32M 像素上限' },
  'small-steps': { width: 2119, bodyHeight: 1200, step: 40, count: 60, ball: null, note: '小增量多次接长（每帧都可能要检查点）' },
  'ball-resolved': { width: 2119, bodyHeight: 1200, step: 40, count: 60, ball: { radius: 6, centerX: 400 }, note: '固定遮挡小球，步长大于直径（有干净来源）' },
  'ball-dense': { width: 2119, bodyHeight: 1200, step: 20, count: 60, ball: { radius: 40, centerX: 400 }, note: '大遮挡、步长小于直径（未确认区压力）' },
  // 真固定物（浮层按钮）：屏幕坐标不变、遮住滚过的正文。前 10 帧存在、之后消失，
  // 用来覆盖「先有未确认证据 → 检查点被拒 → 修复帧补发检查点」这条路径。
  'fixed-cleared': { width: 2119, bodyHeight: 1200, step: 40, count: 60, overlay: { left: 300, top: 500, width: 120, height: 160, until: 10 }, note: '固定浮层前 10 帧存在后消失（证据先拒后修复）' },
  // 全程存在且点数超出遮挡模板预算：检查点永久被拒、complete 恒为 false，只用来量化「不产生检查点」这一侧的对照，
  // 不单独据此判定检查点便宜。
  'mask-budget': { width: 2119, bodyHeight: 1200, step: 40, count: 60, overlay: { left: 300, top: 300, width: 500, height: 700, until: null }, note: '固定浮层超预算（检查点持续被拒）' },
};

const sha = data => createHash('sha256').update(Buffer.from(data.buffer, data.byteOffset, data.byteLength)).digest('hex');
const round2 = value => Number(value.toFixed(2));
const mb = value => Math.round(value / 1048576);

// 夹具固定 64 宽：按列平铺到目标宽度，沿用现有夹具约定，不另写一套场景生成器。
function expand(image, width) {
  const height = image.height, data = new Uint8ClampedArray(width * height * 4), rowBytes = image.width * 4;
  for (let y = 0; y < height; y++) {
    const row = image.data.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let x = 0; x < width; x += image.width) {
      data.set(row.subarray(0, Math.min(image.width, width - x) * 4), (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

async function buildScene(def, seedOffset) {
  const { createScene } = await import(pathToFileURL(path.join(project, 'test/fixtures/auto-scenes.mjs')).href);
  const offsets = Array.from({ length: def.count }, (_, index) => index * def.step);
  const options = { top: 0, bottom: 0, bodyHeight: def.bodyHeight, offsets, seed: 20261104 + seedOffset };
  if (def.ball) Object.assign(options, {
    ball: 'ball', ballRadius: def.ball.radius, ballCenterX: def.ball.centerX, ballCenterY: null,
  });
  const base = createScene(options);
  const small = base.frames.map(frame => frame.image);
  let smallBytes = 0;
  for (const image of small) smallBytes += image.data.byteLength;
  return {
    width: def.width, height: def.bodyHeight, count: offsets.length, offsets, small,
    fixture: { smallFrames: small.length, smallBytes, smallWidth: small[0]?.width ?? 0 },
    frameAt(index) {
      const image = expand(small[index], def.width);
      if (def.overlay && (def.overlay.until === null || index < def.overlay.until)) {
        for (let y = def.overlay.top; y < def.overlay.top + def.overlay.height; y++) {
          for (let x = def.overlay.left; x < def.overlay.left + def.overlay.width; x++) {
            image.data.set([220, 24, 40, 255], (y * def.width + x) * 4);
          }
        }
      }
      return image;
    },
  };
}

function readMemory(target) {
  const usage = process.memoryUsage();
  for (const key of ['rss', 'heapUsed', 'external', 'arrayBuffers']) target[key] = Math.max(target[key], usage[key]);
  return usage;
}

async function runScene({ scene: name, budget, seedOffset, coreDir }) {
  const def = SCENARIOS[name];
  if (!def) throw new Error(`未知场景：${name}`);
  const coreRoot = path.resolve(project, coreDir ?? 'core');
  const { createAutoScrollSession } = await import(pathToFileURL(path.join(coreRoot, 'auto-scroll-session.mjs')).href);
  const scene = await buildScene(def, seedOffset);
  const analysisBudgetMs = budget === 'inf' ? Infinity : Number(budget);
  let first = scene.frameAt(0);
  const session = createAutoScrollSession(first, { analysisBudgetMs, maxBytes: first.data.byteLength * 4 });
  const memory = { rss: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
  const frames = [], checkpoints = [];
  let lastRevision = -1, checkpointWanted = 0, checkpointNull = 0, at = 0;
  let acceptTotalMs = 0, checkpointTotalMs = 0, error = null;
  let peakWithCheckpointBytes = 0;
  try {
    for (let index = 0; index < scene.count; index++) {
      let frame = index === 0 ? first : scene.frameAt(index);
      if (index === 0) first = null;
      at += 50;
      const started = performance.now();
      const update = session.accept(frame, at);
      const acceptMs = round2(performance.now() - started);
      acceptTotalMs += acceptMs;
      frame = null;
      readMemory(memory);
      const revisionChanged = update.autoEvidence?.evidenceRevision !== lastRevision;
      const wanted = (update.added > 0 || revisionChanged) && update.complete && update.height === update.capturedHeight;
      const row = { index, added: update.added, height: update.height, capturedHeight: update.capturedHeight,
        complete: Boolean(update.complete), kind: update.result?.kind ?? null,
        evidenceRevision: update.autoEvidence?.evidenceRevision ?? null,
        missing: update.autoEvidence?.missingRects?.length ?? null, unknown: update.autoEvidence?.unknownRects?.length ?? null,
        masks: update.autoEvidence?.maskCount ?? null, fixedStop: update.autoEvidence?.fixedStopReason ?? null,
        acceptMs };
      if (wanted) {
        checkpointWanted++;
        const startedCheckpoint = performance.now();
        const checkpoint = session.checkpoint();
        const ms = round2(performance.now() - startedCheckpoint);
        checkpointTotalMs += ms;
        if (checkpoint) {
          lastRevision = checkpoint.evidenceRevision;
          const bytes = checkpoint.width * checkpoint.height * 4;
          checkpoints.push({ frame: index, width: checkpoint.width, height: checkpoint.height,
            evidenceRevision: checkpoint.evidenceRevision, bytes, ms, sha: sha(checkpoint.data) });
          peakWithCheckpointBytes = Math.max(peakWithCheckpointBytes, bytes + update.height * def.width * 4);
        } else {
          checkpointNull++;
        }
      }
      frames.push(row);
    }
  } catch (thrown) {
    error = { code: thrown?.code ?? null, stage: thrown?.stage ?? null, message: thrown?.message ?? String(thrown) };
  }
  let output = null, finishMs = null;
  if (!error) {
    const started = performance.now();
    try {
      const result = session.finish();
      finishMs = round2(performance.now() - started);
      output = { sha: sha(result.data), width: result.width, height: result.height, complete: Boolean(result.complete),
        pixels: result.width * result.height, missingCount: result.missingRanges?.length ?? null,
        missingRanges: result.missingRanges ?? null, warning: result.warning ?? '',
        background: result.background ?? null };
    } catch (thrown) {
      error = { code: thrown?.code ?? null, stage: thrown?.stage ?? null, message: thrown?.message ?? String(thrown) };
    }
  }
  readMemory(memory);
  let counters = null;
  try { counters = session.counters(); } catch { counters = null; }
  session.clear?.();
  const checkpointBytes = checkpoints.reduce((sum, row) => sum + row.bytes, 0);
  const totalMs = acceptTotalMs + checkpointTotalMs + (finishMs ?? 0);
  return {
    kind: 'core-scene', generatedAt: new Date().toISOString(),
    script: { path: path.relative(project, SCRIPT_PATH), sha: SCRIPT_SHA },
    core: { dir: path.relative(project, coreRoot) || '.', files: Object.fromEntries(fs.readdirSync(coreRoot).sort()
      .filter(file => /\.(mjs|cjs|js)$/.test(file))
      .map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(coreRoot, file))).digest('hex')])) },
    node: process.version, platform: process.platform, arch: process.arch,
    scene: name, note: def.note, budget, analysisBudgetMs: Number.isFinite(analysisBudgetMs) ? analysisBudgetMs : null,
    params: { width: def.width, bodyHeight: def.bodyHeight, step: def.step, count: def.count, ball: def.ball ?? null, overlay: def.overlay ?? null },
    fixture: scene.fixture,
    expected: { finalHeight: def.bodyHeight + (def.count - 1) * def.step, pixels: def.width * (def.bodyHeight + (def.count - 1) * def.step) },
    frames, acceptTotalMs: round2(acceptTotalMs), finishMs,
    checkpoint: {
      wanted: checkpointWanted, produced: checkpoints.length, null: checkpointNull,
      bytes: checkpointBytes, bytesMB: mb(checkpointBytes), totalMs: round2(checkpointTotalMs),
      avgMs: checkpoints.length ? round2(checkpointTotalMs / checkpoints.length) : null,
      rows: checkpoints,
    },
    costShare: totalMs > 0 ? { checkpoint: round2(checkpointTotalMs / totalMs * 100), accept: round2(acceptTotalMs / totalMs * 100),
      finish: round2((finishMs ?? 0) / totalMs * 100) } : null,
    output, counters,
    memory: { sampledMax: memory, sampledMaxMB: Object.fromEntries(Object.entries(memory).map(([key, value]) => [key, mb(value)])),
      unit: 'bytes', note: 'Node 子进程 process.memoryUsage() 阶段采样最大值；不含 Electron renderer/Worker/GPU，不是整链峰值' },
    residency: { peakComposedPlusOneCheckpointMB: mb(peakWithCheckpointBytes),
      note: '成图 + 一张快照的同时驻留估算；累计复制字节不是峰值' },
    error,
  };
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) out[match[1]] = match[2];
    else if (arg.startsWith('--')) out[arg.slice(2)] = true;
  }
  return out;
}

function runAll(options) {
  const budget = options.budget ?? 'inf';
  const timeout = Number(options.timeout ?? 900) * 1000;
  const coreDir = options.core ?? 'core';
  const names = options.only ? String(options.only).split(',') : Object.keys(SCENARIOS);
  const report = { kind: 'core-suite', generatedAt: new Date().toISOString(), node: process.version,
    script: { path: path.relative(project, SCRIPT_PATH), sha: SCRIPT_SHA }, budget, core: coreDir, timeoutSeconds: timeout / 1000,
    order: names, scenes: [], aborted: null };
  for (const name of names) {
    const child = spawnSync(process.execPath, [SCRIPT_PATH, `--scene=${name}`, `--budget=${budget}`, `--core=${coreDir}`],
      { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout });
    const line = (child.stdout ?? '').split(/\r?\n/).filter(row => row.startsWith('RESULT ')).at(-1);
    if (!line) {
      report.scenes.push({ scene: name, ok: false, timedOut: child.error?.code === 'ETIMEDOUT' || child.signal != null,
        exitCode: child.status, stderrTail: (child.stderr ?? '').slice(-500) });
      // 超时/崩溃即视为资源边界：停止更大场景，不无限重试。
      report.aborted = { at: name, reason: child.error?.code === 'ETIMEDOUT' ? 'timeout' : 'no-result' };
      break;
    }
    const result = JSON.parse(line.slice('RESULT '.length));
    report.scenes.push({ ok: !result.error, ...result });
    console.log(`[${name}] frames=${result.frames.length} accept=${result.acceptTotalMs}ms finish=${result.finishMs}ms ` +
      `ckpt=${result.checkpoint.produced}/${result.checkpoint.wanted} null=${result.checkpoint.null} ` +
      `bytes=${result.checkpoint.bytesMB}MB ms=${result.checkpoint.totalMs} share=${result.costShare?.checkpoint}% ` +
      `out=${result.output ? `${result.output.width}x${result.output.height} complete=${result.output.complete}` : 'none'} ` +
      `rss=${result.memory.sampledMaxMB.rss}MB`);
  }
  const file = path.join(project, 'logs', `bench-longshot-core-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 1)}\n`);
  console.log(`REPORT ${file}`);
  if (report.aborted) process.exitCode = 2;
}

const options = parseArgs(process.argv.slice(2));
if (options.all) {
  runAll(options);
} else {
  const result = await runScene({ scene: options.scene ?? 'small', budget: options.budget ?? 'inf',
    seedOffset: Number(options.seed ?? 0), coreDir: options.core });
  console.log(`RESULT ${JSON.stringify(result)}`);
}
