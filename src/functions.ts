// The VGI surfaces: the products & holdings base-table backing scans, plus the fund_details table
// function. All keyless. The products / fund_details state is just a `done` flag (fully
// serializable — no socket / batch / Date), so the HTTP transport can round-trip it; the holdings
// scan streams via a BoundStorage work queue. The First Trust client is injected so worker.ts
// wires the real fetch and tests wire a fake.

import {
  defineTableFunction,
  ArgumentValidationError,
  batchFromColumns,
  serializeBatch,
  deserializeFilters,
  buildJoinKeysLookup,
  DEFAULT_MAX_WORKERS,
  type OutputCollector,
} from "@query-farm/vgi";
import { Schema, Field, Utf8 } from "@query-farm/apache-arrow";
import { fetchProducts, fetchHoldings, fetchFundDetails, resolveFund } from "./firsttrust.js";
import {
  productsSchema,
  productsBatch,
  holdingsSchema,
  holdingsBatch,
  fundDetailsSchema,
  fundDetailsBatch,
  resultColumnsSchema,
} from "./schema.js";
import type { FirsttrustClient } from "./client.js";

// Per-column descriptions for the `vgi.result_columns_schema` tag (JSON [{name,type,description}],
// generated from each Arrow schema via resultColumnsSchema).
const HOLDINGS_SCAN_DESCS: Record<string, string> = {
  fund_ticker: "The fund's ticker — the partition filter.",
  as_of_date: "The holdings as-of date (the page's own 'Holdings of the Fund as of' date).",
  weight_percent: "Percent of the fund's net assets, in percent points (2.59 = 2.59%).",
  ticker: "Constituent ticker / identifier (blank for some fixed-income lines).",
  name: "Constituent / security name.",
  cusip: "Constituent CUSIP.",
  sector: "Constituent sector / classification (equity funds; blank for many bond funds).",
  shares_held: "Number of shares / units (quantity) held.",
  market_value: "Market value of the position, in USD.",
};

const FUND_DETAILS_DESCS: Record<string, string> = {
  ticker: "Exchange ticker.",
  fund_name: "Full fund name.",
  investment_advisor: "The fund's investment advisor.",
  net_assets: "Total net assets (fund AUM), in USD.",
  shares_outstanding: "Shares outstanding.",
  daily_volume: "Recent daily trading volume (shares).",
  num_holdings: "Number of holdings, excluding cash.",
  expense_ratio_percent: "Total (gross) expense ratio, percent points (0.53 = 0.53%).",
  net_expense_ratio_percent: "Net expense ratio after fee waivers, percent points.",
  objective: "The fund's investment objective / strategy, plain text.",
};

interface DoneState {
  done: boolean;
}

/** Guard a required string argument; returns the trimmed value or throws ArgumentValidationError. */
function required(fn: string, name: string, v: unknown): string {
  if (v == null || String(v).trim() === "") {
    throw new ArgumentValidationError(`${fn}: ${name} is required`);
  }
  return String(v).trim();
}

/** Resolve a `fund` arg to a canonical ticker, raising a typed, discoverable error on a miss. */
async function resolveOrThrow(
  fn: string,
  client: FirsttrustClient,
  fund: string,
): Promise<string> {
  const ticker = await resolveFund(client.get, fund);
  if (ticker == null) {
    throw new ArgumentValidationError(
      `${fn}: could not resolve fund '${fund}'. Pass a First Trust exchange ticker (e.g. 'FTCS'); ` +
        `list valid tickers with SELECT ticker FROM firsttrust.main.products.`,
    );
  }
  return ticker;
}

// ── holdings queue plumbing (BoundStorage work queue + hive partition metadata) ──
//
// The holdings scan streams one fund per partition. `onInit` seeds a BoundStorage queue with the
// target funds (one item each); each `process()` tick pops a fund, fetches its holdings, and emits
// one SINGLE_VALUE partition. Multiple parallel workers drain the same execution-scoped queue, so
// the fan-out is naturally work-stealing and bounded by maxWorkers.

