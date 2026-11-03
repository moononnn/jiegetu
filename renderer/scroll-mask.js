'use strict';
window.regionMaskReady = false;
try {
  // 主进程只交物理数据：真实帧尺寸与已确认的选区像素范围（像素坐标，帧内）。
  const layout = JSON.parse(new URLSearchParams(location.search).get('layout'));
  const frame = layout?.frame, pixels = layout?.pixels;
  const positive = box => Boolean(box) && [box.width, box.height].every(value => Number.isFinite(value) && value > 0);
  if (!positive(frame) || !positive(pixels) ||
      ![pixels.x, pixels.y].every(value => Number.isFinite(value) && value >= 0) ||
      pixels.x + pixels.width > frame.width || pixels.y + pixels.height > frame.height) throw new Error('提示像素范围无效');
  // 与 core/coordinates.cjs outsideMask 同一 floor/ceil±1 安全带公式，投影基准换成这个页面自己的视口：
  // 遮罩窗口的 DIP 尺寸和选区页视口可以不同（125% 副屏 865/864），这里不假设两者相等。
  const width = innerWidth, height = innerHeight;
  // 视口本身不合法时不能靠一张空色块列表冒充就绪：那样主进程会以为提示已就位。
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('提示视口无效');
  const left = Math.max(0, Math.floor(pixels.x * width / frame.width) - 1);
  const top = Math.max(0, Math.floor(pixels.y * height / frame.height) - 1);
  const right = Math.min(width, Math.ceil((pixels.x + pixels.width) * width / frame.width) + 1);
  const bottom = Math.min(height, Math.ceil((pixels.y + pixels.height) * height / frame.height) + 1);
  const panels = [
    { x: 0, y: 0, width, height: top },
    { x: 0, y: bottom, width, height: height - bottom },
    { x: 0, y: top, width: left, height: bottom - top },
    { x: right, y: top, width: width - right, height: bottom - top }
  ].filter(r => r.width > 0 && r.height > 0).map(r => {
    if (![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.x < 0 || r.y < 0 ||
        r.x + r.width > width || r.y + r.height > height) throw new Error('提示区域无效');
    const panel = document.createElement('div'); panel.className = 'shade';
    for (const [key, value] of Object.entries({ left: r.x, top: r.y, width: r.width, height: r.height })) panel.style[key] = `${value}px`;
    return panel;
  });
  document.body.replaceChildren(...panels);
  if (panels.some(panel => getComputedStyle(panel).position !== 'fixed')) throw new Error('提示样式未加载');
  window.regionMaskReady = true;
} catch { /* 主进程核对就绪标志，失败即收回，不能静默无提示采集。 */ }
