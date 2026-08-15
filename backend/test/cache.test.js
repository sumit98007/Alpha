const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const { classifyCacheEntries } = require('../dist/cache.js');

test('semantic cache classifies expired and malformed Redis fields for deletion', () => {
  const now = 100_000;
  const vector = Array(768).fill(0.1);
  const entries = {
    fresh: JSON.stringify({ embedding: vector, optimizedText: 'fresh', createdAt: 99_500 }),
    expired: JSON.stringify({ embedding: vector, optimizedText: 'old', createdAt: 98_000 }),
    future: JSON.stringify({ embedding: vector, optimizedText: 'future', createdAt: 100_001 }),
    malformed: '{not-json',
    invalidVector: JSON.stringify({
      embedding: [Number.NaN],
      optimizedText: 'bad',
      createdAt: 99_500
    })
  };

  const result = classifyCacheEntries(entries, now, 1000);
  assert.deepEqual(
    result.freshEntries.map(([field]) => field),
    ['fresh']
  );
  assert.deepEqual(result.staleFields.sort(), ['expired', 'future', 'invalidVector', 'malformed']);
});
