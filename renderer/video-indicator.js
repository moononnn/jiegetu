// 音源只在准备阶段选择，点击开始时一次性提交并锁定。
(function () {
  'use strict';
  const label = document.querySelector('#state');
  const clock = document.querySelector('#clock');
  const start = document.querySelector('#start');
  const pause = document.querySelector('#pause');
  const stop = document.querySelector('#stop');
  const cancel = document.querySelector('#cancel');
  const audioOptions = document.querySelector('#audio-options');
  const audioSystem = document.querySelector('#audio-system');
  const audioMic = document.querySelector('#audio-mic');
  const bridge = globalThis.video;
  let phase = 'ready', runningSince = 0, recordedMs = 0, timer;
  const tick = () => {
    const s = Math.floor((recordedMs + (runningSince ? Date.now() - runningSince : 0)) / 1000);
    clock.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  function setPhase(next, message) {
    if (next !== 'recording' && runningSince) { recordedMs += Date.now() - runningSince; runningSince = 0; }
    phase = next;
    audioOptions.hidden = next !== 'ready';
    audioSystem.disabled = audioMic.disabled = next !== 'ready';
    cancel.textContent = next === 'failed' ? '关闭' : '取消';
    start.hidden = !['ready', 'unsaved'].includes(next);
    start.textContent = next === 'unsaved' ? '重试保存' : '开始';
    pause.hidden = !['recording', 'paused'].includes(next);
    pause.textContent = next === 'paused' ? '继续' : '暂停';
    stop.hidden = !['recording', 'paused'].includes(next);
    cancel.hidden = next === 'saving';
    for (const button of [start, pause, stop, cancel]) button.disabled = false;
    label.textContent = message || ({ ready: '准备就绪 · 选好声音再开始', starting: '正在准备…', recording: '正在录制', paused: '已暂停', saving: '正在保存…', unsaved: '未保存，可重试', failed: '录制失败' }[next] || next);
    // 计时只在真的在计时时占位置：ready 阶段的 00:00 既刺眼又占宽度。
    clock.hidden = !['recording', 'paused', 'saving'].includes(next);
    if (next === 'recording' && !timer) {
      runningSince = Date.now();
      timer = setInterval(tick, 250);
    } else if (next !== 'recording' && timer) { clearInterval(timer); timer = undefined; }
    tick();
  }
  async function act(action, pending, choices) {
    if (pending) setPhase(pending);
    try { if (await bridge.action(action, choices) !== true && action !== 'retry-save') throw new Error('操作未完成，请重试'); }
    catch (error) { if (phase !== 'failed') setPhase('failed', error.message || '操作失败'); }
  }
  start.addEventListener('click', () => {
    if (phase === 'ready') return act('start', 'starting', { systemAudio: audioSystem.checked === true, microphone: audioMic.checked === true });
    if (phase === 'unsaved') return act('retry-save', 'saving');
  });
  pause.addEventListener('click', () => act(phase === 'paused' ? 'resume' : 'pause'));
  stop.addEventListener('click', () => act('stop', 'saving'));
  cancel.addEventListener('click', () => act('cancel'));
  bridge.onIndicator(payload => {
    if (payload?.state === 'resumed') setPhase('recording');
    else if (['recording', 'paused', 'unsaved', 'failed', 'saved'].includes(payload?.state)) setPhase(payload.state, payload.message);
  });
  setPhase('ready');
})();
