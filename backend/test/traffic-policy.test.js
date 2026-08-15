const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const { MemoryTrafficPolicyStore, trafficStorageKey } = require('../dist/traffic-policy.js');

test('traffic identifiers use a secret-keyed, non-reversible storage key', () => {
  const input = 'ip:203.0.113.42:global';
  const first = trafficStorageKey(input, 'a'.repeat(32));
  const second = trafficStorageKey(input, 'b'.repeat(32));
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
  assert.equal(first.includes('203.0.113.42'), false);
});

test('memory traffic policy isolates counters by user, IP, and endpoint', async () => {
  let now = 1000;
  const store = new MemoryTrafficPolicyStore(100, () => now);

  const first = await store.consume('user:a:POST:/api/enhance', 2, 1000);
  const second = await store.consume('user:a:POST:/api/enhance', 2, 1000);
  const blocked = await store.consume('user:a:POST:/api/enhance', 2, 1000);
  const otherEndpoint = await store.consume('user:a:GET:/api/ready', 2, 1000);
  const otherUser = await store.consume('user:b:POST:/api/enhance', 2, 1000);

  assert.equal(first.allowed, true);
  assert.equal(second.remaining, 0);
  assert.equal(blocked.allowed, false);
  assert.equal(otherEndpoint.allowed, true);
  assert.equal(otherUser.allowed, true);

  now = 2001;
  const reset = await store.consume('user:a:POST:/api/enhance', 2, 1000);
  assert.equal(reset.allowed, true);
  assert.equal(reset.remaining, 1);
});
