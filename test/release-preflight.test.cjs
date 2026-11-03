'use strict';
// 发布预检与发布配置的定向用例：假暂存目录、最短 PE 头，不打包、不安装依赖、不启动程序。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const preflightModule = require('../scripts/release-preflight.cjs');
const { HELPERS, checkRelease, beforePack } = preflightModule;

const REPO_ROOT = path.resolve(__dirname, '..');
const PREFLIGHT = path.join(REPO_ROOT, 'scripts', 'release-preflight.cjs');
const CONFIG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'electron-builder.release.json'), 'utf8'));

function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// 最短合法 PE：MZ + e_lfanew(0x40) + PE 签名 + COFF machine。
function peBuffer(machine = 0x8664) {
  const buffer = Buffer.alloc(0x60, 0);
  buffer.write('MZ', 0, 'ascii');
  buffer.writeUInt32LE(0x40, 0x3c);
  buffer.write('PE\0\0', 0x40, 'ascii');
  buffer.writeUInt16LE(machine, 0x44);
  return buffer;
}

function fixture({
  version = '0.1.0',
  license = 'Proprietary',
  licenseText = 'Proprietary test license.\n',
  iconRecord = 'Icon record: original work, rights confirmed by the project owner on 2026-11-03.\n',
  omitRootLicense = false,
  omitNotices = false,
  omitIconRecord = false,
  machine = {}
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jiegechang-release-preflight-'));
  const pkg = {
    name: 'jiegechang',
    productName: '截个图',
    version,
    private: true,
    description: 'release preflight fixture',
    main: 'main/index.cjs',
    dependencies: { gifenc: '1.0.3' },
    devDependencies: { electron: '44.9.2' }
  };
  if (license !== null) pkg.license = license;
  write(root, 'package.json', JSON.stringify(pkg, null, 2));
  write(root, 'package-lock.json', JSON.stringify({
    name: 'jiegechang',
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { gifenc: '1.0.3' }, devDependencies: { electron: '44.9.2' } },
      'node_modules/gifenc': { version: '1.0.3', license: 'MIT' }
    }
  }, null, 2));
  write(root, 'node_modules/gifenc/package.json', JSON.stringify({ name: 'gifenc', version: '1.0.3', license: 'MIT' }, null, 2));
  write(root, 'node_modules/gifenc/LICENSE.md', 'MIT License\n\nCopyright (c) 2020 Matt DesLauriers\n');
  write(root, 'node_modules/gifenc/dist/gifenc.js', 'module.exports = {};\n');
  if (!omitRootLicense) write(root, 'LICENSE', licenseText);
  if (!omitIconRecord) write(root, 'assets/LICENSE.txt', iconRecord);
  if (!omitNotices) write(root, 'THIRD-PARTY-NOTICES.md', 'Third-party notices\n');
  for (const helper of HELPERS) write(root, `native/${helper}`, peBuffer(machine[helper] || 0x8664));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('CJS 入口 require 后是可直接调用的函数，checkRelease 等附作属性', () => {
  assert.equal(typeof preflightModule, 'function');
  assert.equal(preflightModule, beforePack);
  assert.equal(preflightModule.checkRelease, checkRelease);
  assert.equal(preflightModule.HELPERS, HELPERS);
  const f = fixture();
  try { assert.equal(preflightModule({ appDir: f.root }).ok, true); } finally { f.cleanup(); }
});

test('元数据、人工图标记录、依赖与五个 x64 helper 齐全时通过，兼容两种 beforePack context', () => {
  const f = fixture();
  try {
    const report = checkRelease({ root: f.root });
    assert.equal(report.ok, true);
    assert.equal(report.version, '0.1.0');
    assert.deepEqual(report.helpers, HELPERS);
    assert.ok(report.gifencFiles.includes('node_modules/gifenc/LICENSE.md'));
    assert.equal(beforePack({ appDir: f.root }).ok, true);
    assert.equal(beforePack({ packager: { appDir: f.root } }).ok, true);
  } finally { f.cleanup(); }
});

test('版本 0.0.0 被阻断', () => {
  const f = fixture({ version: '0.0.0' });
  try { assert.throws(() => checkRelease({ root: f.root }), /0\.0\.0/); } finally { f.cleanup(); }
});

test('真实仓库版本已在 package 与 lock 根包同步，且不再被占位版本拦住', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, pkg.version, 'lock 顶层版本要与 package.json 一致');
  assert.equal(lock.packages[''].version, pkg.version, 'lock 根包版本要与 package.json 一致');
  assert.notEqual(pkg.version, '0.0.0', '正式候选不能再用开发占位版本');
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, '版本号要能被文件名模板和 semver 吃下');
  // 真实仓库可能还被其它门禁（helper、图标记录）拦住，但不能再停在版本上。
  let failure = null;
  try { checkRelease({ root: REPO_ROOT }); } catch (error) { failure = error; }
  if (failure) assert.doesNotMatch(failure.message, /0\.0\.0/, '真实版本不该再被占位版门禁拦住');
});

