'use strict';
// Local .NET Framework only: no SDK, NuGet or downloads.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function build({ platform = process.platform, windowsRoot = process.env.WINDIR || process.env.SystemRoot,
  run = spawnSync, root = path.resolve(__dirname, '..') } = {}) {
  if (platform !== 'win32') throw new Error('GIF 复制组件只能在 Windows 构建');
  const framework = path.join(windowsRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const csc = path.join(framework, 'csc.exe');
  if (!fs.existsSync(csc)) throw new Error('缺少本机 Framework 编译器；没有尝试安装');
  const output = path.join(root, 'native/gif-clipboard.exe');
  // /noconfig makes references explicit and avoids duplicate compiler response-file identities.
  const args = ['/noconfig', '/nologo', '/utf8output', '/optimize+', '/platform:x64', '/target:exe', `/out:${output}`,
    ...['System.dll', 'System.Windows.Forms.dll', 'System.Drawing.dll'].map(name => `/r:${path.join(framework, name)}`),
    path.join(root, 'native/gif-clipboard.cs')];
  const result = run(csc, args, { windowsHide: true, encoding: 'utf8', timeout: 60000 });
  if (result.error || result.status !== 0 || !fs.existsSync(output)) {
    throw new Error(result.error?.message || result.stdout || result.stderr || 'GIF 复制组件构建未生成有效产物');
  }
  return output;
}
if (require.main === module) {
  try { console.log(build()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { build };
