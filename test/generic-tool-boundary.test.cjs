'use strict';
// 通用工具边界回归：本仓只做截图工具，不绑定任何 Agent、不自动发送、不做本机反馈出箱。
// 20261031 按产品定位删掉了反馈收发链路（main/feedback-*.cjs、core/feedback-bundle.cjs、
// renderer/feedback.js、companion/jiegetu-feedback），这里守住三件事：
//   1) 源码里不再出现反馈/宿主编排的接线；
//   2) 页面与预载只暴露通用截图能力；
//   3) 删掉的文件不会被悄悄恢复成半套。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const exists = relative => fs.existsSync(path.join(ROOT, relative));

function sourceFiles(directory) {
  const root = path.join(ROOT, directory);
  const out = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (/\.(cjs|mjs|js|html|css|json)$/.test(entry.name)) out.push(path.relative(ROOT, full).replace(/\\/g, '/'));
    }
  };
  walk(root);
  return out;
}

test('main / renderer / core 源码里没有反馈发送、宿主绑定或本机出箱的接线', () => {
  const files = ['main', 'renderer', 'core'].flatMap(sourceFiles);
  assert.ok(files.length > 20, `源码清单要真的扫到东西：${files.length}`);
  const offenses = [];
  for (const file of files) {
    const text = read(file);
    for (const [label, pattern] of [['feedback', /feedback/i], ['Hana', /hana/i], ['出箱', /outbox/i],
      ['反馈包/收件夹', /反馈包|反馈收件夹|反馈导出|反馈给伙伴|交给 Hana|直接发送/]]) {
      if (pattern.test(text)) offenses.push(`${file} → ${label}`);
    }
  }
  assert.deepEqual(offenses, [], `不应再出现宿主编排/反馈接线：${offenses.join('、')}`);
});

test('反馈链路的文件与目录已经删干净，不留半套兼容壳', () => {
  for (const file of ['main/feedback-bridge.cjs', 'main/feedback-ipc.cjs', 'main/feedback-outbox.cjs',
    'core/feedback-bundle.cjs', 'renderer/feedback.js', 'companion/jiegetu-feedback',
    'test/feedback-bridge.test.cjs', 'test/feedback-ipc.test.cjs', 'test/feedback-outbox.test.cjs',
    'test/feedback-bundle.test.cjs', 'test/feedback-bridge-integration.test.cjs']) {
    assert.equal(exists(file), false, `${file} 不该还在`);
  }
  assert.equal(exists('renderer/annotations.js'), true, '通用批注模型在');
});

test('入口只接截图主链路：不再创建反馈出箱、不注册发送 IPC', () => {
  const index = read('main/index.cjs');
  assert.equal(/feedback/i.test(index), false, 'main/index.cjs 不再引入反馈出箱');
  const screenshot = read('main/screenshot.cjs');
  assert.equal(/feedback/i.test(screenshot), false, 'main/screenshot.cjs 不再装发送 IPC 或存 submission 状态');
  assert.equal(/shot:feedback/.test(screenshot), false);
});

test('选区页与预载只暴露通用能力：编辑器搬到独立页，旧反馈桥一个都不留', async () => {
  const html = read('renderer/selection.html');
  const editorHtml = read('renderer/image-editor-window.html');
  assert.equal(html.indexOf('image-editor.js'), -1, '选区页不再加载编辑器');
  assert.ok(editorHtml.indexOf('annotations.js') > -1 && editorHtml.indexOf('annotations.js') < editorHtml.indexOf('image-editor.js'),
    '批注模型要先于编辑器加载');
  assert.equal(/feedback/i.test(html), false, '页面不再加载反馈脚本');

  const vm = require('node:vm');
  let api;
  const listeners = new Map();
  vm.runInNewContext(read('main/selection-preload.cjs'), {
    process: { platform: 'win32' },
    require: name => {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
        ipcRenderer: { on: (name, listener) => listeners.set(name, listener), removeListener: () => {}, invoke: async () => true } };
    }
  });
  for (const name of ['feedback', 'feedbackTarget', 'sendMessage', 'invoke', 'readFile']) {
    assert.equal(name in api, false, `预载不应暴露 ${name}`);
  }
  for (const name of ['init', 'commit', 'editSource', 'editState', 'recognizeText', 'cancel']) {
    assert.equal(typeof api[name], 'function', `截图主链路入口 ${name} 必须还在`);
  }
});

test('package.json 的 check 对着现存文件：批注模型在清单里，被删模块不在', () => {
  const pkg = JSON.parse(read('package.json'));
  const check = String(pkg.scripts.check);
  assert.match(check, /renderer\/annotations\.js/);
  assert.equal(/feedback/i.test(check), false, 'check 里不再有被删的反馈模块');
  assert.equal(pkg.dependencies.gifenc, '1.0.3', '依赖没被动过');
  assert.equal(Object.keys(pkg.dependencies).length, 1, '没有新增依赖');
});