test('license 缺失或 UNLICENSED 被阻断', () => {
  for (const license of [null, '', 'UNLICENSED']) {
    const f = fixture({ license });
    try { assert.throws(() => checkRelease({ root: f.root }), /license|UNLICENSED/); } finally { f.cleanup(); }
  }
});

test('根 LICENSE 缺失或为空被阻断', () => {
  for (const options of [{ omitRootLicense: true }, { licenseText: '   \n' }]) {
    const f = fixture(options);
    try { assert.throws(() => checkRelease({ root: f.root }), /LICENSE/); } finally { f.cleanup(); }
  }
});

test('图标人工记录缺失、为空或仍带 TODO/未确认被阻断', () => {
  for (const iconRecord of ['', 'TODO: confirm icon rights\n', '图标权利未确认\n', '图标权利待确认\n']) {
    const f = fixture({ iconRecord });
    try { assert.throws(() => checkRelease({ root: f.root }), /LICENSE\.txt|TODO|未确认|待确认/); } finally { f.cleanup(); }
  }
});

test('漏任一 helper 都拒绝', () => {
  for (const helper of HELPERS) {
    const f = fixture();
    try {
      fs.rmSync(path.join(f.root, 'native', helper));
      assert.throws(() => checkRelease({ root: f.root }), new RegExp(helper.replace('.', '\\.')));
    } finally { f.cleanup(); }
  }
});

test('helper 不是 x64 PE 或不是 PE 都拒绝', () => {
  const x86 = fixture({ machine: { 'gdi-capture.exe': 0x14c } });
  try { assert.throws(() => checkRelease({ root: x86.root }), /不是 x64 PE|0x14c/); } finally { x86.cleanup(); }

  const text = fixture();
  try {
    fs.writeFileSync(path.join(text.root, 'native', 'wgc-capture.exe'), 'not a pe');
    assert.throws(() => checkRelease({ root: text.root }), /PE/);
  } finally { text.cleanup(); }
});

test('gifenc 许可或固定版本不完整时复用既有校验并拒绝', () => {
  const missingLicense = fixture();
  try {
    fs.rmSync(path.join(missingLicense.root, 'node_modules/gifenc/LICENSE.md'));
    assert.throws(() => checkRelease({ root: missingLicense.root }), /gifenc|许可证/);
  } finally { missingLicense.cleanup(); }

  const wrongVersion = fixture();
  try {
    const file = path.join(wrongVersion.root, 'node_modules/gifenc/package.json');
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    meta.version = '9.9.9';
    fs.writeFileSync(file, JSON.stringify(meta));
    assert.throws(() => checkRelease({ root: wrongVersion.root }), /gifenc|版本/);
  } finally { wrongVersion.cleanup(); }
});

test('根 THIRD-PARTY-NOTICES.md 缺失被阻断', () => {
  const f = fixture({ omitNotices: true });
  try { assert.throws(() => checkRelease({ root: f.root }), /THIRD-PARTY-NOTICES\.md/); } finally { f.cleanup(); }
});

test('CLI 以非零退出并给出明确原因，且不回显暂存绝对路径', () => {
  const f = fixture({ version: '0.0.0' });
  try {
    const result = spawnSync(process.execPath, [PREFLIGHT, f.root], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /发布预检未通过/);
    assert.match(result.stderr, /0\.0\.0/);
    assert.ok(!result.stderr.includes(f.root), 'stderr 不打印真实暂存路径');
    assert.ok(!result.stdout.includes(f.root), 'stdout 不打印真实暂存路径');
  } finally { f.cleanup(); }
});

test('CLI 正例退出 0，且不回显暂存绝对路径', () => {
  const f = fixture();
  try {
    const result = spawnSync(process.execPath, [PREFLIGHT, f.root], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /发布预检通过/);
    assert.ok(!result.stdout.includes(f.root));
  } finally { f.cleanup(); }
});

