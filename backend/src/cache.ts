import Redis from 'ioredis';
import { config } from './config.js';
import { getEmbedding } from './gemini.js';

interface CacheEntry {
  embedding: number[];
  optimizedText: string;
  createdAt: number;
}

const REDIS_CACHE_KEY = 'alpha:semantic_cache';
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
      connectTimeout: 2000,
    });

    redisClient.on('connect', () => {
      console.log('Connected to Redis for semantic caching.');
      useRedis = true;
    });

    redisClient.on('error', (err) => {
      console.warn(`Redis connection error: ${err.message}. Falling back to in-memory cache.`);
      useRedis = false;
    });
  } catch (err: any) {
    console.warn(`Failed to initialize Redis client: ${err.message}. Using in-memory cache.`);
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
  scrubbedText: string
): Promise<{ optimizedText: string; cached: boolean; embedding: number[] } | null> {
  if (!config.enableSemanticCache) return null;
  try {
    // 1. Generate the embedding for the incoming text
    const queryEmbedding = await getEmbedding(scrubbedText);

    // 2. Fetch all entries from active database (Redis or In-memory)
    let entries: Record<string, string> = {};

    if (useRedis && redisClient) {
      entries = await redisClient.hgetall(REDIS_CACHE_KEY);
    } else {
      for (const [text, entry] of inMemoryCache.entries()) {
        if (Date.now() - entry.createdAt > config.cacheTtlMs) {
          inMemoryCache.delete(text);
          continue;
        }
        entries[text] = JSON.stringify(entry);
      }
    }

    // 3. Scan entries and calculate cosine similarity
    let bestMatchText: string | null = null;
    let bestSimilarity = -1;

    for (const [_, valueJson] of Object.entries(entries)) {
      try {
        const entry: CacheEntry = JSON.parse(valueJson);
        if (entry.createdAt && Date.now() - entry.createdAt > config.cacheTtlMs) continue;
        const similarity = cosineSimilarity(queryEmbedding, entry.embedding);

        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestMatchText = entry.optimizedText;
        }
      } catch (e) {
        // Skip malformed entries
      }
    }

    // Cosine similarity threshold selection
    const threshold = 0.90;
    if (bestMatchText && bestSimilarity >= threshold) {
      console.log(`[Cache Hit] Match found (Similarity: ${bestSimilarity.toFixed(4)})`);
      return { optimizedText: bestMatchText, cached: true, embedding: queryEmbedding };
    }

    return { optimizedText: '', cached: false, embedding: queryEmbedding };
  } catch (err: any) {
    console.error('Error during semantic cache lookup:', err.message);
    return null;
  }
}

/**
 * Saves the optimized prompt and its precalculated embedding to the cache.
 */
export async function saveToSemanticCache(
  scrubbedText: string,
  optimizedText: string,
  precalculatedEmbedding?: number[]
): Promise<void> {
  if (!config.enableSemanticCache) return;
  try {
    const embedding = precalculatedEmbedding || (await getEmbedding(scrubbedText));
    const entry: CacheEntry = { embedding, optimizedText, createdAt: Date.now() };
    const valueStr = JSON.stringify(entry);

    if (useRedis && redisClient) {
      await redisClient.hset(REDIS_CACHE_KEY, scrubbedText, valueStr);
    } else {
      if (inMemoryCache.size >= config.cacheMaxEntries) {
        const oldestKey = inMemoryCache.keys().next().value as string | undefined;
        if (oldestKey) inMemoryCache.delete(oldestKey);
      }
      inMemoryCache.set(scrubbedText, entry);
    }
    console.log('[Cache Save] Successfully saved prompt to semantic cache.');
  } catch (err: any) {
    console.error('Failed to save to semantic cache:', err.message);
  }
}
