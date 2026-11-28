'use strict';
// 生产源码语法检查：遍历 main / renderer / core / scripts 下的 .js/.cjs/.mjs，
// 逐个交给 node --check。新增文件自动纳入，不再维护手写清单（FIX-06）。
// 任一文件语法失败即以非零码退出；排除依赖、构建产物、备份与私有实验目录。

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ROOTS = ['main', 'renderer', 'core', 'scripts'];
const EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'dist-release', 'dist-review', 'dist-scroll-map',
  'review-source', 'experiments', 'test-not-written', '_backups'
]);
const CONCURRENCY = 8;
const PROJECT_ROOT = path.resolve(__dirname, '..');

function collect(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collect(path.join(dir, entry.name), out);
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function listSources(root = PROJECT_ROOT) {
  return ROOTS.flatMap(dir => collect(path.join(root, dir))).sort();
}

function checkFile(file) {
  return new Promise(resolve => {
    execFile(process.execPath, ['--check', file], { windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve(null);
      resolve({ file, detail: String(stderr || stdout || error.message).trim() });
    });
  });
}

async function run({ root = PROJECT_ROOT, files = listSources(root) } = {}) {
  if (!files.length) return { total: 0, failures: [{ file: root, detail: '没有找到待检查的源码文件' }] };
  const failures = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < files.length) {
      const file = files[cursor];
      cursor += 1;
      const bad = await checkFile(file);
      if (bad) failures.push(bad);
    }
  };
  const lanes = Math.min(CONCURRENCY, files.length);
  await Promise.all(Array.from({ length: lanes }, worker));
  failures.sort((a, b) => a.file.localeCompare(b.file));
  return { total: files.length, failures };
}

async function main() {
  const { total, failures } = await run();
  if (failures.length) {
    for (const item of failures) console.error(`${path.relative(PROJECT_ROOT, item.file)}\n${item.detail}\n`);
    console.error(`语法检查失败：${failures.length} 个文件有问题，共检查 ${total} 个`);
    process.exit(1);
  }
  console.log(`语法检查通过：${total} 个文件`);
}

if (require.main === module) main().catch(error => { console.error(error); process.exit(1); });

module.exports = { ROOTS, EXTENSIONS, SKIP_DIRS, collect, listSources, checkFile, run };