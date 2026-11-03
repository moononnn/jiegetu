import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScrollSession } from '../core/scroll-session.mjs';
import { createAutoScrollSession } from '../core/auto-scroll-session.mjs';

for (const [name, create] of [['manual', createScrollSession], ['auto', createAutoScrollSession]]) for (const [width, height] of [[1920, 960], [3840, 2160]]) {
  test(`${name} ${width}x${height}: wide reference retains multiple rows of bottom context without changing source`, () => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      data[p] = y % 256; data[p + 1] = Math.floor(y / 256); data[p + 2] = x % 256; data[p + 3] = 255;
    }
    const session = create({ width, height, data }, { maxBytes: width * height * 4 * 4 });
    const sourceRows = Math.ceil(width / 3), top = height - sourceRows;
    const rgba = y => [y % 256, Math.floor(y / 256), 0, 255];
    const reference = session.stats().reference;
    assert.equal(reference.width, 960); assert.equal(reference.height, 320);
    assert.equal(reference.data.length, 960 * 320 * 4);
    assert.deepEqual(Array.from(reference.data.subarray(0, 4)), rgba(top), 'context starts at the expected full-width bottom region');
    assert.deepEqual(Array.from(reference.data.subarray(160 * 960 * 4, 160 * 960 * 4 + 4)), rgba(top + sourceRows / 2));
    reference.data.fill(0);
    assert.deepEqual(Array.from(session.stats().reference.data.subarray(0, 4)), rgba(top));
    assert.deepEqual(Array.from(data.subarray(0, 4)), [0, 0, 0, 255]);
    session.clear();
  });
}
