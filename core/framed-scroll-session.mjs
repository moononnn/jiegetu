import { createScrollSession } from './scroll-session.mjs';
import { compose, MAX_HEIGHT, MAX_PIXELS } from './scroll.mjs';

// 显式标出的物理像素半开区间，不从静止壁纸猜栏边界。
export function createFramedScrollSession(seed, content, options = {}) {
  const { top, bottom } = content ?? {};
  const { width, height } = seed;
  if (!Number.isInteger(top) || !Number.isInteger(bottom) || top < 0 || bottom > height || bottom - top < 48 ||
      !Number.isInteger(width) || width < 16 || !Number.isInteger(height) || seed.data.length !== width * height * 4 ||
      width * height > MAX_PIXELS) throw new RangeError('无效滚动正文范围');
  const stride = width * 4, fixedHeight = top + height - bottom;
  let header = new Uint8ClampedArray(seed.data.slice(0, top * stride));
  let footer = new Uint8ClampedArray(seed.data.slice(bottom * stride));
  let footerBaseline = footer.slice(), blocked = false, cleared = false;
  const crop = image => ({ width, height: bottom - top,
    data: new Uint8ClampedArray(image.data.slice(top * stride, bottom * stride)) });
  const maxHeight = Math.min(options.maxHeight ?? MAX_HEIGHT, Math.floor(MAX_PIXELS / width)) - fixedHeight;
  // 禁用原图回放，保证 added>0 对应当前提交帧，尾栏不会误取失败/回滚帧。
  const session = createScrollSession(crop(seed), { ...options, maxHeight, maxFrames: 0, preservePixels: true });
  const active = () => { if (cleared) throw new Error('滚动会话已清除'); };
  const total = state => ({ ...state, height: state.height + fixedHeight,
    // 与最终成图共用整图坐标，不能把正文缩略冒充含顶底栏的完整长图。
    ...(state.viewport ? { viewport: { ...state.viewport, top: top + state.viewport.top, matched: !blocked && state.viewport.matched } } : {}),
    ...(state.preview ? { preview: session.preview({ data: header, height: top }, { data: footer, height: height - bottom }) } : {}) });
  function bandChanged(reference, image, start) {
    if (!reference.length) return false;
    let changed = 0;
    for (let i = 0; i < reference.length; i += 4) {
      if (Math.max(Math.abs(reference[i] - image.data[start + i]), Math.abs(reference[i + 1] - image.data[start + i + 1]),
        Math.abs(reference[i + 2] - image.data[start + i + 2])) > 12) changed++;
    }
    // 容许小光标/少量闪烁；明显栏内容或布局变化后锁住，不猜新的边界。
    return changed > reference.length / 4 * .005;
  }
  return {
    accept(image, atMs) {
      active();
      if (image.width !== width || image.height !== height || image.data.length !== width * height * 4) throw new RangeError('固定栏截图尺寸发生变化');
      if (!Number.isFinite(atMs)) throw new RangeError('采集时间必须是有限数字');
      blocked ||= bandChanged(header, image, 0) || bandChanged(footerBaseline, image, bottom * stride);
      if (blocked) {
        const state = session.stats();
        return total({ ...state, viewport: state.viewport && { ...state.viewport, matched: false },
          result: { kind: 'layout-changed' }, added: 0, recoveredFrames: 0, limit: false });
      }
      const update = session.accept(crop(image), atMs);
      if (update.added > 0) footer = new Uint8ClampedArray(image.data.slice(bottom * stride));
      return total(update);
    },
    stats() { active(); return total(session.stats()); },
    finish() {
      active();
      const output = session.finish();
      const result = compose([{ height: top, data: header }, { height: output.height, data: output.data },
        { height: height - bottom, data: footer }].filter(part => part.height > 0), width);
      return { ...result, backgroundEvidence: output.backgroundEvidence };
    },
    clear() {
      if (cleared) return;
      session.clear(); header = footer = footerBaseline = null; cleared = true;
    }
  };
}
