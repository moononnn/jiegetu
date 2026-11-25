import {
  Input, BufferSource, MP4, WEBM, Output, BufferTarget, Mp4OutputFormat,
  VideoSampleSink, VideoSampleSource, AudioSampleSource,
} from '../node_modules/mediabunny/dist/bundles/mediabunny.mjs';
import { buildExportTimeline, frameSlices, createPictureCoverage } from '../core/video-export-timeline.mjs';
import { VIDEO_LIMITS, validateOutput } from '../core/video-session.mjs';
import { writeKeptAudio } from './video-built-in-audio.mjs';

const us = seconds => Math.round(seconds * 1e6);
const fail = code => Object.assign(new Error(code), { code });

export async function exportClip({ original, plan }) {
  const input = new Input({ source: new BufferSource(original.bytes), formats: [MP4, WEBM] });
  let output;
  try {
    const [videos, audios] = await Promise.all([input.getVideoTracks(), input.getAudioTracks()]);
    if (videos.length !== 1 || audios.length !== Number(original.hasAudio)) throw fail('export-input');
    const [video] = videos, [audio] = audios;
    const [videoEnd, mediaEnd, width, height] = await Promise.all([
      input.computeDuration(videos), input.computeDuration(), video.getDisplayWidth(), video.getDisplayHeight(),
    ]);
    if (Math.abs(us(mediaEnd) - plan.durationMs * 1000) > 180_000) throw fail('export-timing');
    if (width < 2 || height < 2 || width > 4096 || height > 4096 || width * height > 4096 * 2160) throw fail('export-encoder');
    const timeline = buildExportTimeline(plan, us(videoEnd), us(mediaEnd));
    const target = new BufferTarget();
    output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const videoSource = new VideoSampleSource({ codec: 'avc', bitrate: 6_000_000, hardwareAcceleration: 'prefer-software' });
    const audioSource = audio ? new AudioSampleSource({ codec: 'aac', bitrate: 192_000 }) : null;
    output.addVideoTrack(videoSource);
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();
    const coverage = createPictureCoverage(timeline.durationUs, 1100);
    async function emit(sample, following) {
      try {
        const start = us(sample.timestamp), declaredEnd = us(sample.timestamp + sample.duration);
        const next = following ? us(following.timestamp) : declaredEnd;
        // Preserve normal presentation holds only between two decoded frames.
        // Never infer the end of the last frame from container metadata.
        const end = next > start && Math.abs(next - declaredEnd) <= 60_000 ? next : declaredEnd;
        const slices = frameSlices(timeline.spans, start, end);
        for (const slice of slices) {
          coverage.add(slice);
          const copy = sample.clone();
          try { copy.setTimestamp(slice.timestampUs / 1e6); copy.setDuration(slice.durationUs / 1e6); await videoSource.add(copy); }
          finally { copy.close(); }
        }
      } finally { sample.close(); }
    }
    let previous;
    try {
      for await (const sample of new VideoSampleSink(video).samples()) {
        const pending = previous;
        previous = sample;
        if (pending) await emit(pending, sample);
      }
      const pending = previous;
      previous = undefined;
      if (pending) await emit(pending);
    } finally { previous?.close(); }
    coverage.finish();
    videoSource.close();
    if (audioSource) { await writeKeptAudio(audio, audioSource, timeline.spans); audioSource.close(); }
    await output.finalize();
    const bytes = new Uint8Array(target.buffer);
    if (bytes.length > VIDEO_LIMITS.MAX_BYTES) throw fail('export-encoder');
    const check = new Input({ source: new BufferSource(bytes), formats: [MP4] });
    try {
      const [v, a] = await Promise.all([check.getPrimaryVideoTrack(), check.getPrimaryAudioTrack()]);
      const [codec, audioCodec, duration] = await Promise.all([
        v?.getCodecParameterString(), a?.getCodecParameterString(), check.computeDuration(),
      ]);
      if (!codec || Boolean(a) !== Boolean(audio) || (a && audioCodec !== 'mp4a.40.2') ||
          Math.abs(us(duration) - timeline.durationUs) > 50_000) throw fail('export-encoder');
      const extension = 'mp4', mimeType = `video/mp4;codecs=${codec}${a ? ',mp4a.40.2' : ''}`;
      validateOutput({ bytes, extension, mimeType, hasAudio: Boolean(a) });
      return { bytes, extension, mimeType };
    } finally { check.dispose(); }
  } catch (error) {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {});
    if (error instanceof RangeError) throw fail('export-timing');
    throw error;
  } finally { input.dispose(); }
}

const bridge = globalThis.videoBuiltInExport;
if (bridge) {
  try { await bridge.complete(await exportClip(await bridge.load())); }
  catch (error) { await bridge.fail(error?.code ?? 'export-failed'); }
}
