import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { ICON_PATHS } from '../scripts/extension-manifest-policy.mjs';
import { createDeterministicZip, readDeterministicZip } from '../scripts/lib/deterministic-zip.mjs';

test('deterministic ZIP output is stable regardless of input ordering', () => {
  const ascending = createDeterministicZip([
    { name: 'a.txt', data: Buffer.from('alpha') },
    { name: 'z.txt', data: Buffer.from('omega') }
  ]);
  const descending = createDeterministicZip([
    { name: 'z.txt', data: Buffer.from('omega') },
    { name: 'a.txt', data: Buffer.from('alpha') }
  ]);

  assert(ascending.equals(descending));
  assert.equal(readDeterministicZip(ascending).get('a.txt').toString('utf8'), 'alpha');
});

test('deterministic ZIP rejects traversal and duplicate entries', () => {
  assert.throws(
    () => createDeterministicZip([{ name: '../secret.txt', data: Buffer.alloc(0) }]),
    /Unsafe ZIP entry/
  );
  assert.throws(
    () =>
      createDeterministicZip([
        { name: 'same.txt', data: Buffer.from('one') },
        { name: 'same.txt', data: Buffer.from('two') }
      ]),
    /Duplicate ZIP entry/
  );
});

test('extension icon files are valid PNGs at every declared size', async () => {
  const signature = Buffer.from('89504e470d0a1a0a', 'hex');
  for (const [sizeText, relativePath] of Object.entries(ICON_PATHS)) {
    const expectedSize = Number(sizeText);
    const icon = await readFile(path.resolve('extension', relativePath));
    assert(icon.subarray(0, signature.length).equals(signature), relativePath);
    assert.equal(icon.readUInt32BE(16), expectedSize, relativePath);
    assert.equal(icon.readUInt32BE(20), expectedSize, relativePath);
  }
});