/** A queued fund: its ticker (the partition value). */
interface FundItem {
  ticker: string;
}
const encodeFund = (item: FundItem): Uint8Array => new TextEncoder().encode(JSON.stringify(item));
const decodeFund = (bytes: Uint8Array): FundItem => JSON.parse(new TextDecoder().decode(bytes));

/** Plain (non-annotated) field used to build the partition-values (min,max) batch. */
const FUND_TICKER_FIELD = new Field("fund_ticker", new Utf8(), true);

const b64encode = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/**
 * Build the `vgi_partition_values#b64` batch metadata for a SINGLE_VALUE partition: a 2-row
 * (min,max) Arrow batch over fund_ticker where min == max == the fund's ticker.
 */
function partitionValues(ticker: string): Map<string, string> {
  const batch = batchFromColumns({ fund_ticker: [ticker, ticker] }, new Schema([FUND_TICKER_FIELD]));
  return new Map([["vgi_partition_values#b64", b64encode(serializeBatch(batch))]]);
}

// ── products (backing scan for the products TABLE) ──────────────────────────────
//
// `products` is exposed as a real base TABLE (see catalog.ts `tables`), not a table function, so
// users query `FROM firsttrust.products` (no parens) and filter with WHERE — no arguments. This
// zero-arg scan is registered only for scan dispatch (it is NOT listed among the catalog's
// callable functions). It returns the full First Trust US ETF lineup; a WHERE on ticker / category
// narrows it.

export function makeProductsScan(client: FirsttrustClient) {
  const schema = productsSchema();
  return defineTableFunction<Record<string, never>, DoneState>({
    name: "products",
    description: "First Trust US ETF catalog — backing scan for the products table.",
    args: {},
    onBind: () => ({ outputSchema: schema }),
    initialState: () => ({ done: false }),
    process: async (_p, state: DoneState, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      const rows = await fetchProducts(client.get);
      out.emit(productsBatch(schema, rows));
      state.done = true;
    },
  });
}

// ── holdings (backing scan for the holdings TABLE) ─────────────────────────────
//
// `holdings` is exposed as a base TABLE (see catalog.ts), HIVE-PARTITIONED on `fund_ticker` (the
// fund's ticker — distinct from the constituent `ticker` column). First Trust publishes only the
// CURRENT holdings page per fund, so — like the sibling Global X / SPDR workers — there is NO time
// travel and no as-of argument; `as_of_date` reflects the page's own publication date.
//   SELECT * FROM firsttrust.main.holdings WHERE fund_ticker = 'FTCS';
//   SELECT * FROM firsttrust.main.holdings WHERE fund_ticker IN ('FTCS','AIRR');  -- fan-out
//   SELECT * FROM firsttrust.main.holdings;                                       -- ALL funds
//
// Each fund is one SINGLE_VALUE partition. The scan is a streaming, queue-backed generator:
//   • onInit (runs once on the coordinator) reads the pushed fund_ticker filter — or, absent one,
//     the ENTIRE ETF catalog — and pushes one item per fund onto a BoundStorage work queue.
//   • process() pops one fund per tick, fetches its holdings, and emits a single partition batch.
// filterPushdown + being LISTED is what lets DuckDB push fund_ticker into the scan.

