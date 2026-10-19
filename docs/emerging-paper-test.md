# Emerging-token experiment

## Scope and execution

`launch` is a virtual spot-buy/sell strategy, not liquidity provision or a promise of
profit. The age gate is removed from all paper experiments. The real keeper still
requires its normal admission/review policy; this change does not activate real
trading or deploy contracts. Workflow defaults now select `launch`.

Discovery alternates new-pool pages 1/2 with trending pools, using the shared
65-second request minimum, retry-after and backoff. At normal runner polling,
page 1 refreshes about every three minutes; discovery is neither exhaustive nor
instantaneous. Pools are prioritized by recency, with six probe slots retained for
five minutes to permit meaningful observation. No ticker/name whitelist is used.
Held pools continue exit monitoring after disappearing from discovery.

Canonical Uniswap V2 pairs, V3 pools and V4 pool keys are checked on chain. V4
accepts native ETH as well as actual WETH; tickers alone never identify funding
currency. V4 keys come from the official PositionManager or recent Initialize logs
and must hash to the supplied pool ID. Other DEXs/quote tokens remain observation-only.

The constructor probe executes a buy then a sell in one eth_call with a disposable
funded wallet and a state override. It never broadcasts or signs. Each measurement
captures received tokens, recovered ETH, entry gas and exit gas. More than 3%
round-trip loss, zero tokens, a reverted sale or mismatched identity rejects the
observation. All temporary state is discarded. This only proves executability at
that state, not future sellability or contract safety.

## Entry and exit rules

- No minimum pool age. Liquidity must still reach $100k.
- At least two minutes of actual sampled history, with three observations.
- Observed price rise must exceed max(0.5%, twice measured execution cost/capital),
  and the current price cannot be 1% below the observed recent high.
- Confirm the opportunity for another two minutes. No entry during a monitoring
  gap, stale metadata, failed probe, exhausted daily limit or cooldown.
- Exit on a 3% loss from entry account value, a 2% trailing loss, or a 30% drop in
  measured executable-depth proxy. These protective stops latch the book.
- Exit at net profit >= max(1% entry capital, twice execution cost), or after a
  maximum 30 minutes of exposure. Time exits may lose money. Profit/time exits
  permit another entry after the 30-minute cooldown, max four entries/day.
- Fresh sellability/valuation is mandatory for any close. Missing data leaves the
  position open with unknown PnL, rather than inventing proceeds.

Spot value uses principal times the observed price ratio, with an additional conservative discount if current round-trip recovery deteriorates relative to entry. Improved recovery does not create a valuation bonus. No LP fees accrue.
Measured round-trip trading loss is reserved on entry; entry/exit gas is charged
once per leg, with 51k gas allowance plus 50% margin. This approximation does not
measure an actual portfolio liquidation and can under/overestimate changing price
impact or token taxes. Additional network data fees are excluded. PnL includes
open positions; end of observation does not fabricate a sale.

V2/V3 use funding reserves for the depth proxy. V4 uses active virtual liquidity,
not total reserves in the shared PoolManager. Tick crossings can change this proxy
without liquidity withdrawal; the protective rule is deliberately conservative.

## Creation evidence versus migration

The observer records canonical PairCreated / PoolCreated / Initialize evidence
where available in the last 5,000 blocks, including the transaction hash. Pool
creation is not launchpad graduation. Migration remains `unconfirmed` until the
origin launchpad emitter and event can be verified. The UI and exports preserve
that distinction. A missing log in the bounded search is not a proof of no creation.

The origin launchpad is still required to implement a migration confirmation
adapter; never infer migration from a name, symbol or the fact a pool exists.

## Running and reports

Use the Live-market paper workflow with strategy `launch`, universe `discovered`,
virtual capitals `0.1,0.5`, duration 240 and overnight enabled. The second segment
restores the first segment's books and ledger. It runs in GitHub Actions with the
computer off. Existing reports remain independent experiments.

The public Degen results show the strategy, positions, duration, modeled costs,
open/closed/total PnL, DEX and creation/migration evidence. Artifacts contain raw
samples, report.html, trades.csv, pools.csv and equity.csv. CSV includes optional
fields even when they are absent from the first row. V4 positions link to the pool
page rather than an invalid contract-address link.
