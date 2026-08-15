const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const backendDirectory = path.resolve(__dirname, '..');
const validProductionEnvironment = {
  ...process.env,
  NODE_ENV: 'production',
  GEMINI_API_KEY: 'provider-test-key',
  GATEWAY_API_KEY: '',
  ALLOW_LEGACY_GATEWAY_KEY: 'false',
  AUTH_JWKS_URI: 'https://identity.alpha.test/.well-known/jwks.json',
  AUTH_ISSUER: 'https://identity.alpha.test/',
  AUTH_AUDIENCE: 'alpha-api',
  AUTH_REQUIRED_SCOPES: 'alpha.api',
  ALLOWED_ORIGINS: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
  TRAFFIC_REDIS_URL: 'rediss://redis.alpha.test:6380',
  TRAFFIC_KEY_SECRET: 'production-traffic-hmac-test-secret',
  RATE_LIMIT_WINDOW_MS: '60000'
};

function loadConfig(environment) {
  return spawnSync(process.execPath, ['-e', "require('./dist/config.js')"], {
    cwd: backendDirectory,
    env: environment,
    encoding: 'utf8'
  });
}

test('valid production authentication and distributed traffic configuration loads', () => {
  const result = loadConfig(validProductionEnvironment);
  assert.equal(result.status, 0, result.stderr);
});

test('production requires a bounded traffic-identifier HMAC secret', () => {
  const missingSecret = { ...validProductionEnvironment };
  delete missingSecret.TRAFFIC_KEY_SECRET;
  const missing = loadConfig(missingSecret);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /TRAFFIC_KEY_SECRET/);

  const short = loadConfig({ ...validProductionEnvironment, TRAFFIC_KEY_SECRET: 'too-short' });
  assert.notEqual(short.status, 0);
  assert.match(short.stderr, /between 32 and 1024/);
});

test('production requires an explicit API authorization scope', () => {
  const missingScope = { ...validProductionEnvironment };
  delete missingScope.AUTH_REQUIRED_SCOPES;
  const result = loadConfig(missingScope);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AUTH_REQUIRED_SCOPES/);

  const duplicateScope = loadConfig({
    ...validProductionEnvironment,
    AUTH_REQUIRED_SCOPES: 'alpha.api,alpha.api'
  });
  assert.notEqual(duplicateScope.status, 0);
  assert.match(duplicateScope.stderr, /unique, bounded/);
});

test('production rejects development gateway authentication', () => {
  const result = loadConfig({
    ...validProductionEnvironment,
    GATEWAY_API_KEY: 'shared-browser-secret',
    ALLOW_LEGACY_GATEWAY_KEY: 'true'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /development-only/);
  assert.doesNotMatch(result.stderr, /shared-browser-secret/);
});

test('production rejects insecure JWKS URLs and universal trusted proxies', () => {
  const insecureJwks = loadConfig({
    ...validProductionEnvironment,
    AUTH_JWKS_URI: 'http://identity.alpha.test/jwks.json'
  });
  assert.notEqual(insecureJwks.status, 0);
  assert.match(insecureJwks.stderr, /HTTPS/);

  const universalProxy = loadConfig({ ...validProductionEnvironment, TRUST_PROXY: 'true' });
  assert.notEqual(universalProxy.status, 0);
  assert.match(universalProxy.stderr, /explicit proxy/);

  for (const trustProxy of ['0.0.0.0/0', '::/0', 'loopback', 'proxy.alpha.test', '10.0.0.1/99']) {
    const result = loadConfig({ ...validProductionEnvironment, TRUST_PROXY: trustProxy });
    assert.notEqual(result.status, 0, trustProxy);
    assert.match(result.stderr, /TRUST_PROXY/, trustProxy);
  }

  const explicitProxy = loadConfig({
    ...validProductionEnvironment,
    TRUST_PROXY: '10.20.30.40,2001:db8::1,10.20.31.0/24'
  });
  assert.equal(explicitProxy.status, 0, explicitProxy.stderr);
});

test('production rejects similarity caching so changed prompts always reach the provider', () => {
  const result = loadConfig({
    ...validProductionEnvironment,
    ENABLE_SEMANTIC_CACHE: 'true',
    REDIS_URL: 'rediss://semantic-cache.alpha.test:6380'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /development-only/);
});

test('production freezes the disclosed rate-limit retention window at 60 seconds', () => {
  for (const window of ['1000', '59999', '60001', '86400000']) {
    const result = loadConfig({
      ...validProductionEnvironment,
      RATE_LIMIT_WINDOW_MS: window
    });
    assert.notEqual(result.status, 0, window);
    assert.match(result.stderr, /exactly 60000/, window);
  }
});

test('gateway output limit cannot exceed the extension response contract', () => {
  const enhanced = loadConfig({
    ...validProductionEnvironment,
    MAX_ENHANCED_OUTPUT_CHARACTERS: '30001'
  });
  assert.notEqual(enhanced.status, 0);
  assert.match(enhanced.stderr, /MAX_ENHANCED_OUTPUT_CHARACTERS/);
});
