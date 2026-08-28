import { config } from '../config.js';
import type { MarketData, Signal, TokenFacts, TokenRef, Tri } from '../types.js';

export interface RuleContext {
  ref: TokenRef;
  facts: TokenFacts;
  market: MarketData;
  /** Number of security providers that answered. */
  providersOk: number;
}

export interface RuleOutput {
  vetoes: Signal[];
  signals: Signal[];
}

const veto = (id: string, title: string, detail: string): Signal =>
  ({ id, severity: 'veto', title, detail, weight: 0 });

const sig = (id: string, severity: Signal['severity'], weight: number, title: string, detail: string): Signal =>
  ({ id, severity, title, detail, weight });

const pctStr = (v: number) => `${v.toFixed(1)}%`;
const usd = (v: number) =>
  v >= 1_000_000 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1_000 ? `$${(v / 1e3).toFixed(1)}k` : `$${v.toFixed(0)}`;

/**
 * VETOES -- conditions under which no combination of good signals can produce a
 * passing score. Each of these is a mechanism by which the deployer can take
 * your money at a time of their choosing. The engine forces the score to 0 and
 * the verdict to AVOID when any fires.
 */
function vetoRules(ctx: RuleContext): Signal[] {
  const f = ctx.facts;
  const s = config.safety;
  const out: Signal[] = [];

  if (f.honeypot === true)
    out.push(veto('honeypot', 'Honeypot', 'Simulated sells fail. You can buy this and never sell it.'));
  if (f.cannotSell === true)
    out.push(veto('cannot-sell', 'Cannot sell full balance', 'The contract blocks selling the whole position.'));
  if (f.rugged === true)
    out.push(veto('rugged', 'Already rugged', 'This token is flagged as having already pulled liquidity.'));

  if (f.sellTaxPct !== 'unknown' && f.sellTaxPct > s.maxSellTaxPct)
    out.push(veto('sell-tax', `Sell tax ${pctStr(f.sellTaxPct)}`,
      `Above the ${s.maxSellTaxPct}% limit. A tax this high can also be raised further after you buy.`));
  if (f.buyTaxPct !== 'unknown' && f.buyTaxPct > s.maxBuyTaxPct)
    out.push(veto('buy-tax', `Buy tax ${pctStr(f.buyTaxPct)}`, `Above the ${s.maxBuyTaxPct}% limit.`));

  if (f.mintAuthorityActive === true)
    out.push(veto('mint-authority', 'Mint authority live',
      'The deployer can print unlimited supply and dump it into your liquidity.'));
  if (f.freezeAuthorityActive === true)
    out.push(veto('freeze-authority', 'Freeze authority live',
      'The deployer can freeze your token account and stop you selling at will.'));
  if (f.closeAuthorityActive === true)
    out.push(veto('close-authority', 'Close authority live',
      'The deployer can close holder token accounts.'));
  if (f.balanceMutableAuthority === true)
    out.push(veto('balance-mutable', 'Balances are mutable',
      'A permanent delegate or equivalent authority can move tokens out of your wallet directly.'));
  if (f.ownerCanTakeBack === true)
    out.push(veto('take-back-ownership', 'Ownership can be reclaimed',
      'Renounced ownership is reversible here, so every owner-only risk is still live.'));
  if (f.hiddenOwner === true)
    out.push(veto('hidden-owner', 'Hidden owner',
      'The contract retains a concealed privileged address.'));
  if (f.transferPausable === true)
    out.push(veto('pausable', 'Transfers can be paused',
      'The deployer can halt all trading, including your exit.'));
  if (f.blacklistCapable === true)
    out.push(veto('blacklist', 'Blacklist function present',
      'Your address can be individually blocked from selling.'));
  if (f.selfdestruct === true)
    out.push(veto('selfdestruct', 'Self-destruct present', 'The contract can be destroyed.'));
  if (f.creatorPriorHoneypot === true)
    out.push(veto('serial-scammer', 'Deployer has shipped a honeypot before',
      'The same creator address is linked to a previous honeypot.'));

  // A transfer hook runs deployer-controlled code on every transfer. Tolerable
  // only when provably not upgradable; "unknown" upgradability is not tolerable.
  if (f.transferHook === true && f.transferHookUpgradable !== false)
    out.push(veto('transfer-hook', 'Upgradable transfer hook',
      'Arbitrary deployer code runs on every transfer and can be changed after you buy.'));

  if (f.topHolderPct !== 'unknown' && f.topHolderPct > s.maxTopHolderPct)
    out.push(veto('whale-concentration', `Top wallet holds ${pctStr(f.topHolderPct)}`,
      `Above the ${s.maxTopHolderPct}% limit. One wallet can exit into your liquidity.`));

  if (f.lpLockedPct !== 'unknown' && f.lpLockedPct < s.minLpLockedPct)
    out.push(veto('lp-unlocked', `LP only ${pctStr(f.lpLockedPct)} locked`,
      `Below the ${s.minLpLockedPct}% floor. Unlocked liquidity can be withdrawn at any moment.`));

  // The most important rule in the file: total absence of security data is a
  // reason to refuse, not a reason to shrug. An unindexed token is usually a
  // token that is minutes old, which is exactly when rugs happen.
  if (ctx.providersOk === 0)
    out.push(veto('no-security-data', 'No security data',
      'Every security provider failed or has not indexed this token. Nothing here has been verified.'));

  return out;
}

