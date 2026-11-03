'use strict';
// 公开源码准备（本地整理，不发布、不上传、不建远程）。
// 只把仓库里允许公开的那一部分复制到 review-source/<时间戳>/，清单写在同级 <时间戳>.manifest.json。
// 这是「源码准备目录」，不是发布物：图标授权、安装包实测都还没定，见 manifest.blockers。
// 这里只查通用形状（凭据、私钥、用户目录、当前项目绝对路径），已知个人词的终扫由外部在候选目录外用 grep 做。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// —— 白名单：只有这些路径会被复制 ——
const CODE_DIRS = ['main', 'renderer', 'core', 'scripts', 'test'];
const NATIVE_SOURCE = /^native\/[^/]+\.cs$/;
const ASSET_FILES = new Set([
  'assets/app-icon.png', 'assets/app-icon.ico', 'assets/tray-scroll.png',
  // README 的演示截图：逐条列名，不放开整个 assets/screenshots 目录。
  'assets/screenshots/annotation-editor.png', 'assets/screenshots/gif-editor.png',
  // 图标来源与许可记录；可含待核标记，文件存在不代表授权审核通过。
  'assets/LICENSE.txt'
]);
const ROOT_FILES = new Set([
  '.gitignore', 'README.md', 'package.json', 'package-lock.json',
  'electron-builder.json', 'electron-builder.release.json',
  'THIRD-PARTY-NOTICES.md', 'LICENSE'
]);
const DOC_FILES = new Set(['docs/BUILDING.md', 'docs/RELEASE_CHECKLIST.md']);
// 开发机的诊断启动入口和只测这些入口的专用用例：本机保留，公开导出不带。
// 不带入口就不该带它们对应的测试，否则公开目录里 npm test 会因缺被测文件而失败。
// 逐个列确切路径，不用 diagnostic 这类词大面积过滤，免得误伤运行时排障模块。
const EXCLUDED_FILES = new Set([
  '启动截个图.cmd', '启动截个图（后台）.vbs',
  'scripts/diagnostic-launch.ps1',
  'test/diagnostic-launch.test.cjs', 'test/diagnostic-launcher.test.cjs'
]);
// 白名单内的目录也可能混进构建产物，一律不复制。
const BLOCKED_SUFFIX = /\.(exe|dll|node|asar|zip|7z|blockmap)$/i;
// 既有仓最多 265 个候选文件；准备目录不该越复制越多。
const MAX_FILES = 265;

