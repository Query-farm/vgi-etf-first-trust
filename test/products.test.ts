// Archetype proof for firsttrust.products: the ETF-list-page driver. Imports ONLY our own src +
// the fake — NO @query-farm/* — so it runs without the SDK installed. Proves the section-caption →
// category mapping, the fixed-position cell extraction (incl. the blank spacer + "-------"
// sentinels), date parsing, ticker narrowing, and the ETF-list URL contract.

import { test, expect } from "bun:test";
import {
  parseProducts,
  fetchProducts,
  resolveFund,
  parseDate,
  ETFLIST_URL,
  summaryUrl,
} from "../src/firsttrust.js";
import { FakeFirsttrust, defaultEtflistHtml } from "./fake-firsttrust.js";

const HTML = defaultEtflistHtml;

test("parseDate handles MM/DD/YY (2-digit → 2000+) and M/D/YYYY", () => {
  expect(parseDate("07/08/2026")).toBe(Math.floor(Date.UTC(2026, 6, 8) / 1000));
  expect(parseDate("7/8/2026")).toBe(Math.floor(Date.UTC(2026, 6, 8) / 1000));
  expect(parseDate("03/10/14")).toBe(Math.floor(Date.UTC(2014, 2, 10) / 1000));
  expect(parseDate("-------")).toBeNull();
  expect(parseDate("")).toBeNull();
  expect(parseDate("garbage")).toBeNull();
});

test("parseProducts maps every fund row with its section category", () => {
  const rows = parseProducts(HTML());
  expect(rows.length).toBe(4);
  const ftcs = rows.find((r) => r.ticker === "FTCS")!;
  expect(ftcs.fundName).toBe("First Trust Capital Strength® ETF"); // entity-decoded
  expect(ftcs.category).toBe("Size/Style Funds");
  expect(ftcs.nav).toBe(96.42);
  expect(ftcs.secYield30dayPercent).toBe(1.23);
  expect(ftcs.distributionRate12mPercent).toBe(1.05);
  expect(ftcs.inceptionDate).toBe(Math.floor(Date.UTC(2006, 6, 6) / 1000));
  expect(ftcs.yieldAsOfDate).toBe(Math.floor(Date.UTC(2026, 5, 30) / 1000));
  expect(ftcs.summaryUrl).toBe(summaryUrl("FTCS"));

  const fthi = rows.find((r) => r.ticker === "FTHI")!;
  expect(fthi.category).toBe("Income Funds");
  expect(fthi.distributionRate12mPercent).toBe(8.77);
});

test("parseProducts degrades the '-------' and blank sentinels to null", () => {
  const airr = parseProducts(HTML()).find((r) => r.ticker === "AIRR")!;
  expect(airr.secYield30dayPercent).toBeNull();
  expect(airr.unsubsidizedSecYield30dayPercent).toBeNull();
  expect(airr.distributionRate12mPercent).toBeNull();
  expect(airr.yieldAsOfDate).toBeNull();
  expect(airr.nav).toBe(122.52);
});

test("parseProducts returns [] on a page with no fund rows", () => {
  expect(parseProducts("<html><body>nothing here</body></html>")).toEqual([]);
});

test("parseProducts narrows to a single ticker (case-insensitive)", () => {
  const one = parseProducts(HTML(), "ftcs");
  expect(one.length).toBe(1);
  expect(one[0]!.ticker).toBe("FTCS");
  expect(parseProducts(HTML(), "ZZZZ")).toEqual([]);
});

test("fetchProducts hits the ETF-list URL once", async () => {
  const fake = new FakeFirsttrust(HTML);
  const rows = await fetchProducts(fake.get);
  expect(rows.length).toBe(4);
  expect(fake.calls).toEqual([ETFLIST_URL]);
});

test("resolveFund canonicalizes a ticker and returns null on a miss", async () => {
  const fake = new FakeFirsttrust(HTML);
  expect(await resolveFund(fake.get, "ftcs")).toBe("FTCS");
  expect(await resolveFund(fake.get, "ZZZZ")).toBeNull();
  expect(await resolveFund(fake.get, "")).toBeNull();
});
