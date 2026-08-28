import { getJson } from '../util/http.js';
import { EVM_CHAIN_IDS, type TokenFacts, type Tri, type HolderRow } from '../types.js';
import { emptyFacts } from '../types.js';

const BASE = 'https://api.gopluslabs.io/api/v1';

/** GoPlus encodes booleans as the strings "0" / "1", and omits keys it cannot determine. */
const tri = (v: unknown): Tri => (v === '1' || v === 1 ? true : v === '0' || v === 0 ? false : 'unknown');
const pct = (v: unknown): number | 'unknown' => {
  if (v === undefined || v === null || v === '') return 'unknown';
  const x = Number(v);
  return Number.isFinite(x) ? x * 100 : 'unknown'; // GoPlus taxes are fractions ("0.05")
};
const rawNum = (v: unknown): number | 'unknown' => {
  if (v === undefined || v === null || v === '') return 'unknown';
  const x = Number(v);
  return Number.isFinite(x) ? x : 'unknown';
};

const BURN_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '11111111111111111111111111111111',
  '1nc1nerator11111111111111111111111111111111',
]);

const LOCK_TAG = /burn|lock|dead|null|incinerat|vest/i;

interface GpHolder {
  address?: string;
  tag?: string;
  is_contract?: number;
  balance?: string;
  percent?: string;
  is_locked?: number;
}

/**
 * Largest holder that is not LP, not a burn address and not a tagged locker.
 * Counting the LP pool or the burn address as "the whale" is the classic way to
 * produce a false rug alert, and skipping the exclusion the classic way to miss
 * a real one.
 */
/**
 * Holder concentration, with pool/burn/locker balances excluded.
 *
 * `canExcludePools` must be false whenever the caller cannot actually identify
 * the pool accounts in this response. On Solana, GoPlus returns holder rows
 * with no address and a null lp_holders list, so the largest "holder" on a
 * pre-migration pump.fun token is the bonding curve -- reporting that as a 31%
 * whale disqualifies almost every fresh launch. When the pool cannot be
 * identified the honest answer is "unknown", which the safety engine already
 * prices as risk.
 */
function distribution(holders: GpHolder[], lpAddresses: Set<string>, canExcludePools: boolean): {
  top: number | 'unknown'; top10: number | 'unknown'; rows: HolderRow[];
} {
  const isExcluded = (h: GpHolder): boolean => {
    const addr = (h.address ?? '').toLowerCase();
    return BURN_ADDRESSES.has(addr) || lpAddresses.has(addr) ||
      h.is_locked === 1 || LOCK_TAG.test(h.tag ?? '');
  };

  const rows: HolderRow[] = [];
  const eligible: number[] = [];
  for (const h of holders) {
    if (!h.address) continue;
    const p = Number(h.percent);
    if (!Number.isFinite(p)) continue;
    const percent = p * 100;
    rows.push({ address: h.address, pct: percent, isContract: h.is_contract === 1, tag: h.tag });
    if (!isExcluded(h)) eligible.push(percent);
  }

  if (eligible.length === 0 || !canExcludePools) return { top: 'unknown', top10: 'unknown', rows };
  eligible.sort((a, b) => b - a);
  return {
    top: eligible[0]!,
    top10: eligible.slice(0, 10).reduce((a, b) => a + b, 0),
    rows,
  };
}

/** Fraction of LP tokens held at burn/locked addresses. */
function lpLocked(lpHolders: GpHolder[]): { pctLocked: number | 'unknown'; burned: Tri } {
  if (!lpHolders || lpHolders.length === 0) return { pctLocked: 'unknown', burned: 'unknown' };
  let locked = 0;
  let total = 0;
  let burned = false;
  for (const h of lpHolders) {
    const p = Number(h.percent);
    if (!Number.isFinite(p)) continue;
    total += p;
    const addr = (h.address ?? '').toLowerCase();
    const isBurn = BURN_ADDRESSES.has(addr);
    if (isBurn) burned = true;
    if (isBurn || h.is_locked === 1 || LOCK_TAG.test(h.tag ?? '')) locked += p;
  }
  if (total <= 0) return { pctLocked: 'unknown', burned: 'unknown' };
  return { pctLocked: (locked / total) * 100, burned: burned ? true : false };
}

