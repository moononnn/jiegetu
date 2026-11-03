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
const METADATA_KEYS = ['name', 'productName', 'version', 'private', 'description', 'main'];
// 固定生产依赖：只认 pkg 白名单里的 gifenc，并按逐文件清单核验，不放开整个 node_modules。
const GIFENC_DIR = 'node_modules/gifenc';
const GIFENC_LICENSE = 'LICENSE.md';
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
// 允许进包的文件清单与 electron-builder 的 files 白名单一一对应：源码树 + 三个图标 + 原生 exe + 逐文件 gifenc。
function expectedFiles(root) {
  return ['package.json', ...['main', 'renderer', 'core'].flatMap(dir => files(path.join(root, dir)).map(file => dir + '/' + file)),
    'assets/app-icon.png', 'assets/app-icon.ico', 'assets/tray-scroll.png',
    ...files(path.join(root, 'native')).filter(file => file.endsWith('.exe')).map(file => 'native/' + file),
    ...gifencAllowlist(root)].sort();
}
function pe(file) {
  const data = fs.readFileSync(file); assert.equal(data.toString('ascii', 0, 2), 'MZ');
  const offset = data.readUInt32LE(0x3c); assert.equal(data.readUInt32LE(offset), 0x4550);
  return { file: path.basename(file), bytes: data.length, machine: data.readUInt16LE(offset + 4).toString(16), sha256: hash(file) };
}
function verifyPayload({ root = repoRoot, target = path.join(root, 'dist-review/win-unpacked') } = {}) {
  const payload = path.join(target, 'resources/app');
  const expected = expectedFiles(root);
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
  // 生产依赖声明必须原样带上固定 gifenc：不接受缺失、换版本或额外依赖；实际运行文件另由白名单和哈希检查。
  const metadata = { ...Object.fromEntries(METADATA_KEYS.map(key => [key, original[key]])), dependencies: { ...original.dependencies } };
  assert.deepEqual(packaged, metadata, 'unexpected package metadata');
  const application = pe(path.join(target, '截个图.exe'));
  assert.equal(application.machine, '8664', 'application must be x64');
  const native = actual.filter(file => file.startsWith('native/')).map(file => pe(path.join(payload, file)));
  const portable = path.join(root, 'dist-review/截个图-审查试用版.exe');
  return { ok: true, payloadFiles: actual.length, sourceMatch: true, application, native,
    ...(fs.existsSync(portable) ? { portable: pe(portable) } : {}), manifest };
}
if (require.main === module) {
  const target = path.resolve(process.argv[2] || path.join(repoRoot, 'dist-review/win-unpacked'));
  const result = verifyPayload({ root: repoRoot, target });
  const output = path.join(repoRoot, 'dist-review/payload-verification.json');
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: true, payloadFiles: result.payloadFiles, sourceMatch: true,
    application: result.application, native: result.native, output }, null, 2));
}
module.exports = { verifyPayload, expectedFiles, gifencAllowlist };
