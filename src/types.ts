/**
 * Core domain types.
 *
 * The single most important decision in this file is `Tri`. Every security fact
 * is tri-state: true / false / "unknown". A provider that is down, rate-limited,
 * or has not indexed a 3-minute-old token yields "unknown" -- never `false`.
 * Collapsing "unknown" into "false" is how a scanner tells you a honeypot is
 * clean, so nothing in this codebase is allowed to do it.
 */

export type Tri = true | false | 'unknown';

export const isKnown = <T>(v: T | 'unknown'): v is T => v !== 'unknown';

export type Chain = 'solana' | 'ethereum' | 'base' | 'bsc' | 'arbitrum' | 'polygon';

/** DexScreener chain slug -> GoPlus EVM chain id. Solana has its own endpoint. */
export const EVM_CHAIN_IDS: Record<string, string> = {
  ethereum: '1',
  bsc: '56',
  polygon: '137',
  arbitrum: '42161',
  base: '8453',
  optimism: '10',
  avalanche: '43114',
};

export interface TokenRef {
  chain: string;
  address: string;
  symbol?: string;
  name?: string;
}

/** Market data from DexScreener. All fields optional -- pump.fun pairs omit liquidity. */
export interface MarketData {
  pairAddress?: string;
  dexId?: string;
  url?: string;
  priceUsd?: number;
  marketCapUsd?: number;
  fdvUsd?: number;
  /** Summed across every pair for this token, not just the deepest one. */
  liquidityUsd?: number;
  /** How many pairs the aggregate covers. */
  pairCount?: number;
  /** ms epoch */
  pairCreatedAt?: number;
  ageMinutes?: number;
  volume: { m5?: number; h1?: number; h6?: number; h24?: number };
  priceChange: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns: { m5?: Txns; h1?: Txns; h24?: Txns };
  socials: Social[];
  /** Whether the team paid DexScreener for enhanced info -- weak positive signal. */
  boosted?: boolean;
}

export interface Txns { buys: number; sells: number }
export interface Social { type: string; url: string }

/**
 * Normalized security facts, merged from every provider that answered.
 * Anything a provider did not tell us stays "unknown".
 */
export interface TokenFacts {
  // --- hard rug primitives ---
  honeypot: Tri;
  cannotSell: Tri;
  buyTaxPct: number | 'unknown';
  sellTaxPct: number | 'unknown';

  // --- authority / control ---
  mintAuthorityActive: Tri;
  freezeAuthorityActive: Tri;
  /** Solana: account close authority. Can nuke holder accounts. */
  closeAuthorityActive: Tri;
  /** Solana: authority able to rewrite balances directly. */
  balanceMutableAuthority: Tri;
  ownerCanTakeBack: Tri;
  hiddenOwner: Tri;
  transferPausable: Tri;
  blacklistCapable: Tri;
  isProxy: Tri;
  selfdestruct: Tri;
  metadataMutable: Tri;
  /** Token-2022 transfer hook -- arbitrary code on every transfer. */
  transferHook: Tri;
  transferHookUpgradable: Tri;
  transferFeePct: number | 'unknown';
  transferFeeUpgradable: Tri;

  // --- liquidity ---
  lpLockedPct: number | 'unknown';
  lpBurned: Tri;

  // --- distribution ---
  /** Largest non-LP, non-locker, non-burn holder, as pct of supply. */
  topHolderPct: number | 'unknown';
  top10Pct: number | 'unknown';
  creatorPct: number | 'unknown';
  insiderPct: number | 'unknown';
  insiderNetworkDetected: Tri;
  /** Number of accounts in the largest linked-wallet cluster. */
  insiderNetworkSize: number | 'unknown';
  holderCount: number | 'unknown';

  // --- provenance ---
  rugged: Tri;
  creatorAddress?: string;
  launchpad?: string;
  /** Same creator has shipped a honeypot before. */
  creatorPriorHoneypot: Tri;
  /** Raw top-holder list, used to cross-check roster whale wallets. */
  topHolders: HolderRow[];
}

export interface HolderRow {
  address: string;
  /** Owner wallet where the provider distinguishes it from the token account. */
  owner?: string;
  pct: number;
  isContract?: boolean;
  isInsider?: boolean;
  tag?: string;
}

