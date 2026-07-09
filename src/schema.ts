// Arrow output schemas + row→batch mapping for the products / holdings / fund_details surfaces.
//
// First Trust data has a STABLE, known shape, so we emit real typed columns (not a single JSON
// string): Utf8 identifiers/names, Float64 prices/weights/yields, Int64 counts, and a real Arrow
// DATE (Date32) for every calendar date. `batchFromColumns` defaults to the "rich" representation,
// so a DATE cell is a JS `Date` (at UTC midnight) and an Int64 cell is a bigint. Percent-valued
// columns carry a `_percent` suffix and hold percent-magnitude numbers (e.g. 0.53 = 0.53%),
// matching First Trust's raw displayed values. Ratios that are not percents are unsuffixed.

import { Schema, Field, Utf8, Float64, Int64, DateDay } from "@query-farm/apache-arrow";
import { batchFromColumns } from "@query-farm/vgi";
import type { ProductRow, HoldingRow, FundDetailsRow } from "./firsttrust.js";

const f = (name: string, type: ConstructorParameters<typeof Field>[1]) => new Field(name, type, true);
const date = () => new DateDay();

/**
 * A hive-style partition-column field: carries `vgi.partition_column = "true"` so the DuckDB
 * binder treats it as a partition key. `holdings` is partitioned on `fund_ticker` — each scanned
 * fund is one SINGLE_VALUE partition (see makeHoldingsScan). Mirrors vgi's `partition_field`.
 */
const partitionField = (name: string, type: ConstructorParameters<typeof Field>[1]) =>
  new Field(name, type, true, new Map([["vgi.partition_column", "true"]]));

/** Map an Arrow field type to the DuckDB type name shown in docs. */
function duckdbType(type: unknown): string {
  const n = (type as { constructor?: { name?: string } })?.constructor?.name ?? "";
  if (n.startsWith("Utf8")) return "VARCHAR";
  if (n.startsWith("Float")) return "DOUBLE";
  if (n.startsWith("Int") || n.startsWith("Uint")) return "BIGINT";
  if (n.startsWith("Date")) return "DATE";
  return "VARCHAR";
}

/**
 * Build the `vgi.result_columns_schema` tag value (a JSON array of {name, type, description})
 * for a static result schema, DRY from the Arrow schema + a name→description map.
 */
export function resultColumnsSchema(schema: Schema, descriptions: Record<string, string>): string {
  return JSON.stringify(
    schema.fields.map((field) => ({
      name: field.name,
      type: duckdbType(field.type),
      description: descriptions[field.name] ?? field.name,
    })),
  );
}

/** bigint | null for an Int64 cell from a JS number that may be null. */
const bigOrNull = (v: number | null): bigint | null => (v == null ? null : BigInt(Math.trunc(v)));

/** JS Date | null for a DATE (Date32) cell from epoch SECONDS at UTC midnight. */
const dateOrNull = (sec: number | null): Date | null => (sec == null ? null : new Date(sec * 1000));

// ── products ──────────────────────────────────────────────────────────────────

export function productsSchema(): Schema {
  return new Schema([
    f("ticker", new Utf8()),
    f("fund_name", new Utf8()),
    f("category", new Utf8()),
    f("inception_date", date()),
    f("nav", new Float64()),
    f("sec_yield_30day_percent", new Float64()),
    f("unsubsidized_sec_yield_30day_percent", new Float64()),
    f("distribution_rate_12m_percent", new Float64()),
    f("yield_as_of_date", date()),
    f("summary_url", new Utf8()),
  ]);
}

export function productsBatch(schema: Schema, rows: ProductRow[]) {
  return batchFromColumns(
    {
      ticker: rows.map((r) => r.ticker),
      fund_name: rows.map((r) => r.fundName),
      category: rows.map((r) => r.category),
      inception_date: rows.map((r) => dateOrNull(r.inceptionDate)),
      nav: rows.map((r) => r.nav),
      sec_yield_30day_percent: rows.map((r) => r.secYield30dayPercent),
      unsubsidized_sec_yield_30day_percent: rows.map((r) => r.unsubsidizedSecYield30dayPercent),
      distribution_rate_12m_percent: rows.map((r) => r.distributionRate12mPercent),
      yield_as_of_date: rows.map((r) => dateOrNull(r.yieldAsOfDate)),
      summary_url: rows.map((r) => r.summaryUrl),
    },
    schema,
  );
}

// ── holdings ────────────────────────────────────────────────────────────────

export function holdingsSchema(): Schema {
  return new Schema([
    // fund_ticker is the hive partition key: holdings_scan emits one SINGLE_VALUE partition per fund.
    partitionField("fund_ticker", new Utf8()),
    f("as_of_date", date()),
    f("weight_percent", new Float64()),
    f("ticker", new Utf8()),
    f("name", new Utf8()),
    f("cusip", new Utf8()),
    f("sector", new Utf8()),
    f("shares_held", new Float64()),
    f("market_value", new Float64()),
  ]);
}

export function holdingsBatch(schema: Schema, rows: HoldingRow[]) {
  return batchFromColumns(
    {
      fund_ticker: rows.map((r) => r.fundTicker),
      as_of_date: rows.map((r) => dateOrNull(r.asOfDate)),
      weight_percent: rows.map((r) => r.weightPercent),
      ticker: rows.map((r) => r.ticker),
      name: rows.map((r) => r.name),
      cusip: rows.map((r) => r.cusip),
      sector: rows.map((r) => r.sector),
      shares_held: rows.map((r) => r.sharesHeld),
      market_value: rows.map((r) => r.marketValue),
    },
    schema,
  );
}

// ── fund_details ──────────────────────────────────────────────────────────────

export function fundDetailsSchema(): Schema {
  return new Schema([
    f("ticker", new Utf8()),
    f("fund_name", new Utf8()),
    f("investment_advisor", new Utf8()),
    f("net_assets", new Float64()),
    f("shares_outstanding", new Float64()),
    f("daily_volume", new Float64()),
    f("num_holdings", new Int64()),
    f("expense_ratio_percent", new Float64()),
    f("net_expense_ratio_percent", new Float64()),
    f("objective", new Utf8()),
  ]);
}

export function fundDetailsBatch(schema: Schema, rows: FundDetailsRow[]) {
  return batchFromColumns(
    {
      ticker: rows.map((r) => r.ticker),
      fund_name: rows.map((r) => r.fundName),
      investment_advisor: rows.map((r) => r.investmentAdvisor),
      net_assets: rows.map((r) => r.netAssets),
      shares_outstanding: rows.map((r) => r.sharesOutstanding),
      daily_volume: rows.map((r) => r.dailyVolume),
      num_holdings: rows.map((r) => bigOrNull(r.numHoldings)),
      expense_ratio_percent: rows.map((r) => r.expenseRatioPercent),
      net_expense_ratio_percent: rows.map((r) => r.netExpenseRatioPercent),
      objective: rows.map((r) => r.objective),
    },
    schema,
  );
}
