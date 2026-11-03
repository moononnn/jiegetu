const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyPayload } = require('../scripts/verify-review-build.cjs');

// 合成一个“已打包”的假发布目录：只造核验器真正读的字段与文件，不打包、不生成发布物。
function fakePe() {
  const data = Buffer.alloc(256, 0x90);
  data.write('MZ', 0, 'ascii'); data.writeUInt32LE(64, 0x3c); data.writeUInt32LE(0x4550, 64);
  data.writeUInt16LE(0x8664, 68);
  return data;
}
const GIFENC_FILES = {
  'package.json': JSON.stringify({ name: 'gifenc', version: '1.0.3', license: 'MIT' }, null, 2),
  'LICENSE.md': 'MIT License\n\nCopyright (c) 2020 Matt DesLauriers\n',
  'dist/gifenc.js': 'module.exports = { GIFEncoder: () => ({}) };\n',
  'src/index.js': 'export const noop = 1;\n'
};
const SOURCE_FILES = {
  'main/index.cjs': "'use strict'; console.log('fixture');\n",
  'renderer/scroll-capture.mjs': 'export const ready = true;\n',
  'core/gif-timeline.js': 'export const trim = 0;\n',
  'assets/app-icon.png': 'png-bytes', 'assets/app-icon.ico': 'ico-bytes', 'assets/tray-scroll.png': 'png-bytes'
};
function writeTree(base, files) {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(base, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}
function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-build-'));
  const root = path.join(temp, 'source'), target = path.join(temp, 'win-unpacked');
  const source = {
    'package.json': JSON.stringify({ name: 'fixture', productName: '假发布', version: '0.0.0', private: true,
      description: 'fixture', main: 'main/index.cjs', devDependencies: { electron: '44.9.2' }, dependencies: { gifenc: '1.0.3' } }, null, 2),
    'package-lock.json': JSON.stringify({ name: 'fixture', lockfileVersion: 3,
      packages: { '': { dependencies: { gifenc: '1.0.3' }, devDependencies: { electron: '44.9.2' } },
        'node_modules/gifenc': { version: '1.0.3', resolved: 'https://registry.npmjs.org/gifenc/-/gifenc-1.0.3.tgz', license: 'MIT' } } }, null, 2),
    ...SOURCE_FILES
  };
  writeTree(root, source);
  writeTree(path.join(root, 'node_modules/gifenc'), GIFENC_FILES);
  fs.mkdirSync(path.join(root, 'native'), { recursive: true });
  fs.writeFileSync(path.join(root, 'native/gdi-capture.exe'), fakePe());
  // 打包产物：源码树 + 逐文件 gifenc 副本 + 应用 PE。
  const payload = path.join(target, 'resources/app');
  fs.cpSync(root, payload, { recursive: true, filter: file => !file.includes('package-lock.json') });
  fs.writeFileSync(path.join(payload, 'package.json'), JSON.stringify({ name: 'fixture', productName: '假发布', version: '0.0.0',
    private: true, description: 'fixture', main: 'main/index.cjs', dependencies: { gifenc: '1.0.3' } }, null, 2));
  fs.writeFileSync(path.join(target, '截个图.exe'), fakePe());
  return { temp, root, target, payload, cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}
function run(build) {
  try { return verifyPayload(build); } finally { build.cleanup(); }
}

test('合法包：gifenc 逐文件列入白名单并保留生产依赖', () => {
  const build = fixture();
  const result = run(build);
  assert.equal(result.ok, true);
  assert.equal(result.sourceMatch, true);
  assert.ok(result.manifest.some(entry => entry.file === 'node_modules/gifenc/dist/gifenc.js'), 'gifenc 每个文件都要进清单');
  assert.ok(result.manifest.some(entry => entry.file === 'node_modules/gifenc/LICENSE.md'), '许可证随包发布');
  assert.equal(result.manifest.filter(entry => entry.file === 'package.json').length, 0, 'package.json 由元数据规则管，不算清单');
  assert.equal(result.application.machine, '8664');
});

test('多出私有文件（含 node_modules 里多一个文件）即拒收', () => {
  for (const relative of ['main/private-debug.cjs', 'node_modules/gifenc/src/extra.js', 'node_modules/left-pad/index.js']) {
    const build = fixture();
    writeTree(build.payload, { [relative]: '// extra\n' });
    assert.throws(() => run(build), /runtime file allowlist mismatch/, relative);
  }
});

test('payload 里改过任何字节都拒收（含 gifenc 文件）', () => {
  const build = fixture();
  fs.writeFileSync(path.join(build.payload, 'node_modules/gifenc/dist/gifenc.js'), 'module.exports = { tampered: true };\n');
  assert.throws(() => run(build), /payload drift: node_modules\/gifenc\/dist\/gifenc\.js/);
});

test('gifenc 许可证缺失或不是 MIT 都不允许进包', () => {
  let build = fixture();
  fs.rmSync(path.join(build.root, 'node_modules/gifenc/LICENSE.md'));
  fs.rmSync(path.join(build.payload, 'node_modules/gifenc/LICENSE.md'));
  assert.throws(() => run(build), /许可证文件缺失/);
  build = fixture();
  fs.writeFileSync(path.join(build.root, 'node_modules/gifenc/package.json'), JSON.stringify({ name: 'gifenc', version: '1.0.3', license: 'GPL-3.0' }));
  assert.throws(() => run(build), /gifenc 必须是 MIT 许可/);
});

test('package 生产依赖与版本必须和项目、lock 一致', () => {
  let build = fixture();
  fs.writeFileSync(path.join(build.payload, 'package.json'), JSON.stringify({ name: 'fixture', productName: '假发布', version: '0.0.0',
    private: true, description: 'fixture', main: 'main/index.cjs', dependencies: { gifenc: '1.0.3', 'left-pad': '1.0.0' } }));
  assert.throws(() => run(build), /unexpected package metadata/);
  build = fixture();
  fs.writeFileSync(path.join(build.payload, 'package.json'), JSON.stringify({ name: 'fixture', productName: '假发布', version: '0.0.0',
    private: true, description: 'fixture', main: 'main/index.cjs' }));
  assert.throws(() => run(build), /unexpected package metadata/);
  build = fixture();
  fs.writeFileSync(path.join(build.root, 'package.json'), JSON.stringify({ name: 'fixture', productName: '假发布', version: '0.0.0',
    private: true, description: 'fixture', main: 'main/index.cjs', dependencies: { gifenc: '1.0.3', esbuild: '0.8.52' } }));
  assert.throws(() => run(build), /生产依赖只允许固定版本的 gifenc/);
  build = fixture();
  fs.writeFileSync(path.join(build.root, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3,
    packages: { '': { dependencies: { gifenc: '1.0.3' } }, 'node_modules/gifenc': { version: '1.0.2' } } }));
  assert.throws(() => run(build), /gifenc 版本与 lock 不一致/);
});

test('源码里的用户目录及任意本机工作台路径均拒收', () => {
  for (const location of ['C:\\Users\\someone\\shot.png', 'D:\\示例工作台\\capture']) {
    const build = fixture();
    const text = `const leak = '${location}';\n`;
    fs.writeFileSync(path.join(build.root, 'main/index.cjs'), text);
    fs.writeFileSync(path.join(build.payload, 'main/index.cjs'), text);
    assert.throws(() => run(build), /local private path: main\/index\.cjs/);
  }
});
