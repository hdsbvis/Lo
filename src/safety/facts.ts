import { emptyFacts, type TokenFacts, type Tri, type ProviderReport, type TokenRef } from '../types.js';
import { EVM_CHAIN_IDS } from '../types.js';
import * as goplus from '../providers/goplus.js';
import * as rugcheck from '../providers/rugcheck.js';
import * as solanaRpc from '../providers/solanaRpc.js';
import { log } from '../util/log.js';

/**
 * Fields where the chain itself is the last word. If the on-chain read
 * disagrees with a cached API, the chain wins -- an authority reinstated
 * minutes ago appears here first and in the API much later, if ever.
 */
const CHAIN_AUTHORITATIVE = new Set<keyof TokenFacts>([
  'mintAuthorityActive', 'freezeAuthorityActive', 'transferHook', 'transferFeePct',
]);

/**
 * Danger-biased merge: for a boolean risk flag, one provider saying "yes" beats
 * any number saying "no". A honeypot detector that only fires on consensus is a
 * honeypot detector that misses honeypots.
 */
function mergeTri(a: Tri, b: Tri): Tri {
  if (a === true || b === true) return true;
  if (a === false || b === false) return false;
  return 'unknown';
}

/** For numeric risk quantities, keep the worse (higher) reading. */
function mergeWorseNum(a: number | 'unknown', b: number | 'unknown'): number | 'unknown' {
  if (a === 'unknown') return b;
  if (b === 'unknown') return a;
  return Math.max(a, b);
}

/** For protective quantities (LP locked), keep the lower -- the less flattering one. */
function mergeBetterIsHigher(a: number | 'unknown', b: number | 'unknown'): number | 'unknown' {
  if (a === 'unknown') return b;
  if (b === 'unknown') return a;
  return Math.min(a, b);
}

const RISK_TRI: (keyof TokenFacts)[] = [
  'honeypot', 'cannotSell', 'mintAuthorityActive', 'freezeAuthorityActive',
  'closeAuthorityActive', 'balanceMutableAuthority', 'ownerCanTakeBack', 'hiddenOwner',
  'transferPausable', 'blacklistCapable', 'isProxy', 'selfdestruct', 'metadataMutable',
  'transferHook', 'transferHookUpgradable', 'transferFeeUpgradable',
  'insiderNetworkDetected', 'rugged', 'creatorPriorHoneypot',
];

const RISK_NUM: (keyof TokenFacts)[] = [
  'buyTaxPct', 'sellTaxPct', 'topHolderPct', 'top10Pct', 'creatorPct',
  'insiderPct', 'transferFeePct', 'insiderNetworkSize',
];

function countKnown(f: TokenFacts): number {
  let n = 0;
  for (const k of [...RISK_TRI, ...RISK_NUM, 'lpLockedPct', 'lpBurned', 'holderCount'] as (keyof TokenFacts)[]) {
    if (f[k] !== 'unknown') n++;
  }
  return n;
}

function mergeInto(base: TokenFacts, add: TokenFacts, authoritative: boolean): void {
  for (const k of RISK_TRI) {
    const cur = base[k] as Tri;
    const nxt = add[k] as Tri;
    if (authoritative && CHAIN_AUTHORITATIVE.has(k) && nxt !== 'unknown') {
      (base as any)[k] = nxt;
    } else {
      (base as any)[k] = mergeTri(cur, nxt);
    }
  }
  for (const k of RISK_NUM) {
    const cur = base[k] as number | 'unknown';
    const nxt = add[k] as number | 'unknown';
    if (authoritative && CHAIN_AUTHORITATIVE.has(k) && nxt !== 'unknown') {
      (base as any)[k] = nxt;
    } else {
      (base as any)[k] = mergeWorseNum(cur, nxt);
    }
  }
  base.lpLockedPct = mergeBetterIsHigher(base.lpLockedPct, add.lpLockedPct);
  base.lpBurned = base.lpBurned === true || add.lpBurned === true
    ? true
    : mergeTri(base.lpBurned, add.lpBurned);
  base.holderCount = base.holderCount === 'unknown'
    ? add.holderCount
    : add.holderCount === 'unknown' ? base.holderCount
    : Math.min(base.holderCount, add.holderCount);

  if (!base.creatorAddress && add.creatorAddress) base.creatorAddress = add.creatorAddress;
  if (!base.launchpad && add.launchpad) base.launchpad = add.launchpad;
  // Prefer the richest holder list, and one that carries insider tags.
  const addHasInsider = add.topHolders.some((h) => h.isInsider !== undefined);
  const baseHasInsider = base.topHolders.some((h) => h.isInsider !== undefined);
  if (add.topHolders.length > 0 && (base.topHolders.length === 0 || (addHasInsider && !baseHasInsider))) {
    base.topHolders = add.topHolders;
  }
}

export interface FactsBundle {
  facts: TokenFacts;
  providers: ProviderReport[];
  /** Newest input timestamp, ms. */
  fetchedAt: number;
}

/**
 * Gathers every provider that supports the chain, in parallel, and merges them.
 * A provider that throws is recorded as failed -- it contributes no facts, and
 * its absence lowers confidence rather than silently passing the token.
 */
export async function gatherFacts(ref: TokenRef): Promise<FactsBundle> {
  const chain = ref.chain;
  const tasks: { name: string; authoritative: boolean; run: () => Promise<TokenFacts> }[] = [];

  if (chain === 'solana') {
    tasks.push({ name: 'solana-rpc', authoritative: true, run: () => solanaRpc.solanaChainFacts(ref.address) });
    tasks.push({ name: 'rugcheck', authoritative: false, run: () => rugcheck.solanaReport(ref.address) });
    tasks.push({ name: 'goplus', authoritative: false, run: () => goplus.solanaSecurity(ref.address) });
  } else if (chain in EVM_CHAIN_IDS) {
    tasks.push({ name: 'goplus', authoritative: false, run: () => goplus.evmSecurity(chain, ref.address) });
  }

  const settled = await Promise.all(
    tasks.map(async (t) => {
      const started = Date.now();
      try {
        const facts = await t.run();
        return { t, facts, report: { name: t.name, ok: true, at: Date.now(), factsContributed: countKnown(facts) } as ProviderReport };
      } catch (err) {
        log.debug(`provider ${t.name} failed:`, String(err));
        return {
          t, facts: null,
          report: { name: t.name, ok: false, at: started, error: String(err instanceof Error ? err.message : err) } as ProviderReport,
        };
      }
    }),
  );

  const merged = emptyFacts();
  // Non-authoritative first, so chain reads overwrite rather than get merged away.
  for (const s of settled) if (s.facts && !s.t.authoritative) mergeInto(merged, s.facts, false);
  for (const s of settled) if (s.facts && s.t.authoritative) mergeInto(merged, s.facts, true);

  const oks = settled.filter((s) => s.facts);
  return {
    facts: merged,
    providers: settled.map((s) => s.report),
    fetchedAt: oks.length > 0 ? Math.max(...oks.map((s) => s.report.at)) : Date.now(),
  };
}

export const _internal = { mergeTri, mergeWorseNum, mergeBetterIsHigher, mergeInto, countKnown };
