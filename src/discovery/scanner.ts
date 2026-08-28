import { config } from '../config.js';
import * as ds from '../providers/dexscreener.js';
import { pool } from '../util/http.js';
import { log } from '../util/log.js';
import type { MarketData, TokenRef } from '../types.js';

export interface ScreenOpts {
  minMarketCapUsd?: number;
  maxMarketCapUsd?: number;
  minLiquidityUsd?: number;
  minAgeMinutes?: number;
  maxAgeMinutes?: number;
  minVolume24hUsd?: number;
  chains?: string[];
  limit?: number;
}

export interface Candidate {
  ref: TokenRef;
  market: MarketData;
  /** Why it passed, for display. */
  reasons: string[];
}

export interface ScreenReport {
  candidates: Candidate[];
  examined: number;
  rejected: Record<string, number>;
}

/**
 * Screens the DexScreener discovery feeds down to the low-cap window.
 *
 * Note the liquidity rule: a pair that does not report liquidity is NOT
 * discarded, because pump.fun bonding-curve pairs legitimately omit the field
 * and those are exactly the low-cap tokens being looked for. It is carried
 * forward and the safety engine prices the missing data as risk instead.
 */
export async function screen(opts: ScreenOpts = {}): Promise<ScreenReport> {
  const d = config.discovery;
  const minMc = opts.minMarketCapUsd ?? d.minMarketCapUsd;
  const maxMc = opts.maxMarketCapUsd ?? d.maxMarketCapUsd;
  const minLiq = opts.minLiquidityUsd ?? d.minLiquidityUsd;
  const minAge = opts.minAgeMinutes ?? d.minAgeMinutes;
  const maxAge = opts.maxAgeMinutes ?? d.maxAgeMinutes;
  const minVol = opts.minVolume24hUsd ?? d.minVolume24hUsd;
  const chains = new Set(opts.chains ?? d.chains);

  const [profiles, boosts] = await Promise.all([
    ds.latestProfiles().catch((e) => { log.warn('profiles feed failed:', String(e)); return [] as TokenRef[]; }),
    ds.latestBoosts().catch(() => [] as TokenRef[]),
  ]);

  const seen = new Set<string>();
  const universe: TokenRef[] = [];
  for (const t of [...profiles, ...boosts]) {
    const k = `${t.chain}:${t.address}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (chains.size > 0 && !chains.has(t.chain)) continue;
    universe.push(t);
  }

  log.debug(`discovery universe: ${universe.length} tokens across ${[...chains].join(',')}`);

  const rejected: Record<string, number> = {};
  const bump = (k: string) => { rejected[k] = (rejected[k] ?? 0) + 1; };

  const results = await pool(universe, 6, async (t) => {
    try {
      return await ds.getMarket(t.chain, t.address);
    } catch (err) {
      log.debug(`market lookup failed for ${t.address}:`, String(err));
      return null;
    }
  });

  const candidates: Candidate[] = [];
  for (const r of results) {
    if (!r) { bump('no market data'); continue; }
    const { market: m, ref } = r;
    const reasons: string[] = [];

    const mc = m.marketCapUsd ?? m.fdvUsd;
    if (mc === undefined) { bump('no market cap'); continue; }
    if (mc < minMc) { bump(`below $${minMc} MC`); continue; }
    if (mc > maxMc) { bump(`above $${maxMc} MC`); continue; }
    reasons.push(`MC $${Math.round(mc).toLocaleString()}`);

    if (m.ageMinutes !== undefined) {
      if (m.ageMinutes < minAge) { bump('too new to have any history'); continue; }
      if (m.ageMinutes > maxAge) { bump('older than window'); continue; }
      reasons.push(m.ageMinutes < 120 ? `${m.ageMinutes.toFixed(0)}m old` : `${(m.ageMinutes / 60).toFixed(0)}h old`);
    }

    // Missing liquidity is tolerated (bonding curves); reported-but-thin is not.
    if (m.liquidityUsd !== undefined) {
      if (m.liquidityUsd < minLiq) { bump(`liquidity under $${minLiq}`); continue; }
      reasons.push(`liq $${Math.round(m.liquidityUsd).toLocaleString()}`);
    } else {
      reasons.push('liq unreported');
    }

    const v24 = m.volume.h24 ?? 0;
    if (v24 < minVol) { bump(`24h volume under $${minVol}`); continue; }
    reasons.push(`vol24 $${Math.round(v24).toLocaleString()}`);

    candidates.push({ ref, market: m, reasons });
  }

  // Lowest cap first -- that is what was asked for.
  candidates.sort((a, b) => (a.market.marketCapUsd ?? Infinity) - (b.market.marketCapUsd ?? Infinity));
  const limited = opts.limit ? candidates.slice(0, opts.limit) : candidates;

  return { candidates: limited, examined: universe.length, rejected };
}
