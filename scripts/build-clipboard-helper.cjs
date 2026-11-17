'use strict';
// 本机 .NET Framework 4.0 编译器，不装 SDK/NuGet、不联网。
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function build({ platform = process.platform, windowsRoot = process.env.WINDIR || process.env.SystemRoot,
  run = spawnSync, root = path.resolve(__dirname, '..') } = {}) {
  if (platform !== 'win32') throw new Error('剪贴板组件只能在 Windows 构建');
  const framework = path.join(windowsRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const csc = path.join(framework, 'csc.exe');
  if (!fs.existsSync(csc)) throw new Error('缺少本机 Framework 编译器；没有尝试安装');
  // JSON 解析与 Windows 剪贴板都需要明确引用；缺任一程序集就直说要装什么，不静默降级。
  const references = ['System.dll', 'System.Core.dll', 'System.Windows.Forms.dll', 'System.Drawing.dll',
    'System.Web.Extensions.dll'];
  for (const name of references) {
    if (!fs.existsSync(path.join(framework, name))) throw new Error(`缺少 ${name}；需要在有 .NET Framework 4.0 的机器上构建`);
  }
  const output = path.join(root, 'native/clipboard-helper.exe');
  const args = ['/noconfig', '/nologo', '/utf8output', '/warnaserror+', '/optimize+', '/platform:x64', '/target:exe', `/out:${output}`,
    ...references.map(name => `/r:${path.join(framework, name)}`),
    path.join(root, 'native/clipboard-helper.cs')];
  const result = run(csc, args, { windowsHide: true, encoding: 'utf8', timeout: 60000 });
  if (result.error || result.status !== 0 || !fs.existsSync(output)) {
    throw new Error(result.error?.message || result.stdout || result.stderr || '剪贴板组件构建未生成有效产物');
  }
  return output;
}
if (require.main === module) {
  try { console.log(build()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { build };
