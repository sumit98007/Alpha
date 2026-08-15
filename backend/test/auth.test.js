const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');

process.env.NODE_ENV = 'test';

const { createAuthenticator, JwksTokenVerifier } = require('../dist/auth.js');

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
jwk.kid = 'alpha-test-key';
jwk.alg = 'RS256';
jwk.use = 'sig';
const ecPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ecJwk = ecPair.publicKey.export({ format: 'jwk' });
ecJwk.kid = 'alpha-ec-test-key';
ecJwk.use = 'sig';

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function tokenFor(claimOverrides = {}, headerOverrides = {}) {
  const now = 2_000_000_000;
  const header = { alg: 'RS256', kid: jwk.kid, typ: 'JWT', ...headerOverrides };
  const claims = {
    iss: 'https://identity.alpha.test/',
    sub: 'user-123',
    aud: 'alpha-api',
    iat: now - 60,
    exp: now + 300,
    scope: 'prompt:enhance profile',
    ...claimOverrides
  };
  const signingInput = `${encode(header)}.${encode(claims)}`;
  return `${signingInput}.${sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url')}`;
}

function verifier(fetchImplementation) {
  return new JwksTokenVerifier({
    jwksUri: 'https://identity.alpha.test/.well-known/jwks.json',
    issuer: 'https://identity.alpha.test/',
    audience: 'alpha-api',
    requiredScopes: ['prompt:enhance'],
    algorithms: ['RS256'],
    clockToleranceSeconds: 30,
    maxTokenAgeSeconds: 900,
    cacheTtlMs: 300_000,
    timeoutMs: 1000,
    now: () => 2_000_000_000_000,
    fetchImplementation
  });
}

function ecToken(algorithm) {
  const header = { alg: algorithm, kid: ecJwk.kid, typ: 'JWT' };
  const claims = {
    iss: 'https://identity.alpha.test/',
    sub: 'ec-user',
    aud: 'alpha-api',
    iat: 1_999_999_940,
    exp: 2_000_000_300
  };
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const digest = algorithm === 'ES384' ? 'SHA384' : 'SHA256';
  const signature = sign(digest, Buffer.from(signingInput), {
    key: ecPair.privateKey,
    dsaEncoding: 'ieee-p1363'
  });
  return `${signingInput}.${signature.toString('base64url')}`;
}

test('JWKS verifier accepts a valid short-lived token and caches signing keys', async () => {
  let fetches = 0;
  const tokenVerifier = verifier(async () => {
    fetches += 1;
    return new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  });

  const first = await tokenVerifier.verify(tokenFor());
  const second = await tokenVerifier.verify(tokenFor({ sub: 'user-456' }));
  assert.equal(first.subject, 'user-123');
  assert.equal(first.authMethod, 'bearer');
  assert.deepEqual(first.scopes, ['prompt:enhance', 'profile']);
  assert.equal(second.subject, 'user-456');
  assert.equal(fetches, 1);
});

test('JWKS verifier cancels a chunked response as soon as its byte limit is exceeded', async () => {
  const chunkBytes = 256 * 1024;
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls > 32) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
    },
    cancel() {
      cancelled = true;
    }
  });
  const tokenVerifier = verifier(
    async () =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
  );

  await assert.rejects(() => tokenVerifier.verify(tokenFor()), /JWKS response is too large/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
  assert(pulls <= 6, `expected an early stream cancellation, received ${pulls} chunks`);
});

test('JWKS verifier rejects wrong audience, excessive token age, and unsigned algorithms', async () => {
  const tokenVerifier = verifier(
    async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })
  );

  await assert.rejects(() => tokenVerifier.verify(tokenFor({ aud: 'another-api' })));
  await assert.rejects(() =>
    tokenVerifier.verify(tokenFor({ iat: 1_999_998_000, exp: 2_000_000_100 }))
  );
  await assert.rejects(() => tokenVerifier.verify(tokenFor({}, { alg: 'none' })));
  await assert.rejects(() => tokenVerifier.verify(tokenFor({ scope: 'profile' })));
  await assert.rejects(() =>
    tokenVerifier.verify(tokenFor({ iat: 2_000_000_100, exp: 2_000_000_050 }))
  );
});

test('JWKS verifier rejects weak or non-verification signing keys', async () => {
  const weakPair = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const weakJwk = weakPair.publicKey.export({ format: 'jwk' });
  weakJwk.kid = jwk.kid;
  weakJwk.alg = 'RS256';
  weakJwk.use = 'sig';
  await assert.rejects(() =>
    verifier(async () => new Response(JSON.stringify({ keys: [weakJwk] }))).verify(tokenFor())
  );

  const encryptionOnlyJwk = { ...jwk, key_ops: ['encrypt'] };
  await assert.rejects(() =>
    verifier(async () => new Response(JSON.stringify({ keys: [encryptionOnlyJwk] }))).verify(
      tokenFor()
    )
  );
});

test('JWKS verifier refreshes keys once when a key id rotates', async () => {
  let fetches = 0;
  const tokenVerifier = verifier(async () => {
    fetches += 1;
    return new Response(
      JSON.stringify({
        keys: fetches === 1 ? [{ ...jwk, kid: 'old-key' }] : [jwk]
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });

  const oldPrincipal = await tokenVerifier.verify(tokenFor({}, { kid: 'old-key' }));
  assert.equal(oldPrincipal.subject, 'user-123');
  const principal = await tokenVerifier.verify(tokenFor());
  assert.equal(principal.subject, 'user-123');
  assert.equal(fetches, 2);
});

test('authenticator never falls back to a development key when bearer auth is malformed', async () => {
  const authenticator = createAuthenticator({
    verifier: verifier(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })),
    legacyDevelopmentKey: 'development-only-key'
  });

  await assert.rejects(
    () =>
      authenticator.authenticate({
        authorization: 'Bearer malformed',
        'x-alpha-key': 'development-only-key'
      }),
    (error) => error.code === 'AUTHENTICATION_REQUIRED'
  );
  const principal = await authenticator.authenticate({ 'x-alpha-key': 'development-only-key' });
  assert.equal(principal.authMethod, 'legacy-development-key');
});

test('EC JWT algorithms require their exact standard curve', async () => {
  const fetchImplementation = async () =>
    new Response(JSON.stringify({ keys: [ecJwk] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  const baseOptions = {
    jwksUri: 'https://identity.alpha.test/.well-known/jwks.json',
    issuer: 'https://identity.alpha.test/',
    audience: 'alpha-api',
    requiredScopes: [],
    clockToleranceSeconds: 30,
    maxTokenAgeSeconds: 900,
    cacheTtlMs: 300_000,
    timeoutMs: 1000,
    now: () => 2_000_000_000_000,
    fetchImplementation
  };

  const validVerifier = new JwksTokenVerifier({ ...baseOptions, algorithms: ['ES256'] });
  const principal = await validVerifier.verify(ecToken('ES256'));
  assert.equal(principal.subject, 'ec-user');

  const wrongCurveVerifier = new JwksTokenVerifier({ ...baseOptions, algorithms: ['ES384'] });
  await assert.rejects(() => wrongCurveVerifier.verify(ecToken('ES384')));
});
