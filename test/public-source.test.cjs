'use strict';
// 公开源码准备脚本的自测：全部在临时目录里跑，不碰真实项目文件。
// 反例里的路径与名字都是运行时拼出来的虚构值，文件正文里不含任何真实个人词。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const {
  select, scan, detect, prepare, assertNoSymlinks, isPublicPath, timestamp,
  BLOCKERS, EXCLUDED_FILES, MAX_FILES, PLACEHOLDER_USERS
} = require('../scripts/prepare-public-source.cjs');

const BS = String.fromCharCode(92);
// 运行时才拼成完整形状，文件本身不落任何可扫描的路径。
const userPath = (name, sep = BS, tail = 'shots') => `C:${sep}Users${sep}${name}${sep}${tail}`;
const winUser = (name, tail = 'shots') => userPath(name, BS, tail);
const FICTIONAL_USER = ['zz', 'not', 'real'].join('');

function makeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-public-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function gitRepo(files) {
  const root = makeTree(files);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base'], { cwd: root });
  return root;
}

test('白名单：只挑代码树、原生源码、图标与演示截图、根文件与两份文档，不带诊断启动入口', () => {
  const candidates = [
    'main/index.cjs', 'main/preload.cjs', 'main/diagnostics.cjs', 'renderer/shot-control.js', 'core/scroll.mjs',
    'scripts/build-capture.cjs', 'scripts/prepare-public-source.cjs', 'scripts/release-preflight.cjs',
    'test/index-diagnostic.test.cjs', 'test/diagnostics.test.cjs', 'test/fixtures/editor-dom.cjs',
    'test/release-preflight.test.cjs',
    'native/wgc-capture.cs', 'native/gif-clipboard.cs',
    'assets/app-icon.png', 'assets/app-icon.ico', 'assets/tray-scroll.png', 'assets/LICENSE.txt',
    'assets/screenshots/annotation-editor.png', 'assets/screenshots/gif-editor.png',
    'README.md', 'package.json', 'package-lock.json', 'electron-builder.json',
    'electron-builder.release.json', '.gitignore', 'THIRD-PARTY-NOTICES.md', 'LICENSE',
    'docs/BUILDING.md', 'docs/RELEASE_CHECKLIST.md',
    // 开发诊断入口及只测这些入口的用例：本机有，导出不带
    '启动截个图.cmd', '启动截个图（后台）.vbs',
    'scripts/diagnostic-launch.ps1',
    'test/diagnostic-launch.test.cjs', 'test/diagnostic-launcher.test.cjs',
    // 以下都该被排除
    'assets/screenshots/other.png', 'assets/screenshots/private/annotation-editor.png',
    'assets/screenshots/annotation-editor.webp',
    'AGENTS.md', '开发进度.md', 'PENDING_CHANGES.md', 'PUBLISHING.md', 'REVIEW_GUIDE.md',
    '托盘与设置重设计-验收-20261102.md', '长截图试验页.html',
    'experiments/probe.cjs', 'experiments/_wgc-profile-x/a.json',
    'node_modules/electron/index.js', '.git/config',
    'native/wgc-capture.exe', 'native/ocr-helper.exe', 'assets/tray-girl.png',
    'dist-review/app.asar', 'logs/run.log', '_backups/theme/main/index.cjs',
    '启动截个长.cmd', '启动验证版.cmd', 'docs/PRIVATE.md', 'main/../evil.cjs'
  ];
  const { files, skipped } = select(candidates);
  assert.deepEqual(files, [
    '.gitignore', 'LICENSE', 'README.md', 'THIRD-PARTY-NOTICES.md',
    'assets/LICENSE.txt', 'assets/app-icon.ico', 'assets/app-icon.png',
    'assets/screenshots/annotation-editor.png', 'assets/screenshots/gif-editor.png',
    'assets/tray-scroll.png',
    'core/scroll.mjs', 'docs/BUILDING.md', 'docs/RELEASE_CHECKLIST.md', 'electron-builder.json',
    'electron-builder.release.json', 'main/diagnostics.cjs', 'main/index.cjs', 'main/preload.cjs',
    'native/gif-clipboard.cs', 'native/wgc-capture.cs', 'package-lock.json', 'package.json',
    'renderer/shot-control.js', 'scripts/build-capture.cjs', 'scripts/prepare-public-source.cjs',
    'scripts/release-preflight.cjs', 'test/diagnostics.test.cjs', 'test/fixtures/editor-dom.cjs',
    'test/index-diagnostic.test.cjs', 'test/release-preflight.test.cjs'
  ]);
  assert.deepEqual(files, [...files].sort(), '输出恒有序');
  for (const gone of ['native/wgc-capture.exe', 'assets/tray-girl.png', 'node_modules/electron/index.js', 'experiments/probe.cjs', '.git/config', '开发进度.md']) {
    assert.equal(files.includes(gone), false, `${gone} 不该进准备目录`);
    assert.equal(skipped.includes(gone), true, `${gone} 要记在排除名单里`);
  }
  assert.equal(isPublicPath('main/../evil.cjs'), false, '路径穿越不许过');
  assert.equal(isPublicPath('scripts/x.exe'), false, '白名单目录里的构建产物也不复制');
  assert.equal(isPublicPath('assets/LICENSE.txt'), true, '图标授权文件要能进');
  assert.equal(isPublicPath('assets/extra.txt'), false, 'assets 只收列明的那几个');
});