test('发布配置：双 target 同源、向导/当前用户/可选目录、不自动运行、不删 AppData', () => {
  assert.equal(CONFIG.electronVersion, '44.9.2');
  assert.equal(CONFIG.electronDist, 'node_modules/electron/dist');
  assert.equal(CONFIG.asar, false);
  assert.equal(CONFIG.npmRebuild, false);
  assert.equal(CONFIG.directories.output, 'dist-release');
  assert.equal(CONFIG.beforePack, 'scripts/release-preflight.cjs');
  assert.equal(CONFIG.win.icon, 'assets/app-icon.ico');
  assert.equal(CONFIG.win.signAndEditExecutable, true);

  assert.deepEqual(CONFIG.win.target.map(target => target.target).sort(), ['nsis', 'portable']);
  assert.ok(CONFIG.win.target.every(target => target.arch.includes('x64')));

  assert.equal(CONFIG.nsis.oneClick, false);
  assert.equal(CONFIG.nsis.perMachine, false);
  assert.equal(CONFIG.nsis.allowToChangeInstallationDirectory, true);
  assert.equal(CONFIG.nsis.createDesktopShortcut, true);
  assert.equal(CONFIG.nsis.createStartMenuShortcut, true);
  assert.equal(CONFIG.nsis.deleteAppDataOnUninstall, false);
  assert.equal(CONFIG.nsis.runAfterFinish, false);
  assert.equal(CONFIG.nsis.installerIcon, 'assets/app-icon.ico');
  assert.equal(CONFIG.portable.requestExecutionLevel, 'user');
});

test('双 target ASCII 文件名不碰撞且带 version/arch/ext', () => {
  const setup = CONFIG.nsis.artifactName;
  const portable = CONFIG.portable.artifactName;
  assert.notEqual(setup, portable);
  for (const name of [setup, portable]) {
    assert.ok(!/[^\x20-\x7e]/.test(name), `文件名必须 ASCII：${name}`);
    assert.match(name, /\$\{version\}/);
    assert.match(name, /\$\{arch\}/);
    assert.match(name, /\$\{ext\}/);
  }
  assert.match(setup, /^Jiegetu-\$\{version\}-Setup-\$\{arch\}\.\$\{ext\}$/);
  assert.match(portable, /^Jiegetu-\$\{version\}-Portable-\$\{arch\}\.\$\{ext\}$/);
  const sample = name => name.replace('${version}', '0.1.0').replace('${arch}', 'x64').replace('${ext}', 'exe');
  assert.equal(sample(setup), 'Jiegetu-0.1.0-Setup-x64.exe');
  assert.equal(sample(portable), 'Jiegetu-0.1.0-Portable-x64.exe');
  assert.equal(CONFIG.win.artifactName, undefined, '不保留会与 target 文件名冲突的全局 artifactName');
});

test('files 只带五个明确 helper，不带 dxgi/未用图标/开发文档', () => {
  const nativeEntries = CONFIG.files.filter(file => file.startsWith('native/'));
  assert.deepEqual(nativeEntries.slice().sort(), HELPERS.map(helper => 'native/' + helper).sort());
  assert.ok(!CONFIG.files.includes('native/*.exe'), '不使用会静默带 dxgi 的通配');
  assert.doesNotMatch(JSON.stringify(CONFIG.files), /dxgi/i);
  assert.doesNotMatch(JSON.stringify(CONFIG.files), /tray-girl/i);
  for (const icon of ['assets/app-icon.png', 'assets/app-icon.ico', 'assets/tray-scroll.png']) {
    assert.ok(CONFIG.files.includes(icon), `缺少图标 ${icon}`);
  }
  assert.ok(CONFIG.files.includes('assets/LICENSE.txt'), '图标许可/归属记录必须随包');
  for (const pattern of ['main/**/*', 'renderer/**/*', 'core/**/*', 'package.json', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'node_modules/gifenc/**/*']) {
    assert.ok(CONFIG.files.includes(pattern), `缺少运行文件 ${pattern}`);
  }
  assert.ok(!CONFIG.files.some(file => /README|AGENTS|PENDING|开发进度/.test(file)), '不带开发文档');
});

test('只额外原样复制 gifenc 元数据，保持依赖逐字节核验', () => {
  // builder 会清理依赖 package.json 的 scripts/ava/keywords/bugs；这份显式原样副本在普通文件复制后覆盖。
  assert.deepEqual(CONFIG.extraFiles, [{
    from: 'node_modules/gifenc/package.json',
    to: 'resources/app/node_modules/gifenc/package.json'
  }]);
});

test('publish 为空且没有自动上传配置', () => {
  assert.deepEqual(CONFIG.publish, []);
  assert.equal(CONFIG.win.publish, undefined);
  assert.equal(CONFIG.nsis.publish, undefined);
  assert.equal(CONFIG.portable.publish, undefined);
});

test('未配置签名证书或绕过防护的选项', () => {
  assert.equal(CONFIG.win.certificateFile, undefined);
  assert.equal(CONFIG.win.certificatePassword, undefined);
  assert.equal(CONFIG.win.signingHashAlgorithms, undefined);
  assert.equal(CONFIG.forceCodeSigning, undefined);
});
