'use strict';
// 主题：把「跟随系统 / 浅色 / 深色」落到 Electron 的 nativeTheme.themeSource 上。
// 官方语义（https://www.electronjs.org/docs/latest/api/native-theme）：
// themeSource 三态直接决定所有 renderer 的 prefers-color-scheme，切换不需要重载页面；
// system 时由 Windows 决定，变化通过 nativeTheme.updated 通知。
// 这个模块只负责“意图 + 不透明 UI 窗的纯装饰色”：背景色、标题栏叠加色、强调色。
// 不碰几何、显隐、焦点、采集时序；不遍历窗口，也不给透明选区/遮罩/跨屏黑底窗上色。
const SOURCES = Object.freeze(['system', 'light', 'dark']);
// 未指定的窗口保持原构造参数；只有 opaque UI 窗会用到这两组颜色。
const COLORS = Object.freeze({
  light: Object.freeze({ background: '#f7faf6', titleBar: '#e6f1e9', symbol: '#244e43', accent: '#a8cbb9' }),
  dark: Object.freeze({ background: '#17231f', titleBar: '#21382d', symbol: '#e0eee5', accent: '#486959' })
});

function createTheme({ nativeTheme, settings }) {
  if (!nativeTheme || typeof nativeTheme !== 'object') throw new TypeError('主题需要 nativeTheme');
  if (!settings || typeof settings.get !== 'function' || typeof settings.update !== 'function') {
    throw new TypeError('主题需要 settings');
  }
  const bindings = new Set();
  let listening = false;

  // 保存的意图：旧设置没有这个字段、或磁盘上是非法值，一律按 system。
  const saved = () => {
    let value;
    try { value = settings.get().theme; } catch { value = undefined; }
    return SOURCES.includes(value) ? value : 'system';
  };
  const dark = () => nativeTheme.shouldUseDarkColors === true;
  const palette = () => COLORS[dark() ? 'dark' : 'light'];

  // 启动时先把保存的意图交给 Electron；之后所有窗口的 prefers-color-scheme 由它驱动。
  try { nativeTheme.themeSource = saved(); } catch { /* 读不到主题不影响截图。 */ }

  function apply(binding) {
    const { win, overlay } = binding;
    if (!win) return;
    try { if (win.isDestroyed?.() === true) return; } catch { return; }
    const value = palette();
    try { win.setBackgroundColor(value.background); } catch { /* 窗口可能正在关闭。 */ }
    if (!overlay) return;
    // 只有带自定义标题栏的编辑窗才有叠加色与强调色；旧版本不支持就跳过。
    try { win.setTitleBarOverlay({ color: value.titleBar, symbolColor: value.symbol, height: 36 }); } catch { /* 不支持就不改。 */ }
    try { if (typeof win.setAccentColor === 'function') win.setAccentColor(value.accent); } catch { /* 同上。 */ }
  }

  function onUpdated() { for (const binding of [...bindings]) apply(binding); }

  // 整组窗口共用一个 nativeTheme.updated 监听；最后一个解绑或 dispose 时摘掉。
  function listen(on) {
    if (on === listening) return;
    listening = on;
    try {
      if (on) nativeTheme.on('updated', onUpdated);
      else nativeTheme.removeListener('updated', onUpdated);
    } catch { /* 假 nativeTheme 没有事件也不影响颜色回填。 */ }
  }

  // 只给已经建好的不透明 UI 窗用；返回解绑函数，窗口 closed 时也会自动解绑。
  function bind(win, { titleBarOverlay = false } = {}) {
    if (!win || typeof win.setBackgroundColor !== 'function') return () => {};
    const binding = { win, overlay: titleBarOverlay === true };
    bindings.add(binding);
    // 首次就按当前主题上色：建窗到上屏之间不会闪一帧浅色。
    apply(binding);
    listen(true);
    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      bindings.delete(binding);
      try { win.removeListener?.('closed', onClosed); } catch { /* 已关闭。 */ }
      if (!bindings.size) listen(false);
    };
    const onClosed = () => { detach(); };
    try { win.once('closed', onClosed); } catch { /* 没有事件就只能靠 dispose。 */ }
    return detach;
  }

  // 保存意图 → 落盘 → 再交给 Electron。严格写入：写不进磁盘就抛错，内存与 themeSource 都不动。
  // 非法值在写设置前就抛，状态不变。
  function set(source) {
    if (!SOURCES.includes(source)) throw new Error('无效的主题设置');
    const next = settings.update({ theme: source }, { strict: true });
    if (next && next.theme !== source) throw new Error('主题设置没有保存成功');
    try { nativeTheme.themeSource = source; } catch { /* 系统层不接受时保留已保存的意图。 */ }
    return state();
  }

  function state() {
    return { source: saved(), dark: dark() };
  }

  function dispose() {
    bindings.clear();
    listen(false);
  }

  return { bind, set, state, dispose, sources: SOURCES.slice() };
}

module.exports = { createTheme, SOURCES, COLORS };
