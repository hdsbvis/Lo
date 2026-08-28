import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { score } from '../src/safety/engine.js';
import { applyRatchet, detectShocks } from '../src/safety/volatility.js';
import { _internal as rulesInternal } from '../src/safety/rules.js';
import { _internal as factsInternal } from '../src/safety/facts.js';
import { emptyFacts } from '../src/types.js';
import type { MarketData, ProviderReport, Snapshot, TokenFacts, TokenRef } from '../src/types.js';

const ref: TokenRef = { chain: 'solana', address: 'So11111111111111111111111111111111111111112', symbol: 'TEST' };

const market = (over: Partial<MarketData> = {}): MarketData => ({
  volume: { h24: 50_000 }, priceChange: {}, txns: {}, socials: [{ type: 'twitter', url: 'x' }],
  marketCapUsd: 50_000, liquidityUsd: 30_000, ageMinutes: 60 * 24 * 10, ...over,
});

/** A token where every check came back clean, from three providers. */
const cleanFacts = (): TokenFacts => ({
  ...emptyFacts(),
  honeypot: false, cannotSell: false, buyTaxPct: 0, sellTaxPct: 0,
  mintAuthorityActive: false, freezeAuthorityActive: false, closeAuthorityActive: false,
  balanceMutableAuthority: false, ownerCanTakeBack: false, hiddenOwner: false,
  transferPausable: false, blacklistCapable: false, isProxy: false, selfdestruct: false,
  metadataMutable: false, transferHook: false, rugged: false, creatorPriorHoneypot: false,
  lpLockedPct: 100, lpBurned: true, topHolderPct: 3, top10Pct: 20, creatorPct: 1,
  insiderNetworkDetected: false, holderCount: 5_000,
});

const providers = (n: number): ProviderReport[] =>
  Array.from({ length: n }, (_, i) => ({ name: `p${i}`, ok: true, at: Date.now(), factsContributed: 10 }));

describe('veto rules are absolute', () => {
  const vetoCases: [string, Partial<TokenFacts>][] = [
    ['honeypot', { honeypot: true }],
    ['live mint authority', { mintAuthorityActive: true }],
    ['live freeze authority', { freezeAuthorityActive: true }],
    ['reclaimable ownership', { ownerCanTakeBack: true }],
    ['hidden owner', { hiddenOwner: true }],
    ['pausable transfers', { transferPausable: true }],
    ['blacklist capability', { blacklistCapable: true }],
    ['mutable balances', { balanceMutableAuthority: true }],
    ['already rugged', { rugged: true }],
    ['serial honeypot deployer', { creatorPriorHoneypot: true }],
    ['excess sell tax', { sellTaxPct: 40 }],
    ['whale concentration', { topHolderPct: 60 }],
    ['unlocked LP', { lpLockedPct: 10 }],
  ];

  for (const [name, bad] of vetoCases) {
    test(`${name} forces score 0 and AVOID even with everything else perfect`, () => {
      const r = score({
        ref, facts: { ...cleanFacts(), ...bad }, market: market(),
        providers: providers(3), fetchedAt: Date.now(),
      });
      assert.equal(r.score, 0, `${name} should force score to 0`);
      assert.equal(r.verdict, 'AVOID');
      assert.ok(r.vetoes.length > 0, `${name} should register a veto`);
    });
  }

  test('a veto cannot be outweighed by any number of positive signals', () => {
    const r = score({
      ref, facts: { ...cleanFacts(), honeypot: true }, market: market({ ageMinutes: 60 * 24 * 400 }),
      providers: providers(3), fetchedAt: Date.now(),
      social: {
        status: 'OK', mentions: [], topTier: 'WHALE', coordinated: null,
        safetyAdjustment: -100, summary: 'whales everywhere',
      },
    });
    assert.equal(r.score, 0);
    assert.equal(r.verdict, 'AVOID');
  });
});

describe('unknown is never treated as safe', () => {
  test('a token with no facts at all cannot score well', () => {
    const r = score({
      ref, facts: emptyFacts(), market: market(),
      providers: providers(1), fetchedAt: Date.now(),
    });
    assert.ok(r.score < 50, `expected a low score for an unverified token, got ${r.score}`);
    assert.ok(r.signals.some((s) => s.id.startsWith('unknown-')),
      'unknown facts should surface as explicit findings');
  });

  test('zero working providers is a veto, not a pass', () => {
    const r = score({
      ref, facts: emptyFacts(), market: market(),
      providers: [{ name: 'goplus', ok: false, at: Date.now(), error: 'timeout' }],
      fetchedAt: Date.now(),
    });
    assert.equal(r.verdict, 'AVOID');
    assert.ok(r.vetoes.some((v) => v.id === 'no-security-data'));
  });

  test('each unknown critical fact costs points', () => {
    const full = score({ ref, facts: cleanFacts(), market: market(), providers: providers(3), fetchedAt: Date.now() });
    const partial = score({
      ref, facts: { ...cleanFacts(), mintAuthorityActive: 'unknown', freezeAuthorityActive: 'unknown' },
      market: market(), providers: providers(3), fetchedAt: Date.now(),
    });
    assert.ok(partial.rawScore < full.rawScore,
      `unknown authorities should score worse than confirmed-revoked (${partial.rawScore} vs ${full.rawScore})`);
  });
});

