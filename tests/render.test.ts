import { describe, expect, it } from "vitest";

import { chunk } from "../src/alerts/dispatch.js";
import { chartLink, renderEntryMarkdown, renderEntryShort } from "../src/alerts/render.js";
import type { ReportEntry } from "../src/models.js";
import { makeDossier, sampleVerdict } from "./helpers.js";

function entry(overrides: Partial<ReportEntry> = {}): ReportEntry {
  return { dossier: makeDossier(), verdict: sampleVerdict(), citations: [], ...overrides };
}

describe("chunk", () => {
  it("leaves short text alone", () => {
    expect(chunk("hello", 100)).toEqual(["hello"]);
  });

  it("splits on paragraph boundaries where it can", () => {
    const text = `${"a".repeat(3000)}\n\n${"b".repeat(3000)}`;
    expect(chunk(text, 4096).map((c) => c.length)).toEqual([3000, 3000]);
  });

  it("hard-splits a single oversized paragraph", () => {
    expect(chunk("x".repeat(9000), 4096).map((c) => c.length)).toEqual([4096, 4096, 808]);
  });

  it("never emits a piece over the limit", () => {
    const text = Array.from({ length: 40 }, (_, i) => "p".repeat(i * 37)).join("\n\n");
    for (const piece of chunk(text, 500)) expect(piece.length).toBeLessThanOrEqual(500);
  });
});

describe("markdown", () => {
  it("leads with the verdict and includes the data table", () => {
    const text = renderEntryMarkdown(entry());
    expect(text).toContain("A 2023 dog meme relaunched");
    expect(text).toContain("### Lineage");
    expect(text).toContain("dogwifhat");
    expect(text).toContain("| Top-10 share | 25.0% |");
  });

  it("says so plainly when no ancestor was established", () => {
    const verdict = { ...sampleVerdict(), lineage: [], novelty: "novel" as const };
    expect(renderEntryMarkdown(entry({ verdict }))).toContain("No ancestor established.");
  });

  it("renders a failed entry instead of throwing", () => {
    const text = renderEntryMarkdown(entry({ verdict: null, error: "APIError: 529" }));
    expect(text).toContain("Research failed: APIError: 529");
  });

  it("links the chart only when there is a pool address", () => {
    const d = makeDossier();
    expect(chartLink(d)).toBe("https://dexscreener.com/solana/PAIR1");
    d.ref.pairAddress = null;
    expect(chartLink(d)).toBeNull();
  });
});

describe("chat form", () => {
  it("leads with the lineage, because that is the point", () => {
    const text = renderEntryShort(entry());
    expect(text.indexOf("Runs as: dogwifhat")).toBeGreaterThan(-1);
    expect(text).toContain("confidence 80/100");
  });

  it("respects the length limit", () => {
    const verdict = sampleVerdict();
    verdict.audience_read = "z".repeat(5000);
    verdict.one_liner = "y".repeat(5000);
    const text = renderEntryShort(entry({ verdict }), 400);
    expect(text.length).toBeLessThanOrEqual(400);
    expect(text.endsWith("…")).toBe(true);
  });
});
