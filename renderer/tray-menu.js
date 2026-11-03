'use strict';
// 快捷菜单页面：只负责把四个状态字段落到 DOM、键盘走位与把动作交给 preload。
// 不碰窗口几何、不自己收窗（主进程在动作前先销毁），也不信任 disabled 之外的授权。
(() => {
  const api = window.trayMenu;
  if (!api || typeof api.state !== 'function') return;

  const doc = document;
  const hotkey = doc.getElementById('hotkey');
  const finishScroll = doc.getElementById('finish-scroll');
  const openLast = doc.getElementById('open-last');
  let busy = false;
  let dismissed = false;

  const items = () => [...doc.querySelectorAll('.item')].filter(item => !item.hidden && !item.disabled);

  function applyState(state) {
    if (!state || typeof state !== 'object') return;
    if (hotkey) {
      hotkey.textContent = typeof state.hotkeyLabel === 'string' && state.hotkeyLabel ? state.hotkeyLabel : '—';
      const registered = state.hotkeyRegistered !== false;
      hotkey.classList.toggle('unregistered', !registered);
      hotkey.title = registered ? '截图快捷键' : '快捷键没有注册成功，可能被其他程序占用';
    }
    if (finishScroll) finishScroll.hidden = state.canFinishScroll !== true;
    if (openLast) openLast.disabled = state.hasLastFile !== true;
    // 状态刷新不把焦点抢回首项；只有当前焦点项变得不可用时才就近落回第一个可用项。
    const active = doc.activeElement;
    if (active && active.classList && active.classList.contains('item') && (active.hidden || active.disabled)) {
      focusItem(items()[0]);
    }
  }

  function focusItem(item) {
    if (!item || typeof item.focus !== 'function') return;
    try { item.focus(); } catch { /* 焦点失败不影响鼠标操作。 */ }
  }

  function move(delta) {
    const list = items();
    if (!list.length) return;
    const index = list.indexOf(doc.activeElement);
    const next = index < 0
      ? (delta > 0 ? 0 : list.length - 1)
      : (index + delta + list.length) % list.length;
    focusItem(list[next]);
  }

  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    Promise.resolve(api.dismiss()).catch(() => {});
  }

  // 键盘：↑/↓/Home/End 在可用项间走，Tab 循环（不把焦点困在菜单里靠 Esc 收），Esc 收起。
  doc.addEventListener('keydown', event => {
    if (event.defaultPrevented) return;
    const key = event.key;
    if (key === 'Escape') { event.preventDefault(); dismiss(); return; }
    if (key === 'ArrowDown') { event.preventDefault(); move(1); return; }
    if (key === 'ArrowUp') { event.preventDefault(); move(-1); return; }
    if (key === 'Home') { event.preventDefault(); focusItem(items()[0]); return; }
    if (key === 'End') { event.preventDefault(); focusItem(items().at(-1)); return; }
    if (key === 'Tab') { event.preventDefault(); move(event.shiftKey ? -1 : 1); }
  });

  doc.addEventListener('click', event => {
    const target = event.target;
    const button = target && typeof target.closest === 'function' ? target.closest('.item') : null;
    if (!button || busy || button.hidden || button.disabled) return;
    const action = button.getAttribute('data-action');
    if (!action) return;
    // 一次点击只派发一次：立刻锁住整扇菜单，主进程也会在动作前把它销毁。
    busy = true;
    for (const item of doc.querySelectorAll('.item')) item.disabled = true;
    Promise.resolve(api.action(action)).catch(() => {
      // 常见情形是窗口已被主进程收起，invoke 回包失败——吞掉，不弹系统框。
      // 菜单还在（例如现态校验拒绝）就按最新状态恢复。
      if (dismissed) return;
      busy = false;
      for (const item of doc.querySelectorAll('.item')) item.disabled = false;
      Promise.resolve(api.state()).then(next => applyState(next)).catch(() => {}).then(() => focusItem(items()[0]));
    });
  });

  doc.addEventListener('contextmenu', event => event.preventDefault());
  window.addEventListener('dragover', event => event.preventDefault());
  window.addEventListener('drop', event => event.preventDefault());

  if (typeof api.onState === 'function') api.onState(applyState);

  const firstPaint = typeof window.requestAnimationFrame === 'function'
    ? new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)))
    : Promise.resolve();

  Promise.resolve(api.state())
    .then(state => applyState(state))
    .catch(() => {})
    .then(() => firstPaint)
    .then(() => {
      focusItem(items()[0]);
      return api.ready();
    })
    .catch(() => {});
})();
