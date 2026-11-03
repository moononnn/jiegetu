(() => {
  'use strict';
  const host = window.editorHost || window.selection;
  if (!host || typeof host.onExitConfirmation !== 'function' || typeof host.replyExitConfirmation !== 'function') return;
  let current = null;
  const closed = new Set();

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  function close(state) {
    if (current !== state) return;
    current = null;
    closed.add(state.id);
    state.overlay.remove();
    for (const [node, inert] of state.inert) node.inert = inert;
    if (state.focus && state.focus.isConnected && typeof state.focus.focus === 'function') state.focus.focus();
  }
  async function reply(state, choice) {
    if (current !== state || state.pending) return;
    state.pending = true;
    try { await host.replyExitConfirmation(state.id, choice); }
    catch { /* 主页面可能暂时挂起；保留面板供用户重试。 */ }
    finally { state.pending = false; }
  }
  function show(id) {
    if (closed.has(id) || current?.id === id) return;
    if (current) close(current);
    const overlay = element('div', 'exit-confirm-overlay');
    const panel = element('section', 'exit-confirm-panel');
    panel.setAttribute('role', 'alertdialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'exit-confirm-title');
    panel.setAttribute('aria-describedby', 'exit-confirm-description');
    const title = element('h2', 'exit-confirm-title', '退出截图？');
    title.id = 'exit-confirm-title';
    const description = element('p', 'exit-confirm-description', '放弃后，未保存的成图、批注和编辑草稿会丢失。');
    description.id = 'exit-confirm-description';
    const saved = element('p', 'exit-confirm-saved', '已保存或复制的图片不受影响。');
    const tip = element('p', 'exit-confirm-tip', '可按 F1 截图反馈，完成后会回到这里。');
    const actions = element('div', 'exit-confirm-actions');
    const keep = element('button', 'exit-confirm-keep', '保留截图');
    const discard = element('button', 'exit-confirm-discard', '放弃退出');
    keep.type = discard.type = 'button';
    actions.append(keep, discard);
    panel.append(title, description, saved, tip, actions);
    overlay.append(panel);
    // 选区有 document 级指针/滚轮监听，遮罩必须阻止事件冒泡到它们。
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'wheel', 'contextmenu']) {
      overlay.addEventListener(type, event => event.stopPropagation());
    }
    const state = { id, overlay, panel, keep, discard, pending: false, focus: document.activeElement,
      inert: Array.from(document.body.children, node => [node, node.inert]) };
    current = state;
    for (const [node] of state.inert) node.inert = true;
    document.body.append(overlay);
    keep.addEventListener('click', () => reply(state, 'keep'));
    discard.addEventListener('click', () => reply(state, 'discard'));
    keep.focus();
    requestAnimationFrame(() => {
      if (current !== state) return;
      const readyWhenVisible = () => {
        if (current !== state) return;
        const rect = panel.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) { requestAnimationFrame(readyWhenVisible); return; }
        Promise.resolve(host.replyExitConfirmation(id, 'ready')).catch(() => {});
      };
      requestAnimationFrame(readyWhenVisible);
    });
  }
  window.addEventListener('keydown', event => {
    const state = current;
    if (!state || event.key === 'F1') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === 'Tab') {
      const next = event.shiftKey ? (document.activeElement === state.keep ? state.discard : state.keep)
        : (document.activeElement === state.discard ? state.keep : state.discard);
      next.focus();
    } else if (event.key === 'Escape' && !event.repeat) reply(state, 'keep');
    else if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
      reply(state, document.activeElement === state.discard ? 'discard' : 'keep');
    }
  }, true);
  window.addEventListener('keyup', event => {
    if (!current || event.key === 'F1') return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  host.onExitConfirmation(payload => {
    if (!payload || payload.id == null) return;
    if (payload.open === true) show(payload.id);
    else if (payload.open === false && current?.id === payload.id) close(current);
  });
})();
