// 匿名程序化聊天页；不引用真实截图或消息。
export function chatFrame(offset, { width = 343, height = 539, fixed = true, alpha = 1, footer = 0, gradientFooter = false, sidebar = false, repeat = false, softFooter = false, footerBlink = false, inset = .064, outlinedWallpaper = false, illustratedWallpaper = false, gradientRange = 120, emptyWallpaperTail = 0 } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y + offset, z = fixed ? y : p, line = p % 160;
    const left = Math.max(8, Math.round(width * inset)), right = Math.round(width * .933);
    const col = Math.floor((x - left - 8) / 7), bit = (x - left - 8) % 7;
    let background = 160 + 35 * Math.sin(x / 55 + z / 63) + 20 * Math.cos(z / 27);
    // 密集插画式曲线横跨纸面下方，验证半透明消息内的高频底纹干扰。
    if (illustratedWallpaper && x > width * .14 && x < width * .94 &&
        (Math.abs(Math.sin(z / 28 + x / 37)) < .11 || Math.abs(Math.hypot(x - width * .65, z - height * .8) - 70) < 2)) background -= 100;
    // 固定壁纸可有线条；两侧仍有平滑底纹，消息左侧留出头像／装饰的空隙。
    if (outlinedWallpaper && [.08, .12, .16].some(ratio => Math.abs(x - width * ratio - 7 * Math.sin(z / 13 + ratio * 5)) < 1.7)) background -= 65;
    if (y >= height - emptyWallpaperTail) background = x >= width * .1 && x < width * .1 + 4 ? 175 : 245;
    let value = background;
    if (y < height - emptyWallpaperTail && x >= left && x < right && line >= 8 && line < 145) {
      const glyph = line % 22 >= 4 && line % 22 <= 13 && x > left + 8 && x < right - 12 && bit < 5 &&
        ((Math.imul(Math.floor((repeat ? p % 160 : p) / 22) + 5, 17389) ^ Math.imul(col + 7, 31337) ^ Math.imul(line % 22, 479)) >>> bit & 1);
      value = alpha * (glyph ? 35 : 245) + (1 - alpha) * background;
    }
    if (y >= height - footer) {
      const target = gradientFooter ? 110 + gradientRange * x / width :
        ((Math.imul(x + 3, 17389) ^ Math.imul(y + 7, 31337)) >>> 4) & 255;
      const opacity = softFooter ? Math.min(1, (y - (height - footer) + 1) / 64) : 1;
      value = value * (1 - opacity) + target * opacity;
      if (footerBlink && x === Math.floor(width * .8025)) value = offset === 42 ? 80 : 0;
    }
    if (sidebar && x < width * .2) value = ((Math.imul(x + 1, 214013) ^ Math.imul(y + 1, 1103515245)) >>> 8) & 255;
    const i = (y * width + x) * 4; data[i] = data[i + 1] = data[i + 2] = value; data[i + 3] = 255;
  }
  return { data, width, height };
}