export function makeHoldingsScan(client: FirsttrustClient) {
  const schema = holdingsSchema();
  return defineTableFunction<Record<string, never>, Record<string, never>>({
    name: "holdings",
    description:
      "The callable form of the holdings table — querying holdings() returns the same rows as " +
      "the `holdings` table; prefer the table. Detailed fund " +
      "holdings, hive-partitioned by fund_ticker: filter WHERE fund_ticker = 'FTCS' (or " +
      "fund_ticker IN (…)) for specific funds, or scan with no filter to stream every fund's " +
      "holdings. weight_percent is in percent points; First Trust publishes current holdings only.",
    args: {},
    // filterPushdown MUST be declared AND this function MUST be listed in the catalog so the DuckDB
    // extension can discover the capability and push the fund_ticker filter into the scan. Each
    // fund is one SINGLE_VALUE partition (fund_ticker is the hive partition key).
    filterPushdown: true,
    partitionKind: "SINGLE_VALUE_PARTITIONS",
    maxWorkers: DEFAULT_MAX_WORKERS,
    onBind: () => ({ outputSchema: schema }),
    // Seed the work queue (once, on the coordinator): one item per target fund.
    onInit: async ({ initCall, executionId, storage }) => {
      const joinKeys = buildJoinKeysLookup(initCall.join_keys);
      const filters = initCall.pushdown_filters
        ? deserializeFilters(initCall.pushdown_filters, joinKeys)
        : undefined;
      const requested = new Set(
        (filters?.getColumnValues("fund_ticker") ?? []).map((t) => String(t).toUpperCase()),
      );
      // Resolve the fund universe from the (cached) catalog. One fetch.
      const products = await fetchProducts(client.get);
      const targets: FundItem[] = [];
      const seen = new Set<string>();
      for (const p of products) {
        const tk = (p.ticker ?? "").toUpperCase();
        if (!tk || seen.has(tk)) continue;
        if (requested.size > 0 && !requested.has(tk)) continue;
        seen.add(tk);
        targets.push({ ticker: tk });
      }
      await storage.queuePush(targets.map(encodeFund));
      return { max_workers: DEFAULT_MAX_WORKERS, execution_id: executionId, opaque_data: null };
    },
    initialState: () => ({}),
    process: async (p, _state, out: OutputCollector) => {
      // Pop one fund per tick; emit exactly one partition. Skip funds with no holdings page or an
      // empty page, and pop the next. Queue empty → end of scan.
      for (;;) {
        const item = await p.storage!.queuePop();
        if (item === null) {
          out.finish();
          return;
        }
        const fund = decodeFund(item);
        const rows = await fetchHoldings(client.get, fund.ticker);
        if (rows.length === 0) continue;
        out.emit(holdingsBatch(schema, rows), partitionValues(fund.ticker));
        return;
      }
    },
    examples: [
      { sql: "SELECT name, weight_percent FROM firsttrust.main.holdings() WHERE fund_ticker = 'FTCS' ORDER BY weight_percent DESC LIMIT 10", description: "Top 10 holdings of FTCS via the backing scan" },
      { sql: "SELECT fund_ticker, count(*) FROM firsttrust.main.holdings() WHERE fund_ticker IN ('FTCS', 'AIRR') GROUP BY fund_ticker", description: "Two partitions at once (fan-out)" },
    ],
    tags: {
      "vgi.category": "holdings",
      "vgi.doc_llm":
        "The callable form of the `holdings` table: querying holdings() returns exactly the same " +
        "rows as the `holdings` table — prefer the table for readability. " +
        "Hive-partitioned by fund_ticker (the fund's ticker, distinct from the constituent " +
        "`ticker` column): filter WHERE fund_ticker = '…' (or fund_ticker IN (…)) for specific " +
        "funds, or scan with no filter to stream every fund (~300 partitions — slow). " +
        "weight_percent is in percent points (2.59 = 2.59%). First Trust publishes current " +
        "holdings only, so there is no historical as-of date.",
      "vgi.doc_md":
        "## holdings()\n\n" +
        "The callable form of the **`holdings` table** — calling `holdings()` returns the same rows " +
        "as the table; prefer the table. Hive-partitioned by " +
        "`fund_ticker`: filter `WHERE fund_ticker = 'FTCS'` for one fund, or scan with no filter " +
        "to stream every fund (see the example queries). `fund_ticker` is distinct from the " +
        "constituent `ticker` column.",
      // Described mirror of the native `examples:` above (the duckdb_functions().examples
      // carrier drops descriptions, so VGI515 reads them from this tag).
      "vgi.example_queries": JSON.stringify([
        { description: "Top 10 holdings of FTCS via the backing scan", sql: "SELECT name, weight_percent FROM firsttrust.main.holdings() WHERE fund_ticker = 'FTCS' ORDER BY weight_percent DESC LIMIT 10" },
        { description: "Two partitions at once (fan-out)", sql: "SELECT fund_ticker, count(*) FROM firsttrust.main.holdings() WHERE fund_ticker IN ('FTCS', 'AIRR') GROUP BY fund_ticker" },
      ]),
      "vgi.result_columns_schema": resultColumnsSchema(holdingsSchema(), HOLDINGS_SCAN_DESCS),
    },
  });
}

