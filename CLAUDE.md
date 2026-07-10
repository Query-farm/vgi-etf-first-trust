# vgi-etf-first-trust — agent notes

A VGI (DuckDB) worker exposing First Trust US ETF data as two base **tables** — `products` (the
catalog) and `holdings` (hive-partitioned) — plus the holdings table's backing scan, exposed as a
same-named `holdings()` table function (LISTED so the extension discovers filter_pushdown), and one
callable table function, `fund_details(fund)`. TypeScript, runs on Bun, built on
`@query-farm/vgi` (the TS SDK). Keyless — no secret type, no auth. Modeled on the sibling
`vgi-etf-globalx` worker (an HTML-scraping, current-only, page-driven worker). The key differences from
vgi-etf-globalx: everything is scraped from server-rendered **ASP.NET HTML tables** (no Next.js RSC
payload, no CSV), there is an extra `fund_details` function (First Trust's list page is thin, so
expense ratio / net assets live on the per-fund summary page), and there is no NAV-history plane.

## Base tables (`products`, `holdings`) — two layers: registry vs listing

Tables are wired via `SchemaDescriptor.tables` (`makeCatalog`'s `tables: [...]`); each
`TableDescriptor` has `function: <scan>` + `arguments: new Arguments([], new Map())` and carries
its docs on `tags`/`comment`/`columnComments`. Two INDEPENDENT layers matter:
- **FunctionRegistry** (`registry.register(scan)`) — the *dispatch* layer. Required for a table to
  be scannable.
- **catalog `schemas[].functions`** — the *listing* layer. Controls what shows as a callable `X()`
  function AND is where the extension discovers a scan's capabilities (e.g. `filter_pushdown`).

`products`: backing `productsScan` is **registered but NOT listed** → exposed only as the table.
`holdings`: backing `holdingsScan` MUST be **listed** (`functions: [...functions, holdingsScan]`,
where `functions` is `[fundDetails]`) — an unlisted backing scan gets no `pushdown_filters` (the
extension can't see its `filter_pushdown` capability), so the `fund_ticker` partition filter never
reaches it. So the backing scan MUST be listed. To avoid VGI311 (parameterless-table-function)
firing on it, the listed scan is named the SAME as its table (`holdings`) — VGI311 exempts a
parameterless function when a table-like of the same name scans it, so no `vgi-lint.toml` waiver is
needed. `FROM holdings()` therefore returns the identical rows to the `holdings` table.

## `holdings` — hive-partitioned by `fund_ticker`, CURRENT holdings only (no time travel)

Query `FROM firsttrust.main.holdings WHERE fund_ticker = 'FTCS'` (fund selector); an **unfiltered
scan streams every fund** (one partition per fund). Mechanics:
- **Hive partitioning + streaming queue.** `holdingsScan` is a `partitionKind:
  "SINGLE_VALUE_PARTITIONS"` generator — `fund_ticker` is the partition key (annotated
  `vgi.partition_column` in `holdingsSchema`). `onInit` reads the pushed `fund_ticker` filter (or,
  absent one, the whole catalog) and `queuePush`es one `{ticker}` item per fund onto a
  `BoundStorage` queue keyed by the execution id. `process()` pops one fund per tick, fetches its
  holdings page, and `out.emit`s a single partition batch tagged with `vgi_partition_values`
  (min==max==ticker). `maxWorkers` workers drain the same queue → work-stealing fan-out. `LIMIT`
  short-circuits the stream.
- **No time travel.** First Trust has only one current holdings page per fund. There is
  deliberately NO `supportsTimeTravel` and NO as-of argument; `process()` never reads `p.atValue`.
  `as_of_date` is a real output column populated from the page's "Holdings of the Fund as of
  M/D/YYYY" heading.
- **404/empty-tolerant.** A fund whose holdings page errors or is empty yields `[]` from
  `fetchHoldings` (it catches the fetch); `process()` skips it and pops the next, so an all-funds
  scan never fails on one missing fund.
- **`filterPushdown: true`** + LISTED → the extension pushes the `fund_ticker` filter into the scan.
- **`fund_ticker` is a SEPARATE column from `ticker`** — `ticker` is the CONSTITUENT's own
  identifier (blank for some fixed-income lines); `fund_ticker` is the fund's ticker, constant per
  fund. The scan tags every row with the requested fund ticker, upper-cased.
- Constraints: `products` advisory PK `[ticker]` (First Trust exposes no catalog-level ISIN),
  `holdings` `notNull [fund_ticker]` + advisory composite PK `(fund_ticker, cusip)` (the fund plus
  the constituent's canonical security identifier). No cross-table FK: fund_ticker→products.ticker
  is a real relationship but declaring it would force a live VGI810 data-probe of the whole
  (unfiltered) holdings stream, and VGI809 does not fire, so it's intentionally left off. No
  `vgi-lint.toml` rule waivers — the metadata passes `--fail-on info` on its own.

## The three scrape planes (server-rendered ASP.NET HTML — NOT a JSON API)

All keyless, all plain HTML, all need only a browser User-Agent (the default fetch UA is served an
interstitial). No headless browser is needed. `src/firsttrust.ts` parses each with small,
tag-tolerant regexes; every parser is defensive (missing table/cell → `[]`/null, never a throw).

1. **`etflist.aspx` → products.** One `searchResults` HTML table PER fund-type section; each
   section is preceded by a `lblETFSectionTitle` caption span that becomes the row's `category`
   (Income Funds, Sector & Industry Funds, Size/Style Funds, Global/International Funds, Thematic
   Funds, Specialty Funds, Alternative Funds, Target Outcome Funds). `parseProducts` finds each
   `EtfSummary.aspx?Ticker=…` anchor (one per data row), bounds its `<tr>`, and reads the **11
   fixed-position `<td>` cells** — 0 name, 1 ticker, 2 inception (MM/DD/YY), 3 NAV, 4 30-day SEC
   yield, 5 unsubsidized yield, **6 a blank spacer**, 7 12-month distribution rate, 8 yield-as-of
   date, 9–10 links. ~316 funds. The `-------` sentinel and empty cells degrade to null.
2. **`EtfHoldings.aspx?Ticker=T` → holdings.** The constituents live in a `fundSilverGrid` table
   whose header row (`fundSilverGridHeader`) labels the columns, so parsing is **header-driven**
   (`colByPrefix` maps Security Name/Identifier/CUSIP/Classification/Shares/Market Value/Weighting
   by label prefix). This matters: equity funds carry a Classification (sector) column, fixed-income
   funds do NOT (and label the value column "Market Value / Notional Value"), and either binds.
   The as-of date is the "Holdings of the Fund as of M/D/YYYY" heading. `parseHoldings` sorts by
   `weight_percent` DESC (NULLS last) so `... LIMIT n` returns the top holdings.
3. **`EtfSummary.aspx?Ticker=T` → fund_details.** Key facts are a `CEFFieldLabel` → `CEFPagesBody`
   two-cell label/value table; `labelValue(html, label)` matches a label by prefix (so a trailing
   `*` / `(excluding cash)` doesn't matter) and grabs the adjacent value cell. `fund_name` comes
   from the `<title>` minus the trailing `(TICKER)`; `objective` from the `lblInvestmentStrategy`
   span (HTML-stripped, entity-decoded). This is the ONLY source of expense ratio / net assets —
   the list page doesn't carry them, and fetching the 2 MB summary page for all ~316 funds in the
   products scan would be far too slow, so it's an on-demand per-fund function instead.

**Units:** dates are US-slash (`M/D/YYYY` and `MM/DD/YY`; 2-digit years → 2000+YY). `parseDate`
returns epoch seconds for the DateDay path. Percent columns hold percent points (0.53 = 0.53%,
2.59 = 2.59%) exactly as displayed — no scaling. `nav`/`net_assets`/`market_value` are plain USD;
`asNum` strips `$ , % "`. `num_holdings` is Int64 → emit **bigint** via `bigOrNull`.

## `fund_details(fund)` — a callable table function

Single-shot snapshot (`{done}` state, HTTP-transport safe). `fund` is a ticker (VGI313: the arg
doc says "an exchange ticker like 'FTCS'", never "a string"). `resolveOrThrow` calls the driver's
`resolveFund` (validate/canonicalize against the cached catalog) and turns a null into a typed
`ArgumentValidationError` with a "list tickers via products" hint (the driver stays SDK-free —
`resolveFund` returns `string | null`). `process()` fetches the summary page and emits one row.

## Architecture (keep this separation)

- **`src/firsttrust.ts` — the pure driver.** URL builders + HTML parsers (`parseProducts`,
  `parseHoldings`, `parseFundDetails`) + thin `fetch*` orchestrators + `resolveFund`, all taking an
  injected `get(url) => Promise<string>` (text). NO network, NO SDK import. This is what the unit
  tests exercise. Shared helpers: `decodeEntities`/`cleanText` (strip tags + decode entities +
  collapse whitespace), `asStr`/`asNum` (the `-------` sentinel → null), `parseDate`, `rowCells`.
- **`src/client.ts` — the only network module.** `makeFirsttrustClient()` returns `{ get }` (and
  `makeFirsttrustGet()` the bare `get`). A SINGLE text transport (all three planes are HTML). `get`
  memoizes the `etflist.aspx` page for 24 h; holdings and summary pages are never cached. Sets the
  browser-like User-Agent First Trust requires and a generous 60 s timeout (the holdings/summary
  pages are large/slow). Verified live, not in the unit suite.
- **`src/schema.ts` — typed Arrow schemas + batch builders.** Real typed columns
  (`Utf8`/`Float64`/`Int64`/`DateDay`), not JSON. Every calendar date is a real Arrow **DATE**
  (`DateDay` → DuckDB `DATE`, no timezone; a DATE cell is a JS `Date` at UTC midnight via
  `dateOrNull`). Int64 cells are **bigint** via `bigOrNull`. NOTE: dates are DATE, not TIMESTAMP.
  Percent columns carry a `_percent` suffix and hold **percent points**.
- **`src/functions.ts`** — three `defineTableFunction`s: `makeProductsScan` (unlisted products
  backing scan), `makeHoldingsScan` (named `holdings` — same as the table, LISTED, filterPushdown, SINGLE_VALUE
  partitions, queue/BoundStorage streaming), and `makeFundDetailsFunction` (`fund_details`, LISTED,
  a `fund` arg). Each `make*` takes the whole `FirsttrustClient`.
- **`src/catalog.ts` / `src/worker.ts`** — catalog descriptor (no `secretTypes`) and the entry that
  wires the real client into the scans/functions. `makeCatalog(functions, productsScan,
  holdingsScan)` keeps the sibling signature; `functions` is `[fundDetails]`.

## Commands

```bash
bun install
bun test            # SDK-free driver + Arrow batch builders + live HTTP-transport E2E
bun run typecheck   # own-source only; scripts/typecheck.sh filters node_modules errors
./run_tests.sh      # haybarn SQLLogic E2E: worker under real DuckDB + community vgi ext
```

`run_tests.sh` sets `VGI_TEST_WORKER=bin/vgi-etf-first-trust-worker` +
`VGI_WORKER_CATALOG_NAME=firsttrust` and runs `test/sql/*.test` (DESCRIBE-based schema asserts + a
few live-invariant asserts that hit First Trust). CI runs this, the reusable `ts-ci.yml`, and a
`vgi-lint` gate at `--fail-on info` (100/100).

Typecheck must be a `bash scripts/typecheck.sh` file (not an inline package.json pipeline) —
`bun run` uses Bun's shell, which mishandles the `grep -v node_modules` filter. Use a modern
`typescript` (>=6; the repo tracks `^7.0.2`) — pre-6 descends into SDK `.ts` source and reports
external errors.

## Gotchas / conventions

- Emit `Date` (rich repr) for DATE columns and `bigint` for Int64 (`num_holdings`) via
  `batchFromColumns`; date fields go through `parseDate` (→ epoch seconds) then `dateOrNull`.
- `noUncheckedIndexedAccess` is on: guard array/cell reads (the parsers null-check before use, e.g.
  `at(cells, col)` returning `undefined` for a missing column) so cells don't type as `undefined`.
- vgi-lint rules to keep satisfied: catalog/schema descriptions must NOT enumerate the worker's own
  functions (VGI173); numeric column comments should state units (VGI131 — "per share in USD",
  "percent points"); argument docs must NOT restate the data type (VGI313); every function needs an
  agent test task (VGI520 — products/holdings table+function/fund_details are covered in `catalog.ts`
  `vgi.agent_test_tasks`).
- Don't add a secret type; this worker is keyless by design.
- Keep the `holdings` current-only contract: do NOT add `supportsTimeTravel` or an as-of arg.
- Products PK is `[ticker]` (First Trust exposes no catalog-level ISIN/CUSIP).

## DuckDB (manual)

```sql
LOAD vgi;
ATTACH 'firsttrust' AS firsttrust (TYPE vgi, LOCATION '/path/to/vgi-etf-first-trust/bin/vgi-etf-first-trust-worker');
SELECT ticker, fund_name, sec_yield_30day_percent FROM firsttrust.products ORDER BY sec_yield_30day_percent DESC LIMIT 10;
SELECT name, ticker, weight_percent FROM firsttrust.holdings WHERE fund_ticker = 'FTCS' ORDER BY weight_percent DESC LIMIT 10;
SELECT ticker, net_assets, expense_ratio_percent FROM firsttrust.fund_details('FTCS');
```
