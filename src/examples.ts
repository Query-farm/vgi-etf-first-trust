// Composed example queries: each one combines two of the worker's own objects (products,
// holdings, fund_details) in a single query. Every example is defined ONCE here and referenced
// from both the schema-level vgi.example_queries list (catalog.ts) and the example list of the
// object that drives the query (so the vgi-lint agent simulator, which shows only per-object
// examples, sees it too).

export interface ExampleQuery {
  description: string;
  sql: string;
}

/** products → holdings: the category filter on products picks the funds (join-pushed into holdings). */
export const ALT_FUNDS_TOP_POSITIONS: ExampleQuery = {
  description:
    "The three largest positions of every Alternative fund, with the fund's name — products picks " +
    "the funds by category and holdings supplies their positions (futures, cash and fund-of-fund " +
    "lines included)",
  sql:
    "SELECT p.ticker, p.fund_name, h.name, h.weight_percent " +
    "FROM firsttrust.main.products p JOIN firsttrust.main.holdings h ON h.fund_ticker = p.ticker " +
    "WHERE p.category = 'Alternative Funds' " +
    "QUALIFY row_number() OVER (PARTITION BY p.ticker ORDER BY h.weight_percent DESC) <= 3 " +
    "ORDER BY p.ticker, h.weight_percent DESC",
};

/** products + aggregated holdings: a concentration screen across one fund-type category. */
export const SECTOR_FUND_CONCENTRATION: ExampleQuery = {
  description:
    "Concentration screen of the Sector & Industry funds: each fund's number of listed holding " +
    "lines and the combined weight of its top 10, most concentrated first",
  sql:
    "SELECT p.ticker, p.fund_name, count(*) AS positions, " +
    "round(sum(h.weight_percent) FILTER (WHERE h.rn <= 10), 2) AS top10_weight_percent " +
    "FROM firsttrust.main.products p JOIN (SELECT fund_ticker, weight_percent, " +
    "row_number() OVER (PARTITION BY fund_ticker ORDER BY weight_percent DESC) AS rn " +
    "FROM firsttrust.main.holdings) h ON h.fund_ticker = p.ticker " +
    "WHERE p.category = 'Sector & Industry Funds' " +
    "GROUP BY p.ticker, p.fund_name ORDER BY top10_weight_percent DESC",
};

/** fund_details × aggregated holdings: reconcile published positions against the fund's facts. */
export const FTCS_HOLDINGS_RECONCILIATION: ExampleQuery = {
  description:
    "Reconcile FTCS's published holdings with its fund facts: reported holding count vs listed " +
    "lines (which include cash), and the holdings' total market value as a percent of net assets",
  sql:
    "WITH h AS (SELECT count(*) AS listed_positions, sum(market_value) AS holdings_value " +
    "FROM firsttrust.main.holdings WHERE fund_ticker = 'FTCS') " +
    "SELECT d.ticker, d.num_holdings, h.listed_positions, d.net_assets, h.holdings_value, " +
    "round(100 * h.holdings_value / d.net_assets, 2) AS pct_of_net_assets " +
    "FROM firsttrust.main.fund_details('FTCS') d CROSS JOIN h ORDER BY d.ticker",
};