// —— 隐私规则：只写通用形状，不嵌任何真实用户名、目录名或称呼 ——
// 用户目录：先把每行归一成“小写 + 只用正斜杠”的 flat 再匹配，反斜杠与正斜杠两种写法都吃得下。
// 占位名（test/someone/example/…）不算隐私。
const USER_PATH_RE = /[a-z]:\/users\/([^/\s]+)/g;
const PLACEHOLDER_USERS = new Set([
  'test', 'tester', 'user', 'user1', 'example', 'sample', 'demo',
  'public', 'placeholder', 'someone', 'nobody', 'fixture', 'anonymous', 'runner',
  // 测试里专门用来验“打码/脱敏”的假目录名
  'private', 'secret', 'redacted', 'xxx', 'foo', 'bar', 'baz'
]);
// 凭据/私钥只看形状，不认具体服务。
const CREDENTIAL_RULES = [
  { id: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { id: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  { id: 'openai-style-key', re: /\bsk-[A-Za-z0-9]{20,}/ },
  { id: 'github-token', re: /\bghp_[A-Za-z0-9]{36,}/ },
  { id: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { id: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/ }
];

const BLOCKERS = [
  '项目许可已写入根 LICENSE，但公开前仍要人工复核：确认条款没有超出版权持有人可授权的范围。',
  '图标授权未确认：assets 里图标的来源与再分发授权尚未核实。',
  '最终安装包/免安装包未构建实测：这里只是源码准备，没做真机打包、安装与卸载验证。'
];

function isPublicPath(rel) {
  if (!rel || rel.includes('\0') || rel.startsWith('/') || rel.includes('..')) return false;
  if (EXCLUDED_FILES.has(rel)) return false;
  if (BLOCKED_SUFFIX.test(rel)) return false;
  const top = rel.split('/')[0];
  if (CODE_DIRS.includes(top)) return true;
  if (NATIVE_SOURCE.test(rel)) return true;
  if (ASSET_FILES.has(rel)) return true;
  if (ROOT_FILES.has(rel)) return true;
  if (DOC_FILES.has(rel)) return true;
  return false;
}

// 纯函数：候选相对路径 → 白名单内的文件（排序后）+ 被排除的（便于对账）。
function select(candidates) {
  const files = [];
  const skipped = [];
  for (const raw of candidates || []) {
    if (typeof raw !== 'string') continue;
    const rel = raw.replace(/\\/g, '/');
    if (isPublicPath(rel)) files.push(rel);
    else skipped.push(rel);
  }
  files.sort();
  return { files, skipped };
}

// 纯函数：逐行查隐私特征，只返回规则名，不返回正文。
// paths：调用方传进来的绝对路径（一般是当前项目根与上一级），命中即视为泄露本机位置。
function detect(text, paths = []) {
  const ids = new Set();
  const needles = (paths || [])
    .map(value => String(value || '').replace(/[\\/]+/g, '/').toLowerCase())
    .filter(value => value.length >= 8 && value !== path.parse(value || '.').root.toLowerCase());
  for (const line of String(text || '').split(/\r?\n/)) {
    const flat = line.replace(/[\\/]+/g, '/').toLowerCase();
    for (const needle of needles) {
      if (flat.includes(needle)) ids.add('project-absolute-path');
    }
    USER_PATH_RE.lastIndex = 0;
    let match;
    while ((match = USER_PATH_RE.exec(flat)) !== null) {
      const name = String(match[1] || '').trim();
      if (!PLACEHOLDER_USERS.has(name)) ids.add('user-profile-path');
      if (match.index === USER_PATH_RE.lastIndex) USER_PATH_RE.lastIndex += 1;
    }
    for (const rule of CREDENTIAL_RULES) {
      if (rule.re.test(line)) ids.add(rule.id);
    }
  }
  return [...ids].sort();
}

// 纯函数：entries = [{ path, text, binary }] → 命中清单（只含路径与规则名）。
function scan(entries, options = {}) {
  const paths = options.paths || [];
  const findings = [];
  for (const entry of entries || []) {
    if (!entry || entry.binary) continue;
    const rules = detect(entry.text, paths);
    if (rules.length) findings.push({ path: entry.path, rules });
  }
  return findings;
}

function timestamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-`
    + `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function splitZ(output) {
  return String(output || '').split('\0').filter(Boolean);
}

// 候选来自 git（不含 .git 目录本身），带 .gitignore 过滤。
function listCandidates(root) {
  const tracked = splitZ(git(root, ['ls-files', '--cached', '-z']));
  const others = splitZ(git(root, ['ls-files', '--others', '--exclude-standard', '-z']));
  return { all: [...new Set([...tracked, ...others])].sort(), tracked, others };
}

function headCommit(root) {
  try { return git(root, ['rev-parse', 'HEAD']).trim(); }
  catch { return null; }
}

function changedPaths(root) {
  try { return new Set(splitZ(git(root, ['diff', '--name-only', '-z', 'HEAD']))); }
  catch { return new Set(); }
}

function assertNoSymlinks(root, files, lstat = fs.lstatSync) {
  const realRoot = fs.realpathSync(root);
  for (const rel of files) {
    const full = path.join(root, rel);
    let stats;
    try { stats = lstat(full); } catch (error) { throw new Error(`读不到 ${rel}：${error.code || error.message}`); }
    if (stats.isSymbolicLink()) throw new Error(`${rel} 是符号链接，拒绝生成`);
    const real = fs.realpathSync(full);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error(`${rel} 指向项目外，拒绝生成`);
  }
}

function readEntry(root, rel) {
  const buffer = fs.readFileSync(path.join(root, rel));
  const binary = buffer.includes(0);
  return {
    path: rel,
    buffer,
    binary,
    text: binary ? '' : buffer.toString('utf8'),
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    size: buffer.length
  };
}

// 许可证现状：缺文件不阻止生成待审目录，但要如实写进清单。
// ready 永远是 false：这份东西只是源码准备目录，最终交付物（安装包 + 免安装包）根本没做。
function readiness(root) {
  const hasLicense = fs.existsSync(path.join(root, 'LICENSE'));
  const hasIconLicense = fs.existsSync(path.join(root, 'assets', 'LICENSE.txt'));
  const iconPending = hasIconLicense && /TODO|未确认|待确认/.test(fs.readFileSync(path.join(root, 'assets', 'LICENSE.txt'), 'utf8'));
  const reasons = ['最终安装包与免安装包都还没构建实测：源码准备目录不等于可交付物'];
  if (!hasLicense) reasons.push('根目录没有 LICENSE：项目许可证还没定');
  if (!hasIconLicense) reasons.push('没有 assets/LICENSE.txt：图标授权还没确认');
  else if (iconPending) reasons.push('assets/LICENSE.txt 仍含待核标记：来源记录不等于分发权核实');
  return { metadataReady: hasLicense && hasIconLicense && !iconPending, reasons };
}

// 主流程：选文件 → 查链接 → 扫隐私 → 建新目录 → 复制并逐份对账 → 写清单。
// options: { root, outRoot, stamp, candidates, lstat }
function prepare(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const outRoot = path.resolve(options.outRoot || path.join(root, 'review-source'));
  const stamp = options.stamp || timestamp();
  const candidateInfo = options.candidates || listCandidates(root);
  const candidates = candidateInfo.all || candidateInfo;
  const untracked = new Set(candidateInfo.others || []);

  const { files } = select(candidates);
  if (!files.length) throw new Error('白名单里一个文件都没有，检查候选来源');
  if (files.length > MAX_FILES) throw new Error(`白名单选出 ${files.length} 个文件，超过上限 ${MAX_FILES}`);

  assertNoSymlinks(root, files, options.lstat);

  const entries = files.map(rel => readEntry(root, rel));
  // 只查当前项目所在地的绝对路径（运行时算，不写死任何本机路径）。
  const guardPaths = [root, path.dirname(root)];
  const findings = scan(entries, { paths: guardPaths });
  if (findings.length) {
    const error = new Error(`有 ${findings.length} 个文件命中隐私规则，已拒绝生成`);
    error.findings = findings;
    throw error;
  }

  fs.mkdirSync(outRoot, { recursive: true });
  const dir = path.join(outRoot, `源码准备-${stamp}`);
  if (fs.existsSync(dir)) throw new Error(`目标目录已存在，不覆盖：${path.relative(root, dir)}`);
  if (fs.existsSync(`${dir}.manifest.json`)) throw new Error(`清单已存在，不覆盖：${path.relative(root, dir)}.manifest.json`);

  fs.mkdirSync(dir);
  try {
    for (const entry of entries) {
      const target = path.join(dir, entry.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.buffer);
      const copied = fs.readFileSync(target);
      const sha = crypto.createHash('sha256').update(copied).digest('hex');
      if (sha !== entry.sha256 || copied.length !== entry.size) throw new Error(`复制后对账不一致：${entry.path}`);
    }
    const modified = changedPaths(root);
    const dirtySet = new Set([...modified, ...untracked]);
    const dirty = entries.some(entry => dirtySet.has(entry.path));
    const { metadataReady, reasons } = readiness(root);
    const manifest = {
      kind: 'prepared-source',
      note: '源码准备目录，不是发布物；图标授权与安装包实测仍未确定。',
      createdAt: new Date().toISOString(),
      baseCommit: headCommit(root),
      dirty,
      ready: false,
      metadataReady,
      readyReasons: reasons,
      counts: { files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0) },
      blockers: BLOCKERS,
      files: entries.map(entry => ({
        path: entry.path,
        sha256: entry.sha256,
        size: entry.size,
        dirty: dirtySet.has(entry.path)
      }))
    };
    const manifestPath = `${dir}.manifest.json`;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { dir, manifestPath, manifest };
  } catch (error) {
    // 中途失败就收掉这次刚建的空目录，别留半成品冒充准备目录。
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 收不掉就算了，报原始错误。 */ }
    throw error;
  }
}

if (require.main === module) {
  const cwd = process.cwd();
  const root = fs.existsSync(path.join(cwd, 'package.json')) ? cwd : path.join(__dirname, '..');
  try {
    const { dir, manifestPath, manifest } = prepare({ root });
    console.log(`已生成源码准备目录：${path.relative(root, dir)}`);
    console.log(`清单：${path.relative(root, manifestPath)}`);
    console.log(`文件 ${manifest.counts.files} 个，共 ${manifest.counts.bytes} 字节，基线 ${manifest.baseCommit}${manifest.dirty ? '（工作树有未提交改动）' : ''}`);
    console.log(`ready=false；许可证/图标说明齐备=${manifest.metadataReady}；${manifest.readyReasons.join('；')}`);
    console.log('这不是可发布产物，以下问题未解决：');
    for (const blocker of manifest.blockers) console.log(`  - ${blocker}`);
  } catch (error) {
    console.error(`没有生成准备目录：${error.message}`);
    for (const finding of error.findings || []) {
      // 只报路径与规则名，绝不打印命中行的正文。
      console.error(`  - ${finding.path}：${finding.rules.join(', ')}`);
    }
    process.exitCode = 1;
  }
}

module.exports = {
  select, scan, detect, prepare, listCandidates, assertNoSymlinks, isPublicPath, timestamp,
  BLOCKERS, EXCLUDED_FILES, MAX_FILES, PLACEHOLDER_USERS
};
