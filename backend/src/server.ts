import Fastify from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { createAuthenticator, JwksTokenVerifier } from './auth.js';
import type { Authenticator } from './auth.js';
import {
  checkSemanticCache,
  closeSemanticCache,
  isSemanticCacheReady,
  saveToSemanticCache
} from './cache.js';
import { config } from './config.js';
import { ApiError, ProviderError } from './errors.js';
import { isGeminiReady, optimizePrompt } from './gemini.js';
import { registerApiRoutes } from './routes.js';
import type { RouteDependencies } from './routes.js';
import { createTrafficPolicyStore } from './traffic-policy.js';
import type { TrafficLimitDecision, TrafficPolicyStore } from './traffic-policy.js';

interface ServerDependencies extends Partial<RouteDependencies> {
  authenticator?: Authenticator;
  trafficPolicy?: TrafficPolicyStore;
  semanticCacheReady?: () => Promise<boolean>;
  closeSemanticCache?: () => Promise<void>;
  providerReady?: () => Promise<boolean>;
}

function defaultAuthenticator(): Authenticator {
  const verifier =
    config.authJwksUri && config.authIssuer && config.authAudience
      ? new JwksTokenVerifier({
          jwksUri: config.authJwksUri,
          issuer: config.authIssuer,
          audience: config.authAudience,
          requiredScopes: config.authRequiredScopes,
          algorithms: config.authAlgorithms,
          clockToleranceSeconds: config.authClockToleranceSeconds,
          maxTokenAgeSeconds: config.authMaxTokenAgeSeconds,
          cacheTtlMs: config.authJwksCacheTtlMs,
          timeoutMs: config.authJwksTimeoutMs
        })
      : undefined;
  return createAuthenticator({
    verifier,
    legacyDevelopmentKey: config.allowLegacyGatewayKey ? config.gatewayApiKey : undefined
  });
}

function endpointKey(method: string, url: string): string {
  return `${method}:${url.split('?')[0]}`;
}

function applyRateHeaders(
  reply: { header(name: string, value: string | number): unknown },
  decision: TrafficLimitDecision
): void {
  reply.header('RateLimit-Limit', decision.limit);
  reply.header('RateLimit-Remaining', decision.remaining);
  reply.header('RateLimit-Reset', Math.ceil(decision.resetAt / 1000));
}

function retryAfterSeconds(decision: TrafficLimitDecision): number {
  return Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000));
}

