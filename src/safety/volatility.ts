import { config } from '../config.js';
import type { MarketData, Shock, Snapshot, TokenFacts } from '../types.js';

/**
 * Adverse-change detection.
 *
 * The rule engine scores a token from a standing start. This module scores the
 * *delta* since the last look, because the dangerous moment is rarely "this
 * token was always bad" -- it is "this token was fine ten minutes ago and
 * something just changed". Each shock returns a multiplier applied to the score,
 * so a drain or an authority coming back online collapses the score in one tick
 * rather than eroding it over several.
 */
export function detectShocks(
  prev: Snapshot | undefined,
  facts: TokenFacts,
  market: MarketData,
): Shock[] {
  if (!prev) return [];
  const out: Shock[] = [];
  const cfg = config.shocks;

  // Liquidity leaving the pool is the rug itself, in progress.
  if (prev.liquidityUsd !== undefined && market.liquidityUsd !== undefined && prev.liquidityUsd > 0) {
    const drop = (prev.liquidityUsd - market.liquidityUsd) / prev.liquidityUsd;
    if (drop >= cfg.liquidityDropFrac) {
      out.push({
        id: 'liquidity-drain',
        title: `Liquidity fell ${(drop * 100).toFixed(0)}%`,
        detail: `$${prev.liquidityUsd.toFixed(0)} -> $${market.liquidityUsd.toFixed(0)} since the last check. This is what a rug looks like while it happens.`,
        multiplier: drop >= 0.6 ? 0 : 0.25,
      });
    }
  }

  // An authority that was revoked and is now live means the deployer reclaimed
  // control. There is no benign reading of this.
  if (prev.mintAuthorityActive === false && facts.mintAuthorityActive === true) {
    out.push({
      id: 'mint-authority-restored', title: 'Mint authority came back online',
      detail: 'Previously revoked, now active. Supply can be printed.', multiplier: 0,
    });
  }
  if (prev.freezeAuthorityActive === false && facts.freezeAuthorityActive === true) {
    out.push({
      id: 'freeze-authority-restored', title: 'Freeze authority came back online',
      detail: 'Previously revoked, now active. Your account can be frozen.', multiplier: 0,
    });
  }

  // Concentration spiking means someone is accumulating for an exit.
  if (prev.topHolderPct !== undefined && prev.topHolderPct !== 'unknown' &&
      facts.topHolderPct !== 'unknown') {
    const jump = facts.topHolderPct - prev.topHolderPct;
    if (jump >= cfg.topHolderJumpPct) {
      out.push({
        id: 'concentration-spike',
        title: `Top wallet grew ${jump.toFixed(1)} points`,
        detail: `${prev.topHolderPct.toFixed(1)}% -> ${facts.topHolderPct.toFixed(1)}%. One wallet is accumulating.`,
        multiplier: 0.4,
      });
    }
  }

  // LP unlocking is the setup step before a drain.
  if (prev.lpLockedPct !== undefined && prev.lpLockedPct !== 'unknown' && facts.lpLockedPct !== 'unknown') {
    if (facts.lpLockedPct < prev.lpLockedPct - 5) {
      out.push({
        id: 'lp-unlocking',
        title: `LP lock fell to ${facts.lpLockedPct.toFixed(0)}%`,
        detail: `Was ${prev.lpLockedPct.toFixed(0)}%. Liquidity is being freed for withdrawal.`,
        multiplier: 0.15,
      });
    }
  }

  // Holders leaving en masse.
  if (prev.holderCount !== undefined && prev.holderCount !== 'unknown' &&
      facts.holderCount !== 'unknown' && prev.holderCount > 20) {
    const drop = (prev.holderCount - facts.holderCount) / prev.holderCount;
    if (drop >= cfg.holderDropFrac) {
      out.push({
        id: 'holder-exodus',
        title: `Holder count fell ${(drop * 100).toFixed(0)}%`,
        detail: `${prev.holderCount} -> ${facts.holderCount}. Mass exit under way.`,
        multiplier: 0.5,
      });
    }
  }

  return out;
}

export interface RatchetInput {
  rawScore: number;
  prev: Snapshot | undefined;
  now: number;
  shocks: Shock[];
  /** Seconds since the newest security fact was fetched. */
  dataAgeSec: number;
}

/**
 * The asymmetric ratchet.
 *
 * Downward moves apply in full and immediately. Upward moves are capped at
 * `riseCapPerMinute` points per minute of elapsed time, so a token has to hold a
 * clean reading for a sustained period before its score recovers. This is
 * deliberate: a scanner that lets a score snap back to 80 the instant a provider
 * comes back online is a scanner that recommends a token mid-rug.
 *
 * Shock multipliers are applied before the ratchet, and bypass the rise cap
 * entirely on the way down.
 */
export function applyRatchet(input: RatchetInput): { score: number; staleFactor: number } {
  const { rawScore, prev, now, shocks } = input;
  const s = config.safety;

  let score = rawScore;

  // Shocks multiply, so two independent adverse changes compound.
  for (const sh of shocks) score *= sh.multiplier;

  // Stale security data decays toward zero rather than persisting as a pass.
  // Full confidence up to maxDataAgeSec, then linear decay over the same span again.
  let staleFactor = 1;
  if (input.dataAgeSec > s.maxDataAgeSec) {
    const over = input.dataAgeSec - s.maxDataAgeSec;
    staleFactor = Math.max(0, 1 - over / s.maxDataAgeSec);
    score *= staleFactor;
  }

  if (prev) {
    const dtMin = Math.max(0, (now - prev.at) / 60_000);
    const maxRise = s.riseCapPerMinute * dtMin;
    if (score > prev.score + maxRise) {
      score = prev.score + maxRise;
    }
  }

  return { score: Math.max(0, Math.min(100, score)), staleFactor };
}
