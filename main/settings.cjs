'use strict';
// 用户设置：快捷键、开机自启、保存文件夹。文件坏了就回默认值，不影响开程序。
const path = require('node:path');
const fs = require('node:fs');

const DEFAULTS = { hotkey: 'F1', autoLaunch: false, saveFolder: '', lastSaveFolder: '', theme: 'system' };
// 界面主题三态：跟随系统 / 浅色 / 深色。
const THEME_SOURCES = ['system', 'light', 'dark'];
const KEY = '(?:F(?:[1-9]|1[0-9]|2[0-4])|[A-Z0-9]|Up|Down|Left|Right|Home|End|PageUp|PageDown|Space|Tab)';
const ACCELERATOR = new RegExp(`^(?:(?:Ctrl|Alt|Shift|Super)\\+)*${KEY}$`);
const FUNCTION_KEY = /^F(?:[1-9]|1[0-9]|2[0-4])$/;
const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Super'];

// 只收认得的写法：修饰键顺序固定、不许重复、单键必须是功能键（免得抢掉打字）。
function normalizeHotkey(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().replace(/\s+/g, '');
  if (!text || text.length > 40) return undefined;
  const parts = text.split('+').map(part => part === 'CommandOrControl' || part === 'Control' ? 'Ctrl' : part);
  const key = parts.pop();
  if (!key) return undefined;
  const modifiers = new Set();
  for (const part of parts) {
    if (!MODIFIER_ORDER.includes(part) || modifiers.has(part)) return undefined;
    modifiers.add(part);
  }
  const normalized = [...MODIFIER_ORDER.filter(name => modifiers.has(name)), key].join('+');
  if (!ACCELERATOR.test(normalized)) return undefined;
  if (!modifiers.size && !FUNCTION_KEY.test(key)) return undefined;
  return normalized;
}

function absoluteDirectory(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.length < 3 || text.length > 400 || text.includes('\0')) return undefined;
  return path.isAbsolute(text) ? text : undefined;
}

function createSettings({ file }) {
  let state = { ...DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') {
      state.hotkey = normalizeHotkey(raw.hotkey) || DEFAULTS.hotkey;
      state.autoLaunch = raw.autoLaunch === true;
      state.saveFolder = absoluteDirectory(raw.saveFolder) || '';
      state.lastSaveFolder = absoluteDirectory(raw.lastSaveFolder) || '';
      // 旧设置没有 theme、或磁盘上写了认不得的值，一律回到跟随系统。
      state.theme = THEME_SOURCES.includes(raw.theme) ? raw.theme : DEFAULTS.theme;
    }
  } catch { /* 首次启动或文件损坏：用默认值，不阻断。 */ }
  // 写盘：成功 true、失败 false。value 默认是当前状态；严格更新用下一次的完整值先写再替换内存。
  function persist(value = state) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
      fs.renameSync(temp, file);
      return true;
    } catch { return false; }
  }
  return {
    file,
    get: () => ({ ...state }),
    // strict=false 沿用旧语义：先改内存再尝试落盘，写失败只影响下次启动。
    // strict=true：先把下一份完整设置写进文件，写成功才替换内存；写失败抛错，内存与磁盘都保持原样。
    update(patch = {}, { strict = false } = {}) {
      const next = { ...state };
      if ('hotkey' in patch) {
        const hotkey = normalizeHotkey(patch.hotkey);
        if (!hotkey) throw new Error('快捷键格式无效');
        next.hotkey = hotkey;
      }
      if ('autoLaunch' in patch) next.autoLaunch = patch.autoLaunch === true;
      if ('saveFolder' in patch) {
        const directory = absoluteDirectory(patch.saveFolder);
        if (!directory) throw new Error('保存文件夹无效');
        next.saveFolder = directory;
      }
      if ('lastSaveFolder' in patch) {
        const directory = absoluteDirectory(patch.lastSaveFolder);
        if (!directory) throw new Error('文件夹无效');
        next.lastSaveFolder = directory;
      }
      if ('theme' in patch) {
        if (!THEME_SOURCES.includes(patch.theme)) throw new Error('主题设置无效');
        next.theme = patch.theme;
      }
      if (strict) {
        if (!persist(next)) throw new Error('设置没有保存成功，已保留原来的设置');
        state = next;
        return { ...state };
      }
      state = next;
      persist();
      return { ...state };
    },
    // 直接保存用的文件夹；另存为的起点优先用上次手动选过的目录。
    resolveSaveFolder(fallback) { return state.saveFolder || fallback; },
    resolveAsFolder(fallback) { return state.lastSaveFolder || state.saveFolder || fallback; }
  };
}

module.exports = { createSettings, normalizeHotkey, DEFAULTS, THEME_SOURCES };
