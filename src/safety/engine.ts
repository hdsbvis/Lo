import { config } from '../config.js';
import type {
  MarketData, ProviderReport, SafetyResult, Signal, Snapshot,
  SocialResult, TokenFacts, TokenRef, Verdict,
} from '../types.js';
import { evaluate } from './rules.js';
import { applyRatchet, detectShocks } from './volatility.js';

export interface ScoreInput {
  ref: TokenRef;
  facts: TokenFacts;
  market: MarketData;
  providers: ProviderReport[];
  /** ms epoch of the newest security fact. */
  fetchedAt: number;
  prev?: Snapshot;
  social?: SocialResult;
  now?: number;
}

function bandVerdict(score: number): Verdict {
  const b = config.safety.bands;
  if (score >= b.watch) return 'WATCH';
  if (score >= b.elevated) return 'ELEVATED_RISK';
  if (score >= b.high) return 'HIGH_RISK';
  if (score >= b.danger) return 'DANGER';
  return 'AVOID';
}

/**
 * Confidence is the share of independent security providers that answered.
 * It caps the score: one provider agreeing that a token looks clean is not the
 * same evidence as three, and the ceiling makes that difference visible rather
 * than letting a single lucky response produce a confident-looking number.
 */
function confidenceCap(providersOk: number): { cap: number; confidence: number } {
  const caps = config.safety.confidenceCaps;
  const idx = Math.min(providersOk, caps.length - 1);
  return {
    cap: caps[idx] ?? 100,
    confidence: Math.min(1, providersOk / 3),
  };
}

export function score(input: ScoreInput): SafetyResult {
  const now = input.now ?? Date.now();
  const providersOk = input.providers.filter((p) => p.ok).length;

  const { vetoes, signals } = evaluate({
    ref: input.ref,
    facts: input.facts,
    market: input.market,
    providersOk,
  });

  // Social attribution feeds back into safety: a coordinated shill campaign is
  // a rug precursor, and a credible holder with skin in the game is mild relief.
  const allSignals = [...signals];
  if (input.social && input.social.safetyAdjustment !== 0) {
    const adj = input.social.safetyAdjustment;
    allSignals.push({
      id: 'social-adjustment',
      severity: adj > 0 ? 'high' : 'positive',
      title: adj > 0 ? 'Social pattern raises risk' : 'Credible social attribution',
      detail: input.social.summary,
      weight: adj,
    });
  }

  const penalty = allSignals.reduce((a, s) => a + s.weight, 0);
  let rawScore = Math.max(0, Math.min(100, 100 - penalty));

  // Credits must never lift a token above the evidence supporting it.
  const { cap, confidence } = confidenceCap(providersOk);
  rawScore = Math.min(rawScore, cap);

  const dataAgeSec = Math.max(0, (now - input.fetchedAt) / 1000);
  const shocks = detectShocks(input.prev, input.facts, input.market);

  let finalScore: number;
  if (vetoes.length > 0) {
    // A veto is not a large penalty. It is a floor of zero that no amount of
    // countervailing evidence can lift.
    finalScore = 0;
  } else {
    finalScore = applyRatchet({ rawScore, prev: input.prev, now, shocks, dataAgeSec }).score;
  }

  const verdict: Verdict = vetoes.length > 0
    ? 'AVOID'
    : providersOk === 0
      ? 'UNRATED'
      : bandVerdict(finalScore);

  return {
    score: Math.round(finalScore),
    rawScore: Math.round(rawScore),
    verdict,
    confidence,
    vetoes,
    signals: allSignals.sort((a, b) => b.weight - a.weight),
    providers: input.providers,
    shocks,
    computedAt: now,
    dataAgeSec: Math.round(dataAgeSec),
  };
}

export function toSnapshot(
  ref: TokenRef, market: MarketData, facts: TokenFacts, safety: SafetyResult, socialCount = 0,
): Snapshot {
  return {
    at: safety.computedAt,
    chain: ref.chain,
    address: ref.address,
    score: safety.score,
    rawScore: safety.rawScore,
    verdict: safety.verdict,
    marketCapUsd: market.marketCapUsd,
    liquidityUsd: market.liquidityUsd,
    topHolderPct: facts.topHolderPct,
    lpLockedPct: facts.lpLockedPct,
    mintAuthorityActive: facts.mintAuthorityActive,
    freezeAuthorityActive: facts.freezeAuthorityActive,
    holderCount: facts.holderCount,
    socialCount,
  };
}

/** Human-facing label. Deliberately never says "safe". */
export function verdictLabel(v: Verdict): string {
  switch (v) {
    case 'AVOID': return 'AVOID';
    case 'DANGER': return 'DANGER';
    case 'HIGH_RISK': return 'HIGH RISK';
    case 'ELEVATED_RISK': return 'ELEVATED RISK';
    case 'WATCH': return 'WATCHABLE';
    case 'UNRATED': return 'UNRATED';
  }
}

export const _internal = { bandVerdict, confidenceCap };
