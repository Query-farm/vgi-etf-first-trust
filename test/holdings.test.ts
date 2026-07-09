// Archetype proof for firsttrust.holdings: the header-driven fundSilverGrid parser (equity vs
// fixed-income column sets), the "as of" date extraction, the weight-descending sort, and the
// fetchHoldings skip-on-error contract. SDK-free (no @query-farm import).

import { test, expect } from "bun:test";
import { parseHoldings, fetchHoldings, holdingsUrl } from "../src/firsttrust.js";
import { FakeFirsttrust, equityHoldingsHtml, bondHoldingsHtml } from "./fake-firsttrust.js";

test("holdingsUrl upper-cases the ticker into the query string", () => {
  expect(holdingsUrl("ftcs")).toBe(
    "https://www.ftportfolios.com/Retail/Etf/EtfHoldings.aspx?Ticker=FTCS",
  );
});

test("parseHoldings maps an equity page, sorts by weight desc, keeps the cash line", () => {
  const rows = parseHoldings(equityHoldingsHtml(), "FTCS");
  expect(rows.length).toBe(3);
  expect(rows.map((r) => r.weightPercent)).toEqual([2.59, 2.44, 0.08]); // weight-descending
  const top = rows[0]!;
  expect(top.fundTicker).toBe("FTCS");
  expect(top.ticker).toBe("CSCO");
  expect(top.name).toBe("Cisco Systems, Inc.");
  expect(top.cusip).toBe("17275R102");
  expect(top.sector).toBe("Telecommunications");
  expect(top.sharesHeld).toBe(1780110); // "1,780,110" → 1780110
  expect(top.marketValue).toBeCloseTo(202612120.2, 2);
  expect(top.asOfDate).toBe(Math.floor(Date.UTC(2026, 6, 8) / 1000));
  // The cash line keeps its "$USD" identifier and has no CUSIP.
  const cash = rows[2]!;
  expect(cash.ticker).toBe("$USD");
  expect(cash.cusip).toBeNull();
});

test("parseHoldings binds a fixed-income page with no Classification column", () => {
  const rows = parseHoldings(bondHoldingsHtml(), "LGOV");
  expect(rows.length).toBe(2);
  const top = rows[0]!;
  expect(top.weightPercent).toBe(3.3);
  expect(top.name).toBe("US Dollar");
  expect(top.sector).toBeNull(); // no Classification column on bond pages
  expect(top.marketValue).toBeCloseTo(20823207.55, 2);
  // A bond line with a blank identifier → null ticker, CUSIP present.
  const bond = rows[1]!;
  expect(bond.ticker).toBeNull();
  expect(bond.cusip).toBe("3136AAWE1");
});

test("parseHoldings returns [] when there is no holdings table", () => {
  expect(parseHoldings("<html><body>no table</body></html>", "X")).toEqual([]);
  expect(parseHoldings("", "X")).toEqual([]);
});

test("fetchHoldings fetches the fund's holdings page (one request)", async () => {
  const fake = new FakeFirsttrust((url) => {
    if (url === holdingsUrl("FTCS")) return equityHoldingsHtml();
    throw new Error(`404 ${url}`);
  });
  const rows = await fetchHoldings(fake.get, "ftcs");
  expect(rows.length).toBe(3);
  expect(fake.calls).toEqual([holdingsUrl("FTCS")]);
});

test("fetchHoldings returns [] (not a throw) when the holdings page errors", async () => {
  const fake = new FakeFirsttrust((url) => {
    throw new Error(`404 ${url}`);
  });
  expect(await fetchHoldings(fake.get, "NOPE")).toEqual([]);
});
