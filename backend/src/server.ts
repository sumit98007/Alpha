import Fastify from 'fastify';
import cors from '@fastify/cors';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { createChatEnvironment, EnhancementMode, optimizePrompt } from './gemini.js';
import { checkSemanticCache, saveToSemanticCache } from './cache.js';

interface EnhanceRequest {
  sessionId: string;
  meta: {
    hostPlatform: string;
    timestamp: number;
  };
  payload: {
    scrubbedText: string;
    redactionLog: Array<{
      placeholder: string;
      type: string;
    }>;
  };
  preferences?: {
    mode?: EnhancementMode;
    taskType?: string;
    chatEnvironment?: string;
    conversationContext?: string;
    preserveVoice?: boolean;
    askClarifying?: boolean;
    qualityChecks?: boolean;
  };
}

interface EnvironmentRequest {
  sessionId: string;
  meta?: {
    hostPlatform?: string;
  };
  payload?: {
    scrubbedPurpose?: string;
  };
}

const ENHANCEMENT_MODES = new Set<EnhancementMode>(['quick', 'balanced', 'deep', 'agent']);
const PLACEHOLDER_PATTERN = /\{\{ALPHA_SECRET_\d+\}\}/g;

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function getPlaceholders(text: string): string[] {
  return text.match(PLACEHOLDER_PATTERN) || [];
}

function hasValidPlaceholderIntegrity(source: string, result: string): boolean {
  const sourcePlaceholders = getPlaceholders(source).sort();
  const resultPlaceholders = getPlaceholders(result).sort();
  return (
    sourcePlaceholders.length === resultPlaceholders.length &&
    sourcePlaceholders.every((placeholder, index) => placeholder === resultPlaceholders[index])
  );
}

function hasValidApiKey(value: string | undefined): boolean {
  if (!config.gatewayApiKey) return !config.isProduction;
  if (!value || value.length > 256) return false;
  const expected = Buffer.from(config.gatewayApiKey);
  const received = Buffer.from(value);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

async function optimizeWithPlaceholderSafety(
  source: string,
  options: Parameters<typeof optimizePrompt>[1]
): Promise<{ text: string; degraded: boolean }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await optimizePrompt(source, options);
    if (
      hasValidPlaceholderIntegrity(source, result) &&
      !/\{\{ALPHA_CONTEXT_SECRET_\d+\}\}/.test(result)
    ) {
      return { text: result, degraded: false };
    }
  }

  // Returning the scrubbed source is safer than losing or misplacing a secret.
  return { text: source, degraded: true };
}

