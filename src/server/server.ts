import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { assessToken, resolveToken } from '../assess.js';
import { screen } from '../discovery/scanner.js';
import { pool } from '../util/http.js';
import * as store from '../store/snapshots.js';
import { log, c } from '../util/log.js';
import type { TokenAssessment } from '../types.js';

const HERE = resolve(fileURLToPath(import.meta.url), '..');
// Works both when run from source via tsx and from a compiled dist/ build,
// where the static assets are not copied by tsc.
const PUBLIC = [join(HERE, 'public'), resolve(process.cwd(), 'src/server/public')]
  .find((p) => existsSync(p)) ?? join(HERE, 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

interface ScanCache { at: number; rows: TokenAssessment[]; running: boolean }
const scanCache: ScanCache = { at: 0, rows: [], running: false };
const SCAN_TTL_MS = 90_000;

async function runScan(params: URLSearchParams): Promise<TokenAssessment[]> {
  const num = (k: string): number | undefined => {
    const v = params.get(k);
    if (!v) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const chains = params.get('chains')?.split(',').filter(Boolean);
  const report = await screen({
    minMarketCapUsd: num('minMc'),
    maxMarketCapUsd: num('maxMc'),
    minLiquidityUsd: num('minLiq'),
    minVolume24hUsd: num('minVol'),
    maxAgeMinutes: num('maxAge'),
    chains,
    limit: num('limit') ?? 20,
  });
  const assessed = await pool(report.candidates, 3, (cand) =>
    assessToken(cand.ref, { market: cand.market }).catch(() => null),
  );
  return assessed.filter((a): a is TokenAssessment => a !== null)
    .sort((a, b) => b.safety.score - a.safety.score);
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** Non-internal IPv4 addresses, so the startup banner can print a URL to type. */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const rows of Object.values(networkInterfaces())) {
    for (const r of rows ?? []) {
      if (r.family === 'IPv4' && !r.internal) out.push(r.address);
    }
  }
  return out;
}

/**
 * Constant-time-ish comparison. The token is short and the endpoint is not a
 * high-value target, but there is no reason to leak length or prefix timing.
 */
function tokenMatches(given: string | null): boolean {
  const expected = config.authToken;
  if (!expected) return true;
  if (!given || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

export function serve(port = config.port, host = config.host): void {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const path = url.pathname;

    // The token gates everything, including the page itself, so a stray visitor
    // on the same network gets nothing rather than a working scanner.
    if (config.authToken && !tokenMatches(url.searchParams.get('k'))) {
      res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized');
      return;
    }

    try {
      if (path === '/api/scan') {
        const fresh = Date.now() - scanCache.at < SCAN_TTL_MS;
        if (fresh && !url.searchParams.has('force')) {
          return json(res, 200, { rows: scanCache.rows, cachedAt: scanCache.at, cached: true });
        }
        if (scanCache.running) {
          return json(res, 200, { rows: scanCache.rows, cachedAt: scanCache.at, cached: true, running: true });
        }
        scanCache.running = true;
        try {
          const rows = await runScan(url.searchParams);
          scanCache.rows = rows;
          scanCache.at = Date.now();
          return json(res, 200, { rows, cachedAt: scanCache.at, cached: false });
        } finally {
          scanCache.running = false;
        }
      }

      if (path === '/api/check') {
        const q = url.searchParams.get('q');
        if (!q) return json(res, 400, { error: 'missing ?q=<address|symbol>' });
        const ref = await resolveToken(q, url.searchParams.get('chain') ?? undefined);
        if (!ref) return json(res, 404, { error: `could not resolve "${q}"` });
        const a = await assessToken(ref);
        return json(res, 200, a);
      }

      if (path === '/api/history') {
        const address = url.searchParams.get('address');
        const chain = url.searchParams.get('chain') ?? 'solana';
        if (!address) return json(res, 400, { error: 'missing ?address=' });
        return json(res, 200, { history: store.history(chain, address) });
      }

      if (path === '/api/tracked') {
        return json(res, 200, { tracked: store.tracked().slice(0, 100) });
      }

      // Static files.
      const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
      // Contain path traversal: the resolved file must stay inside PUBLIC.
      const file = resolve(PUBLIC, rel);
      if (!file.startsWith(PUBLIC)) { res.writeHead(403).end('forbidden'); return; }
      if (existsSync(file)) {
        const body = readFileSync(file);
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    } catch (err) {
      log.error('request failed:', err instanceof Error ? err.message : String(err));
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(port, host, () => {
    const q = config.authToken ? `?k=${config.authToken}` : '';
    log.info(`\n  ${c.bold('rugwatch dashboard')}`);
    log.info(`  on this machine   ${c.cyan(`http://localhost:${port}${q}`)}`);

    if (host === '0.0.0.0' || host === '::') {
      for (const ip of lanAddresses()) {
        log.info(`  from your phone   ${c.cyan(`http://${ip}:${port}${q}`)}`);
      }
      if (!config.authToken) {
        log.info(c.yellow('\n  Reachable by anyone on this network. Set AUTH_TOKEN in .env to require a key,'));
        log.info(c.yellow('  or HOST=127.0.0.1 to keep it on this machine only.'));
      }
    }
    log.info(c.grey('\n  Re-scans on demand, caches for 90s. Ctrl-C to stop.\n'));
  });
}
