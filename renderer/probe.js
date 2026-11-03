import { meanRgb, assess } from '../core/probe-analysis.mjs';

const start = document.querySelector('#start');
const status = document.querySelector('#status');
const result = document.querySelector('#result');
const video = document.querySelector('#screen');
const canvas = document.querySelector('#sample');
const context = canvas.getContext('2d', { willReadFrequently: true });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let displayId;
let running = false;

try {
  const displays = await window.probe.displays();
  for (const display of displays) {
    const button = document.createElement('button');
    button.textContent = `${display.label}${display.primary ? ' · 主屏' : ''} · ${Math.round(display.scaleFactor * 100)}%`;
    button.setAttribute('aria-pressed', String(display.primary));
    button.onclick = () => {
      if (running) return;
      displayId = display.id;
      document.querySelectorAll('#displays button').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    };
    document.querySelector('#displays').append(button);
    if (display.primary) displayId = display.id;
  }
  if (displayId === undefined) throw new Error('未发现可用显示器');
  start.disabled = false;
  status.textContent = '准备好了，验证约需 6 秒。';
} catch (error) { status.textContent = `无法准备：${error.message}`; }

start.onclick = async () => {
  if (running) return;
  running = true;
  start.disabled = true;
  result.hidden = true;
  status.textContent = '正在启动屏幕流…';
  let stream;
  let track;
  try {
    await window.probe.select(displayId);
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 } }, audio: false
    });
    [track] = stream.getVideoTracks();
    video.srcObject = stream;
    await video.play();
    const config = await window.probe.prepare();
    const deadline = performance.now() + 12000;
    while (!video.videoWidth || !video.videoHeight || video.readyState < 2) {
      if (performance.now() > deadline) throw new Error('屏幕流没有送来画面');
      await wait(100);
    }
    const frame = { width: video.videoWidth, height: video.videoHeight };
    const rect = await window.probe.map(config.sample, frame);
    const phases = {};
    for (const mode of ['hidden', 'visible', 'protected']) {
      status.textContent = '正在比较遮罩前后的画面…';
      await window.probe.phase(mode);
      phases[mode] = [];
      for (let n = 0; n < 3; n++) {
        await wait(250);
        if (performance.now() > deadline || track.readyState !== 'live') throw new Error('捕获中断或超时');
        if (video.videoWidth !== frame.width || video.videoHeight !== frame.height) throw new Error('验证期间屏幕尺寸发生变化，请重试');
        context.drawImage(video, rect.x, rect.y, rect.width, rect.height, 0, 0, 32, 32);
        phases[mode].push({ rgb: meanRgb(context.getImageData(0, 0, 32, 32).data), time: video.currentTime });
      }
    }
    const checks = assess(phases);
    const saved = await window.probe.finish({ display: config.display, frame, samplePixels: rect,
      checks, phases, trackSettings: { width: track.getSettings().width, height: track.getSettings().height } });
    status.textContent = checks.pass ? '遮罩排除验证通过。仍需另测实际选区与滚动。' : '验证未通过，先不要继续做拼接。';
    result.textContent = [
      `阶段切换得到新画面：${checks.fresh ? '通过' : '失败'}`,
      `坐标命中绿色底图：${checks.baseline ? '通过' : '失败'}`,
      `未保护时可见粉色遮罩：${checks.positiveControl ? '通过' : '失败'}`,
      `保护后恢复绿色底图：${checks.excluded ? '通过' : '失败'}`,
      '', `屏幕流：${frame.width} × ${frame.height}`,
      '这次没有保存桌面图片。报告已保存在本程序的本地数据目录。',
      '', JSON.stringify(saved.report, null, 2)
    ].join('\n');
    result.hidden = false;
  } catch (error) {
    status.textContent = `验证未完成：${error.message}`;
    try { await window.probe.cancel(); } catch { /* 主进程另有自动收回看门狗。 */ }
  } finally {
    if (stream) stream.getTracks().forEach(item => item.stop());
    video.srcObject = null;
    running = false;
    start.disabled = false;
  }
};