test('开发诊断入口与专用测试不导出，运行排障模块照常导出', () => {
  const excluded = [
    '启动截个图.cmd', '启动截个图（后台）.vbs',
    'scripts/diagnostic-launch.ps1',
    'test/diagnostic-launch.test.cjs', 'test/diagnostic-launcher.test.cjs'
  ];
  assert.deepEqual([...EXCLUDED_FILES].sort(), [...excluded].sort(), '恰好排除这五个确切路径');
  for (const rel of excluded) {
    assert.equal(isPublicPath(rel), false, `${rel} 不该进准备目录`);
    assert.deepEqual(select([rel]), { files: [], skipped: [rel] }, `${rel} 要记在排除名单里`);
  }
  // 运行时排障、业务约束与正常构建脚本不许被这条排除带走。
  const kept = [
    'main/diagnostics.cjs', 'main/index.cjs', 'renderer/shot-control.js',
    'test/diagnostics.test.cjs', 'test/index-diagnostic.test.cjs',
    'scripts/build-capture.cjs', 'scripts/prepare-public-source.cjs', 'scripts/release-preflight.cjs'
  ];
  for (const rel of kept) assert.equal(isPublicPath(rel), true, `${rel} 要照常导出`);
  // 其它开发用启动脚本本来就不在根白名单，别因为这次排除放宽或收紧。
  for (const rel of ['启动截个长.cmd', '启动验证版.cmd', 'docs/diagnostic-launch.ps1']) {
    assert.equal(isPublicPath(rel), false, `${rel} 仍不在白名单`);
  }
});

test('演示截图只认 README 在用的那两张，不扩散到整个目录', () => {
  const allowed = ['assets/screenshots/annotation-editor.png', 'assets/screenshots/gif-editor.png'];
  for (const rel of allowed) {
    assert.equal(isPublicPath(rel), true, `${rel} 要能进准备目录`);
    assert.deepEqual(select([rel]).files, [rel]);
  }
  for (const rel of [
    'assets/screenshots/other.png', 'assets/screenshots/scratch.png',
    'assets/screenshots/private/annotation-editor.png', 'assets/screenshots/annotation-editor.jpg',
    'assets/screenshots', 'assets/photo.png'
  ]) {
    assert.equal(isPublicPath(rel), false, `${rel} 没列名就不复制`);
  }
  // README 真的引用到的图，必须在白名单里，二者不能各说各话。
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  for (const match of readme.matchAll(/!\[[^\]]*\]\((assets\/[^)]+)\)/g)) {
    assert.equal(isPublicPath(match[1]), true, `README 引用的 ${match[1]} 要能进准备目录`);
  }
});

