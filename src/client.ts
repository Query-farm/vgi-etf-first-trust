// The real First Trust HTTP client — the ONE module that touches the network, so (like the sibling
// Global X / iShares clients) it is exercised live, not by the unit tests, which drive the pure
// driver in firsttrust.ts through an injected `get`.
//
// All three First Trust planes — the ETF list page, the per-fund holdings page, and the per-fund
// summary page — are keyless, un-gated, and plain HTML, so there is a single `get(url) => string`
// transport (no JSON, no binary). The one non-obvious requirement is a browser-like User-Agent;
// the default fetch UA is served an interstitial/blocked page instead of the content.
//
// CATALOG CACHE: the ~0.9 MB ETF list page backs `products` and every ticker resolution, and
// changes at most once a day. So the client memoizes just that one URL with a 24 h TTL (shared
// across queries in a long-lived stdio/HTTP process). Holdings and summary pages always go live.
// The in-flight Promise is cached (not only the resolved value) so concurrent first requests
// coalesce into one fetch; a failed fetch is evicted so the next call retries.

import { ETFLIST_URL } from "./firsttrust.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Default ETF-list-page cache lifetime: 24 hours. */
export const CATALOG_CACHE_MS = 24 * 60 * 60 * 1000;

/** The holdings and summary pages can be large/slow — give them a generous timeout. */
export const FETCH_TIMEOUT_MS = 60_000;

type FetchLike = typeof globalThis.fetch;

/** The injected transport the table functions call: a text `get` (HTML). */
export interface FirsttrustClient {
  get: (url: string) => Promise<string>;
}

export interface FirsttrustClientOptions {
  /** ETF-list-page cache TTL in ms (default 24 h). Pass 0 to disable caching. */
  catalogCacheMs?: number;
  /** Per-request timeout in ms (default 60 s). */
  timeoutMs?: number;
  /** Injectable clock (ms since epoch) — for tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Build the injectable `{ get }` client. `fetchImpl` defaults to the platform fetch; pass one in
 * for Cloudflare or to stub the network. The ETF list page is memoized for `catalogCacheMs`
 * (default 24 h); holdings and summary pages are never cached.
 */
export function makeFirsttrustClient(
  fetchImpl: FetchLike = globalThis.fetch,
  opts: FirsttrustClientOptions = {},
): FirsttrustClient {
  const ttl = opts.catalogCacheMs ?? CATALOG_CACHE_MS;
  const timeout = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());
  let catalog: { at: number; value: Promise<string> } | null = null;

  const rawGet = async (url: string): Promise<string> => {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`firsttrust: HTTP ${res.status} for ${url} — ${body.slice(0, 200)}`);
    }
    return res.text();
  };

  const get = async (url: string): Promise<string> => {
    if (ttl > 0 && url === ETFLIST_URL) {
      const t = now();
      if (!catalog || t - catalog.at >= ttl) {
        const value = rawGet(url);
        catalog = { at: t, value };
        value.catch(() => {
          if (catalog && catalog.value === value) catalog = null;
        });
      }
      return catalog.value;
    }
    return rawGet(url);
  };

  return { get };
}

/** Convenience: the real client's `get` for wiring into the table functions. */
export function makeFirsttrustGet(): (url: string) => Promise<string> {
  return makeFirsttrustClient().get;
}
