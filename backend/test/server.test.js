const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.GATEWAY_API_KEY = 'test-gateway-key';
process.env.RATE_LIMIT_MAX = '20';

const { buildServer } = require('../dist/server.js');

test('health endpoint is available and sends security headers', async (t) => {
  const app = buildServer();
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'ok');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('protected routes reject missing credentials', async (t) => {
  const app = buildServer();
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/api/ready' });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { error: 'Unauthorized.' });
});

test('authenticated malformed enhancement requests are rejected', async (t) => {
  const app = buildServer();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/enhance',
    headers: { 'x-alpha-key': 'test-gateway-key' },
    payload: { payload: { scrubbedText: '   ' } },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /scrubbedText/);
});

test('unknown routes do not leak implementation details', async (t) => {
  const app = buildServer();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/does-not-exist',
    headers: { 'x-alpha-key': 'test-gateway-key' },
  });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: 'Not found.' });
});

test('invalid authentication attempts consume the rate limit', async (t) => {
  const app = buildServer();
  t.after(() => app.close());

  let response;
  for (let attempt = 0; attempt <= 20; attempt += 1) {
    response = await app.inject({ method: 'GET', url: '/api/ready' });
  }
  assert.equal(response.statusCode, 429);
  assert.match(response.headers['retry-after'], /^\d+$/);
});

test('protected POST routes accept JSON only', async (t) => {
  const app = buildServer();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/enhance',
    headers: {
      'x-alpha-key': 'test-gateway-key',
      'content-type': 'text/plain',
    },
    payload: 'not json',
  });
  assert.equal(response.statusCode, 415);
});
