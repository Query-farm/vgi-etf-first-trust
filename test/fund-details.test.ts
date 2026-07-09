// Archetype proof for firsttrust.fund_details: the summary-page label/value extraction
// (CEFFieldLabel → CEFPagesBody), the <title> → fund_name path, and the objective span
// (HTML-stripped, entity-decoded). SDK-free (no @query-farm import).

import { test, expect } from "bun:test";
import { parseFundDetails, fetchFundDetails, labelValue, summaryUrl } from "../src/firsttrust.js";
import { FakeFirsttrust, summaryHtml } from "./fake-firsttrust.js";

test("labelValue pulls a value cell by its label prefix (ignoring a trailing *)", () => {
  const html = summaryHtml();
  expect(labelValue(html, "Total Expense Ratio")).toContain("0.53%");
  expect(labelValue(html, "Total Net Assets")).toContain("$7,836,247,188");
  expect(labelValue(html, "Nonexistent Field")).toBeNull();
});

test("parseFundDetails extracts the key facts and the objective", () => {
  const row = parseFundDetails(summaryHtml(), "ftcs");
  expect(row.ticker).toBe("FTCS");
  expect(row.fundName).toBe("First Trust Capital Strength® ETF"); // <title> minus "(FTCS)"
  expect(row.investmentAdvisor).toBe("First Trust Advisors L.P.");
  expect(row.expenseRatioPercent).toBe(0.53);
  expect(row.netExpenseRatioPercent).toBe(0.53);
  expect(row.netAssets).toBe(7836247188);
  expect(row.sharesOutstanding).toBe(81300002);
  expect(row.dailyVolume).toBe(399403);
  expect(row.numHoldings).toBe(50);
  expect(row.objective).toContain("Capital Strength® ETF seeks investment results");
});

test("parseFundDetails degrades every field to null on an empty page (no throw)", () => {
  const row = parseFundDetails("<html><body></body></html>", "ZZZ");
  expect(row.ticker).toBe("ZZZ");
  expect(row.fundName).toBeNull();
  expect(row.netAssets).toBeNull();
  expect(row.numHoldings).toBeNull();
  expect(row.objective).toBeNull();
});

test("fetchFundDetails hits the fund's summary URL", async () => {
  const fake = new FakeFirsttrust((url) => {
    if (url === summaryUrl("FTCS")) return summaryHtml();
    throw new Error(`404 ${url}`);
  });
  const row = await fetchFundDetails(fake.get, "FTCS");
  expect(row.expenseRatioPercent).toBe(0.53);
  expect(fake.calls).toEqual([summaryUrl("FTCS")]);
});
