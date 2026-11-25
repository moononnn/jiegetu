// Common timeline for offline video and PCM export. All ranges are half-open.
const US = 1_000_000;

export function buildExportTimeline(plan, videoEndUs, mediaEndUs) {
  const { durationMs, ranges, totalMs } = plan ?? {};
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 60_000 ||
      !Number.isSafeInteger(videoEndUs) || videoEndUs <= 0 || !Number.isSafeInteger(mediaEndUs) ||
      !Array.isArray(ranges) || !ranges.length || ranges.length > 25) throw new RangeError('invalid export plan');
  let previousEnd = 0, expectedMs = 0, outputUs = 0;
  const spans = ranges.map(({ startMs, endMs }, index) => {
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < previousEnd || endMs <= startMs || endMs > durationMs) {
      throw new RangeError('invalid export range');
    }
    previousEnd = endMs;
    expectedMs += endMs - startMs;
    const startUs = startMs * 1000;
    let endUs = endMs * 1000;
    if (endUs > videoEndUs) {
      // Only a selection through the declared media end can lose an audio-only tail.
      if (index !== ranges.length - 1 || endMs !== durationMs || Math.abs(endUs - mediaEndUs) > 1000 ||
          mediaEndUs < videoEndUs || mediaEndUs - videoEndUs > 180_000 || videoEndUs <= startUs) {
        throw new RangeError('export range exceeds picture');
      }
      endUs = videoEndUs;
    }
    const span = { startUs, endUs, outputUs };
    outputUs += endUs - startUs;
    return span;
  });
  if (totalMs !== expectedMs) throw new RangeError('invalid export duration');
  return { spans, durationUs: outputUs };
}

export function frameSlices(spans, startUs, endUs) {
  const slices = [];
  for (const span of spans) {
    if (span.startUs >= endUs) break;
    const from = Math.max(startUs, span.startUs), to = Math.min(endUs, span.endUs);
    if (to > from) slices.push({ timestampUs: span.outputUs + from - span.startUs, durationUs: to - from });
  }
  return slices;
}

// Ordered output intervals must cover the requested duration. A claimed container
// length alone cannot establish that the final requested frame was decodable.
export function createPictureCoverage(durationUs, toleranceUs = 2) {
  if (!Number.isSafeInteger(durationUs) || durationUs <= 0 || !Number.isSafeInteger(toleranceUs) || toleranceUs < 0) {
    throw new RangeError('invalid picture coverage');
  }
  let nextUs = 0;
  return {
    add({ timestampUs, durationUs: frameUs }) {
      const endUs = timestampUs + frameUs;
      if (!Number.isSafeInteger(timestampUs) || timestampUs < 0 || !Number.isSafeInteger(frameUs) || frameUs <= 0 ||
          Math.abs(nextUs - timestampUs) > toleranceUs || endUs > durationUs + toleranceUs) {
        throw new RangeError('invalid picture interval');
      }
      nextUs = endUs;
    },
    finish() {
      if (nextUs === 0 || Math.abs(nextUs - durationUs) > toleranceUs) throw new RangeError('missing picture at end');
    },
  };
}

// Round span endpoints on the same sample grid, rather than rounding lengths of independently decoded chunks.
export function audioSpans(spans, sampleRate) {
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new RangeError('invalid audio rate');
  const sampleAt = us => Math.round(us * sampleRate / US);
  let outputStart = 0;
  return spans.map(span => {
    const start = sampleAt(span.startUs), end = sampleAt(span.endUs);
    const out = { start, end, outputStart };
    outputStart += end - start;
    return out;
  });
}

export function audioSlices(spans, chunkStart, frames) {
  const chunkEnd = chunkStart + frames;
  const slices = [];
  for (const span of spans) {
    if (span.start >= chunkEnd) break;
    const from = Math.max(span.start, chunkStart), to = Math.min(span.end, chunkEnd);
    if (to > from) slices.push({ offset: from - chunkStart, frames: to - from, outputSample: span.outputStart + from - span.start });
  }
  return slices;
}
