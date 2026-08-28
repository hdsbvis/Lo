# rugwatch

Finds low-market-cap memecoins, then tries hard to talk you out of them.

Three parts: a **scanner** that sweeps discovery feeds for tokens in a market-cap
window you choose, a **safety engine** built to distrust by default, and a
**social classifier** that answers whether a real whale is posting about a token
or whether it is three bot accounts running the same script.

```
npm install
npm run scan -- --max-mc 100000 --chains solana --limit 15
npm run check -- <contract address>
npm run serve            # dashboard on http://localhost:8787
```

No API keys required. Every core provider used here is free.

---

## The safety engine

You asked for the safety part to be the most reactive component. Four mechanisms
do that work, and they all point the same way: **evidence of safety has to be
earned; risk is assumed until disproved.**

### 1. Vetoes are absolute, not heavy penalties

Twenty conditions are treated as disqualifying rather than as points off. Each
one is a mechanism by which the deployer can take your money whenever they feel
like it — live mint authority, live freeze authority, honeypot, reclaimable
ownership, pausable transfers, blacklist functions, mutable balances, unlocked
LP, a single wallet over 25% of supply, a deployer with a prior honeypot.

When any fires the score is forced to **0** and the verdict to **AVOID**. No
combination of good news lifts it. A whale posting, burned liquidity, six months
of history, 50,000 holders — none of it matters if the deployer can freeze your
account. There is a test asserting exactly this.

### 2. Unknown is priced as risk, never as a pass

Every security fact is tri-state: `true`, `false`, or `'unknown'`. A provider
that is down, rate-limited, or has not yet indexed a four-minute-old token
produces `'unknown'` — never `false`.

This matters more than it sounds. Collapsing "we could not check" into "it is
fine" is how a scanner cheerfully reports a honeypot as clean. So unverified
honeypot status costs 12 points, an unverified mint authority 14, unknown LP
lock 12, and so on. **If every provider fails, that is itself a veto** — an
unindexed token is usually a token that is minutes old, which is exactly when
rugs happen.

### 3. The score is ratcheted, and the ratchet is asymmetric

Downward moves apply instantly and in full. Upward moves are capped at 2 points
per minute of sustained clean readings. Climbing from 0 to 100 takes roughly 50
minutes of everything looking fine; falling from 100 to 0 takes one reading.

On top of that, comparing each check against the previous snapshot detects
**shocks** — liquidity down 35%+, a mint authority that was revoked and is now
live again, the top holder's share jumping 5 points, the LP lock falling, a
fifth of holders leaving. Shocks apply as multipliers *before* the ratchet and
bypass the rise cap entirely, so a drain in progress collapses the score in a
single tick instead of eroding it over several.

Security data older than five minutes decays the score toward zero rather than
persisting as a pass.

### 4. Confidence caps the score

One provider answering is not the same evidence as three. With one corroborating
source the score cannot exceed 60; with two, 85. The ceiling is visible in the
output rather than hidden inside the number.

### What the verdicts mean

`AVOID` · `DANGER` · `HIGH RISK` · `ELEVATED RISK` · `WATCHABLE`

There is deliberately no band called "safe". The best available verdict means
*the specific rug mechanisms checked here did not fire* — nothing more.

---

## Social attribution: whale or nobody?

The classifier starts every unrostered account at NOBODY and makes it earn a
tier, because on a low-cap memecoin the prior is overwhelmingly that the poster
is anonymous and unimportant.

**Roster first.** `data/whales.json` is a curated list you own and are expected
to edit. It ships with a handful of well-known accounts as a starting point.
Roster membership is the strongest signal available, so a padded roster degrades
everything downstream.

**Heuristics for everyone else.** Follower count, account age, follower/following
ratio, and handle shape (`cryptogem84719` is not a person). An account under 30
days old is treated as a bot regardless of follower count. High reach without
roster vouching tops out at KOL — reach is not credibility.

**Posting vs holding.** Roster entries can carry wallet addresses. When present,
those are cross-checked against the token's top holders, so the output
distinguishes *"@handle is posting about this"* from *"@handle is posting about
this and holds 2.5% of it"*. That distinction is most of the point.

**Bot-farm detection.** Posts are normalized — contract addresses, links,
tickers, emoji and casing stripped — then compared with an overlap coefficient
over word 3-grams. Three or more distinct accounts posting the same script
inside an hour is reported as a coordinated campaign and *raises* the risk
score by 18 points, because a paid shill campaign is a rug precursor rather than
evidence of interest.

Overlap coefficient rather than Jaccard is deliberate: farms spin their copy,
and dropping one word collapses Jaccard below any usable threshold. On spun
samples Jaccard scored real duplicates 0.58–0.63 against 0.00–0.22 for unrelated
posts — bands too close to separate. Containment scored the same pairs 0.78–0.83
against 0.00–0.40. Short posts fall back to Jaccard, where containment would
flag common phrasing.

