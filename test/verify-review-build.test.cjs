const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyPayload, expectedFiles, gifencAllowlist } = require('../scripts/verify-review-build.cjs');

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
  'README.md': '# gifenc\n\nUsage: import { GIFEncoder } from \'gifenc\';\n',
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

// —— release profile：公开双交付的真实载荷 ——
// 合成包里的假 PE 会被系统实时防护逐个扫，反复建/删临时目录很慢，所以 release 用例共用一份夹具，
// 每个用例只改名或改内容再复原，最后统一清理。
const RELEASE_HELPERS = ['wgc-capture.exe', 'wgc-record.exe', 'gdi-capture.exe', 'gif-clipboard.exe', 'ocr-helper.exe'];
const RELEASE_DECLARATIONS = ['LICENSE', 'THIRD-PARTY-NOTICES.md', 'assets/LICENSE.txt'];

// 根 package.json 补齐公开元数据；review 旧夹具不需改，新旧共用同一套核验器。
function releasePackage(overrides = {}) {
  return {
    name: 'fixture', productName: '假发布', version: '0.90.0', private: true,
    description: 'fixture', main: 'main/index.cjs',
    license: 'SEE LICENSE IN LICENSE',
    repository: { type: 'git', url: 'https://github.com/example/fixture.git' },
    homepage: 'https://github.com/example/fixture#readme',
    bugs: { url: 'https://github.com/example/fixture/issues' },
    ...overrides
  };
}

function releaseFixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-build-'));
  const root = path.join(temp, 'source'), target = path.join(temp, 'win-unpacked');
  writeTree(root, {
    'package.json': JSON.stringify({ ...releasePackage(),
      dependencies: { gifenc: '1.0.3' }, devDependencies: { electron: '44.9.2' } }, null, 2),
    'package-lock.json': JSON.stringify({ name: 'fixture', lockfileVersion: 3,
      packages: { '': { dependencies: { gifenc: '1.0.3' }, devDependencies: { electron: '44.9.2' } },
        'node_modules/gifenc': { version: '1.0.3', license: 'MIT' } } }, null, 2),
    ...SOURCE_FILES,
    'LICENSE': '测试用许可正文\n',
    'THIRD-PARTY-NOTICES.md': '第三方声明\n',
    'assets/LICENSE.txt': '图标来源记录\n'
  });
  writeTree(path.join(root, 'node_modules/gifenc'), GIFENC_FILES);
  for (const helper of RELEASE_HELPERS) writeTree(root, { ['native/' + helper]: fakePe() });
  const payload = path.join(target, 'resources/app');
  fs.cpSync(root, payload, { recursive: true, filter: file => !file.endsWith('package-lock.json') });
  // builder 26.18.0 拷依赖时会丢掉依赖自带的 README.md，夹具跟真实包保持一致。
  fs.rmSync(path.join(payload, 'node_modules/gifenc/README.md'), { force: true });
  fs.writeFileSync(path.join(payload, 'package.json'), JSON.stringify({ ...releasePackage(),
    dependencies: { gifenc: '1.0.3' } }, null, 2));
  fs.writeFileSync(path.join(target, '截个图.exe'), fakePe());
  return { temp, root, target, payload, cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}

let releaseBuild = null;
function sharedRelease() {
  if (!releaseBuild) releaseBuild = releaseFixture();
  return releaseBuild;
}
after(() => { if (releaseBuild) { releaseBuild.cleanup(); releaseBuild = null; } });

function verifyRelease() {
  const build = sharedRelease();
  return verifyPayload({ root: build.root, target: build.target, profile: 'release' });
}

// 把文件临时挪出白名单范围，跑完再挪回来：避免反复读写假 PE。
let parkSeq = 0;
function parked(file, runInside) {
  const dir = path.join(sharedRelease().temp, 'parked');
  fs.mkdirSync(dir, { recursive: true });
  const hold = path.join(dir, `${++parkSeq}-${path.basename(file)}`);
  fs.renameSync(file, hold);
  try { return runInside(); } finally { fs.renameSync(hold, file); }
}

test('release 正例：五 helper、三份声明与新增 metadata 都随包', () => {
  const result = verifyRelease();
  assert.equal(result.ok, true);
  assert.equal(result.profile, 'release');
  const listed = result.manifest.map(entry => entry.file);
  for (const file of [...RELEASE_HELPERS.map(helper => 'native/' + helper), ...RELEASE_DECLARATIONS]) {
    assert.ok(listed.includes(file), `${file} 要进逐文件清单`);
  }
  assert.deepEqual(result.native.map(entry => entry.file).sort(), [...RELEASE_HELPERS].sort(), '只核对五个 helper');
  assert.equal(result.application.machine, '8664');
});

test('release 缺 helper 即拒收，且不靠扫描补位', () => {
  const build = sharedRelease();
  parked(path.join(build.payload, 'native/ocr-helper.exe'),
    () => assert.throws(verifyRelease, /runtime file allowlist mismatch/, 'payload 少 helper'));
  parked(path.join(build.root, 'native/wgc-record.exe'),
    () => assert.throws(verifyRelease, /release 源码缺少原生 helper：native\/wgc-record\.exe/, '源码少 helper'));
  assert.equal(verifyRelease().ok, true, '复原后仍要通过，证明只是临时挪走');
});

