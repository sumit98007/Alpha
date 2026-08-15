const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const backendDirectory = path.resolve(__dirname, '..');

test('production request and error logs omit IP, content, identity, and credentials', () => {
  const result = spawnSync(process.execPath, ['test/fixtures/production-log-fixture.js'], {
    cwd: backendDirectory,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      GEMINI_API_KEY: 'provider-test-key',
      GATEWAY_API_KEY: '',
      ALLOW_LEGACY_GATEWAY_KEY: 'false',
      AUTH_JWKS_URI: 'https://identity.alpha.test/.well-known/jwks.json',
      AUTH_ISSUER: 'https://identity.alpha.test/',
      AUTH_AUDIENCE: 'alpha-api',
      AUTH_REQUIRED_SCOPES: 'alpha.api',
      ALLOWED_ORIGINS: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
      TRAFFIC_REDIS_URL: 'rediss://redis.alpha.test:6380',
      TRAFFIC_KEY_SECRET: 'production-traffic-hmac-test-secret'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /FIXTURE_STATUS=500/);
  const logs = `${result.stdout}\n${result.stderr}`;
  for (const forbidden of [
    '203.0.113.42',
    '127.0.0.1',
    'prompt-content-sentinel',
    'account-subject-sentinel',
    'authorization-sentinel',
    'provider-cause-sentinel'
  ]) {
    assert.equal(logs.includes(forbidden), false, forbidden);
  }
  assert.match(logs, /API request failed/);
});
