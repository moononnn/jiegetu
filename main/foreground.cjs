'use strict';
const path = require('node:path');
const { execFile: defaultExecFile } = require('node:child_process');

// Query the current foreground HWND and its process id, right before the selection
// window appears, so the wheel bridge can hand keyboard focus back to the page the
// user was on. Our own windows are dropped: activating a hidden helper is useless and
// would steal focus for nothing. Any failure is a missing hint, never a blocked capture.
function queryForegroundHwnd({ execFile = defaultExecFile, executable = path.join(__dirname, '../native/gdi-capture.exe'),
  selfPid = process.pid } = {}) {
  return new Promise(resolve => {
    try {
      execFile(executable, ['--fg'], { windowsHide: true, timeout: 4000 }, (error, stdout) => {
        if (error) return resolve(0);
        const match = /^(\d{1,19})\s+(\d{1,19})$/.exec(String(stdout ?? '').trim());
        if (!match) return resolve(0);
        const handle = Number(match[1]), owner = Number(match[2]);
        if (!Number.isSafeInteger(handle) || handle <= 0 || !Number.isSafeInteger(owner)) return resolve(0);
        resolve(owner === selfPid ? 0 : handle);
      });
    } catch { resolve(0); }
  });
}

module.exports = { queryForegroundHwnd };
