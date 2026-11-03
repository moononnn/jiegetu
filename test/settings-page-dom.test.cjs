'use strict';
// 设置页 DOM 契约：逻辑作者（shot-control.js）与主进程依赖的 id/文本/结构必须唯一且齐全。
// 只读 HTML/CSS 文本，不启动 Electron；对应的深色规则见 theme-style.test.cjs。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = path.join(__dirname, '..', 'renderer');
const read = name => fs.readFileSync(path.join(renderer, name), 'utf8');
const html = read('index.html');
const css = read('style.css');
const theme = read('theme.css');

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
const idCount = id => ids.filter(id => id === idCount.id).length;
void idCount;

test('所有被脚本/主进程引用的 id 都在且只出现一次', () => {
  const required = ['titlebar', 'window-minimize', 'window-maximize', 'window-close',
    'home', 'settings', 'help', 'capture-label', 'settings-label', 'help-label', 'page-content',
    'take', 'retry', 'hotkey-badge', 'desktop-help',
    'hotkey-display', 'hotkey-button', 'hotkey-help', 'hotkey-editor', 'hotkey-capture', 'hotkey-save', 'hotkey-cancel',
    'auto-launch', 'theme-group', 'save-folder', 'choose-folder', 'open-directory',
    'shot-status', 'open-last', 'diagnostic-open', 'diagnostic-status', 'displays', 'start', 'status', 'result', 'screen', 'sample'];
  for (const id of required) {
    assert.equal(ids.filter(value => value === id).length, 1, `#${id} 必须恰好出现一次`);
  }
  const dup = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual(dup, [], '不能有重复 id：' + dup.join(','));
});

test('快捷键区：键帽显示当前值，按钮只负责“更改”，编辑器默认收起', () => {
  const display = html.match(/<kbd id="hotkey-display"[^>]*>([^<]*)<\/kbd>/);
  assert.ok(display, '缺少 #hotkey-display 键帽');
  assert.equal(display[1].trim(), 'F1', '键帽初始文本应为当前值 F1');
  const button = html.match(/<button id="hotkey-button"[^>]*>([^<]*)<\/button>/);
  assert.ok(button, '缺少 #hotkey-button');
  assert.equal(button[1].trim(), '更改', '#hotkey-button 只当“更改”按钮，不再显示快捷键');
  assert.match(html, /<button id="hotkey-button"[^>]*aria-describedby="hotkey-help"/);
  const editor = html.match(/<div id="hotkey-editor"[^>]*>/);
  assert.ok(editor, '缺少 #hotkey-editor');
  assert.match(editor[0], /\shidden(\s|>)/, '#hotkey-editor 默认必须 hidden');
  const capture = html.match(/<button id="hotkey-capture"[^>]*>([^<]*)<\/button>/);
  assert.ok(capture, '缺少 #hotkey-capture');
  assert.match(html, /<button id="hotkey-capture"[^>]*type="button"/);
  assert.match(html, /<button id="hotkey-capture"[^>]*aria-label="[^"]+"/);
  assert.match(html, /<button id="hotkey-capture"[^>]*aria-describedby="hotkey-help"/);
  assert.equal(capture[1].trim(), '按下新的组合键');
  const save = html.match(/<button id="hotkey-save"[^>]*>([^<]*)<\/button>/);
  assert.ok(save, '缺少 #hotkey-save');
  assert.match(html, /<button id="hotkey-save"[^>]*\sdisabled(\s|>)/, '保存快捷键初始应 disabled');
  assert.match(html, /<button id="hotkey-save"[^>]*type="button"/);
  assert.equal(save[1].trim(), '保存快捷键');
  const cancel = html.match(/<button id="hotkey-cancel"[^>]*>([^<]*)<\/button>/);
  assert.ok(cancel, '缺少 #hotkey-cancel');
  assert.equal(cancel[1].trim(), '取消');
  assert.match(html, /id="hotkey-help"[^>]*role="status"/);
  assert.match(html, /id="hotkey-help"[^>]*aria-live="polite"/);
  assert.match(html, /<span id="hotkey-badge"[^>]*>/, '缺少 #hotkey-badge 注册状态');
});

test('左窄导航 + 右内容：nav [data-section] 互斥、aria-controls 指向真实分区', () => {
  const navs = [...html.matchAll(/<button[^>]*class="nav-item"[^>]*data-section="(\w+)"[^>]*>/g)];
  assert.deepEqual(navs.map(m => m[1]), ['settings', 'help']);
  assert.match(navs[0][0], /aria-current="page"/);
  assert.doesNotMatch(navs[1][0], /aria-current=/);
  assert.match(navs[0][0], /aria-controls="home settings"/);
  assert.match(navs[1][0], /aria-controls="help"/);
  assert.match(css, /\.app-main\s*\{[^}]*grid-template-columns:\s*148px/, '左栏基准 148px');
  assert.match(css, /@media \(max-width: 680px\)[\s\S]*?grid-template-columns:\s*132px/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?grid-template-columns:\s*128px/, '窄窗 128px');
  assert.match(css, /\.page-scroll\s*\{[^}]*overflow:\s*auto/);
});

