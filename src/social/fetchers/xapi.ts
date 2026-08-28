import { config } from '../../config.js';
import { getJson } from '../../util/http.js';
import type { Mention, TokenRef } from '../../types.js';
import type { FetchResult, MentionFetcher } from './types.js';

const BASE = 'https://api.x.com/2';

interface XUser {
  id: string; username: string; name?: string; verified?: boolean;
  created_at?: string;
  public_metrics?: { followers_count?: number; following_count?: number; tweet_count?: number };
}
interface XTweet { id: string; text: string; created_at?: string; author_id?: string }
interface XSearch { data?: XTweet[]; includes?: { users?: XUser[] }; errors?: unknown[]; title?: string; detail?: string }

/**
 * X API v2 recent search. Inert unless X_BEARER_TOKEN is set.
 *
 * This is kept in the tree because it is a drop-in upgrade: the classifier does
 * not care where mentions come from, so adding a token turns live search on
 * without touching anything else. Recent search on the free tier does not return
 * results -- it needs at least Basic.
 */
export class XApiFetcher implements MentionFetcher {
  name = 'x-api';

  available(): boolean {
    return config.xBearerToken.length > 0;
  }

  async fetch(ref: TokenRef, symbol?: string): Promise<FetchResult> {
    if (!this.available()) {
      return { unavailable: 'X_BEARER_TOKEN not set' };
    }
    const terms = [ref.address];
    if (symbol) terms.push(`$${symbol}`);
    const query = `(${terms.map((t) => `"${t}"`).join(' OR ')}) -is:retweet`;

    const url = `${BASE}/tweets/search/recent?query=${encodeURIComponent(query)}` +
      `&max_results=100&tweet.fields=created_at,author_id` +
      `&expansions=author_id&user.fields=public_metrics,created_at,verified`;

    try {
      const res = await getJson<XSearch>(url, {
        headers: { authorization: `Bearer ${config.xBearerToken}` },
        cacheTtlMs: 60_000,
      });
      if (res.detail && !res.data) return { unavailable: `X API: ${res.detail}` };

      const users = new Map<string, XUser>();
      for (const u of res.includes?.users ?? []) users.set(u.id, u);

      const mentions: Mention[] = (res.data ?? []).map((t) => {
        const u = t.author_id ? users.get(t.author_id) : undefined;
        return {
          id: t.id,
          handle: u?.username ?? t.author_id ?? 'unknown',
          text: t.text,
          createdAt: t.created_at ? Date.parse(t.created_at) : Date.now(),
          followers: u?.public_metrics?.followers_count,
          following: u?.public_metrics?.following_count,
          postCount: u?.public_metrics?.tweet_count,
          accountCreatedAt: u?.created_at ? Date.parse(u.created_at) : undefined,
          verified: u?.verified,
          url: u ? `https://x.com/${u.username}/status/${t.id}` : undefined,
        };
      });
      return { mentions };
    } catch (err) {
      return { unavailable: `X API request failed: ${String(err instanceof Error ? err.message : err)}` };
    }
  }
}
