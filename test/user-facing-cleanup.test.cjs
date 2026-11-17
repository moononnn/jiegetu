'use strict';
// 普通设置页的前台清理：不再加载开发探针、不再显示捕获链路验证入口、不再显示后台原始日志入口；
// 后台有界日志与主侧探针实现原样保留。DOM 契约在 settings-page-dom.test.cjs，这里补“脚本在元素消失后不报错”。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'renderer/shot-control.js'), 'utf8');
const pageIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));

test('普通设置页不再加载或显示开发探针、原始日志入口', () => {
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(scripts, ['shot-control.js'], '设置页只加载自己的脚本');
  assert.equal(html.includes('probe.js'), false, '不再加载 probe.js');
  for (const id of ['displays', 'start', 'status', 'result', 'screen', 'sample', 'diagnostic-open', 'diagnostic-status']) {
    assert.equal(pageIds.has(id), false, '普通设置页不应再有 #' + id);
  }
  assert.doesNotMatch(html, /捕获链路验证|开发检查|绿色底图|粉色色块|打开最近后台记录|后台排查记录/);
  // 故障排查只留可操作指引。
  assert.match(html, /重试注册/);
  assert.match(html, /重新截一次/);
  assert.match(html, /id="open-last"/);
  // 帮助里不再出现工程口径，风险与正确动作仍在，但不再展示像素限额参数。
  assert.doesNotMatch(html, /开发版已知限制|36M|16M|3600\s*万|1600\s*万|像素上限|按整屏采集/);
  assert.match(html, /截取或编辑特别大的区域时，可能无法处理；遇到提示请缩小选区后重试。/);
  assert.match(html, /可能少几行或者重复几行/);
});

test('shot-control.js 不再引用被删掉的元素', () => {
  for (const token of ['diagnostic-open', 'diagnostic-status', 'openDiagnostic', '#displays', '#start', '#result', '#sample', '#screen']) {
    assert.equal(script.includes(token), false, '脚本里不该再有 ' + token);
  }
});

