import { c } from '../util/log.js';
import { verdictLabel } from '../safety/engine.js';
import type { SafetyResult, TokenAssessment, Verdict, SocialResult } from '../types.js';

export const usd = (v?: number): string => {
  if (v === undefined) return '—';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
};

export const age = (min?: number): string => {
  if (min === undefined) return '—';
  if (min < 60) return `${min.toFixed(0)}m`;
  if (min < 1440) return `${(min / 60).toFixed(1)}h`;
  return `${(min / 1440).toFixed(0)}d`;
};

export function verdictBadge(v: Verdict): string {
  const t = ` ${verdictLabel(v)} `;
  switch (v) {
    case 'AVOID': return c.bgRed(t);
    case 'DANGER': return c.red(t);
    case 'HIGH_RISK': return c.yellow(t);
    case 'ELEVATED_RISK': return c.yellow(t);
    case 'WATCH': return c.bgGreen(t);
    case 'UNRATED': return c.grey(t);
  }
}

export function scoreBar(score: number, width = 20): string {
  const filled = Math.round((score / 100) * width);
  const bar = '█'.repeat(filled) + '·'.repeat(width - filled);
  const color = score >= 75 ? c.green : score >= 55 ? c.yellow : score >= 35 ? c.yellow : c.red;
  return color(bar);
}

const sevColor: Record<string, (s: string) => string> = {
  veto: c.bgRed, critical: c.red, high: c.red, medium: c.yellow, low: c.grey, info: c.grey, positive: c.green,
};

export function renderSafety(s: SafetyResult, opts: { verbose?: boolean } = {}): string {
  const lines: string[] = [];

  lines.push(`${verdictBadge(s.verdict)}  score ${c.bold(String(s.score))}/100  ${scoreBar(s.score)}`);
  const conf = `${(s.confidence * 100).toFixed(0)}%`;
  const okCount = s.providers.filter((p) => p.ok).length;
  lines.push(c.grey(`  confidence ${conf} (${okCount}/${s.providers.length} providers)  ·  data age ${s.dataAgeSec}s`));
  if (s.rawScore !== s.score) {
    lines.push(c.grey(`  raw ${s.rawScore} → ${s.score} after volatility adjustment`));
  }

  if (s.shocks.length > 0) {
    lines.push('');
    lines.push(c.bgRed(' CHANGED SINCE LAST CHECK '));
    for (const sh of s.shocks) {
      lines.push(`  ${c.red('▼')} ${c.bold(sh.title)}`);
      lines.push(`     ${c.grey(sh.detail)}`);
    }
  }

  if (s.vetoes.length > 0) {
    lines.push('');
    lines.push(c.bgRed(` ${s.vetoes.length} DISQUALIFYING ${s.vetoes.length === 1 ? 'FINDING' : 'FINDINGS'} `));
    for (const v of s.vetoes) {
      lines.push(`  ${c.red('✗')} ${c.bold(v.title)}`);
      lines.push(`     ${c.grey(v.detail)}`);
    }
  }

  const shown = opts.verbose ? s.signals : s.signals.filter((x) => Math.abs(x.weight) >= 4);
  if (shown.length > 0) {
    lines.push('');
    lines.push(c.bold('  Findings'));
    for (const g of shown) {
      const paint = sevColor[g.severity] ?? ((x: string) => x);
      const mark = g.weight < 0 ? c.green('+') : paint('−');
      const w = g.weight < 0 ? c.green(`+${Math.abs(g.weight).toFixed(0)}`) : c.grey(`-${g.weight.toFixed(0)}`);
      lines.push(`  ${mark} ${g.title} ${w}`);
      if (opts.verbose) lines.push(`     ${c.grey(g.detail)}`);
    }
  }

  const failed = s.providers.filter((p) => !p.ok);
  if (failed.length > 0) {
    lines.push('');
    lines.push(c.grey(`  providers unavailable: ${failed.map((f) => `${f.name} (${f.error?.slice(0, 60)})`).join(', ')}`));
  }

  return lines.join('\n');
}

