'use strict';
// Builds the DXGI Desktop Duplication capture candidate with the already installed Framework
// compiler. Installs nothing, adds no third-party dependency, and does not touch the WGC helper.
// The source only uses dxgi.dll / d3d11.dll / user32.dll, so no Windows SDK metadata is needed.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function build() {
  if (process.platform !== 'win32') throw new Error('DXGI 采集组件只能在 Windows 构建');
  const windows = process.env.WINDIR || process.env.SystemRoot;
  const csc = path.join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const root = path.resolve(__dirname, '..');
  const source = path.join(root, 'native', 'dxgi-capture.cs');
  const output = path.join(root, 'native', 'dxgi-capture.exe');
  if (!fs.existsSync(csc)) throw new Error('缺少本机 Framework64 编译器；没有尝试安装');
  if (!fs.existsSync(source)) throw new Error('缺少 native/dxgi-capture.cs');
  const args = ['/nologo', '/utf8output', '/optimize+', '/platform:x64', '/target:exe', `/out:${output}`, source];
  const result = spawnSync(csc, args, { windowsHide: true, encoding: 'utf8', timeout: 60000 });
  if (result.error || result.status !== 0 || !fs.existsSync(output)) {
    throw new Error((result.error && result.error.message) || (result.stdout || '') + (result.stderr || '') || 'DXGI 组件构建没有生成有效产物');
  }
  return output;
}

if (require.main === module) {
  try { console.log(build()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { build };
