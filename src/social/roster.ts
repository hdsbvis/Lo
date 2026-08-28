import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RosterEntry, WhaleTier } from '../types.js';
import { log } from '../util/log.js';

export interface Roster {
  byHandle: Map<string, RosterEntry>;
  /** Accounts whose coverage is a warning rather than a shill. */
  warnAccounts: Set<string>;
  /** Wallet address (lowercased) -> roster handle. */
  walletOwners: Map<string, string>;
  size: number;
}

const norm = (h: string) => h.replace(/^@/, '').trim().toLowerCase();

export function loadRoster(path = resolve(process.cwd(), 'data/whales.json')): Roster {
  const empty: Roster = { byHandle: new Map(), warnAccounts: new Set(), walletOwners: new Map(), size: 0 };
  if (!existsSync(path)) {
    log.warn(`roster not found at ${path}; social tiers will fall back to heuristics only`);
    return empty;
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      roster?: RosterEntry[];
      warnAccounts?: string[];
    };
    const byHandle = new Map<string, RosterEntry>();
    const walletOwners = new Map<string, string>();
    for (const e of raw.roster ?? []) {
      if (!e.handle) continue;
      const h = norm(e.handle);
      byHandle.set(h, { ...e, handle: h });
      for (const w of e.wallets ?? []) walletOwners.set(w.toLowerCase(), h);
    }
    return {
      byHandle,
      warnAccounts: new Set((raw.warnAccounts ?? []).map(norm)),
      walletOwners,
      size: byHandle.size,
    };
  } catch (err) {
    log.warn(`roster at ${path} is not valid JSON (${String(err)}); continuing without it`);
    return empty;
  }
}

export function lookup(roster: Roster, handle: string): RosterEntry | undefined {
  return roster.byHandle.get(norm(handle));
}

export function isWarnAccount(roster: Roster, handle: string): boolean {
  return roster.warnAccounts.has(norm(handle));
}

export const TIER_RANK: Record<WhaleTier, number> = {
  WHALE: 5, KOL: 4, ALPHA: 3, RETAIL: 2, NOBODY: 1, BOT: 0,
};

export function bestTier(tiers: WhaleTier[]): WhaleTier | null {
  if (tiers.length === 0) return null;
  return tiers.reduce((a, b) => (TIER_RANK[b] > TIER_RANK[a] ? b : a));
}
