'use strict';

// Worker entry for the frozen-frame control detector.
//
// The detector itself is unchanged and lives in control-regions.js; this file only loads it
// (classic script, same origin) and answers one bounded sample per message. The main thread
// transfers the sample buffer, so the pixels never come back and the geometry work never
// happens on the input thread.
importScripts('./control-regions.js');

self.onmessage = event => {
  const { id, width, height, buffer } = event.data || {};
  let boxes = [];
  try {
    if (buffer && width > 0 && height > 0) {
      boxes = self.detectControlRegions(new Uint8ClampedArray(buffer), width, height) || [];
    }
  } catch {
    // A failing sample is reported as "no rectangles": the panel and MSAA fallbacks stay.
    boxes = [];
  }
  self.postMessage({ id, boxes });
};
