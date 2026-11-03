'use strict';
// Verify the actual unpacked payload against source, not the builder's success message.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const repoRoot = path.resolve(__dirname, '..');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
// 打包后的 package.json 只允许这些元数据字段（builder 会补上生产依赖），多一个字段都不收。
// 后四项是公开仓库补齐的元数据：只在根 package.json 真有时才纳入比较，旧审查包不受影响。
const METADATA_KEYS = ['name', 'productName', 'version', 'private', 'description', 'main',
  'license', 'repository', 'homepage', 'bugs'];
// release 载荷必须能读到许可声明：许可随包可读是公开交付的前提，review 旧包不追加这条要求。
const RELEASE_REQUIRED_KEYS = ['license'];
// 旧本地审查包与公开双交付不是同一套文件白名单，用 profile 明确区分，不靠猜。
const PROFILES = ['review', 'release'];
// 公开双交付只带这五个 helper；不扫描 native/*.exe，免得旧实验产物（如 dxgi）混进来。
const RELEASE_HELPERS = ['wgc-capture.exe', 'wgc-record.exe', 'gdi-capture.exe', 'gif-clipboard.exe', 'ocr-helper.exe'];
// 公开双交付额外要求随包的三份声明文件。
const RELEASE_DECLARATIONS = ['LICENSE', 'THIRD-PARTY-NOTICES.md', 'assets/LICENSE.txt'];
// electron-builder 26.18.0 内置依赖拷贝会精确排除依赖包自己的 README.md
// （app-builder-lib/out/util/NodeModuleCopyHelper.js 里的默认排除表），所以 release 载荷只少这一个文件。
// 不泛化过滤 md：LICENSE.md、dist/、src/ 仍按逐文件清单和哈希核验。
const RELEASE_OMITTED_DEPENDENCY_DOC = 'node_modules/gifenc/README.md';
// 固定生产依赖：只认 pkg 白名单里的 gifenc，并按逐文件清单核验，不放开整个 node_modules。
const GIFENC_DIR = 'node_modules/gifenc';
const GIFENC_LICENSE = 'LICENSE.md';

function profileOf(value) {
  const profile = value === undefined || value === null || value === '' ? 'review' : value;
  assert.ok(PROFILES.includes(profile), '未知载荷 profile：' + String(profile) + '（只支持 review / release）');
  return profile;
}

