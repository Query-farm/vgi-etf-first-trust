// The `firsttrust` catalog descriptor + its metadata tags (the vgi.* discovery/doc channels
// vgi-lint grades). First Trust's public ETF pages are KEYLESS, so there is NO secret type here.
//
// Tag shapes follow vgi-lint's TAGS.md: JSON-valued tags (keywords/categories/
// executable_examples/agent_test_tasks) are JSON strings; all example SQL is
// catalog-qualified (firsttrust.main.<obj>) so it binds/runs when the catalog is attached.

import type { CatalogDescriptor, VgiFunction } from "@query-farm/vgi";
import { Arguments } from "@query-farm/vgi";
import {
  productsSchema,
  holdingsSchema,
  fundDetailsSchema,
  resultColumnsSchema,
} from "./schema.js";

const REPO = "https://github.com/Query-farm/vgi-etf-first-trust";
const ISSUES = `${REPO}/issues`;

/** Per-column comments for the products table (surface as Arrow field metadata). */
const PRODUCTS_COLUMN_COMMENTS: Record<string, string> = {
  ticker: "Exchange ticker (e.g. FTCS).",
  fund_name: "Full fund name as marketed, e.g. 'First Trust Capital Strength® ETF'.",
  category: "Fund-type section the fund is listed under (Income, Sector & Industry, Size/Style, Global/International, Thematic, Specialty, Alternative, Target Outcome).",
  inception_date: "Fund inception date.",
  nav: "Closing net asset value per share, in USD.",
  sec_yield_30day_percent: "30-day SEC yield, percent points (0.71 = 0.71%); null when not reported.",
  unsubsidized_sec_yield_30day_percent: "Unsubsidized 30-day SEC yield, percent points; null when not reported.",
  distribution_rate_12m_percent: "12-month trailing distribution rate, percent points; null when not reported.",
  yield_as_of_date: "As-of date for the yield / distribution-rate columns.",
  summary_url: "URL of the fund's First Trust summary page (also the source for fund_details).",
};

/** Table-level metadata for the products base table (the vgi.* doc/discovery channels). */
const PRODUCTS_TABLE_TAGS: Record<string, string> = {
  "vgi.category": "catalog",
  domain: "finance",
  "vgi.keywords": JSON.stringify([
    "ETF",
    "fund catalog",
    "product list",
    "yield",
    "distribution rate",
    "category",
    "ticker",
  ]),
  "vgi.doc_llm":
    "The First Trust US ETF catalog as a plain table (query it directly, no arguments): one row " +
    "per ETF with ticker, name, fund-type category, inception date, closing NAV, 30-day SEC " +
    "yield, unsubsidized SEC yield, and 12-month trailing distribution rate. Narrow it with a " +
    "WHERE clause on ticker, category, and so on. Percent columns hold percent points (0.71 " +
    "means 0.71%). Start here to find a fund's ticker; expense ratio and net assets live in " +
    "fund_details, not here.",
  "vgi.doc_md":
    "## products\n\n" +
    "The First Trust US ETF catalog as a base table — one row per fund. It takes no arguments; " +
    "query it directly and filter with a WHERE clause (e.g. `WHERE category = 'Income Funds' " +
    "ORDER BY sec_yield_30day_percent DESC`; see the example queries). Percent columns " +
    "(`*_percent`) are in **percent points** (a yield of 0.71 means 0.71%). The ticker column is " +
    "the key for the holdings table and fund_details.",
  "vgi.example_queries": JSON.stringify([
    { description: "Highest 30-day SEC yields in the lineup", sql: "SELECT ticker, fund_name, sec_yield_30day_percent FROM firsttrust.main.products WHERE sec_yield_30day_percent IS NOT NULL ORDER BY sec_yield_30day_percent DESC LIMIT 10" },
    { description: "Every income fund", sql: "SELECT ticker, fund_name, distribution_rate_12m_percent FROM firsttrust.main.products WHERE category = 'Income Funds' ORDER BY distribution_rate_12m_percent DESC" },
    { description: "Look up a single fund by ticker", sql: "SELECT ticker, fund_name, inception_date, nav FROM firsttrust.main.products WHERE ticker = 'FTCS'" },
  ]),
  "vgi.result_columns_schema": resultColumnsSchema(productsSchema(), PRODUCTS_COLUMN_COMMENTS),
};