describe('confidence caps the score', () => {
  test('one provider cannot produce a high score', () => {
    const one = score({ ref, facts: cleanFacts(), market: market(), providers: providers(1), fetchedAt: Date.now() });
    const three = score({ ref, facts: cleanFacts(), market: market(), providers: providers(3), fetchedAt: Date.now() });
    assert.ok(one.rawScore < three.rawScore, 'more corroboration should permit a higher score');
    assert.ok(one.rawScore <= 60);
  });
});

describe('the volatility ratchet is asymmetric', () => {
  const prev = (score_: number, atMsAgo: number): Snapshot => ({
    at: Date.now() - atMsAgo, chain: 'solana', address: ref.address,
    score: score_, rawScore: score_, verdict: 'WATCH',
  });

  test('score falls instantly and in full', () => {
    const { score: s } = applyRatchet({
      rawScore: 10, prev: prev(90, 30_000), now: Date.now(), shocks: [], dataAgeSec: 0,
    });
    assert.equal(s, 10, 'a drop must apply immediately, with no smoothing');
  });

  test('score rises only at the capped rate', () => {
    const { score: s } = applyRatchet({
      rawScore: 95, prev: prev(10, 60_000), now: Date.now(), shocks: [], dataAgeSec: 0,
    });
    // One minute elapsed at 2 points/minute => 12, not 95.
    assert.ok(s <= 13, `rise should be capped, got ${s}`);
    assert.ok(s >= 11, `rise should still occur, got ${s}`);
  });

  test('a shock collapses the score regardless of raw quality', () => {
    const { score: s } = applyRatchet({
      rawScore: 95, prev: prev(95, 60_000), now: Date.now(),
      shocks: [{ id: 'x', title: 't', detail: 'd', multiplier: 0 }], dataAgeSec: 0,
    });
    assert.equal(s, 0);
  });

  test('stale data decays the score toward zero', () => {
    const fresh = applyRatchet({ rawScore: 80, prev: undefined, now: Date.now(), shocks: [], dataAgeSec: 0 });
    const stale = applyRatchet({ rawScore: 80, prev: undefined, now: Date.now(), shocks: [], dataAgeSec: 450 });
    const ancient = applyRatchet({ rawScore: 80, prev: undefined, now: Date.now(), shocks: [], dataAgeSec: 10_000 });
    assert.equal(fresh.score, 80);
    assert.ok(stale.score < fresh.score, 'stale data should score lower');
    assert.equal(ancient.score, 0, 'very stale data should decay to zero');
  });
});

describe('shock detection', () => {
  const base: Snapshot = {
    at: Date.now() - 60_000, chain: 'solana', address: ref.address, score: 80, rawScore: 80,
    verdict: 'WATCH', liquidityUsd: 100_000, topHolderPct: 5, lpLockedPct: 100,
    mintAuthorityActive: false, freezeAuthorityActive: false, holderCount: 1000,
  };

  test('detects a liquidity drain', () => {
    const s = detectShocks(base, cleanFacts(), market({ liquidityUsd: 20_000 }));
    assert.ok(s.some((x) => x.id === 'liquidity-drain'));
    assert.equal(s.find((x) => x.id === 'liquidity-drain')!.multiplier, 0);
  });

  test('detects a reinstated mint authority', () => {
    const s = detectShocks(base, { ...cleanFacts(), mintAuthorityActive: true }, market());
    assert.ok(s.some((x) => x.id === 'mint-authority-restored'));
  });

  test('detects concentration spikes and LP unlocking', () => {
    const s = detectShocks(base, { ...cleanFacts(), topHolderPct: 18, lpLockedPct: 40 }, market());
    assert.ok(s.some((x) => x.id === 'concentration-spike'));
    assert.ok(s.some((x) => x.id === 'lp-unlocking'));
  });

  test('no previous snapshot means no shocks', () => {
    assert.deepEqual(detectShocks(undefined, cleanFacts(), market()), []);
  });

  test('stable readings produce no shocks', () => {
    assert.deepEqual(detectShocks(base, cleanFacts(), market({ liquidityUsd: 99_000 })), []);
  });
});

describe('fact merging is danger-biased', () => {
  const { mergeTri, mergeWorseNum, mergeBetterIsHigher } = factsInternal;

  test('one provider reporting danger beats several reporting clean', () => {
    assert.equal(mergeTri(false, true), true);
    assert.equal(mergeTri(true, false), true);
  });
  test('unknown yields to any known value', () => {
    assert.equal(mergeTri('unknown', false), false);
    assert.equal(mergeTri('unknown', 'unknown'), 'unknown');
  });
  test('the worse number wins for risk quantities', () => {
    assert.equal(mergeWorseNum(5, 40), 40);
    assert.equal(mergeWorseNum('unknown', 12), 12);
  });
  test('the less flattering number wins for protective quantities', () => {
    assert.equal(mergeBetterIsHigher(100, 30), 30);
  });
});

describe('liquidity handling', () => {
  test('missing liquidity is penalised, not treated as zero or as fine', () => {
    const { signals } = { signals: rulesInternal.weightedRules({
      ref, facts: cleanFacts(), market: market({ liquidityUsd: undefined }), providersOk: 3,
    }) };
    assert.ok(signals.some((s) => s.id === 'liquidity-unknown'));
    assert.ok(!signals.some((s) => s.id === 'liquidity-thin'),
      'absent liquidity must not be scored as a thin pool of $0');
  });
});
