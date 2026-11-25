'use strict';
// Experimental offline backend. Callers must supply independently verified absolute binaries;
// this module never discovers or downloads executables. Not wired into the application.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { inspectContainer, validateOutput } = require('../core/video-session.mjs');
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_SPANS = 25;   // 24 个内部删除区间 = 最多 25 段保留
// 固定代码：界面只认这些码，不解析原始报错、不带路径或 stderr。
const EXPORT_ERROR_CODES = [
  [/^导出已取消$/, 'export-aborted'],
  [/^(媒体工具|媒体信息无效|导出超时|导出诊断输出过大|媒体工具必须)/, 'export-tool'],
  [/^音频/, 'export-audio'],
  [/^(视频|轨道|容器起始|音视频轨道时长)/, 'export-timing'],
  [/^(保留片段|剪辑计划|输入|需要绝对路径的私有临时目录)/, 'export-input'],
  [/^(导出结果|导出编码|缺少 AVC|AVC)/, 'export-encoder'],
];
function classifyExportError(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  for (const [pattern, code] of EXPORT_ERROR_CODES) if (pattern.test(message)) return code;
  return 'export-failed';
}
// 时间轴守卫的固定子码白名单：仅用于诊断区分拒绝来源，不改任何阈值或修复行为。
// 界面与生命周期日志只认这些子码；总码（export-timing / export-audio 等）仍由 classifyExportError 决定。
const TIMING_SUBCODES = Object.freeze([
  'packets-unverifiable', 'track-start-missing', 'video-frame-interval-short', 'audio-packet-overlap',
  'video-gap-large', 'audio-gap-large', 'audio-gap-cumulative', 'track-end-short',
  'audio-timebase-unverifiable', 'audio-frames-unverifiable', 'audio-timebase-precision', 'audio-frame-start',
  'audio-frame-gap-overlap', 'audio-frame-drift-cumulative', 'audio-overlap-rate', 'audio-frame-end-short',
  'container-start', 'av-duration-mismatch', 'track-span',
]);
const TIMING_SUBCODE_SET = new Set(TIMING_SUBCODES);
const TIMING_METRIC_KEYS = ['rows', 'video', 'firstPtsMs', 'startMs', 'intervalMs', 'overlapMs', 'gapMs',
  'totalGapMs', 'largeGaps', 'endMs', 'requiredEndMs', 'rate', 'deltaMs', 'roundingOverlapMs', 'overlapCount', 'diffMs', 'streamEndMs'];
// Only fixed names and coarse numeric values may cross into the log or renderer.
function coarseTimingMetrics(metrics) {
  const out = {};
  if (metrics && typeof metrics === 'object') for (const key of TIMING_METRIC_KEYS) {
    const value = Object.hasOwn(metrics, key) ? metrics[key] : undefined;
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = Math.round(value);
  }
  return out;
}
// 保留原消息（总码不变），额外挂白名单子码与净化后的数值指标；子码不在白名单则不挂。
function timingReject(message, subcode, metrics) {
  const error = new Error(message);
  if (TIMING_SUBCODE_SET.has(subcode)) { error.subcode = subcode; error.metrics = coarseTimingMetrics(metrics); }
  return error;
}
// 主生命周期失败处只取白名单子码 + 净化数值指标；未知子码/非数值一律丢弃，防原始报错与私有 metadata 外泄。
function timingDiagnostics(error) {
  const subcode = typeof error?.subcode === 'string' && TIMING_SUBCODE_SET.has(error.subcode) ? error.subcode : undefined;
  if (!subcode) return {};
  return { subcode, metrics: coarseTimingMetrics(error?.metrics) };
}
const MAX_DIAGNOSTIC = 1024 * 1024;

// —— 候选路径：显式输出 PTS 排程 ——
// 仅内部工厂选项 timeline:'explicit-pts' 可开（渲染层/IPC 只能传 original/plan/signal，无法开启）。
// 只接管两种已知真 VFR 形态：>100ms 显示空洞、<1/60 近帧；其余输入与默认路径逐字一致。
const PTS_MATCH_TOLERANCE_MS = 2;    // 输出帧 pts 与排程的允许偏差（毫秒）
// 候选回落时附带的诊断键（固定白名单，值只能是有限数字）。
const CANDIDATE_METRIC_KEYS = Object.freeze(['candidateDisabled']);
function markCandidateDisabled(error) {
  if (!error || typeof error !== 'object') return error;
  const metrics = { ...(error.metrics || {}) };
  for (const key of CANDIDATE_METRIC_KEYS) metrics[key] = 1;
  error.metrics = metrics;
  return error;
}

