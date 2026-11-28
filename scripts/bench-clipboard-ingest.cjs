'use strict';
// FIX-03 基线：剪贴板主进程同步读取与哈希的阻塞测量。
// 用合成 spool 文件直接走生产 readParts（statSync + readFileSync + sha256），不碰真实剪贴板、
// 不启动 GUI、不写用户库。合成内容为随机字节，只代表同等体积的读取成本，不参与图像解析。
//
// 主进程被同步读取占住的时长，等于热键回调（F1）在这段时间里排不上队的上限，
// 所以 maxBlockMs 就是「一次大复制会让 F1 迟钝多久」的保守估计。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { createClipboardService } = require('../main/clipboard-service.cjs');

const REPEATS = Number(process.env.BENCH_REPEATS || 3);
const LOADS = [
  { format: 'png', ext: '.png', label: 'PNG 图片 60 MB', bytes: 60 * 1024 * 1024 },
  { format: 'dib', ext: '.dib', label: 'DIB 位图 148 MB（上限）', bytes: 148 * 1024 * 1024 },
  { format: 'html', ext: '.html', label: 'HTML 富文本 10 MB', bytes: 10 * 1024 * 1024 }
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function makePayload(bytes) {
  // 分块生成随机字节，避免一次性再翻倍内存。
  const chunk = crypto.randomBytes(Math.min(bytes, 8 * 1024 * 1024));
  const buffer = Buffer.allocUnsafe(bytes);
  for (let offset = 0; offset < bytes; offset += chunk.length) {
    chunk.copy(buffer, offset, 0, Math.min(chunk.length, bytes - offset));
  }
  return buffer;
}

async function main() {
  const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jgc-bench-clip-'));
  const service = createClipboardService({ spoolDir });
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const rows = [];

  for (const load of LOADS) {
    const runs = [];
    for (let round = 0; round < REPEATS; round += 1) {
      // spool 文件名必须是十六进制加白名单扩展名，与真实 helper 产出保持一致。
      const name = `${crypto.randomBytes(12).toString('hex')}${load.ext}`;
      const file = path.join(spoolDir, name);
      fs.writeFileSync(file, makePayload(load.bytes));
      const event = { seq: round + 1, formats: [{ format: load.format, file: name, size: load.bytes }] };
      const rssBefore = process.memoryUsage().rss;
      delay.reset();
      const started = process.hrtime.bigint();
      const parts = service.readParts(event);
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      // 让 event-loop-delay 采样把刚才的阻塞记进去。
      await sleep(30);
      const rssAfter = process.memoryUsage().rss;
      runs.push({
        ms: Number(elapsedMs.toFixed(1)),
        maxBlockMs: Number((delay.max / 1e6).toFixed(1)),
        rssDeltaMb: Number(((rssAfter - rssBefore) / 1048576).toFixed(1)),
        rssMb: Number((rssAfter / 1048576).toFixed(1)),
        entries: parts.entries.length,
        hasHash: typeof parts.assetHash === 'string'
      });
      try { fs.rmSync(file, { force: true }); } catch { /* 已被 readParts 删掉。 */ }
    }
    const median = values => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };
    rows.push({
      load: load.label,
      format: load.format,
      bytes: load.bytes,
      medianReadMs: median(runs.map(run => run.ms)),
      maxReadMs: Math.max(...runs.map(run => run.ms)),
      medianBlockMs: median(runs.map(run => run.maxBlockMs)),
      maxBlockMs: Math.max(...runs.map(run => run.maxBlockMs)),
      peakRssMb: Math.max(...runs.map(run => run.rssMb)),
      maxRssDeltaMb: Math.max(...runs.map(run => run.rssDeltaMb)),
      runs
    });
  }

  delay.disable();
  try { fs.rmSync(spoolDir, { recursive: true, force: true }); } catch { /* 临时目录清不掉就留着。 */ }

  const report = {
    at: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    repeats: REPEATS,
    note: '合成随机字节；读取与哈希走生产 readParts，不含下游入库。maxBlockMs 是主进程被占住的最长时间，即 F1 在此期间的最坏响应延迟。',
    rows
  };
  const outFile = path.join(__dirname, '..', '.tmp', 'bench-clipboard-ingest.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');

  console.log('负载'.padEnd(24), '读取中位', '读取最大', '阻塞中位', '阻塞最大', 'RSS 峰值');
  for (const row of rows) {
    console.log(
      row.load.padEnd(24),
      `${row.medianReadMs}ms`.padStart(9),
      `${row.maxReadMs}ms`.padStart(9),
      `${row.medianBlockMs}ms`.padStart(9),
      `${row.maxBlockMs}ms`.padStart(9),
      `${row.peakRssMb}MB`.padStart(9)
    );
  }
  console.log(`\n报告：${path.relative(path.join(__dirname, '..'), outFile)}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });