import { Redis } from 'ioredis';
import { config } from '../config/env.js';
import type { Logger } from './logger.js';

/**
 * Redis is optional in Phase 1 — it backs caching and, from Phase 7, the job
 * queue. Its absence degrades the system (no automated execution, §55) but must
 * never crash the API or block read-only operation.
 */
let client: Redis | null = null;
let unavailable = false;

export function redis(logger?: Logger): Redis | null {
  const url = config().REDIS_URL;
  if (!url || unavailable) return null;
  if (!client) {
    client = new Redis(url, {
      maxRetriesPerRequest: 2,
      lazyConnect: false,
      retryStrategy: (times) => (times > 10 ? null : Math.min(times * 200, 3000)),
    });
    client.on('error', (err) => {
      logger?.warn({ err: err.message }, 'redis connection error');
    });
  }
  return client;
}

export async function pingRedis(): Promise<{
  ok: boolean;
  latencyMs: number | null;
  detail: string | null;
}> {
  const c = redis();
  if (!c) return { ok: false, latencyMs: null, detail: 'REDIS_URL is not configured' };
  const started = Date.now();
  try {
    await c.ping();
    return { ok: true, latencyMs: Date.now() - started, detail: null };
  } catch (err) {
    return { ok: false, latencyMs: null, detail: (err as Error).message };
  }
}

export async function disconnectRedis(): Promise<void> {
  if (client) {
    client.disconnect();
    client = null;
  }
  unavailable = false;
}
