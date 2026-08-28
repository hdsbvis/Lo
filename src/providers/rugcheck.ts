import { getJson } from '../util/http.js';
import { emptyFacts, type TokenFacts, type HolderRow } from '../types.js';

const BASE = 'https://api.rugcheck.xyz/v1';

interface RcHolder {
  address?: string;
  owner?: string;
  pct?: number;
  insider?: boolean;
  uiAmount?: number;
}

interface RcReport {
  mint?: string;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  rugged?: boolean;
  score?: number;
  score_normalised?: number;
  totalHolders?: number;
  totalMarketLiquidity?: number;
  totalLPProviders?: number;
  creator?: string;
  creatorBalance?: number;
  launchpad?: string;
  deployPlatform?: string;
  topHolders?: RcHolder[];
  insiderNetworks?: { size?: number; tokenAmount?: number; type?: string }[];
  graphInsidersDetected?: number;
  risks?: { name?: string; description?: string; level?: string; score?: number; value?: string }[];
  markets?: {
    pubkey?: string;
    marketType?: string;
    liquidityA?: string;
    liquidityB?: string;
    lp?: { lpLockedPct?: number; lpLocked?: number; lpTotalSupply?: number; lpMint?: string };
  }[];
  tokenMeta?: { name?: string; symbol?: string; mutable?: boolean };
  token?: { supply?: number; decimals?: number };
  lockers?: Record<string, unknown>;
  verification?: { jup_verified?: boolean } | null;
  /** Address -> { name, type } for AMM pools, lockers and the creator. */
  knownAccounts?: Record<string, { name?: string; type?: string }>;
}

/**
 * RugCheck is Solana-only, but it indexes brand-new mints faster than GoPlus and
 * is the only free source here that flags insider networks (bundled wallets
 * funded from one source), which is the dominant rug pattern on pump.fun.
 */
export async function solanaReport(mint: string): Promise<TokenFacts> {
  const r = await getJson<RcReport>(`${BASE}/tokens/${encodeURIComponent(mint)}/report`);
  const f = emptyFacts();

  // RugCheck reports the authority address, or null when revoked. Absent key
  // means "not reported", which is not the same as revoked.
  if ('mintAuthority' in r) f.mintAuthorityActive = r.mintAuthority ? true : false;
  if ('freezeAuthority' in r) f.freezeAuthorityActive = r.freezeAuthority ? true : false;
  if (typeof r.rugged === 'boolean') f.rugged = r.rugged;
  if (typeof r.totalHolders === 'number') f.holderCount = r.totalHolders;
  if (r.creator) f.creatorAddress = r.creator;
  if (r.launchpad || r.deployPlatform) f.launchpad = r.launchpad || r.deployPlatform;
  if (r.tokenMeta && typeof r.tokenMeta.mutable === 'boolean') f.metadataMutable = r.tokenMeta.mutable;

  // LP lock: take the deepest market's figure.
  const lpPcts = (r.markets ?? [])
    .map((m) => m.lp?.lpLockedPct)
    .filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  if (lpPcts.length > 0) {
    f.lpLockedPct = Math.max(...lpPcts);
    f.lpBurned = f.lpLockedPct >= 99.9 ? true : 'unknown';
  }

  // Distribution.
  //
  // RugCheck's topHolders include the AMM / bonding-curve account, which on a
  // pre-migration pump.fun token holds a large share of supply. Counting that
  // as "one whale holds 32%" disqualifies almost every fresh launch for what is
  // really just the pool, so pool and locker accounts are excluded here using
  // the report's own knownAccounts labels plus the market pool addresses.
  const poolAddresses = new Set<string>();
  for (const [addr, meta] of Object.entries(r.knownAccounts ?? {})) {
    const type = (meta?.type ?? '').toUpperCase();
    if (type === 'AMM' || type === 'LOCKER' || type === 'VAULT') poolAddresses.add(addr);
  }
  for (const mk of r.markets ?? []) {
    for (const a of [mk.pubkey, mk.liquidityA, mk.liquidityB]) if (a) poolAddresses.add(a);
  }
  // The creator's own bag is NOT excluded -- that is a real, sellable position.
  const creatorAddresses = new Set<string>(
    Object.entries(r.knownAccounts ?? {})
      .filter(([, m]) => (m?.type ?? '').toUpperCase() === 'CREATOR')
      .map(([a]) => a),
  );

  const rows: HolderRow[] = [];
  const eligible: number[] = [];
  let insiderSum = 0;
  let creatorHeld = 0;

  for (const h of r.topHolders ?? []) {
    if (typeof h.pct !== 'number' || !Number.isFinite(h.pct)) continue;
    const isPool = (h.address && poolAddresses.has(h.address)) || (h.owner && poolAddresses.has(h.owner));
    rows.push({
      address: h.address ?? '',
      owner: h.owner,
      pct: h.pct,
      isInsider: h.insider === true,
      tag: isPool ? 'pool' : undefined,
    });
    if (isPool) continue;
    eligible.push(h.pct);
    if (h.insider) insiderSum += h.pct;
    if ((h.address && creatorAddresses.has(h.address)) || (h.owner && creatorAddresses.has(h.owner))) {
      creatorHeld += h.pct;
    }
  }

  if (rows.length > 0) f.topHolders = rows;
  if (eligible.length > 0) {
    eligible.sort((a, b) => b - a);
    f.topHolderPct = eligible[0]!;
    f.top10Pct = eligible.slice(0, 10).reduce((a, b) => a + b, 0);
    f.insiderPct = insiderSum;
  }
  if (creatorHeld > 0) f.creatorPct = creatorHeld;

  const insiderNetworkSize = (r.insiderNetworks ?? []).reduce((a, x) => a + (x.size ?? 0), 0);
  if (r.insiderNetworks !== undefined || r.graphInsidersDetected !== undefined) {
    f.insiderNetworkDetected = insiderNetworkSize > 0 || (r.graphInsidersDetected ?? 0) > 0;
    f.insiderNetworkSize = Math.max(insiderNetworkSize, r.graphInsidersDetected ?? 0);
  }

  if (f.creatorPct === 'unknown' && typeof r.creatorBalance === 'number' && r.token?.supply) {
    const supply = r.token.supply;
    if (supply > 0) f.creatorPct = (r.creatorBalance / supply) * 100;
  }

  // RugCheck's own named risks fill gaps the structured fields miss.
  for (const risk of r.risks ?? []) {
    const name = (risk.name ?? '').toLowerCase();
    if (name.includes('honeypot')) f.honeypot = true;
    if (name.includes('freeze') && name.includes('enabled')) f.freezeAuthorityActive = true;
    if (name.includes('mint') && name.includes('authority')) f.mintAuthorityActive = true;
    if (name.includes('transfer fee')) {
      const v = Number((risk.value ?? '').replace('%', ''));
      if (Number.isFinite(v)) f.transferFeePct = v;
    }
  }

  return f;
}

/** RugCheck's own 0-100 normalised risk score, kept separate from ours. */
export async function solanaScore(mint: string): Promise<number | null> {
  try {
    const r = await getJson<{ score_normalised?: number }>(
      `${BASE}/tokens/${encodeURIComponent(mint)}/report/summary`,
    );
    return typeof r.score_normalised === 'number' ? r.score_normalised : null;
  } catch {
    return null;
  }
}
