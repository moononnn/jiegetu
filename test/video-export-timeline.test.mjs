import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExportTimeline, frameSlices, audioSpans, audioSlices, createPictureCoverage } from '../core/video-export-timeline.mjs';

const plan = {durationMs: 1000, ranges: [{startMs: 0, endMs: 300}, {startMs: 500, endMs: 1000}], totalMs: 800};

test('carry-in repeats the held picture only across the kept pieces', () => {
  const {spans} = buildExportTimeline(plan, 1_000_000, 1_000_000);
  assert.deepEqual(frameSlices(spans, 250_000, 560_000), [
    {timestampUs: 250_000, durationUs: 50_000}, {timestampUs: 300_000, durationUs: 60_000},
  ]);
  assert.deepEqual(frameSlices(spans, 300_000, 500_000), []);
});

test('clip interleaved audio by sample ranges, including chunks spanning both keeps', () => {
  const {spans} = buildExportTimeline(plan, 1_000_000, 1_000_000);
  for (const rate of [44100, 48000]) {
    const m = audioSpans(spans, rate);
    assert.deepEqual(audioSlices(m, rate * .25, rate * .3), [
      {offset: 0, frames: rate * .05, outputSample: rate * .25},
      {offset: rate * .25, frames: rate * .05, outputSample: rate * .3},
    ]);
  }
});

test('coverage rejects missing decoded tail and interior gaps', () => {
  const complete = createPictureCoverage(800_000);
  complete.add({timestampUs:0,durationUs:300_000});
  complete.add({timestampUs:300_000,durationUs:500_000});
  complete.finish();
  const incomplete = createPictureCoverage(800_000);
  incomplete.add({timestampUs:0,durationUs:300_000});
  assert.throws(() => incomplete.finish(), /missing picture/);
  assert.throws(() => incomplete.add({timestampUs:310_000,durationUs:490_000}), /invalid picture/);
});

test('only a small audio-only tail at the full file end can be excluded', () => {
  assert.equal(buildExportTimeline(plan, 865_000, 1_000_000).durationUs, 665_000);
  assert.throws(() => buildExportTimeline(plan, 750_000, 1_000_000), /exceeds picture/);
  assert.throws(() => buildExportTimeline({...plan, ranges: [plan.ranges[0], {startMs:500,endMs:950}], totalMs:750}, 865_000, 1_000_000), /exceeds picture/);
  assert.throws(() => buildExportTimeline({...plan,totalMs:801}, 1_000_000, 1_000_000), /invalid export duration/);
});
