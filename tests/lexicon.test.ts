import { describe, expect, it } from "vitest";

import { ARCHETYPES, classify, describeHits } from "../src/lexicon.js";

describe("lexicon", () => {
  it("detects an explicit revival alongside its family", () => {
    const keys = classify("Shiba Inu 2.0").map((h) => h.archetype.key);
    expect(keys).toContain("explicit_revival");
    expect(keys).toContain("dog");
  });

  it("reports matched text, not the regex that matched it", () => {
    // The matches end up in a prompt; raw patterns there are noise.
    const { matched } = classify("PEPE 2.0")[0]!;
    expect(matched.every((m) => !m.includes("\\b"))).toBe(true);
  });

  it("states plainly when nothing matched", () => {
    expect(classify("Quorum Settlement Layer")).toEqual([]);
    expect(describeHits([]).toLowerCase()).toContain("open");
  });

  it("gives every archetype patterns, ancestors and a weight", () => {
    for (const archetype of ARCHETYPES) {
      expect(archetype.patterns.length, archetype.key).toBeGreaterThan(0);
      expect(archetype.ancestors.length, archetype.key).toBeGreaterThan(0);
      expect(archetype.weight, archetype.key).toBeGreaterThan(0);
    }
  });

  it("uses stateless patterns", () => {
    // A /g or /y flag would make exec() stateful and classify() order-dependent.
    for (const archetype of ARCHETYPES) {
      for (const pattern of archetype.patterns) {
        expect(pattern.global, `${archetype.key}: ${pattern}`).toBe(false);
        expect(pattern.sticky, `${archetype.key}: ${pattern}`).toBe(false);
      }
    }
  });

  it("is repeatable across calls", () => {
    const first = classify("Pepe 2.0").map((h) => h.matched.join(","));
    const second = classify("Pepe 2.0").map((h) => h.matched.join(","));
    expect(second).toEqual(first);
  });
});
