'use strict';
// README 演示图与仓库链接的定向用例：只读本地文件，不联网、不打包、不改图。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isPublicPath } = require('../scripts/prepare-public-source.cjs');

const ROOT = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const README = read('README.md');
const PKG = JSON.parse(read('package.json'));
const REPO = 'https://github.com/moononnn/jiegetu';
const SHOTS = ['assets/screenshots/annotation-editor.png', 'assets/screenshots/gif-editor.png'];

// 只读 PNG 块名，不改写文件。
function chunks(buffer) {
  const names = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    names.push(type);
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return names;
}

test('README 顶部三个链接指向同一个仓库，没有徽章', () => {
  const header = README.split('## 功能预览')[0];
  assert.match(header, new RegExp(`\\[moononnn/jiegetu\\]\\(${REPO}\\)`), '源码仓库链接');
  assert.match(header, new RegExp(`\\[Releases\\]\\(${REPO}/releases\\)`), '下载入口指向 Releases');
  assert.match(header, new RegExp(`\\[Issues\\]\\(${REPO}/issues\\)`), '反馈入口指向 Issues');
  assert.equal(/shields\.io|\bbadge\b/i.test(header), false, '不放徽章');
  assert.equal(/!\[/.test(header), false, '标题区不放图片');
});

test('package.json 的仓库元数据与 README 指向同一处', () => {
  assert.equal(PKG.repository.type, 'git');
  assert.equal(PKG.repository.url, `${REPO}.git`);
  assert.equal(PKG.homepage, `${REPO}#readme`);
  assert.equal(PKG.bugs.url, `${REPO}/issues`);
  assert.equal(PKG.repository.url.replace(/\.git$/, ''), REPO, '去掉 .git 后与 README 链接同源');
  for (const value of [PKG.repository.url, PKG.homepage, PKG.bugs.url]) {
    assert.match(value, /^https:\/\/github\.com\/moononnn\/jiegetu/, `${value} 不能指向别处`);
  }
});

test('README 只引用那两张本地演示图，文件真实存在且是完整 PNG', () => {
  const refs = [...README.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)].map(match => ({ alt: match[1], src: match[2] }));
  assert.deepEqual(refs.map(ref => ref.src), SHOTS, '两张演示图的顺序与路径固定');
  for (const ref of refs) {
    assert.ok(ref.alt.trim().length >= 6, `${ref.src} 要有说明性 alt`);
    assert.equal(/^[a-z]+:|^\/\//i.test(ref.src), false, '不引用外链图片');
    const buffer = fs.readFileSync(path.join(ROOT, ref.src));
    assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${ref.src} 是 PNG`);
    assert.equal(buffer.toString('ascii', 12, 16), 'IHDR', `${ref.src} 头部完整`);
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    assert.ok(width >= 1000 && height >= 800, `${ref.src} 尺寸 ${width}x${height} 太小，看不清界面`);
    assert.ok(buffer.length > 100 * 1024, `${ref.src} 只有 ${buffer.length} 字节，可能是占位图`);
    assert.equal(chunks(buffer).at(-1), 'IEND', `${ref.src} 不是截断的 PNG`);
    for (const meta of ['eXIf', 'tEXt', 'iTXt', 'zTXt']) {
      assert.equal(chunks(buffer).includes(meta), false, `${ref.src} 不该带 ${meta} 元数据`);
    }
  }
});

test('两张演示图进公开源码准备目录，其它截图和整目录都不行', () => {
  for (const src of SHOTS) assert.equal(isPublicPath(src), true, `${src} 必须能进准备目录`);
  for (const other of [
    'assets/screenshots/other.png', 'assets/screenshots/annotation-editor.webp',
    'assets/screenshots/private/gif-editor.png', 'assets/screenshots', 'assets/photo.png'
  ]) {
    assert.equal(isPublicPath(other), false, `${other} 不在名单里就不该复制`);
  }
});

test('演示图说明不冒充绑定，也不称安装包已经可以下载', () => {
  const preview = README.split('## 功能预览')[1].split('## 可以做什么')[0];
  assert.match(preview, /第三方界面/, '点明底图来自第三方');
  assert.match(preview, /没有关联/, '不宣称与截图里的产品有关联');
  assert.match(preview, /不绑定或依赖/, '不宣称绑定');
  assert.match(README, /安装版／免安装版/, 'Releases 旁边说明双版本下载');
  assert.match(README, /Jiegetu-0\.90\.0-Setup-x64\.exe/, '安装版使用确切文件名');
  assert.match(README, /Jiegetu-0\.90\.0-Portable-x64\.exe/, '免安装版使用确切文件名');
  assert.match(README, /SHA256SUMS\.txt/, '提示核对下载哈希');
  assert.match(README, /安装／卸载、自启与混合 DPI 尚未验收/, '不把静态核验冒充实装');
  for (const stale of [/已经可以下载/, /立即下载/, /点此下载/, /已发布安装包/]) {
    assert.equal(stale.test(README), false, `README 不该写 ${stale}`);
  }
});
