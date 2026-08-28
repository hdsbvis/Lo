import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, detectCoordination, scoreMention, similarity } from '../src/social/classify.js';
import { normalizeText, _internal } from '../src/social/classify.js';
import type { Roster } from '../src/social/roster.js';
import type { HolderRow, Mention } from '../src/types.js';

const DAY = 86_400_000;

const roster: Roster = {
  byHandle: new Map([
    ['bigwhale', { handle: 'bigwhale', tier: 'WHALE' as const, wallets: ['WALLET111'] }],
    ['somekol', { handle: 'somekol', tier: 'KOL' as const }],
    ['investigator', { handle: 'investigator', tier: 'ALPHA' as const }],
  ]),
  warnAccounts: new Set(['investigator']),
  walletOwners: new Map([['wallet111', 'bigwhale']]),
  size: 3,
};

const m = (over: Partial<Mention> = {}): Mention => ({
  id: Math.random().toString(36).slice(2),
  handle: 'randoguy',
  text: 'this coin is going to the moon',
  createdAt: Date.now(),
  ...over,
});

describe('account classification', () => {
  test('a rostered whale is recognised', () => {
    const s = scoreMention(m({ handle: 'bigwhale' }), roster, []);
    assert.equal(s.tier, 'WHALE');
    assert.ok(s.credibility > 0.9);
  });

  test('an unknown account with few followers is a nobody, not a whale', () => {
    const s = scoreMention(m({ handle: 'randoguy', followers: 120 }), roster, []);
    assert.equal(s.tier, 'NOBODY');
    assert.ok(s.credibility < 0.2);
  });

  test('a brand-new account is treated as a bot regardless of followers', () => {
    const s = scoreMention(
      m({ handle: 'freshaccount', followers: 40_000, accountCreatedAt: Date.now() - 5 * DAY }),
      roster, [],
    );
    assert.equal(s.tier, 'BOT');
  });

  test('follow-farming is detected', () => {
    const s = scoreMention(m({ handle: 'farmer', followers: 300, following: 4900 }), roster, []);
    assert.equal(s.tier, 'BOT');
  });

  test('generated-looking handles are flagged', () => {
    assert.equal(_internal.handleLooksAutomated('cryptogem849271'), true);
    assert.equal(_internal.handleLooksAutomated('elon__musk'), true);
    assert.equal(_internal.handleLooksAutomated('blknoiz06'), false);
    assert.equal(_internal.handleLooksAutomated('cobie'), false);
  });

  test('high reach without roster vouching is KOL, not WHALE', () => {
    const s = scoreMention(
      m({ handle: 'popularbutunknown', followers: 900_000, accountCreatedAt: Date.now() - 900 * DAY }),
      roster, [],
    );
    assert.equal(s.tier, 'KOL');
    assert.ok(s.credibility < 0.9, 'unvouched reach must not reach whale-level credibility');
  });

  test('a whale who holds the token is distinguished from one who only posts', () => {
    const holders: HolderRow[] = [{ address: 'WALLET111', pct: 2.5 }];
    const holding = scoreMention(m({ handle: 'bigwhale' }), roster, holders);
    assert.ok(holding.holdsToken, 'should match the roster wallet against top holders');
    assert.equal(holding.holdsToken!.pct, 2.5);

    const talking = scoreMention(m({ handle: 'bigwhale' }), roster, [{ address: 'SOMEONEELSE', pct: 9 }]);
    assert.equal(talking.holdsToken, undefined);
    assert.ok(talking.reasons.some((r) => r.includes('without a visible position')));
  });
});

