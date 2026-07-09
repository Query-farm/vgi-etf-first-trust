// A tiny in-process fake of the First Trust endpoints — enough to prove the driver: it records
// every requested URL (so a test can assert the wire contract) and returns canned HTML shaped
// like the real ETF list page (server-rendered sections of `searchResults` tables), the per-fund
// holdings page (a `fundSilverGrid` table + an "as of" heading), and the per-fund summary page
// (a `CEFFieldLabel`/`CEFPagesBody` key-facts table + the objective span).
//
// The driver takes ONE injected transport: `get(url) => Promise<string>` (HTML text). No network.

import { ETFLIST_URL, holdingsUrl, summaryUrl } from "../src/firsttrust.js";

export class FakeFirsttrust {
  /** Every URL this fake was asked for, in order. */
  readonly calls: string[] = [];

  constructor(private readonly route: (url: string) => string) {}

  get = async (url: string): Promise<string> => {
    this.calls.push(url);
    return this.route(url);
  };
}

// ── ETF list page ────────────────────────────────────────────────────────────────

export interface FakeFund {
  ticker: string;
  name: string;
  inception: string; // MM/DD/YY
  nav: string; // e.g. "$23.85"
  secYield: string; // e.g. "0.71%" or "-------"
  unsubYield: string; // e.g. "-------"
  distRate: string; // e.g. "8.77%" or ""
  yieldAsOf: string; // MM/DD/YY or "-------"
}

export const FTHI_FUND: FakeFund = {
  ticker: "FTHI",
  name: "First Trust BuyWrite Income ETF",
  inception: "01/06/14",
  nav: "$23.85",
  secYield: "0.71%",
  unsubYield: "-------",
  distRate: "8.77%",
  yieldAsOf: "06/30/26",
};

export const LGOV_FUND: FakeFund = {
  ticker: "LGOV",
  name: "First Trust Long Duration Opportunities ETF",
  inception: "01/22/19",
  nav: "$21.22",
  secYield: "4.27%",
  unsubYield: "-------",
  distRate: "4.26%",
  yieldAsOf: "06/30/26",
};

export const FTCS_FUND: FakeFund = {
  ticker: "FTCS",
  name: "First Trust Capital Strength® ETF",
  inception: "07/06/06",
  nav: "$96.42",
  secYield: "1.23%",
  unsubYield: "-------",
  distRate: "1.05%",
  yieldAsOf: "06/30/26",
};

export const AIRR_FUND: FakeFund = {
  ticker: "AIRR",
  name: "First Trust RBA American Industrial Renaissance® ETF",
  inception: "03/10/14",
  nav: "$122.52",
  secYield: "-------",
  unsubYield: "-------",
  distRate: "",
  yieldAsOf: "-------",
};

/** One data `<tr>` (11 cells; a blank spacer at index 6) for the searchResults table. */
function fundRow(f: FakeFund): string {
  return (
    "<tr >" +
    `<td><a href='/Retail/Etf/EtfSummary.aspx?Ticker=${f.ticker}'>${f.name}</a></td>` +
    `<td>${f.ticker}</td>` +
    `<td>${f.inception}</td>` +
    `<td>${f.nav}</td>` +
    `<td>${f.secYield}</td>` +
    `<td>${f.unsubYield}</td>` +
    `<td></td>` +
    `<td>${f.distRate}</td>` +
    `<td>${f.yieldAsOf}</td>` +
    `<td><a href='/Common/ContentFileLoader.aspx?ContentGUID=fact'>fs</a></td>` +
    `<td><a href='/Common/ContentFileLoader.aspx?ContentGUID=pros'>sp</a></td>` +
    "</tr>"
  );
}

/** A `searchResults` section: a lblETFSectionTitle caption + a header row + the fund rows. */
function section(idx: number, category: string, funds: FakeFund[]): string {
  return (
    `<span id="ContentPlaceHolder1_etfsearch_ctl0${idx}_lblETFSectionTitle" style="color:White;">${category}</span>` +
    '<table cellpadding="0" cellspacing="0" class="searchResults small" width="100%" border="0">' +
    "<tr><th>Fund Name</th><th>Ticker</th><th>Inception</th><th>Close NAV</th><th>30-Day SEC Yield</th>" +
    "<th>Unsubsidized</th><th>12-Month Distribution</th><th>Yield As Of</th><th>Fact Sheet</th><th>Prospectus</th></tr>" +
    funds.map(fundRow).join("\n") +
    "</table>"
  );
}

/** Build the full ETF list page HTML from category → funds sections. */
export function etflistHtml(sections: { category: string; funds: FakeFund[] }[]): string {
  const body = sections.map((s, i) => section(i, s.category, s.funds)).join("\n");
  return "<!doctype html><html><head><title>ETF List</title></head><body>" + body + "</body></html>";
}

/** The default fixture: two sections covering four funds. */
export const DEFAULT_SECTIONS = [
  { category: "Income Funds", funds: [FTHI_FUND, LGOV_FUND] },
  { category: "Size/Style Funds", funds: [FTCS_FUND, AIRR_FUND] },
];

export const defaultEtflistHtml = (): string => etflistHtml(DEFAULT_SECTIONS);

// ── per-fund holdings page ─────────────────────────────────────────────────────

