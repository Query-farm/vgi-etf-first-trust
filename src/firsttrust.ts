// The First Trust (First Trust Portfolios / ftportfolios.com) driver — pure logic, no @query-farm
// SDK import. Every fetch* takes an injected `get(url) => Promise<string>` (HTML text), so the
// archetype-proof tests drive it against an in-process fake and the worker wires the real HTTP
// client (client.ts). This module MUST NOT import from @query-farm/* — the unit tests import it
// without the SDK.
//
// Three KEYLESS, server-rendered (ASP.NET) HTML planes back the read paths, all plain text over a
// browser UA:
//
//   /retail/etf/etflist.aspx                → products (the ETF catalog: one HTML table per
//                                             fund-type section, ~316 funds)
//   /Retail/Etf/EtfHoldings.aspx?Ticker=T   → holdings (a per-fund holdings HTML table)
//   /Retail/Etf/EtfSummary.aspx?Ticker=T    → fund_details (a per-fund key-facts page)
//
// First Trust publishes CURRENT holdings only (one holdings page per fund), so there is NO
// as-of / time-travel coordinate; `as_of_date` reflects the page's own "Holdings of the Fund as
// of M/D/YYYY" date.
//
// Every parser is defensive: a missing table / cell / row degrades to an empty result or a null
// cell rather than throwing. `resolveFund` returns null (not a throw) on an unknown ticker so the
// caller (functions.ts) can raise a typed SDK error while this module stays SDK-free.
//
// DATES: the driver returns dates as epoch SECONDS at UTC midnight (number | null). The Arrow
// mapping to a real DATE column lives in schema.ts (keeping this module type/SDK-free).

export const FT_HOST = "https://www.ftportfolios.com";

/** The ETF list page: the server-rendered catalog of every First Trust US ETF. */
export const ETFLIST_URL = `${FT_HOST}/retail/etf/etflist.aspx`;

/** The per-fund holdings page (constituents table + the "as of" date). */
export function holdingsUrl(ticker: string): string {
  return `${FT_HOST}/Retail/Etf/EtfHoldings.aspx?Ticker=${encodeURIComponent(ticker.trim().toUpperCase())}`;
}

/** The per-fund summary page (key facts: expense ratio, net assets, advisor, objective, …). */
export function summaryUrl(ticker: string): string {
  return `${FT_HOST}/Retail/Etf/EtfSummary.aspx?Ticker=${encodeURIComponent(ticker.trim().toUpperCase())}`;
}

// ── shared value coercion ───────────────────────────────────────────────────────

/** True for "no data": null/undefined, "", all-whitespace, or the "-------" sentinel. */
function isBlank(v: unknown): boolean {
  if (v == null) return true;
  const s = String(v).trim();
  return s === "" || /^-+$/.test(s);
}

/** Decode the HTML entities First Trust emits (&amp; &reg; &trade; &nbsp; numeric refs, …). */
export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&reg;/g, "®")
    .replace(/&trade;/g, "™")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** Strip HTML tags, decode entities, and collapse whitespace to single spaces. */
export function cleanText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

const asStr = (v: unknown): string | null => {
  if (isBlank(v)) return null;
  const s = cleanText(String(v));
  return s === "" ? null : s;
};

