// Typed-column contract for the three schemas. This one pulls @query-farm/vgi (batchFromColumns) +
// apache-arrow, so it runs under the full SDK install — unlike the driver tests, which are
// deliberately SDK-free. Proves schema field names/order and that Utf8/Float64/Int64/Date cells
// (incl. nulls) round-trip into an Arrow batch.

import { test, expect } from "bun:test";
import {
  productsSchema,
  productsBatch,
  holdingsSchema,
  holdingsBatch,
  fundDetailsSchema,
  fundDetailsBatch,
} from "../src/schema.js";
import { parseProducts, parseHoldings, parseFundDetails } from "../src/firsttrust.js";
import { defaultEtflistHtml, equityHoldingsHtml, summaryHtml } from "./fake-firsttrust.js";

const names = (schema: { fields: { name: string }[] }) => schema.fields.map((f) => f.name);

test("products schema field names + order", () => {
  expect(names(productsSchema())).toEqual([
    "ticker", "fund_name", "category", "inception_date", "nav", "sec_yield_30day_percent",
    "unsubsidized_sec_yield_30day_percent", "distribution_rate_12m_percent", "yield_as_of_date",
    "summary_url",
  ]);
});

test("holdings schema field names + order", () => {
  expect(names(holdingsSchema())).toEqual([
    "fund_ticker", "as_of_date", "weight_percent", "ticker", "name", "cusip", "sector",
    "shares_held", "market_value",
  ]);
});

test("fund_details schema field names + order", () => {
  expect(names(fundDetailsSchema())).toEqual([
    "ticker", "fund_name", "investment_advisor", "net_assets", "shares_outstanding",
    "daily_volume", "num_holdings", "expense_ratio_percent", "net_expense_ratio_percent",
    "objective",
  ]);
});

test("batch builders produce one row per parsed record", () => {
  const products = parseProducts(defaultEtflistHtml());
  const holdings = parseHoldings(equityHoldingsHtml(), "FTCS");
  const details = parseFundDetails(summaryHtml(), "FTCS");
  expect((productsBatch(productsSchema(), products) as { numRows: number }).numRows).toBe(4);
  expect((holdingsBatch(holdingsSchema(), holdings) as { numRows: number }).numRows).toBe(3);
  expect((fundDetailsBatch(fundDetailsSchema(), [details]) as { numRows: number }).numRows).toBe(1);
});

test("empty inputs build a zero-row batch, not a throw", () => {
  expect((productsBatch(productsSchema(), []) as { numRows: number }).numRows).toBe(0);
  expect((holdingsBatch(holdingsSchema(), []) as { numRows: number }).numRows).toBe(0);
  expect((fundDetailsBatch(fundDetailsSchema(), []) as { numRows: number }).numRows).toBe(0);
});
