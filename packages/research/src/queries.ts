/**
 * Query construction is the highest-leverage part of evidence collection: the
 * model can only reason over what we hand it, and a bad query ("$🐸🐸") returns
 * either nothing or noise. Everything here is pure and offline so the
 * adversarial ticker cases can be pinned down in tests.
 *
 * The governing rule: search for the MEME, not the TOKEN. A ticker is a
 * marketing surface; the meme behind it is what has (or has not) already worked.
 */

/** Confusable homoglyphs that scammers use to squat a real ticker. */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't',
  у: 'y', х: 'x', А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P',
  С: 'C', Т: 'T', У: 'Y', Х: 'X', і: 'i', ј: 'j', ѕ: 's',
  // Greek
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x',
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O',
  Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X',
  // Fullwidth latin is handled by NFKC; these are the leftovers people actually use.
  ℓ: 'l', і̇: 'i',
};

/**
 * Words that show up glued together in meme tickers. Only used to *offer* a
 * split variant — never to replace the original surface form, because the glued
 * spelling is often the canonical one ("dogwifhat", not "dog wif hat").
 */
export const MEME_LEXICON: readonly string[] = [
  'dog', 'doge', 'cat', 'frog', 'pepe', 'wojak', 'chad', 'inu', 'shib', 'shiba',
  'wif', 'hat', 'moon', 'rocket', 'baby', 'mini', 'mega', 'giga', 'based',
  'book', 'of', 'the', 'meme', 'coin', 'token', 'gold', 'silver', 'king',
  'queen', 'lord', 'god', 'boss', 'man', 'boy', 'girl', 'guy', 'bro', 'sir',
  'mr', 'ms', 'apu', 'apustaja', 'groyper', 'bonk', 'mog', 'brett', 'andy',
  'landwolf', 'toshi', 'keyboard', 'sad', 'happy', 'angry', 'crying', 'laugh',
  'nyan', 'grumpy', 'doom', 'wojak', 'trench', 'retard', 'ape', 'monkey',
  'banana', 'bear', 'bull', 'whale', 'fish', 'bird', 'duck', 'goose', 'owl',
  'snek', 'snake', 'wolf', 'fox', 'bunny', 'rabbit', 'turtle', 'hippo', 'moo',
];

/** Subreddits worth a restricted search: meme archaeology and crypto history. */
export const EVIDENCE_SUBREDDITS: readonly string[] = [
  'OutOfTheLoop',
  'memes',
  'dankmemes',
  'CryptoCurrency',
];

export interface QueryInput {
  symbol?: string | null;
  name?: string | null;
  /** Optional extra hint, e.g. the DexScreener description. */
  description?: string | null;
}

export interface QuerySet {
  /** Best guess at the meme's own name, in the form most likely to be indexed. */
  subject: string;
  /** Alternative surface forms worth searching (split spelling, ticker, name). */
  variants: string[];
  /** Queries aimed at dating and sourcing the meme. */
  meme: string[];
  /** Queries aimed at finding EARLIER tokenisations of the same meme. */
  priorTokenisations: string[];
  /** meme + priorTokenisations, deduped, in priority order. */
  all: string[];
  subreddits: readonly string[];
  /**
   * True when the inputs were too degenerate to build a meme query from
   * (pure emoji, a single letter, bare digits). Collectors should do less work
   * rather than search for garbage.
   */
  degraded: boolean;
  /** Why the input was degraded, for logs and report notes. */
  notes: string[];
}

/**
 * Codepoint ranges that carry no searchable text: general punctuation (which is
 * where ZWSP/ZWJ live), symbol and dingbat blocks, variation selectors, the
 * private use area, and the emoji planes. Scripts (Latin, Greek, Cyrillic, CJK,
 * Arabic, ...) are deliberately left alone — a non-Latin meme name is still a
 * meme name.
 */
const DROP_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x2000, 0x206f],
  [0x2100, 0x27bf],
  [0x2900, 0x2bff],
  [0xfe00, 0xfe0f],
  [0xe000, 0xf8ff],
  [0xfff0, 0xffff],
  [0x1f000, 0x1ffff],
];

function isDropped(code: number): boolean {
  return DROP_RANGES.some(([lo, hi]) => code >= lo && code <= hi);
}

