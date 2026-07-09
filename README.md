# vgi-etf-first-trust

A [VGI](https://query.farm) worker that exposes **First Trust** US ETF data as DuckDB tables — the
full ETF catalog, a partitioned holdings table, and a per-fund details function.

| Object | What it returns | First Trust source |
| --- | --- | --- |
| `firsttrust.products` (table) | Every US ETF with key facts, one row per fund | the `etflist.aspx` page |
| `firsttrust.holdings` (table) | Detailed current holdings, partitioned by fund_ticker | per-fund `EtfHoldings.aspx?Ticker=…` |
| `firsttrust.fund_details(fund)` | A one-row deep snapshot (expense ratio, net assets, objective, …) | per-fund `EtfSummary.aspx?Ticker=…` |

Everything rides First Trust's public website — there is no secret to create and no login. Funds
are identified by their exchange **ticker** (e.g. `FTCS`); the holdings table resolves the fund
universe via one `etflist.aspx` lookup.

Two conventions to know:
- **Dates are real `DATE` columns** (no timezone) — compare them directly, e.g.
  `WHERE inception_date >= DATE '2020-01-01'`.
- **Percent columns carry a `_percent` suffix and hold percent points**:
  `expense_ratio_percent` = 0.53 means 0.53%; `weight_percent` = 2.59 means 2.59% (weights sum to
  ~100).

> **Current holdings only.** First Trust publishes a single, current holdings page per fund, so
> `holdings` has **no time travel / as-of argument** — `as_of_date` reflects the page's own
> published date. (This matches the sibling `vgi-etf-globalx` / `vgi-etf-spdr` workers and differs from
> `vgi-etf-ishares`.)

> **Status:** initial build. Unit tests (SDK-free driver + Arrow batch builders), own-source
> typecheck, a live HTTP-transport smoke test, the haybarn SQLLogic E2E suite against a real
> DuckDB + the community `vgi` extension, and a `vgi-lint` metadata gate at 100/100 all pass.

## Install / attach

### Option A — prebuilt binary (recommended)

Each release ships a self-contained executable per platform, so the host needs **neither Bun nor
`node_modules`**. Archives are named `vgi-etf-first-trust-<tag>-<platform>.tar.gz` for `linux_amd64`,
`linux_arm64`, `osx_amd64`, `osx_arm64`, and `windows_amd64`, each with a SHA256, a keyless
**cosign** signature, and a **SLSA** build-provenance attestation.

```bash
tar xzf vgi-etf-first-trust-v0.1.0-osx_arm64.tar.gz     # → vgi-etf-first-trust-worker
```

```sql
LOAD vgi;
ATTACH 'firsttrust' AS firsttrust (TYPE vgi, LOCATION '/path/to/vgi-etf-first-trust-worker');
```

### Option B — from source (Bun)

For development or the latest `main`, run the worker on [Bun](https://bun.sh):

```bash
bun install
```

```sql
LOAD vgi;
ATTACH 'firsttrust' AS firsttrust (TYPE vgi, LOCATION '/path/to/vgi-etf-first-trust/bin/vgi-etf-first-trust-worker');
```

`bin/vgi-etf-first-trust-worker` is a small wrapper that launches `src/worker.ts` under Bun.

### Option C — container image (ghcr.io)

A multi-arch (linux/amd64 + linux/arm64), cosign-signed image is published to
`ghcr.io/query-farm/vgi-etf-first-trust` on every release — no local Bun or worker binary needed.
Attach it directly over the VGI container transport:

```sql
LOAD vgi;
ATTACH 'firsttrust' AS firsttrust (TYPE vgi, LOCATION 'oci://ghcr.io/query-farm/vgi-etf-first-trust:latest');
```

Or run the HTTP transport yourself and attach that:

```bash
docker run --rm -p 8000:8000 ghcr.io/query-farm/vgi-etf-first-trust:latest   # serves /health + the VGI RPC on :8000
```

```sql
LOAD vgi;
ATTACH 'firsttrust' AS firsttrust (TYPE vgi, LOCATION 'http://localhost:8000');
```

`:latest` always tracks the newest release.

## Usage

### products — the fund catalog (a base table)

`products` is a plain **table** — no arguments, no parentheses. It returns the whole ETF lineup;
filter with `WHERE`.

```sql
-- Highest 30-day SEC yields in the lineup:
SELECT ticker, fund_name, sec_yield_30day_percent
FROM firsttrust.products
WHERE sec_yield_30day_percent IS NOT NULL
ORDER BY sec_yield_30day_percent DESC
LIMIT 10;

-- Every income fund:
SELECT ticker, fund_name, distribution_rate_12m_percent
FROM firsttrust.products
WHERE category = 'Income Funds'
ORDER BY distribution_rate_12m_percent DESC;

-- Look up one fund by ticker:
SELECT ticker, fund_name, inception_date, nav
FROM firsttrust.products
WHERE ticker = 'FTCS';
```

Columns include `ticker`, `fund_name`, `category` (the fund-type section: `'Income Funds'`,
`'Sector & Industry Funds'`, `'Size/Style Funds'`, `'Global/International Funds'`,
`'Thematic Funds'`, `'Specialty Funds'`, `'Alternative Funds'`, `'Target Outcome Funds'`),
`inception_date` (DATE), `nav`, `sec_yield_30day_percent`,
`unsubsidized_sec_yield_30day_percent`, `distribution_rate_12m_percent`, `yield_as_of_date`
(DATE), and `summary_url`. All `*_percent` columns are in percent points. Note the catalog is
intentionally thin on expense ratio / net assets — those live in `fund_details`.

### holdings — a hive-partitioned table

`holdings` is a **table hive-partitioned by `fund_ticker`** (the fund's ticker). Filter
`fund_ticker` to pick funds, or scan without a filter to stream **every** fund's holdings (one
partition per fund — ~300 funds, so prefer a filter).

```sql
-- Top 10 current holdings of FTCS (already weight-ordered):
SELECT name, ticker, weight_percent, market_value
FROM firsttrust.holdings
WHERE fund_ticker = 'FTCS'
ORDER BY weight_percent DESC
LIMIT 10;

-- The sector mix of a fund:
SELECT sector, sum(weight_percent) AS weight
FROM firsttrust.holdings
WHERE fund_ticker = 'FTCS'
GROUP BY sector ORDER BY weight DESC;

-- Several funds at once (partition fan-out):
SELECT fund_ticker, name, weight_percent
FROM firsttrust.holdings
WHERE fund_ticker IN ('FTCS', 'AIRR');
```

`fund_ticker` is the **fund's** ticker and the hive partition key — distinct from the `ticker`
column (each row's own constituent identifier; blank for some fixed-income lines). Columns:
`weight_percent`, `ticker`, `name`, `cusip`, `sector` (present for equity funds; blank for many
bond funds), `shares_held`, `market_value`. Rows come back **weight-descending**. `as_of_date`
(DATE) is the page's published date — First Trust publishes **current holdings only**, so there is
no historical time travel. Join `holdings.fund_ticker` to `products.ticker` for fund-level facts.

> A backing `holdings_scan()` function is also exposed (it's what the table scans, and it's what
> lets DuckDB push the `fund_ticker` filter) — prefer the `holdings` table.

### fund_details(fund) — a deep one-row snapshot

`fund_details` takes a ticker and returns one row of the facts the catalog does not carry —
expense ratio, net assets, shares outstanding, advisor, number of holdings, and the investment
objective. It fetches the fund's summary page on demand.

```sql
SELECT ticker, net_assets, expense_ratio_percent, num_holdings
FROM firsttrust.fund_details('FTCS');

SELECT objective FROM firsttrust.fund_details('FTCS');
```

## Development

```bash
bun install
bun test            # unit tests (SDK-free driver + Arrow batch builders + live HTTP transport)
bun run typecheck   # own-source typecheck (see scripts/typecheck.sh)
./run_tests.sh      # haybarn SQLLogic E2E under a real DuckDB + the community vgi extension
```

The E2E suite needs the haybarn runner and the vgi extension, once:

```bash
uv tool install haybarn-unittest
echo "INSTALL vgi FROM community;" | uvx haybarn-cli
```

Metadata quality is graded by [`vgi-lint`](https://github.com/Query-farm/vgi-lint-check); CI runs
it as a gate at 100/100. Locally:

```bash
uvx --prerelease allow --from vgi-lint-check vgi-lint bin/vgi-etf-first-trust-worker --fail-on info
```

The pure request/response logic lives in `src/firsttrust.ts` and is fully unit-tested against an
in-process fake (`test/fake-firsttrust.ts`) — no network. The single module that touches the
network is `src/client.ts` (it sets the browser-like User-Agent First Trust requires); it is
verified live rather than in the unit suite.

## Data format: the ftportfolios.com HTML scrape

First Trust's site is a **server-rendered ASP.NET** app — plain `fetch` with a browser User-Agent
returns the full HTML (no headless browser needed). Three keyless pages back the read paths:

- **`etflist.aspx`** — the ETF catalog, rendered as one `searchResults` HTML table per fund-type
  section (each preceded by a section caption that becomes the row's `category`). One data row per
  fund links its name to `EtfSummary.aspx?Ticker=…`; the value cells are fixed-position.
- **`EtfHoldings.aspx?Ticker=…`** — the per-fund constituents in a `fundSilverGrid` table. Parsing
  is **header-driven** (each column mapped by its label), so equity funds (which carry a
  Classification/sector column) and fixed-income funds (which do not) both bind. The as-of date
  comes from the "Holdings of the Fund as of M/D/YYYY" heading.
- **`EtfSummary.aspx?Ticker=…`** — the per-fund key facts in a `CEFFieldLabel` → `CEFPagesBody`
  label/value table, plus the objective prose. Backs `fund_details`.

No JSON API, no downloadable file, and no extra dependency — everything is parsed from the
server-rendered HTML in the driver.

## Layout

```
src/firsttrust.ts  Pure driver: URL builders + HTML parsers + fetch orchestrators (no network, no SDK)
src/client.ts      Real fetch client (browser User-Agent; keyless): a single text get (HTML)
src/schema.ts      Typed Arrow output schemas + row→batch builders
src/functions.ts   The products/holdings backing scans + the fund_details function
src/catalog.ts     The `firsttrust` catalog descriptor (no secret type)
src/worker.ts      Worker entry: wires the real client into the functions
bin/…-worker       Launch wrapper (bun run src/worker.ts) for DuckDB ATTACH
```

## Data source & terms

Data comes from First Trust's public website (the ETF list, holdings, and summary pages). It is
provided for personal, informational use; consult First Trust's terms before any redistribution or
commercial use. This worker is not affiliated with or endorsed by First Trust Portfolios L.P. /
First Trust Advisors L.P.

## License

MIT — Copyright 2026 Query Farm LLC · https://query.farm
