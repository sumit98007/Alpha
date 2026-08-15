const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.GATEWAY_API_KEY = 'test-gateway-key';
process.env.RATE_LIMIT_MAX = '20';
process.env.USER_RATE_LIMIT_MAX = '50';

const { ProviderError } = require('../dist/errors.js');
const { abortWhenRequestDisconnects } = require('../dist/routes.js');
const { buildServer } = require('../dist/server.js');
const { EventEmitter } = require('node:events');

const authHeaders = { 'x-alpha-key': 'test-gateway-key' };
const sessionId = '123e4567-e89b-42d3-a456-426614174000';
const requestToken = sessionId.replaceAll('-', '').toUpperCase();

function placeholder(source, index) {
  return `{{ALPHA_SECRET_${requestToken}_${source}_${index}}}`;
}

function logEntry(source, index, occurrences = 1) {
  return {
    placeholder: placeholder(source, index),
    source,
    requestId: sessionId,
    occurrences
  };
}

function enhancePayload(overrides = {}) {
  return {
    sessionId,
    meta: { hostPlatform: 'chatgpt' },
    payload: { scrubbedText: 'Improve this request.', redactionLog: [] },
    ...overrides
  };
}

function testDependencies(overrides = {}) {
  return {
    optimizePrompt: async (prompt) => `Refined: ${prompt}`,
    checkSemanticCache: async () => null,
    saveToSemanticCache: async () => {},
    ...overrides
  };
}

test('provider cancellation observes aborted requests and incomplete response disconnects', () => {
  function harness() {
    const incoming = new EventEmitter();
    const socket = new EventEmitter();
    socket.destroyed = false;
    incoming.socket = socket;
    incoming.aborted = false;
    const outgoing = new EventEmitter();
    outgoing.writableEnded = false;
    const cancellation = abortWhenRequestDisconnects({ raw: incoming }, { raw: outgoing });
    return { cancellation, incoming, outgoing, socket };
  }

  const abortedRequest = harness();
  abortedRequest.incoming.emit('aborted');
  assert.equal(abortedRequest.cancellation.signal.aborted, true);
  abortedRequest.cancellation.dispose();

  const closedResponse = harness();
  closedResponse.outgoing.emit('close');
  assert.equal(closedResponse.cancellation.signal.aborted, true);
  closedResponse.cancellation.dispose();

  const completedResponse = harness();
  completedResponse.outgoing.writableEnded = true;
  completedResponse.socket.emit('close');
  assert.equal(completedResponse.cancellation.signal.aborted, false);
  completedResponse.cancellation.dispose();
});

test('health endpoint is available and sends security and correlation headers', async (t) => {
  const app = buildServer();
  t.after(() => app.close());
  assert.equal(app.initialConfig.disableRequestLogging, true);

  const response = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'ok');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.headers['x-request-id'], /^[0-9a-f-]{36}$/);
});

test('protected routes reject missing credentials without verification details', async (t) => {
  const app = buildServer();
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/api/ready' });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error, 'Authentication required.');
  assert.equal(response.json().code, 'AUTHENTICATION_REQUIRED');
  assert.equal(response.json().requestId, response.headers['x-request-id']);
});

test('readiness includes provider and resource health', async (t) => {
  const readyApp = buildServer(testDependencies({ providerReady: async () => true }));
  const unavailableApp = buildServer(testDependencies({ providerReady: async () => false }));
  t.after(() => Promise.all([readyApp.close(), unavailableApp.close()]));

  const ready = await readyApp.inject({ method: 'GET', url: '/api/ready', headers: authHeaders });
  const unavailable = await unavailableApp.inject({
    method: 'GET',
    url: '/api/ready',
    headers: authHeaders
  });
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.json().status, 'ready');
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().status, 'not_ready');
});

test('authenticated malformed enhancement requests are rejected by runtime schema', async (t) => {
  const app = buildServer();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/enhance',
    headers: authHeaders,
    payload: { payload: { scrubbedText: '   ' } }
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 'INVALID_REQUEST');
  assert.equal(response.json().error, 'Request body does not match the API contract.');
});

test('runtime schema rejects unknown properties and unsupported platforms', async (t) => {
  const app = buildServer(testDependencies());
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/enhance',
    headers: authHeaders,
    payload: enhancePayload({
      meta: { hostPlatform: 'untrusted-platform' },
      unexpected: true
    })
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 'INVALID_REQUEST');
});

test('runtime schema rejects unsupported prompt task types', async (t) => {
  const app = buildServer(testDependencies());
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/enhance',
    headers: authHeaders,
    payload: enhancePayload({ preferences: { taskType: 'unversioned-taxonomy' } })
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 'INVALID_REQUEST');
});