/** A numeric value, stripping $, %, commas and surrounding quotes/space. Null if not finite. */
const asNum = (v: unknown): number | null => {
  if (isBlank(v)) return null;
  const n = typeof v === "number" ? v : Number(cleanText(String(v)).replace(/[$,%"\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

// ── date parsing ────────────────────────────────────────────────────────────────

/** Build epoch SECONDS at UTC midnight from y/m/d, validating the parts round-trip. Null if bad. */
function ymdToEpoch(y: number, mo0: number, d: number): number | null {
  const ms = Date.UTC(y, mo0, d);
  if (Number.isNaN(ms)) return null;
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo0 || dt.getUTCDate() !== d) return null;
  return Math.floor(ms / 1000);
}

/**
 * Parse the US-slash date shapes First Trust uses → epoch SECONDS at UTC midnight (or null):
 *   M/D/YYYY or MM/DD/YYYY  "7/8/2026"  (holdings "as of" line)
 *   MM/DD/YY                "03/10/14"  (inception / yield-as-of on the list page; 2-digit → 2000+YY)
 */
export function parseDate(v: unknown): number | null {
  if (isBlank(v)) return null;
  const s = cleanText(String(v));
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (!m) return null;
  const mo = Number(m[1]);
  const d = Number(m[2]);
  let y = Number(m[3]);
  if (m[3]!.length === 2) y += 2000; // First Trust ETFs are all post-2000
  return ymdToEpoch(y, mo - 1, d);
}

/** Format epoch SECONDS (or a Date) as a YYYYMMDD string at UTC (used only in tests). */
export function epochToYmd(sec: number | Date): string {
  const d = sec instanceof Date ? sec : new Date(sec * 1000);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${mo}${day}`;
}

// ── tiny HTML table helpers ──────────────────────────────────────────────────────

/** The raw inner HTML of every `<td>` in a `<tr>…</tr>` fragment, in order. */
function rowCells(trHtml: string): string[] {
  const cells: string[] = [];
  const re = /<td[^>]*>([\s\S]*?)<\/td>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trHtml)) !== null) cells.push(m[1]!);
  return cells;
}

// ── products (the ETF list page) ─────────────────────────────────────────────────

export interface ProductRow {
  ticker: string | null;
  fundName: string | null;
  /** Fund-type section the fund is listed under (Income, Sector & Industry, Target Outcome, …). */
  category: string | null;
  inceptionDate: number | null;
  nav: number | null;
  secYield30dayPercent: number | null;
  unsubsidizedSecYield30dayPercent: number | null;
  distributionRate12mPercent: number | null;
  yieldAsOfDate: number | null;
  summaryUrl: string | null;
}

/**
 * Parse the ETF list page into product rows. The page renders one HTML table per fund-type
 * section, each preceded by a `lblETFSectionTitle` caption (the row's `category`). Each data row
 * links its name to `EtfSummary.aspx?Ticker=…`; the 10 value cells are fixed-position (a blank
 * spacer sits at index 6). `ticker`, when non-empty, narrows to that one fund (case-insensitive).
 */
export function parseProducts(html: string, ticker = ""): ProductRow[] {
  const want = ticker.trim().toUpperCase();

  // Section captions (position → category), so each fund row can be tagged with its section.
  const sections: { pos: number; category: string }[] = [];
  const secRe = /lblETFSectionTitle[^>]*>([\s\S]*?)<\/span>/g;
  let sm: RegExpExecArray | null;
  while ((sm = secRe.exec(html)) !== null) {
    sections.push({ pos: sm.index, category: cleanText(sm[1]!) });
  }
  const categoryFor = (pos: number): string | null => {
    let cat: string | null = null;
    for (const s of sections) {
      if (s.pos < pos) cat = s.category;
      else break;
    }
    return cat;
  };

  const rows: ProductRow[] = [];
  const seen = new Set<string>();
  const rowRe = /EtfSummary\.aspx\?Ticker=([A-Za-z0-9.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const tk = m[1]!.toUpperCase();
    if (seen.has(tk)) continue; // the name anchor is the first EtfSummary link of the row
    const trStart = html.lastIndexOf("<tr", m.index);
    const trEnd = html.indexOf("</tr>", m.index);
    if (trStart < 0 || trEnd < 0) continue;
    const cells = rowCells(html.slice(trStart, trEnd));
    if (cells.length < 9) continue; // not a data row (header / nav / spacer table)
    seen.add(tk);
    if (want && tk !== want) continue;
    const cell = (i: number): string | undefined => cells[i];
    rows.push({
      ticker: asStr(cell(1)) ?? tk,
      fundName: asStr(cell(0)),
      category: categoryFor(m.index),
      inceptionDate: parseDate(cell(2)),
      nav: asNum(cell(3)),
      secYield30dayPercent: asNum(cell(4)),
      unsubsidizedSecYield30dayPercent: asNum(cell(5)),
      distributionRate12mPercent: asNum(cell(7)),
      yieldAsOfDate: parseDate(cell(8)),
      summaryUrl: summaryUrl(tk),
    });
  }
  return rows;
}

export async function fetchProducts(
  get: (url: string) => Promise<unknown>,
  ticker = "",
): Promise<ProductRow[]> {
  return parseProducts(String(await get(ETFLIST_URL)), ticker);
}

// ── ticker resolution (validate + canonicalize against the catalog) ─────────────

/**
 * Resolve a `fund` argument to a fund's canonical ticker by matching the catalog
 * (case-insensitive). Returns null when the ticker isn't in the First Trust lineup (the caller
 * raises a typed ArgumentValidationError — this module stays SDK-free). One list-page fetch.
 */
export async function resolveFund(
  get: (url: string) => Promise<unknown>,
  fund: string,
): Promise<string | null> {
  const wanted = fund.trim().toUpperCase();
  if (!wanted) return null;
  const products = parseProducts(String(await get(ETFLIST_URL)));
  const hit = products.find((p) => (p.ticker ?? "").toUpperCase() === wanted);
  return hit ? hit.ticker : null;
}

// ── holdings (the per-fund holdings page) ────────────────────────────────────────

export interface HoldingRow {
  /** The fund's ticker — the partition key (constant per fund; distinct from the constituent `ticker`). */
  fundTicker: string | null;
  asOfDate: number | null;
  weightPercent: number | null;
  /** Constituent ticker / identifier (blank for some fixed-income lines). */
  ticker: string | null;
  name: string | null;
  cusip: string | null;
  /** Sector / classification (present for equity funds; absent for many fixed-income funds). */
  sector: string | null;
  sharesHeld: number | null;
  marketValue: number | null;
}

/** Map a lowercased header label → column index, from the fundSilverGrid header row. */
function holdingColumns(headerRow: string): Map<string, number> {
  const cells = rowCells(headerRow);
  const map = new Map<string, number>();
  for (let c = 0; c < cells.length; c++) {
    const name = cleanText(cells[c]!).toLowerCase();
    if (name) map.set(name, c);
  }
  return map;
}

/** Find the index of the first header column whose label starts with any of `prefixes`. */
function colByPrefix(cols: Map<string, number>, ...prefixes: string[]): number | undefined {
  for (const [label, idx] of cols) {
    if (prefixes.some((p) => label.startsWith(p))) return idx;
  }
  return undefined;
}

/**
 * Parse a First Trust holdings page into holding rows, sorted by weight desc (NULLS last). The
 * constituent table has class `fundSilverGrid`; its header row (`fundSilverGridHeader`) labels the
 * columns, so parsing is header-driven — equity funds carry a Classification column, fixed-income
 * funds do not, and either binds. The as-of date comes from the "Holdings of the Fund as of
 * M/D/YYYY" heading.
 */
export function parseHoldings(html: string, fundTicker: string | null): HoldingRow[] {
  const hdrIdx = html.indexOf("fundSilverGridHeader");
  if (hdrIdx < 0) return [];
  const tableStart = html.lastIndexOf("<table", hdrIdx);
  const tableEnd = html.indexOf("</table>", hdrIdx);
  if (tableStart < 0 || tableEnd < 0) return [];
  const table = html.slice(tableStart, tableEnd);

  const trs: string[] = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let tm: RegExpExecArray | null;
  while ((tm = trRe.exec(table)) !== null) trs.push(tm[1]!);
  if (trs.length === 0) return [];

  const cols = holdingColumns(trs[0]!);
  const nameCol = colByPrefix(cols, "security name", "name");
  const idCol = colByPrefix(cols, "identifier", "ticker");
  const cusipCol = colByPrefix(cols, "cusip");
  const sectorCol = colByPrefix(cols, "classification", "sector");
  const sharesCol = colByPrefix(cols, "shares", "quantity");
  const valueCol = colByPrefix(cols, "market value");
  const weightCol = colByPrefix(cols, "weight");

  // As-of date from the "Holdings of the Fund as of M/D/YYYY" heading (fall back to any "as of").
  let asOf: number | null = null;
  const asOfM = /as of\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i.exec(html);
  if (asOfM) asOf = parseDate(asOfM[1]);

  const at = (cells: string[], col: number | undefined): string | undefined =>
    col == null ? undefined : cells[col];

  const rows: HoldingRow[] = [];
  for (let i = 1; i < trs.length; i++) {
    const cells = rowCells(trs[i]!);
    const weight = asNum(at(cells, weightCol));
    const name = asStr(at(cells, nameCol));
    if (weight == null && name == null) continue; // skip any stray non-data row
    rows.push({
      fundTicker,
      asOfDate: asOf,
      weightPercent: weight,
      ticker: asStr(at(cells, idCol)),
      name,
      cusip: asStr(at(cells, cusipCol)),
      sector: asStr(at(cells, sectorCol)),
      sharesHeld: asNum(at(cells, sharesCol)),
      marketValue: asNum(at(cells, valueCol)),
    });
  }
  rows.sort((a, b) => (b.weightPercent ?? -Infinity) - (a.weightPercent ?? -Infinity));
  return rows;
}

/**
 * Current holdings for one fund (First Trust publishes current holdings only, so there is no
 * as-of/time-travel coordinate). Returns [] for a fund whose holdings page errors or is empty, so
 * an all-funds scan never fails on a single missing fund.
 */
export async function fetchHoldings(
  get: (url: string) => Promise<unknown>,
  fundTicker: string,
): Promise<HoldingRow[]> {
  const up = fundTicker.trim().toUpperCase();
  let html: string;
  try {
    html = String(await get(holdingsUrl(up)));
  } catch {
    return [];
  }
  return parseHoldings(html, up);
}

// ── fund_details (the per-fund summary page) ─────────────────────────────────────

export interface FundDetailsRow {
  ticker: string | null;
  fundName: string | null;
  investmentAdvisor: string | null;
  netAssets: number | null;
  sharesOutstanding: number | null;
  dailyVolume: number | null;
  numHoldings: number | null;
  expenseRatioPercent: number | null;
  netExpenseRatioPercent: number | null;
  objective: string | null;
}

/**
 * The value of a `CEFFieldLabel`/`CEFPagesBody` key-facts pair on the summary page. The label is
 * matched as a prefix (so trailing "*" / "(excluding cash)" don't matter); returns the raw inner
 * HTML of the value cell, or null.
 */
export function labelValue(html: string, label: string): string | null {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `CEFFieldLabel[^>]*>\\s*${esc}[^<]*</td>\\s*<td[^>]*class="CEFPagesBody"[^>]*>([\\s\\S]*?)</td>`,
    "i",
  );
  const m = re.exec(html);
  return m ? m[1]! : null;
}

/**
 * Parse a First Trust summary page into a one-row fund-details snapshot. The key facts live in a
 * `CEFFieldLabel` → `CEFPagesBody` two-cell table; the objective prose is in the
 * `lblInvestmentStrategy` span. Every field degrades to null when absent.
 */
export function parseFundDetails(html: string, ticker: string): FundDetailsRow {
  // Fund name from the page <title> ("First Trust … ETF (TICKER)"), minus the trailing "(TICKER)".
  let fundName: string | null = null;
  const titleM = /<title>([\s\S]*?)<\/title>/i.exec(html);
  if (titleM) fundName = cleanText(titleM[1]!).replace(/\s*\([A-Za-z0-9.]+\)\s*$/, "") || null;

  const objM = /lblInvestmentStrategy[^>]*>([\s\S]*?)<\/span>/i.exec(html);

  return {
    ticker: ticker.trim().toUpperCase(),
    fundName,
    investmentAdvisor: asStr(labelValue(html, "Investment Advisor")),
    netAssets: asNum(labelValue(html, "Total Net Assets")),
    sharesOutstanding: asNum(labelValue(html, "Outstanding Shares")),
    dailyVolume: asNum(labelValue(html, "Daily Volume")),
    numHoldings: asNum(labelValue(html, "Number of Holdings")),
    expenseRatioPercent: asNum(labelValue(html, "Total Expense Ratio")),
    netExpenseRatioPercent: asNum(labelValue(html, "Net Expense Ratio")),
    objective: objM ? asStr(objM[1]) : null,
  };
}

export async function fetchFundDetails(
  get: (url: string) => Promise<unknown>,
  ticker: string,
): Promise<FundDetailsRow> {
  return parseFundDetails(String(await get(summaryUrl(ticker))), ticker);
}