/** Per-column comments for the holdings table. */
const HOLDINGS_COLUMN_COMMENTS: Record<string, string> = {
  fund_ticker: "The fund's ticker (e.g. FTCS) — the hive partition key; constant for every row of a fund. Filter on it to pick funds; omit to stream all.",
  as_of_date: "Holdings as-of date (the page's own 'Holdings of the Fund as of' date; current holdings only).",
  weight_percent: "Percent of the fund's net assets, in percent points (2.59 = 2.59%; weights sum to ~100).",
  ticker: "Constituent ticker / identifier (blank for some fixed-income lines).",
  name: "Constituent / security name.",
  cusip: "Constituent CUSIP identifier.",
  sector: "Constituent sector / classification (populated for equity funds; blank for many bond funds).",
  shares_held: "Number of shares / units (quantity) held.",
  market_value: "Market value of the position, in USD.",
};

/** Table-level metadata for the holdings base table (ticker-partitioned, current holdings). */
const HOLDINGS_TABLE_TAGS: Record<string, string> = {
  "vgi.category": "holdings",
  domain: "finance",
  "vgi.keywords": JSON.stringify([
    "holdings",
    "constituents",
    "portfolio",
    "weights",
    "positions",
    "exposure",
  ]),
  "vgi.doc_llm":
    "Detailed portfolio holdings for First Trust ETFs as a hive-partitioned table. It is " +
    "partitioned by fund_ticker (the FUND's ticker, distinct from the constituent `ticker` " +
    "column): filter `WHERE fund_ticker = '…'` (or `fund_ticker IN (…)`) to pick funds, or scan " +
    "with no filter to stream EVERY fund's holdings (~300 funds — slow, so prefer a filter). " +
    "First Trust publishes CURRENT holdings only, so there is no historical as-of date; " +
    "as_of_date is the page's own date. Rows come back weight-descending; weight_percent is in " +
    "percent points (2.59 = 2.59%). Join on fund_ticker to products.ticker for fund-level facts.",
  "vgi.doc_md":
    "## holdings\n\n" +
    "Detailed fund holdings as a **hive-partitioned table**, partitioned by `fund_ticker` (the " +
    "fund's ticker). `fund_ticker` is distinct from `ticker` (the constituent's own ticker). " +
    "Filter `WHERE fund_ticker = 'FTCS'` for one fund's holdings (see the example queries).\n\n" +
    "`WHERE fund_ticker IN ('FTCS','AIRR')` fans out per partition; an unfiltered scan streams " +
    "every fund (~300 partitions — slow). First Trust publishes **current holdings only** (no " +
    "historical dates). `weight_percent` is in percent points (2.59 = 2.59%).",
  "vgi.result_columns_schema": resultColumnsSchema(holdingsSchema(), HOLDINGS_COLUMN_COMMENTS),
  "vgi.example_queries": JSON.stringify([
    { description: "Top 10 current holdings of FTCS", sql: "SELECT name, ticker, weight_percent FROM firsttrust.main.holdings WHERE fund_ticker = 'FTCS' ORDER BY weight_percent DESC LIMIT 10" },
    { description: "The sector mix of a fund", sql: "SELECT sector, sum(weight_percent) AS weight FROM firsttrust.main.holdings WHERE fund_ticker = 'FTCS' GROUP BY sector ORDER BY weight DESC" },
    { description: "Two funds at once (partition fan-out)", sql: "SELECT fund_ticker, name, weight_percent FROM firsttrust.main.holdings WHERE fund_ticker IN ('FTCS', 'AIRR')" },
  ]),
};