/** NFKC-fold, map confusables to ASCII, drop emoji/ZWJ/control characters. */
export function normalizeText(raw: string): string {
  const folded = raw.normalize('NFKC');
  let out = '';
  for (const ch of folded) {
    const mapped = CONFUSABLES[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    if (isDropped(ch.codePointAt(0) ?? 0)) continue;
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Strip the `$` sigil and surrounding punctuation from a ticker. */
export function stripTicker(raw: string): string {
  return normalizeText(raw).replace(/^[$#@\s]+/, '').replace(/[\s.,:;!?]+$/, '').trim();
}

/**
 * Split on explicit separators, camelCase boundaries and letter/digit
 * boundaries. "DogWifHat_2" -> ["Dog","Wif","Hat","2"].
 */
export function splitOnBoundaries(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean);
}

/**
 * Greedy longest-match segmentation against the meme lexicon. Returns null
 * unless the WHOLE string is covered — a partial match ("dogwifxyz" ->
 * "dog wif xyz") is worse than leaving the glued form alone.
 */
export function segmentWithLexicon(raw: string, lexicon: readonly string[] = MEME_LEXICON): string[] | null {
  const word = raw.toLowerCase();
  if (word.length < 4) return null;
  const sorted = [...lexicon].sort((a, b) => b.length - a.length);
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < word.length) {
    const hit = sorted.find((candidate) => candidate.length >= 2 && word.startsWith(candidate, cursor));
    if (hit === undefined) return null;
    parts.push(hit);
    cursor += hit.length;
  }
  return parts.length >= 2 ? parts : null;
}

/** A phrase is usable as a meme search subject only if it carries information. */
export function isUsableSubject(text: string): boolean {
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (letters >= 3) return true;
  // Two-letter words ("gm", "wp") are marginal but searchable when paired with
  // the templates below; single letters and bare digits are not. A pure number
  // is never a meme subject on its own — it retrieves the number, not the meme.
  return letters === 2 && text.length <= 4;
}

function quoteIfMultiword(text: string): string {
  return text.includes(' ') ? `"${text}"` : text;
}

function pushUnique(target: string[], value: string): void {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return;
  if (!target.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) target.push(trimmed);
}

/**
 * Derive the search plan for one token. Ordering matters: collectors truncate,
 * so the queries most likely to date the meme come first.
 */
export function buildQueries(input: QueryInput): QuerySet {
  const notes: string[] = [];
  const rawSymbol = stripTicker(input.symbol ?? '');
  const rawName = normalizeText(input.name ?? '');

  if ((input.symbol ?? '').trim().length > 0 && rawSymbol.length === 0) {
    notes.push('ticker reduced to nothing after unicode/emoji normalization');
  }
  if ((input.name ?? '').trim().length > 0 && rawName.length === 0) {
    notes.push('name reduced to nothing after unicode/emoji normalization');
  }

  // The name is almost always the better meme handle; the ticker is an
  // abbreviation of it. Prefer the name, fall back to the ticker.
  const candidates: string[] = [];
  pushUnique(candidates, rawName);
  pushUnique(candidates, rawSymbol);

  const boundarySplits = candidates.flatMap((candidate) => {
    const parts = splitOnBoundaries(candidate);
    return parts.length > 1 ? [parts.join(' ')] : [];
  });
  const lexiconSplits = candidates.flatMap((candidate) => {
    const single = splitOnBoundaries(candidate);
    if (single.length !== 1) return [];
    const segmented = segmentWithLexicon(candidate);
    return segmented ? [segmented.join(' ')] : [];
  });

  const surfaceForms: string[] = [];
  for (const form of [...candidates, ...boundarySplits, ...lexiconSplits]) pushUnique(surfaceForms, form);

  const usable = surfaceForms.filter(isUsableSubject);
  const subject = usable[0] ?? '';
  const degraded = subject.length === 0;
  if (degraded) notes.push('no usable meme subject could be derived from symbol or name');

  const variants = usable.slice(1, 4);
  // Search at most two surface forms; more just burns rate limit on synonyms.
  const searchForms = usable.slice(0, 2);

  const meme: string[] = [];
  const priorTokenisations: string[] = [];

  for (const form of searchForms) {
    const q = quoteIfMultiword(form);
    pushUnique(meme, `${q} meme origin`);
    pushUnique(meme, `${q} know your meme`);
    pushUnique(meme, `${q} meme history`);
  }
  if (searchForms.length > 0) {
    const primary = quoteIfMultiword(searchForms[0] ?? '');
    pushUnique(meme, `${primary} meme first appeared year`);
    pushUnique(priorTokenisations, `${primary} coin previous`);
    pushUnique(priorTokenisations, `${primary} token 2021`);
    pushUnique(priorTokenisations, `${primary} memecoin earlier launch`);
    // The ticker itself is only useful for finding *other* tokens with the same
    // name, never for dating the meme.
    if (rawSymbol.length >= 2 && rawSymbol.toLowerCase() !== (searchForms[0] ?? '').toLowerCase()) {
      pushUnique(priorTokenisations, `"$${rawSymbol}" token history`);
    }
  }

  const all: string[] = [];
  for (const q of [...meme, ...priorTokenisations]) pushUnique(all, q);

  return {
    subject,
    variants,
    meme,
    priorTokenisations,
    all,
    subreddits: EVIDENCE_SUBREDDITS,
    degraded,
    notes,
  };
}
