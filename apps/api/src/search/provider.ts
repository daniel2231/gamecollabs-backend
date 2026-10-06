import { queryTokens } from "../lib/text.js";

/**
 * Keyword search sits behind this interface so the self-hosted token index can
 * be swapped (e.g. for Atlas Search with `lucene.korean`) without touching callers.
 */
export interface SearchProvider {
  /** A filter matching `q`, `null` when `q` has no searchable tokens. */
  filter(q: string): Record<string, unknown> | null;
}

/** Matches documents whose `searchTokens` contain every query token (Hangul 2-grams, word prefixes). */
export class TokenSearchProvider implements SearchProvider {
  constructor(private readonly field = "searchTokens") {}

  filter(q: string): Record<string, unknown> | null {
    const tokens = queryTokens(q);
    return tokens.length ? { [this.field]: { $all: tokens } } : null;
  }
}

export const search: SearchProvider = new TokenSearchProvider();