/**
 * Weighted penalties. `weight` is subtracted from 100. Negative weights are
 * credits, capped tightly -- there is no configuration of good news that makes
 * a memecoin trustworthy, only less obviously doomed.
 */
function weightedRules(ctx: RuleContext): Signal[] {
  const f = ctx.facts;
  const m = ctx.market;
  const s = config.safety;
  const out: Signal[] = [];

  // ---- unknowns are risk, priced explicitly ----
  const criticalUnknowns: [keyof TokenFacts, string, number][] = [
    ['honeypot', 'honeypot status', 12],
    ['mintAuthorityActive', 'mint authority', 14],
    ['freezeAuthorityActive', 'freeze authority', 14],
    ['lpLockedPct', 'LP lock status', 12],
    ['topHolderPct', 'holder concentration', 10],
    ['sellTaxPct', 'sell tax', 8],
  ];
  for (const [key, label, w] of criticalUnknowns) {
    if (f[key] === 'unknown') {
      out.push(sig(`unknown-${String(key)}`, 'high', w, `Unverified: ${label}`,
        `No provider could confirm ${label}. Treated as risk, not as a pass.`));
    }
  }

  // ---- distribution ----
  if (f.top10Pct !== 'unknown' && f.top10Pct > s.maxTop10Pct) {
    out.push(sig('top10', 'high', Math.min(30, (f.top10Pct - s.maxTop10Pct) * 0.8),
      `Top 10 wallets hold ${pctStr(f.top10Pct)}`,
      `Above the ${s.maxTop10Pct}% comfort line; coordinated exit would erase the price.`));
  }
  if (f.creatorPct !== 'unknown' && f.creatorPct > s.maxCreatorPct) {
    out.push(sig('creator-bag', 'high', Math.min(25, (f.creatorPct - s.maxCreatorPct) * 1.2),
      `Deployer holds ${pctStr(f.creatorPct)}`, 'The creator retains a large sellable position.'));
  }
  // Insider/bundled wallets. Sized by how much supply the cluster actually
  // controls, not by the bare fact that a cluster exists: on a mature token
  // "17,000 accounts linked by transfers" is just the token being used, and a
  // flat penalty there fires on every established name. What matters is a
  // cluster that holds enough supply to dump on you.
  if (f.insiderPct !== 'unknown' && f.insiderPct >= 1) {
    const w = Math.min(30, f.insiderPct * 1.1);
    out.push(sig('insiders', f.insiderPct > s.maxInsiderPct ? 'critical' : 'high', w,
      `Bundled insider wallets hold ${pctStr(f.insiderPct)}`,
      'Multiple holders funded from one source — the signature of a sniped or bundled launch.'));
  } else if (f.insiderNetworkDetected === true && f.insiderPct === 'unknown') {
    // A cluster exists but nobody could size it. Penalise the uncertainty, and
    // scale it against the holder base when we know one.
    const size = f.insiderNetworkSize;
    const holders = f.holderCount;
    let w = 12;
    let detail = 'A linked-wallet cluster was detected but its share of supply could not be measured.';
    if (size !== 'unknown' && holders !== 'unknown' && holders > 0) {
      const share = size / holders;
      w = share > 0.3 ? 20 : share > 0.05 ? 12 : 5;
      detail = `Cluster spans ${size.toLocaleString()} of ${holders.toLocaleString()} holders (${(share * 100).toFixed(0)}%).`;
    }
    out.push(sig('insider-network', 'medium', w, 'Linked-wallet cluster detected', detail));
  }

  if (f.holderCount !== 'unknown' && f.holderCount < s.minHolderCount) {
    out.push(sig('few-holders', 'medium', Math.min(18, (s.minHolderCount - f.holderCount) * 0.25),
      `Only ${f.holderCount} holders`, 'Thin holder base is trivially manipulated.'));
  }

  // ---- contract surface ----
  if (f.isProxy === true)
    out.push(sig('proxy', 'high', 16, 'Upgradable proxy', 'Contract logic can be replaced after you buy.'));
  if (f.metadataMutable === true)
    out.push(sig('metadata-mutable', 'low', 4, 'Metadata mutable',
      'Name, symbol and image can be rewritten — common in impersonation swaps.'));
  if (f.transferFeePct !== 'unknown' && f.transferFeePct > 0)
    out.push(sig('transfer-fee', 'medium', Math.min(20, f.transferFeePct * 1.5),
      `Transfer fee ${pctStr(f.transferFeePct)}`, 'Every transfer is taxed at the token level.'));
  if (f.transferFeeUpgradable === true)
    out.push(sig('fee-upgradable', 'high', 15, 'Transfer fee is upgradable',
      'The fee can be raised after you are in.'));
  if (f.lpBurned === true)
    out.push(sig('lp-burned', 'positive', -6, 'LP burned', 'Liquidity tokens sent to a burn address.'));
  if (f.mintAuthorityActive === false && f.freezeAuthorityActive === false)
    out.push(sig('authorities-revoked', 'positive', -8, 'Mint and freeze revoked',
      'Confirmed on chain. Removes the two fastest rug mechanisms — not the others.'));

  // ---- liquidity and market structure ----
  if (m.liquidityUsd === undefined) {
    out.push(sig('liquidity-unknown', 'medium', 10, 'Liquidity not reported',
      'No pool depth published (typical pre-migration bonding curve). Exit depth unverified.'));
  } else {
    if (m.liquidityUsd < 5_000)
      out.push(sig('liquidity-thin', 'high', 20, `Liquidity ${usd(m.liquidityUsd)}`,
        'Any meaningful sell moves the price against you badly.'));
    else if (m.liquidityUsd < 20_000)
      out.push(sig('liquidity-low', 'medium', 10, `Liquidity ${usd(m.liquidityUsd)}`, 'Shallow pool.'));

    // A market cap far above the pool it trades against is a paper valuation.
    if (m.marketCapUsd && m.liquidityUsd > 0) {
      const ratio = m.marketCapUsd / m.liquidityUsd;
      if (ratio > 25)
        out.push(sig('mc-liq-ratio', 'high', Math.min(22, (ratio - 25) * 0.4),
          `Market cap is ${ratio.toFixed(0)}x liquidity`,
          'The valuation is not backed by exitable depth.'));
    }
  }

  // ---- age ----
  const age = m.ageMinutes;
  if (age !== undefined) {
    if (age < 15)
      out.push(sig('brand-new', 'high', 18, `${age.toFixed(0)} minutes old`,
        'Most rugs happen inside the first hour, before any provider has indexed the token.'));
    else if (age < 60)
      out.push(sig('very-new', 'medium', 10, `${age.toFixed(0)} minutes old`, 'Still inside the highest-risk window.'));
    else if (age > 60 * 24 * 7)
      out.push(sig('survived', 'positive', -5, `${(age / 1440).toFixed(0)} days old`,
        'Has survived past the window where most rugs fire.'));
  }

  // ---- trading behaviour ----
  const h1 = m.txns.h1;
  if (h1 && h1.buys + h1.sells > 20) {
    const sellShare = h1.sells / (h1.buys + h1.sells);
    if (sellShare > 0.65)
      out.push(sig('sell-pressure', 'medium', Math.min(15, (sellShare - 0.65) * 60),
        `${(sellShare * 100).toFixed(0)}% of 1h trades are sells`, 'Distribution is under way.'));
  }
  const ch = m.priceChange.h1;
  if (ch !== undefined && ch < -40)
    out.push(sig('dumping', 'high', Math.min(20, Math.abs(ch) * 0.25),
      `Down ${Math.abs(ch).toFixed(0)}% in the last hour`, 'Active dump in progress.'));

  // Volume with almost no holders is usually wash trading between few wallets.
  const v24 = m.volume.h24;
  if (v24 !== undefined && f.holderCount !== 'unknown' && f.holderCount > 0 && v24 > 50_000 && f.holderCount < 100)
    out.push(sig('wash-suspect', 'high', 16, `${usd(v24)} volume across only ${f.holderCount} holders`,
      'Volume-to-holder ratio consistent with wash trading.'));

  // ---- presentation ----
  if (m.socials.length === 0)
    out.push(sig('no-socials', 'medium', 8, 'No socials published', 'No public presence attached to the pair.'));
  if (m.boosted === true)
    out.push(sig('paid-boost', 'low', 5, 'Paid DexScreener boost',
      'Promotion was bought. Neutral on its own, common in pump-and-dump scheduling.'));

  return out;
}

export function evaluate(ctx: RuleContext): RuleOutput {
  return { vetoes: vetoRules(ctx), signals: weightedRules(ctx) };
}

export const _internal = { vetoRules, weightedRules };
