import Redis from 'ioredis';
import { createHash } from 'node:crypto';
import { config } from './config.js';
import { getEmbedding } from './gemini.js';

interface CacheEntry {
  embedding: number[];
  optimizedText: string;
  createdAt: number;
}

export function classifyCacheEntries(
  entries: Record<string, string>,
  now: number,
  ttlMs: number
): { freshEntries: Array<[string, CacheEntry]>; staleFields: string[] } {
  const freshEntries: Array<[string, CacheEntry]> = [];
  const staleFields: string[] = [];
  for (const [field, valueJson] of Object.entries(entries)) {
    try {
      const entry = JSON.parse(valueJson) as Partial<CacheEntry>;
      const valid =
        Number.isFinite(entry.createdAt) &&
        (entry.createdAt as number) > 0 &&
        (entry.createdAt as number) <= now &&
        now - (entry.createdAt as number) <= ttlMs &&
        typeof entry.optimizedText === 'string' &&
        entry.optimizedText.length > 0 &&
        entry.optimizedText.length <= config.maxEnhancedOutputCharacters &&
        Array.isArray(entry.embedding) &&
        entry.embedding.length === 768 &&
        entry.embedding.every(Number.isFinite);
      if (valid) freshEntries.push([field, entry as CacheEntry]);
      else staleFields.push(field);
    } catch {
      staleFields.push(field);
    }
  }
  return { freshEntries, staleFields };
}

const inMemoryCache = new Map<string, CacheEntry>();
let redisClient: Redis | null = null;
let useRedis = false;

// Initialize Redis Client if configured
if (!config.enableSemanticCache) {
  console.log('Semantic cache disabled.');
} else if (config.redisUrl) {
  try {
    redisClient = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000
    });

    redisClient.on('connect', () => {
      console.log('Connected to Redis for semantic caching.');
      useRedis = true;
    });

    redisClient.on('error', () => {
      console.warn('Semantic-cache Redis is unavailable. Falling back to in-memory cache.');
      useRedis = false;
    });
  } catch {
    console.warn('Semantic-cache Redis could not be initialized. Using in-memory cache.');
  }
} else {
  console.log('No Redis URL provided. Using in-memory semantic cache.');
}

/**
 * Computes cosine similarity between two vector arrays of the same length.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Checks if a semantically similar prompt exists in the cache (> 0.90 cosine similarity).
 * Returns the optimized text if hit, or the generated embedding to reuse if miss.
 */
export async function checkSemanticCache(
  scrubbedText: string,
  namespace: string,
  signal?: AbortSignal
): Promise<{ optimizedText: string; cached: boolean; embedding: number[] } | null> {
  if (!config.enableSemanticCache) return null;
  try {
    // 1. Generate the embedding for the incoming text
    const queryEmbedding = await getEmbedding(scrubbedText, signal);

    // 2. Fetch all entries from active database (Redis or In-memory)
    let entries: Record<string, string> = {};

    if (useRedis && redisClient) {
      entries = await redisClient.hgetall(redisCacheKey(namespace));
    } else {
      for (const [text, entry] of inMemoryCache.entries()) {
        if (Date.now() - entry.createdAt > config.cacheTtlMs) {
          inMemoryCache.delete(text);
          continue;
        }
        if (text.startsWith(`${namespaceKey(namespace)}:`)) {
          entries[text] = JSON.stringify(entry);
        }
      }
    }

    // 3. Scan entries and calculate cosine similarity
    let bestMatchText: string | null = null;
    let bestSimilarity = -1;

    const { freshEntries, staleFields } = classifyCacheEntries(
      entries,
      Date.now(),
      config.cacheTtlMs
    );
    if (useRedis && redisClient && staleFields.length > 0) {
      await redisClient.hdel(redisCacheKey(namespace), ...staleFields);
    }
    for (const [, entry] of freshEntries) {
      const similarity = cosineSimilarity(queryEmbedding, entry.embedding);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatchText = entry.optimizedText;
      }
    }

    // Cosine similarity threshold selection
    const threshold = 0.9;
    if (bestMatchText && bestSimilarity >= threshold) {
      console.log(`[Cache Hit] Match found (Similarity: ${bestSimilarity.toFixed(4)})`);
      return { optimizedText: bestMatchText, cached: true, embedding: queryEmbedding };
    }

    return { optimizedText: '', cached: false, embedding: queryEmbedding };
  } catch {
    console.error('Semantic cache lookup failed; continuing without a cached result.');
    return null;
  }
}

/**
 * Saves the optimized prompt and its precalculated embedding to the cache.
 */
export async function saveToSemanticCache(
  scrubbedText: string,
  optimizedText: string,
  namespace: string,
  precalculatedEmbedding?: number[],
  signal?: AbortSignal
): Promise<void> {
  if (!config.enableSemanticCache) return;
  try {
    const embedding = precalculatedEmbedding || (await getEmbedding(scrubbedText, signal));
    const entry: CacheEntry = { embedding, optimizedText, createdAt: Date.now() };
    const valueStr = JSON.stringify(entry);

    if (useRedis && redisClient) {
      const cacheKey = redisCacheKey(namespace);
      if ((await redisClient.hlen(cacheKey)) >= config.cacheMaxEntries) {
        const [oldest] = await redisClient.hkeys(cacheKey);
        if (oldest) await redisClient.hdel(cacheKey, oldest);
      }
      await redisClient.hset(cacheKey, contentKey(scrubbedText), valueStr);
      await redisClient.pexpire(cacheKey, config.cacheTtlMs);
    } else {
      if (inMemoryCache.size >= config.cacheMaxEntries) {
        const oldestKey = inMemoryCache.keys().next().value;
        if (oldestKey) inMemoryCache.delete(oldestKey);
      }
      inMemoryCache.set(`${namespaceKey(namespace)}:${contentKey(scrubbedText)}`, entry);
    }
    console.log('[Cache Save] Successfully saved prompt to semantic cache.');
  } catch {
    console.error('Semantic cache save failed; continuing without caching.');
  }
}

function namespaceKey(namespace: string): string {
  return createHash('sha256').update(namespace).digest('hex');
}

function contentKey(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function redisCacheKey(namespace: string): string {
  return `alpha:semantic_cache:${namespaceKey(namespace)}`;
}

export async function isSemanticCacheReady(): Promise<boolean> {
  if (!config.enableSemanticCache || !redisClient) return true;
  try {
    return (await redisClient.ping()) === 'PONG';
  } catch {
    return false;
  }
}

export async function closeSemanticCache(): Promise<void> {
  inMemoryCache.clear();
  if (!redisClient) return;
  if (redisClient.status === 'ready') {
    await redisClient.quit();
  } else {
    redisClient.disconnect(false);
  }
  redisClient = null;
  useRedis = false;
}
