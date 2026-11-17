/* 真实渲染器隐藏验收：真实 renderer/index.html + renderer/shot-control.js + main/preload.cjs，
   主进程侧用桩 ipcMain 回答 shot:* / window:* / probe:*（不注册全局键、不建真实监听取证、不碰真实剪贴板）。
   证明设置页新增的剪贴板行（记录开关、打开历史、独立改键）在真实渲染环境里能加载、回填、交互。
   不加载生产 main/index.cjs，不碰真实 userData。
   运行：node_modules\electron\dist\electron.exe scripts\verify-settings-clipboard.cjs */
'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const results = [];
const failures = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures.push(name);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-clipboard-'));
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.disableHardwareAcceleration();

const state = {
  message: '准备就绪',
  hotkeyRegistered: true,
  hotkey: 'F1',
  hotkeyLabel: 'F1',
  hotkeyEditing: false,
  autoLaunch: false,
  saveFolder: 'K:\\verify',
  directory: 'K:\\verify',
  theme: { source: 'light', dark: false },
  diagnostic: { hasReport: false, recording: false },
  clipboard: {
    enabled: false, paused: false, hotkey: 'Ctrl+Alt+V', hotkeyLabel: 'Ctrl + Alt + V',
    hotkeyRegistered: true, hotkeyEditing: false, phase: 'stopped'
  }
};
const calls = [];
const clip = () => state.clipboard;
const snapshot = () => ({ ...state, clipboard: { ...clip() } });

