/**
 * Keyword scoring over the skill and MCP-group indexes.
 *
 * Deliberately dumb: a few dozen short descriptions do not need embeddings,
 * and a keyword hit is what the model is reaching for anyway. Shared by the
 * router (which unions its picks with the obvious matches, so a plainly
 * relevant skill cannot go missing because a small model overlooked it) and by
 * query_skills / query_mcps, so both rank the same way.
 */

/** Words of a haystack, lowercased; punctuation is a separator. */
export const words = (s: string): string[] =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Below this length a term matches everything and means nothing ("a", "to"). */
const MIN_TERM = 3;

/** Whole words, plus a prefix hit so "deploys" still finds "deploy". */
const hasTerm = (haystack: Set<string>, term: string): boolean => {
  if (haystack.has(term)) return true;
  if (term.length < 4) return false;
  for (const w of haystack) if (w.startsWith(term) || term.startsWith(w)) return true;
  return false;
};

/**
 * Overlap score of a query against a document. A term hit in the title counts
 * double — "the skill called deploy" beats "a skill that mentions deploy".
 *
 * Words, never substrings: a plain `includes` made every short word in a
 * sentence ("a", "in") match every entry in the index, which turns a search
 * into a shuffle and, in the router, adds the whole index to every prompt.
 */
export function score(query: string, title: string, body: string): number {
  const terms = [...new Set(words(query))].filter((t) => t.length >= MIN_TERM);
  if (terms.length === 0) return 0;
  const titleWords = new Set(words(title));
  const bodyWords = new Set(words(body));
  let hits = 0;
  for (const term of terms) {
    if (hasTerm(titleWords, term)) hits += 2;
    else if (hasTerm(bodyWords, term)) hits += 1;
  }
  return hits;
}

/** The `limit` best matches of `items` for `query`, best first, misses dropped. */
export function bestMatches<T>(
  query: string,
  items: T[],
  of: (item: T) => { title: string; body: string },
  limit: number,
): T[] {
  return items
    .map((item) => {
      const { title, body } = of(item);
      return { item, s: score(query, title, body) };
    })
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((r) => r.item);
}
