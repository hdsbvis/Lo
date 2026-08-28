import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Minimal .env loader -- avoids a dependency for six variables. */
function loadDotEnv(): void {
  const p = resolve(process.cwd(), '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let val = (m[2] ?? '').trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

const num = (k: string, d: number): number => {
  const v = process.env[k];
  if (v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export const config = {
  solanaRpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  xBearerToken: process.env.X_BEARER_TOKEN || '',
  port: num('PORT', 8787),

  discovery: {
    /** Default market-cap window for "low MC". Overridable per invocation. */
    minMarketCapUsd: num('DISCOVERY_MIN_MC', 5_000),
    maxMarketCapUsd: num('DISCOVERY_MAX_MC', 300_000),
    minLiquidityUsd: num('DISCOVERY_MIN_LIQ', 3_000),
    minAgeMinutes: num('DISCOVERY_MIN_AGE_MIN', 5),
    maxAgeMinutes: num('DISCOVERY_MAX_AGE_MIN', 60 * 72),
    minVolume24hUsd: num('DISCOVERY_MIN_VOL', 5_000),
    chains: (process.env.DISCOVERY_CHAINS || 'solana,base,ethereum,bsc').split(','),
  },

  safety: {
    maxTopHolderPct: num('SAFETY_MAX_TOP_HOLDER_PCT', 25),
    maxTop10Pct: num('SAFETY_MAX_TOP10_PCT', 60),
    maxSellTaxPct: num('SAFETY_MAX_SELL_TAX_PCT', 15),
    maxBuyTaxPct: num('SAFETY_MAX_BUY_TAX_PCT', 15),
    minLpLockedPct: num('SAFETY_MIN_LP_LOCKED_PCT', 90),
    maxCreatorPct: num('SAFETY_MAX_CREATOR_PCT', 15),
    maxInsiderPct: num('SAFETY_MAX_INSIDER_PCT', 25),
    minHolderCount: num('SAFETY_MIN_HOLDERS', 50),
    /** Security data older than this starts decaying the score toward zero. */
    maxDataAgeSec: num('SAFETY_MAX_DATA_AGE_SEC', 300),

    /**
     * Asymmetric ratchet. The score may climb at most this many points per
     * minute of sustained clean readings, but any drop applies in full,
     * immediately. Trust is earned slowly and lost at once.
     */
    riseCapPerMinute: num('SAFETY_RISE_CAP_PER_MIN', 2),

    /** Score bands. A token never reaches a band called "safe". */
    bands: { watch: 75, elevated: 55, high: 35, danger: 15 },

    /** Confidence caps: with N corroborating providers, the score cannot exceed. */
    confidenceCaps: [25, 60, 85, 100] as const,
  },

  shocks: {
    /** Liquidity fall (fraction) vs previous snapshot that counts as a drain. */
    liquidityDropFrac: num('SHOCK_LIQ_DROP', 0.35),
    /** Absolute pct-point jump in the top holder's share. */
    topHolderJumpPct: num('SHOCK_TOPHOLDER_JUMP', 5),
    /** Holder count falling this fraction implies mass exit. */
    holderDropFrac: num('SHOCK_HOLDER_DROP', 0.2),
  },

  social: {
    /**
     * Overlap-coefficient threshold above which two posts count as the same
     * script. 0.75 sits in the gap measured between spun duplicates (0.78+)
     * and unrelated posts (0.40 and below).
     */
    similarityThreshold: num('SOCIAL_SIMILARITY', 0.75),
    /** Accounts posting near-identical text inside this window = coordinated. */
    coordinationWindowMinutes: num('SOCIAL_COORD_WINDOW_MIN', 60),
    minClusterSize: num('SOCIAL_MIN_CLUSTER', 3),
    /** Below this follower count an unrostered account is treated as noise. */
    nobodyFollowerCeiling: num('SOCIAL_NOBODY_FOLLOWERS', 2_000),
    whaleFollowerFloor: num('SOCIAL_WHALE_FOLLOWERS', 250_000),
  },

  http: {
    timeoutMs: num('HTTP_TIMEOUT_MS', 15_000),
    retries: num('HTTP_RETRIES', 2),
    cacheTtlMs: num('HTTP_CACHE_TTL_MS', 20_000),
  },
} as const;

export type Config = typeof config;
