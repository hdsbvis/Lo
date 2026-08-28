#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assessToken, resolveToken } from '../assess.js';
import { screen } from '../discovery/scanner.js';
import { pool } from '../util/http.js';
import { c, log, setVerbose } from '../util/log.js';
import * as store from '../store/snapshots.js';
import { DISCLAIMER, renderFull, renderRow, ROW_HEADER } from './render.js';
import type { SocialMode } from '../social/index.js';
import type { TokenAssessment } from '../types.js';

export interface Args {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Single-dash shorthands, expanded to their long names. */
const SHORT_FLAGS: Record<string, string> = { v: 'verbose', h: 'help', j: 'json' };

export function parseArgs(argv: string[]): Args {
  const [cmd = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const next = rest[i + 1];
        // A value may be negative, so only a long flag terminates the pair.
        if (next !== undefined && !next.startsWith('--')) { flags[a.slice(2)] = next; i++; }
        else flags[a.slice(2)] = true;
      }
    } else if (/^-[A-Za-z]+$/.test(a)) {
      // Short flags are boolean only. Without this branch `-v` fell through to
      // the positional list and got resolved as a token symbol, so `watch -v`
      // silently watched a token nobody asked for.
      for (const ch of a.slice(1)) flags[SHORT_FLAGS[ch] ?? ch] = true;
    } else positional.push(a);
  }
  return { cmd, positional, flags };
}

const numFlag = (f: Args['flags'], k: string): number | undefined => {
  const v = f[k];
  if (v === undefined || typeof v === 'boolean') return undefined;
  const n = Number(v.replace(/[_,]/g, ''));
  return Number.isFinite(n) ? n : undefined;
};

const socialMode = (f: Args['flags']): SocialMode => {
  const v = f['social'];
  if (v === 'off' || v === 'manual' || v === 'x-api' || v === 'auto') return v;
  return 'auto';
};

const HELP = `
${c.bold('rugwatch')} — low-cap memecoin scanner with a distrust-by-default safety engine

${c.bold('COMMANDS')}
  scan                    Find low-market-cap tokens and rank them by risk
  check <address|symbol>  Full assessment of one token
  watch [address...]      Re-check on an interval and alert on adverse changes
  serve                   Local dashboard on http://localhost:8787
  history <address>       Print the recorded score history for a token

${c.bold('SCAN FLAGS')}
  --min-mc <usd>          Minimum market cap (default 5000)
  --max-mc <usd>          Maximum market cap (default 300000)
  --min-liq <usd>         Minimum reported liquidity (default 3000)
  --max-age <minutes>     Newest launch window (default 4320 = 3 days)
  --min-age <minutes>     Skip tokens younger than this (default 5)
  --min-vol <usd>         Minimum 24h volume (default 5000)
  --chains <a,b>          Chains to scan (default solana,base,ethereum,bsc)
  --limit <n>             Max tokens to assess (default 25)
  --only-watchable        Hide everything the engine disqualified

${c.bold('COMMON FLAGS')}
  --chain <name>          Disambiguate a symbol lookup
  --social <mode>         auto | manual | x-api | off
  --json                  Machine-readable output
  --verbose, -v           Show every finding and its explanation
  --interval <seconds>    watch: seconds between passes (default 120)

${c.bold('EXAMPLES')}
  npm run scan -- --max-mc 100000 --chains solana --limit 15
  npm run check -- 7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr
  npm run watch -- --interval 60
`;

async function cmdScan(args: Args): Promise<void> {
  const limit = numFlag(args.flags, 'limit') ?? 25;
  const chains = typeof args.flags['chains'] === 'string'
    ? (args.flags['chains'] as string).split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  log.info(c.grey('scanning discovery feeds…'));
  const report = await screen({
    minMarketCapUsd: numFlag(args.flags, 'min-mc'),
    maxMarketCapUsd: numFlag(args.flags, 'max-mc'),
    minLiquidityUsd: numFlag(args.flags, 'min-liq'),
    minAgeMinutes: numFlag(args.flags, 'min-age'),
    maxAgeMinutes: numFlag(args.flags, 'max-age'),
    minVolume24hUsd: numFlag(args.flags, 'min-vol'),
    chains,
    limit,
  });

  if (report.candidates.length === 0) {
    log.info(c.yellow(`\nNo tokens matched. Examined ${report.examined} from the discovery feeds.`));
    const top = Object.entries(report.rejected).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (top.length) log.info(c.grey('Main rejection reasons: ' + top.map(([k, v]) => `${k} (${v})`).join(', ')));
    log.info(c.grey('Try widening: --max-mc 1000000 --min-vol 0 --min-liq 0'));
    return;
  }

  log.info(c.grey(`assessing ${report.candidates.length} candidates (of ${report.examined} examined)…\n`));

  const mode = socialMode(args.flags);
  const assessed = await pool(report.candidates, 3, async (cand) =>
    assessToken(cand.ref, { market: cand.market, social: mode }).catch((err) => {
      log.debug('assessment failed:', String(err));
      return null;
    }),
  );

  let rows = assessed.filter((a): a is TokenAssessment => a !== null);
  if (args.flags['only-watchable']) {
    rows = rows.filter((a) => a.safety.verdict === 'WATCH' || a.safety.verdict === 'ELEVATED_RISK');
  }
  // Least-bad first.
  rows.sort((a, b) => b.safety.score - a.safety.score);

  if (args.flags['json']) {
    log.out(JSON.stringify(rows, null, 2));
    return;
  }

  log.out(c.bold(ROW_HEADER));
  log.out(c.grey('─'.repeat(110)));
  for (const r of rows) log.out(renderRow(r));

  const disq = rows.filter((r) => r.safety.verdict === 'AVOID').length;
  log.out('');
  log.out(c.grey(`${rows.length} assessed · ${disq} disqualified outright · ` +
    `${rows.filter((r) => r.safety.verdict === 'WATCH').length} watchable`));
  log.out('');
  log.out(DISCLAIMER);
}

