'use strict';
// 深色主题的样式契约：dark-only 共享 theme.css + 每页最后引入 + 透明根/整图不加滤镜。
// 这些断言只读 CSS/HTML 文本，不启动 Electron，也不需要真实绘制。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = path.join(__dirname, '..', 'renderer');
const read = name => fs.readFileSync(path.join(renderer, name), 'utf8');
const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
const theme = stripComments(read('theme.css'));

// 取出 @media (prefers-color-scheme: dark) 的完整块（配平花括号）。
function darkBlock(css) {
  const start = css.indexOf('@media (prefers-color-scheme: dark)');
  assert.ok(start >= 0, 'theme.css 必须有 @media (prefers-color-scheme: dark)');
  const from = css.indexOf('{', start) + 1;
  let depth = 1;
  for (let i = from; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') { depth -= 1; if (depth === 0) return { before: css.slice(0, start), inside: css.slice(from, i) }; }
  }
  throw new Error('@media (prefers-color-scheme: dark) 没有配平');
}
const split = darkBlock(theme);
const rules = css => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, head, body]) => ({ selector: head.trim().replace(/\s+/g, ' '), body }));
const rule = (css, selector) => {
  const hit = rules(css).find(item => item.selector === selector);
  assert.ok(hit, '缺少规则：' + selector);
  return hit.body;
};
const DARK = split.inside;

test('theme.css 只在 dark media 里改样式，浅色只声明 color-scheme:light', () => {
  assert.match(split.before, /:root\{color-scheme:light\}/);
  assert.equal(rules(split.before).length, 1, 'dark media 之外只允许那条 color-scheme:light');
  assert.match(rule(DARK, ':root'), /color-scheme:dark/);
});

