# Cost-aware carry experiment

This is a paper-only strategy hypothesis, not a profitable trading system proven by data.
Production keeper settings and live execution remain unchanged. Scheduled paper tests
now use carry48 with 0.1 and 0.5 ETH virtual balances. Baseline remains selectable
in the workflow as the six-hour control strategy. This is not a live rollout.

The baseline evaluates six hours of discounted, capped historical-volume fees.
The recorded overnight sample required a median of roughly 43 hours at 0.1 ETH
and over 5,000 hours at 0.00045 ETH to cover modeled round-trip costs with the
existing two-times margin. A tiny deposit cannot be made economical merely by
forcing more transactions.

Carry48 uses a 48-hour fee projection, with the same fee discount, cost margin,
factory, token-universe, age, liquidity and round-trip checks. It requires at least
two minutes of observed prices and rejects entry at least 1% below the observed
15-minute high. Existing price/liquidity stops remain active.

One missing feed sample can preserve recent confirmation evidence for at most
45 seconds; it never counts as an observation and never permits entry without
fresh prices and a successful current round-trip probe. Longer outages reset
confirmation. Missing prices remain unknown and do not accrue modeled fees.

Exit is attempted when estimated value after exit costs exceeds both initial
capital and entry account value by at least max(0.1% initial capital, two current
round-trip cost estimates), or after 48 hours in the position. Successful exits
latch the stop for the remainder of the experiment, avoiding immediate re-entry.

The cloud experiment is bounded to at most five hours. A four-hour run tests
initial behavior, NOT the full 48-hour hypothesis. An open position at the end
is unrealized, not a profitable completed trade. The 48-hour timeout and profit
exit are exercised with deterministic regression tests; long holding periods
require a future continuous observation run before any live rollout.

## Reproducible development replay

Run `node scripts/live-paper/replay.mjs <samples.ndjson>` against an Actions
artifact. It compares baseline and carry48 using each capital's own probe costs,
processes observations chronologically, and reports trades, modeled PnL and open
positions. There is no invented pool price or future-price input into decisions.

Legacy samples lack exact decision timestamps. Replay conservatively uses the
end of each sample interval; it cannot reproduce original execution timing
exactly. New runs record decision timestamps. This dataset was used during
development, so its result is in-sample, not independent validation.

On the October 17 overnight sample, this conservative replay entered once at
0.1 ETH, ended with the position open and modeled PnL around -0.00016835 ETH
(-0.168%). The small-capital baseline and carry tests did not enter. This result
shows that generating trades does NOT establish profitability. No parameters
should be promoted to live trading on this evidence.