test('configured body limit accepts a maximum-size schema-valid request shape', async (t) => {
  const redactionLog = Array.from({ length: 100 }, (_, index) => logEntry('PROMPT', index));
  const tokens = redactionLog.map((entry) => entry.placeholder).join(' ');
  const scrubbedText = `${tokens}${'p'.repeat(30000 - tokens.length)}`;
  const payload = enhancePayload({
    payload: { scrubbedText, redactionLog },
    preferences: {
      conversationContext: 'c'.repeat(12000),
      customGuidance: 'g'.repeat(2000)
    }
  });
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 50000);

  const app = buildServer(testDependencies({ optimizePrompt: async (prompt) => prompt }));
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/api/enhance',
    headers: authHeaders,
    payload
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().optimizedText.length, 30000);
});

test('normal enhancement requests may return a valid per-user cached result', async (t) => {
  let cacheChecks = 0;
  let providerCalls = 0;
  const app = buildServer(
    testDependencies({
      checkSemanticCache: async () => {
        cacheChecks += 1;
        return {
          optimizedText: 'Cached refinement.',
          cached: true,
          embedding: Array(768).fill(0.1)
        };
      },
      optimizePrompt: async () => {
        providerCalls += 1;
        return 'Provider refinement.';
      }
    })
  );
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/enhance',
    headers: authHeaders,
    payload: enhancePayload()
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().optimizedText, 'Cached refinement.');
  assert.equal(response.json().cached, true);
  assert.equal(cacheChecks, 1);
  assert.equal(providerCalls, 0);
});

test('cache-bypass enhancement invokes provider and saves the replacement result', async (t) => {
  let cacheChecks = 0;
  let providerCalls = 0;
  let cacheSaves = 0;
  const app = buildServer(
    testDependencies({
      checkSemanticCache: async () => {
        cacheChecks += 1;
        return {
          optimizedText: 'Stale cached refinement.',
          cached: true,
          embedding: Array(768).fill(0.1)
        };
      },
      optimizePrompt: async () => {
        providerCalls += 1;
        return 'Fresh provider refinement.';
      },
      saveToSemanticCache: async () => {
        cacheSaves += 1;
      }
    })
  );
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/enhance',
    headers: authHeaders,
    payload: enhancePayload({ preferences: { bypassCache: true } })
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().optimizedText, 'Fresh provider refinement.');
  assert.equal(response.json().cached, false);
  assert.equal(cacheChecks, 0);
  assert.equal(providerCalls, 1);
  assert.equal(cacheSaves, 1);
});

test('unknown routes do not leak implementation details', async (t) => {
  const app = buildServer();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/does-not-exist',
    headers: authHeaders
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error, 'Not found.');
  assert.equal(response.json().code, 'NOT_FOUND');
});

test('invalid authentication attempts consume the IP and endpoint rate limit', async (t) => {
  const app = buildServer();
  t.after(() => app.close());

  let response;
  for (let attempt = 0; attempt <= 20; attempt += 1) {
    response = await app.inject({ method: 'GET', url: '/api/ready' });
  }
  assert.equal(response.statusCode, 429);
  assert.equal(response.json().code, 'RATE_LIMITED');
  assert.match(response.headers['retry-after'], /^\d+$/);
});

test('global IP limit cannot be bypassed with changing endpoint paths', async (t) => {
  const app = buildServer();
  t.after(() => app.close());

  let response;
  for (let attempt = 0; attempt <= 20; attempt += 1) {
    response = await app.inject({ method: 'GET', url: `/unknown-${attempt}` });
  }
  assert.equal(response.statusCode, 429);
  assert.equal(response.json().code, 'RATE_LIMITED');
});

test('protected POST routes accept JSON only', async (t) => {
  const app = buildServer();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/enhance',
    headers: { ...authHeaders, 'content-type': 'text/plain' },
    payload: 'not json'
  });
  assert.equal(response.statusCode, 415);
  assert.equal(response.json().code, 'UNSUPPORTED_MEDIA_TYPE');
});

test('malformed JSON returns a safe validation error', async (t) => {
  const app = buildServer();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/enhance',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    payload: '{"sessionId":'
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 'INVALID_REQUEST');
  assert.doesNotMatch(response.body, /Unexpected end|JSON/);
});

test('valid request-scoped prompt placeholders are preserved', async (t) => {
  const token = placeholder('PROMPT', 0);
  const app = buildServer(
    testDependencies({
      optimizePrompt: async (prompt) => `Refined safely: ${prompt}`
    })
  );
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/enhance',
    headers: authHeaders,
    payload: enhancePayload({
      payload: {
        scrubbedText: `Use ${token} securely.`,
        redactionLog: [logEntry('PROMPT', 0)]
      }
    })
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.json().optimizedText, new RegExp(token.replace(/[{}]/g, '\\$&')));
  assert.equal(response.json().degraded, false);
});

