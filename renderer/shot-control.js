'use strict';
const hotkeyBadge = document.querySelector('#hotkey-badge');
const hotkeyButton = document.querySelector('#hotkey-button');
const hotkeyHelp = document.querySelector('#hotkey-help');
const hotkeyDisplay = document.querySelector('#hotkey-display');
// 改键编辑器（UI 作者提供的容器与按钮；旧页面没有时“更改”会就地提示而不是暂停快捷键）。
const hotkeyEditor = document.querySelector('#hotkey-editor');
const hotkeyCapture = document.querySelector('#hotkey-capture');
const hotkeySave = document.querySelector('#hotkey-save');
const hotkeyCancel = document.querySelector('#hotkey-cancel');
const autoLaunch = document.querySelector('#auto-launch');
const saveFolder = document.querySelector('#save-folder');
const shotStatus = document.querySelector('#shot-status');
const take = document.querySelector('#take');
const retry = document.querySelector('#retry');
const openLast = document.querySelector('#open-last');
const diagnosticsOpen = document.querySelector('#diagnostic-open');
const diagnosticsStatus = document.querySelector('#diagnostic-status');
// 界面主题：三个真实 button，互斥 aria-pressed；请求在飞时按钮临时禁用，状态回包不抢正在提交的选择。
const themeButtons = [...document.querySelectorAll('[data-theme-source]')];
let themePending = false;

let lastState;
// 改键状态：hotkeyEdit 只在录入中非空；begin 在飞/回包前已取消/保存中各自一个标记。
let hotkeyEdit = null;
let hotkeyBeginPending = false;
let hotkeyCancelPending = false;
let hotkeySaving = false;

const DEFAULT_HELP = '点击后按新组合键，Esc 取消。';
const reportError = error => {
  shotStatus.textContent = `未完成：${error.message}`;
  shotStatus.classList.add('warning');
};
const helpText = text => setHelp(text, false);

function paintTheme(source) {
  const value = ['system', 'light', 'dark'].includes(source) ? source : 'system';
  for (const button of themeButtons) button.setAttribute('aria-pressed', String(button.dataset.themeSource === value));
}

async function chooseTheme(button) {
  const source = button?.dataset?.themeSource;
  if (!source || themePending || button.disabled) return;
  themePending = true;
  for (const item of themeButtons) item.disabled = true;
  // 先按用户的选择回填（主进程几乎同步生效）：待存档期间别的状态回包也不会把它抢回去。
  paintTheme(source);
  try {
    const next = await window.shot.setTheme(source);
    themePending = false;      // 先解开，再让 showState 正常回填成功的值
    showState(next);
  } catch (error) {
    // 失败回显旧态并提示：保存没成功就不能假装已经换了主题。
    paintTheme(lastState?.theme?.source);
    reportError(error);
  } finally {
    themePending = false;
    for (const item of themeButtons) item.disabled = false;
  }
}

for (const button of themeButtons) button.addEventListener('click', () => chooseTheme(button));

function showState(state) {
  lastState = state;
  hotkeyBadge.textContent = state.hotkeyEditing ? '正在修改快捷键…'
    : state.hotkeyRegistered ? `${state.hotkeyLabel} 已注册` : `${state.hotkeyLabel} 没注册上`;
  hotkeyBadge.classList.toggle('warning', !state.hotkeyEditing && !state.hotkeyRegistered);
  retry.hidden = Boolean(state.hotkeyRegistered) || Boolean(state.hotkeyEditing);
  // 当前键只写独立显示位；按钮文字固定“更改”，不随状态改。
  if (hotkeyDisplay) hotkeyDisplay.textContent = state.hotkeyLabel;
  // 主进程已经收掉租约（失焦/崩溃/退出）时，收起残留的编辑器；begin 回包 state=true 不会误关。
  if (state.hotkeyEditing !== true && hotkeyEdit) closeHotkeyEditor({ focusButton: false });
  shotStatus.textContent = state.message;
  shotStatus.classList.toggle('warning', Boolean(state.error));
  autoLaunch.setAttribute('aria-checked', state.autoLaunch ? 'true' : 'false');
  // 只在没有主题请求在飞时回填：否则别的状态回包会把用户刚点的选择抢回去。
  if (!themePending && state.theme) paintTheme(state.theme.source);
  saveFolder.textContent = state.saveFolder || '（还没设置）';
  saveFolder.title = state.saveFolder || '';
  if (state.file) openLast.hidden = false;
  const diagnostic = state.diagnostic || {};
  diagnosticsOpen.disabled = !diagnostic.hasReport;
  diagnosticsStatus.textContent = diagnostic.error || (diagnostic.recording
    ? diagnostic.limited ? '本轮详细采样已达上限，完成结果仍会自动记录。' : '正在自动记录本次长截图，不影响保存或复制。'
    : diagnostic.writing ? '正在写完本轮后台记录…' : diagnostic.hasReport ? '本轮记录已留在本机；照常截图，需要时再排查。' : '正常长截图会自动留下排查摘要。');
}

