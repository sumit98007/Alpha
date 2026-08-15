import dotenv from 'dotenv';
import path from 'node:path';
import { isIP } from 'node:net';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function integerFromEnv(
  name: string,
  fallback: number,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  const raw = process.env[name];
  if (raw !== undefined && !/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a whole number.`);
  }
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
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

function trustProxyFromEnv(): false | string[] {
  const raw = process.env.TRUST_PROXY?.trim();
  if (!raw || raw === 'false') return false;
  if (raw === 'true') {
    throw new Error(
      'TRUST_PROXY=true is not allowed; configure explicit proxy IPs or CIDR ranges.'
    );
  }
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0 || entries.length > 32) {
    throw new Error('TRUST_PROXY must contain between 1 and 32 explicit IP or CIDR entries.');
  }
  for (const entry of entries) {
    const parts = entry.split('/');
    if (parts.length > 2) {
      throw new Error('TRUST_PROXY entries must be literal IP addresses or bounded CIDR ranges.');
    }
    const [address, prefixText] = parts;
    const family = isIP(address);
    const unspecifiedIpv6 = family === 6 && address.replaceAll(':', '').replaceAll('0', '') === '';
    if (!family || address === '0.0.0.0' || unspecifiedIpv6) {
      throw new Error('TRUST_PROXY entries must be literal, non-unspecified IP addresses.');
    }
    if (prefixText !== undefined) {
      const maximum = family === 4 ? 32 : 128;
      if (!/^\d{1,3}$/.test(prefixText)) {
        throw new Error('TRUST_PROXY CIDR prefixes must be whole numbers.');
      }
      const prefix = Number(prefixText);
      if (prefix < 1 || prefix > maximum) {
        throw new Error(`TRUST_PROXY CIDR prefixes must be between 1 and ${maximum}.`);
      }
    }
  }
  return entries;
}

function optionalUrl(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${name} must not contain credentials or a URL fragment.`);
  }
  return parsed.toString();
}

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';
const gatewayApiKey = process.env.GATEWAY_API_KEY || '';
const authJwksUri = optionalUrl('AUTH_JWKS_URI');
const authIssuer = process.env.AUTH_ISSUER?.trim() || '';
const authAudience = process.env.AUTH_AUDIENCE?.trim() || '';
const authRequiredScopes = listFromEnv('AUTH_REQUIRED_SCOPES');
const allowLegacyGatewayKey = booleanFromEnv(
  'ALLOW_LEGACY_GATEWAY_KEY',
  !isProduction && Boolean(gatewayApiKey)
);

export const config = {
  nodeEnv,
  isProduction,
  port: integerFromEnv('PORT', 3000, 1, 65535),
  host: process.env.HOST || '127.0.0.1',
  trustProxy: trustProxyFromEnv(),
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
  geminiEmbeddingModel: process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2',
  providerTimeoutMs: integerFromEnv('PROVIDER_TIMEOUT_MS', 25000, 1000, 120000),
  providerMaxAttempts: integerFromEnv('PROVIDER_MAX_ATTEMPTS', 2, 1, 3),
  providerReadinessCacheMs: integerFromEnv('PROVIDER_READINESS_CACHE_MS', 30000, 1000, 300000),
  providerMaxOutputTokens: integerFromEnv('PROVIDER_MAX_OUTPUT_TOKENS', 8192, 256, 16384),
  gatewayApiKey,
  allowLegacyGatewayKey,
  authJwksUri,
  authIssuer,
  authAudience,
  authRequiredScopes,
  authAlgorithms: listFromEnv('AUTH_ALGORITHMS').length
    ? listFromEnv('AUTH_ALGORITHMS')
    : ['RS256'],
  authClockToleranceSeconds: integerFromEnv('AUTH_CLOCK_TOLERANCE_SECONDS', 30, 0, 300),
  authMaxTokenAgeSeconds: integerFromEnv('AUTH_MAX_TOKEN_AGE_SECONDS', 3600, 60, 86400),
  authJwksCacheTtlMs: integerFromEnv('AUTH_JWKS_CACHE_TTL_MS', 300000, 1000, 86400000),
  authJwksTimeoutMs: integerFromEnv('AUTH_JWKS_TIMEOUT_MS', 5000, 500, 30000),
  allowedOrigins: listFromEnv('ALLOWED_ORIGINS'),
  redisUrl: process.env.REDIS_URL || undefined,
  trafficRedisUrl: process.env.TRAFFIC_REDIS_URL || process.env.REDIS_URL || undefined,
  trafficKeySecret: process.env.TRAFFIC_KEY_SECRET || '',
  enableSemanticCache: booleanFromEnv('ENABLE_SEMANTIC_CACHE', false),
  maxPromptCharacters: integerFromEnv('MAX_PROMPT_CHARACTERS', 30000, 100, 30000),
  maxEnhancedOutputCharacters: integerFromEnv('MAX_ENHANCED_OUTPUT_CHARACTERS', 30000, 100, 30000),
  maxRequestBodyBytes: integerFromEnv('MAX_REQUEST_BODY_BYTES', 262144, 65536, 2097152),
  rateLimitMax: integerFromEnv('RATE_LIMIT_MAX', 60, 1, 100000),
  userRateLimitMax: integerFromEnv('USER_RATE_LIMIT_MAX', 120, 1, 100000),
  rateLimitWindowMs: integerFromEnv('RATE_LIMIT_WINDOW_MS', 60000, 1000, 86400000),
  dailyRequestQuota: integerFromEnv('DAILY_REQUEST_QUOTA', 500, 1, 1000000),
  trafficMaxEntries: integerFromEnv('TRAFFIC_MAX_ENTRIES', 50000, 100, 1000000),
  cacheMaxEntries: integerFromEnv('CACHE_MAX_ENTRIES', 500, 1, 10000),
  cacheTtlMs: integerFromEnv('CACHE_TTL_MS', 86400000, 1000, 604800000)
};

