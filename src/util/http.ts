import { config } from '../config.js';
import { log } from './log.js';

interface CacheRow { at: number; body: unknown }
const cache = new Map<string, CacheRow>();

/** Per-host serialization + spacing, so a scan of 40 tokens does not get us banned. */
const hostQueues = new Map<string, Promise<unknown>>();
const HOST_MIN_GAP_MS: Record<string, number> = {
  'api.dexscreener.com': 220,
  'api.gopluslabs.io': 350,
  'api.rugcheck.xyz': 350,
  'api.mainnet-beta.solana.com': 450,
};
const lastCall = new Map<string, number>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function paced<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const gap = HOST_MIN_GAP_MS[host] ?? 150;
  const prev = hostQueues.get(host) ?? Promise.resolve();
  const run = prev.then(async () => {
    const since = Date.now() - (lastCall.get(host) ?? 0);
    if (since < gap) await sleep(gap - since);
    try {
      return await fn();
    } finally {
      lastCall.set(host, Date.now());
    }
  });
  // Keep the chain alive even when this link rejects.
  hostQueues.set(host, run.catch(() => undefined));
  return run;
}

export class HttpError extends Error {
  // Explicit fields rather than TS parameter properties, so the sources stay
  // strippable by `node --experimental-strip-types` for anyone running them
  // without a loader.
  status: number;
  url: string;
  constructor(status: number, url: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

export interface GetOpts {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  /** 0 disables the cache for this call. */
  cacheTtlMs?: number;
  method?: 'GET' | 'POST';
  body?: unknown;
}

/**
 * JSON fetch with timeout, bounded retry on transient failures, per-host pacing
 * and a short TTL cache. Retries only 429/5xx/network -- a 4xx is a real answer.
 */
export async function getJson<T = unknown>(url: string, opts: GetOpts = {}): Promise<T> {
  const ttl = opts.cacheTtlMs ?? config.http.cacheTtlMs;
  const key = `${opts.method ?? 'GET'} ${url} ${opts.body ? JSON.stringify(opts.body) : ''}`;
  if (ttl > 0) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) {
      log.debug('cache hit', url);
      return hit.body as T;
    }
  }

  const host = new URL(url).host;
  const retries = opts.retries ?? config.http.retries;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(400 * 2 ** (attempt - 1));
    try {
      const body = await paced(host, async () => {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), opts.timeoutMs ?? config.http.timeoutMs);
        try {
          const res = await fetch(url, {
            method: opts.method ?? 'GET',
            signal: ctl.signal,
            headers: {
              accept: 'application/json',
              'user-agent': 'rugwatch/0.1 (+local research tool)',
              ...(opts.body ? { 'content-type': 'application/json' } : {}),
              ...opts.headers,
            },
            ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
          });
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new HttpError(res.status, url, `HTTP ${res.status} ${text.slice(0, 160)}`);
          }
          return (await res.json()) as T;
        } finally {
          clearTimeout(t);
        }
      });
      if (ttl > 0) cache.set(key, { at: Date.now(), body });
      return body;
    } catch (err) {
      lastErr = err;
      const retryable =
        !(err instanceof HttpError) || err.status === 429 || err.status >= 500;
      log.debug(`fetch fail (attempt ${attempt + 1}/${retries + 1})`, url, String(err));
      if (!retryable) break;
    }
  }
  throw lastErr;
}

/** Runs tasks with bounded concurrency, preserving input order. */
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