// 按解码帧 pts 与半开保留段排定输出帧 pts：carry-in 落在段偏移，其余映射到 O+(srcPTS-S)。
function planExplicitPts(spans, frames) {
  const carryIn = spans.map(s => { let c = frames[0]; for (const p of frames) if (p <= s.startMs / 1000 + 1e-6) c = p; return c; });
  let acc = 0; const offsets = spans.map(s => { const o = acc / 1000; acc += s.endMs - s.startMs; return o; });
  const schedule = [];
  let lastSourcePts = null;
  for (const p of frames) {
    let idx = -1;
    for (let i = 0; i < spans.length; i++) if (p >= carryIn[i] - 1e-9 && p < spans[i].endMs / 1000 - 1e-9) { idx = i; break; }
    if (idx < 0) continue;                      // 落在剪除区里的帧不输出
    const s = spans[idx];
    schedule.push(p <= s.startMs / 1000 + 1e-6 ? offsets[idx] : offsets[idx] + (p - s.startMs / 1000));
    lastSourcePts = p;
  }
  return { carryIn, offsets, schedule, totalMs: acc, lastSourcePts };
}

// 单次 select+setpts：不用 concat ⇒ 没有“帧推导段长”，输出时间戳就是排程本身。
// 音频走自己的采样时钟（aselect+asetpts），不与视频 pts 绑定；音频校验与尾部补齐策略不变。
function explicitPtsFilters(spans, carryIn, offsets, audio, repairAudio, padAudioTail, tailPadMs) {
  const sec = v => v.toFixed(3);
  const sel = spans.map((s, i) => `gte(t\\,${sec(carryIn[i])})*lt(t\\,${sec(s.endMs / 1000)})`).join('+');
  let reb = 'T';
  for (let i = spans.length - 1; i >= 0; i--) {
    const S = sec(spans[i].startMs / 1000), E = sec(spans[i].endMs / 1000), C = sec(carryIn[i]), O = sec(offsets[i]);
    reb = `if(gte(T\\,${C})*lt(T\\,${E}),if(lte(T\\,${S}),${O},${O}+T-${S}),${reb})`;
  }
  const parts = [`[0:v:0]select='${sel}',setpts='${reb}/TB'[vout]`];
  if (audio) {
    const selA = spans.map(s => `gte(t\\,${sec(s.startMs / 1000)})*lt(t\\,${sec(s.endMs / 1000)})`).join('+');
    let rebA = 'T';
    for (let i = spans.length - 1; i >= 0; i--) {
      const S = sec(spans[i].startMs / 1000), E = sec(spans[i].endMs / 1000), O = sec(offsets[i]);
      rebA = `if(gte(T\\,${S})*lt(T\\,${E}),${O}+T-${S},${rebA})`;
    }
    const pre = `${repairAudio ? 'aresample=async=1:first_pts=0:min_hard_comp=0.00001,' : ''}${padAudioTail ? `apad=pad_dur=${sec(tailPadMs / 1000)},` : ''}`;
    parts.push(`[0:a:0]${pre}aselect='${selA}',asetpts='${rebA}/TB'[aout]`);
  }
  return parts.join(';');
}


function runProcess(executable, args, { signal, timeoutMs = 120000, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('导出已取消'));
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd, env });
    const stdout = [], stderr = []; let outSize = 0, errSize = 0, failure;
    const stop = message => { failure ||= new Error(message); child.kill(); };
    const onAbort = () => stop('导出已取消');
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timer = setTimeout(() => stop('导出超时'), timeoutMs);
    const collect = (list, name) => chunk => {
      if (name === 'out') outSize += chunk.length; else errSize += chunk.length;
      if (outSize + errSize > MAX_DIAGNOSTIC) return stop('导出诊断输出过大');
      list.push(chunk);
    };
    child.stdout.on('data', collect(stdout, 'out')); child.stderr.on('data', collect(stderr, 'err'));
    child.on('error', e => { if (e && !e.code) e.code = 'export-tool'; failure ||= e; });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`媒体工具失败（退出码 ${code}）`));
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