if (config.maxEnhancedOutputCharacters < config.maxPromptCharacters) {
  throw new Error(
    'MAX_ENHANCED_OUTPUT_CHARACTERS must be at least MAX_PROMPT_CHARACTERS for safe fallback.'
  );
}
if (config.maxRequestBodyBytes < config.maxPromptCharacters + 70000) {
  throw new Error(
    'MAX_REQUEST_BODY_BYTES is too small for the configured prompt and schema overhead.'
  );
}

const supportedJwtAlgorithms = new Set(['RS256', 'RS384', 'RS512', 'ES256', 'ES384']);
if (config.authAlgorithms.some((algorithm) => !supportedJwtAlgorithms.has(algorithm))) {
  throw new Error('AUTH_ALGORITHMS contains an unsupported or unsafe JWT algorithm.');
}

if (
  authRequiredScopes.length > 20 ||
  authRequiredScopes.some((scope) => !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(scope)) ||
  new Set(authRequiredScopes).size !== authRequiredScopes.length
) {
  throw new Error('AUTH_REQUIRED_SCOPES must contain unique, bounded OAuth scope names.');
}

if (config.authJwksUri) {
  const jwksUrl = new URL(config.authJwksUri);
  if (isProduction && jwksUrl.protocol !== 'https:') {
    throw new Error('AUTH_JWKS_URI must use HTTPS in production.');
  }
}

if (config.authIssuer) {
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(config.authIssuer);
  } catch {
    throw new Error('AUTH_ISSUER must be a valid URL.');
  }
  if (
    issuerUrl.username ||
    issuerUrl.password ||
    issuerUrl.search ||
    issuerUrl.hash ||
    (isProduction && issuerUrl.protocol !== 'https:')
  ) {
    throw new Error(
      'AUTH_ISSUER must be an HTTPS issuer URL without credentials, query, or fragment.'
    );
  }
}

if (isProduction) {
  const missing = [
    !config.geminiApiKey && 'GEMINI_API_KEY',
    !config.authJwksUri && 'AUTH_JWKS_URI',
    !config.authIssuer && 'AUTH_ISSUER',
    !config.authAudience && 'AUTH_AUDIENCE',
    config.authRequiredScopes.length === 0 && 'AUTH_REQUIRED_SCOPES',
    config.allowedOrigins.length === 0 && 'ALLOWED_ORIGINS',
    !config.trafficRedisUrl && 'TRAFFIC_REDIS_URL or REDIS_URL',
    !config.trafficKeySecret && 'TRAFFIC_KEY_SECRET'
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Missing required production configuration: ${missing.join(', ')}`);
  }
  if (config.allowLegacyGatewayKey || config.gatewayApiKey) {
    throw new Error(
      'Legacy gateway-key authentication is development-only and cannot be enabled in production.'
    );
  }
  if (config.authMaxTokenAgeSeconds > 3600) {
    throw new Error('AUTH_MAX_TOKEN_AGE_SECONDS cannot exceed 3600 in production.');
  }
  if (config.rateLimitWindowMs !== 60000) {
    throw new Error('RATE_LIMIT_WINDOW_MS must be exactly 60000 in production.');
  }
  if (config.trafficKeySecret.length < 32 || config.trafficKeySecret.length > 1024) {
    throw new Error('TRAFFIC_KEY_SECRET must contain between 32 and 1024 characters.');
  }
  const trafficRedisUrl = new URL(config.trafficRedisUrl as string);
  if (trafficRedisUrl.protocol !== 'rediss:') {
    throw new Error('Production traffic limits require a TLS REDIS URL using rediss://.');
  }
  if (config.enableSemanticCache) {
    throw new Error(
      'Semantic similarity caching is development-only and cannot be enabled in production.'
    );
  }
  const invalidOrigin = config.allowedOrigins.some((origin) => {
    if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return false;
    try {
      const parsed = new URL(origin);
      return (
        parsed.protocol !== 'https:' ||
        parsed.origin !== origin ||
        Boolean(parsed.username || parsed.password)
      );
    } catch {
      return true;
    }
  });
  if (invalidOrigin) {
    throw new Error(
      'ALLOWED_ORIGINS must contain exact HTTPS or chrome-extension origins; wildcards are not allowed.'
    );
  }
}

if (!config.geminiApiKey && nodeEnv !== 'test') {
  console.warn('GEMINI_API_KEY is not configured; provider-backed endpoints will be unavailable.');
}
