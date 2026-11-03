'use strict';
// 快捷菜单页面（renderer/tray-menu.js）的定向用例：假 DOM、假 preload 桥，不启动 Electron。
// 覆盖：初始状态落 DOM、状态刷新、方向键/Home/End/Tab 走位（跳过隐藏与禁用）、Esc、双击只派发一次。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { HTMLElement } = require('./fixtures/editor-dom.cjs');

const HTML = fs.readFileSync(path.join(__dirname, '../renderer/tray-menu.html'), 'utf8');
const SCRIPT = fs.readFileSync(path.join(__dirname, '../renderer/tray-menu.js'), 'utf8');
const BODY = /<body>([\s\S]*)<\/body>/.exec(HTML)[1];

function bridge(initial = {}) {
  const state = { hotkeyLabel: 'F1', hotkeyRegistered: true, canFinishScroll: false, hasLastFile: false, ...initial };
  const calls = { actions: [], ready: 0, dismissed: 0, states: 0 };
  let emitState;
  const api = {
    state: async () => { calls.states += 1; return { ...state }; },
    ready: async () => { calls.ready += 1; return true; },
    action: action => { calls.actions.push(action); return Promise.resolve({ ok: true }); },
    dismiss: async () => { calls.dismissed += 1; return true; },
    onState: callback => { emitState = callback; }
  };
  return { api, calls, push(patch) { Object.assign(state, patch); emitState?.({ ...state }); } };
}

function findBy(root, predicate) {
  if (!root || root.nodeType !== 1) return null;
  if (predicate(root)) return root;
  for (const child of root.childNodes) {
    const found = findBy(child, predicate);
    if (found) return found;
  }
  return null;
}

async function createUi({ initial, api: suppliedApi, autoFlush = true } = {}) {
  const document = { activeElement: null, listeners: new Map(), body: null };
  document.createElement = tag => new HTMLElement(document, tag);
  document.getElementById = id => findBy(document.body, node => node.getAttribute('id') === id);
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.addEventListener = (type, handler) => {
    if (!document.listeners.has(type)) document.listeners.set(type, []);
    document.listeners.get(type).push(handler);
  };
  document.emit = (type, event = {}) => {
    const payload = { type, target: document.activeElement, preventDefault() {}, stopPropagation() {}, ...event };
    for (const handler of [...(document.listeners.get(type) || [])]) handler(payload);
    return payload;
  };
  document.body = new HTMLElement(document, 'body');
  document.body.innerHTML = BODY;
  document.activeElement = document.body;

  const frames = [];
  const bridgeValue = suppliedApi ? { api: suppliedApi, calls: { actions: [], ready: 0, dismissed: 0 }, push() {} } : bridge(initial);
  const window = {
    trayMenu: bridgeValue.api,
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; },
    addEventListener: () => {}
  };
  vm.runInNewContext(SCRIPT, { window, document, console });

  const flush = async () => {
    for (let guard = 0; guard < 10; guard += 1) {
      await new Promise(resolve => setImmediate(resolve));
      if (!frames.length) break;
      for (const fn of frames.splice(0)) fn();
    }
    await new Promise(resolve => setImmediate(resolve));
  };
  if (autoFlush) await flush();

  const get = id => document.getElementById(id);
  const key = (name, extra = {}) => document.emit('keydown', { key: name, preventDefault() {}, ...extra });
  const click = target => document.emit('click', { target });
  return { document, window, frames, flush, get, key, click, calls: bridgeValue.calls, push: bridgeValue.push };
}

test('首帧：快捷键、完成长截图隐藏、最近截图禁用，首个可用项获得焦点后才 ready', async () => {
  const ui = await createUi();
  assert.equal(ui.get('hotkey').textContent, 'F1');
  assert.equal(ui.get('finish-scroll').hidden, true);
  assert.equal(ui.get('open-last').disabled, true);
  assert.equal(ui.document.activeElement, ui.get('capture'), '首个可用项聚焦');
  assert.equal(ui.calls.ready, 1);
});

