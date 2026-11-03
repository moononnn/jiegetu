'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createWinCapture } = require('../main/win-capture.cjs');

// Synthetic pipes only: never start a desktop capture in these tests.
test('GIF purpose explicitly selects cursor-inclusive native mode without affecting snapshot/scroll', () => {
  for (const [purpose, suffix] of [['record', ['--record']], ['snapshot', ['--snapshot']], ['scroll', []]]) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdin.end = () => {}; child.kill = () => {};
    let args, invokedExecutable;
    const source = createWinCapture({ x: -20, y: 5, width: 2, height: 2 }, {
      purpose, spawn: (exe, values) => { invokedExecutable = exe; args = values; return child; }
    });
    assert.deepEqual(args, ['-20', '5', '2', '2', ...suffix]);
    assert.equal(path.basename(invokedExecutable), purpose === 'record' ? 'wgc-record.exe' : 'wgc-capture.exe');
    source.stop();
  }
});

test('GIF capture rejects oversized frames and lazy start before spawning', () => {
  const never = () => { throw new Error('must not spawn'); };
  for (const [width, height] of [[2001, 2000], [4097, 1], [1, 4097]]) {
    assert.throws(() => createWinCapture({ x: 0, y: 0, width, height }, { purpose: 'record', spawn: never }), /采集范围/);
  }
  assert.throws(() => createWinCapture({ x: 0, y: 0, width: 2, height: 2 }, {
    purpose: 'record', deferredStart: true, spawn: never
  }), /只有普通快照/);
});

const executable = path.join(__dirname, '../native/wgc-record.exe');
test('built native recorder accepts --record but rejects excess geometry before allocating/capturing', {
  skip: process.platform !== 'win32' || !fs.existsSync(executable)
}, () => {
  for (const [width, height] of [[2001, 2000], [4097, 1], [1, 4097]]) {
    const result = spawnSync(executable, ['0', '0', String(width), String(height), '--record'], {
      windowsHide: true, timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /invalid-region/);
    assert.doesNotMatch(result.stderr, /invalid-arguments/);
    assert.equal(result.stdout, '');
  }
});