// 组合键只认这些写法：功能键可单用，字母数字必须带修饰键。
const NAMED = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Space: 'Space', Tab: 'Tab', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' };
const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;
function acceleratorFrom(event) {
  const modifiers = [];
  if (event.ctrlKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push('Super');
  const code = event.code || '';
  let key;
  if (FUNCTION_KEY.test(event.key)) key = event.key;
  else if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (NAMED[code]) key = NAMED[code];
  else return { message: '这个键不能当快捷键，换个功能键或者加 Ctrl／Alt／Shift 的字母数字。' };
  if (!modifiers.length && !FUNCTION_KEY.test(key)) return { message: '单键只能用功能键，字母数字要加 Ctrl、Alt 或 Shift。' };
  return { accelerator: [...modifiers, key].join('+') };
}

// —— 改键：更改 → 录入候选 → 明确保存/取消 ——
// 候选只存在本页；保存才交给主进程。录入期间的全局键已由主进程暂停，按 F1 不会触发截图。
const editorReady = () => Boolean(hotkeyEditor && hotkeyCapture && hotkeySave && hotkeyCancel);
function captureText(text) { if (hotkeyCapture) hotkeyCapture.textContent = text; }
// 就地提示：出错时就该红一行（UI 作者的 .hotkey-help.warning）。
function setHelp(text, warning = false) {
  hotkeyHelp.textContent = text;
  hotkeyHelp.classList.toggle('warning', warning === true);
}
// 录入中的高亮（UI 作者的 .keycap-capture.recording / #hotkey-button.recording）。
function setRecordingClass(on) {
  try { hotkeyCapture?.classList.toggle('recording', on === true); } catch { /* 忽略。 */ }
  try { hotkeyButton.classList.toggle('recording', on === true); } catch { /* 忽略。 */ }
}
// 按钮可用性只跟“当前模式 + 候选”走：合法候选才启用保存，保存中全锁。
function syncHotkeyControls() {
  const editing = Boolean(hotkeyEdit);
  if (hotkeySave) hotkeySave.disabled = !(editing && hotkeyEdit.candidate) || hotkeySaving;
  if (hotkeyCancel) hotkeyCancel.disabled = hotkeySaving || (!editing && !hotkeyBeginPending);
  if (hotkeyCapture) hotkeyCapture.disabled = hotkeySaving || !editing;
  hotkeyButton.disabled = hotkeySaving || hotkeyBeginPending || editing;
}
function focusHotkeyButton() {
  // 保存中按钮是禁用的，不能把焦点送进虚空；页面已失焦（blur）时也不抢回来。
  if (!hotkeyButton || hotkeyButton.disabled) return;
  let active = true;
  try { active = typeof document.hasFocus !== 'function' || document.hasFocus() === true; } catch { active = false; }
  if (!active) return;
  try { hotkeyButton.focus({ preventScroll: true }); } catch { /* 忽略。 */ }
}
function openHotkeyEditor(token) {
  hotkeyEdit = { token, candidate: null };
  if (hotkeyEditor) hotkeyEditor.hidden = false;
  hotkeyButton.setAttribute('aria-expanded', 'true');
  setRecordingClass(true);
  captureText('按下新组合键…');
  setHelp('按下新组合键；Enter 保存，Esc 取消；Tab 可移到保存/取消。');
  syncHotkeyControls();
  try { hotkeyCapture?.focus({ preventScroll: true }); } catch { /* 聚焦失败仍可点按钮。 */ }
}
function closeHotkeyEditor({ focusButton = true } = {}) {
  hotkeyEdit = null;
  if (hotkeyEditor) hotkeyEditor.hidden = true;
  hotkeyButton.setAttribute('aria-expanded', 'false');
  setRecordingClass(false);
  captureText('');
  syncHotkeyControls();
  if (focusButton) focusHotkeyButton();
}

async function beginHotkeyEdit() {
  if (hotkeyEdit || hotkeyBeginPending || hotkeySaving) return;
  if (!editorReady()) { setHelp('界面还没准备好，稍后再试。', true); return; }
  hotkeyBeginPending = true;
  hotkeyCancelPending = false;
  syncHotkeyControls();
  try {
    const reply = await window.shot.beginHotkeyEdit();
    const state = reply && reply.state ? reply.state : reply;
    const token = reply && reply.token;
    // 回包前已要求取消（Esc / 失焦 / 页面卸载）：不打开编辑器，但要把主进程的租约结束掉。
    if (hotkeyCancelPending) {
      hotkeyCancelPending = false;
      if (token) {
        try { const restored = await window.shot.endHotkeyEdit(token); if (restored) showState(restored); }
        catch { /* 主进程已自行恢复（blur/关窗），不必再报。 */ }
      }
      setHelp(DEFAULT_HELP);
      return;
    }
    if (state) showState(state);
    if (!token) throw new Error('这次改键没有开始');
    openHotkeyEditor(token);
  } catch (error) {
    setHelp(`没能开始改键：${error.message}`, true);
  } finally {
    hotkeyBeginPending = false;
    syncHotkeyControls();
  }
}

async function saveHotkeyEdit() {
  if (!hotkeyEdit || !hotkeyEdit.candidate || hotkeySaving) return;
  const candidate = hotkeyEdit.candidate, token = hotkeyEdit.token;
  hotkeySaving = true;
  syncHotkeyControls();
  try {
    const state = await window.shot.setHotkey(candidate, token);
    closeHotkeyEditor({ focusButton: false });
    if (state) showState(state);
    setHelp(`已经生效：${candidate.split('+').join(' + ')}。`);
  } catch (error) {
    // 失败保留候选与租约：旧键仍在主进程那里待取消恢复，可以改个候选再试。
    setHelp(`没能保存：${error.message}；可以再试或取消（Esc）。`, true);
    captureText(candidate.split('+').join(' + '));
  } finally {
    hotkeySaving = false;
    syncHotkeyControls();
    // 成功时编辑器已关：解禁后才会真正拿到焦点；失焦的页面不抢。
    if (!hotkeyEdit) focusHotkeyButton();
  }
}

async function cancelHotkeyEdit() {
  if (hotkeySaving) return;
  if (!hotkeyEdit) {
    // begin 还没回包：记下来，回包后立刻结束租约。
    if (hotkeyBeginPending) hotkeyCancelPending = true;
    return;
  }
  const token = hotkeyEdit.token;
  closeHotkeyEditor();
  setHelp(DEFAULT_HELP);
  try { const state = await window.shot.endHotkeyEdit(token); if (state) showState(state); }
  catch (error) { setHelp(`取消没能确认：${error.message}`, true); }
}

// 录入只发生在 capture 里：其它输入框/按钮的键盘不受影响。
if (hotkeyCapture) {
  hotkeyCapture.addEventListener('keydown', event => {
    if (!hotkeyEdit || hotkeySaving || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelHotkeyEdit(); return; }
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); saveHotkeyEdit(); return; }
    // 普通 Tab / Shift+Tab 导航；带 Ctrl / Alt 的 Tab 仍可作为候选。
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) return;
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) {
      event.preventDefault();
      hotkeyEdit.candidate = null;
      syncHotkeyControls();
      const modifiers = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Super'].filter(Boolean);
      captureText(modifiers.length ? `${modifiers.join(' + ')} + …` : '按下新组合键…');
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const parsed = acceleratorFrom(event);
    if (!parsed.accelerator) {
      hotkeyEdit.candidate = null;
      captureText('按下新组合键…');
      syncHotkeyControls();
      setHelp(parsed.message, true);
      return;
    }
    hotkeyEdit.candidate = parsed.accelerator;
    captureText(parsed.accelerator.split('+').join(' + '));
    syncHotkeyControls();   // 有合法候选才启用“保存快捷键”
    setHelp(`候选 ${parsed.accelerator.split('+').join(' + ')} · Enter 保存，Esc 取消。`);
  });
  hotkeyCapture.addEventListener('click', event => event.preventDefault());
}
if (hotkeySave) hotkeySave.addEventListener('click', () => saveHotkeyEdit());
if (hotkeyCancel) hotkeyCancel.addEventListener('click', () => cancelHotkeyEdit());

