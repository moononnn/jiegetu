'use strict';
// Uses the existing Windows Framework compiler and Windows SDK; installs nothing.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function build({ cursorTest = false, recording = false } = {}) {
  if (cursorTest && recording) throw new Error('测试指针与录制构建不能混用');
  if (process.platform !== 'win32') throw new Error('原生采集组件只能在 Windows 构建');
  const windows = process.env.WINDIR || process.env.SystemRoot;
  const csc = path.join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const metadataRoot = path.join(process.env['ProgramFiles(x86)'], 'Windows Kits', '10', 'UnionMetadata');
  const versions = fs.readdirSync(metadataRoot).filter(name => /^\d+(\.\d+){3}$/.test(name)).sort((a,b) => b.localeCompare(a, undefined, { numeric: true }));
  const metadata = versions.map(name => path.join(metadataRoot, name, 'Windows.winmd')).find(file => fs.existsSync(file));
  if (!metadata || !fs.existsSync(csc)) throw new Error('缺少本地 Windows SDK 或 Framework 编译器；没有尝试安装');
  const references = ['System.Runtime', 'System.Runtime.WindowsRuntime', 'System.Runtime.InteropServices.WindowsRuntime'].map(name => {
    const root = path.join(windows, 'Microsoft.NET', 'assembly', 'GAC_MSIL', name);
    const version = fs.readdirSync(root).find(value => value.startsWith('v4.0_4.0.0.0__'));
    if (!version) throw new Error(`缺少系统程序集 ${name}`);
    return path.join(root, version, `${name}.dll`);
  });
  const root = path.resolve(__dirname, '..');
  // Separate recording output avoids overwriting a helper currently held by the screenshot warm source.
  const output = path.join(root, cursorTest ? 'experiments/wgc-cursor-included.exe' : recording ? 'native/wgc-record.exe' : 'native/wgc-capture.exe');
  const args = ['/nologo', '/utf8output', '/optimize+', '/platform:x64', '/target:exe', `/out:${output}`,
    `/r:${metadata}`, ...references.map(file => `/r:${file}`), ...(cursorTest ? ['/define:INCLUDE_CURSOR_TEST'] : []), path.join(root, 'native/wgc-capture.cs')];
  const result = spawnSync(csc, args, { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  if (result.error || result.status !== 0 || !fs.existsSync(output)) throw new Error(result.error?.message || result.stdout || result.stderr || '原生组件构建没有生成有效产物');
  if (cursorTest) {
    const cursorOutput = path.join(root, 'experiments/cursor-state.exe');
    const cursor = spawnSync(csc, ['/nologo', '/utf8output', '/platform:x64', '/target:exe', `/out:${cursorOutput}`, path.join(root, 'experiments/cursor-state.cs')], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
    if (cursor.error || cursor.status !== 0 || !fs.existsSync(cursorOutput)) throw new Error(cursor.error?.message || cursor.stdout || '测试指针状态组件构建失败');
  }
  return output;
}
if (require.main === module) {
  try { console.log(build({ cursorTest: process.argv.includes('--cursor-test'), recording: process.argv.includes('--record') })); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { build };