describe('coordination detection', () => {
  const shill = (handle: string, i: number): Mention => m({
    handle,
    // Same sales copy, different ticker and link -- exactly what a farm does.
    text: `GEM ALERT this one is about to explode dont miss it $TOK${i} https://x.com/a/${i}`,
    createdAt: Date.now() - i * 60_000,
  });

  test('near-identical copy across many accounts is caught', () => {
    const mentions = ['a1', 'b2', 'c3', 'd4', 'e5'].map(shill);
    const c = detectCoordination(mentions);
    assert.ok(c, 'should detect the cluster');
    assert.ok(c!.clusterSize >= 3);
  });

  test('organic distinct posts are not flagged', () => {
    const mentions = [
      m({ handle: 'a', text: 'the chart looks weak here honestly' }),
      m({ handle: 'b', text: 'dev just posted a roadmap, interesting' }),
      m({ handle: 'c', text: 'liquidity is way too thin for me' }),
      m({ handle: 'd', text: 'anyone know who deployed this?' }),
    ];
    assert.equal(detectCoordination(mentions), null);
  });

  test('one account posting repeatedly is not a cluster', () => {
    const mentions = [0, 1, 2, 3].map((i) => shill('sameguy', i));
    assert.equal(detectCoordination(mentions), null,
      'a cluster requires distinct accounts, not repeated posts');
  });

  test('catches spun copy where a word or two was changed', () => {
    const mentions = [
      m({ handle: 'a1', text: 'GEM ALERT 100x incoming dont miss this one anon $AAA https://t.co/a' }),
      m({ handle: 'b2', text: 'GEM ALERT 100x incoming dont miss this anon $BBB https://t.co/b' }),
      m({ handle: 'c3', text: 'GEM ALERT 100x incoming dont miss this one fren $CCC https://t.co/c' }),
    ];
    const c = detectCoordination(mentions);
    assert.ok(c, 'spun variants of one script should still cluster');
    assert.ok(c!.clusterSize >= 3);
  });

  test('short generic posts are not treated as duplicates', () => {
    const mentions = [
      m({ handle: 'a', text: 'going to the moon boys lets go' }),
      m({ handle: 'b', text: 'this is going to the moon for sure' }),
      m({ handle: 'c', text: 'moon soon i think' }),
    ];
    assert.equal(detectCoordination(mentions), null,
      'containment must not turn short common phrasing into a detected campaign');
  });

  test('similarity ignores tickers, links and addresses', () => {
    const a = 'buy $AAA now https://t.co/1 7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
    const b = 'buy $BBB now https://t.co/2 So11111111111111111111111111111111111111112';
    assert.ok(similarity(a, b) > 0.8, `expected high similarity, got ${similarity(a, b)}`);
    assert.equal(normalizeText(a), normalizeText(b));
  });
});

describe('overall social verdict', () => {
  test('a coordinated campaign raises risk', () => {
    const mentions = ['a1', 'b2', 'c3', 'd4'].map((h, i) =>
      m({ handle: h, text: `GEM ALERT this is about to explode dont miss $T${i}`, createdAt: Date.now() - i * 1000 }));
    const r = analyze(mentions, roster, []);
    assert.ok(r.coordinated);
    assert.ok(r.safetyAdjustment > 10, 'a shill campaign should be a meaningful penalty');
  });

  test('a whale holding a position is a modest credit, never a large one', () => {
    const r = analyze([m({ handle: 'bigwhale' })], roster, [{ address: 'WALLET111', pct: 3 }]);
    assert.equal(r.topTier, 'WHALE');
    assert.ok(r.safetyAdjustment < 0, 'credible attribution should help');
    assert.ok(r.safetyAdjustment > -15, 'no social signal should dominate the contract facts');
  });

  test('adversarial coverage is a penalty, not an endorsement', () => {
    const r = analyze([m({ handle: 'investigator' })], roster, []);
    assert.ok(r.safetyAdjustment > 0,
      'a post from a known investigator is a warning about the token, not a shill for it');
  });

  test('anonymous-only coverage raises risk', () => {
    const r = analyze([m({ handle: 'rando1', followers: 50 })], roster, []);
    assert.ok(r.safetyAdjustment > 0);
    assert.equal(r.topTier, 'NOBODY');
  });

  test('unavailable data is reported as unavailable, never as clean', () => {
    const r = analyze([], roster, [], 'X_BEARER_TOKEN not set');
    assert.equal(r.status, 'UNAVAILABLE');
    assert.ok(r.safetyAdjustment > 0, 'missing information must not read as good news');
    assert.match(r.summary, /unavailable/i);
  });

  test('no mentions is distinct from could-not-look', () => {
    const none = analyze([], roster, []);
    assert.equal(none.status, 'NO_MENTIONS');
    assert.notEqual(none.status, 'UNAVAILABLE');
  });
});
