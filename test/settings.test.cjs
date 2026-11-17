'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSettings, normalizeHotkey, DEFAULTS, THEME_SOURCES } = require('../main/settings.cjs');

function tempFile(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jiege-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'settings.json');
}

test('快捷键只收认得的写法：功能键可单用，字母数字必须带修饰键', () => {
  assert.equal(normalizeHotkey('F1'), 'F1');
  assert.equal(normalizeHotkey('f9'), undefined, '小写不猜，交给界面自己拼');
  assert.equal(normalizeHotkey('F24'), 'F24');
  assert.equal(normalizeHotkey('Ctrl+Shift+a'), undefined);
  assert.equal(normalizeHotkey('Shift+Ctrl+A'), 'Ctrl+Shift+A', '修饰键顺序固定，避免同一组合两种写法');
  assert.equal(normalizeHotkey('CommandOrControl+Alt+S'), 'Ctrl+Alt+S');
  assert.equal(normalizeHotkey('Ctrl+Ctrl+A'), undefined);
  assert.equal(normalizeHotkey('A'), undefined, '单字母会抢掉打字');
  assert.equal(normalizeHotkey('Ctrl+'), undefined);
  assert.equal(normalizeHotkey(''), undefined);
  assert.equal(normalizeHotkey('Ctrl+F1'), 'Ctrl+F1');
  assert.equal(normalizeHotkey('Alt+PageDown'), 'Alt+PageDown');
  assert.equal(normalizeHotkey('F25'), undefined);
  assert.equal(normalizeHotkey({}), undefined);
});

test('首次运行给默认值，坏文件不挡启动', async t => {
  const file = tempFile(t);
  const fresh = createSettings({ file });
  assert.deepEqual(fresh.get(), DEFAULTS);

  fs.writeFileSync(file, '{这不是 JSON', 'utf8');
  assert.deepEqual(createSettings({ file }).get(), DEFAULTS);

  fs.writeFileSync(file, JSON.stringify({ hotkey: 'Ctrl+Shift+K', autoLaunch: 'yes', saveFolder: 'relative/path', lastSaveFolder: 42 }), 'utf8');
  const parsed = createSettings({ file }).get();
  assert.equal(parsed.hotkey, 'Ctrl+Shift+K');
  assert.equal(parsed.autoLaunch, false, '只认真正的布尔值');
  assert.equal(parsed.saveFolder, '', '相对路径不算有效保存目录');
  assert.equal(parsed.lastSaveFolder, '');
});

test('设置写进文件，重启后还在；非法值一律拒绝且不落盘', async t => {
  const file = tempFile(t);
  const settings = createSettings({ file });
  const folder = path.join(path.sep === '/' ? '/tmp' : 'C:\\', 'JieGeShots');
  settings.update({ hotkey: 'Ctrl+Alt+9', saveFolder: folder, lastSaveFolder: folder, autoLaunch: true, theme: 'dark' });
  const reopened = createSettings({ file });
  assert.deepEqual(reopened.get(), { hotkey: 'Ctrl+Alt+9', autoLaunch: true, saveFolder: folder, lastSaveFolder: folder, theme: 'dark',
    clipboard: { enabled: false, paused: false, hotkey: 'Ctrl+Alt+V', retentionDays: 30, maxHistoryItems: 1000,
      maxStorageBytes: 2147483648, excludedApps: [] } });

  assert.throws(() => settings.update({ hotkey: 'A' }), /快捷键格式无效/);
  assert.throws(() => settings.update({ saveFolder: 'not-absolute' }), /保存文件夹无效/);
  assert.equal(settings.get().hotkey, 'Ctrl+Alt+9', '拒绝之后状态不能变');
  assert.equal(createSettings({ file }).get().hotkey, 'Ctrl+Alt+9');
});

test('保存目录取用顺序：直接保存用设置值，另存为优先上次手选目录', async t => {  const file = tempFile(t);
  const settings = createSettings({ file });
  const fallback = path.join(path.sep === '/' ? '/tmp' : 'C:\\', 'pictures');
  assert.equal(settings.resolveSaveFolder(fallback), fallback, '没设置时回落到默认');
  assert.equal(settings.resolveAsFolder(fallback), fallback);
  const configured = path.join(path.sep === '/' ? '/tmp' : 'C:\\', 'shots');
  const picked = path.join(path.sep === '/' ? '/tmp' : 'C:\\', 'picked');
  settings.update({ saveFolder: configured });
  assert.equal(settings.resolveSaveFolder(fallback), configured);
  assert.equal(settings.resolveAsFolder(fallback), configured, '还没手选过时跟着设置走');
  settings.update({ lastSaveFolder: picked });
  assert.equal(settings.resolveAsFolder(fallback), picked, '另存为从上一次的位置开始');
  assert.equal(settings.resolveSaveFolder(fallback), configured, '直接保存仍然用自己的目录');
});

