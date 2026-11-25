'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { validateOutput, VIDEO_LIMITS: { MAX_BYTES } } = require('../core/video-session.mjs');

const page = path.join(__dirname, '../renderer/video-built-in-export.html');
const preload = path.join(__dirname, 'video-built-in-export-preload.cjs');
const channels = ['video-offline:load', 'video-offline:complete', 'video-offline:fail'];
const reportedErrors = new Set(['export-input', 'export-timing', 'export-encoder', 'export-failed']);
const error = code => Object.assign(new Error(code), { code });

function createBuiltInVideoExporter({ BrowserWindow, session, timeoutMs = 120_000 }) {
  let active = false, isolated;
  return async function exportVideo({ original, plan, signal }) {
    if (signal?.aborted) throw error('export-aborted');
    if (active) throw error('export-busy');
    if (!(original?.bytes instanceof Uint8Array) || !original.bytes.length || original.bytes.length > MAX_BYTES ||
        typeof original.hasAudio !== 'boolean') throw error('export-input');
    active = true;
    try {
      if (!isolated) {
        const next = session.fromPartition('jiegetu-video-offline');
        next.setPermissionRequestHandler((_contents, _permission, done) => done(false));
        next.setPermissionCheckHandler(() => false);
        next.webRequest.onBeforeRequest(({ url }, done) => done({ cancel: !url.startsWith('file:') }));
        isolated = next;
      }
      return await new Promise((resolve, reject) => {
        const win = new BrowserWindow({ show: false, skipTaskbar: true, webPreferences: {
          session: isolated, preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
        } });
        const contents = win.webContents, ipc = contents.ipc;
        let loaded = false, finished = false, timer;
        const settle = (failure, output) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          for (const channel of channels) ipc.removeHandler(channel);
          if (!win.isDestroyed()) win.destroy();
          if (failure) reject(failure); else resolve(output);
        };
        const abort = () => settle(error('export-aborted'));
        const sameFrame = event => !finished && event.sender === contents &&
          event.senderFrame && event.senderFrame === contents.mainFrame && event.senderFrame.url === pathToFileURL(page).href;
        try {
          contents.setWindowOpenHandler(() => ({ action: 'deny' }));
          contents.on('will-navigate', event => event.preventDefault());
          contents.on('will-frame-navigate', event => event.preventDefault());
          contents.once('render-process-gone', () => settle(error('export-failed')));
          win.once('closed', () => settle(error('export-failed')));
          ipc.handle(channels[0], event => {
            if (!sameFrame(event) || loaded) throw error('export-input');
            loaded = true;
            return { original, plan };
          });
          ipc.handle(channels[1], (event, payload) => {
            if (!sameFrame(event) || !loaded) return;
            try {
              const { bytes, mimeType, extension } = payload ?? {};
              if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_BYTES) throw error('export-encoder');
              validateOutput({ bytes, mimeType, extension, hasAudio: original.hasAudio });
              settle(null, { bytes, mimeType, extension });
            } catch { settle(error('export-encoder')); }
          });
          ipc.handle(channels[2], (event, code) => {
            if (!sameFrame(event) || !loaded) return;
            settle(error(reportedErrors.has(code) ? code : 'export-failed'));
          });
          timer = setTimeout(() => settle(error('export-tool')), timeoutMs);
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) return abort();
          Promise.resolve(win.loadFile(page)).catch(() => settle(error('export-failed')));
        } catch { settle(error('export-failed')); }
      });
    } finally { active = false; }
  };
}

module.exports = { createBuiltInVideoExporter };
