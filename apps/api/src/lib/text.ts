/** NFKC, lowercase, diacritics removed (Pokémon → pokemon). */
export function normalizeText(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFKC")
    .toLowerCase();
}

/** Key used to compare names and aliases: normalized with spaces and punctuation removed. */
export function nameKey(input: string): string {
  return normalizeText(input).replace(/[\s\p{P}\p{S}]+/gu, "");
}

const CJK = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu;
const WORD = /[\p{L}\p{N}]+/gu;
const MAX_PREFIX = 20;

/**
 * Search tokens: CJK runs become 2-grams (a single character stays a 1-gram),
 * other words become lowercase words plus their prefixes (from 2 characters).
 */
export function indexTokens(...texts: (string | null | undefined)[]): string[] {
  const tokens = new Set<string>();
  for (const raw of texts) {
    if (!raw) continue;
    const text = normalizeText(raw);
    for (const run of text.match(CJK) ?? []) addGrams(run, tokens);
    const latin = text.replace(CJK, " ");
    for (const word of latin.match(WORD) ?? []) {
      tokens.add(word);
      for (let n = 2; n < Math.min(word.length, MAX_PREFIX); n++) tokens.add(word.slice(0, n));
    }
  }
  return [...tokens];
}

/** Tokens a query must all match. Words are matched as prefixes (indexed as such). */
export function queryTokens(query: string): string[] {
  const tokens = new Set<string>();
  const text = normalizeText(query);
  for (const run of text.match(CJK) ?? []) addGrams(run, tokens);
  const latin = text.replace(CJK, " ");
  for (const word of latin.match(WORD) ?? []) tokens.add(word.slice(0, MAX_PREFIX - 1));
  return [...tokens];
}

function addGrams(run: string, out: Set<string>): void {
  const chars = [...run];
  if (chars.length === 1) {
    out.add(chars[0]!);
    return;
  }
  for (let i = 0; i < chars.length - 1; i++) out.add(chars[i]! + chars[i + 1]!);
}

/** ASCII kebab-case slug; returns "" when nothing ASCII is left (e.g. Korean only). */
export function slugify(input: string): string {
  return normalizeText(input)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