export function buildServer(overrides: ServerDependencies = {}) {
  const authenticator = overrides.authenticator || defaultAuthenticator();
  const trafficPolicy =
    overrides.trafficPolicy ||
    createTrafficPolicyStore({
      redisUrl: config.trafficRedisUrl,
      maxEntries: config.trafficMaxEntries,
      keySecret: config.trafficKeySecret
    });
  const cacheReady = overrides.semanticCacheReady || isSemanticCacheReady;
  const closeCache = overrides.closeSemanticCache || closeSemanticCache;
  const providerReady = overrides.providerReady || isGeminiReady;
  const routeDependencies: RouteDependencies = {
    optimizePrompt: overrides.optimizePrompt || optimizePrompt,
    checkSemanticCache: overrides.checkSemanticCache || checkSemanticCache,
    saveToSemanticCache: overrides.saveToSemanticCache || saveToSemanticCache
  };

  const server = Fastify({
    logger:
      config.nodeEnv === 'test'
        ? false
        : {
            level: process.env.LOG_LEVEL || 'info',
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.x-alpha-key',
                'req.headers.cookie',
                'request.headers.authorization',
                'request.headers.x-alpha-key'
              ],
              censor: '[REDACTED]'
            }
          },
    genReqId: () => randomUUID(),
    bodyLimit: config.maxRequestBodyBytes,
    disableRequestLogging: true,
    requestTimeout: 30000,
    connectionTimeout: 10000,
    keepAliveTimeout: 5000,
    trustProxy: config.trustProxy,
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
        allErrors: false
      }
    }
  });

  const allowedOrigins = new Set(config.allowedOrigins);
  server.register(cors, {
    origin(origin, callback) {
      if (!origin || (!config.isProduction && allowedOrigins.size === 0)) {
        callback(null, true);
        return;
      }
      callback(null, allowedOrigins.has(origin));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Accept',
      'Authorization',
      ...(config.allowLegacyGatewayKey ? ['X-Alpha-Key'] : [])
    ],
    maxAge: 86400
  });

  server.addHook('onSend', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.isProduction) {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  });

  server.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS' || request.url.split('?')[0] === '/api/health') return;
    const endpoint = endpointKey(request.method, request.url);

    let ipDecision: TrafficLimitDecision;
    let ipEndpointDecision: TrafficLimitDecision;
    try {
      ipDecision = await trafficPolicy.consume(
        `ip:${request.ip}:global`,
        config.rateLimitMax,
        config.rateLimitWindowMs
      );
      ipEndpointDecision = await trafficPolicy.consume(
        `ip:${request.ip}:${endpoint}`,
        config.rateLimitMax,
        config.rateLimitWindowMs
      );
    } catch {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Service temporarily unavailable.');
    }
    applyRateHeaders(reply, ipDecision);
    const blockedIpDecision = !ipDecision.allowed
      ? ipDecision
      : !ipEndpointDecision.allowed
        ? ipEndpointDecision
        : null;
    if (blockedIpDecision) {
      throw new ApiError(
        429,
        'RATE_LIMITED',
        'Too many requests. Try again later.',
        retryAfterSeconds(blockedIpDecision)
      );
    }

    request.authPrincipal = await authenticator.authenticate({
      authorization: request.headers.authorization,
      'x-alpha-key': request.headers['x-alpha-key']
    });

    if (
      request.method === 'POST' &&
      request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json'
    ) {
      throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
    }

    let userDecision: TrafficLimitDecision;
    let userEndpointDecision: TrafficLimitDecision;
    try {
      userDecision = await trafficPolicy.consume(
        `user:${request.authPrincipal.subject}:global`,
        config.userRateLimitMax,
        config.rateLimitWindowMs
      );
      userEndpointDecision = await trafficPolicy.consume(
        `user:${request.authPrincipal.subject}:${endpoint}`,
        config.userRateLimitMax,
        config.rateLimitWindowMs
      );
    } catch {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Service temporarily unavailable.');
    }
    const blockedUserDecision = !userDecision.allowed
      ? userDecision
      : !userEndpointDecision.allowed
        ? userEndpointDecision
        : null;
    if (blockedUserDecision) {
      throw new ApiError(
        429,
        'RATE_LIMITED',
        'Too many requests. Try again later.',
        retryAfterSeconds(blockedUserDecision)
      );
    }

    if (request.method === 'POST' && request.url.startsWith('/api/')) {
      let quotaDecision: TrafficLimitDecision;
      try {
        quotaDecision = await trafficPolicy.consume(
          `quota:${request.authPrincipal.subject}:${endpoint}`,
          config.dailyRequestQuota,
          24 * 60 * 60 * 1000
        );
      } catch {
        throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Service temporarily unavailable.');
      }
      if (!quotaDecision.allowed) {
        throw new ApiError(
          429,
          'QUOTA_EXCEEDED',
          'Daily request quota exceeded.',
          retryAfterSeconds(quotaDecision)
        );
      }
    }
  });

  server.get('/api/health', async () => ({ status: 'ok', timestamp: Date.now() }));

  server.get('/api/ready', async (_request, reply) => {
    const [authReady, limiterReady, semanticCacheReady, modelReady] = await Promise.all([
      authenticator.ready(),
      trafficPolicy.ready(),
      cacheReady(),
      providerReady()
    ]);
    const ready = Boolean(authReady && limiterReady && semanticCacheReady && modelReady);
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready' });
  });

  registerApiRoutes(server, routeDependencies);

  server.setNotFoundHandler(() => {
    throw new ApiError(404, 'NOT_FOUND', 'Not found.');
  });

  server.setErrorHandler((error, request, reply) => {
    const unknownError = error as {
      validation?: unknown;
      code?: string;
      name?: string;
      statusCode?: number;
    };
    let statusCode = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred.';
    let retryAfter: number | undefined;

    if (error instanceof ApiError) {
      statusCode = error.statusCode;
      code = error.code;
      message = error.message;
      retryAfter = error.retryAfterSeconds;
    } else if (error instanceof ProviderError) {
      statusCode = error.kind === 'timeout' ? 504 : 503;
      code = error.kind === 'timeout' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE';
      message =
        error.kind === 'timeout'
          ? 'Prompt processing timed out. Please try again.'
          : 'Prompt processing is temporarily unavailable. Please try again.';
    } else if (unknownError.validation) {
      statusCode = 400;
      code = 'INVALID_REQUEST';
      message = 'Request body does not match the API contract.';
    } else if (unknownError.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      statusCode = 413;
      code = 'PAYLOAD_TOO_LARGE';
      message = 'Request body is too large.';
    } else if (unknownError.statusCode === 400) {
      statusCode = 400;
      code = 'INVALID_REQUEST';
      message = 'Request body does not match the API contract.';
    }

    if (retryAfter !== undefined) reply.header('Retry-After', retryAfter);
    if (statusCode >= 500) {
      request.log.error(
        {
          requestId: request.id,
          errorType: unknownError.name || 'Error',
          errorCode: code,
          statusCode
        },
        'API request failed.'
      );
    }
    return reply.status(statusCode).send({ error: message, code, requestId: request.id });
  });

  server.addHook('onClose', async () => {
    await Promise.allSettled([trafficPolicy.close(), authenticator.close(), closeCache()]);
  });

  return server;
}

export async function startServer(): Promise<void> {
  const server = buildServer();
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.log.info({ signal }, 'Shutdown requested.');
    try {
      await server.close();
    } catch {
      process.exitCode = 1;
    }
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  try {
    await server.listen({ port: config.port, host: config.host });
  } catch (error) {
    server.log.error({ errorType: (error as Error)?.name || 'Error' }, 'Server failed to start.');
    await server.close().catch(() => undefined);
    throw error;
  }
}

if (require.main === module) {
  void startServer().catch(() => {
    process.exitCode = 1;
  });
}
