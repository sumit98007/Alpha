import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { optimizePrompt } from './gemini.js';
import { checkSemanticCache, saveToSemanticCache } from './cache.js';

const server = Fastify({
  logger: true,
});

// Configure CORS to accept requests from chrome-extension:// origins
server.register(cors, {
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
});

// Health check endpoint
server.get('/api/health', async () => {
  return { status: 'ok', timestamp: Date.now() };
});

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
}

// Enhance prompt endpoint
server.post('/api/enhance', async (request, reply) => {
  const body = request.body as EnhanceRequest;

  if (!body || !body.payload || !body.payload.scrubbedText) {
    return reply.status(400).send({ error: 'Missing payload.scrubbedText in request body.' });
  }

  const { sessionId } = body;
  const { scrubbedText } = body.payload;

  try {
    // 1. Check semantic cache
    const cacheResult = await checkSemanticCache(scrubbedText);

    if (cacheResult && cacheResult.cached) {
      return reply.send({
        sessionId,
        optimizedText: cacheResult.optimizedText,
        cached: true,
      });
    }

    // 2. Cache miss -> call Gemini model
    const optimizedText = await optimizePrompt(scrubbedText);

    // 3. Save to cache (reusing the embedding calculated during check)
    if (cacheResult && cacheResult.embedding) {
      await saveToSemanticCache(scrubbedText, optimizedText, cacheResult.embedding);
    } else {
      await saveToSemanticCache(scrubbedText, optimizedText);
    }

    return reply.send({
      sessionId,
      optimizedText,
      cached: false,
    });
  } catch (err: any) {
    server.log.error(`Enhancement error: ${err.message}`);
    return reply.status(500).send({ error: `Internal Server Error: ${err.message}` });
  }
});

// Start the server
const start = async () => {
  try {
    await server.listen({ port: config.port, host: config.host });
    console.log(`Alpha Backend API Gateway running at http://${config.host}:${config.port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