test('白名单文件数有上限，防止把准备目录越做越大', () => {
  const many = Array.from({ length: MAX_FILES + 5 }, (_, index) => `main/f${index}.cjs`);
  const root = makeTree({ 'package.json': '{}' });
  assert.throws(() => prepare({ root, outRoot: path.join(root, 'review-source'), candidates: many, stamp: '20260101-000000' }),
    /超过上限/);
});

test('凭据规则只看形状，正常文本不误报', () => {
  assert.deepEqual(detect([`-----BEGIN `, 'PRIVATE KEY-----'].join('')), ['private-key']);
  assert.deepEqual(detect(['AKIA', 'ABCDEFGHIJKLMNOP'].join('')), ['aws-access-key']);
  assert.deepEqual(detect(['sk-', 'a'.repeat(24)].join('')), ['openai-style-key']);
  assert.deepEqual(detect(['ghp_', 'b'.repeat(36)].join('')), ['github-token']);
  assert.deepEqual(detect(['xoxb-', '1234567890-abcd'].join('')), ['slack-token']);
  assert.deepEqual(detect(['AIza', 'c'.repeat(35)].join('')), ['google-api-key']);
  assert.deepEqual(detect('sk-短值'), [], '不够长的不当密钥');
  assert.deepEqual(detect('普通注释，没有任何隐私'), []);
});

test('用户目录规则：占位名放过，虚构的真实形状要拦', () => {
  for (const placeholder of ['test', 'example', 'sample', 'demo', 'nobody', 'private', 'secret']) {
    assert.deepEqual(detect(`const dir = '${winUser(placeholder)}';`), [], `${placeholder} 是占位名，不该报`);
  }
  assert.match(FICTIONAL_USER, /^[a-z]+$/, '反例用完全虚构的名字');
  // 反斜杠与正斜杠两种写法都必须拦（规则在归一化后的 flat 上匹配）。
  assert.deepEqual(detect(`const dir = '${userPath(FICTIONAL_USER)}';`), ['user-profile-path'], '反斜杠写法');
  assert.deepEqual(detect(`const dir = '${userPath(FICTIONAL_USER, '/')}';`), ['user-profile-path'], '正斜杠写法');
  assert.deepEqual(detect(`const dir = '${userPath('someone')}';`), [], 'someone 是占位名');
  assert.deepEqual(detect(`${winUser('test')} 与 ${winUser(FICTIONAL_USER)} 同现`), ['user-profile-path'], '同一行里有真名字就报');
  assert.equal(PLACEHOLDER_USERS.has(FICTIONAL_USER), false, '反例名不在占位名单里');
});

test('当前项目绝对路径是运行时算的：出现在文件里就拦', () => {
  // 用虚构的绝对路径，避开临时目录本身带真实用户名的干扰。
  const fakeRoot = `Q:${BS}check${BS}proj`;
  const fakeParent = `Q:${BS}check`;
  assert.deepEqual(detect(`const base = '${fakeRoot}';`, [fakeRoot, fakeParent]), ['project-absolute-path']);
  assert.deepEqual(detect(`const base = '${fakeRoot.replace(/\\/g, '/')}';`, [fakeRoot, fakeParent]), ['project-absolute-path'], '正斜杠写法也认');
  assert.deepEqual(detect(`const base = '${fakeParent}';`, [fakeRoot, fakeParent]), ['project-absolute-path'], '上一级也算');
  assert.deepEqual(detect('const base = path.join(__dirname, "..");', [fakeRoot, fakeParent]), [], '相对写法不报');
});

test('脚本与测试自己必须过得了自己的规则', () => {
  const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  assert.deepEqual(detect(read('scripts/prepare-public-source.cjs')), [], '脚本正文里没有真实路径/个人词/凭据');
  assert.deepEqual(detect(read('test/public-source.test.cjs')), [], '测试里的反例是运行时拼的');
});

