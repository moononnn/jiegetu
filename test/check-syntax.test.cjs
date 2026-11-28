'use strict';
// FIX-06：全仓语法检查脚本的可复现验证。用临时目录造样本，不碰真实源码树。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collect, listSources, checkFile, run } = require('../scripts/check-syntax.cjs');

function makeTemp(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jgc-syntax-'));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  return root;
}

test('FIX-06 新增的合法源码文件自动纳入，不需要改脚本', () => {
  const root = makeTemp({
    'main/ok.cjs': "'use strict';\nmodule.exports = 1;\n",
    'renderer/ok.js': 'const a = 1;\n',
    'core/ok.mjs': 'export const a = 1;\n',
    'scripts/ok.cjs': "'use strict';\n"
  });
  const found = listSources(root).map(file => path.relative(root, file).replace(/\\/g, '/'));
  assert.deepEqual(found, ['core/ok.mjs', 'main/ok.cjs', 'renderer/ok.js', 'scripts/ok.cjs']);
});

test('FIX-06 排除依赖、产物与私有实验目录', () => {
  const root = makeTemp({
    'main/keep.cjs': "'use strict';\n",
    'main/node_modules/dep.cjs': 'not valid javascript ((((\n',
    'renderer/dist-release/built.cjs': 'not valid javascript ((((\n',
    'core/experiments/trial.mjs': 'not valid javascript ((((\n',
    'scripts/_backups/old.cjs': 'not valid javascript ((((\n'
  });
  const found = collect(path.join(root, 'main')).concat(collect(path.join(root, 'core')), collect(path.join(root, 'scripts')), collect(path.join(root, 'renderer')))
    .map(file => path.relative(root, file).replace(/\\/g, '/'));
  assert.deepEqual(found.filter(file => file.endsWith('keep.cjs')), ['main/keep.cjs']);
  assert.equal(found.length, 1);
});

test('FIX-06 语法错误的文件被检出并给出定位', async () => {
  const root = makeTemp({ 'main/broken.cjs': "'use strict';\nconst a = ;\n" });
  const bad = await checkFile(path.join(root, 'main', 'broken.cjs'));
  assert.ok(bad, '应当返回失败项');
  assert.match(bad.detail, /broken\.cjs|Unexpected token/i);
});

test('FIX-06 临时错误文件令整轮失败，删除后通过', async () => {
  const root = makeTemp({
    'main/ok.cjs': "'use strict';\nmodule.exports = 1;\n",
    'core/ok.mjs': 'export const a = 1;\n'
  });
  const clean = await run({ root, files: listSources(root) });
  assert.equal(clean.failures.length, 0, '干净样本应当通过');

  const broken = path.join(root, 'renderer', 'broken.js');
  fs.mkdirSync(path.dirname(broken), { recursive: true });
  fs.writeFileSync(broken, 'function () {\n', 'utf8');
  const failed = await run({ root, files: listSources(root) });
  assert.equal(failed.failures.length, 1);
  assert.equal(path.basename(failed.failures[0].file), 'broken.js');

  fs.rmSync(broken);
  const again = await run({ root, files: listSources(root) });
  assert.equal(again.failures.length, 0, '删除错误文件后应当恢复通过');
});

test('FIX-06 空目录视为失败，避免检查静默通过', async () => {
  const root = makeTemp({});
  const result = await run({ root, files: [] });
  assert.equal(result.total, 0);
  assert.equal(result.failures.length, 1);
});