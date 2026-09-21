import { describe, expect, it } from "vitest";

import { tokenKey } from "../src/models.js";
import { Store } from "../src/state.js";
import { makeDossier, sampleVerdict } from "./helpers.js";

function store(): Store {
  return new Store(":memory:");
}

describe("store", () => {
  it("suppresses a re-alert inside the window", () => {
    const s = store();
    const dossier = makeDossier();
    const key = tokenKey(dossier.ref);

    expect(s.alertedRecently(key, 72)).toBe(false);
    s.recordAlert(dossier, sampleVerdict(), "run1");
    expect(s.alertedRecently(key, 72)).toBe(true);
    // A window of zero hours means nothing is ever considered recent.
    expect(s.alertedRecently(key, 0)).toBe(false);
    s.close();
  });

  it("accumulates sightings across runs but not within one", () => {
    const s = store();
    const dossier = makeDossier();
    const key = tokenKey(dossier.ref);

    s.recordSighting(dossier, "run1");
    s.recordSighting(dossier, "run2");
    s.recordSighting(dossier, "run2");
    expect(s.sightingCount(key)).toBe(2);
    expect(s.firstSeen(key)).not.toBeNull();
    s.close();
  });

  it("round-trips an alert", () => {
    const s = store();
    s.recordAlert(makeDossier(), sampleVerdict(), "run1");
    const rows = s.recentAlerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.novelty).toBe("pure-rerun");
    expect(rows[0]!.confidence).toBe(80);
    expect(JSON.parse(rows[0]!.verdict!)).toMatchObject({ archetype: "dog coin" });
    s.close();
  });
});
