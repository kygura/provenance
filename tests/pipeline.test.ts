/**
 * End-to-end with the network and the model stubbed out.
 *
 * The fake fetcher answers by URL so the real source adapters, enrichment,
 * scoring, state and rendering all run; only the two things that cost money are
 * replaced.
 */

import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderReportMarkdown } from "../src/alerts/render.js";
import { DEFAULTS, loadSecrets, type Config } from "../src/config.js";
import type { Fetcher } from "../src/http.js";
import { run, type Deps, type ResearchLike } from "../src/pipeline.js";
import { freshFixture, sampleVerdict } from "./helpers.js";

const TOKEN = "TOKEN111111111111111111111111111111111111111";

/**
 * Routes on substrings of the URL. Anything unrecognised returns null, which is
 * exactly how a real dead endpoint behaves here.
 */
class FakeFetcher {
  readonly calls: string[] = [];
  readonly posts: [string, unknown][] = [];

  getJson(url: string): Promise<unknown> {
    this.calls.push(url);
    if (url.includes("token-boosts")) {
      return Promise.resolve([{ chainId: "solana", tokenAddress: TOKEN, amount: 500 }]);
    }
    if (url.includes("/tokens/v1/") || url.includes("/latest/dex/tokens/")) {
      return Promise.resolve([freshFixture("dexscreener_pair", 12)]);
    }
    if (url.includes("trending_pools")) {
      return Promise.resolve({ data: [freshFixture("geckoterminal_pool", 30)] });
    }
    if (url.includes("solana/token_security")) {
      return Promise.resolve({ result: { [TOKEN]: freshFixture("goplus_solana", 0) } });
    }
    if (url.includes("token_security/")) {
      return Promise.resolve({ result: { [TOKEN.toLowerCase()]: freshFixture("goplus_evm", 0) } });
    }
    return Promise.resolve(null);
  }

  postJson(url: string, body: unknown): Promise<unknown> {
    this.posts.push([url, body]);
    return Promise.resolve({ ok: true, html_url: "https://example.invalid/issues/1" });
  }
}

function makeConfig(): Config {
  const tmp = mkdtempSync(join(tmpdir(), "provenance-test-"));
  return {
    sources: { ...DEFAULTS.sources, chains: ["solana"], dextoolsEnabled: false, perSourceLimit: 5 },
    filters: { ...DEFAULTS.filters },
    research: { ...DEFAULTS.research, maxTokensPerRun: 2 },
    alerts: { ...DEFAULTS.alerts, reportsDir: join(tmp, "reports") },
    statePath: join(tmp, "state.sqlite3"),
    secrets: {
      ...loadSecrets(),
      anthropicApiKey: "test-key",
      telegramBotToken: null,
      telegramChatId: null,
      discordWebhookUrl: null,
      githubToken: null,
      githubRepository: null,
    },
  };
}

function stubAnalyst(investigate: (dossier: unknown) => Promise<ResearchLike>): Deps["makeAnalyst"] {
  return () => ({ investigate: investigate as never });
}

function result(overrides: Partial<ResearchLike> = {}): ResearchLike {
  return {
    notes: "notes",
    citations: ["https://example.invalid/wif"],
    verdict: sampleVerdict(),
    searchesRun: 3,
    ...overrides,
  };
}

let config: Config;
let fetcher: FakeFetcher;
let deps: Partial<Deps>;

beforeEach(() => {
  config = makeConfig();
  fetcher = new FakeFetcher();
  deps = { makeFetcher: () => fetcher as unknown as Fetcher };
});

describe("pipeline", () => {
  it("makes no model calls on a dry run", async () => {
    const makeAnalyst = vi.fn(() => {
      throw new Error("dry run must not construct an Analyst");
    });
    const report = await run(config, {
      dryRun: true,
      deps: { ...deps, makeAnalyst: makeAnalyst as never },
    });

    expect(report.entries.length).toBeGreaterThan(0);
    expect(report.entries.every((e) => !e.verdict)).toBe(true);
    expect(makeAnalyst).not.toHaveBeenCalled();
  });

  it("researches and reports, with enrichment applied", async () => {
    const seen: string[] = [];
    const report = await run(config, {
      deps: {
        ...deps,
        makeAnalyst: stubAnalyst((d) => {
          seen.push((d as { ref: { address: string } }).ref.address);
          return Promise.resolve(result());
        }),
      },
    });

    // Both feeds surface a distinct token and both clear the filters, so the
    // DexScreener and GeckoTerminal paths are each covered.
    expect(report.entries).toHaveLength(2);
    expect(seen.sort()).toEqual([TOKEN, "TOKEN222"].sort());
    expect(report.errors).toEqual([]);

    for (const entry of report.entries) {
      expect(entry.verdict?.lineage[0]?.name).toBe("dogwifhat");
      // Enrichment ran: the Solana GoPlus fixture sets a live freeze authority.
      expect(entry.dossier.security.freezeAuthorityActive).toBe(true);
      expect(entry.dossier.holders.holderCount).toBe(1290);
    }
  });

  it("contains a research failure to its own entry", async () => {
    const report = await run(config, {
      deps: {
        ...deps,
        makeAnalyst: stubAnalyst(() => Promise.reject(new Error("upstream 529"))),
      },
    });

    expect(report.entries.length).toBeGreaterThan(0);
    expect(report.entries[0]!.error).toContain("upstream 529");
    expect(report.errors.length).toBeGreaterThan(0);
    // A failed entry still renders rather than crashing the report.
    expect(renderReportMarkdown(report)).toContain("Research failed");
  });

  it("reports a low-confidence verdict but does not alert on it", async () => {
    config.alerts.minRecycleConfidence = 90;
    const sent: unknown[][] = [];

    const report = await run(config, {
      deps: {
        ...deps,
        makeAnalyst: stubAnalyst(() =>
          Promise.resolve(result({ verdict: sampleVerdict(40) })),
        ),
        dispatch: (_report, entries) => {
          sent.push(entries);
          return Promise.resolve(["file:x"]);
        },
      },
    });

    expect(report.entries[0]?.verdict).toBeTruthy();
    expect(sent).toEqual([[]]);
  });

  it("does not research the same token twice inside the re-alert window", async () => {
    let calls = 0;
    const withCounter = {
      ...deps,
      makeAnalyst: stubAnalyst(() => {
        calls += 1;
        return Promise.resolve(result());
      }),
    };

    await run(config, { deps: withCounter });
    const first = calls;
    expect(first).toBeGreaterThan(0);

    await run(config, { deps: withCounter });
    expect(calls).toBe(first);
  });

  it("leaves a readable report on disk and a JSON-serialisable report in memory", async () => {
    const report = await run(config, {
      deps: { ...deps, makeAnalyst: stubAnalyst(() => Promise.resolve(result())) },
    });

    const files = readdirSync(config.alerts.reportsDir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);

    const text = readFileSync(join(config.alerts.reportsDir, files[0]!), "utf8");
    expect(text).toContain("# Provenance");
    expect(text).toContain("dogwifhat");
    expect(text).toContain("is a recommendation"); // the disclaimer footer

    // The report must round-trip as JSON too, for --json.
    expect(() => JSON.stringify(report)).not.toThrow();
  });
});
