'use strict';
// FIX-02：设置落盘失败时不能给假成功。settings.cjs 的严格写入本身由 settings.test.cjs 覆盖，
// 这里盯住 index.cjs 三个入口是否真的用了严格写入并在失败时回滚外部状态。
// 说明：这三处是 Electron IPC handler，行为级注入需要完整 app 夹具；本文件只做结构断言，
// 真实失败注入（无权限/磁盘满）留在 settings 层与上机验收。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'main', 'index.cjs'), 'utf8');

function block(anchor) {
  const start = SOURCE.indexOf(anchor);
  assert.ok(start >= 0, `源码里找不到入口：${anchor}`);
  const end = SOURCE.indexOf("\n  handle(", start + anchor.length);
  return end < 0 ? SOURCE.slice(start) : SOURCE.slice(start, end);
}

test('FIX-02 旧热键入口：严格写入，失败时把热键退回上一个', () => {
  const section = block("handle('shot:set-hotkey'");
  assert.match(section, /settings\.update\(\{ hotkey: normalized \}, \{ strict: true \}\)/);
  assert.doesNotMatch(section, /settings\.update\(\{ hotkey: normalized \}\)/, '不能保留非严格写入');
  assert.match(section, /previousHotkey/);
  assert.match(section, /applyHotkey\(previousHotkey\)/, '写盘失败要回退热键注册');
  assert.match(section, /快捷键没有改/);
});

test('FIX-02 保存文件夹：严格写入，失败时不改内存目录也不报成功', () => {
  const section = block("handle('shot:choose-save-folder'");
  assert.match(section, /settings\.update\(\{ saveFolder: result\.filePaths\[0\] \}, \{ strict: true \}\)/);
  assert.match(section, /保存文件夹没能记住/);
  const writeIndex = section.indexOf('settings.update');
  const assignIndex = section.indexOf('saveDirectory = result.filePaths[0]');
  assert.ok(assignIndex > writeIndex, '内存里的目录必须在写盘之后才改');
});

test('FIX-02 开机自启：严格写入，失败时把系统自启退回原状态', () => {
  const section = block("handle('shot:set-auto-launch'");
  assert.match(section, /settings\.update\(\{ autoLaunch: actual \}, \{ strict: true \}\)/);
  assert.match(section, /openAtLogin: before/, '写盘失败要用原状态回滚注册表');
  assert.match(section, /开机自启没能保存/);
  const readBefore = section.indexOf('before = app.getLoginItemSettings');
  const setWanted = section.indexOf('openAtLogin: wanted');
  assert.ok(readBefore > 0 && readBefore < setWanted, '必须先读原状态再改系统设置');
});

test('FIX-02 index.cjs 里不再有裸的 settings.update({...}) 调用', () => {
  const bare = [...SOURCE.matchAll(/settings\.update\(\{[^}]*\}\)/g)].map(match => match[0]);
  assert.deepEqual(bare, [], `仍有非严格写入：${bare.join(' / ')}`);
});