test('界面主题三态：默认跟随系统，旧设置/非法磁盘值回 system，update 非法值拒绝且不改状态', async t => {
  const file = tempFile(t);
  assert.deepEqual(THEME_SOURCES, ['system', 'light', 'dark']);
  assert.equal(DEFAULTS.theme, 'system', '默认跟随系统');
  assert.equal(createSettings({ file }).get().theme, 'system', '首次运行没有文件也是 system');

  // 旧设置根本没有 theme 字段。
  fs.writeFileSync(file, JSON.stringify({ hotkey: 'Ctrl+Alt+8', autoLaunch: true }), 'utf8');
  const migrated = createSettings({ file });
  assert.equal(migrated.get().theme, 'system', '旧设置迁移到 system');
  assert.equal(migrated.get().hotkey, 'Ctrl+Alt+8', '其它字段照旧读出来');

  // 磁盘上是认不得的值 / 类型不对：只回 system，不影响其它字段。
  for (const bogus of ['neon', 'SYSTEM', '', 1, null, true, {}, ['dark']]) {
    fs.writeFileSync(file, JSON.stringify({ theme: bogus, hotkey: 'Ctrl+Alt+8', autoLaunch: false }), 'utf8');
    const loaded = createSettings({ file });
    assert.equal(loaded.get().theme, 'system', `磁盘值 ${JSON.stringify(bogus)} 回到 system`);
    assert.equal(loaded.get().hotkey, 'Ctrl+Alt+8');
  }

  // update：三个合法值都能落盘，非法值抛错且状态/文件都不变。
  const settings = createSettings({ file });
  for (const source of THEME_SOURCES) {
    settings.update({ theme: source });
    assert.equal(settings.get().theme, source);
    assert.equal(createSettings({ file }).get().theme, source, '重启后还在');
  }
  settings.update({ theme: 'light' });
  for (const bad of ['neon', 'Light', '', 1, null, undefined, {}]) {
    assert.throws(() => settings.update({ theme: bad }), /主题设置无效/);
    assert.equal(settings.get().theme, 'light', '拒绝后状态不变');
    assert.equal(createSettings({ file }).get().theme, 'light', '也没有被写进文件');
  }
  // 同一次 update 里其它字段照常生效，不因 theme 校验挡住。
  settings.update({ hotkey: 'Ctrl+Alt+7', theme: 'system' });
  assert.equal(settings.get().hotkey, 'Ctrl+Alt+7');
  assert.equal(settings.get().theme, 'system');
});

test('剪贴板设置：默认全关、旧设置缺字段不开启、非法值拒绝且不落盘', async t => {
  const file = tempFile(t);
  const { CLIPBOARD_DEFAULTS: defaults, CLIPBOARD_CHOICES: choices } = require('../main/settings.cjs');
  assert.equal(defaults.enabled, false, '新安装默认关闭记录');
  assert.equal(defaults.paused, false);
  assert.equal(defaults.hotkey, 'Ctrl+Alt+V');

  // 旧文件没有 clipboard：不得因为缺失而被开启。
  fs.writeFileSync(file, JSON.stringify({ hotkey: 'F1' }), 'utf8');
  const loaded = createSettings({ file });
  assert.equal(loaded.getClipboard().enabled, false);
  assert.deepEqual(loaded.getClipboard().excludedApps, []);

  // 磁盘上是乱写的：逐字段回默认。
  fs.writeFileSync(file, JSON.stringify({ clipboard: { enabled: 'yes', hotkey: 'F1', retentionDays: 3, maxHistoryItems: -1, excludedApps: 'chrome' } }), 'utf8');
  const repaired = createSettings({ file }).getClipboard();
  assert.equal(repaired.enabled, false);
  assert.equal(repaired.hotkey, 'Ctrl+Alt+V');
  assert.equal(repaired.retentionDays, 30);
  assert.equal(repaired.maxHistoryItems, 1000);
  assert.deepEqual(repaired.excludedApps, []);

  // 写入：合法值持久，非法值抛错且内存与磁盘都不变。
  const settings = createSettings({ file });
  settings.updateClipboard({ enabled: true, paused: true, hotkey: 'Shift+Alt+V', retentionDays: 7,
    maxHistoryItems: 200, maxStorageBytes: choices.maxStorageBytes[0], excludedApps: ['Chrome.exe', 'chrome.exe', 'WeChat'] }, { strict: true });
  const saved = settings.getClipboard();
  assert.equal(saved.enabled, true);
  assert.equal(saved.paused, true);
  assert.deepEqual(saved.excludedApps, ['Chrome.exe', 'WeChat'], '同名进程去重');
  assert.equal(createSettings({ file }).getClipboard().retentionDays, 7, '重启后还在');

  for (const bad of [{ hotkey: 'F1' }, { hotkey: 'A' }, { retentionDays: 3 }, { maxHistoryItems: 999 }, { maxStorageBytes: 3 * 1024 * 1024 * 1024 }, { enabled: 'x' }, { excludedApps: 'x' }]) {
    assert.throws(() => settings.updateClipboard(bad, { strict: true }));
    assert.deepEqual(settings.getClipboard(), saved, '拒绝后状态不变');
  }
  assert.equal(createSettings({ file }).getClipboard().enabled, true, '磁盘上仍是上一个有效值');

  // 严格写入失败：内存与磁盘都不变。
  const before = settings.getClipboard();
  fs.mkdirSync(`${file}.tmp`, { recursive: true });
  assert.throws(() => settings.updateClipboard({ paused: false }, { strict: true }), /设置没有保存成功/);
  assert.deepEqual(settings.getClipboard(), before);
  fs.rmSync(`${file}.tmp`, { recursive: true, force: true });
});