// ── fund_details (a callable table function) ────────────────────────────────────
//
// A one-row per-fund snapshot from the fund's summary page — the key facts the list-page catalog
// does NOT carry (expense ratio, net assets, shares outstanding, advisor, objective). `fund` is a
// ticker; it is resolved / validated against the catalog first.

interface FundArgs {
  fund: string;
}

const FUND_ARG_DOC =
  "The fund to look up, given as an exchange ticker like 'FTCS'. Required, first positional " +
  "argument.";

export function makeFundDetailsFunction(client: FirsttrustClient) {
  const schema = fundDetailsSchema();
  return defineTableFunction<FundArgs, DoneState>({
    name: "fund_details",
    description:
      "A one-row snapshot of a single fund's key facts from its summary page: full name, " +
      "investment advisor, total net assets, shares outstanding, recent daily volume, number of " +
      "holdings, gross/net expense ratio, and the fund's investment objective. `fund` is a ticker " +
      "(e.g. 'FTCS'). These are the facts the products catalog does not carry.",
    args: { fund: new Utf8() },
    argDocs: { fund: FUND_ARG_DOC },
    onBind: (p) => {
      required("fund_details", "fund", p.args.fund);
      return { outputSchema: schema };
    },
    initialState: () => ({ done: false }),
    process: async (p, state: DoneState, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      const ticker = await resolveOrThrow("fund_details", client, String(p.args.fund));
      const row = await fetchFundDetails(client.get, ticker);
      out.emit(fundDetailsBatch(schema, [row]));
      state.done = true;
    },
    examples: [
      { sql: "SELECT ticker, net_assets, expense_ratio_percent, num_holdings FROM firsttrust.main.fund_details('FTCS')", description: "Key facts for FTCS" },
      { sql: "SELECT objective FROM firsttrust.main.fund_details('FTCS')", description: "The fund's investment objective (plain text)" },
    ],
    tags: {
      "vgi.category": "catalog",
      "vgi.doc_llm":
        "One-row detail snapshot for a fund from its summary page: investment advisor, total net " +
        "assets, shares outstanding, recent daily volume, number of holdings, gross/net expense " +
        "ratio, and the investment objective. These are the facts the wide-but-shallow products " +
        "catalog does not carry (notably expense ratio and net assets). Percent columns are in " +
        "percent points; `objective` is plain text. `fund` is a ticker (e.g. 'FTCS').",
      "vgi.doc_md":
        "## fund_details\n\n" +
        "A one-row snapshot of a fund's key facts from its summary page — the details beyond what " +
        "`products` carries (expense ratio, net assets, shares outstanding, advisor, objective). " +
        "Percent columns are in percent points; `objective` is plain text.\n\n" +
        "It returns exactly one row; for the whole lineup use `products` (see the example queries).",
      // Described mirror of the native `examples:` above (VGI515 — the
      // duckdb_functions().examples carrier drops descriptions).
      "vgi.example_queries": JSON.stringify([
        { description: "Key facts for FTCS", sql: "SELECT ticker, net_assets, expense_ratio_percent, num_holdings FROM firsttrust.main.fund_details('FTCS')" },
        { description: "The fund's investment objective (plain text)", sql: "SELECT objective FROM firsttrust.main.fund_details('FTCS')" },
      ]),
      "vgi.result_columns_schema": resultColumnsSchema(fundDetailsSchema(), FUND_DETAILS_DESCS),
    },
  });
}
