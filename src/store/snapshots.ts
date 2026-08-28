import { existsSync, mkdirSync, readFileSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Snapshot } from '../types.js';
import { log } from '../util/log.js';

const DIR = resolve(process.cwd(), 'data/snapshots');

const keyOf = (chain: string, address: string) => `${chain}_${address}`.replace(/[^A-Za-z0-9_.-]/g, '');
const fileOf = (chain: string, address: string) => join(DIR, `${keyOf(chain, address)}.jsonl`);

function ensureDir(): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

/**
 * Append-only JSONL per token. Deliberately not a database: the access pattern
 * is "append one row, read the tail", the volumes are small, and a file per
 * token means a corrupt write can never take out more than one token's history.
 */
export function append(s: Snapshot): void {
  ensureDir();
  try {
    appendFileSync(fileOf(s.chain, s.address), JSON.stringify(s) + '\n', 'utf8');
  } catch (err) {
    log.warn('could not persist snapshot:', String(err));
  }
}

export function history(chain: string, address: string, limit = 500): Snapshot[] {
  const f = fileOf(chain, address);
  if (!existsSync(f)) return [];
  try {
    const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
    const tail = lines.slice(-limit);
    const out: Snapshot[] = [];
    for (const l of tail) {
      try { out.push(JSON.parse(l) as Snapshot); } catch { /* skip a torn line */ }
    }
    return out;
  } catch {
    return [];
  }
}

export function latest(chain: string, address: string): Snapshot | undefined {
  const h = history(chain, address, 5);
  return h.length > 0 ? h[h.length - 1] : undefined;
}

/** Every token we have ever recorded, newest activity first. */
export function tracked(): { chain: string; address: string; last: Snapshot }[] {
  ensureDir();
  const out: { chain: string; address: string; last: Snapshot }[] = [];
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith('.jsonl')) continue;
    try {
      if (statSync(join(DIR, f)).size === 0) continue;
      const lines = readFileSync(join(DIR, f), 'utf8').trimEnd().split('\n');
      const last = JSON.parse(lines[lines.length - 1]!) as Snapshot;
      out.push({ chain: last.chain, address: last.address, last });
    } catch { /* skip unreadable file */ }
  }
  return out.sort((a, b) => b.last.at - a.last.at);
}
