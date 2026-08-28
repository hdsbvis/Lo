import type { Mention, TokenRef } from '../../types.js';

export interface FetchResult {
  mentions?: Mention[];
  /** Set when mentions could not be collected. Surfaced to the user verbatim. */
  unavailable?: string;
}

export interface MentionFetcher {
  name: string;
  available(): boolean;
  fetch(ref: TokenRef, symbol?: string): Promise<FetchResult>;
}