/** An equity holdings page (FTCS-shaped): 7 columns incl. Classification, plus a cash line. */
export function equityHoldingsHtml(asOf = "7/8/2026"): string {
  return (
    "<!doctype html><html><body>" +
    `<span id="ContentPlaceHolder1_HoldingsListing_lblHoldingsTitle" class="PageHeading">Holdings of the Fund as of ${asOf}</span>` +
    '<table width="100%" class="fundSilverGrid" style="border-collapse: collapse;">' +
    '<tr class="fundSilverGridHeader">' +
    '<td class="fundSilverGridHeader sortableColumn">Security Name </td>' +
    '<td class="fundSilverGridHeader sortableColumn">Identifier </td>' +
    '<td class="fundSilverGridHeader sortableColumn">CUSIP </td>' +
    '<td class="fundSilverGridHeader sortableColumn">Classification </td>' +
    '<td class="fundSilverGridHeader sortableColumn">Shares / Quantity </td>' +
    '<td class="fundSilverGridHeader sortableColumn">Market Value </td>' +
    '<td class="fundSilverGridHeader sortableColumn">Weighting </td>' +
    "</tr>" +
    // Intentionally NOT weight-ordered, to prove the parser sorts desc.
    row("Monster Beverage Corporation", "MNST", "61174X109", "Consumer Staples", "2,001,229", "$190,416,939.35", "2.44%") +
    row("Cisco Systems, Inc.", "CSCO", "17275R102", "Telecommunications", "1,780,110", "$202,612,120.20", "2.59%") +
    row("US Dollar", "$USD", "", "Other", "6,073,763", "$6,073,763.14", "0.08%") +
    "</table></body></html>"
  );
}

/** A fixed-income holdings page (LGOV-shaped): 6 columns, NO Classification, blank tickers. */
export function bondHoldingsHtml(asOf = "7/8/2026"): string {
  return (
    "<!doctype html><html><body>" +
    `<span class="PageHeading">Holdings of the Fund as of ${asOf}</span>` +
    '<table width="100%" class="fundSilverGrid">' +
    '<tr class="fundSilverGridHeader">' +
    '<td class="fundSilverGridHeader">Security Name </td>' +
    '<td class="fundSilverGridHeader">Identifier </td>' +
    '<td class="fundSilverGridHeader">CUSIP </td>' +
    '<td class="fundSilverGridHeader">Shares / Quantity </td>' +
    '<td class="fundSilverGridHeader">Market Value / Notional Value </td>' +
    '<td class="fundSilverGridHeader">Weighting </td>' +
    "</tr>" +
    rowBond("US Dollar", "$USD", "", "20,823,208", "$20,823,207.55", "3.30%") +
    rowBond("Fannie Mae Series 2012-134, Class ZC, 2.50%, due 12/25/2042", "", "3136AAWE1", "25,197,034", "$19,755,097.28", "3.13%") +
    "</table></body></html>"
  );
}

function row(name: string, id: string, cusip: string, cls: string, shares: string, mv: string, wt: string): string {
  return (
    "<tr >" +
    `<td>${name}</td><td>${id}</td><td>${cusip}</td><td>${cls}</td>` +
    `<td align="right">${shares}</td><td align="right">${mv}</td><td align="right">${wt}</td>` +
    "</tr>"
  );
}

function rowBond(name: string, id: string, cusip: string, shares: string, mv: string, wt: string): string {
  return (
    "<tr >" +
    `<td>${name}</td><td>${id}</td><td>${cusip}</td>` +
    `<td align="right">${shares}</td><td align="right">${mv}</td><td align="right">${wt}</td>` +
    "</tr>"
  );
}

// ── per-fund summary page ────────────────────────────────────────────────────────

/** A summary page (FTCS-shaped): the CEFFieldLabel/CEFPagesBody key facts + the objective span. */
export function summaryHtml(): string {
  const kv = (label: string, value: string) =>
    `<tr><td class="CEFFieldLabel" valign="top">${label}</td>` +
    `<td class="CEFPagesBody" align="right" valign="top">${value}</td></tr>`;
  return (
    "<!doctype html><html><head><title>First Trust Capital Strength&reg; ETF (FTCS)</title></head><body>" +
    '<table><tr><td class="CEFPageHeader">Fund Overview</td></tr>' +
    kv("Investment Advisor", "First Trust Advisors L.P.") +
    kv("Investor Servicing Agent", "Bank of New York Mellon Corp") +
    kv("Total Expense Ratio*", "0.53%") +
    kv("Net Expense Ratio*", "0.53%") +
    kv("Total Net Assets", "$7,836,247,188") +
    kv("Outstanding Shares", "81,300,002") +
    kv("Daily Volume", "399,403") +
    kv("Number of Holdings (excluding cash)", "50") +
    "</table>" +
    '<div class="FundObjectiveContainer"><b>Investment Objective/Strategy -</b> ' +
    '<span id="FundObjective_FundControlContainer_lblInvestmentStrategy">The First Trust Capital Strength&reg; ETF seeks investment results that correspond generally to the price and yield of an equity index called The Capital Strength Index&trade;.</span>' +
    "</div></body></html>"
  );
}

// ── routers ──────────────────────────────────────────────────────────────────────

/**
 * A router covering the full flow: the ETF list page, each fund's holdings page, and each fund's
 * summary page. Unknown URLs throw (a 404), so the driver's skip-on-miss paths are exercised.
 */
export function fullRouter(
  holdingsByTicker: Record<string, string> = { FTCS: equityHoldingsHtml(), LGOV: bondHoldingsHtml() },
  summaryByTicker: Record<string, string> = { FTCS: summaryHtml() },
  sections = DEFAULT_SECTIONS,
): (url: string) => string {
  return (url: string): string => {
    if (url === ETFLIST_URL) return etflistHtml(sections);
    for (const [tk, html] of Object.entries(holdingsByTicker)) {
      if (url === holdingsUrl(tk)) return html;
    }
    for (const [tk, html] of Object.entries(summaryByTicker)) {
      if (url === summaryUrl(tk)) return html;
    }
    throw new Error(`404 for ${url}`);
  };
}
