import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { _internal } from '../src/safety/facts.js';
import { emptyFacts } from '../src/types.js';
import type { TokenFacts } from '../src/types.js';

/**
 * Regression guard for the pool-as-whale bug.
 *
 * On a pre-migration pump.fun token the bonding-curve account holds ~30% of
 * supply. Providers that cannot label it report that balance as the largest
 * holder, which trips the concentration veto and disqualifies nearly every
 * fresh launch. Providers that cannot identify pools must therefore report
 * concentration as 'unknown', and the merge must not let a pool-inflated
 * number from one provider override a pool-corrected one from another.
 */
describe('holder concentration never counts the pool as a whale', () => {
  test('an unknown reading does not override a pool-corrected one', () => {
    const rugcheck: TokenFacts = { ...emptyFacts(), topHolderPct: 2.7, top10Pct: 11 };
    const goplus: TokenFacts = { ...emptyFacts() }; // cannot exclude pools -> unknown
    const merged = { ...emptyFacts() };
    _internal.mergeInto(merged, rugcheck, false);
    _internal.mergeInto(merged, goplus, false);
    assert.equal(merged.topHolderPct, 2.7,
      'the provider that can label pool accounts must decide concentration');
  });

  test('a provider reporting unknown contributes no concentration at all', () => {
    const merged = { ...emptyFacts() };
    _internal.mergeInto(merged, { ...emptyFacts() }, false);
    assert.equal(merged.topHolderPct, 'unknown');
    assert.equal(merged.top10Pct, 'unknown');
  });

  test('between two real readings the worse one still wins', () => {
    const merged = { ...emptyFacts() };
    _internal.mergeInto(merged, { ...emptyFacts(), topHolderPct: 4 }, false);
    _internal.mergeInto(merged, { ...emptyFacts(), topHolderPct: 31 }, false);
    assert.equal(merged.topHolderPct, 31,
      'danger-biased merge still applies when both providers can measure');
  });
});

describe('protective values merge pessimistically', () => {
  test('the lower LP lock figure survives', () => {
    const merged = { ...emptyFacts() };
    _internal.mergeInto(merged, { ...emptyFacts(), lpLockedPct: 100 }, false);
    _internal.mergeInto(merged, { ...emptyFacts(), lpLockedPct: 42 }, false);
    assert.equal(merged.lpLockedPct, 42);
  });

  test('a burned LP reported by any provider is kept', () => {
    const merged = { ...emptyFacts() };
    _internal.mergeInto(merged, { ...emptyFacts(), lpBurned: 'unknown' }, false);
    _internal.mergeInto(merged, { ...emptyFacts(), lpBurned: true }, false);
    assert.equal(merged.lpBurned, true);
  });
});

describe('chain reads are authoritative for authority fields', () => {
  test('an on-chain revocation overrides a cached API claiming it is live', () => {
    const merged = { ...emptyFacts() };
    _internal.mergeInto(merged, { ...emptyFacts(), mintAuthorityActive: true }, false);  // stale API
    _internal.mergeInto(merged, { ...emptyFacts(), mintAuthorityActive: false }, true);  // chain
    assert.equal(merged.mintAuthorityActive, false);
  });

  test('an on-chain reinstatement overrides an API claiming it is revoked', () => {
    const merged = { ...emptyFacts() };
    _internal.mergeInto(merged, { ...emptyFacts(), mintAuthorityActive: false }, false);
    _internal.mergeInto(merged, { ...emptyFacts(), mintAuthorityActive: true }, true);
    assert.equal(merged.mintAuthorityActive, true);
  });

  test('non-authority fields still merge danger-biased even from the chain', () => {
    const merged = { ...emptyFacts() };
    _internal.mergeInto(merged, { ...emptyFacts(), honeypot: true }, false);
    _internal.mergeInto(merged, { ...emptyFacts(), honeypot: false }, true);
    assert.equal(merged.honeypot, true, 'the chain read is not authoritative for honeypot status');
  });
});