test('状态刷新：快捷键文案/未注册提示、完成长截图出现、最近截图解禁，且不把焦点抢回首项', async () => {
  const ui = await createUi();
  ui.get('settings').focus();
  ui.push({ hotkeyLabel: 'Ctrl + Shift + A', hotkeyRegistered: false, canFinishScroll: true, hasLastFile: true });
  assert.equal(ui.get('hotkey').textContent, 'Ctrl + Shift + A');
  assert.equal(ui.get('hotkey').classList.contains('unregistered'), true);
  assert.equal(ui.get('finish-scroll').hidden, false);
  assert.equal(ui.get('open-last').disabled, false);
  assert.equal(ui.document.activeElement, ui.get('settings'), '刷新保持当前焦点');
});

test('当前焦点项被新状态禁用时，焦点落到第一个可用项', async () => {
  const ui = await createUi({ initial: { hasLastFile: true } });
  ui.get('open-last').focus();
  ui.push({ hasLastFile: false });
  assert.equal(ui.get('open-last').disabled, true);
  assert.equal(ui.document.activeElement, ui.get('capture'));
});

test('↑/↓/Home/End 只在可用项之间走，并在两端循环', async () => {
  const ui = await createUi();
  assert.equal(ui.document.activeElement, ui.get('capture'));
  ui.key('ArrowDown');
  assert.equal(ui.document.activeElement, ui.get('open-folder'));
  ui.key('End');
  assert.equal(ui.document.activeElement, ui.get('quit'));
  ui.key('ArrowDown');
  assert.equal(ui.document.activeElement, ui.get('capture'), '到底回到第一项');
  ui.key('ArrowUp');
  assert.equal(ui.document.activeElement, ui.get('quit'), '到顶回到最后一项');
  ui.key('Home');
  assert.equal(ui.document.activeElement, ui.get('capture'));
  ui.key('ArrowDown');
  ui.key('ArrowDown');
  assert.equal(ui.document.activeElement, ui.get('settings'), '禁用的最近截图被跳过');
});

test('完成长截图出现后进入走位序列', async () => {
  const ui = await createUi({ initial: { canFinishScroll: true } });
  ui.key('ArrowDown');
  assert.equal(ui.document.activeElement, ui.get('finish-scroll'));
  ui.key('ArrowDown');
  assert.equal(ui.document.activeElement, ui.get('open-folder'));
});

test('Tab / Shift+Tab 在菜单内循环，不把焦点丢出窗口', async () => {
  const ui = await createUi();
  ui.key('End');
  ui.key('Tab');
  assert.equal(ui.document.activeElement, ui.get('capture'));
  ui.key('Tab', { shiftKey: true });
  assert.equal(ui.document.activeElement, ui.get('quit'));
});

test('Esc 只收起一次', async () => {
  const ui = await createUi();
  ui.key('Escape');
  ui.key('Escape');
  assert.equal(ui.calls.dismissed, 1);
});

test('点击禁用项不派发动作；点一次只执行一次，并立即锁住整扇菜单', async () => {
  const ui = await createUi();
  ui.click(ui.get('open-last'));
  assert.deepEqual(ui.calls.actions, []);

  ui.click(ui.get('capture'));
  ui.click(ui.get('capture'));
  assert.deepEqual(ui.calls.actions, ['capture']);
  assert.equal(ui.get('capture').disabled, true);
  assert.equal(ui.get('settings').disabled, true);
});

test('动作返回失败时按最新状态恢复，而不是留下整扇禁用菜单', async () => {
  let rejectOnce = true;
  const api = {
    state: async () => ({ hotkeyLabel: 'F1', hotkeyRegistered: true, canFinishScroll: false, hasLastFile: false }),
    ready: async () => true,
    action: () => {
      if (rejectOnce) { rejectOnce = false; return Promise.reject(new Error('expired')); }
      return Promise.resolve({ ok: true });
    },
    dismiss: async () => true,
    onState: () => {}
  };
  const ui = await createUi({ api });
  ui.click(ui.get('capture'));
  await ui.flush();
  assert.equal(ui.get('capture').disabled, false, '失败后恢复可点');
  assert.equal(ui.document.activeElement, ui.get('capture'));
});