app.whenReady().then(async () => {
  const answers = {
    'shot:state': () => snapshot(),
    'shot:begin-hotkey-edit': () => ({ token: 'shot-lease', state: snapshot() }),
    'shot:begin-clipboard-hotkey-edit': () => {
      clip().hotkeyEditing = true;
      return { token: 'clip-lease', state: snapshot() };
    },
    'shot:end-hotkey-edit': () => {
      clip().hotkeyEditing = false;
      return snapshot();
    },
    'shot:set-clipboard-hotkey': (accelerator, token) => {
      if (token !== 'clip-lease') throw new Error('这次改键已失效，请重新点「更改」');
      clip().hotkey = accelerator;
      clip().hotkeyLabel = accelerator.split('+').join(' + ');
      clip().hotkeyEditing = false;
      return snapshot();
    },
    'shot:set-clipboard-enabled': enabled => {
      clip().enabled = enabled === true;
      clip().paused = false;
      clip().phase = clip().enabled ? 'ready' : 'stopped';
      return snapshot();
    },
    'shot:open-clipboard': () => ({ ok: true }),
    'shot:set-theme': source => { state.theme = { source, dark: false }; return snapshot(); },
    'shot:set-auto-launch': () => snapshot(),
    'shot:choose-save-folder': () => snapshot(),
    'shot:open-directory': () => ({}),
    'shot:open-last': () => ({}),
    'shot:diagnostic-open': () => ({}),
    'shot:start': () => ({}),
    'shot:start-desktop': () => ({}),
    'shot:retry-hotkey': () => snapshot(),
    'shot:set-hotkey': () => snapshot(),
    'shot:quit': () => ({}),
    'window:state': () => ({ maximized: false }),
    'window:minimize': () => ({}),
    'window:toggle-maximize': () => ({}),
    'window:close': () => ({}),
    'probe:displays': () => [],
    'probe:select': () => ({}),
    'probe:prepare': () => ({}),
    'probe:phase': () => ({}),
    'probe:map': () => ({}),
    'probe:finish': () => ({}),
    'probe:cancel': () => ({})
  };
  for (const [name, fn] of Object.entries(answers)) {
    ipcMain.handle(name, (_event, ...args) => {
      calls.push({ name, args });
      return fn(...args);
    });
  }

  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: {
    preload: path.join(ROOT, 'main', 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false
  } });
  const consoleErrors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) consoleErrors.push(message);
  });
  win.webContents.on('render-process-gone', () => check('渲染进程存活', false, 'gone'));
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  await sleep(600);

  const run = code => win.webContents.executeJavaScript(code, true);

  // 1. 页面基础：新行都在，且没有运行时错误。
  const dom = await run(`(() => ({
    enabled: Boolean(document.querySelector('#clipboard-enabled')),
    phase: document.querySelector('#clipboard-phase')?.textContent || '',
    display: document.querySelector('#clip-hotkey-display')?.textContent || '',
    changeButton: Boolean(document.querySelector('#clip-hotkey-button')),
    openButton: Boolean(document.querySelector('#open-clipboard')),
    editor: Boolean(document.querySelector('#clip-hotkey-editor')),
    bridge: typeof window.shot?.beginClipboardHotkeyEdit === 'function'
      && typeof window.shot?.setClipboardHotkey === 'function'
      && typeof window.shot?.setClipboardEnabled === 'function'
      && typeof window.shot?.openClipboard === 'function'
  }))()`);
  check('剪贴板行元素齐全', dom.enabled && dom.changeButton && dom.openButton && dom.editor && dom.display);
  check('preload 交出四个剪贴板通道', dom.bridge === true);
  check('初始快捷键回填', dom.display === 'Ctrl + Alt + V', dom.display);
  check('初始相位文案', dom.phase === '记录未开启', dom.phase);
  check('页面无运行时错误', consoleErrors.length === 0, consoleErrors.slice(0, 3));

  // 2. 开关：点一下走 shot:set-clipboard-enabled(true)，回包后文案跟着变。
  await run(`document.querySelector('#clipboard-enabled').click()`);
  await sleep(300);
  const afterToggle = await run(`(() => ({
    checked: document.querySelector('#clipboard-enabled').getAttribute('aria-checked'),
    phase: document.querySelector('#clipboard-phase').textContent
  }))()`);
  check('开关请求打到主进程', calls.some(call => call.name === 'shot:set-clipboard-enabled' && call.args[0] === true),
    JSON.stringify(calls.filter(call => call.name.startsWith('shot:set-clipboard'))));
  check('开关状态回填', afterToggle.checked === 'true', afterToggle.checked);
  check('记录中文案', afterToggle.phase.includes('正在记录'), afterToggle.phase);

  // 3. 打开历史：按钮走 shot:open-clipboard。
  await run(`document.querySelector('#open-clipboard').click()`);
  await sleep(200);
  check('打开历史请求到达主进程', calls.some(call => call.name === 'shot:open-clipboard'));

  // 4. 改键：只按字母不满足修饰键要求，不能保存；Ctrl+Alt+H 可以保存。
  await run(`document.querySelector('#clip-hotkey-button').click()`);
  await sleep(300);
  const opened = await run(`(() => ({
    hidden: document.querySelector('#clip-hotkey-editor').hidden,
    captureExists: Boolean(document.querySelector('#clip-hotkey-capture'))
  }))()`);
  check('点「更改」打开编辑器', opened.hidden === false && opened.captureExists === true, JSON.stringify(opened));

  await run(`(() => {
    const target = document.querySelector('#clip-hotkey-capture');
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', code: 'KeyH', bubbles: true }));
  })()`);
  await sleep(150);
  const bare = await run(`(() => ({
    saveDisabled: document.querySelector('#clip-hotkey-save').disabled,
    help: document.querySelector('#clip-hotkey-help').textContent
  }))()`);
  check('不带修饰键不能保存', bare.saveDisabled === true, JSON.stringify(bare));
  check('不带修饰键有明确提示', bare.help.includes('Ctrl'), bare.help);

  await run(`(() => {
    const target = document.querySelector('#clip-hotkey-capture');
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', code: 'KeyH', ctrlKey: true, altKey: true, bubbles: true }));
  })()`);
  await sleep(150);
  const candidate = await run(`(() => ({
    text: document.querySelector('#clip-hotkey-capture').textContent,
    saveDisabled: document.querySelector('#clip-hotkey-save').disabled
  }))()`);
  check('合法候选可保存', candidate.saveDisabled === false, JSON.stringify(candidate));
  check('候选按显示格式回显', candidate.text === 'Ctrl + Alt + H', candidate.text);

  await run(`document.querySelector('#clip-hotkey-save').click()`);
  await sleep(300);
  const saved = await run(`(() => ({
    display: document.querySelector('#clip-hotkey-display').textContent,
    hidden: document.querySelector('#clip-hotkey-editor').hidden
  }))()`);
  const savedCall = calls.find(call => call.name === 'shot:set-clipboard-hotkey');
  check('保存带 token 打到主进程', Boolean(savedCall) && savedCall.args[1] === 'clip-lease', JSON.stringify(savedCall));
  check('保存后回填新键', saved.display === 'Ctrl + Alt + H', saved.display);
  check('保存后收起编辑器', saved.hidden === true, String(saved.hidden));
  check('改键期间没有触发截图改键通道', !calls.some(call => call.name === 'shot:begin-hotkey-edit'));

  // 5. 取消路径：打开后再按 Esc，编辑器收起、走 end 通道。
  await run(`document.querySelector('#clip-hotkey-button').click()`);
  await sleep(250);
  const endBefore = calls.filter(call => call.name === 'shot:end-hotkey-edit').length;
  await win.webContents.executeJavaScript(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`, true);
  await sleep(250);
  const cancelled = await run(`document.querySelector('#clip-hotkey-editor').hidden`);
  const endAfter = calls.filter(call => call.name === 'shot:end-hotkey-edit').length;
  check('Esc 收起编辑器', cancelled === true, String(cancelled));
  check('Esc 结束租约', endAfter === endBefore + 1, `${endBefore} → ${endAfter}`);

  console.log(JSON.stringify({
    results,
    failures,
    consoleErrors,
    clipCalls: calls.filter(call => call.name.startsWith('shot:set-clipboard') || call.name.includes('clipboard')),
    userData
  }, null, 2));
  try { win.destroy(); } catch { /* 已销毁。 */ }
  app.exit(failures.length ? 1 : 0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});

setTimeout(() => { console.error('超时退出'); app.exit(2); }, 30000);