export function renderSocial(s: SocialResult): string {
  const lines: string[] = [];
  lines.push(c.bold('  Who is talking'));

  if (s.status !== 'OK') {
    lines.push(`  ${c.grey('○')} ${s.summary}`);
    return lines.join('\n');
  }

  const tierColor: Record<string, (x: string) => string> = {
    WHALE: c.bgGreen, KOL: c.green, ALPHA: c.cyan, RETAIL: c.grey, NOBODY: c.grey, BOT: c.red,
  };
  const top = s.topTier ? (tierColor[s.topTier] ?? c.grey)(` ${s.topTier} `) : c.grey(' NONE ');
  lines.push(`  highest-credibility poster: ${top}`);

  if (s.coordinated) {
    lines.push(`  ${c.bgRed(' COORDINATED CAMPAIGN ')} ${s.coordinated.clusterSize} accounts, ` +
      `${(s.coordinated.medianSimilarity * 100).toFixed(0)}% identical copy in ${s.coordinated.windowMinutes}m`);
    lines.push(c.grey(`     ${s.coordinated.handles.slice(0, 8).map((h) => '@' + h).join(' ')}`));
  }

  for (const m of s.mentions.slice(0, 6)) {
    const paint = tierColor[m.tier] ?? c.grey;
    const hold = m.holdsToken ? c.green(` holds ${m.holdsToken.pct.toFixed(2)}%`) : '';
    lines.push(`  ${paint(m.tier.padEnd(6))} @${m.mention.handle}${hold} ${c.grey(`cred ${(m.credibility * 100).toFixed(0)}%`)}`);
    if (m.reasons[0]) lines.push(c.grey(`         ${m.reasons[0]}`));
  }
  if (s.mentions.length > 6) lines.push(c.grey(`  …and ${s.mentions.length - 6} more`));

  lines.push(c.grey(`  → ${s.summary}`));
  return lines.join('\n');
}

export function renderFull(a: TokenAssessment, opts: { verbose?: boolean } = {}): string {
  const t = a.token;
  const m = a.market;
  const head = `${c.bold(t.symbol ?? t.address.slice(0, 8))} ${c.grey(t.name ?? '')} ${c.grey(`[${t.chain}]`)}`;
  const lines = [
    '',
    head,
    c.grey(`  ${t.address}`),
    c.grey(`  MC ${usd(m.marketCapUsd)}  ·  liq ${m.liquidityUsd === undefined ? c.yellow('unreported') : usd(m.liquidityUsd)}` +
      `  ·  vol24 ${usd(m.volume.h24)}  ·  age ${age(m.ageMinutes)}` +
      (m.url ? `\n  ${m.url}` : '')),
    '',
    renderSafety(a.safety, opts),
    '',
    renderSocial(a.social),
  ];
  return lines.join('\n');
}

/** Compact one-line-per-token table for scan results. */
export function renderRow(a: TokenAssessment): string {
  const t = a.token;
  const sym = (t.symbol ?? t.address.slice(0, 6)).slice(0, 10).padEnd(10);
  const badge = verdictBadge(a.safety.verdict).padEnd(24);
  const sc = String(a.safety.score).padStart(3);
  const mc = usd(a.market.marketCapUsd).padStart(8);
  const liq = (a.market.liquidityUsd === undefined ? '—' : usd(a.market.liquidityUsd)).padStart(8);
  const ag = age(a.market.ageMinutes).padStart(5);
  const chain = t.chain.slice(0, 8).padEnd(8);
  const why = a.safety.vetoes[0]?.title ?? a.safety.signals.find((s) => s.weight > 8)?.title ?? '';
  const social = a.social.topTier && a.social.status === 'OK' ? ` ${c.cyan(a.social.topTier)}` : '';
  return `${sym} ${chain} ${badge} ${sc}  ${mc} ${liq} ${ag}  ${c.grey(why.slice(0, 38))}${social}`;
}

export const ROW_HEADER =
  `${'TOKEN'.padEnd(10)} ${'CHAIN'.padEnd(8)} ${'VERDICT'.padEnd(15)} ${'SCR'}  ${'MC'.padStart(8)} ${'LIQ'.padStart(8)} ${'AGE'.padStart(5)}  TOP FINDING`;

export const DISCLAIMER = c.grey(
  'This is a risk filter, not investment advice, and a clean score is not a\n' +
  'guarantee. Most low-cap memecoins go to zero even when nothing here fires.',
);