function files(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix + entry.name;
    assert.ok(!entry.isSymbolicLink(), 'no symlinks: ' + relative);
    return entry.isDirectory() ? files(path.join(dir, entry.name), relative + '/') : [relative];
  }).sort();
}
// 依赖自身的版本/许可/lock 一致性是“允许它进包”的前提；不满足就直接失败，不上机再猜。
function gifencAllowlist(root) {
  const dir = path.join(root, GIFENC_DIR);
  assert.ok(fs.existsSync(dir), '缺少固定生产依赖 gifenc');
  const meta = readJson(path.join(dir, 'package.json'));
  assert.equal(meta.name, 'gifenc', 'gifenc 目录内容与包名不符');
  assert.equal(meta.license, 'MIT', 'gifenc 必须是 MIT 许可');
  const declared = readJson(path.join(root, 'package.json')).dependencies || {};
  assert.deepEqual(declared, { gifenc: meta.version }, '生产依赖只允许固定版本的 gifenc');
  const lock = readJson(path.join(root, 'package-lock.json'));
  assert.equal(lock.packages?.['']?.dependencies?.gifenc, meta.version, 'lock 根依赖与 gifenc 声明版本不一致');
  assert.equal(lock.packages?.[GIFENC_DIR]?.version, meta.version, 'gifenc 版本与 lock 不一致');
  const list = files(dir).map(file => GIFENC_DIR + '/' + file);
  assert.ok(list.includes(GIFENC_DIR + '/' + GIFENC_LICENSE), 'gifenc 许可证文件缺失');
  return list;
}
// 允许进包的文件清单与 electron-builder 的 files 白名单一一对应。
// review：源码树 + 三个图标 + native 下实际存在的 exe + 逐文件 gifenc（旧审查包行为不变）。
// release：源码树 + 三个图标 + 逐个列明的五个 helper + 三份声明文件 + 逐文件 gifenc。
function expectedFiles(root, options = {}) {
  const profile = profileOf(options.profile);
  const runtime = ['package.json',
    ...['main', 'renderer', 'core'].flatMap(dir => files(path.join(root, dir)).map(file => dir + '/' + file)),
    'assets/app-icon.png', 'assets/app-icon.ico', 'assets/tray-scroll.png'];
  const extra = [];
  if (profile === 'release') {
    for (const helper of RELEASE_HELPERS) {
      assert.ok(fs.existsSync(path.join(root, 'native', helper)), 'release 源码缺少原生 helper：native/' + helper);
      extra.push('native/' + helper);
    }
    for (const file of RELEASE_DECLARATIONS) {
      assert.ok(fs.existsSync(path.join(root, file)), 'release 源码缺少声明文件：' + file);
      extra.push(file);
    }
  } else {
    extra.push(...files(path.join(root, 'native')).filter(file => file.endsWith('.exe')).map(file => 'native/' + file));
  }
  // 源依赖仍按 gifencAllowlist 的完整清单核验；只有 release 载荷按 builder 实际行为少那一个 README。
  const dependencies = gifencAllowlist(root);
  const listed = profile === 'release'
    ? dependencies.filter(file => file !== RELEASE_OMITTED_DEPENDENCY_DOC)
    : dependencies;
  return [...runtime, ...extra, ...listed].sort();
}
// 只从根 package.json 实际存在的字段取值，再逐结构比较：不认识的字段、被改过的 URL、丢掉的许可都会不等。
function expectedMetadata(original, profile) {
  const metadata = {};
  for (const key of METADATA_KEYS) {
    if (original[key] !== undefined) metadata[key] = original[key];
  }
  if (profile === 'release') {
    for (const key of RELEASE_REQUIRED_KEYS) {
      assert.ok(typeof original[key] === 'string' && original[key].trim() !== '', 'release 载荷需要根 package.json 声明 ' + key);
    }
  }
  // 生产依赖声明必须原样带上固定 gifenc：不接受缺失、换版本或额外依赖；实际运行文件另由白名单和哈希检查。
  metadata.dependencies = { ...original.dependencies };
  return metadata;
}
function pe(file) {
  const data = fs.readFileSync(file); assert.equal(data.toString('ascii', 0, 2), 'MZ');
  const offset = data.readUInt32LE(0x3c); assert.equal(data.readUInt32LE(offset), 0x4550);
  return { file: path.basename(file), bytes: data.length, machine: data.readUInt16LE(offset + 4).toString(16), sha256: hash(file) };
}
function verifyPayload({ root = repoRoot, target, profile = 'review' } = {}) {
  const mode = profileOf(profile);
  const baseTarget = path.resolve(target || path.join(root, mode === 'release' ? 'dist-release/win-unpacked' : 'dist-review/win-unpacked'));
  const payload = path.join(baseTarget, 'resources/app');
  const expected = expectedFiles(root, { profile: mode });
  const actual = files(payload);
  assert.deepEqual(actual, expected, 'runtime file allowlist mismatch');
  const manifest = [];
  for (const file of actual) {
    if (file === 'package.json') continue;
    const digest = hash(path.join(payload, file));
    assert.equal(digest, hash(path.join(root, file)), 'payload drift: ' + file);
    manifest.push({ file, sha256: digest, bytes: fs.statSync(path.join(payload, file)).size });
    if (/\.(?:cjs|mjs|js|html|css)$/.test(file)) {
      const text = fs.readFileSync(path.join(payload, file), 'utf8');
      assert.ok(!/[A-Z]:[\\/](?:Users|[^\\/\r\n'"]*工作台|Desktop)/i.test(text), 'local private path: ' + file);
      assert.ok(!/(?:sk-[A-Za-z0-9]{24,})/.test(text), 'possible credential: ' + file);
    }
  }
  const original = readJson(path.join(root, 'package.json'));
  const packaged = readJson(path.join(payload, 'package.json'));
  assert.deepEqual(packaged, expectedMetadata(original, mode), 'unexpected package metadata');
  const application = pe(path.join(baseTarget, '截个图.exe'));
  assert.equal(application.machine, '8664', 'application must be x64');
  const native = actual.filter(file => file.startsWith('native/')).map(file => pe(path.join(payload, file)));
  const portable = mode === 'review' ? path.join(root, 'dist-review/截个图-审查试用版.exe') : null;
  return { ok: true, profile: mode, payloadFiles: actual.length, sourceMatch: true, application, native,
    ...(portable && fs.existsSync(portable) ? { portable: pe(portable) } : {}), manifest };
}
if (require.main === module) {
  const args = process.argv.slice(2);
  const profile = args.includes('--release') ? 'release' : 'review';
  const positional = args.find(arg => !arg.startsWith('--'));
  // 报告写到与载荷平级的输出目录，不进载荷本身。
  const outDir = path.join(repoRoot, profile === 'release' ? 'dist-release' : 'dist-review');
  const target = path.resolve(positional || path.join(outDir, 'win-unpacked'));
  const result = verifyPayload({ root: repoRoot, target, profile });
  fs.mkdirSync(outDir, { recursive: true });
  const output = path.join(outDir, 'payload-verification.json');
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: true, profile, payloadFiles: result.payloadFiles, sourceMatch: true,
    application: result.application, native: result.native, output }, null, 2));
}
module.exports = {
  verifyPayload, expectedFiles, expectedMetadata, gifencAllowlist, profileOf,
  PROFILES, RELEASE_HELPERS, RELEASE_DECLARATIONS, RELEASE_OMITTED_DEPENDENCY_DOC, METADATA_KEYS
};