/** Catalog-level tags: docs, discovery, provenance, and the agent-test suite. */
const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "First Trust ETFs",
  "vgi.doc_llm":
    "First Trust US ETF data as SQL. Reach for it to screen the ETF lineup on key facts (yield, " +
    "distribution rate, fund-type category), to pull a fund's deeper facts (expense ratio, net " +
    "assets, objective), and to inspect what a fund currently holds. The central concept is the " +
    "fund, identified by its exchange ticker (e.g. FTCS); start from the catalog to find that " +
    "key, then drill into a fund's details or holdings. Data is First Trust's public fund " +
    "website: best-effort, for informational use.",
  "vgi.doc_md":
    "## First Trust ETFs\n\n" +
    "First Trust US ETF data, exposed as DuckDB tables and a table function.\n\n" +
    "The **fund** is the unit of the data and is keyed by an exchange `ticker` (e.g. `FTCS`) — " +
    "begin at the catalog to discover that key, then drill into a fund's deeper facts or its " +
    "holdings. Holdings are the current published portfolio (First Trust does not publish " +
    "historical holdings).\n\n" +
    "Data is provided for informational use; review First Trust's terms before redistribution.",
  "vgi.keywords": JSON.stringify([
    "ETF",
    "First Trust",
    "holdings",
    "portfolio",
    "fund",
    "target outcome",
    "buffer",
    "AlphaDEX",
    "income",
    "expense ratio",
  ]),
  "vgi.author": "Query Farm LLC",
  "vgi.copyright": "Copyright 2026 Query Farm LLC",
  "vgi.license": "MIT",
  "vgi.support_contact": ISSUES,
  "vgi.support_policy_url": ISSUES,
  // At least one guaranteed-runnable example at the catalog level (VGI509). No
  // expected_result — First Trust data is live/non-deterministic.
  "vgi.executable_examples": JSON.stringify([
    {
      name: "income_funds",
      description: "First Trust income ETFs by 12-month distribution rate",
      sql: "SELECT ticker, fund_name, distribution_rate_12m_percent FROM firsttrust.main.products WHERE category = 'Income Funds' ORDER BY distribution_rate_12m_percent DESC LIMIT 5",
    },
    {
      name: "top_holdings",
      description: "The top holdings of the First Trust Capital Strength ETF",
      sql: "SELECT name, ticker, weight_percent FROM firsttrust.main.holdings WHERE fund_ticker = 'FTCS' ORDER BY weight_percent DESC LIMIT 5",
    },
    {
      name: "fund_facts",
      description: "Expense ratio and net assets for a fund",
      sql: "SELECT ticker, net_assets, expense_ratio_percent FROM firsttrust.main.fund_details('FTCS')",
    },
  ]),
  // Agent-suitability suite (catalog only). Each task carries a deterministic check_sql that
  // asserts specific ground truth; reference_sql is deliberately omitted (live data). One task
  // per callable surface (products, holdings, holdings_scan, fund_details) satisfies VGI520.
  "vgi.agent_test_tasks": JSON.stringify([
    {
      name: "ftcs_exists",
      prompt: "Does First Trust offer an ETF with the ticker FTCS, and what is it called?",
      check_sql: "SELECT count(*) > 0 FROM firsttrust.main.products WHERE ticker = 'FTCS'",
      success_criteria: "The answer confirms FTCS is the First Trust Capital Strength ETF, found via the products table.",
    },
    {
      name: "ftcs_expense_ratio",
      prompt: "What is the expense ratio of the First Trust Capital Strength ETF (FTCS)?",
      check_sql: "SELECT count(*) > 0 FROM firsttrust.main.fund_details('FTCS') WHERE expense_ratio_percent IS NOT NULL",
      success_criteria: "The answer reports FTCS's expense ratio (a small percentage) from fund_details.",
    },
    {
      name: "ftcs_top_holding",
      prompt: "What is the single largest holding of the First Trust Capital Strength ETF (FTCS) right now?",
      check_sql: "SELECT count(*) > 0 FROM firsttrust.main.holdings WHERE fund_ticker = 'FTCS'",
      success_criteria: "The answer names FTCS's top holding by weight, obtained from the holdings table.",
    },
    {
      name: "ftcs_holdings_scan",
      prompt: "Using the holdings backing scan, list a few FTCS constituents by weight.",
      check_sql: "SELECT count(*) > 0 FROM firsttrust.main.holdings_scan() WHERE fund_ticker = 'FTCS'",
      success_criteria: "The answer returns FTCS constituents via holdings_scan() filtered by fund_ticker.",
    },
  ]),
};