test('扫描：二进制跳过，命中只回规则名不回正文', () => {
  const entries = [
    { path: 'main/a.cjs', text: `// ${winUser(FICTIONAL_USER)}`, binary: false },
    { path: 'assets/app-icon.png', text: `${winUser(FICTIONAL_USER)}`, binary: true },
    { path: 'main/ok.cjs', text: '没问题', binary: false }
  ];
  const findings = scan(entries);
  assert.deepEqual(findings, [{ path: 'main/a.cjs', rules: ['user-profile-path'] }]);
  assert.equal(JSON.stringify(findings).includes(FICTIONAL_USER), false, '命中结果里不能带正文');
});

test('prepare：新目录、逐份 hash 对账、清单在目录外且不含绝对路径', () => {
  const root = gitRepo({
    'package.json': '{"name":"demo"}\n',
    'README.md': '# demo\n',
    'main/index.cjs': "'use strict';\n",
    'assets/app-icon.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]),
    '启动截个图.cmd': 'start "" electron .\r\n',
    '开发进度.md': '私有记录\n',
    'node_modules/x/index.js': 'x\n'
  });
  const outRoot = path.join(root, 'review-source');
  const { dir, manifestPath, manifest } = prepare({ root, outRoot, stamp: '20260102-030405' });

  assert.equal(path.basename(dir), '源码准备-20260102-030405');
  assert.equal(fs.existsSync(dir), true);
  assert.equal(path.dirname(manifestPath), outRoot, '清单落在准备目录外');
  assert.equal(path.basename(manifestPath), '源码准备-20260102-030405.manifest.json');

  assert.equal(manifest.counts.files, manifest.files.length);
  for (const entry of manifest.files) {
    const source = fs.readFileSync(path.join(root, entry.path));
    const copy = fs.readFileSync(path.join(dir, entry.path));
    assert.equal(sha256(source), entry.sha256, `${entry.path} 记录的是源文件 hash`);
    assert.equal(sha256(copy), entry.sha256, `${entry.path} 复制后一致`);
    assert.equal(copy.length, entry.size);
  }
  assert.deepEqual(manifest.files.map(entry => entry.path), manifest.files.map(entry => entry.path).sort());
  assert.equal(fs.existsSync(path.join(dir, '启动截个图.cmd')), false, '开发用启动脚本不跟着导出');
  assert.equal(fs.existsSync(path.join(dir, '开发进度.md')), false, '私人文档不复制');
  assert.equal(fs.existsSync(path.join(dir, 'node_modules')), false);

  assert.equal(manifest.kind, 'prepared-source');
  assert.match(manifest.note, /不是发布物/);
  assert.match(manifest.baseCommit, /^[0-9a-f]{40}$/);
  assert.equal(manifest.dirty, false, '刚提交过的工作树是干净的');
  assert.deepEqual(manifest.blockers, BLOCKERS);
  // 没有 LICENSE 也照样生成，但 ready 恒 false：最终交付物根本没做。
  assert.equal(manifest.ready, false);
  assert.equal(manifest.metadataReady, false, '许可证类文件不齐');
  const reasons = manifest.readyReasons.join('\n');
  assert.match(reasons, /最终安装包与免安装包/, '始终包含双交付未验');
  assert.match(reasons, /LICENSE/);
  assert.match(reasons, /assets\/LICENSE\.txt/);
  const text = fs.readFileSync(manifestPath, 'utf8');
  assert.equal(text.includes(root), false, '清单里不能出现本机绝对路径');
  assert.equal(/[A-Za-z]:\\\\/.test(text), false, '清单里不能出现盘符路径');
});

