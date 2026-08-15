import { createHash, createHmac } from 'node:crypto';
import Redis from 'ioredis';

export interface TrafficLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

export interface TrafficPolicyStore {
  consume(
    key: string,
    limit: number,
    windowMs: number,
    cost?: number
  ): Promise<TrafficLimitDecision>;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

interface MemoryEntry {
  count: number;
  resetAt: number;
}

export function trafficStorageKey(key: string, keySecret = ''): string {
  return keySecret
    ? createHmac('sha256', keySecret).update(key).digest('hex')
    : createHash('sha256').update(key).digest('hex');
}

export class MemoryTrafficPolicyStore implements TrafficPolicyStore {
  private readonly entries = new Map<string, MemoryEntry>();

  constructor(
    private readonly maxEntries = 50000,
    private readonly now: () => number = Date.now,
    private readonly keySecret = ''
  ) {}

  async consume(
    key: string,
    limit: number,
    windowMs: number,
    cost = 1
  ): Promise<TrafficLimitDecision> {
    const now = this.now();
    const hashedKey = trafficStorageKey(key, this.keySecret);
    if (this.entries.size >= this.maxEntries && !this.entries.has(hashedKey)) {
      for (const [candidate, entry] of this.entries) {
        if (entry.resetAt <= now) this.entries.delete(candidate);
      }
      if (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest) this.entries.delete(oldest);
      }
    }
    const existing = this.entries.get(hashedKey);
    const entry =
      !existing || existing.resetAt <= now
        ? { count: cost, resetAt: now + windowMs }
        : { count: existing.count + cost, resetAt: existing.resetAt };
    this.entries.set(hashedKey, entry);
    return {
      allowed: entry.count <= limit,
      limit,
      remaining: Math.max(0, limit - entry.count),
      resetAt: entry.resetAt
    };
  }

  async ready(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.entries.clear();
  }
}

const CONSUME_SCRIPT = `
local count = redis.call('INCRBY', KEYS[1], ARGV[1])
if count == tonumber(ARGV[1]) then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}
`;

export class RedisTrafficPolicyStore implements TrafficPolicyStore {
  private readonly client: Redis;
  private connectionPromise: Promise<void> | null = null;

  constructor(
    redisUrl: string,
    private readonly keySecret: string
  ) {
    this.client = new Redis(redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      commandTimeout: 3000
    });
    this.client.on('error', () => {
      // The caller fails closed; connection details are intentionally not logged here.
    });
  }

  private async ensureConnected(): Promise<void> {
    if (
      (this.client.status === 'wait' || this.client.status === 'end') &&
      !this.connectionPromise
    ) {
      this.connectionPromise = this.client.connect().finally(() => {
        this.connectionPromise = null;
      });
    }
    if (this.connectionPromise) await this.connectionPromise;
    if (this.client.status !== 'ready') throw new Error('Traffic policy store is unavailable.');
  }

  async consume(
    key: string,
    limit: number,
    windowMs: number,
    cost = 1
  ): Promise<TrafficLimitDecision> {
    await this.ensureConnected();
    const redisKey = `alpha:traffic:${trafficStorageKey(key, this.keySecret)}`;
    const result = (await this.client.eval(
      CONSUME_SCRIPT,
      1,
      redisKey,
      String(cost),
      String(windowMs)
    )) as [number, number];
    const count = Number(result[0]);
    const ttl = Math.max(0, Number(result[1]));
    return {
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt: Date.now() + ttl
    };
  }

  async ready(): Promise<boolean> {
    try {
      await this.ensureConnected();
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.client.status === 'ready') {
      await this.client.quit();
    } else {
      this.client.disconnect(false);
    }
  }
}

export function createTrafficPolicyStore(options: {
  redisUrl?: string;
  maxEntries: number;
  keySecret?: string;
}): TrafficPolicyStore {
  return options.redisUrl
    ? new RedisTrafficPolicyStore(options.redisUrl, options.keySecret || '')
    : new MemoryTrafficPolicyStore(options.maxEntries, Date.now, options.keySecret || '');
}
