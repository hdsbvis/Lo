import type { HolderRow, SocialResult, TokenRef } from '../types.js';
import { analyze } from './classify.js';
import { loadRoster, type Roster } from './roster.js';
import { ManualFetcher } from './fetchers/manual.js';
import { XApiFetcher } from './fetchers/xapi.js';
import type { MentionFetcher } from './fetchers/types.js';

export type SocialMode = 'auto' | 'manual' | 'x-api' | 'off';

let cachedRoster: Roster | undefined;
export function roster(): Roster {
  if (!cachedRoster) cachedRoster = loadRoster();
  return cachedRoster;
}

/**
 * Picks a mention source.
 *
 * Deliberately absent: an X scraper. Nitter is dead (the public instances
 * return 410 or do not resolve) and reader proxies hit X's login wall, which
 * yields profile chrome and no timeline. A fetcher that silently returns zero
 * posts is worse than no fetcher, because "no whales are talking" and "we could
 * not look" are opposite conclusions and the app must not confuse them.
 */
export function pickFetcher(mode: SocialMode): MentionFetcher | null {
  const x = new XApiFetcher();
  const manual = new ManualFetcher();
  switch (mode) {
    case 'off': return null;
    case 'x-api': return x;
    case 'manual': return manual;
    case 'auto': return x.available() ? x : manual;
  }
}

export async function assessSocial(
  ref: TokenRef, topHolders: HolderRow[], mode: SocialMode = 'auto',
): Promise<SocialResult> {
  if (mode === 'off') {
    return {
      status: 'UNAVAILABLE', note: 'social checks disabled (--social=off)',
      mentions: [], topTier: null, coordinated: null,
      safetyAdjustment: 0,
      summary: 'Social attribution skipped by request.',
    };
  }
  const fetcher = pickFetcher(mode);
  if (!fetcher) {
    return {
      status: 'UNAVAILABLE', note: 'no mention source configured',
      mentions: [], topTier: null, coordinated: null, safetyAdjustment: 4,
      summary: 'Social attribution unavailable: no mention source configured.',
    };
  }
  const res = await fetcher.fetch(ref, ref.symbol);
  return analyze(res.mentions ?? [], roster(), topHolders, res.unavailable);
}

export { analyze, scoreMention, detectCoordination, similarity } from './classify.js';
export { loadRoster } from './roster.js';
