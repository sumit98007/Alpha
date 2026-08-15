const { buildServer } = require('../../dist/server.js');

const safePrincipal = {
  subject: 'account-subject-sentinel',
  issuer: 'https://identity.alpha.test/',
  audience: ['alpha-api'],
  scopes: ['alpha.api'],
  authMethod: 'bearer'
};

const authenticator = {
  authenticate: async () => safePrincipal,
  ready: async () => true,
  close: async () => {}
};

const trafficPolicy = {
  consume: async (_key, limit) => ({
    allowed: true,
    limit,
    remaining: Math.max(0, limit - 1),
    resetAt: Date.now() + 60_000
  }),
  ready: async () => true,
  close: async () => {}
};

async function main() {
  const server = buildServer({
    authenticator,
    trafficPolicy,
    semanticCacheReady: async () => true,
    closeSemanticCache: async () => {},
    providerReady: async () => true,
    optimizePrompt: async () => {
      throw new Error('provider-cause-sentinel');
    },
    checkSemanticCache: async () => null,
    saveToSemanticCache: async () => {}
  });
  try {
    const response = await server.inject({
      method: 'POST',
      url: '/api/enhance',
      remoteAddress: '203.0.113.42',
      headers: {
        authorization: 'Bearer authorization-sentinel',
        'content-type': 'application/json'
      },
      payload: {
        sessionId: '123e4567-e89b-42d3-a456-426614174000',
        meta: { hostPlatform: 'chatgpt' },
        payload: { scrubbedText: 'prompt-content-sentinel', redactionLog: [] }
      }
    });
    console.log(`FIXTURE_STATUS=${response.statusCode}`);
  } finally {
    await server.close();
  }
}

void main().catch(() => {
  process.exitCode = 1;
});
