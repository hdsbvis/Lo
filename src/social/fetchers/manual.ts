import { existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Mention, TokenRef } from '../../types.js';
import type { FetchResult, MentionFetcher } from './types.js';
import { log } from '../../util/log.js';

const DIR = resolve(process.cwd(), 'data/mentions');

/**
 * Reads posts you have collected yourself, from data/mentions/<address>.json
 * (or a shared all.json). This is the fetcher that works without paying X:
 * you supply the raw posts, the classifier does the judgement, which is the
 * part that actually needed building.
 *
 * Expected shape -- an array of:
 *   {
 *     "handle": "someaccount",
 *     "text": "full post text",
 *     "createdAt": "2026-08-28T10:00:00Z",   // or ms epoch
 *     "followers": 1200,                      // optional
 *     "following": 4000,                      // optional
 *     "accountCreatedAt": "2026-07-01",       // optional
 *     "verified": false,                      // optional
 *     "url": "https://x.com/..."              // optional
 *   }
 */
export class ManualFetcher implements MentionFetcher {
  name = 'manual';

  available(): boolean {
    return existsSync(DIR);
  }

  async fetch(ref: TokenRef): Promise<FetchResult> {
    if (!existsSync(DIR)) {
      mkdirSync(DIR, { recursive: true });
      return { unavailable: `no posts supplied (create ${DIR}/${ref.address}.json — see README)` };
    }

    const candidates = [
      join(DIR, `${ref.address}.json`),
      join(DIR, `${ref.address.toLowerCase()}.json`),
      ...(ref.symbol ? [join(DIR, `${ref.symbol.toLowerCase()}.json`)] : []),
      join(DIR, 'all.json'),
    ];
    const file = candidates.find((p) => existsSync(p));
    if (!file) {
      const have = readdirSync(DIR).filter((f) => f.endsWith('.json'));
      return {
        unavailable: `no posts supplied for ${ref.symbol ?? ref.address}` +
          (have.length ? ` (data/mentions holds: ${have.slice(0, 5).join(', ')})` : ''),
      };
    }

    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      const rows: any[] = Array.isArray(raw) ? raw : (raw.mentions ?? []);
      const mentions: Mention[] = [];
      for (const [i, r] of rows.entries()) {
        if (!r || typeof r.handle !== 'string' || typeof r.text !== 'string') continue;
        // all.json is shared across tokens, so filter it by address/symbol.
        if (file.endsWith('all.json')) {
          const hay = r.text.toLowerCase();
          const matchesAddr = hay.includes(ref.address.toLowerCase());
          const matchesSym = ref.symbol ? hay.includes(`$${ref.symbol.toLowerCase()}`) : false;
          if (!matchesAddr && !matchesSym) continue;
        }
        mentions.push({
          id: r.id ?? `${file}#${i}`,
          handle: r.handle.replace(/^@/, ''),
          text: r.text,
          createdAt: toMs(r.createdAt) ?? Date.now(),
          followers: numOrUndef(r.followers),
          following: numOrUndef(r.following),
          accountCreatedAt: toMs(r.accountCreatedAt),
          verified: typeof r.verified === 'boolean' ? r.verified : undefined,
          postCount: numOrUndef(r.postCount),
          url: typeof r.url === 'string' ? r.url : undefined,
        });
      }
      log.debug(`manual fetcher: ${mentions.length} posts from ${file}`);
      if (mentions.length === 0) return { mentions: [], unavailable: `${file} contained no usable posts` };
      return { mentions };
    } catch (err) {
      return { unavailable: `could not read ${file}: ${String(err)}` };
    }
  }
}

function toMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}
const numOrUndef = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
