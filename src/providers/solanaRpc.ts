import { getJson } from '../util/http.js';
import { config } from '../config.js';
import { emptyFacts, type TokenFacts, type HolderRow } from '../types.js';

interface RpcResp<T> { result?: T; error?: { code: number; message: string } }

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await getJson<RpcResp<T>>(config.solanaRpcUrl, {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method, params },
    cacheTtlMs: 10_000,
  });
  if (res.error) throw new Error(`RPC ${method}: ${res.error.message}`);
  if (res.result === undefined) throw new Error(`RPC ${method}: empty result`);
  return res.result;
}

interface ParsedMint {
  value?: {
    data?: {
      parsed?: {
        info?: {
          mintAuthority?: string | null;
          freezeAuthority?: string | null;
          supply?: string;
          decimals?: number;
          isInitialized?: boolean;
          extensions?: { extension?: string; state?: Record<string, unknown> }[];
        };
        type?: string;
      };
      program?: string;
    };
    owner?: string;
  };
}

interface LargestAccounts {
  value?: { address?: string; amount?: string; uiAmount?: number; decimals?: number }[];
}

/**
 * Reads mint/freeze authority and top holders straight off the chain.
 *
 * Third-party security APIs cache, and a mint authority reinstated two minutes
 * ago is exactly the kind of change that shows up on chain first. Where this
 * provider and an API disagree, the merge policy in facts.ts treats the chain
 * as authoritative for authority fields.
 */
export async function solanaChainFacts(mint: string): Promise<TokenFacts> {
  const f = emptyFacts();

  const acct = await rpc<ParsedMint>('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
  const info = acct.value?.data?.parsed?.info;
  if (!info) throw new Error('mint account not found or not an SPL mint');

  // Explicit null from a parsed mint means "revoked" -- that is a real `false`.
  f.mintAuthorityActive = info.mintAuthority ? true : info.mintAuthority === null ? false : 'unknown';
  f.freezeAuthorityActive = info.freezeAuthority ? true : info.freezeAuthority === null ? false : 'unknown';

  // Token-2022 extensions carry the genuinely dangerous switches.
  const exts = info.extensions ?? [];
  if (exts.length > 0 || acct.value?.owner) {
    const names = new Set(exts.map((e) => e.extension));
    f.transferHook = names.has('transferHook');
    const fee = exts.find((e) => e.extension === 'transferFeeConfig');
    if (fee) {
      const st = fee.state as any;
      const bp = Number(st?.newerTransferFee?.transferFeeBasisPoints ?? st?.olderTransferFee?.transferFeeBasisPoints);
      if (Number.isFinite(bp)) f.transferFeePct = bp / 100;
    }
    if (names.has('permanentDelegate')) f.balanceMutableAuthority = true;
    if (names.has('defaultAccountState')) f.freezeAuthorityActive = f.freezeAuthorityActive === false ? 'unknown' : f.freezeAuthorityActive;
  }

  const supply = Number(info.supply);
  const decimals = info.decimals ?? 0;
  if (Number.isFinite(supply) && supply > 0) {
    try {
      const largest = await rpc<LargestAccounts>('getTokenLargestAccounts', [mint]);
      const rows: HolderRow[] = [];
      for (const a of largest.value ?? []) {
        const amt = Number(a.amount);
        if (!Number.isFinite(amt)) continue;
        rows.push({ address: a.address ?? '', pct: (amt / supply) * 100 });
      }
      if (rows.length > 0) {
        // Rows are kept so roster whale wallets can be matched against them,
        // but no concentration figure is derived: getTokenLargestAccounts
        // includes the AMM/bonding-curve account and gives no way to label it,
        // so any top-holder number from here would really be the pool.
        // RugCheck supplies Solana concentration via its knownAccounts labels.
        f.topHolders = rows;
      }
    } catch {
      // Public RPC rate-limits this call aggressively; distribution stays unknown.
    }
  }
  void decimals;
  return f;
}