test('release 缺任一声明文件即拒收', () => {
  const build = sharedRelease();
  for (const file of RELEASE_DECLARATIONS) {
    parked(path.join(build.payload, file),
      () => assert.throws(verifyRelease, /runtime file allowlist mismatch/, `payload 少 ${file}`));
    parked(path.join(build.root, file),
      () => assert.throws(verifyRelease, /release 源码缺少声明文件/, `源码少 ${file}`));
  }
  assert.equal(verifyRelease().ok, true);
});

test('release 混入 dxgi 或日志/私文件一律拒收', () => {
  const build = sharedRelease();
  for (const relative of ['logs/run.log', 'main/private-debug.cjs', 'assets/tray-girl.png']) {
    const file = path.join(build.payload, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '// extra\n');
    try { assert.throws(verifyRelease, /runtime file allowlist mismatch/, relative); }
    finally { fs.rmSync(file, { force: true }); }
  }
  // 额外 exe 用改名证明：dxgi 不在 release 白名单里。
  const helper = path.join(build.payload, 'native/gif-clipboard.exe');
  const dxgi = path.join(build.payload, 'native/dxgi-capture.exe');
  fs.renameSync(helper, dxgi);
  try { assert.throws(verifyRelease, /runtime file allowlist mismatch/, 'dxgi'); }
  finally { fs.renameSync(dxgi, helper); }
  assert.equal(verifyRelease().ok, true);
});

test('release 白名单不随根目录 exe 扩列，review 仍按目录实际 exe 核对', () => {
  const build = sharedRelease();
  const extra = path.join(build.root, 'native/dxgi-capture.exe');
  fs.copyFileSync(path.join(build.root, 'native/ocr-helper.exe'), extra);
  try {
    const release = expectedFiles(build.root, { profile: 'release' });
    assert.equal(release.includes('native/dxgi-capture.exe'), false, 'release 不因根里有 dxgi 就收录');
    assert.equal(release.includes('native/ocr-helper.exe'), true);
    assert.equal(expectedFiles(build.root, { profile: 'review' }).includes('native/dxgi-capture.exe'), true, 'review 保持旧行为');
    assert.equal(verifyRelease().ok, true, '根里多出的 exe 不进 release 载荷核对');
  } finally { fs.rmSync(extra, { force: true }); }
});

test('release metadata：仓库字段被改、少许可或多出未知字段都拒收', () => {
  const build = sharedRelease();
  const file = path.join(build.payload, 'package.json');
  const original = fs.readFileSync(file, 'utf8');
  const tamper = [
    meta => ({ ...meta, repository: { type: 'git', url: 'https://github.com/other/fixture.git' } }),
    meta => ({ ...meta, homepage: 'https://example.com/' }),
    meta => { const { license, ...rest } = meta; return rest; },
    meta => ({ ...meta, scripts: { test: 'node --test' } })
  ];
  try {
    for (const mutate of tamper) {
      fs.writeFileSync(file, JSON.stringify(mutate({ ...releasePackage(), dependencies: { gifenc: '1.0.3' } }), null, 2));
      assert.throws(verifyRelease, /unexpected package metadata/);
    }
  } finally { fs.writeFileSync(file, original); }
  assert.equal(verifyRelease().ok, true);
});

test('release 要求根 package.json 真的声明许可', () => {
  const build = sharedRelease();
  const file = path.join(build.root, 'package.json');
  const original = fs.readFileSync(file, 'utf8');
  try {
    const meta = JSON.parse(original);
    delete meta.license;
    fs.writeFileSync(file, JSON.stringify(meta, null, 2));
    assert.throws(verifyRelease, /release 载荷需要根 package\.json 声明 license/);
  } finally { fs.writeFileSync(file, original); }
});

test('release 只少依赖自带的 README.md：多带即拒，LICENSE.md 与 dist/src 仍逐字节核验', () => {
  const build = sharedRelease();
  const readme = path.join(build.payload, 'node_modules/gifenc/README.md');
  fs.writeFileSync(readme, fs.readFileSync(path.join(build.root, 'node_modules/gifenc/README.md')));
  try { assert.throws(verifyRelease, /runtime file allowlist mismatch/, 'README 不在 release 白名单里'); }
  finally { fs.rmSync(readme, { force: true }); }

  for (const relative of ['node_modules/gifenc/LICENSE.md', 'node_modules/gifenc/dist/gifenc.js', 'node_modules/gifenc/src/index.js']) {
    const file = path.join(build.payload, relative);
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.concat([original, Buffer.from('\n')]));
    const pattern = new RegExp('payload drift: ' + relative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    try { assert.throws(verifyRelease, pattern, relative); }
    finally { fs.writeFileSync(file, original); }
  }
  assert.equal(verifyRelease().ok, true);
  // 源依赖清单不变：预检和源侧核验仍要求 README 在内的全部 gifenc 文件。
  assert.equal(gifencAllowlist(build.root).includes('node_modules/gifenc/README.md'), true, 'gifencAllowlist 仍列 README');
  assert.equal(expectedFiles(build.root, { profile: 'review' }).includes('node_modules/gifenc/README.md'), true, 'review 清单不变');
});

test('未知 profile 拒绝，默认仍是 review', () => {
  const build = sharedRelease();
  assert.throws(() => verifyPayload({ root: build.root, target: build.target, profile: 'debug' }), /未知载荷 profile/);
  assert.throws(() => expectedFiles(build.root, { profile: 'Review' }), /未知载荷 profile/);
  const review = fixture();
  try { assert.equal(verifyPayload(review).profile, 'review', '不传 profile 走旧路径'); } finally { review.cleanup(); }
});
