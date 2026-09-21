/**
 * One shared fetch wrapper with retries and a per-host rate limit.
 *
 * The free endpoints this project leans on (DexScreener, GeckoTerminal) publish
 * modest per-minute limits and answer 429 rather than queueing. A minimum
 * interval per host keeps a sweep across four chains from tripping them.
 */

import { log } from "./log.js";

/**
 * Requests per minute we allow ourselves per host. Deliberately below each
 * provider's published ceiling.
 */
const HOST_LIMITS: Record<string, number> = {
  "api.dexscreener.com": 250,
  "api.geckoterminal.com": 25,
  "public-api.dextools.io": 50,
};
const DEFAULT_LIMIT = 60;

const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 20_000;

/** One promise chain per host, so concurrent callers queue instead of racing. */
const hostQueues = new Map<string, Promise<void>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rateLimit(host: string): Promise<void> {
  const interval = 60_000 / (HOST_LIMITS[host] ?? DEFAULT_LIMIT);
  const previous = hostQueues.get(host) ?? Promise.resolve();
  const next = previous.then(() => sleep(interval));
  // Keep the chain alive even if a link rejects; nothing here should reject.
  hostQueues.set(
    host,
    next.catch(() => undefined),
  );
  await previous;
}

export interface RequestOptions {
  params?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

function withParams(url: string, params?: RequestOptions["params"]): string {
  if (!params) return url;
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
}

/** 429 and 5xx are worth another attempt; 4xx is not. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export class Fetcher {
  constructor(
    private readonly timeoutMs = 20_000,
    private readonly userAgent = "provenance/0.1",
  ) {}

  private async request(
    method: "GET" | "POST",
    url: string,
    options: RequestOptions & { body?: unknown } = {},
  ): Promise<Response | null> {
    const full = withParams(url, options.params);
    const host = new URL(full).host;
    const headers: Record<string, string> = {
      "User-Agent": this.userAgent,
      Accept: "application/json",
      ...options.headers,
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    let lastError: unknown = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
        await sleep(backoff * (0.5 + Math.random() / 2));
      }
      await rateLimit(host);

      const init: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
        redirect: "follow",
      };
      // Set only on POST: fetch rejects a GET that carries a body, even an
      // undefined one, on some runtimes.
      if (method === "POST" && options.body !== undefined) {
        init.body = JSON.stringify(options.body);
      }

      try {
        const response = await fetch(full, init);
        if (isRetryableStatus(response.status)) {
          lastError = new Error(`${response.status} from ${host}`);
          continue;
        }
        return response;
      } catch (error) {
        // Network failure, DNS, proxy refusal or timeout - all worth retrying.
        lastError = error;
      }
    }

    log.warn(`${method} ${full} failed after ${MAX_ATTEMPTS} attempts: ${String(lastError)}`);
    return null;
  }

  /**
   * Parsed JSON, or null for any failure.
   *
   * Sources are best-effort by design: one dead endpoint should degrade the
   * dossier, not abort the run.
   */
  async getJson(url: string, options: RequestOptions = {}): Promise<unknown> {
    const response = await this.request("GET", url, options);
    if (!response) return null;
    if (!response.ok) {
      log.info(`GET ${url} -> ${response.status}`);
      return null;
    }
    return this.parse(response, url);
  }

  async postJson(url: string, body: unknown, options: RequestOptions = {}): Promise<unknown> {
    const response = await this.request("POST", url, { ...options, body });
    if (!response) return null;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      log.info(`POST ${url} -> ${response.status} (${text.slice(0, 200)})`);
      return null;
    }
    return this.parse(response, url);
  }

  private async parse(response: Response, url: string): Promise<unknown> {
    // 204 and other empty bodies are a success with nothing to read - Discord
    // webhooks answer that way.
    if (response.status === 204) return {};
    const text = await response.text();
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      log.warn(`GET ${url} returned non-JSON`);
      return null;
    }
  }
}

// --------------------------------------------------------------------------
// Tolerant accessors. Upstream schemas drift and fields vanish; every read of a
// third-party payload goes through these so a shape change degrades one field
// rather than throwing mid-sweep.
// --------------------------------------------------------------------------

export function dig(obj: unknown, ...path: (string | number)[]): unknown {
  let current = obj;
  for (const key of path) {
    if (current === null || current === undefined) return undefined;
    if (typeof key === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[key];
    } else {
      if (typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[key];
    }
  }
  return current ?? undefined;
}

export function asFloat(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const out = Number(value);
  return Number.isFinite(out) ? out : null;
}

export function asInt(value: unknown): number | null {
  const out = asFloat(value);
  return out === null ? null : Math.trunc(out);
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Narrow an unknown payload to an object list, tolerating {data: [...]} wrappers. */
export function asObjectList(payload: unknown, ...wrapperKeys: string[]): Record<string, unknown>[] {
  const pick = (value: unknown): Record<string, unknown>[] | null => {
    if (!Array.isArray(value)) return null;
    return value.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
  };

  const direct = pick(payload);
  if (direct) return direct;

  if (typeof payload === "object" && payload !== null) {
    for (const key of wrapperKeys) {
      const inner = pick((payload as Record<string, unknown>)[key]);
      if (inner) return inner;
    }
  }
  return [];
}
