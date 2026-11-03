'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const css = fs.readFileSync(path.join(__dirname, '../renderer/selection.css'), 'utf8');
const editorCss = fs.readFileSync(path.join(__dirname, '../renderer/image-editor.css'), 'utf8');
const block = selector => {
  const match = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, head]) => head.trim() === selector);
  assert.ok(match, selector);
  return match[2];
};
test('长图预览仅背景半透明，不降低整层或截图的不透明度', () => {
  const viewer = block('#image-viewer');
  assert.match(viewer, /background:rgba\(10,31,25,\.34\)/);
  assert.doesNotMatch(viewer, /(?:^|;)opacity:/);
  const image = block('#viewer-image');
  assert.match(image, /background:#f7faf6/);
  assert.doesNotMatch(image, /(?:^|;)opacity:/);
});
test('顶栏不再整屏铺实色，控件和提示各保留可读底色', () => {
  assert.match(block('.viewer-header'), /background:transparent/);
  assert.match(block('.viewer-controls'), /background:#f7faf6/);
  assert.match(block('#viewer-status'), /width:max-content/);
});
test('仅移除滚动区整屏系统焦点边线，保留局部键盘焦点提示与按钮轮廓', () => {
  assert.match(block('#viewer-scroll:focus'), /outline:none/);
  assert.match(block('body:has(#viewer-scroll:focus-visible) #viewer-status'), /box-shadow:0 0 0 2px #a8cbb9/);
  assert.match(block('.viewer-controls button:focus-visible'), /outline:3px solid #e89bb0/);
  assert.match(block('#viewer-scroll'), /cursor:grab/);
});
test('预览打开时隐藏底下缩略图及旧遮罩，关闭时由CSS自动恢复', () => {
  for (const id of ['long-preview', 'hint', 'veil', 'box']) {
    assert.ok(css.includes(`body:has(#image-viewer:not([hidden])) #${id}`));
  }
  assert.match(css, /#box\{visibility:hidden\}/);
  assert.match(css, /@media\(max-width:640px\).*max-width:calc\(100% - 32px\)/);
});
test('关系下拉用原生 base-select 定制成纸白/浅绿，只作用于它、不加动画、不外溢', () => {
  // 注释里也会提到 ::picker，先去掉注释再查规则。
  const code = editorCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const start = code.indexOf('@supports (appearance:base-select)');
  assert.ok(start >= 0, '高级规则要在 @supports (appearance:base-select) 里');
  let depth = 1, end = -1;
  const from = code.indexOf('{', start) + 1;
  for (let i = from; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > from, '@supports 块要配平');
  const section = code.slice(from, end);
  const rule = (selector, source = section) => {
    const match = source.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^{}]*)\\}'));
    assert.ok(match, selector);
    return match[1];
  };
  const scope = '.image-editor select[data-setting="relation"]';
  // select 与 picker 必须同时 base-select，谈层才接管；不支持时退回原生 select。
  assert.equal((section.match(/appearance:base-select/g) || []).length, 2, '刚好两处 base-select：select 与 ::picker(select)');
  assert.match(rule(scope), /appearance:base-select/);
  assert.match(rule(`${scope}::picker(select)`), /appearance:base-select/);
  // 弹层：纸白底、细绿边、小阴影、内留白 4px、与锚点间距 4px，不做动画也不靠 fixed 坐标。
  const picker = rule(`${scope}::picker(select)`);
  assert.match(picker, /background:var\(--ie-paper\)/);
  assert.match(picker, /border:1px solid var\(--ie-edge\)/);
  assert.match(picker, /box-shadow:0 6px 18px/);
  assert.match(picker, /padding:4px/);
  assert.match(picker, /margin-block-start:4px/);
  assert.doesNotMatch(picker, /position:fixed/, '不强制定位，留给 top layer 自己避让');
  // 选项：舒适行高、圆角，hover 与 checked 同主题浅绿 + 深绿字，不出系统蓝、不被禁用透明度带累。
  const option = rule(`${scope} option`);
  assert.match(option, /min-height:30px/);
  assert.match(option, /border-radius:[4-6]px/);
  assert.match(option, /background:var\(--ie-paper\)/);
  assert.match(option, /opacity:1/);
  for (const state of ['option:hover', 'option:checked']) {
    const decls = rule(`${scope} ${state}`);
    assert.match(decls, /background:var\(--ie-mint\)/, state);
    assert.match(decls, /color:var\(--ie-ink\)/, state);
    assert.doesNotMatch(decls, /#(?:0{0,2}0?0?ff|1a73e8|0b57d0)/i, `${state} 不能回到系统蓝`);
  }
  assert.match(rule(`${scope} option::checkmark`), /color:var\(--ie-ink\)/, '勾标用主题色');
  // 不加动画：即时响应，不慢弹。
  assert.doesNotMatch(section, /\banimation\b/);
  assert.doesNotMatch(section, /transition:(?!none)[^;]*/);
  // 不外溢：这一块每条规则的头部都限定在这一个下拉上，且只在编辑器根内。
  const heads = section.split('\n').map(line => line.trim()).filter(line => line.includes('{'))
    .map(line => line.slice(0, line.indexOf('{')));
  assert.ok(heads.length >= 5);
  for (const head of heads) {
    assert.ok(head.startsWith('.image-editor '), `只在编辑器内：${head}`);
    assert.match(head, /select\[data-setting="relation"\]/, `只限关系下拉：${head}`);
  }
  for (const line of code.split('\n')) {
    if (!/::picker|(?:^|[\s,{])option\b/.test(line)) continue;
    assert.match(line, /select\[data-setting="relation"\]/, `弹层/选项样式不能写到全局：${line}`);
  }
  assert.match(rule(scope, code), /height:30px/, '不支持 base-select 时也有 30px 高的原生下拉');
  assert.match(rule(`${scope}:focus-visible`, code), /outline:2px solid var\(--ie-focus\)/);
  assert.match(code, /\.image-editor select\{height:26px/, '原全局 select 兜底规则保留，原样不动');
});

test('预览与 GIF 预览把动作、输出、退出分组，输出统一为保存→另存→复制且复制是主按钮', () => {
  const selectionHtml = fs.readFileSync(path.join(__dirname, '../renderer/selection.html'), 'utf8');
  const recorderHtml = fs.readFileSync(path.join(__dirname, '../renderer/gif-recorder.html'), 'utf8');
  const recorderCss = fs.readFileSync(path.join(__dirname, '../renderer/gif-recorder.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  // 分组容器存在，且 CSS 只用间距/分隔线分组，不用 order 把 Tab 顺序和视觉顺序掰开。
  for (const [name, html] of [['selection', selectionHtml], ['gif-recorder', recorderHtml]]) {
    assert.match(html, /class="action-group" role="group"/, `${name} 要有后续操作分组`);
    assert.match(html, /class="action-group action-output" role="group"/, `${name} 要有输出分组`);
    assert.match(html, /class="action-group action-exit" role="group"/, `${name} 要有退出分组`);
  }
  assert.match(block('#actions .action-group + .action-group'), /border-left:1px solid/);
  assert.doesNotMatch(css, /(?:^|[;{\s])order:/, '选择条不靠 order 重排');
  assert.doesNotMatch(recorderCss, /(?:^|[;{\s])order:/, 'GIF 预览不靠 order 重排');
  // 输出顺序两个页统一：另存 → 保存 → 复制；退出（重新框选 / 关闭）在其后。
  for (const [name, html] of [['selection', selectionHtml], ['gif-recorder', recorderHtml]]) {
    const [save, saveAs, copy] = ['save', 'save-as', 'copy'].map(id => html.indexOf(`id="${id}"`));
    assert.ok(saveAs > 0 && saveAs < save && save < copy, `${name} 输出顺序必须是另存 → 保存 → 复制`);
  }
  assert.ok(selectionHtml.indexOf('id="retake"') > selectionHtml.indexOf('id="copy"'), '重新框选放在输出之后');
  assert.ok(recorderHtml.indexOf('id="close"') > recorderHtml.indexOf('id="copy"'), '关闭放在输出之后');
  // 复制是主按钮：选择条墨绿实心，GIF 预览同层；保存/另存是细边次级。
  const flatCss = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const ruleOf = selector => [...flatCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find(([, head]) => head.trim() === selector)?.[2] || '';
  assert.match(block('#actions #copy'), /background:#244e43/);
  assert.match(ruleOf('#actions #save,#actions #retake'), /border:1px solid/, '保存与退出用同一层细边');
  assert.match(recorderCss, /#copy,#stop\{[^}]*background:var\(--ink\)/);
  assert.match(recorderCss, /#cancel,#close,#record-retry\{[^}]*background:var\(--mint\)/, '退出组要看得见');
  assert.match(recorderCss, /button\{[^}]*background:transparent/, '普通按钮不再是实心主按钮');
});

test('GIF 编辑与图片编辑器共用 header 时：动画没有“另存”出口，时间线不会被工具区挤没', () => {
  const gifCss = fs.readFileSync(path.join(__dirname, '../renderer/gif-editor.css'), 'utf8');
  assert.match(gifCss, /#gif-editor \[data-action="save-as"\]\{display:none!important\}/, '动画里隐藏新加的另存');
  assert.match(gifCss, /#gif-editor\{[^}]*grid-template-rows:minmax\(120px,1fr\) auto/, '编辑区保留下限，时间栏占剩余空间');
  assert.match(gifCss, /#gif-editor \.ge-time\{[^}]*min-height:150px/, '时间栏有保底高度');
  const recorderCss = fs.readFileSync(path.join(__dirname, '../renderer/gif-recorder.css'), 'utf8');
  assert.match(recorderCss, /#frame\{flex:1;min-height:0/, '预览图区自己占满剩余高度');
  assert.doesNotMatch(recorderCss, /\.actions\{[^}]*position:absolute/, '操作不浮在图上');
});

test('分组只在整组按钮都隐藏时收起，单个隐藏不牵连同组还能用的按钮', () => {
  const flat = (file) => fs.readFileSync(path.join(__dirname, `../renderer/${file}`), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const selectionCss = flat('selection.css');
  const recorderCss = flat('gif-recorder.css');
  // 语义：组里还有任何一个可见直接按钮就留着整组；全部 hidden（或没有直接按钮）才 display:none。
  assert.ok(selectionCss.includes('#actions .action-group:not(:has(>button:not([hidden]))){display:none}'),
    '选择条要按“整组都隐藏才收起”判定');
  assert.ok(recorderCss.includes('.action-group:not(:has(>button:not([hidden]))){display:none}'),
    'GIF 录制/预览条要按“整组都隐藏才收起”判定');
  // 旧的“任一 hidden 就收起整组”必须已经没有了：它就是 cancel 被 record-retry 带走的根因。
  for (const [name, code] of [['selection.css', selectionCss], ['gif-recorder.css', recorderCss]]) {
    assert.doesNotMatch(code, /\.action-group:has\(>button\[hidden\]\)/, `${name} 不能因单个 hidden 收起整组`);
    // 单个按钮自己还是要消失，否则隐藏状态就失效了。
    assert.match(code, /\[hidden\]\{display:none!important\}/, `${name} 保留单个 [hidden] 的隐藏`);
  }
});

test('各页灰色禁用按钮使用普通箭头，不把不可用状态显示成等待指针', () => {
  for (const name of ['style', 'selection', 'scroll-bar', 'gif-recorder', 'image-editor']) {
    const code = fs.readFileSync(path.join(__dirname, `../renderer/${name}.css`), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(code, /cursor\s*:\s*(?:wait|progress)\b/, `${name} 不再有等待光标`);
    const selector = name === 'image-editor' ? '.image-editor :disabled' : 'button:disabled';
    const rules = [...code.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, head]) => head.split(',').some(part => name === 'image-editor'
        ? part.trim() === selector : /(?:^|\s)button:disabled$/.test(part.trim())));
    assert.ok(rules.length, `${name} 保留禁用规则`);
    for (const [, , declarations] of rules) assert.match(declarations, /(?:^|;)\s*cursor\s*:\s*default\b/, `${name} 禁用态仍是普通箭头`);
  }
  const gifCss = fs.readFileSync(path.join(__dirname, '../renderer/gif-editor.css'), 'utf8');
  assert.match(gifCss, /#gif-editor \.ge-segments \.ge-segment:disabled\{cursor:default\}/,
    'GIF片段的高优先级pointer规则也有禁用覆盖');
});

test('编辑器用可见的原生双轴滚动条，控件与标记层避开滚动条', () => {
  assert.match(editorCss, /\.ie-scroll\{[^}]*scrollbar-width:auto/);
  assert.match(editorCss, /\.ie-scroll::-webkit-scrollbar\{width:14px;height:14px\}/);
  assert.match(editorCss, /\.ie-scroll::-webkit-scrollbar-track\{background:#e3ece7/);
  assert.match(editorCss, /\.ie-scroll::-webkit-scrollbar-thumb\{background:#7fa898/);
  // 缩放控件已停靠到底栏：不再靠 right/bottom 躲滚动条，也不会浮在画布上盖图。
  assert.doesNotMatch(editorCss, /\.ie-view-actions\{[^}]*position:absolute/);
  assert.doesNotMatch(editorCss, /\.ie-view-actions\{[^}]*(right|bottom):/);
  assert.match(editorCss, /\.ie-marker-layer\{[^}]*inset:0 14px 14px 0/);
});