hotkeyButton.onclick = () => beginHotkeyEdit();

// 编辑中整窗口 Esc 也能取消（焦点不在 capture 上时人也能退出）。
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (!hotkeyEdit && !hotkeyBeginPending) return;
  event.preventDefault();
  cancelHotkeyEdit();
}, true);
// 失焦/页面卸载：主进程会结束租约并恢复原键；在飞的 begin 标记为取消，晚回包不会再开编辑器。
const abandonHotkeyEdit = () => {
  if (hotkeyBeginPending) hotkeyCancelPending = true;
  if (hotkeyEdit) { closeHotkeyEditor({ focusButton: false }); setHelp(DEFAULT_HELP); }
  else syncHotkeyControls();
};
window.addEventListener('blur', abandonHotkeyEdit);
window.addEventListener('pagehide', abandonHotkeyEdit);

autoLaunch.onclick = async () => {
  autoLaunch.disabled = true;
  try { showState(await window.shot.setAutoLaunch(!(lastState?.autoLaunch === true))); }
  catch (error) { reportError(error); }
  finally { autoLaunch.disabled = false; }
};

document.querySelector('#choose-folder').onclick = async () => {
  try { showState(await window.shot.chooseSaveFolder()); } catch (error) { reportError(error); }
};
document.querySelector('#open-directory').onclick = () => window.shot.openDirectory().catch(reportError);

