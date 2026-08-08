import dotenv from 'dotenv';
import path from 'path';

// Load .env from the current working directory
const envPath = path.resolve(process.cwd(), '.env');
console.log(`[Config] Loading environment variables from: ${envPath}`);
dotenv.config({ path: envPath });

function integerFromEnv(name: string, fallback: number, minimum = 1): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }
  return value;
}

function listFromEnv(name: string): string[] {
  return (process.env[name] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function booleanFromEnv(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be either true or false.`);
}

const nodeEnv = process.env.NODE_ENV || 'development';

export const config = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port: integerFromEnv('PORT', 3000),
  host: process.env.HOST || '127.0.0.1',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
  geminiEmbeddingModel: process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2',
  gatewayApiKey: process.env.GATEWAY_API_KEY || '',
  allowedOrigins: listFromEnv('ALLOWED_ORIGINS'),
  redisUrl: process.env.REDIS_URL || undefined,
  enableSemanticCache: booleanFromEnv('ENABLE_SEMANTIC_CACHE', false),
  maxPromptCharacters: integerFromEnv('MAX_PROMPT_CHARACTERS', 30000),
  rateLimitMax: integerFromEnv('RATE_LIMIT_MAX', 60),
  rateLimitWindowMs: integerFromEnv('RATE_LIMIT_WINDOW_MS', 60000, 1000),
  cacheMaxEntries: integerFromEnv('CACHE_MAX_ENTRIES', 500),
  cacheTtlMs: integerFromEnv('CACHE_TTL_MS', 86400000, 1000),
};

if (!config.geminiApiKey) {
  console.warn('WARNING: GEMINI_API_KEY environment variable is not set. API calls to Gemini will fail.');
}

if (config.isProduction) {
  const missing = [
    !config.geminiApiKey && 'GEMINI_API_KEY',
    !config.gatewayApiKey && 'GATEWAY_API_KEY',
    config.allowedOrigins.length === 0 && 'ALLOWED_ORIGINS',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Missing required production configuration: ${missing.join(', ')}`);
  }
  if (config.gatewayApiKey.length < 32) {
    throw new Error('GATEWAY_API_KEY must contain at least 32 characters in production.');
  }
  if (config.gatewayApiKey === config.geminiApiKey) {
    throw new Error('GATEWAY_API_KEY must not reuse GEMINI_API_KEY.');
  }
  if (config.allowedOrigins.some((origin) => origin === '*' || !/^(https:\/\/|chrome-extension:\/\/)/.test(origin))) {
    throw new Error('ALLOWED_ORIGINS must contain exact HTTPS or chrome-extension origins; wildcards are not allowed.');
  }
}
