// vgi-etf-first-trust stdio worker entry. DuckDB spawns this and ATTACHes it:
//   LOAD vgi;
//   ATTACH 'firsttrust' AS firsttrust (TYPE vgi, LOCATION '/path/to/vgi-etf-first-trust/bin/vgi-etf-first-trust-worker');
//   SELECT * FROM firsttrust.products WHERE category = 'Income Funds';
//   SELECT * FROM firsttrust.holdings WHERE fund_ticker = 'FTCS' ORDER BY weight_percent DESC LIMIT 10;
//   SELECT * FROM firsttrust.fund_details('FTCS');
//
// Keyless: no CREATE SECRET is needed. `products` and `holdings` are base TABLES (backed by scan
// functions); `fund_details` is the one callable table function. All take the injected HTTP
// client (client.ts).

import { Worker, ReadOnlyCatalogInterface, FunctionRegistry } from "@query-farm/vgi";
import { makeFirsttrustClient } from "./client.js";
import { makeProductsScan, makeHoldingsScan, makeFundDetailsFunction } from "./functions.js";
import { makeCatalog } from "./catalog.js";

const client = makeFirsttrustClient();

// The one callable table function (fund_details); products and holdings are base tables.
const fundDetails = makeFundDetailsFunction(client);
const functions = [fundDetails];

// Backing scans for the base tables: registered so scan RPCs resolve. products' scan stays
// unlisted (exposed only as the `products` table); holdings' scan is LISTED (in makeCatalog) so
// the extension can push the fund_ticker filter into the `holdings` table.
const productsScan = makeProductsScan(client);
const holdingsScan = makeHoldingsScan(client);

const registry = new FunctionRegistry();
registry.register(productsScan);
registry.register(holdingsScan);
registry.register(fundDetails);

const catalogInterface = new ReadOnlyCatalogInterface(
  makeCatalog(functions, productsScan, holdingsScan),
  registry,
);

// `functions` for the Worker is the full set the registry serves (the table scans + fund_details).
new Worker({ functions: [productsScan, holdingsScan, fundDetails], catalogInterface }).run();