async function cmdCheck(args: Args): Promise<void> {
  const query = args.positional[0];
  if (!query) { log.error('usage: check <address|symbol>'); process.exitCode = 1; return; }

  const chainHint = typeof args.flags['chain'] === 'string' ? (args.flags['chain'] as string) : undefined;
  const ref = await resolveToken(query, chainHint);
  if (!ref) {
    log.error(`could not resolve "${query}". Pass a contract address, or add --chain.`);
    process.exitCode = 1;
    return;
  }

  const a = await assessToken(ref, { social: socialMode(args.flags) });
  if (args.flags['json']) { log.out(JSON.stringify(a, null, 2)); return; }

  const verbose = Boolean(args.flags['verbose']);
  log.out(renderFull(a, { verbose }));
  log.out('');
  log.out(DISCLAIMER);
}

async function cmdWatch(args: Args): Promise<void> {
  const interval = (numFlag(args.flags, 'interval') ?? 120) * 1000;
  const mode = socialMode(args.flags);

  let targets = args.positional;
  if (targets.length === 0) {
    targets = store.tracked().slice(0, 20).map((t) => t.address);
    if (targets.length === 0) {
      log.error('nothing to watch. Pass addresses, or run `scan` first to build a history.');
      process.exitCode = 1;
      return;
    }
    log.info(c.grey(`watching ${targets.length} previously seen tokens`));
  }

  const refs = (await Promise.all(targets.map((t) => resolveToken(t).catch(() => null))))
    .filter((r): r is NonNullable<typeof r> => r !== null);

  log.info(c.grey(`watching ${refs.length} tokens every ${interval / 1000}s. Ctrl-C to stop.\n`));

  let stop = false;
  process.on('SIGINT', () => { stop = true; log.info(c.grey('\nstopping…')); });

  while (!stop) {
    const at = new Date().toLocaleTimeString();
    for (const ref of refs) {
      try {
        const a = await assessToken(ref, { social: mode });
        const sym = a.token.symbol ?? a.token.address.slice(0, 8);
        if (a.safety.shocks.length > 0) {
          log.out(`${c.grey(at)} ${c.bgRed(' ALERT ')} ${c.bold(sym)} — ${a.safety.shocks.map((s) => s.title).join('; ')}`);
          log.out(`         score ${a.safety.score} (was ${a.safety.rawScore} raw)`);
        } else {
          log.out(`${c.grey(at)} ${sym.padEnd(10)} ${String(a.safety.score).padStart(3)} ${a.safety.verdict}`);
        }
      } catch (err) {
        log.debug('watch pass failed:', String(err));
      }
      if (stop) break;
    }
    if (stop) break;
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function cmdHistory(args: Args): Promise<void> {
  const addr = args.positional[0];
  if (!addr) { log.error('usage: history <address>'); process.exitCode = 1; return; }
  const ref = await resolveToken(addr).catch(() => null);
  const rows = store.history(ref?.chain ?? 'solana', ref?.address ?? addr);
  if (rows.length === 0) { log.info('no recorded history for this token yet'); return; }
  if (args.flags['json']) { log.out(JSON.stringify(rows, null, 2)); return; }
  log.out(c.bold('TIME                  SCORE  VERDICT         MC        LIQ'));
  for (const r of rows) {
    log.out(`${new Date(r.at).toISOString().slice(0, 19)}  ${String(r.score).padStart(5)}  ` +
      `${r.verdict.padEnd(14)}  ${r.marketCapUsd ? '$' + Math.round(r.marketCapUsd).toLocaleString() : '—'}` +
      `  ${r.liquidityUsd ? '$' + Math.round(r.liquidityUsd).toLocaleString() : '—'}`);
  }
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags['verbose']) setVerbose(true);

  switch (args.cmd) {
    case 'scan': return cmdScan(args);
    case 'check': return cmdCheck(args);
    case 'watch': return cmdWatch(args);
    case 'history': return cmdHistory(args);
    case 'serve': {
      const { serve } = await import('../server/server.js');
      return serve();
    }
    case 'help': case '--help': case '-h':
      log.out(HELP);
      return;
    default:
      if (args.flags['help']) { log.out(HELP); return; }
      log.error(`unknown command "${args.cmd}"`);
      log.out(HELP);
      process.exitCode = 1;
  }
}

export function run(): void {
  main().catch((err) => {
    log.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  });
}

/**
 * Only drive the CLI when this module is what was executed. Without the guard,
 * importing anything from here (the tests import parseArgs) runs main() against
 * the host process's argv and prints the help text as a side effect.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) run();
