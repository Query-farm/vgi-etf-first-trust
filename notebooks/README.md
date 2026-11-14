# First Trust notebooks

[01 · How much reported portfolio weight sits in the largest holdings?](01_current_holdings_concentration.ipynb) compares current FTCS and AIRR holdings, checks dates and missing weights, and separates top-ranked lines from the reported remainder. The experiment changes the cutoff from 5 to 10 lines. The funds have different mandates; this is a holdings description, not an investment recommendation or a risk/return comparison.

## Run

Requirements: [uv](https://docs.astral.sh/uv/), Python 3.13+ (uv can install it), and internet access to GitHub/package sources and First Trust. No API key, Bun installation or surrounding worker checkout is needed.

```sh
cd notebooks
uv sync --locked
uv run --locked python execute.py --timeout 300
```

The notebook locks Haybarn 2.0.0rc11 and plotting/Jupyter dependencies. The visible literal location is `github-auto://Query-farm/vgi-etf-first-trust@v0.4.0`; the release tag resolves to `9a6685db836e7636b810bd03d9dfa0a739a4f51f`. VGI downloads the platform-native release binary and checks its published SHA-256 before caching it. Change the pinned release deliberately and rerun defaults and the experiment when upgrading.

Optional editor kernel:

```sh
uv run --locked python -m ipykernel install --user --name vgi-etf-first-trust-notebooks --display-name "Python (vgi-etf-first-trust notebooks)"
```

Use this directory as the working directory, then Restart Kernel → Run All. The runner registers a temporary kernel automatically and replaces the saved notebook only after successful execution.

## Separate experiment

```sh
uv run --locked python execute.py --timeout 300 --parameters '{"TOP_N":10}' --output-dir artifacts/top-10
```

Overrides require a separate destination. Branding, documentation, runner and locked environment files accompany each experiment. Restore 5 for the default. Logs, extracted charts, experiments and virtual environments are ignored.

## Source and interpretation

The public [FTCS holdings page](https://www.ftportfolios.com/retail/etf/EtfHoldings.aspx?Ticker=FTCS) and [AIRR holdings page](https://www.ftportfolios.com/retail/etf/EtfHoldings.aspx?Ticker=AIRR) are fetched through the unchanged released worker. The bounded remote scan selects only these two fund partitions. Release v0.4.0 has a known limitation with nonpartition holdings filters; all such analytics operate on the materialized local table. No synthetic or replay fallback is used.

Holdings are current-only. The published `as_of_date` is a calendar DATE without timezone, distinct from the UTC acquisition bounds displayed in the notebook. Two fund responses are not an atomic snapshot. The worker caches its catalog for 24 hours; this notebook supplies a fresh temporary cache directory, while holdings pages are always requested live. Compare page dates, weighted-observation fingerprints and missing-weight counts before attributing a repeated run's change to the cutoff alone.

Weights already express percent points: 2.5 means 2.5%. The notebook preserves reported totals and their differences from 100; it does not renormalize. Missing weights are excluded from ranking and counted separately. Negative weights or insufficient weighted lines stop this cumulative example. Names/tickers/CUSIPs are labels rather than assumed unique row keys, and duplicated holding lines are retained. Empty output cannot distinguish an empty page from a retrieval/parser failure, so required-source checks stop rather than present zero concentration.