export function buildServer() {
  const server = Fastify({
    logger: config.nodeEnv !== 'test',
    bodyLimit: Math.max(config.maxPromptCharacters * 2, 65536),
    requestTimeout: 30000,
    connectionTimeout: 10000,
    trustProxy: config.isProduction,
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
    allowedHeaders: ['Content-Type', 'Accept', 'X-Alpha-Key'],
    maxAge: 86400,
  });

  server.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (config.isProduction) {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  });

  const rateLimits = new Map<string, { count: number; resetAt: number }>();
  server.addHook('onRequest', async (request, reply) => {
    if (request.url === '/api/health') return;

    const now = Date.now();
    if (rateLimits.size >= 10000 && !rateLimits.has(request.ip)) {
      for (const [ip, limit] of rateLimits) {
        if (limit.resetAt <= now) rateLimits.delete(ip);
      }
      if (rateLimits.size >= 10000) {
        const oldestIp = rateLimits.keys().next().value as string | undefined;
        if (oldestIp) rateLimits.delete(oldestIp);
      }
    }
    const current = rateLimits.get(request.ip);
    const entry = !current || current.resetAt <= now
      ? { count: 1, resetAt: now + config.rateLimitWindowMs }
      : { ...current, count: current.count + 1 };
    rateLimits.set(request.ip, entry);
    reply.header('RateLimit-Limit', config.rateLimitMax);
    reply.header('RateLimit-Remaining', Math.max(0, config.rateLimitMax - entry.count));
    reply.header('RateLimit-Reset', Math.ceil(entry.resetAt / 1000));
    if (entry.count > config.rateLimitMax) {
      reply.header('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return reply.status(429).send({ error: 'Too many requests. Try again later.' });
    }

    if (!hasValidApiKey(request.headers['x-alpha-key'] as string | undefined)) {
      return reply.status(401).send({ error: 'Unauthorized.' });
    }

    if (request.method === 'POST' && request.headers['content-type']?.split(';')[0] !== 'application/json') {
      return reply.status(415).send({ error: 'Content-Type must be application/json.' });
    }
  });

  server.get('/api/health', async () => ({
    status: 'ok',
    timestamp: Date.now(),
  }));

  server.get('/api/ready', async (_request, reply) => {
    const ready = Boolean(config.geminiApiKey && (!config.isProduction || config.gatewayApiKey));
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready' });
  });

  server.post('/api/enhance', async (request, reply) => {
  const body = request.body as EnhanceRequest;

  if (!body || !body.payload || typeof body.payload.scrubbedText !== 'string' || !body.payload.scrubbedText.trim()) {
    return reply.status(400).send({ error: 'Missing payload.scrubbedText in request body.' });
  }

  const { sessionId } = body;
  const scrubbedText = body.payload.scrubbedText.trim();
  const requestedMode = body.preferences?.mode || 'balanced';
  const mode = ENHANCEMENT_MODES.has(requestedMode) ? requestedMode : 'balanced';
  const targetPlatform =
    typeof body.meta?.hostPlatform === 'string' && body.meta.hostPlatform.trim()
      ? body.meta.hostPlatform.trim().slice(0, 40)
      : 'generic AI assistant';
  const taskType =
    typeof body.preferences?.taskType === 'string'
      ? body.preferences.taskType.trim().slice(0, 40)
      : 'auto';
  const chatEnvironment =
    typeof body.preferences?.chatEnvironment === 'string'
      ? body.preferences.chatEnvironment.trim().slice(0, 8000)
      : '';
  const conversationContext =
    typeof body.preferences?.conversationContext === 'string'
      ? body.preferences.conversationContext.trim().slice(-12000)
      : '';
  const preserveVoice = body.preferences?.preserveVoice !== false;
  const askClarifying = body.preferences?.askClarifying !== false;
  const qualityChecks = body.preferences?.qualityChecks !== false;

  if (scrubbedText.length > config.maxPromptCharacters) {
    return reply.status(413).send({
      error: `Prompt exceeds the ${config.maxPromptCharacters} character limit.`,
    });
  }

  const cacheKey = [
    `platform:${targetPlatform}`,
    `mode:${mode}`,
    `task:${taskType}`,
    `environment:${chatEnvironment}`,
    `conversation:${conversationContext}`,
    `voice:${preserveVoice}`,
    `clarify:${askClarifying}`,
    `quality:${qualityChecks}`,
    scrubbedText,
  ].join('\n');

  try {
    // 1. Check semantic cache
    const cacheResult = await checkSemanticCache(cacheKey);

    if (
      cacheResult &&
      cacheResult.cached &&
      hasValidPlaceholderIntegrity(scrubbedText, cacheResult.optimizedText) &&
      !/\{\{ALPHA_CONTEXT_SECRET_\d+\}\}/.test(cacheResult.optimizedText)
    ) {
      return reply.send({
        sessionId,
        optimizedText: cacheResult.optimizedText,
        cached: true,
        mode,
        taskType,
        estimatedTokens: estimateTokens(cacheResult.optimizedText),
        contextUsed: Boolean(conversationContext),
      });
    }

    // 2. Cache miss -> call Gemini model
    const optimization = await optimizeWithPlaceholderSafety(scrubbedText, {
      mode,
      targetPlatform,
      taskType,
      chatEnvironment,
      conversationContext,
      preserveVoice,
      askClarifying,
      qualityChecks,
    });
    const optimizedText = optimization.text;

    // 3. Save to cache (reusing the embedding calculated during check)
    if (cacheResult && cacheResult.embedding) {
      await saveToSemanticCache(cacheKey, optimizedText, cacheResult.embedding);
    } else {
      await saveToSemanticCache(cacheKey, optimizedText);
    }

    return reply.send({
      sessionId,
      optimizedText,
      cached: false,
      mode,
      taskType,
      estimatedTokens: estimateTokens(optimizedText),
      degraded: optimization.degraded,
      contextUsed: Boolean(conversationContext),
    });
  } catch (err: any) {
    server.log.error({ errorType: err?.name || 'Error' }, 'Prompt refinement failed.');
    return reply.status(500).send({ error: 'Prompt refinement failed. Please try again.' });
  }
  });

  server.post('/api/environment', async (request, reply) => {
  const body = request.body as EnvironmentRequest;
  const purpose = body?.payload?.scrubbedPurpose?.trim();

  if (!purpose) {
    return reply.status(400).send({ error: 'Describe what this chat is for.' });
  }
  if (purpose.length > 4000) {
    return reply.status(413).send({ error: 'Chat purpose exceeds the 4000 character limit.' });
  }

  const targetPlatform =
    typeof body.meta?.hostPlatform === 'string' && body.meta.hostPlatform.trim()
      ? body.meta.hostPlatform.trim().slice(0, 40)
      : 'generic AI assistant';

  try {
    let environmentText = await createChatEnvironment(purpose, targetPlatform);
    if (!hasValidPlaceholderIntegrity(purpose, environmentText)) {
      environmentText = purpose;
    }
    return reply.send({
      sessionId: body.sessionId,
      environmentText,
      targetPlatform,
    });
  } catch (err: any) {
    server.log.error({ errorType: err?.name || 'Error' }, 'Environment generation failed.');
    return reply.status(500).send({ error: 'Environment generation failed. Please try again.' });
  }
  });

  server.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send({ error: 'Not found.' });
  });

  return server;
}

const start = async () => {
  const server = buildServer();
  try {
    await server.listen({ port: config.port, host: config.host });
    console.log(`Alpha Backend API Gateway running at http://${config.host}:${config.port}`);
    const shutdown = async (signal: string) => {
      server.log.info(`${signal} received; shutting down.`);
      await server.close();
      process.exit(0);
    };
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
    process.once('SIGINT', () => void shutdown('SIGINT'));
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

if (require.main === module) {
  void start();
}