test('元素消失后设置页仍能初始化：状态回包、快捷键与开始截图都不报错', async () => {
  const elements = new Map();
  const queried = [];
  const element = key => {
    if (!elements.has(key)) {
      const listeners = new Map();
      const classes = new Set();
      elements.set(key, { hidden: false, disabled: false, textContent: '', title: '', style: {}, dataset: {}, attrs: {},
        classList: {
          add(name) { classes.add(name); },
          remove(name) { classes.delete(name); },
          contains: name => classes.has(name),
          toggle(name, on) { if (on === undefined) { if (classes.has(name)) classes.delete(name); else classes.add(name); } else if (on === true) classes.add(name); else classes.delete(name); }
        },
        setAttribute(name, value) { this.attrs[name] = value; },
        getAttribute(name) { return this.attrs[name]; },
        removeAttribute(name) { delete this.attrs[name]; },
        toggleAttribute(name, on) { if (on === true) this.attrs[name] = ''; else delete this.attrs[name]; },
        focus() { this.focused = true; }, scrollTo() {}, contains: () => false,
        addEventListener(type, fn) { listeners.set(type, fn); },
        emit(type, event) { listeners.get(type)?.(event); },
        onclick: null, click() { if (this.disabled) return; this.emit('click', {}); this.onclick?.(); } });
    }
    return elements.get(key);
  };
  const themeButtons = ['system', 'light', 'dark'].map(source => ({
    dataset: { themeSource: source }, disabled: false, pressed: undefined,
    setAttribute(name, value) { if (name === 'aria-pressed') this.pressed = value; },
    addEventListener(type, fn) { if (type === 'click') this.click = fn; }
  }));
  const navButtons = ['settings', 'help'].map(section => Object.assign(element('nav-' + section), { dataset: { section } }));
  // 只按 index.html 里真实存在的 id 给元素：被删掉的 id 一律查不到（null），脚本必须自己扛住。
  const document = {
    hasFocus: () => true,
    querySelector(selector) {
      queried.push(selector);
      if (selector.startsWith('#')) {
        const id = selector.slice(1);
        return pageIds.has(id) ? element(selector) : null;
      }
      return element(selector);
    },
    querySelectorAll(selector) {
      if (selector === 'nav [data-section]') return navButtons;
      if (selector === '[data-theme-source]') return themeButtons;
      return [];
    },
    addEventListener() {}
  };
  const calls = [];
  let statusCallback = null;
  const baseState = (over = {}) => ({ hotkeyLabel: 'F1', hotkeyRegistered: true, hotkeyEditing: false, message: '就绪',
    autoLaunch: false, saveFolder: 'C:\\图片', diagnostic: { hasReport: true, recording: true, writing: false }, ...over });
  const shot = {
    state: async () => baseState(),
    onStatus(callback) { statusCallback = callback; },
    onFocusSettings() {}, onFocusSection() {}, onWindowState() {}, windowState: async () => ({ maximized: false }),
    start: async () => { calls.push('shot:start'); },
    retryHotkey: async () => { calls.push('shot:retry-hotkey'); return baseState(); },
    openLast: async () => { calls.push('shot:open-last'); },
    beginHotkeyEdit: async () => ({ token: 'tok', state: baseState({ hotkeyEditing: true }) }),
    endHotkeyEdit: async () => baseState(),
    setHotkey: async () => baseState(),
    setClipboardEnabled: async () => baseState(),
    beginClipboardHotkeyEdit: async () => ({ token: 'tok', state: baseState() }),
    setClipboardHotkey: async () => baseState(),
    setAutoLaunch: async () => baseState(),
    chooseSaveFolder: async () => baseState(),
    setTheme: async () => baseState(),
    openDirectory: async () => {}, openClipboard: async () => {},
    minimizeWindow: async () => {}, toggleMaximize: async () => {}, closeWindow: async () => {}
  };
  // 脚本顶层不允许因缺元素抛错。
  vm.runInNewContext(script, { document, window: { shot, addEventListener() {}, removeEventListener() {} } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queried.includes('#diagnostic-open'), false, '不再查后台日志按钮');
  assert.equal(queried.includes('#diagnostic-status'), false, '不再查后台日志状态文案');
  // 初始化回包照常生效。
  assert.equal(elements.get('#hotkey-badge').textContent, 'F1 已注册');
  assert.equal(elements.get('#hotkey-display').textContent, 'F1');
  assert.equal(elements.get('#save-folder').textContent, 'C:\\图片');
  // 带后台记录状态的状态包也不报错（后台仍在写，前台不再显示）。
  statusCallback(baseState({ message: '快捷键已就绪', diagnostic: { hasReport: false, recording: true, limited: true } }));
  assert.equal(elements.get('#shot-status').textContent, '快捷键已就绪');
  // 快捷键与开始截图照旧可用。
  await elements.get('#take').onclick();
  await elements.get('#retry').onclick();
  assert.deepEqual(calls, ['shot:start', 'shot:retry-hotkey']);
});

test('后台有界日志与主侧探针实现原样保留', () => {
  const preload = fs.readFileSync(path.join(root, 'main/preload.cjs'), 'utf8');
  assert.match(preload, /openDiagnostic: \(\) => ipcRenderer\.invoke\('shot:diagnostic-open'\)/, '主侧打开后台记录的通道还在');
  assert.match(preload, /exposeInMainWorld\('probe'/, '主侧探针桥接保留给开发用');
  const main = fs.readFileSync(path.join(root, 'main/index.cjs'), 'utf8');
  assert.match(main, /handle\('shot:diagnostic-open', openDiagnostic\)/, '主进程诊断 IPC 仍在');
  assert.match(main, /handle\('probe:prepare'/, '主进程探针 IPC 仍在');
  assert.equal(fs.existsSync(path.join(root, 'main/diagnostics.cjs')), true, '后台诊断实现保留');
  assert.equal(fs.existsSync(path.join(root, 'renderer/probe.js')), true, '开发探针页面脚本保留');
  assert.equal(fs.existsSync(path.join(root, 'core/probe-analysis.mjs')), true, '开发探针分析模块保留');
});
