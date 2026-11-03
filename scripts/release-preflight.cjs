'use strict';
// 发布预检：挂在 electron-builder 的 beforePack，元数据、许可记录或原生 helper 不完整就直接中止。
// 只读检查：不构建 helper、不从 node_modules 复制任何东西，也没有跳过许可的开关。
const fs = require('node:fs');
const path = require('node:path');
const { gifencAllowlist } = require('./verify-review-build.cjs');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const HELPERS = Object.freeze(['wgc-capture.exe', 'wgc-record.exe', 'gdi-capture.exe', 'gif-clipboard.exe', 'ocr-helper.exe']);
const X64_MACHINE = 0x8664;

// CLI 传字符串；beforePack 传 context，兼容 context.appDir 与 context.packager.appDir。
function resolveRoot(options) {
  if (typeof options === 'string') return path.resolve(options);
  if (options && typeof options === 'object') {
    if (typeof options.root === 'string' && options.root) return path.resolve(options.root);
    if (typeof options.appDir === 'string' && options.appDir) return path.resolve(options.appDir);
    const packager = options.packager;
    if (packager && typeof packager.appDir === 'string' && packager.appDir) return path.resolve(packager.appDir);
  }
  return DEFAULT_ROOT;
}

function readJson(root, relative) {
  let text;
  try { text = fs.readFileSync(path.join(root, relative), 'utf8'); }
  catch { throw new Error(`缺少 ${relative}`); }
  try { return JSON.parse(text); }
  catch { throw new Error(`${relative} 不是有效 JSON`); }
}

function readNonEmpty(root, relative) {
  const file = path.join(root, relative);
  let stat;
  try { stat = fs.statSync(file); } catch { throw new Error(`缺少 ${relative}`); }
  if (!stat.isFile()) throw new Error(`缺少 ${relative}`);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { throw new Error(`无法读取 ${relative}`); }
  if (!text.trim()) throw new Error(`${relative} 内容为空`);
  return text;
}

function assertFile(root, relative) {
  let stat;
  try { stat = fs.statSync(path.join(root, relative)); } catch { throw new Error(`缺少 ${relative}`); }
  if (!stat.isFile()) throw new Error(`缺少 ${relative}`);
}

// 只读 PE 头：MZ → e_lfanew → PE 签名 → COFF machine。错误信息只用相对路径。
function peMachine(root, helper) {
  const relative = `native/${helper}`;
  const file = path.join(root, 'native', helper);
  let stat;
  try { stat = fs.statSync(file); } catch { throw new Error(`缺少 ${relative}`); }
  if (!stat.isFile()) throw new Error(`缺少 ${relative}`);
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { throw new Error(`无法读取 ${relative}`); }
  try {
    const dos = Buffer.alloc(64);
    if (fs.readSync(fd, dos, 0, 64, 0) !== 64) throw new Error(`${relative} 不是有效 PE（头部不完整）`);
    if (dos.toString('ascii', 0, 2) !== 'MZ') throw new Error(`${relative} 不是有效 PE（缺少 MZ）`);
    const offset = dos.readUInt32LE(0x3c);
    if (!Number.isInteger(offset) || offset < 64) throw new Error(`${relative} 不是有效 PE（e_lfanew 无效）`);
    const head = Buffer.alloc(6);
    if (fs.readSync(fd, head, 0, 6, offset) !== 6) throw new Error(`${relative} 不是有效 PE（头部不完整）`);
    if (head.toString('ascii', 0, 4) !== 'PE\0\0') throw new Error(`${relative} 不是有效 PE（缺少 PE 签名）`);
    return head.readUInt16LE(4);
  } catch (error) {
    if (error && error.code) throw new Error(`无法读取 ${relative}`);
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}

function checkRelease(options = {}) {
  const root = resolveRoot(options);
  const pkg = readJson(root, 'package.json');

  // 0.0.0 是开发占位版本；正式候选没定之前故意阻断，而不是带着占位版本发安装包。
  const version = typeof pkg.version === 'string' ? pkg.version.trim() : '';
  if (!version || version === '0.0.0') throw new Error('package.json 版本仍是 0.0.0；正式候选版本确定前不打包');

  const license = typeof pkg.license === 'string' ? pkg.license.trim() : '';
  if (!license || license.toUpperCase() === 'UNLICENSED') {
    throw new Error('package.json 缺少可用 license 或仍为 UNLICENSED');
  }

  readNonEmpty(root, 'LICENSE');

  // 图标权利由人核实；这里只检查记录文件存在且没有被留在待确认状态，不等于机器证明权利。
  const iconRecord = readNonEmpty(root, 'assets/LICENSE.txt');
  if (/\bTODO\b|未确认|待确认/i.test(iconRecord)) {
    throw new Error('assets/LICENSE.txt 仍含 TODO/未确认；图标权利需人工核实');
  }

  for (const helper of HELPERS) {
    const machine = peMachine(root, helper);
    if (machine !== X64_MACHINE) {
      throw new Error(`native/${helper} 不是 x64 PE（machine=0x${machine.toString(16)}）`);
    }
  }

  // 复用既有固定依赖校验：gifenc 版本、MIT 许可、lock 一致性和逐文件清单。
  let gifencFiles;
  try {
    gifencFiles = gifencAllowlist(root);
  } catch (error) {
    throw new Error(`gifenc 依赖校验未通过：${error.message}`);
  }

  assertFile(root, 'THIRD-PARTY-NOTICES.md');

  return { ok: true, version, helpers: HELPERS.slice(), gifencFiles };
}

function beforePack(context) {
  return checkRelease(context);
}

// CJS 入口直接导出可调用函数，builder 默认按函数 require 也能用；同时把辅助函数附作属性，
// 现有测试的 { checkRelease, beforePack, HELPERS } 解构保持不变。
beforePack.DEFAULT_ROOT = DEFAULT_ROOT;
beforePack.HELPERS = HELPERS;
beforePack.X64_MACHINE = X64_MACHINE;
beforePack.resolveRoot = resolveRoot;
beforePack.checkRelease = checkRelease;
beforePack.beforePack = beforePack;
module.exports = beforePack;

// CLI 入口：打印相对原因，不输出暂存绝对路径。
if (require.main === module) {
  try {
    const report = checkRelease({ root: process.argv[2] || DEFAULT_ROOT });
    console.log(`发布预检通过：版本 ${report.version}，${report.helpers.length} 个原生 helper，gifenc 许可已核。`);
  } catch (error) {
    console.error(`发布预检未通过：${error.message}`);
    process.exitCode = 1;
  }
}