function validateSpans(spans) {
  if (!Array.isArray(spans) || spans.length < 1 || spans.length > MAX_SPANS) throw new Error('保留片段数量无效');
  let previous = -1;
  return spans.map(s => {
    if (!Number.isSafeInteger(s?.startMs) || !Number.isSafeInteger(s?.endMs) || s.startMs < 0 || s.endMs <= s.startMs || s.startMs < previous || s.endMs > 60000) throw new Error('保留片段范围无效');
    previous = s.endMs;
    return { startMs: s.startMs, endMs: s.endMs };
  });
}
const sec = ms => (ms / 1000).toFixed(3);
const numeric = value => typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
const AUDIO_TAIL_PAD_MS = 80;
function filters(spans, audio, repairAudio, padAudioTail, tailPadMs) {
  const parts = [];
  for (const [i, s] of spans.entries()) {
    parts.push(`[0:v:0]fps=fps=60:round=up,trim=start=${sec(s.startMs)}:end=${sec(s.endMs)},setpts=PTS-${sec(s.startMs)}/TB,pad=ceil(iw/2)*2:ceil(ih/2)*2[v${i}]`);
    if (audio) {
      const pad = padAudioTail && i === spans.length - 1 ? `apad=pad_dur=${sec(tailPadMs)},` : '';
      parts.push(`[0:a:0]${repairAudio ? 'aresample=async=1:first_pts=0:min_hard_comp=0.00001,' : ''}${pad}atrim=start=${sec(s.startMs)}:end=${sec(s.endMs)},asetpts=PTS-${sec(s.startMs)}/TB[a${i}]`);
    }
  }
  const inputs = spans.map((_, i) => `[v${i}]${audio ? `[a${i}]` : ''}`).join('');
  parts.push(`${inputs}concat=n=${spans.length}:v=1:a=${audio ? 1 : 0}[vout]${audio ? '[aout]' : ''}`);
  return parts.join(';');
}

// A video packet gap of at most 100 ms is held on the preceding displayed frame.
// Audio gaps have strict per-gap and cumulative budgets; delayed starts and missing timestamps remain unsupported.
// 一次校验：默认（relaxVideoShape=false）行为逐字不变；候选路径只放宽“视频形态”两扇门
// （>100ms 显示空洞、<1/60 近帧），其余时序与覆盖检查（起点、间隙、累计、末尾、有限且正长的包）
// 全部照旧执行——放宽后继续走完所有剩余包行，绝不在第一次形态拒绝后就回落。
function inspectPackets(csv, startMs, endMs, video, relaxVideoShape = false) {
  const rows = csv.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const [p, d] = line.split(',');
    return [p?.trim() ? Number(p) : NaN, d?.trim() ? Number(d) : NaN];
  }).sort((a, b) => a[0] - b[0]);
  if (!rows.length || rows.length > 60000 || rows.some(([p,d]) => !Number.isFinite(p) || !Number.isFinite(d) || d <= 0)) throw timingReject('轨道时间戳不可验证', 'packets-unverifiable', { rows: rows.length });
  // 候选路径还要求帧时间戳有限且严格递增（重复 pts 视为元数据不一致，不进候选）。
  if (relaxVideoShape) for (let i = 1; i < rows.length; i++) if (!(rows[i][0] > rows[i - 1][0])) throw timingReject('轨道时间戳不可验证', 'packets-unverifiable', { rows: rows.length });
  let end = rows[0][0] + rows[0][1], previousPts = rows[0][0];
  let totalGap = 0, largeGaps = 0, repairAudio = false, relaxedGap = 0, relaxedInterval = 0;
  const label = video ? '视频' : '音频';
  if (rows[0][0] > startMs / 1000 + 0.002) throw timingReject(`${label}轨道起点缺失`, 'track-start-missing', { video: video ? 1 : 0, firstPtsMs: rows[0][0] * 1000, startMs });
  for (const [p,d] of rows.slice(1)) {
    // 60 Hz can hold a previous frame, but must not silently drop denser source frames.
    if (video && p - previousPts < 1 / 60 - 0.000001) {
      if (!relaxVideoShape) throw timingReject('视频帧间隔过短', 'video-frame-interval-short', { video: 1, intervalMs: (p - previousPts) * 1000 });
      relaxedInterval++;
    }
    const gap = p - end;
    if (!video && gap < -0.002001) throw timingReject('音频包时间重叠不支持', 'audio-packet-overlap', { overlapMs: -gap * 1000 });
    if (!video && gap < -0.00001) repairAudio = true;
    if (gap > (video ? 0.100001 : 0.006001)) {
      if (!relaxVideoShape) throw timingReject(`${label}时间间隙过大`, video ? 'video-gap-large' : 'audio-gap-large', { video: video ? 1 : 0, gapMs: gap * 1000 });
      relaxedGap++;
    }
    if (!video && gap > 0) {
      totalGap += gap;
      if (gap > 0.00001) repairAudio = true;
      if (gap > 0.002) largeGaps++;
      if (totalGap > 0.030001 || largeGaps > 8) throw timingReject('音频时间间隙累计过大', 'audio-gap-cumulative', { totalGapMs: totalGap * 1000, largeGaps });
    }
    end = Math.max(end, p + d); previousPts = p;
  }
  if (end + 0.002 < endMs / 1000) throw timingReject(`${label}轨道末尾不足`, 'track-end-short', { video: video ? 1 : 0, endMs: end * 1000, requiredEndMs: endMs });
  return { repairAudio, relaxedGap, relaxedInterval };
}
function validatePackets(csv, startMs, endMs, video) { return inspectPackets(csv, startMs, endMs, video, false).repairAudio; }

