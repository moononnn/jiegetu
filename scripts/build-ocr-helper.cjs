'use strict';
// Builds the offline OCR helper with the local Framework compiler and the local Windows SDK.
// Reuses the same SDK metadata and WinRT facade assemblies as build-capture.cjs; installs nothing.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function build({ platform = process.platform, windowsRoot = process.env.WINDIR || process.env.SystemRoot,
  programFilesX86 = process.env['ProgramFiles(x86)'], run = spawnSync, root = path.resolve(__dirname, '..') } = {}) {
  if (platform !== 'win32') throw new Error('离线识别组件只能在 Windows 构建');
  const csc = path.join(windowsRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const metadataRoot = path.join(programFilesX86, 'Windows Kits', '10', 'UnionMetadata');
  if (!fs.existsSync(csc) || !fs.existsSync(metadataRoot)) throw new Error('缺少本机 Windows SDK 或 Framework 编译器；没有尝试安装');
  const versions = fs.readdirSync(metadataRoot).filter(name => /^\d+(\.\d+){3}$/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const metadata = versions.map(name => path.join(metadataRoot, name, 'Windows.winmd')).find(file => fs.existsSync(file));
  if (!metadata) throw new Error('缺少 Windows SDK 的 Windows.winmd；没有尝试安装');
  const assembly = name => {
    const base = path.join(windowsRoot, 'Microsoft.NET', 'assembly', 'GAC_MSIL', name);
    if (!fs.existsSync(base)) throw new Error(`缺少系统程序集 ${name}`);
    const version = fs.readdirSync(base).find(value => value.startsWith('v4.0_4.0.0.0__'));
    if (!version) throw new Error(`缺少系统程序集 ${name}`);
    return path.join(base, version, `${name}.dll`);
  };
  // System.Drawing is a local .NET Framework assembly (PNG decode + white composite); no NuGet, no download.
  // It is already in the compiler's default response file, so passing it again would be a duplicate identity (CS1703).
  const references = ['System.Runtime', 'System.Runtime.WindowsRuntime', 'System.Runtime.InteropServices.WindowsRuntime'].map(assembly);
  const output = path.join(root, 'native/ocr-helper.exe');
  const args = ['/nologo', '/utf8output', '/optimize+', '/platform:x64', '/target:exe', `/out:${output}`,
    `/r:${metadata}`, ...references.map(file => `/r:${file}`), path.join(root, 'native/ocr-helper.cs')];
  const result = run(csc, args, { windowsHide: true, encoding: 'utf8', timeout: 60000 });
  if (result.error || result.status !== 0 || !fs.existsSync(output)) {
    throw new Error(result.error?.message || result.stdout || result.stderr || '离线识别组件构建没有生成有效产物');
  }
  return output;
}
if (require.main === module) {
  try { console.log(build()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { build };