test('prepare：含五个诊断候选项的仓库，导出时一个都不复制，兄弟文件照拷', () => {
  const root = gitRepo({
    'package.json': '{"name":"demo"}\n',
    'README.md': '# demo\n',
    'main/index.cjs': "'use strict';\n",
    'main/diagnostics.cjs': "'use strict';\n",
    'scripts/build-capture.cjs': '// build\n',
    'scripts/diagnostic-launch.ps1': 'param()\n',
    'test/diagnostics.test.cjs': '// test\n',
    'test/diagnostic-launch.test.cjs': '// test\n',
    'test/diagnostic-launcher.test.cjs': '// test\n',
    '启动截个图.cmd': 'start "" electron .\r\n',
    '启动截个图（后台）.vbs': 'CreateObject("WScript.Shell").Run "cmd"\r\n'
  });
  const { dir, manifest } = prepare({ root, outRoot: path.join(root, 'review-source'), stamp: '20260103-040506' });
  const copied = manifest.files.map(entry => entry.path);
  const gone = [
    '启动截个图.cmd', '启动截个图（后台）.vbs',
    'scripts/diagnostic-launch.ps1',
    'test/diagnostic-launch.test.cjs', 'test/diagnostic-launcher.test.cjs'
  ];
  for (const rel of gone) {
    assert.equal(fs.existsSync(path.join(dir, rel)), false, `${rel} 不该被复制到导出目录`);
    assert.equal(copied.includes(rel), false, `${rel} 不该出现在清单里`);
  }
  for (const rel of ['package.json', 'main/index.cjs', 'main/diagnostics.cjs', 'scripts/build-capture.cjs', 'test/diagnostics.test.cjs']) {
    assert.equal(copied.includes(rel), true, `${rel} 要正常导出`);
  }
});

test('prepare：许可证文件齐了也只是 metadataReady，顶层 ready 仍为 false', () => {
  const root = gitRepo({
    'package.json': '{}\n',
    'LICENSE': 'MIT\n',
    'assets/LICENSE.txt': 'icon license\n',
    'assets/app-icon.png': Buffer.from([1, 2, 3])
  });
  const { manifest, dir } = prepare({ root, outRoot: path.join(root, 'review-source'), stamp: '20260102-030411' });
  assert.equal(manifest.metadataReady, true, '许可证类文件齐了');
  assert.equal(manifest.ready, false, '但仍不能算可交付：安装包/免安装包还没实测');
  assert.match(manifest.readyReasons.join('\n'), /最终安装包与免安装包/);
  assert.equal(fs.existsSync(path.join(dir, 'assets/LICENSE.txt')), true, '授权文件要跟着进准备目录');
});

test('prepare：图标来源已记载但仍待核，不标 metadataReady', () => {
  for (const marker of ['TODO', '未确认', '待确认']) {
    const root = gitRepo({
      'package.json': '{}\n', 'LICENSE': 'custom license\n',
      'assets/LICENSE.txt': `GPT source record: ${marker}\n`
    });
    const { manifest } = prepare({ root, outRoot: path.join(root, 'review-source'), stamp: '20260102-030412' });
    assert.equal(manifest.metadataReady, false);
    assert.equal(manifest.ready, false);
    assert.match(manifest.readyReasons.join('\n'), /来源记录不等于分发权核实/);
  }
});

test('prepare：工作树有改动时 dirty 逐份标出来', () => {
  const root = gitRepo({ 'package.json': '{}\n', 'main/index.cjs': 'old\n', 'core/scroll.mjs': 'old\n' });
  fs.writeFileSync(path.join(root, 'main/index.cjs'), 'new\n');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/BUILDING.md'), 'untracked\n');
  const { manifest } = prepare({ root, outRoot: path.join(root, 'review-source'), stamp: '20260102-030406' });
  assert.equal(manifest.dirty, true);
  const dirty = manifest.files.filter(entry => entry.dirty).map(entry => entry.path);
  assert.deepEqual(dirty.sort(), ['docs/BUILDING.md', 'main/index.cjs'], '改动和未跟踪都算脏');
});

test('prepare：目标目录已存在就失败，绝不覆盖', () => {
  const root = makeTree({ 'package.json': '{}\n' });
  const outRoot = path.join(root, 'review-source');
  const first = prepare({ root, outRoot, candidates: ['package.json'], stamp: '20260102-030407' });
  const before = fs.readFileSync(path.join(first.dir, 'package.json'));
  fs.writeFileSync(path.join(first.dir, 'keep.txt'), '别动我\n');
  assert.throws(() => prepare({ root, outRoot, candidates: ['package.json'], stamp: '20260102-030407' }), /已存在，不覆盖/);
  assert.equal(fs.readFileSync(path.join(first.dir, 'keep.txt'), 'utf8'), '别动我\n', '原目录内容不动');
  assert.equal(sha256(fs.readFileSync(path.join(first.dir, 'package.json'))), sha256(before));
});

