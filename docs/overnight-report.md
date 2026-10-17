# Overnight paper test and complete position report

Degen → Cloud test results shows the position ledger and a CSV download. The
Live-market paper test workflow defaults to **eight hours**: two four-hour jobs
using the same virtual balances (0.1 and 0.5 ETH). These are independent test
books, not actual deposits. The computer can be off.

The first job uploads its complete checkpoint. The second downloads that exact
artifact from the same workflow run and restores balances, positions, confirmation
state, trade limits, cumulative fees/costs and the ledger. Missing or mismatched
checkpoints fail instead of silently starting over. There is a short runner-start
gap between segments: no fees accrue across it and entry confirmation cannot be
manufactured by the gap. Risk rules still inspect fresh prices when sampling
resumes. This remains a paper test, not continuous protection of real funds.

Discovery reads three GeckoTerminal pages of Uniswap V3 WETH pools on Robinhood
Chain. Screening requires at least $100,000 reported TVL and seven days of pool
age. Up to six pools are probed per sample, with at most two fee tiers per token.
Held pools are also queried even when they disappear from the discovery list.
Canonical factory identity and an actual read-only buy/LP/withdraw/sell probe are
required. Selecting a token for this experiment is NOT a security review.
Provider errors and stale data are recorded, never replaced with catalog prices.

After a profitable simulated close, another entry is allowed following the
30-minute cooldown and rolling four-entry daily limit. Loss/liquidity stops stay
latched. This lets the overnight experiment collect more than one winning cycle
without removing protective stops. The carry48 fee projection remains a 48-hour
hypothesis; an eight-hour test does not validate that full holding horizon.

The run page provides artifacts `live-paper-<run id>-part-1` and `...-part-2`.
**Part 2 contains the cumulative report for the whole night**:

- report.html: standalone readable tables (open in a browser).
- report.md: equivalent report in Markdown, also shown in the job summary.
- report.json: complete virtual books, counters and continuation state.
- trades.csv: pool/name/address, entry and exit UTC, holding duration, value,
  modeled fees, charged costs, per-position PnL and exit reason.
- pools.csv: pools screened, successful/failed probes and latest screening result.
- equity.csv: balance and total PnL observations by capital and timestamp.
- samples.ndjson: raw provider observations, block references, quotes, errors
  and decisions throughout both segments.

Closed-position PnL equals exit cash minus cash allocated before that position's
entry cost. Open-position PnL is a marked estimate and remains unknown if pricing
or sellability cannot be verified. Sum of closed and open PnL reconciles to the
book's total change from starting capital. Hop accounting charges old exit costs
to the old position and new entry costs to the new position.

Times in downloads are UTC; the app displays the viewer's local time. All earnings
and position values are modeled, not transaction receipts. Positions still open
at the end are explicitly OPEN; the test never invents a final sale. Artifacts
last 14 days; the public dashboard refreshes once per minute with possible CDN lag.

For a quick end-to-end continuation check, dispatch with duration_minutes=1 and
overnight=true. For a single short test choose overnight=false. The scheduled
nightly run also uses the two-segment configuration.
