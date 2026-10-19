# Guarded paper portfolio

The default cloud paper experiment is `guarded`. The workflow permits this profile
only; `baseline`, `carry48` and the all-in `launch` implementation remain available
for reproducing historical reports. This change does not enable or modify live
keeper trading. No wallet key, signing method or transaction broadcast is used.

## Position accounting and exits

Each independent virtual balance can hold **two different tokens** simultaneously.
An entry allocates at most **2% of the smaller of initial and current equity**, with
**4% maximum combined allocation** checked at entry. The allocation includes the
buy input, estimated entry gas and an ETH reserve for exit gas. The buy uses 95%
of its allocation; entries whose measured costs do not fit are rejected. Initial
balances of 0.1 / 0.5 ETH therefore allocate up to 0.002 / 0.01 ETH per position,
respectively. Open positions may change value; allocations are not rebalanced.
The same token in another fee pool, or a shared known issuer/owner/top-three
non-pool holder, cannot form a second simultaneous position.

Each position stores its own exact raw token quantity, allocation, gas reserve,
entry block/time, high water, exit request and ledger ID. A sell-only constructor
simulation injects that quantity into a disposable wallet's ERC20 balance mapping
using read-only storage overrides. The mapping is proved by sentinel and actual
quantity `balanceOf` reads; unsupported accounting fails closed. **No new buy or
pool reserve override precedes the sale.** Exits use the quantity held, not a new
notional purchase. Independent books do not interact or change future chain state.

The marked value is sale proceeds plus reserved ETH minus estimated exit gas.
The ledger separately charges each gas leg once, at entry and at simulated close.
Pool trading fees and impact are already included in token fills / sale proceeds;
spot positions earn no LP fees. Gas adds 51,000 per leg and a 50% margin. Additional
network data fees, deployment, MEV, real mempool latency and execution guarantees
are not modeled. Missing/stale/failed sales mean **unknown**, never a zero mark or
invented closed trade. A gas quote above the reserved ETH cannot silently spend
unallocated portfolio cash; the position remains open and needs review.

Entry requires two minutes of observed prices, rise at least max(0.5%, twice
measured costs/allocation), no 1% drawdown, then two minutes of signal confirmation.
There is **no minimum pool age** in paper trading. Stops apply independently:
1% net position profit target, 3% loss trigger, 2% trailing trigger, 30% depth drop,
or 30-minute maximum hold. Security/risk exits latch further entries while other
open positions remain monitored. At most four entries per rolling day and a
30-minute per-token cooldown. These are execution requests, not guaranteed loss
limits or a claim that the strategy is profitable.

## Security admission and current coverage

Fresh explicit GoPlus results on chain 4663 are required: verified source, negative
proxy/mint/hidden-owner/balance-change/recoverable-owner/selfdestruct/external-call/
mutable-tax/transfer-pause/blacklist/whitelist/honeypot/buy/sell restrictions, zero
buy/sell/transfer tax, creator+owner holdings <=1%, holder distribution with at
least 20 holders and ten reported top holders, each non-pool holder <=5% and the
observed top holders <=20%. Missing fields, unavailable results and data older
than 60 seconds block entry. Provider cache age is preserved. The free API is
batched and throttled; failures and retry-after do not refresh old timestamps.
This is external screening, not a source-code audit or a security guarantee.

Liquidity protection currently supports **canonical V2 pools with >=95% of LP
supply provably at zero/dead addresses**, read at the quote block. Canonical
factory/token identity is also checked before any entry simulation. A provider's
claim that a contract is a locker is insufficient: unsupported locker contracts
remain rejected pending a verified adapter. **Complete pool-specific V3/V4 NFT
ownership, approval and withdrawal permissions are not implemented**, so these
pools remain visible but observation-only. The sell-only adapters were separately
verified with live read-only V2/V3/V4 calls; that does not authorize V3/V4 admission.

Issuer and shared major-holder addresses provide limited correlation screening.
A full related-wallet/funding graph, exhaustive launchpad coverage and proof of
migration are unavailable. Creation logs do not establish launchpad migration.
Burning liquidity does not eliminate token, whale, manipulation or market risk.

## Monitoring, automation and reports

A separate monitor polls the chain head every second and scans **all intervening
blocks** for held pool/token logs in bounded ranges. V2/V3 burns, negative V4
liquidity changes, >=10% funding reserve falls, token mints and ownership changes
request exit. Failed ranges are retried without advancing their cursor. Valuation
targets five seconds; slow RPC/provider calls can delay it. Missing monitoring
blocks entries and requests exits. A removal within a single transaction can
complete before detection; no free polling service can guarantee front-running it.

The two four-hour GitHub Actions segments restore cash, quantities, reserves,
ledgers, risk latches and block-monitor cursors. Checkpoints must reconcile and
cannot silently reinterpret an old all-in account. Daily scheduling runs in the
cloud with the computer off, subject to GitHub scheduling delays and quotas.

`/degen` displays both positions, unallocated ETH, aggregate open/closed/total PnL,
raw quantities and security rejection reasons. Downloadable CSVs include all
position entries/exits, holding times and PnL; artifacts contain JSON, Markdown,
HTML, pool coverage, equity and raw samples. A run with zero security-approved
candidates may correctly produce no trades; unknown checks are never relaxed to
force activity. Different runs and initial balances remain separate experiments.

## Mimi regression evidence

The previous all-in experiment entered Mimi pool
`0x1334ed928fec8e04169a007e4506cb986b45dc47` on 2026-10-19 around 11:32:56 UTC.
A canonical V2 **Burn** at block 92583134 removed 52.876832399121913576 ETH,
transaction `0x5ad9a4655937a3de6e11f8b31adcee586cda33fb4902e3bdb82e46e2ad456da2`.
The public honeypot flag was negative while LP ownership was unprotected.

At block 92656188 a fresh 0.0019 ETH buy/sell probe still recovered about
99.9996%, because the buy itself replenished the pool. A sale-only simulation of
that bought quantity returned only 0.000000614250453361 ETH, before estimated gas
of 0.000006362018346 ETH. This is why a fresh roundtrip must not value an existing
position. The new gates reject this pool's liquidity and missing holder coverage;
the position budget also contains hypothetical loss to its allocated slice.

Unit and local EVM regressions exercise parallel positions, correlated tokens,
exact-quantity exits, independent profit/loss, unknown valuations, insufficient
exit gas, missing security fields, LP proof, provider backoff, scanner catch-up and
checkpoint accounting. They establish those behaviors, not future profitability.