export async function evmSecurity(chain: string, address: string): Promise<TokenFacts> {
  const chainId = EVM_CHAIN_IDS[chain];
  if (!chainId) throw new Error(`GoPlus has no EVM chain id for "${chain}"`);
  const res = await getJson<{ code?: number; message?: string; result?: Record<string, any> }>(
    `${BASE}/token_security/${chainId}?contract_addresses=${address.toLowerCase()}`,
  );
  if (res.code !== 1) throw new Error(`GoPlus: ${res.message ?? 'non-ok code ' + res.code}`);
  const r = res.result?.[address.toLowerCase()] ?? Object.values(res.result ?? {})[0];
  if (!r) throw new Error('GoPlus returned no record for this token');

  const f = emptyFacts();
  const lpAddresses = new Set<string>(
    (r.lp_holders ?? []).map((h: GpHolder) => (h.address ?? '').toLowerCase()).filter(Boolean),
  );

  f.honeypot = tri(r.is_honeypot);
  f.cannotSell = tri(r.cannot_sell_all);
  f.buyTaxPct = pct(r.buy_tax);
  f.sellTaxPct = pct(r.sell_tax);
  f.mintAuthorityActive = tri(r.is_mintable);
  f.ownerCanTakeBack = tri(r.can_take_back_ownership);
  f.hiddenOwner = tri(r.hidden_owner);
  f.transferPausable = tri(r.transfer_pausable);
  f.blacklistCapable = tri(r.is_blacklisted);
  f.isProxy = tri(r.is_proxy);
  f.selfdestruct = tri(r.selfdestruct);
  f.creatorPriorHoneypot = tri(r.honeypot_with_same_creator);
  f.creatorPct = r.creator_percent !== undefined ? pct(r.creator_percent) : 'unknown';
  f.holderCount = rawNum(r.holder_count);
  f.creatorAddress = r.creator_address;
  // EVM tokens have no freeze/close authority concept; leave as unknown rather
  // than claiming a clean result the chain cannot express.

  const lp = lpLocked(r.lp_holders ?? []);
  f.lpLockedPct = lp.pctLocked;
  f.lpBurned = lp.burned;

  const evmHolders: GpHolder[] = r.holders ?? [];
  const dist = distribution(evmHolders, lpAddresses, evmHolders.every((h) => Boolean(h.address)));
  f.topHolderPct = dist.top;
  f.top10Pct = dist.top10;
  f.topHolders = dist.rows;

  return f;
}

export async function solanaSecurity(address: string): Promise<TokenFacts> {
  const res = await getJson<{ code?: number; message?: string; result?: Record<string, any> }>(
    `${BASE}/solana/token_security?contract_addresses=${address}`,
  );
  if (res.code !== 1) throw new Error(`GoPlus: ${res.message ?? 'non-ok code ' + res.code}`);
  const r = res.result?.[address] ?? Object.values(res.result ?? {})[0];
  if (!r) throw new Error('GoPlus returned no record for this mint');

  const f = emptyFacts();
  // Solana blocks are shaped { authority: [...], status: "0"|"1" }.
  const authActive = (block: any): Tri => {
    if (!block || typeof block !== 'object') return 'unknown';
    if (block.status === '1' || block.status === 1) return true;
    if (block.status === '0' || block.status === 0) return false;
    if (Array.isArray(block.authority)) return block.authority.length > 0;
    return 'unknown';
  };

  f.mintAuthorityActive = authActive(r.mintable);
  f.freezeAuthorityActive = authActive(r.freezable);
  f.closeAuthorityActive = authActive(r.closable);
  f.balanceMutableAuthority = authActive(r.balance_mutable_authority);
  f.metadataMutable = authActive(r.metadata_mutable);
  f.transferHook = Array.isArray(r.transfer_hook)
    ? r.transfer_hook.length > 0
    : authActive(r.transfer_hook);
  f.transferHookUpgradable = authActive(r.transfer_hook_upgradable);
  f.transferFeeUpgradable = authActive(r.transfer_fee_upgradable);
  f.holderCount = rawNum(r.holder_count);

  if (r.transfer_fee && typeof r.transfer_fee === 'object') {
    const bp = Number(r.transfer_fee.fee_rate ?? r.transfer_fee.transfer_fee_rate);
    f.transferFeePct = Number.isFinite(bp) ? bp * 100 : 'unknown';
  }
  if (Array.isArray(r.creators) && r.creators.length > 0) {
    f.creatorAddress = r.creators[0]?.address;
  }

  const solHolders: GpHolder[] = r.holders ?? [];
  const lpHolders: GpHolder[] = r.lp_holders ?? [];
  const lpAddresses = new Set<string>(
    lpHolders.map((h) => (h.address ?? '').toLowerCase()).filter(Boolean),
  );
  const lp = lpLocked(lpHolders);
  f.lpLockedPct = lp.pctLocked;
  f.lpBurned = lp.burned;

  // Requires both addressable holders and a known pool set; otherwise the
  // bonding curve is indistinguishable from a whale. RugCheck covers Solana
  // concentration properly via its knownAccounts labels.
  const canExclude = solHolders.length > 0 && solHolders.every((h) => Boolean(h.address)) && lpAddresses.size > 0;
  const dist = distribution(solHolders, lpAddresses, canExclude);
  f.topHolderPct = dist.top;
  f.top10Pct = dist.top10;
  f.topHolders = dist.rows;

  return f;
}

export function supportsChain(chain: string): boolean {
  return chain === 'solana' || chain in EVM_CHAIN_IDS;
}
