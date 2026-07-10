// vgi-etf-first-trust stdio worker entry. DuckDB spawns this and ATTACHes it:
//   LOAD vgi;
//   ATTACH 'firsttrust' AS firsttrust (TYPE vgi, LOCATION '/path/to/vgi-etf-first-trust/bin/vgi-etf-first-trust-worker');
//   SELECT * FROM firsttrust.products WHERE category = 'Income Funds';
//   SELECT * FROM firsttrust.holdings WHERE fund_ticker = 'FTCS' ORDER BY weight_percent DESC LIMIT 10;
//   SELECT * FROM firsttrust.fund_details('FTCS');
//
// What this worker serves is defined once in src/parts.ts and shared with the
// HTTP entrypoint (scripts/serve.ts).

import { Worker } from "@query-farm/vgi";
import { makeWorkerParts } from "./parts.js";

const { servedFunctions, catalogInterface } = makeWorkerParts();

// `functions` for the Worker is the full set the registry serves (incl. the table scans).
new Worker({ functions: servedFunctions, catalogInterface }).run();
