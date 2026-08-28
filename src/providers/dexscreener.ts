import { getJson } from '../util/http.js';
import type { MarketData, TokenRef, Social } from '../types.js';

const BASE = 'https://api.dexscreener.com';

interface DsPair {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  /** Absent on bonding-curve pairs (pump.fun pre-migration). Absent != zero. */
  liquidity?: { usd?: number; base?: number; quote?: number };
  pairCreatedAt?: number;
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  txns?: Record<string, { buys?: number; sells?: number }>;
  info?: { socials?: { type?: string; platform?: string; url?: string }[]; websites?: { url?: string }[] };
  boosts?: { active?: number };
}

interface DsProfile {
  url?: string;
  chainId?: string;
  tokenAddress?: string;
  description?: string;
  links?: { type?: string; label?: string; url?: string }[];
}

const n = (v: unknown): number | undefined => {
  const x = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(x) ? x : undefined;
};

function toMarket(p: DsPair): MarketData {
  const socials: Social[] = [];
  for (const s of p.info?.socials ?? []) {
    if (s.url) socials.push({ type: s.type || s.platform || 'social', url: s.url });
  }
  for (const w of p.info?.websites ?? []) {
    if (w.url) socials.push({ type: 'website', url: w.url });
  }
  const created = p.pairCreatedAt;
  return {
    pairAddress: p.pairAddress,
    dexId: p.dexId,
    url: p.url,
    priceUsd: n(p.priceUsd),
    marketCapUsd: n(p.marketCap),
    fdvUsd: n(p.fdv),
    // Deliberately left undefined (not 0) when the key is missing.
    liquidityUsd: p.liquidity ? n(p.liquidity.usd) : undefined,
    pairCreatedAt: created,
    ageMinutes: created ? Math.max(0, (Date.now() - created) / 60_000) : undefined,
    volume: { m5: n(p.volume?.['m5']), h1: n(p.volume?.['h1']), h6: n(p.volume?.['h6']), h24: n(p.volume?.['h24']) },
    priceChange: {
      m5: n(p.priceChange?.['m5']), h1: n(p.priceChange?.['h1']),
      h6: n(p.priceChange?.['h6']), h24: n(p.priceChange?.['h24']),
    },
    txns: {
      m5: p.txns?.['m5'] ? { buys: p.txns['m5'].buys ?? 0, sells: p.txns['m5'].sells ?? 0 } : undefined,
      h1: p.txns?.['h1'] ? { buys: p.txns['h1'].buys ?? 0, sells: p.txns['h1'].sells ?? 0 } : undefined,
      h24: p.txns?.['h24'] ? { buys: p.txns['h24'].buys ?? 0, sells: p.txns['h24'].sells ?? 0 } : undefined,
    },
    socials,
    boosted: (p.boosts?.active ?? 0) > 0,
  };
}

/**
 * Exit depth is the sum of every pool you could sell into, not the deepest one.
 * Reading a single pair understates liquidity on any token that trades in more
 * than one place, which then fires the market-cap-to-liquidity rule spuriously.
 * Volume is summed for the same reason.
 */
function aggregate(pairs: DsPair[], market: MarketData): MarketData {
  let liq = 0;
  let sawLiq = false;
  const vol = { m5: 0, h1: 0, h6: 0, h24: 0 };
  const seenVol = { m5: false, h1: false, h6: false, h24: false };

  for (const p of pairs) {
    const l = p.liquidity ? n(p.liquidity.usd) : undefined;
    if (l !== undefined) { liq += l; sawLiq = true; }
    for (const k of ['m5', 'h1', 'h6', 'h24'] as const) {
      const v = n(p.volume?.[k]);
      if (v !== undefined) { vol[k] += v; seenVol[k] = true; }
    }
  }

  return {
    ...market,
    // Stays undefined when no pair reported liquidity at all, so the safety
    // engine can tell "no pool" apart from "a pool worth $0".
    liquidityUsd: sawLiq ? liq : undefined,
    pairCount: pairs.length,
    volume: {
      m5: seenVol.m5 ? vol.m5 : undefined,
      h1: seenVol.h1 ? vol.h1 : undefined,
      h6: seenVol.h6 ? vol.h6 : undefined,
      h24: seenVol.h24 ? vol.h24 : undefined,
    },
  };
}

/** Picks the pair with the deepest liquidity; falls back to highest 24h volume. */
function bestPair(pairs: DsPair[]): DsPair | undefined {
  if (pairs.length === 0) return undefined;
  return [...pairs].sort((a, b) => {
    const la = a.liquidity?.usd ?? -1;
    const lb = b.liquidity?.usd ?? -1;
    if (lb !== la) return lb - la;
    return (b.volume?.['h24'] ?? 0) - (a.volume?.['h24'] ?? 0);
  })[0];
}

export async function getMarket(chain: string, address: string): Promise<{ market: MarketData; ref: TokenRef } | null> {
  const pairs = await getJson<DsPair[] | { pairs?: DsPair[] }>(
    `${BASE}/token-pairs/v1/${encodeURIComponent(chain)}/${encodeURIComponent(address)}`,
  );
  const list = Array.isArray(pairs) ? pairs : (pairs.pairs ?? []);
  const p = bestPair(list);
  if (!p) return null;
  return {
    // Price, age and chart come from the deepest pair; depth and volume are
    // aggregated across all of them.
    market: aggregate(list, toMarket(p)),
    ref: {
      chain: p.chainId ?? chain,
      address: p.baseToken?.address ?? address,
      symbol: p.baseToken?.symbol,
      name: p.baseToken?.name,
    },
  };
}

/** Free-text search, used by `check` when the user passes a symbol rather than an address. */
export async function search(query: string): Promise<{ market: MarketData; ref: TokenRef }[]> {
  const res = await getJson<{ pairs?: DsPair[] }>(`${BASE}/latest/dex/search?q=${encodeURIComponent(query)}`);
  return (res.pairs ?? []).map((p) => ({
    market: toMarket(p),
    ref: {
      chain: p.chainId ?? '',
      address: p.baseToken?.address ?? '',
      symbol: p.baseToken?.symbol,
      name: p.baseToken?.name,
    },
  }));
}

/**
 * The discovery feed: tokens whose teams just published a DexScreener profile.
 * This is the closest thing to a free "new launches" firehose, and it skews
 * toward tokens with at least minimal effort behind them.
 */
export async function latestProfiles(): Promise<TokenRef[]> {
  const rows = await getJson<DsProfile[]>(`${BASE}/token-profiles/latest/v1`, { cacheTtlMs: 30_000 });
  const out: TokenRef[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.chainId || !r.tokenAddress) continue;
    const k = `${r.chainId}:${r.tokenAddress}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ chain: r.chainId, address: r.tokenAddress });
  }
  return out;
}

/** Boosted tokens -- paid promotion. Useful as a candidate source AND as a signal. */
export async function latestBoosts(): Promise<TokenRef[]> {
  const rows = await getJson<DsProfile[]>(`${BASE}/token-boosts/latest/v1`, { cacheTtlMs: 30_000 });
  const seen = new Set<string>();
  const out: TokenRef[] = [];
  for (const r of rows) {
    if (!r.chainId || !r.tokenAddress) continue;
    const k = `${r.chainId}:${r.tokenAddress}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ chain: r.chainId, address: r.tokenAddress });
  }
  return out;
}