test('深色核心色板落在 token 上，不是逐处硬写', () => {
  const tokens = rule(DARK, 'body:has(> #titlebar)');
  for (const [name, value] of Object.entries({
    '--paper': '#17231f', '--ink': '#e0eee5', '--muted': '#acbfb4', '--line': '#405d4e',
    '--surface': '#202f29', '--hover': '#30483d', '--focus': '#9ed3b6'
  })) assert.ok(tokens.includes(`${name}:${value}`), `${name} 应为 ${value}`);
  const editor = rule(DARK, '.image-editor');
  for (const [name, value] of Object.entries({
    '--ie-paper': '#17231f', '--ie-ink': '#e0eee5', '--ie-muted': '#acbfb4', '--ie-line': '#405d4e',
    '--ie-mint': '#355747', '--ie-edge': '#486959', '--ie-focus': '#e89bb0', '--ie-white': '#202f29'
  })) assert.ok(editor.includes(`${name}:${value}`), `${name} 应为 ${value}`);
  assert.match(rule(DARK, 'body:has(> #record)'), /--mint:#355747/);
  assert.match(rule(DARK, 'body:has(> header > #height)'), /--ink:#e0eee5/);
});

test('主按钮是浅绿底深绿字，选中/悬停用暗绿面', () => {
  assert.match(rule(DARK, '#actions #copy'), /background:#b6dbc6/);
  assert.match(rule(DARK, '#actions #copy'), /color:#17231f/);
  assert.match(rule(DARK, '.image-editor button.ie-primary'), /background:#b6dbc6/);
  assert.match(rule(DARK, '.image-editor button.ie-primary'), /color:#17231f/);
  assert.match(rule(DARK, '.image-editor button[aria-pressed=true]'), /background:#355747/);
  assert.match(rule(DARK, '.image-editor button:hover:not(:disabled)'), /background:#30483d/);
  assert.match(rule(DARK, 'body:has(> #record) #copy,body:has(> #record) #stop'), /background:#b6dbc6/);
});

test('深色覆盖了标题栏、提示、动作条、预览壳、确认面板与时间轴', () => {
  for (const selector of ['#hint', '#long-capture-tip', '#actions', '#long-preview', '#viewer-status',
    '.window-titlebar', '.exit-confirm-panel', '#gif-editor', '.image-editor .ie-warning']) {
    const body = rule(DARK, selector);
    assert.match(body, /background:#/, selector + ' 要有自己的深色底');
  }
  assert.match(rule(DARK, '.window-titlebar'), /background:#21382d/);
  assert.match(rule(DARK, '#hint'), /color:#e0eee5/);
  assert.match(rule(DARK, '.exit-confirm-panel'), /color:#e0eee5|border-color:#486959/);
  assert.match(rule(DARK, '#gif-editor'), /color:#e0eee5/);
});

test('透明根不被铺底：不给 :root/html/body 通用背景，遮罩与预览外壳只换色', () => {
  const banned = rules(DARK).filter(item => ['html', 'body', ':root'].includes(item.selector) && /(^|;)background(:|-color)?:/.test(item.body));
  assert.deepEqual(banned.map(item => item.selector), [], '透明根/页面根不允许写 background');
  assert.equal(rules(DARK).filter(item => ['#veil', '#box', '.shade', '.exit-confirm-overlay', '#image-viewer'].includes(item.selector)
    && /(^|;)background:/.test(item.body)).length, 0, '遮罩/整屏层不能改 background（alpha 与黑蒙版必须原样）');
  assert.match(rule(DARK, '.exit-confirm-overlay'), /^color:/);
});

test('不给图片和画布加滤镜，也不碰绘图/导出路径', () => {
  const flat = DARK.replace(/\s+/g, '');
  assert.doesNotMatch(flat, /(?:^|[;{])filter:/);
  assert.doesNotMatch(flat, /backdrop-filter/);
  assert.doesNotMatch(flat, /(?:^|[;{])opacity:/);
  assert.doesNotMatch(DARK, /(^|[\s,{}])(img|canvas|video)\b/i, 'theme.css 不应直接选中 img/canvas/video');
  for (const name of ['image-editor.js', 'gif-editor.js', 'selection.js', 'scroll-bar.js']) {
    assert.doesNotMatch(read(name), /theme\.css|data-theme/, name + ' 不应出现主题脚本/主题属性');
  }
});

test('六个页面都在最后引入 theme.css（index 由主作者挂）', () => {
  const pages = ['index.html', 'selection.html', 'image-editor-window.html', 'gif-recorder.html', 'scroll-bar.html', 'scroll-mask.html'];
  for (const page of pages) {
    const html = read(page);
    const links = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map(match => match[1]);
    assert.ok(links.length > 0, page + ' 没有任何样式表');
    assert.equal(links[links.length - 1], 'theme.css', page + ' 的 theme.css 必须是最后一个样式表');
    assert.equal(links.filter(href => href === 'theme.css').length, 1, page + ' 只能引入一次 theme.css');
  }
});

test('深色 token 的页钩子在各页 DOM 里真的成立（#height 不是 body 直接子元素）', () => {
  const index = read('index.html');
  assert.match(index, /<body[^>]*>\s*<header id="titlebar"/, 'index 的 #titlebar 必须是 body 直接子元素');
  const bar = read('scroll-bar.html');
  assert.match(bar, /<header[^>]*>\s*<strong id="height"/, 'scroll-bar 的 #height 在 header 里');
  assert.match(read('gif-recorder.html'), /<body>\s*<section id="record"/, 'gif-recorder 的 #record 必须是 body 直接子元素');
  assert.match(read('image-editor-window.html'), /<section id="editor-root"/, '编辑窗要有 #editor-root');
});

test('不改探针/边框页：gif-border、target、overlay 不引入 theme.css', () => {
  for (const page of ['gif-border.html', 'target.html', 'overlay.html']) {
    assert.doesNotMatch(read(page), /theme\.css/, page + ' 不应引入主题样式');
  }
  assert.doesNotMatch(read('gif-border.css'), /var\(--(?:theme|paper|bg|ink)/, '录制边框色保持原常量');
});