// Packet durations can differ from decoded sample counts. Allow only measured
// one-sample overlaps, with strict total/rate budgets; reject ambiguous skew.
function validateAudioFrames(csv, stream, endMs, softwareAudioTiming) {
  const rate = numeric(stream.sample_rate);
  const match = /^(\d+)\/(\d+)$/.exec(stream.time_base || '');
  const num = Number(match?.[1]), den = Number(match?.[2]);
  if (!Number.isSafeInteger(rate) || rate < 8000 || rate > 192000 || !Number.isSafeInteger(num) || num < 1 || !Number.isSafeInteger(den) || den < 1) throw timingReject('音频时间基准不可验证', 'audio-timebase-unverifiable', { rate });
  const rows = csv.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const [pts, count] = line.split(',');
    return [pts?.trim() ? Number(pts) : NaN, count?.trim() ? Number(count) : NaN];
  });
  if (!rows.length || rows.length > 60000 || rows.some(([pts, count]) => !Number.isSafeInteger(pts) || !Number.isSafeInteger(count) || count < 1 || count > 8192)) throw timingReject('音频帧时间戳不可验证', 'audio-frames-unverifiable', { rows: rows.length });
  if (num / den > 1 / rate + 1e-12) throw timingReject('音频时间基准精度不足', 'audio-timebase-precision', { rate });
  let end = 0, totalGap = 0, roundingOverlap = 0, overlapCount = 0, largeGaps = 0, pauseOverlap = 0;
  for (const [index, [pts, count]] of rows.entries()) {
    const time = pts * num / den, delta = time - end;
    if (index === 0 && Math.abs(time) > 0.00001) throw timingReject('音频帧起点不支持', 'audio-frame-start', { startMs: time * 1000 });
    if (!Number.isFinite(time) || delta > (softwareAudioTiming ? 0.008001 : 0.006001)) throw timingReject('音频帧时间间隙或重叠不支持', 'audio-frame-gap-overlap', { deltaMs: delta * 1000 });
    if (delta > 0) { totalGap += delta; if (delta > 0.002) largeGaps++; }
    else if (-delta * rate > 0.5) {
      if (Math.abs(-delta * rate - 1) > 0.05 &&
          (!softwareAudioTiming || -delta > 0.001201 || ++pauseOverlap > 1)) throw timingReject('音频帧时间间隙或重叠不支持', 'audio-frame-gap-overlap', { deltaMs: delta * 1000 });
      overlapCount += Math.round(-delta * rate);
    } else roundingOverlap -= delta;
    if (totalGap > 0.030001 || roundingOverlap > 0.00001 || overlapCount / rate > 0.050001 || largeGaps > 8) throw timingReject('音频帧时间偏差累计过大', 'audio-frame-drift-cumulative', { totalGapMs: totalGap * 1000, roundingOverlapMs: roundingOverlap * 1000, overlapCount, largeGaps, rate });
    end = time + count / rate;
  }
  if (overlapCount > Math.ceil(Math.max(1, end) * 40)) throw timingReject('音频帧重叠频率过高', 'audio-overlap-rate', { overlapCount, endMs: end * 1000 });
  if (end + 0.002 < endMs / 1000) throw timingReject('音频帧末尾不足', 'audio-frame-end-short', { endMs: end * 1000, requiredEndMs: endMs });
  return totalGap > 0 || overlapCount > 0;
}

