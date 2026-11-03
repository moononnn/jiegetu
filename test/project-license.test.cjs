'use strict';
// 项目许可的定向用例：元数据、根 LICENSE、公开文档说的是同一个边界；不做逐字快照。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const PKG = JSON.parse(read('package.json'));
const LOCK = JSON.parse(read('package-lock.json'));
const LICENSE = read('LICENSE');
const README = read('README.md');

test('package.json 指向根 LICENSE，lock 根包声明与之一致', () => {
  assert.equal(PKG.license, 'SEE LICENSE IN LICENSE');
  const root = LOCK.packages[''];
  assert.equal(root.license, PKG.license, 'lock 根包 license 要与 package.json 一致');
  assert.equal(root.name, PKG.name);
  assert.equal(root.version, PKG.version, '不改版本：lock 与 package 保持同版本');
});

test('根 LICENSE 是这份自定义许可，而不是常见开源许可的改名版', () => {
  assert.equal(fs.statSync(path.join(ROOT, 'LICENSE')).isFile(), true, '根 LICENSE 必须存在');
  assert.ok(LICENSE.trim().length > 500, '许可应是正文，不是占位符');
  assert.match(LICENSE, /截个图免费使用与禁止收费转售许可 1\.0/, '标题带版本号');
  assert.match(LICENSE, /2026/, '版权年份');
  assert.match(LICENSE, /moononnn/, '版权持有人与其它公开项目一致');
  for (const name of ['MIT', 'GPL', 'LGPL', 'Apache', 'BSD', 'PolyForm']) {
    assert.equal(new RegExp(`\\b${name}\\b`).test(LICENSE), false, `不使用 ${name} 的名称`);
  }
  const clauses = LICENSE.match(/^[一二三四五六七八]、/gm) || [];
  assert.ok(clauses.length >= 6, `分条许可，至少 6 条，实际 ${clauses.length}`);
});

test('工作用途和收费内容里的截图/GIF 明确免费允许，不额外加规模或收入门槛', () => {
  assert.match(LICENSE, /个人、企业或其他组织/, '主体覆盖个人与组织');
  assert.match(LICENSE, /免费使用/);
  assert.match(LICENSE, /接单为客户截图/, '接单给客户截图要写明白允许');
  assert.match(LICENSE, /收费产品或收费内容中使用本软件的产出/, '收费内容里用产出也允许');
  assert.match(LICENSE, /不必额外署名/, '使用不额外要求署名');
  for (const banned of [/禁止商业使用/, /不得用于商业/, /员工人数/, /年收入/, /营业额/, /公司规模不超过/]) {
    assert.equal(banned.test(LICENSE), false, `不该出现 ${banned}`);
  }
});

test('产出条款放开商业利用，但不连同画面里的第三方内容一起授权', () => {
  const [, output = ''] = LICENSE.split('四、软件产出');
  const clause = output.split('五、禁止收费转售')[0];
  assert.match(clause, /截图/);
  assert.match(clause, /GIF/);
  assert.match(clause, /商业利用/);
  assert.match(clause, /无需向版权持有人付费或署名/);
  assert.match(clause, /不授予你输出画面中第三方内容的任何权利/, '第三方内容权利不随产出放出去');
});

test('禁止的是对软件和修改版收费，不波及产出与用软件接的活', () => {
  const [, resale = ''] = LICENSE.split('五、禁止收费转售');
  const clause = resale.split('六、免责与责任限制')[0];
  assert.match(clause, /收费销售/);
  assert.match(clause, /付费下载/);
  assert.match(clause, /授权、许可、激活或类似权利/);
  assert.match(clause, /事先书面同意/, '收费要另获事先书面授权');
  assert.match(clause, /本条限制针对软件本身及其修改版/, '禁止范围限定在软件本体');
  assert.match(clause, /不针对软件产出/, '产出不受这条限制');
  assert.match(clause, /以本软件为工具提供的正当服务/, '不禁止用软件提供正当服务');
});

test('README 不再称项目许可待定，写清边界并链到 LICENSE', () => {
  const [, section = ''] = README.split('## 许可');
  assert.ok(section.trim(), 'README 要有许可节');
  assert.match(section, /\]\(LICENSE\)/, '许可节链到根 LICENSE');
  assert.match(section, /不是 OSI 认可的开源许可/, '说明源码公开但不等于 OSI 开源');
  assert.match(section, /接单给客户截图/);
  assert.match(section, /收费产品、收费内容/);
  assert.match(section, /禁止收费转售软件/);
  assert.match(section, /THIRD-PARTY-NOTICES\.md/);
  assert.match(section, /自行生成/, '图标来源按已知事实记录');
  assert.match(section, /图标.{0,40}尚未核实/, '图标工具授权不写成已核实');
  for (const stale of [/确定后会提供根目录 `LICENSE`/, /许可证和图标素材的发布授权尚待确认/, /许可证待选/, /项目许可待选/]) {
    assert.equal(stale.test(README), false, `README 不该再出现 ${stale}`);
  }
});

test('免费分发可保留随软件标识，修改版不得冒充官方但不禁止改名', () => {
  assert.match(LICENSE, /为按本许可分发软件而保留其原有标识和署名，不受此限/);
  assert.match(LICENSE, /暗示修改版是官方版本/);
  assert.doesNotMatch(LICENSE, /不得改名/);
  assert.match(LICENSE, /第三方组件按其自身许可提供，不因本许可而改变/);
  assert.match(LICENSE, /其他接收者，其授权不因你的违约而终止/);
});

test('公开文档不再把项目许可写成未定项', () => {
  for (const relative of ['README.md', 'docs/BUILDING.md', 'docs/RELEASE_CHECKLIST.md']) {
    const text = read(relative);
    assert.equal(/没有 LICENSE/.test(text), false, `${relative} 不该再说仓库没有 LICENSE`);
    for (const stale of [/项目许可证未确定/, /许可证未定/, /许可待选/, /项目许可证尚待/, /未选项目许可/]) {
      assert.equal(stale.test(text), false, `${relative} 不该再称项目许可待定：${stale}`);
    }
  }
  assert.match(read('docs/RELEASE_CHECKLIST.md'), /\[x\] 项目许可证已确定/, '检查表的许可项已勾掉');
  assert.match(read('docs/RELEASE_CHECKLIST.md'), /assets\/LICENSE\.txt/, '图标授权仍列在未完成门禁里');
  assert.match(read('docs/BUILDING.md'), /LICENSE/, '构建说明能指到根许可');
});
