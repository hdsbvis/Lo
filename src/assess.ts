import * as ds from './providers/dexscreener.js';
import { gatherFacts } from './safety/facts.js';
import { score, toSnapshot } from './safety/engine.js';
import { assessSocial, type SocialMode } from './social/index.js';
import * as store from './store/snapshots.js';
import { emptyFacts, type TokenAssessment, type TokenRef, type MarketData } from './types.js';
import { log } from './util/log.js';

export interface AssessOpts {
  social?: SocialMode;
  /** Persist a snapshot so the next run can detect adverse changes. */
  persist?: boolean;
  /** Pre-fetched market data, to avoid a second lookup during a scan. */
  market?: MarketData;
}

/**
 * Full assessment for one token: market data, merged security facts, the safety
 * score with its volatility adjustments, and social attribution.
 *
 * Ordering matters. Social runs after facts because the classifier needs the
 * top-holder list to tell a whale who bought from a whale who is only posting.
 */
export async function assessToken(ref: TokenRef, opts: AssessOpts = {}): Promise<TokenAssessment> {
  let market = opts.market;
  let resolved = ref;

  if (!market) {
    const m = await ds.getMarket(ref.chain, ref.address).catch((e) => {
      log.debug('market lookup failed:', String(e));
      return null;
    });
    if (m) { market = m.market; resolved = { ...m.ref, ...(ref.symbol ? { symbol: ref.symbol } : {}) }; }
  }

  if (!market) {
    // No pair at all: nothing trades, so there is nothing to assess and no
    // basis for a score. Say so rather than emitting a number.
    market = { volume: {}, priceChange: {}, txns: {}, socials: [] };
  }

  const bundle = await gatherFacts(resolved).catch((e) => {
    log.debug('fact gathering failed:', String(e));
    return { facts: emptyFacts(), providers: [], fetchedAt: Date.now() };
  });

  const social = await assessSocial(resolved, bundle.facts.topHolders, opts.social ?? 'auto')
    .catch((e) => {
      log.debug('social assessment failed:', String(e));
      return {
        status: 'UNAVAILABLE' as const, note: String(e), mentions: [], topTier: null,
        coordinated: null, safetyAdjustment: 4, summary: `Social attribution failed: ${String(e)}`,
      };
    });

  const prev = store.latest(resolved.chain, resolved.address);
  const safety = score({
    ref: resolved,
    facts: bundle.facts,
    market,
    providers: bundle.providers,
    fetchedAt: bundle.fetchedAt,
    prev,
    social,
  });

  if (opts.persist !== false) {
    store.append(toSnapshot(resolved, market, bundle.facts, safety, social.mentions.length));
  }

  return { token: resolved, market, facts: bundle.facts, safety, social };
}

/** Resolves a user-supplied string (address or symbol) to a concrete token. */
export async function resolveToken(query: string, chainHint?: string): Promise<TokenRef | null> {
  const looksLikeAddress = /^0x[a-fA-F0-9]{40}$/.test(query) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(query);
  if (looksLikeAddress) {
    const chains = chainHint ? [chainHint] : /^0x/.test(query)
      ? ['ethereum', 'base', 'bsc', 'arbitrum', 'polygon']
      : ['solana'];
    for (const c of chains) {
      const m = await ds.getMarket(c, query).catch(() => null);
      if (m) return m.ref;
    }
    // Unindexed address: still return it so security providers can be tried.
    return { chain: chainHint ?? (/^0x/.test(query) ? 'ethereum' : 'solana'), address: query };
  }

  const hits = await ds.search(query).catch(() => []);
  const filtered = chainHint ? hits.filter((h) => h.ref.chain === chainHint) : hits;
  if (filtered.length === 0) return null;
  // Deepest liquidity wins; a symbol search on a memecoin returns dozens of
  // impersonators and the deepest pool is the least-bad disambiguation.
  filtered.sort((a, b) => (b.market.liquidityUsd ?? 0) - (a.market.liquidityUsd ?? 0));
  return filtered[0]!.ref;
}
