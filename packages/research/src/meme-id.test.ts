import { describe, expect, test } from 'bun:test';
import { isResolvableMeme, memeSlug, resolveMemeIdentity } from './meme-id';

describe('memeSlug collapses spellings of one meme', () => {
  test('case and spacing do not make new memes', () => {
    const forms = ['Nyan Cat', 'nyan cat', 'NYAN CAT', 'nyan-cat', 'Nyan  Cat', '  Nyan Cat  '];
    expect(new Set(forms.map(memeSlug)).size).toBe(1);
    expect(memeSlug('Nyan Cat')).toBe('nyan-cat');
  });

  test('drops a parenthetical qualifier', () => {
    expect(memeSlug('Apu Apustaja (meme)')).toBe(memeSlug('Apu Apustaja'));
    expect(memeSlug('Moon Man [4chan]')).toBe(memeSlug('Moon Man'));
  });

  test('drops a leading article', () => {
    expect(memeSlug('The Doge')).toBe(memeSlug('Doge'));
    expect(memeSlug('A Wojak')).toBe(memeSlug('Wojak'));
  });

  test('closes up apostrophes rather than splitting on them', () => {
    expect(memeSlug("Pepe's Frog")).toBe('pepes-frog');
    expect(memeSlug('Pepe’s Frog')).toBe('pepes-frog');
  });

  test('folds confusables, so a homoglyph squat resolves to the real meme', () => {
    // Cyrillic 'о' in place of Latin 'o'.
    expect(memeSlug('Dоge')).toBe(memeSlug('Doge'));
  });

  test('strips emoji without leaving separator debris', () => {
    expect(memeSlug('Nyan Cat 🌈🐱')).toBe('nyan-cat');
  });
});

describe('memeSlug keeps distinct memes distinct', () => {
  test('a qualifier word is not dropped as noise', () => {
    // The single most damaging possible collision: these are different memes
    // with different lineages, and merging them fabricates precedent.
    expect(memeSlug('Baby Doge')).not.toBe(memeSlug('Doge'));
    expect(memeSlug('Doge Killer')).not.toBe(memeSlug('Doge'));
  });

  test('nothing is stemmed', () => {
    expect(memeSlug('Cats')).not.toBe(memeSlug('Cat'));
  });

  test('digits are significant', () => {
    expect(memeSlug('Pepe 2.0')).not.toBe(memeSlug('Pepe'));
    expect(memeSlug('Pepe 2.0')).toBe('pepe-2-0');
  });
});

describe('memeSlug outside ASCII', () => {
  /*
   * An earlier version turned every non-ASCII letter into a separator, so
   * these collapsed into shared slugs ('p-p', 'e-e', 'se-or-doge') and each
   * became "observed precedent" for the other — fabricated precedent, the
   * failure this module exists to prevent.
   */
  test('accented names that differ stay distinct', () => {
    expect(memeSlug('Pépé')).not.toBe(memeSlug('Pöpö'));
    expect(memeSlug('Señor Doge')).not.toBe(memeSlug('Seçor Doge'));
  });

  test('names in other scripts stay distinct', () => {
    expect(memeSlug('Пепе')).not.toBe(memeSlug('Бебе'));
    expect(memeSlug('ドージ')).not.toBe(memeSlug('ペペ'));
  });

  test('non-Latin letters survive into the slug rather than vanishing', () => {
    expect(memeSlug('ペペ')).not.toBe('');
    expect(isResolvableMeme(memeSlug('ペペ'))).toBe(true);
  });

  test('an accent is one meme typed two ways, so it does collide', () => {
    expect(memeSlug('Pépé')).toBe(memeSlug('Pepe'));
    expect(memeSlug('Pépé')).toBe('pepe');
  });

  test('a leading qualifier does not stop the article being dropped', () => {
    expect(memeSlug('(meme) The Doge')).toBe(memeSlug('Doge'));
  });
});

describe('memeSlug edge cases', () => {
  test('pure punctuation or emoji yields an empty slug', () => {
    expect(memeSlug('🐸🐸🐸')).toBe('');
    expect(memeSlug('---')).toBe('');
    expect(memeSlug('')).toBe('');
  });

  test('a runaway name is cut to a key, on a boundary', () => {
    const slug = memeSlug(`${'nyan cat '.repeat(40)}`);
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('isResolvableMeme', () => {
  test('rejects the model’s ways of saying it does not know', () => {
    // Every one of these would otherwise become a single shared meme that all
    // unidentified tokens point at, manufacturing precedent out of ignorance.
    for (const value of ['unknown', 'unclear', 'unidentified', 'none', 'n-a', 'unclassified']) {
      expect(isResolvableMeme(value)).toBe(false);
    }
  });

  test('rejects the empty and the single character', () => {
    expect(isResolvableMeme('')).toBe(false);
    expect(isResolvableMeme('x')).toBe(false);
  });

  test('accepts a real meme slug', () => {
    expect(isResolvableMeme('nyan-cat')).toBe(true);
    expect(isResolvableMeme('wif')).toBe(true);
  });
});

describe('resolveMemeIdentity', () => {
  test('returns the slug and a cleaned display name', () => {
    expect(resolveMemeIdentity('  Nyan Cat (meme) ')).toEqual({
      id: 'nyan-cat',
      displayName: 'Nyan Cat',
    });
  });

  test('the display name keeps its own script; only the key is folded', () => {
    // Folding confusables is right for the key and wrong for a label: 'Пепе'
    // was being stored as the mixed-script 'Пeпe'.
    expect(resolveMemeIdentity('Пепе')?.displayName).toBe('Пепе');
  });

  test('returns null rather than a junk row for an unidentifiable name', () => {
    expect(resolveMemeIdentity('unknown')).toBeNull();
    expect(resolveMemeIdentity('🐸')).toBeNull();
    expect(resolveMemeIdentity('')).toBeNull();
  });

  test('two spellings resolve to one id, and the first display form is usable', () => {
    const a = resolveMemeIdentity('dogwifhat');
    const b = resolveMemeIdentity('DogWifHat');
    expect(a?.id).toBe(b?.id as string);
    expect(a?.displayName).toBe('dogwifhat');
    expect(b?.displayName).toBe('DogWifHat');
  });
});