export function emptyFacts(): TokenFacts {
  return {
    honeypot: 'unknown', cannotSell: 'unknown',
    buyTaxPct: 'unknown', sellTaxPct: 'unknown',
    mintAuthorityActive: 'unknown', freezeAuthorityActive: 'unknown',
    closeAuthorityActive: 'unknown', balanceMutableAuthority: 'unknown',
    ownerCanTakeBack: 'unknown', hiddenOwner: 'unknown',
    transferPausable: 'unknown', blacklistCapable: 'unknown',
    isProxy: 'unknown', selfdestruct: 'unknown', metadataMutable: 'unknown',
    transferHook: 'unknown', transferHookUpgradable: 'unknown',
    transferFeePct: 'unknown', transferFeeUpgradable: 'unknown',
    lpLockedPct: 'unknown', lpBurned: 'unknown',
    topHolderPct: 'unknown', top10Pct: 'unknown', creatorPct: 'unknown',
    insiderPct: 'unknown', insiderNetworkDetected: 'unknown',
    insiderNetworkSize: 'unknown',
    holderCount: 'unknown', rugged: 'unknown',
    creatorPriorHoneypot: 'unknown', topHolders: [],
  };
}

/** Which providers actually answered. Drives the confidence cap. */
export interface ProviderReport {
  name: string;
  ok: boolean;
  /** ms epoch of the response */
  at: number;
  error?: string;
  /** Count of non-unknown facts contributed. */
  factsContributed?: number;
}

export type Severity = 'veto' | 'critical' | 'high' | 'medium' | 'low' | 'info' | 'positive';

export interface Signal {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  /** Penalty points for non-veto signals; negative values are credits. */
  weight: number;
}

export type Verdict = 'AVOID' | 'DANGER' | 'HIGH_RISK' | 'ELEVATED_RISK' | 'WATCH' | 'UNRATED';

export interface SafetyResult {
  /** 0-100. Higher is less bad. Never "safe". */
  score: number;
  /** Score before the volatility ratchet and staleness decay. */
  rawScore: number;
  verdict: Verdict;
  /** 0-1. How much independent corroboration is behind the score. */
  confidence: number;
  vetoes: Signal[];
  signals: Signal[];
  providers: ProviderReport[];
  /** Adverse changes vs the previous snapshot. */
  shocks: Shock[];
  computedAt: number;
  /** Age of the oldest input the score depends on, in seconds. */
  dataAgeSec: number;
}

export interface Shock {
  id: string;
  title: string;
  detail: string;
  /** Multiplier applied to the score, 0-1. */
  multiplier: number;
}

// ---------------- social ----------------

export type WhaleTier = 'WHALE' | 'KOL' | 'ALPHA' | 'RETAIL' | 'NOBODY' | 'BOT';

export interface RosterEntry {
  handle: string;
  tier: WhaleTier;
  followers?: number;
  note?: string;
  /** On-chain wallets, used to check whether they actually bought. */
  wallets?: string[];
  /** Historical hit rate if you choose to track it, 0-1. */
  trackRecord?: number;
}

export interface Mention {
  id: string;
  handle: string;
  text: string;
  createdAt: number;
  followers?: number;
  following?: number;
  accountCreatedAt?: number;
  verified?: boolean;
  postCount?: number;
  url?: string;
}

export interface ScoredMention {
  mention: Mention;
  tier: WhaleTier;
  credibility: number;
  reasons: string[];
  /** Roster wallet of this handle found in the token's top holders. */
  holdsToken?: { wallet: string; pct: number };
}

export type SocialStatus = 'OK' | 'UNAVAILABLE' | 'NO_MENTIONS';

export interface SocialResult {
  status: SocialStatus;
  /** Why the data is missing, when status !== OK. Shown verbatim to the user. */
  note?: string;
  mentions: ScoredMention[];
  topTier: WhaleTier | null;
  /** Coordinated near-identical posting detected across accounts. */
  coordinated: CoordinationReport | null;
  /** Penalty/credit handed to the safety engine. */
  safetyAdjustment: number;
  summary: string;
}

export interface CoordinationReport {
  clusterSize: number;
  windowMinutes: number;
  medianSimilarity: number;
  handles: string[];
}

export interface TokenAssessment {
  token: TokenRef;
  market: MarketData;
  facts: TokenFacts;
  safety: SafetyResult;
  social: SocialResult;
}

/** One persisted point in a token's history, used for shock detection. */
export interface Snapshot {
  at: number;
  chain: string;
  address: string;
  score: number;
  rawScore: number;
  verdict: Verdict;
  marketCapUsd?: number;
  liquidityUsd?: number;
  topHolderPct?: number | 'unknown';
  lpLockedPct?: number | 'unknown';
  mintAuthorityActive?: Tri;
  freezeAuthorityActive?: Tri;
  holderCount?: number | 'unknown';
  socialCount?: number;
}
