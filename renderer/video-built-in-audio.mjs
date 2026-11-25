import { AudioSample, AudioSampleSink } from '../node_modules/mediabunny/dist/bundles/mediabunny.mjs';
import { audioSpans, audioSlices } from '../core/video-export-timeline.mjs';

export async function writeKeptAudio(track, output, spans) {
  const rate = await track.getSampleRate(), channels = await track.getNumberOfChannels();
  if (channels !== 1 && channels !== 2) throw new RangeError('unsupported audio channels');
  const mapped = audioSpans(spans, rate), last = mapped.at(-1);
  const duration = last.outputStart + last.end - last.start;
  let cursor = 0, realSamples = 0, filled = 0;
  async function add(data) {
    const sample = new AudioSample({ data, format: 'f32', numberOfChannels: channels,
      sampleRate: rate, timestamp: cursor / rate });
    try { await output.add(sample); cursor += sample.numberOfFrames; }
    finally { sample.close(); }
  }
  async function silence(length) {
    while (length > 0) {
      const count = Math.min(2048, length);
      await add(new Float32Array(count * channels));
      length -= count;
    }
  }
  for await (const sample of new AudioSampleSink(track).samples()) {
    try {
      if (sample.sampleRate !== rate || sample.numberOfChannels !== channels) throw new RangeError('audio format changed');
      const start = Math.round(sample.timestamp * rate);
      if (!Number.isSafeInteger(start)) throw new RangeError('invalid audio timestamp');
      for (const slice of audioSlices(mapped, start, sample.numberOfFrames)) {
        const overlap = Math.max(0, cursor - slice.outputSample);
        const gap = Math.max(0, slice.outputSample - cursor);
        if (overlap > Math.ceil(.0012 * rate) || gap > Math.ceil(.008 * rate) || filled + gap > Math.ceil(.030 * rate)) {
          throw new RangeError('audio discontinuity');
        }
        if (gap) { await silence(gap); filled += gap; }
        const frames = slice.frames - overlap;
        if (frames <= 0) continue;
        const data = new Float32Array(frames * channels);
        sample.copyTo(data, { format: 'f32', planeIndex: 0, frameOffset: slice.offset + overlap, frameCount: frames });
        await add(data);
        realSamples += frames;
      }
    } finally { sample.close(); }
  }
  const tail = duration - cursor;
  // Only fill the short final audio-only gap after some real audio in the last keep.
  if (!realSamples || cursor <= last.outputStart || tail < 0 || tail > Math.ceil(.180 * rate)) throw new RangeError('missing audio');
  await silence(tail);
}
