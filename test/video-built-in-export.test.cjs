'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { createBuiltInVideoExporter } = require('../main/video-built-in-export.cjs');

function harness() {
  const handlers = new Map();
  let latest, network, permission;
  class Window extends EventEmitter {
    constructor(options) {
      super(); latest = this; this.options = options;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: {}, setWindowOpenHandler() {},
        ipc: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) },
      });
    }
    loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const session = { fromPartition(name) {
    assert.doesNotMatch(name, /^persist:/);
    return { setPermissionCheckHandler: fn => { permission = fn; }, setPermissionRequestHandler() {},
      webRequest: { onBeforeRequest: fn => { network = fn; } } };
  } };
  return { run: createBuiltInVideoExporter({ BrowserWindow: Window, session }), handlers,
    get win() { return latest; }, canRequest: url => network({ url }, outcome => !outcome.cancel), permission: () => permission() };
}
const request = { original: { bytes: Uint8Array.of(1), hasAudio: false }, plan: {} };
const eventFor = win => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });

test('isolated export accepts only its own loaded page, once; abort tears down handlers', async () => {
  const h = harness(), abort = new AbortController();
  const pending = h.run({ ...request, signal: abort.signal });
  const load = h.handlers.get('video-offline:load');
  const event = eventFor(h.win);
  assert.equal(h.win.options.webPreferences.sandbox, true);
  assert.equal(h.win.options.webPreferences.nodeIntegration, false);
  assert.equal(h.permission(), false);
  assert.equal(h.canRequest('https://example.com/'), false);
  assert.throws(() => load({ ...event, senderFrame: {} }), /export-input/);
  assert.deepEqual(load(event), request);
  assert.throws(() => load(event), /export-input/);
  await assert.rejects(h.run(request), { code: 'export-busy' });
  abort.abort();
  await assert.rejects(pending, { code: 'export-aborted' });
  assert.equal(h.handlers.size, 0);
  assert.equal(h.win.destroyed, true);
  assert.throws(() => load(event), /export-input/);
});

test('invalid output and renderer failures are bounded and release the next job', async () => {
  const h = harness();
  let pending = h.run(request), event = eventFor(h.win);
  h.handlers.get('video-offline:load')(event);
  h.handlers.get('video-offline:complete')(event, { bytes: Uint8Array.of(0), mimeType: 'video/mp4', extension: 'mp4' });
  await assert.rejects(pending, { code: 'export-encoder' });
  pending = h.run(request); event = eventFor(h.win);
  h.handlers.get('video-offline:load')(event);
  h.handlers.get('video-offline:fail')(event, 'untrusted details');
  await assert.rejects(pending, { message: 'export-failed', code: 'export-failed' });
  assert.equal(h.handlers.size, 0);
});