/** Schema-level tags: docs, discovery, the category registry, and shown examples. */
const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "First Trust Fund Data",
  "vgi.doc_llm":
    "First Trust ETF data at two levels. At the catalog level you screen the whole lineup on key " +
    "facts and resolve a fund's key, and pull a single fund's deeper facts (expense ratio, net " +
    "assets, objective). At the fund level you drill into one fund's current holdings. A fund is " +
    "keyed by its exchange `ticker` (e.g. `FTCS`); resolve the key at the catalog level first.",
  "vgi.doc_md":
    "## First Trust fund data\n\n" +
    "Work happens at two levels. **Catalog level:** screen the lineup on key facts, find a " +
    "fund's key, and pull a single fund's deeper facts. **Fund level:** drill into a single " +
    "fund's constituents. A fund is keyed by its exchange `ticker` (e.g. `FTCS`).\n\n" +
    "Holdings are the current published portfolio; First Trust does not publish historical holdings.",
  "vgi.keywords": JSON.stringify(["ETF holdings", "fund catalog", "portfolio", "First Trust", "target outcome"]),
  domain: "finance",
  // Ordered navigation registry; each `name` is referenced by a function's vgi.category.
  "vgi.categories": JSON.stringify([
    { name: "catalog", title: "Fund Catalog", description: "The ETF product list and per-fund key facts." },
    { name: "holdings", title: "Holdings", description: "Detailed current portfolio holdings." },
  ]),
  "vgi.example_queries": JSON.stringify([
    { description: "Highest-yielding First Trust ETFs", sql: "SELECT ticker, fund_name, sec_yield_30day_percent FROM firsttrust.main.products WHERE sec_yield_30day_percent IS NOT NULL ORDER BY sec_yield_30day_percent DESC LIMIT 10" },
    { description: "Top holdings of FTCS", sql: "SELECT name, ticker, weight_percent FROM firsttrust.main.holdings WHERE fund_ticker = 'FTCS' ORDER BY weight_percent DESC LIMIT 10" },
  ]),
};

/**
 * @param functions    the callable table functions — here just `fund_details`. products and
 *                      holdings are base tables (not listed as callable functions).
 * @param productsScan  the zero-arg scan backing the `products` base table.
 * @param holdingsScan  the pushdown scan backing the `holdings` base table.
 * Both scans are registered for scan dispatch; productsScan is exposed only as a table, while
 * holdingsScan is also LISTED so the extension can push the fund_ticker filter into it.
 */
export function makeCatalog(
  functions: VgiFunction[],
  productsScan: VgiFunction,
  holdingsScan: VgiFunction,
): CatalogDescriptor {
  return {
    name: "firsttrust",
    defaultSchema: "main",
    comment:
      "First Trust US ETF data as DuckDB tables: products (catalog) & holdings " +
      "(ticker-partitioned, current holdings), plus fund_details — vgi-etf-first-trust",
    sourceUrl: REPO,
    tags: CATALOG_TAGS,
    schemas: [
      {
        name: "main",
        comment: "First Trust fund data: the ETF catalog, per-fund details, and detailed current holdings.",
        tags: SCHEMA_TAGS,
        functions: [...functions, holdingsScan],
        tables: [
          {
            name: "products",
            function: productsScan,
            arguments: new Arguments([], new Map()),
            // Each fund is keyed by its exchange ticker (advisory — not enforced on scan).
            primaryKey: [["ticker"]],
            // The First Trust US ETF lineup is ~316 funds; headroom to ~500.
            inlinedCardinality: { estimate: 316n, max: 500n },
            comment:
              "Every First Trust US ETF with its key facts, one row per fund. Query directly (no " +
              "arguments) and filter with WHERE; percent columns are in percent points.",
            columnComments: PRODUCTS_COLUMN_COMMENTS,
            tags: PRODUCTS_TABLE_TAGS,
          },
          {
            name: "holdings",
            function: holdingsScan,
            arguments: new Arguments([], new Map()),
            // fund_ticker is always populated (the scan tags every row with its fund).
            notNull: ["fund_ticker"],
            // Hive partition key: fund_ticker. A WHERE fund_ticker = … / IN (…) filter is pushed
            // down to fetch just those funds; an unfiltered scan streams every fund (all partitions).
            // First Trust publishes current holdings only, so there is NO time travel.
            // Whole-table estimate: ~316 funds × ~100 constituents each (bond funds reach several
            // hundred). A single-fund filter scans one partition.
            inlinedCardinality: { estimate: 32000n, max: 200000n },
            comment:
              "Detailed current fund holdings, hive-partitioned by fund_ticker (filter WHERE " +
              "fund_ticker = … for one fund, or scan unfiltered for all). First Trust publishes " +
              "current holdings only (no historical dates).",
            columnComments: HOLDINGS_COLUMN_COMMENTS,
            tags: HOLDINGS_TABLE_TAGS,
          },
        ],
      },
    ],
  };
}