**Adversarial coverage.** Accounts in `warnAccounts` (on-chain investigators)
are scored as a risk *increase*. A post from an investigator is a warning about
the token, not a call for it.

### Getting posts in

X killed the free tier, and the scraping routes are gone: public nitter
instances return 410 or do not resolve, and reader proxies hit X's login wall —
they return profile chrome and no timeline. **This was verified, not assumed.**

So there is no scraper here. A fetcher that silently returns zero posts is worse
than none, because "no whales are talking" and "we could not look" are opposite
conclusions and the app must never confuse them. Two paths work instead:

**Supply posts yourself** — drop a JSON array in `data/mentions/<address>.json`.
See `data/mentions/example.json`. This is the default path and it exercises the
whole classifier; collecting the posts is the only manual step.

**Add an X key** — set `X_BEARER_TOKEN` in `.env` and live search turns on with
no other changes (needs Basic tier or above; the free tier returns nothing from
recent search). The classifier does not care where mentions come from.

Without either, social status reports `UNAVAILABLE` with the reason, and carries
a small standing penalty. Missing information is not good news.

---

## Data sources

| Provider | Chains | Supplies |
|---|---|---|
| DexScreener | all | discovery feeds, market cap, liquidity, volume, age, socials |
| RugCheck | Solana | insider networks, pool-corrected holder distribution, LP locks, launchpad |
| GoPlus | Solana + EVM | honeypot, taxes, authorities, proxy/blacklist/pausable, LP locks |
| Solana RPC | Solana | mint/freeze authority, Token-2022 extensions — read straight off the chain |

Facts merge **danger-biased**: for a boolean risk flag, one provider saying
"yes" beats any number saying "no". A honeypot detector that fires only on
consensus is a honeypot detector that misses honeypots. For risk quantities the
worse reading wins; for protective ones (LP locked) the less flattering reading
wins. The chain read is authoritative for authority fields, because an authority
reinstated two minutes ago appears on chain first and in a cached API much later
if ever.

### One thing worth knowing about holder concentration

On a pre-migration pump.fun token the bonding-curve account holds ~30% of
supply. Providers that cannot label that account report it as the largest
holder, which trips the 25% concentration veto and disqualifies nearly every
fresh launch — the exact tokens you are scanning for. An early version of this
tool marked 11 of 12 candidates AVOID for this reason.

RugCheck is the only free Solana source that labels pool accounts (via its
`knownAccounts` map), so on Solana it alone decides concentration. GoPlus
returns Solana holder rows with no address and a null LP list, so it reports
concentration as `'unknown'` there rather than guessing; on EVM, where addresses
and LP holders are present, its exclusion works and it is used. The Solana RPC
provider contributes holder rows for wallet matching but no concentration figure
at all. `test/providers.test.ts` guards against a regression.

---

## Commands

```
scan                     Find low-cap tokens and rank them by risk
check <address|symbol>   Full assessment of one token
watch [address...]       Re-check on an interval, alert on adverse changes
history <address>        Recorded score history
serve                    Local dashboard
```

Scan flags: `--min-mc` `--max-mc` `--min-liq` `--min-age` `--max-age`
`--min-vol` `--chains` `--limit` `--only-watchable`.
Common flags: `--chain` `--social <auto|manual|x-api|off>` `--json` `--verbose`.

`--json` on any command emits the full assessment for piping.

Snapshots are appended to `data/snapshots/<chain>_<address>.jsonl` on every
check. That history is what makes shock detection and the ratchet work, so the
second run on a token is more informative than the first, and `watch` is where
the engine is doing its real job.

Tunables — thresholds, the rise cap, shock sensitivity, similarity — live in
`src/config.ts` and all read from environment variables. See `.env.example`.

## Tests

```
npm test        # 59 tests
npm run typecheck
```

The suite covers the invariants that matter: every veto forces 0 and cannot be
outweighed, unknowns never score as clean, zero providers is a veto, the ratchet
falls fast and rises slow, stale data decays, shocks are detected, merges stay
danger-biased, the chain wins on authority fields, pool balances never count as
a whale, and the social classifier separates whales from bots and spun copy from
organic posts.

## Limits

This is a risk filter, not investment advice, and a clean score is not a
guarantee.

It reads contract mechanics and distribution. It cannot see intent. A token can
pass every check here and still go to zero because the deployer loses interest,
because the whale who holds 3% decides to leave, or because it is a memecoin and
that is what they do. Most low-cap memecoins lose most of their value regardless
of contract hygiene.

It is also blind to off-chain coordination it has not been shown — a Telegram
group planning an exit produces no signal until the exit starts. The shock
detector will see the drain when it begins, which is help, but it is not a
warning in advance.

The providers disagree, go down, and lag. That is why confidence is reported
next to every score, and why a token nobody has indexed yet is refused outright
rather than given the benefit of the doubt.