// 单一设置页包含截图入口；帮助独立展示。
const navigation = document.querySelectorAll('nav [data-section]');
const homeSection = document.querySelector('#home');
const settingsSection = document.querySelector('#settings');
const helpSection = document.querySelector('#help');
function focusSection(section, focus = true) {
  if (!['settings', 'help'].includes(section)) return;
  if (hotkeyEdit || hotkeyBeginPending) cancelHotkeyEdit();
  homeSection.hidden = section === 'help';
  settingsSection.hidden = section === 'help';
  helpSection.hidden = section !== 'help';
  navigation.forEach(button => {
    if (button.dataset.section === section) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (focus) {
    const target = section === 'settings' ? hotkeyButton : document.querySelector('#help-label');
    target.focus({ preventScroll: true });
    document.querySelector('#page-content').scrollTo({ top: 0, behavior: 'instant' });
  }
}
navigation.forEach(button => {
  button.addEventListener('click', () => focusSection(button.dataset.section));
});
focusSection('settings', false);

window.shot.onStatus(showState);
// 保留旧版托盘「设置」事件，兼容尚未提供新订阅接口的 preload。
window.shot.onFocusSettings(() => focusSection('settings'));
window.shot.onFocusSection?.(section => focusSection(section));
window.shot.state().then(showState).catch(reportError);

take.onclick = async () => {
  take.disabled = true;
  shotStatus.textContent = '正在准备框选…';
  try { await window.shot.start(); } catch (error) { reportError(error); }
  finally { take.disabled = false; }
};
retry.onclick = async () => {
  retry.disabled = true;
  try { showState(await window.shot.retryHotkey()); } catch (error) { reportError(error); }
  finally { retry.disabled = false; }
};
openLast.onclick = () => window.shot.openLast().catch(reportError);
diagnosticsOpen.onclick = () => window.shot.openDiagnostic().catch(reportError);

// 原生窗口负责拖动、缩放与关闭后的托盘行为，页面仅发送控制请求。
const maximizeButton = document.querySelector('#window-maximize');
const maximizeIcon = document.querySelector('#window-maximize-icon');
const restoreIcon = document.querySelector('#window-restore-icon');
function showWindowState(state) {
  const maximized = Boolean(state.maximized);
  const label = maximized ? '还原窗口' : '最大化';
  maximizeButton.setAttribute('aria-label', label);
  maximizeButton.title = label;
  maximizeIcon.toggleAttribute('hidden', maximized);
  restoreIcon.toggleAttribute('hidden', !maximized);
}
let windowStateReceived = false;
window.shot.onWindowState?.(state => {
  windowStateReceived = true;
  showWindowState(state);
});
// 若初始化请求晚于最大化事件返回，以事件中的新状态为准。
window.shot.windowState?.().then(state => {
  if (!windowStateReceived) showWindowState(state);
}).catch(reportError);
for (const [id, method] of [
  ['window-minimize', 'minimizeWindow'],
  ['window-maximize', 'toggleMaximize'],
  ['window-close', 'closeWindow']
]) {
  const button = document.querySelector(`#${id}`);
  button.onclick = async () => {
    button.disabled = true;
    try { await window.shot[method](); }
    catch (error) { reportError(error); }
    finally { button.disabled = false; }
  };
}
