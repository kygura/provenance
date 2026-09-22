/**
 * Turning the model's free-text `memeName` into a stable join key.
 *
 * The model picks a name per token, per run. "Nyan Cat", "nyan cat", "NyanCat",
 * "Nyan Cat (meme)" are one meme and four strings, so storing the string is
 * storing four memes. Without a key, the system cannot answer its own most
 * valuable question — "have I watched this meme run before?" — and has to ask
 * the web again on every token, throwing away the one kind of evidence nobody
 * else has: what happened last time it watched.
 *
 * The slug is deliberately lossy and deliberately conservative:
 *
 *  - lossy, because "Nyan Cat" and "nyan-cat" must collide;
 *  - conservative, because "Baby Doge" and "Doge" must NOT. They are different
 *    memes with different lineages, and merging them would fabricate precedent,
 *    which is worse than having none. So nothing is stemmed, nothing is
 *    substring-matched, and no word is dropped for being common.
 *
 * Normalization is `normalizeText` from `queries.ts` — the same NFKC fold and
 * confusable mapping used on tickers, so a Cyrillic 'а' in a meme name resolves
 * to the same meme as the Latin one rather than squatting a second row.
 */

import { normalizeText } from './queries';

/**
 * Parenthetical and bracketed qualifiers the model adds when disambiguating
 * ("Apu Apustaja (meme)", "Moon Man [4chan]"). They describe the name rather
 * than belonging to it, so they are dropped before slugging.
 */
const QUALIFIER = /\s*[([{][^)\]}]*[)\]}]\s*/g;

/** Leading articles carry no identity: "The Doge" and "Doge" are one meme. */
const LEADING_ARTICLE = /^(the|a|an)\s+/i;

/** Slug for a meme name, or '' when nothing usable survives normalization. */
export function memeSlug(name: string): string {
  const cleaned = normalizeText(name)
    .replace(QUALIFIER, ' ')
    .replace(LEADING_ARTICLE, '')
    .toLowerCase();

  const slug = cleaned
    // Apostrophes close up ("pepe's" -> "pepes"); everything else separates.
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // A slug long enough to be a paragraph is a model that answered the wrong
  // question. Truncating on a boundary keeps it a key rather than a sentence.
  if (slug.length <= 80) return slug;
  const cut = slug.slice(0, 80);
  const boundary = cut.lastIndexOf('-');
  return boundary > 40 ? cut.slice(0, boundary) : cut;
}

/**
 * Names the model uses when it could not identify a meme. These must never
 * become a canonical row: every unidentified token would collide into one
 * "unknown" meme and manufacture precedent out of ignorance.
 */
const NON_IDENTIFYING = new Set([
  'unknown',
  'unclear',
  'unidentified',
  'none',
  'n-a',
  'na',
  'null',
  'undefined',
  'unclassified',
  'no-meme',
  'not-applicable',
  'not-identified',
  'unnamed',
  'untitled',
]);

/**
 * Whether a slug is worth storing as a meme. Rejects the blank, the
 * non-identifying, and the single character — a one-character slug is almost
 * always a mangled ticker rather than a meme.
 */
export function isResolvableMeme(slug: string): boolean {
  if (slug.length < 2) return false;
  return !NON_IDENTIFYING.has(slug);
}

/** Slug plus the display form to store alongside it, or null if unresolvable. */
export function resolveMemeIdentity(
  name: string,
): { id: string; displayName: string } | null {
  const id = memeSlug(name);
  if (!isResolvableMeme(id)) return null;
  const displayName = normalizeText(name).replace(QUALIFIER, ' ').trim();
  return { id, displayName: displayName === '' ? name.trim() : displayName };
}