test('placeholder ownership and occurrence mismatches are rejected before provider use', async (t) => {
  let providerCalls = 0;
  const token = placeholder('PROMPT', 0);
  const app = buildServer(
    testDependencies({
      optimizePrompt: async () => {
        providerCalls += 1;
        return 'should not run';
      }
    })
  );
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/enhance',
    headers: authHeaders,
    payload: enhancePayload({
      payload: {
        scrubbedText: `Use ${token} securely.`,
        redactionLog: [{ ...logEntry('PROMPT', 0), occurrences: 2 }]
      }
    })
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 'INVALID_REQUEST');
  assert.equal(providerCalls, 0);
});

test('gateway rejects unnecessary local detection-category metadata', async (t) => {
  const token = placeholder('PROMPT', 0);
  const app = buildServer(testDependencies());
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/enhance',
    headers: authHeaders,
    payload: enhancePayload({
      payload: {
        scrubbedText: `Use ${token} securely.`,
        redactionLog: [{ ...logEntry('PROMPT', 0), type: 'OPENAI_API_KEY' }]
      }
    })
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 'INVALID_REQUEST');
});

test('a placeholder cannot be reused across request source fields', async (t) => {
  const token = placeholder('PROMPT', 0);
  const app = buildServer(testDependencies());
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/enhance',
    headers: authHeaders,
    payload: enhancePayload({
      payload: {
        scrubbedText: `Use ${token}.`,
        redactionLog: [logEntry('PROMPT', 0)]
      },
      preferences: { conversationContext: `Duplicated ${token}` }
    })
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 'INVALID_REQUEST');
});

test('relocated prompt placeholders trigger retry then safe source fallback', async (t) => {
  const first = placeholder('PROMPT', 0);
  const second = placeholder('PROMPT', 1);
  let calls = 0;
  const app = buildServer(
    testDependencies({
      optimizePrompt: async () => {
        calls += 1;
        return `${second} moved before ${first}`;
      }
    })
  );
  t.after(() => app.close());
  const source = `First ${first}; then ${second}.`;

  const response = await app.inject({
    method: 'POST',
    url: '/api/enhance',
    headers: authHeaders,
    payload: enhancePayload({
      payload: {
        scrubbedText: source,
        redactionLog: [logEntry('PROMPT', 0), logEntry('PROMPT', 1)]
      }
    })
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().optimizedText, source);
  assert.equal(response.json().degraded, true);
  assert.equal(calls, 2);
});

test('context or guidance placeholders can never enter enhancement output', async (t) => {
  const contextToken = placeholder('CONTEXT', 0);
  const source = 'Summarise the decision.';
  const app = buildServer(
    testDependencies({
      optimizePrompt: async () => `Refined ${source} ${contextToken}`
    })
  );
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/enhance',
    headers: authHeaders,
    payload: enhancePayload({
      payload: { scrubbedText: source, redactionLog: [logEntry('CONTEXT', 0)] },
      preferences: { conversationContext: `Earlier: ${contextToken}` }
    })
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().optimizedText, source);
  assert.equal(response.json().degraded, true);
});

test('provider timeouts are safely mapped without exposing causes', async (t) => {
  const app = buildServer(
    testDependencies({
      optimizePrompt: async () => {
        throw new ProviderError('timeout', 'SecretProviderTimeoutDetails');
      }
    })
  );
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/enhance',
    headers: authHeaders,
    payload: enhancePayload()
  });
  assert.equal(response.statusCode, 504);
  assert.equal(response.json().code, 'PROVIDER_TIMEOUT');
  assert.doesNotMatch(response.body, /SecretProviderTimeoutDetails/);
});

test('unexpected provider failures never expose error messages or secrets', async (t) => {
  const app = buildServer(
    testDependencies({
      optimizePrompt: async () => {
        throw new Error('upstream rejected key super-secret-provider-key');
      }
    })
  );
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/enhance',
    headers: authHeaders,
    payload: enhancePayload()
  });
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().code, 'INTERNAL_ERROR');
  assert.doesNotMatch(response.body, /upstream|super-secret-provider-key/);
});

test('oversized provider output is retried and never returned to the client', async (t) => {
  let calls = 0;
  const source = 'Keep this bounded.';
  const app = buildServer(
    testDependencies({
      optimizePrompt: async () => {
        calls += 1;
        return 'x'.repeat(30001);
      }
    })
  );
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/enhance',
    headers: authHeaders,
    payload: enhancePayload({ payload: { scrubbedText: source, redactionLog: [] } })
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().optimizedText, source);
  assert.equal(response.json().degraded, true);
  assert.equal(calls, 2);
  assert.ok(response.body.length < 1000);
});
