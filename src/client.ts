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
// changes at most once a day — but First Trust's server takes ~6 s to render it (time-to-first-byte;
// the response is already gzip'd and parsing is instant). So the client caches that one URL at TWO
// layers, both 24 h TTL: an in-memory layer (shared across queries in a long-lived stdio/HTTP
// process) AND a PERSISTENT on-disk layer under the OS temp dir, shared across worker PROCESSES.
// The disk layer means the 6 s fetch is paid at most once per 24 h even though DuckDB spawns a
// fresh worker per ATTACH (and vgi-lint per run): the first process to touch the catalog writes
// the file; every later process — and every later query within a run — reads it in milliseconds.
// Holdings and summary pages always go live. The in-flight Promise is cached (not only the resolved
// value) so concurrent first requests coalesce into one fetch; a failed fetch is evicted so the next
// call retries. The disk layer is OFF when a custom `fetchImpl` is injected (the unit tests), so
// tests never read/write a shared file or collide with a real run.

import { rename, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ETFLIST_URL } from "./firsttrust.js";

/** Shared on-disk cache file for the ETF list page (one per host, keyed by worker name). */
const DISK_CACHE_PATH = join(tmpdir(), "vgi-etf-first-trust-catalog.json");

interface DiskEntry {
  at: number;
  body: string;
}

/** Read the disk cache if present and younger than `ttl`; otherwise null. Best-effort (never throws). */
async function readDiskCache(ttl: number, now: () => number): Promise<DiskEntry | null> {
  try {
    const obj = JSON.parse(await readFile(DISK_CACHE_PATH, "utf8")) as DiskEntry;
    if (typeof obj?.at === "number" && typeof obj?.body === "string" && now() - obj.at < ttl) return obj;
  } catch {
    // missing / stale / partial write — treat as a miss.
  }
  return null;
}

/** Atomically write the disk cache (temp file + rename). Best-effort (never throws). */
async function writeDiskCache(at: number, body: string): Promise<void> {
  try {
    const tmp = `${DISK_CACHE_PATH}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ at, body }));
    await rename(tmp, DISK_CACHE_PATH);
  } catch {
    // a read-only /tmp or a race is non-fatal — the in-memory layer still applies.
  }
}

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
  // The persistent disk layer is meaningful only for the real platform fetch; an injected fetch
  // (the unit tests) uses the in-memory layer alone, so tests never touch a shared file.
  const useDisk = fetchImpl === globalThis.fetch;
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
      // 1) In-memory layer (this process).
      if (catalog && t - catalog.at < ttl) return catalog.value;
      // 2) Persistent disk layer (shared across processes) — pay the ~6 s fetch once per 24 h.
      if (useDisk) {
        const disk = await readDiskCache(ttl, now);
        if (disk) {
          catalog = { at: disk.at, value: Promise.resolve(disk.body) };
          return disk.body;
        }
      }
      // 3) Cold: fetch live, populate both layers.
      const value = rawGet(url);
      catalog = { at: t, value };
      value
        .then((body) => {
          if (useDisk) void writeDiskCache(t, body);
        })
        .catch(() => {
          if (catalog && catalog.value === value) catalog = null;
        });
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