function avcMime(stream, audio) {
  const line = /^00000000:\s*([0-9a-f]{4})\s+([0-9a-f]{4})/im.exec(stream.extradata || '');
  if (!line) throw new Error('缺少 AVC 编码配置');
  const header = (line[1] + line[2]).toLowerCase();
  if (!header.startsWith('01')) throw new Error('AVC 编码配置无效');
  return `video/mp4;codecs=avc1.${header.slice(2)}${audio ? ',mp4a.40.2' : ''}`;
}

// 候选前置条件：源必须能完整解码、覆盖有效、时间戳已知且与包时间戳一致。
// 任一条不满足 ⇒ 候选保持关闭（返回 null），落回默认路径自己的拒绝，诊断码与默认完全一致。
async function buildExplicitPtsCandidate({ run, ffmpegPath, ffprobePath, inputFormat, source, packetCsv, spans, requiredEndMs, options }) {
  try { await run(ffmpegPath, ['-v', 'error', '-xerror', '-nostdin', '-protocol_whitelist', 'file,pipe', '-f', inputFormat, '-i', source, '-map', '0:v:0', '-f', 'null', '-'], options); }
  catch { return null; }
  const csv = (await run(ffprobePath, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', inputFormat, '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', source], options)).stdout;
  const frames = csv.trim().split(/\r?\n/).filter(Boolean).map(l => Number(l.split(',')[0])).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  if (!frames.length) return null;
  // 解码帧时间戳必须有限且严格递增。
  for (let i = 1; i < frames.length; i++) if (!(frames[i] > frames[i - 1])) return null;
  const decodedEndMs = frames[frames.length - 1] * 1000;
  if (decodedEndMs + 40 < requiredEndMs) return null;
  const packets = packetCsv.trim().split(/\r?\n/).filter(Boolean).map(l => { const [p, d] = l.split(','); return [Number(p), Number(d)]; }).filter(r => Number.isFinite(r[0]) && Number.isFinite(r[1])).sort((a, b) => a[0] - b[0]);
  // 时间戳已知：解码帧与包一一对应且时间戳一致；否则元数据不一致 ⇒ 保持关闭。
  if (packets.length !== frames.length) return null;
  for (let i = 0; i < frames.length; i++) if (Math.abs(packets[i][0] - frames[i]) * 1000 > 2) return null;
  const plan = planExplicitPts(spans, frames);
  // 末尾时长用“最后一个被排入输出的帧”对应的那个包的时长，不用全局最大包长。
  const lastPacket = packets.find(r => Math.abs(r[0] - plan.lastSourcePts) * 1000 <= 2);
  if (!lastPacket) return null;
  return { ...plan, decodedEndMs, lastFrameDurationMs: Math.round(lastPacket[1] * 1000) };
}

// 候选输出校验：必须能解码；帧时间戳须与排程一致（接缝处映射精确）；时长须落在实际解码/包时间给出的范围内。
async function verifyExplicitPtsOutput({ run, ffmpegPath, ffprobePath, output, candidate, expectedTotalMs, audio, spanCount, options }) {
  try { await run(ffmpegPath, ['-v', 'error', '-xerror', '-nostdin', '-protocol_whitelist', 'file,pipe', '-f', 'mp4', '-i', output, '-f', 'null', '-'], options); }
  catch { throw new Error('导出编码或轨道不匹配'); }
  const csv = (await run(ffprobePath, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', 'mp4', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', output], options)).stdout;
  const actual = csv.trim().split(/\r?\n/).filter(Boolean).map(l => Number(l.split(',')[0])).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  if (actual.length !== candidate.schedule.length) throw new Error('导出编码或轨道不匹配');
  let maxDeltaMs = 0;
  for (let i = 0; i < actual.length; i++) maxDeltaMs = Math.max(maxDeltaMs, Math.abs(actual[i] - candidate.schedule[i]) * 1000);
  if (maxDeltaMs > PTS_MATCH_TOLERANCE_MS) throw new Error('导出编码或轨道不匹配');
  const info = JSON.parse((await run(ffprobePath, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', 'mp4', '-show_entries', 'format=duration:stream=codec_type,duration', '-of', 'json', output], options)).stdout);
  const vDurMs = Number(info.streams.find(s => s.codec_type === 'video')?.duration) * 1000;
  // 期望末尾 = 最后一个匹配到的解码帧的输出 pts + 该帧对应包的时长。
  const expectedVideoMs = candidate.schedule[candidate.schedule.length - 1] * 1000 + candidate.lastFrameDurationMs;
  if (!Number.isFinite(vDurMs) || Math.abs(vDurMs - expectedVideoMs) > 40 + candidate.lastFrameDurationMs) throw new Error('导出编码或轨道不匹配');
  // 与保留计划不得有重大偏差（不得远短/远长于应保留的时长）。
  if (Math.abs(vDurMs - expectedTotalMs) > 60 + candidate.lastFrameDurationMs) throw new Error('导出编码或轨道不匹配');
  if (audio) {
    // 音频边界量化在一帧 AAC（≤25ms）内，尾部补齐上限 AUDIO_TAIL_PAD_MS；超出即视为行为不可界定。
    const aDurMs = Number(info.streams.find(s => s.codec_type === 'audio')?.duration) * 1000;
    if (!Number.isFinite(aDurMs) || Math.abs(aDurMs - expectedTotalMs) > spanCount * 25 + AUDIO_TAIL_PAD_MS) throw new Error('导出编码或轨道不匹配');
  }
}

function createVideoExporter({ ffmpegPath, ffprobePath, scratchRoot, run = runProcess, timeoutMs = 120000, timeline = 'packet', softwareAudioTiming = false } = {}) {
  for (const p of [ffmpegPath, ffprobePath]) if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('媒体工具必须使用已验证的绝对路径');
  if (typeof run !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('导出配置无效');
  if (typeof scratchRoot !== 'string' || !path.isAbsolute(scratchRoot)) throw new Error('需要绝对路径的私有临时目录');
  if ((timeline !== 'packet' && timeline !== 'explicit-pts') || typeof softwareAudioTiming !== 'boolean') throw new Error('导出配置无效');
  return async function exportVideo(request = {}) {
    try {
      return await runExport(request);
    } catch (error) {
      if (error && typeof error === 'object' && !error.code) error.code = classifyExportError(error);
      throw error;
    }
  };
  async function runExport({ original, plan, signal } = {}) {
    if (!(original?.bytes instanceof Uint8Array) || !original.bytes.length || original.bytes.length > MAX_BYTES || typeof original.hasAudio !== 'boolean') throw new Error('输入视频无效或音频状态不明');
    const input = Buffer.from(original.bytes);
    let segments = validateSpans(plan?.ranges);
    if (!Number.isSafeInteger(plan?.durationMs) || plan.durationMs < segments.at(-1).endMs || plan.durationMs > 60000 ||
        !Number.isSafeInteger(plan.totalMs) || plan.totalMs !== segments.reduce((n, s) => n + s.endMs - s.startMs, 0)) throw new Error('剪辑计划无效');
    let totalMs = plan.totalMs;
    const mp4 = inspectContainer(input, 'mp4'), webm = inspectContainer(input, 'webm');
    const inputFormat = mp4.signature && mp4.hasContent ? 'mov' : webm.signature && webm.hasContent ? 'matroska' : '';
    if (!inputFormat) throw new Error('输入不是有效的 MP4 或 WebM');
    if (original.extension !== (inputFormat === 'mov' ? 'mp4' : 'webm')) throw new Error('输入容器不匹配');
    if (signal?.aborted) throw new Error('导出已取消');
    const dir = await fs.mkdtemp(path.join(scratchRoot, 'video-export-'));
    const source = path.join(dir, 'input.media'), output = path.join(dir, 'output.mp4');
    const options = { signal, timeoutMs };
    const probe = async (file, format) => {
      const result = await run(ffprobePath, ['-v','error','-protocol_whitelist','file,pipe','-f',format,'-show_data','-show_entries','stream=codec_type,codec_name,codec_tag_string,profile,extradata,start_time,duration,sample_rate,time_base:format=start_time,duration,format_name','-of','json',file], options);
      try { return JSON.parse(result.stdout); } catch { throw new Error('媒体信息无效'); }
    };
    try {
      await fs.writeFile(source, input, { flag: 'wx', mode: 0o600 });
      const info = await probe(source, inputFormat), streams = info.streams || [];
      if (streams.filter(s => s.codec_type === 'video').length !== 1 || streams.filter(s => s.codec_type === 'audio').length > 1) throw new Error('输入轨道不支持');
      const duration = Number(info.format?.duration);
      if (!Number.isFinite(duration) || duration <= 0 || segments.at(-1).endMs > duration * 1000 + 5) throw new Error('片段超出视频时长');
      const audio = streams.some(s => s.codec_type === 'audio');
      if (audio !== original.hasAudio) throw new Error('输入音频轨道与录制声明不一致');
      // Use a common source timeline. Never silently collapse audio gaps or
      // delayed starts; accept only bounded internal video presentation gaps.
      if (!Number.isFinite(numeric(info.format?.start_time)) || Math.abs(numeric(info.format.start_time)) > 0.001) throw timingReject('容器起始时间不支持', 'container-start', { startMs: numeric(info.format.start_time) * 1000 });
      const timedStreams = streams.filter(s => s.codec_type === 'video' || s.codec_type === 'audio');
      const tailPadMs = softwareAudioTiming ? 180 : AUDIO_TAIL_PAD_MS;
      const videoEnd = numeric(timedStreams.find(s => s.codec_type === 'video')?.duration);
      const audioEnd = numeric(timedStreams.find(s => s.codec_type === 'audio')?.duration);
      // 软件编码的录制可能让音频比视频多出一小截尾巴。软件模式下两个方向都放到 180ms，
      // 超出照旧拒绝（默认路径的 100ms 门限一字不改）。
      const avDiffLimit = softwareAudioTiming ? 0.180001 : 0.100001;
      if (audio && timedStreams.every(s => Number.isFinite(numeric(s.duration))) &&
          (audioEnd - videoEnd > avDiffLimit || videoEnd - audioEnd > avDiffLimit)) throw timingReject('音视频轨道时长差异过大', 'av-duration-mismatch', { diffMs: Math.abs(videoEnd - audioEnd) * 1000 });
      // 导出边界（仅软件模式）：用户选“整段”时，用最后一段可用视频的末尾当边界——
      // 音频多出来的那截尾巴不带进成片（不补帧、不改音频内容，Save original 仍给原片）。
      // 用户自己要的任意剪辑不缩：只有请求的末尾就是整段末尾时才收边界。
      if (softwareAudioTiming && audio && Number.isFinite(videoEnd) && Number.isFinite(audioEnd)) {
        const videoEndMs = videoEnd * 1000, audioEndMs = audioEnd * 1000, overallMs = duration * 1000;
        const lastSpan = segments.at(-1);
        const wholeFileRequested = lastSpan.endMs === plan.durationMs && Math.abs(plan.durationMs - overallMs) <= 5;
        const tailMs = audioEndMs - videoEndMs;
        const lastVideoMs = Math.floor(videoEndMs);
        if (wholeFileRequested && tailMs > 0 && tailMs <= 180.001 && lastSpan.endMs > videoEndMs && lastVideoMs > lastSpan.startMs) {
          segments = segments.map((span, index) => (index === segments.length - 1 ? { ...span, endMs: lastVideoMs } : span));
          totalMs = segments.reduce((n, span) => n + span.endMs - span.startMs, 0);
        }
      }
      let repairAudio = false, padAudioTail = false, candidate = null;
      const last = segments.at(-1);
      for (const s of timedStreams) {
        const isVideo = s.codec_type === 'video', streamEndMs = numeric(s.duration) * 1000;
        const needsPad = !isVideo && last.endMs > streamEndMs + 2;
        // Only extend a short audio tail, and only if all earlier spans and the
        // beginning of the last span are covered by real audio.
        const requiredEndMs = needsPad ? Math.max(last.endMs - tailPadMs,
          last.startMs + 3, segments.at(-2)?.endMs ?? 0) : last.endMs;
        if (!Number.isFinite(numeric(s.start_time)) || Math.abs(numeric(s.start_time)) > 0.001 ||
            !Number.isFinite(streamEndMs) || streamEndMs + 2 < requiredEndMs) throw timingReject('轨道起止时间不支持', 'track-span', { video: isVideo ? 1 : 0, streamEndMs, requiredEndMs });
        const packetResult = await run(ffprobePath, ['-v','error','-protocol_whitelist','file,pipe','-f',inputFormat,'-select_streams',isVideo ? 'v:0' : 'a:0','-show_entries','packet=pts_time,duration_time','-of','csv=p=0',source], options);
        // 候选路径：一次校验，只放宽两扇视频形态门；其余检查照旧。校验不通过才回落，
        // 且回落时重跑默认校验以给出与默认完全一致的诊断码（不因第一次形态拒绝就跳过剩余包行）。
        if (isVideo && timeline === 'explicit-pts') {
          let relaxed = null;
          try { relaxed = inspectPackets(packetResult.stdout, segments[0].startMs, requiredEndMs, true, true); } catch { relaxed = null; }
          if (!relaxed || (!relaxed.relaxedGap && !relaxed.relaxedInterval)) {
            let defaultError = null;
            try { validatePackets(packetResult.stdout, segments[0].startMs, requiredEndMs, true); } catch (error) { defaultError = error; }
            if (defaultError) throw markCandidateDisabled(defaultError);
            continue;                              // 没有形态问题：视频按原路径即可
          }
          const built = await buildExplicitPtsCandidate({ run, ffmpegPath, ffprobePath, inputFormat, source, packetCsv: packetResult.stdout, spans: segments, requiredEndMs, options });
          if (!built) {
            let defaultError = null;
            try { validatePackets(packetResult.stdout, segments[0].startMs, requiredEndMs, true); } catch (error) { defaultError = error; }
            throw markCandidateDisabled(defaultError || new Error('视频时间间隙过大'));
          }
          candidate = { ...built, subcode: relaxed.relaxedGap ? 'video-gap-large' : 'video-frame-interval-short' };
          continue;
        }
        const needsRepair = validatePackets(packetResult.stdout, segments[0].startMs, requiredEndMs, isVideo);
        if (!isVideo && (needsRepair || needsPad || softwareAudioTiming)) {
          const frames = await run(ffprobePath, ['-v','error','-protocol_whitelist','file,pipe','-f',inputFormat,'-select_streams','a:0','-show_entries','frame=best_effort_timestamp,nb_samples','-of','csv=p=0',source], options);
          const frameRepair = validateAudioFrames(frames.stdout, s, requiredEndMs, softwareAudioTiming);
          repairAudio = needsRepair || (softwareAudioTiming && frameRepair);
          padAudioTail = needsPad;
        }
      }
      const filterGraph = candidate
        ? explicitPtsFilters(segments, candidate.carryIn, candidate.offsets, audio, repairAudio, padAudioTail, tailPadMs)
        : filters(segments, audio, repairAudio, padAudioTail, tailPadMs);
      const args = ['-hide_banner','-loglevel','error','-nostdin','-protocol_whitelist','file,pipe','-f',inputFormat,'-i',source,'-filter_complex',filterGraph,'-map','[vout]'];
      if (audio) args.push('-map','[aout]');
      // libx264 is for local GPL feasibility only; no bundled or redistributable build is implied.
      // veryfast measured ~1.9x faster than the medium default on detailed 1080p synthetic
      // content with valid A/V output (test/video-export-perf.test.cjs); pins and checks unchanged.
      args.push('-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p','-fps_mode:v','vfr','-enc_time_base:v','1:30000');
      if (audio) args.push('-c:a','aac');
      args.push('-movflags','+faststart','-fs',String(MAX_BYTES + 1),'-f','mp4','-n',output);
      await run(ffmpegPath, args, options);
      if (signal?.aborted) throw new Error('导出已取消');
      const stat = await fs.stat(output);
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) throw new Error('导出结果为空或过大');
      const bytes = await fs.readFile(output), container = inspectContainer(bytes, 'mp4');
      if (!container.signature || !container.hasContent) throw new Error('导出结果不是有效 MP4');
      const result = await probe(output, 'mov'), tracks = result.streams || [];
      const video = tracks.filter(s => s.codec_type === 'video' && s.codec_name === 'h264' && s.codec_tag_string === 'avc1');
      if (video.length !== 1 || tracks.filter(s => s.codec_type === 'audio' && s.codec_name === 'aac' && s.codec_tag_string === 'mp4a' && s.profile === 'LC').length !== (audio ? 1 : 0) ||
          tracks.length !== (audio ? 2 : 1)) throw new Error('导出编码或轨道不匹配');
      // 候选路径：导出后必须自证（可解码、帧时间戳与排程一致、时长在实际解码/包时间范围内）。
      if (candidate) await verifyExplicitPtsOutput({ run, ffmpegPath, ffprobePath, output, candidate, expectedTotalMs: totalMs, audio, spanCount: segments.length, options });
      const mimeType = avcMime(video[0], audio);
      validateOutput({ bytes, mimeType, extension: 'mp4', hasAudio: audio });
      return { bytes, mimeType, extension: 'mp4', hasAudio: audio };
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
}
module.exports = { createVideoExporter, runProcess, TIMING_SUBCODES, timingDiagnostics };
