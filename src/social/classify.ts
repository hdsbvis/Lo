import { config } from '../config.js';
import type {
  CoordinationReport, HolderRow, Mention, ScoredMention, SocialResult, WhaleTier,
} from '../types.js';
import { bestTier, isWarnAccount, lookup, TIER_RANK, type Roster } from './roster.js';

const DAY = 86_400_000;

/**
 * Normalizes a post down to the part that would be identical across a paid
 * shill campaign: contract addresses, links, tickers, emoji and casing all get
 * stripped, because those are exactly the fields a bot farm varies while
 * keeping the sales copy the same.
 */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[a-z0-9]{32,44}\b/g, ' ')      // solana mints
    .replace(/0x[a-f0-9]{40}\b/g, ' ')       // evm addresses
    .replace(/[$#@][a-z0-9_]+/g, ' ')        // tickers, hashtags, handles
    .replace(/[\p{Extended_Pictographic}]/gu, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shingles(s: string, n = 3): Set<string> {
  const words = s.split(' ').filter(Boolean);
  if (words.length < n) return new Set(words.length ? [words.join(' ')] : []);
  const out = new Set<string>();
  for (let i = 0; i <= words.length - n; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
}

/** Minimum 3-gram count (≈6 words) before containment is trusted over Jaccard. */
const MIN_SHINGLES_FOR_CONTAINMENT = 4;

/**
 * Near-duplicate score between two posts.
 *
 * Uses the overlap coefficient (intersection over the *smaller* shingle set)
 * rather than Jaccard, because shill farms spin their copy: dropping or adding
 * a word or two collapses Jaccard well below any usable threshold while the
 * post is plainly the same script. Measured on spun samples, Jaccard put real
 * duplicates at 0.58-0.63 and unrelated posts at 0.00-0.22 -- overlapping the
 * band where a threshold has to sit. Containment separates the same pairs
 * 0.78-0.83 against 0.00-0.40.
 *
 * Containment's weakness is short text, where one post is trivially a subset of
 * another, so anything under MIN_SHINGLES_FOR_CONTAINMENT falls back to Jaccard.
 */
export function similarity(a: string, b: string): number {
  const A = shingles(normalizeText(a));
  const B = shingles(normalizeText(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const jaccard = inter / (A.size + B.size - inter);
  if (Math.min(A.size, B.size) < MIN_SHINGLES_FOR_CONTAINMENT) return jaccard;
  return Math.max(jaccard, inter / Math.min(A.size, B.size));
}

/** Handles like "CryptoGem84719" or "elonmusk_8827" are overwhelmingly farmed. */
function handleLooksAutomated(handle: string): boolean {
  const h = handle.replace(/^@/, '');
  if (/\d{5,}$/.test(h)) return true;
  if (/^[a-z]+\d{4,}$/i.test(h)) return true;
  if (/_{2,}/.test(h)) return true;
  return false;
}

/**
 * Classifies one account. The roster is authoritative when it matches; the
 * heuristics only run for accounts nobody has vouched for, and they are biased
 * toward NOBODY, because on a low-cap memecoin the prior is overwhelmingly that
 * the poster is anonymous and unimportant.
 */
export function scoreMention(m: Mention, roster: Roster, topHolders: HolderRow[]): ScoredMention {
  const reasons: string[] = [];
  const entry = lookup(roster, m.handle);
  let tier: WhaleTier;
  let credibility: number;

  if (entry) {
    tier = entry.tier;
    credibility = { WHALE: 0.95, KOL: 0.8, ALPHA: 0.75, RETAIL: 0.4, NOBODY: 0.15, BOT: 0.02 }[entry.tier];
    reasons.push(`On your curated roster as ${entry.tier}${entry.note ? ` (${entry.note})` : ''}`);
    if (entry.trackRecord !== undefined) {
      credibility = credibility * 0.5 + entry.trackRecord * 0.5;
      reasons.push(`Track record ${(entry.trackRecord * 100).toFixed(0)}%`);
    }
  } else {
    // Unrostered. Start from "nobody" and require evidence to climb.
    credibility = 0.1;
    tier = 'NOBODY';
    const f = m.followers;
    const ageDays = m.accountCreatedAt ? (Date.now() - m.accountCreatedAt) / DAY : undefined;

    if (f !== undefined) {
      if (f >= config.social.whaleFollowerFloor) {
        tier = 'KOL';
        credibility = 0.55;
        reasons.push(`${f.toLocaleString()} followers, but not on your roster — reach without vouched credibility`);
      } else if (f > config.social.nobodyFollowerCeiling) {
        tier = 'RETAIL';
        credibility = 0.3;
        reasons.push(`${f.toLocaleString()} followers`);
      } else {
        reasons.push(`${f.toLocaleString()} followers — below the noise floor`);
      }
    } else {
      reasons.push('Follower count unknown');
    }

    if (ageDays !== undefined && ageDays < 30) {
      tier = 'BOT';
      credibility = Math.min(credibility, 0.05);
      reasons.push(`Account is ${ageDays.toFixed(0)} days old`);
    }
    if (m.followers !== undefined && m.following !== undefined && m.following > 0) {
      const ratio = m.followers / m.following;
      if (ratio < 0.2 && m.following > 500) {
        tier = 'BOT';
        credibility = Math.min(credibility, 0.05);
        reasons.push(`Follows ${m.following.toLocaleString()} accounts, followed by ${m.followers.toLocaleString()} — follow-farming pattern`);
      }
    }
    if (handleLooksAutomated(m.handle)) {
      tier = 'BOT';
      credibility = Math.min(credibility, 0.04);
      reasons.push('Handle matches the generated-account pattern');
    }
    if (m.verified) {
      credibility = Math.min(1, credibility + 0.05);
      reasons.push('Verified (paid checkmark — weak signal on its own)');
    }
  }

  if (isWarnAccount(roster, m.handle)) {
    reasons.push('Adversarial-coverage account: treat this post as a warning, not a call');
  }

  // Does this account actually hold the token, or is it only talking?
  let holdsToken: ScoredMention['holdsToken'];
  const wallets = entry?.wallets ?? [];
  for (const w of wallets) {
    const hit = topHolders.find(
      (h) => h.address.toLowerCase() === w.toLowerCase() || h.owner?.toLowerCase() === w.toLowerCase(),
    );
    if (hit) {
      holdsToken = { wallet: w, pct: hit.pct };
      reasons.push(`Holds ${hit.pct.toFixed(2)}% of supply — posting with a position, not just an opinion`);
      break;
    }
  }
  if (!holdsToken && wallets.length > 0) {
    reasons.push('Roster wallets are not in the top holders — talking without a visible position');
  }

  return { mention: m, tier, credibility, reasons, holdsToken };
}

/**
 * Finds the largest group of distinct accounts posting near-identical copy
 * inside the configured window. This is the difference between "it is trending"
 * and "somebody bought fifty accounts", and it is a rug precursor, so it feeds
 * a penalty back into the safety score.
 */
export function detectCoordination(mentions: Mention[]): CoordinationReport | null {
  const cfg = config.social;
  if (mentions.length < cfg.minClusterSize) return null;

  const windowMs = cfg.coordinationWindowMinutes * 60_000;
  let best: CoordinationReport | null = null;

  for (let i = 0; i < mentions.length; i++) {
    const seed = mentions[i]!;
    const group = [seed];
    const sims: number[] = [];
    const handles = new Set([seed.handle.toLowerCase()]);

    for (let j = 0; j < mentions.length; j++) {
      if (i === j) continue;
      const other = mentions[j]!;
      if (Math.abs(other.createdAt - seed.createdAt) > windowMs) continue;
      if (handles.has(other.handle.toLowerCase())) continue;
      const sim = similarity(seed.text, other.text);
      if (sim >= cfg.similarityThreshold) {
        group.push(other);
        sims.push(sim);
        handles.add(other.handle.toLowerCase());
      }
    }

    if (handles.size >= cfg.minClusterSize) {
      sims.sort((a, b) => a - b);
      const median = sims.length ? sims[Math.floor(sims.length / 2)]! : 1;
      if (!best || handles.size > best.clusterSize) {
        best = {
          clusterSize: handles.size,
          windowMinutes: cfg.coordinationWindowMinutes,
          medianSimilarity: median,
          handles: [...handles],
        };
      }
    }
  }
  return best;
}

/**
 * Rolls the per-account judgements into one answer to the question the user
 * actually asked: is a big whale posting about this, or is it just some nut?
 */
export function analyze(
  mentions: Mention[],
  roster: Roster,
  topHolders: HolderRow[],
  unavailableNote?: string,
): SocialResult {
  if (unavailableNote) {
    return {
      status: 'UNAVAILABLE', note: unavailableNote, mentions: [], topTier: null,
      coordinated: null,
      // Missing social data is not evidence of safety. Small standing penalty.
      safetyAdjustment: 4,
      summary: `Social attribution unavailable: ${unavailableNote}`,
    };
  }
  if (mentions.length === 0) {
    return {
      status: 'NO_MENTIONS', mentions: [], topTier: null, coordinated: null,
      safetyAdjustment: 2,
      summary: 'No posts found from any account in scope. Nobody credible is talking about this yet.',
    };
  }

  const scored = mentions
    .map((m) => scoreMention(m, roster, topHolders))
    .sort((a, b) => b.credibility - a.credibility);
  const coordinated = detectCoordination(mentions);
  const topTier = bestTier(scored.map((s) => s.tier));

  let adjustment = 0;
  const notes: string[] = [];

  if (coordinated) {
    adjustment += 18;
    notes.push(
      `${coordinated.clusterSize} accounts posted near-identical copy within ${coordinated.windowMinutes} minutes ` +
      `(median similarity ${(coordinated.medianSimilarity * 100).toFixed(0)}%) — paid campaign, not organic interest`,
    );
  }

  const botShare = scored.filter((s) => s.tier === 'BOT').length / scored.length;
  if (botShare > 0.5) {
    adjustment += 10;
    notes.push(`${(botShare * 100).toFixed(0)}% of posters look automated`);
  }

  const credible = scored.filter((s) => TIER_RANK[s.tier] >= TIER_RANK.KOL);
  const warn = scored.filter((s) => isWarnAccount(roster, s.mention.handle));

  if (warn.length > 0) {
    adjustment += 25;
    notes.push(`Adversarial coverage from ${warn.map((w) => '@' + w.mention.handle).join(', ')} — investigated, not shilled`);
  } else if (credible.length > 0) {
    const holders = credible.filter((s) => s.holdsToken);
    // A credible account posting is mild relief; a credible account holding is
    // better. Neither is large -- whales exit-liquidity their followers routinely.
    adjustment -= holders.length > 0 ? 8 : 4;
    const who = credible.slice(0, 3).map((s) => `@${s.mention.handle} (${s.tier})`).join(', ');
    notes.push(holders.length > 0
      ? `${who} posting, and holding a position`
      : `${who} posting, with no visible on-chain position`);
  } else {
    adjustment += 6;
    notes.push('No rostered or high-reach account is posting — coverage is anonymous accounts only');
  }

  const summary = notes.join('. ') + '.';
  return { status: 'OK', mentions: scored, topTier, coordinated, safetyAdjustment: adjustment, summary };
}

export const _internal = { handleLooksAutomated, shingles };