test('三段式设置：快捷键 / 使用偏好（开机自启 + 三段主题）/ 保存位置', () => {
  const settings = html.slice(html.indexOf('id="settings"'), html.indexOf('id="help"'));
  for (const title of ['快捷键', '使用偏好', '保存位置']) {
    assert.ok(settings.includes(`class="group-title">${title}<`), '缺少分组标题：' + title);
  }
  assert.equal((settings.match(/class="group"/g) || []).length, 3, '恰好三组，线性分隔');
  const themes = [...settings.matchAll(/data-theme-source="(\w+)"[^>]*aria-pressed="(\w+)"/g)];
  assert.deepEqual(themes.map(m => m[1]), ['system', 'light', 'dark']);
  assert.equal(themes.filter(m => m[2] === 'true').length, 1, '主题三段必须恰好一个选中');
  assert.match(settings, /id="auto-launch"[^>]*class="switch"[^>]*role="switch"/);
  assert.match(settings, /id="save-folder"[^>]*class="folder-path"/, '保存目录独占一行且可省略');
  assert.match(css, /\.folder-path\s*\{[^}]*text-overflow:\s*ellipsis/);
});

test('截图区只留一句说明，长段迁到帮助，且不宣称跨屏长图/GIF', () => {
  const home = html.slice(html.indexOf('id="home"'), html.indexOf('id="settings"'));
  assert.match(home, /<h2 id="capture-label"[^>]*>开始截图<\/h2>/);
  assert.match(home, /按快捷键，或点击按钮框选。/);
  assert.match(home, /id="desktop-help"[^>]*>框选后可编辑、复制，或继续接长图、录制 GIF。<\/p>/);
  assert.doesNotMatch(home, /跨屏|套娃|36M/, '顶部不再放长段说明');
  assert.match(home, /id="take"[^>]*class="primary"/, '开始截图仍是主按钮');
  assert.match(home, /id="hotkey-badge"[^>]*class="badge"/, '快捷键 badge 是状态');
  const help = html.slice(html.indexOf('id="help"'));
  assert.match(help, /截图直接盖住整组屏幕/, '原来的整屏框选说明保留在帮助里');
  assert.match(help, /36M 像素/);
  assert.match(help, /左键单击托盘图标打开设置窗口；右键打开快捷菜单/);
  assert.match(help, /点「更改」，按下新的组合键后点「保存快捷键」/);
  assert.match(help, /关闭设置窗口只会回到托盘/);
});

test('底部状态常驻单行，隐藏的故障排查/开发探针 DOM 全部保留', () => {
  assert.doesNotMatch(html, /<p id="shot-status"[^>]*\shidden/, '#shot-status 不能被隐藏');
  assert.match(css, /#shot-status\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(css, /#shot-status\s*\{[^}]*white-space:\s*nowrap/);
  for (const id of ['troubleshooting', 'displays', 'start', 'status', 'result', 'screen', 'sample']) {
    assert.ok(html.includes(`id="${id}"`), '开发/排查 DOM 不能丢：' + id);
  }
  assert.match(html, /<details id="troubleshooting">/);
});

test('通用按钮的排除条件不抬高优先级，主按钮与录入框可覆盖基础配色', () => {
  assert.match(css, /button:where\(:not\(\.switch\):not\(\.window-button\):not\(\.nav-item\):not\(#theme-group button\)\)/);
  assert.doesNotMatch(css, /button:not\(\.switch\):not\(\.window-button\):not\(\.nav-item\):not\(#theme-group button\)/);
});

test('样式只落在控制页：标题栏深色走 body:has(> #titlebar)，不泛化到全局', () => {
  assert.match(html, /<body class="settings-page">/);
  assert.equal((html.match(/class="app-icon"/g) || []).length, 1, '应用图标仍复用现有资源');
  assert.match(theme, /body:has\(> #titlebar\) \.titlebar\{background:#21382d\}/);
  assert.match(theme, /body:has\(> #titlebar\) \.keycap\{/);
  assert.match(css, /kbd|--font-code: 'Cascadia Mono', Consolas/);
  assert.doesNotMatch(css, /img\s*\{[^}]*filter|canvas\s*\{[^}]*filter/, '控制页不给图片/画布加滤镜');
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(scripts, ['shot-control.js', 'probe.js'], '不新增脚本');
});
