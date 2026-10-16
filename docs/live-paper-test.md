# Automatic test with real market data

[Open cloud runs and reports](https://github.com/urbanz95/reef-mist-pepper-cobalt/actions/workflows/live-paper.yml).

The **Live-market paper test** workflow runs for four hours daily at 00:17 UTC,
and can be started using **Run workflow**. The computer and browser can be off.
GitHub can delay scheduled starts. This is a bounded experiment, not a continuous
production keeper. Standard GitHub-hosted runners are free for this public repository.

Default virtual balances are 0.00045 ETH and 0.1 ETH. Every run starts fresh.
Observations target 15-second intervals; slow requests can extend them.
The report records monitoring gaps and the shared keeper policy blocks entries
without sufficiently frequent observations.

## Real observations, virtual positions

The runner reads Robinhood Chain block timestamps, pool prices, canonical factory
addresses, gas prices, and GeckoTerminal liquidity/24-hour volume. It simulates
a buy → LP entry → LP exit → sell using eth_call with a temporary balance
override. No state is committed. A transport allowlist rejects signing and
transaction broadcasting methods. No keeper key, wallet, database or secret is needed.

Only USDG/WETH pools are selected by default. Token selection replaces the
manual-review gate **for this experiment only**; it is not a security approval.
Production settings and the live-trading switch are unchanged.

The shared strategy policy makes entry, rotation and protective exit decisions.
LP valuation uses a full-range constant-product approximation, while fees use
discounted, capped historical-volume APR. They are **estimates, not earned money**.
Probe execution gas excludes contract creation, adds an allowance and margin,
and does not include any additional network data fee. Trading losses from the
round trip are reserved on entry, and each gas leg is charged once.

Missing/stale data never falls back to static pool data. Unknown position values
remain unknown. Observation gaps accrue no modeled fees. A successful probe
proves only sellability in that observed state, not future safety.

## Reading a run

While running, open **observe → Observe real markets without sending transactions**
to see samples and decisions. After completion, the run summary shows balances,
modeled fees, costs and reasons for waiting or exiting. Download the
live-paper artifact for report.md (readable summary), report.json (final counters
and virtual books), and samples.ndjson (timestamped observations and decisions).

Artifacts are retained for 14 days. Partial reports are uploaded on ordinary
failures/cancellation when GitHub can still execute the cleanup step.
A run with no verified quotes fails; individual provider failures remain in
the report. No trade is a valid result when expected earnings do not cover costs.
This test does not establish profitability or justify enabling real trading.

For development, npm run test:paper:live runs the same observer. Optional
variables: PAPER_DURATION_MINUTES (0.25–300), PAPER_CAPITALS (1–3 balances,
each >0 and ≤0.5 ETH), PAPER_TOKEN_ADDRESSES (1–4 paper-only addresses), and
PAPER_OUTPUT_DIR. Never supply a private key.

## In-app results

Open Degen → Cloud test results. Select a virtual balance to see estimated PnL,
modeled fees, charged costs, simulated operations, and recent decisions. No-entry
runs explicitly say that the exit logic was not exercised. Unknown valuations
are never displayed as zero.

The runner publishes a validated public snapshot at most once a minute to the
paper-reports branch. The app reads it without credentials. Publication and CDN
caching may delay visibility; snapshots show their timestamp and running reports
older than three minutes are marked delayed. Completed snapshots retain their
actual finish status. Each new run replaces the dashboard snapshot; historical
full reports remain in Actions artifacts.

The workflow needs contents: write solely to publish these public experiment
results using its temporary GitHub token. Production secrets are not used.
Publication runs asynchronously so a slow GitHub request does not stall market
observations. A final flush completes before artifact upload.