test('prepare：目录里有符号链接就拒绝', () => {
  const root = makeTree({ 'main/a.cjs': 'a\n', 'main/b.cjs': 'b\n' });
  const fakeLstat = file => ({ isSymbolicLink: () => String(file).endsWith('b.cjs') });
  assert.throws(() => assertNoSymlinks(root, ['main/a.cjs', 'main/b.cjs'], fakeLstat), /符号链接/);
  assert.doesNotThrow(() => assertNoSymlinks(root, ['main/a.cjs'], fakeLstat));
  assert.throws(() => prepare({
    root, outRoot: path.join(root, 'review-source'), candidates: ['main/a.cjs', 'main/b.cjs'],
    stamp: '20260102-030408', lstat: fakeLstat
  }), /符号链接/);
  assert.equal(fs.existsSync(path.join(root, 'review-source')), false, '拒绝时一个目录都不建');
});

test('prepare：命中隐私就拒绝生成，且不建目录、不打印正文', () => {
  const root = makeTree({
    'package.json': '{}\n',
    'main/host.cjs': `const base = '${winUser(FICTIONAL_USER)}';\n`
  });
  const outRoot = path.join(root, 'review-source');
  let caught;
  try { prepare({ root, outRoot, candidates: ['package.json', 'main/host.cjs'], stamp: '20260102-030409' }); }
  catch (error) { caught = error; }
  assert.ok(caught, '必须抛错');
  assert.match(caught.message, /隐私规则/);
  assert.deepEqual(caught.findings, [{ path: 'main/host.cjs', rules: ['user-profile-path'] }]);
  assert.equal(JSON.stringify(caught.findings).includes(FICTIONAL_USER), false, '报错里不回显正文');
  assert.equal(fs.existsSync(outRoot), false, '拒绝时连 review-source 都不建');
});

test('prepare：文件里写死当前项目绝对路径也拦', () => {
  const root = makeTree({
    'package.json': '{}\n',
    'main/paths.cjs': ''
  });
  // 内容在运行时写入，测试文件本身不含这条路径。
  fs.writeFileSync(path.join(root, 'main/paths.cjs'), `const base = '${root.replace(/\\/g, '/')}';\n`);
  let caught;
  try { prepare({ root, outRoot: path.join(root, 'review-source'), candidates: ['main/paths.cjs'], stamp: '20260102-030412' }); }
  catch (error) { caught = error; }
  assert.ok(caught, '必须抛错');
  assert.deepEqual(caught.findings, [{ path: 'main/paths.cjs', rules: ['project-absolute-path', 'user-profile-path'] }], '临时目录本身带真实用户名，两条都该命中');
});

test('prepare：二进制图标照抄不误报，文本才扫', () => {
  const root = makeTree({
    'assets/app-icon.png': Buffer.concat([Buffer.from([0x89, 0x50, 0, 1]), Buffer.from(`C:${BS}Users${BS}${FICTIONAL_USER}`)])
  });
  const outRoot = path.join(root, 'review-source');
  const { dir, manifest } = prepare({ root, outRoot, candidates: ['assets/app-icon.png'], stamp: '20260102-030410' });
  const source = fs.readFileSync(path.join(root, 'assets/app-icon.png'));
  assert.equal(sha256(fs.readFileSync(path.join(dir, 'assets/app-icon.png'))), sha256(source));
  assert.equal(manifest.files[0].size, source.length);
  assert.equal(manifest.baseCommit, null, '没有 git 历史时如实留空，不编一个 commit');
});

test('timestamp 与导出接口保持可用', () => {
  assert.match(timestamp(new Date(2026, 10, 2, 7, 8, 9)), /^20261102-070809$/);
  for (const name of ['select', 'scan', 'detect', 'prepare', 'assertNoSymlinks']) {
    assert.equal(typeof require('../scripts/prepare-public-source.cjs')[name], 'function', `${name} 要导出`);
  }
});