// 两种确定性写失败：临时文件路径被目录占住（writeFileSync 失败）、目标路径被目录占住（renameSync 失败）。
const blockTempFile = file => fs.mkdirSync(`${file}.tmp`, { recursive: true });
const unblockTempFile = file => fs.rmSync(`${file}.tmp`, { recursive: true, force: true });

test('严格写入失败就抛错：内存与磁盘都不变，修好后重写可重启读回', async t => {
  const file = tempFile(t);
  const settings = createSettings({ file });
  settings.update({ hotkey: 'Ctrl+Alt+6', theme: 'dark' }, { strict: true });
  assert.equal(createSettings({ file }).get().theme, 'dark', '严格写入成功时就落盘，重启能读回');

  const saved = settings.get();
  blockTempFile(file);
  assert.throws(() => settings.update({ theme: 'light' }, { strict: true }), /设置没有保存成功/);
  assert.deepEqual(settings.get(), saved, '内存状态保持原样');
  assert.equal(createSettings({ file }).get().theme, 'dark', '磁盘上仍是上一个有效值');
  unblockTempFile(file);

  // 修好后重写：三态都能落盘并读回。
  for (const source of ['light', 'dark', 'system']) {
    settings.update({ theme: source }, { strict: true });
    assert.equal(createSettings({ file }).get().theme, source);
  }
});

test('严格写入：rename 目标被占成目录时同样抛错且不改内存，清开后恢复', async t => {
  const file = tempFile(t);
  const settings = createSettings({ file });
  const before = settings.get();
  fs.mkdirSync(file);                      // 目标路径本身是目录 → renameSync 失败
  assert.throws(() => settings.update({ theme: 'dark' }, { strict: true }), /设置没有保存成功/);
  assert.deepEqual(settings.get(), before, '内存不变');
  assert.equal(fs.statSync(file).isDirectory(), true, '磁盘上原东西不动（这里是被占住的目标）');
  fs.rmdirSync(file);
  settings.update({ theme: 'dark' }, { strict: true });
  assert.equal(createSettings({ file }).get().theme, 'dark', '清开后再写就能读回');
});

test('非严格写入保持旧行为：写失败只吞错、内存照改，其余字段的宽松语义不变', async t => {
  const file = tempFile(t);
  const settings = createSettings({ file });
  settings.update({ theme: 'light' }, { strict: true });
  blockTempFile(file);
  assert.doesNotThrow(() => settings.update({ hotkey: 'Ctrl+Alt+5', theme: 'dark' }), '非严格不抛');
  assert.equal(settings.get().theme, 'dark', '内存照改（旧契约）');
  assert.equal(settings.get().hotkey, 'Ctrl+Alt+5');
  assert.equal(createSettings({ file }).get().theme, 'light', '磁盘没变：重启会回旧值——这正是旧宽松语义');
  unblockTempFile(file);
  // 其它字段（hotkey/autoLaunch/saveFolder）仍用宽松路径，未被严格化。
  const folder = path.join(path.sep === '/' ? '/tmp' : 'C:\\', 'JieGeStrict');
  assert.doesNotThrow(() => settings.update({ autoLaunch: true, saveFolder: folder }));
  assert.equal(settings.get().autoLaunch, true);
  assert.equal(settings.get().saveFolder, folder);
});
