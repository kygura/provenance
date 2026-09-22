import { describe, expect, test } from 'bun:test';
import { ARCHETYPES, classify, describeHits } from './lexicon';

describe('the table itself', () => {
  test('no pattern carries the /g flag', () => {
    // A global regex keeps `lastIndex` between calls, so `classify()` would
    // return different answers depending on what was classified before it.
    const global = ARCHETYPES.flatMap((archetype) =>
      archetype.patterns.filter((pattern) => pattern.global).map((pattern) => `${archetype.key}:${pattern}`),
    );
    expect(global).toEqual([]);
  });

  test('keys are unique', () => {
    const keys = ARCHETYPES.map((archetype) => archetype.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('every archetype names at least one prior run', () => {
    for (const archetype of ARCHETYPES) {
      expect(archetype.ancestors.length).toBeGreaterThan(0);
    }
  });
});

describe('classify', () => {
  test('is stateless across repeated calls', () => {
    const first = classify('nyan cat');
    const second = classify('nyan cat');
    expect(second.map((hit) => hit.archetype.key)).toEqual(first.map((hit) => hit.archetype.key));
  });

  test('a run over other text does not change a later answer', () => {
    const before = classify('pepe frog').map((hit) => hit.archetype.key);
    classify('doge shib inu bonk wif cat pepe 2.0 rebase safemoon');
    const after = classify('pepe frog').map((hit) => hit.archetype.key);
    expect(after).toEqual(before);
  });

  test('reports the matched substring, not the pattern', () => {
    const hits = classify('Doge 2.0');
    const dog = hits.find((hit) => hit.archetype.key === 'dog');
    expect(dog?.matched).toContain('Doge');
    expect(dog?.matched.join(' ')).not.toContain('\\b');
  });

  test('an explicit sequel matches the revival archetype', () => {
    expect(classify('PEPE 2.0').map((hit) => hit.archetype.key)).toContain('explicit_revival');
  });

  test('one token can match several archetypes', () => {
    expect(classify('AI Doge Agent').map((hit) => hit.archetype.key).sort()).toEqual(['ai_agent', 'dog']);
  });

  test('unmatched text yields no hits rather than a guess', () => {
    expect(classify('zzqx plorbinate')).toEqual([]);
  });
});

describe('describeHits', () => {
  test('says the lineage question is open when nothing matched', () => {
    expect(describeHits([])).toContain('Treat the lineage question as open');
  });

  test('names the ancestors for a hit', () => {
    expect(describeHits(classify('shiba inu'))).toContain('Dogecoin (2013)');
  });
});
