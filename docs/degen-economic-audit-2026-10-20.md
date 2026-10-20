# Degen economic audit — 20 October 2026

The observed spot opportunities did not demonstrate an edge sufficient to pay
execution costs. Fixing price continuity and exit accounting is necessary, but
does not establish profitability. This audit used recorded paper observations
and public read-only calls on Robinhood Chain (4663); no transactions were signed
and no real funds were used.

## First four hours: movement versus cost

[Run 39381049084](https://github.com/urbanz95/reef-mist-pepper-cobalt/actions/runs/39381049084),
artifact `live-paper-39381049084-part-1`, covers
**2026-10-20 06:34:06.251–10:34:06.899 UTC**: 2,582 samples, 8,770 verified quotes
and **zero filled paper positions**. This is a segment, not the final run result.
Its `samples.ndjson` supplies the quote chronology; `report.json` supplies the
segment times and counters.

| Pool          | Distinct price observations | Change across segment | Largest measured rise over 60 seconds–30 minutes |
| ------------- | --------------------------: | --------------------: | -----------------------------------------------: |
| HARMONIC/WETH |                       1,960 |             −10.7275% |                                         +0.8263% |
| THRONE/WETH   |                       1,703 |              −0.1441% |                                         +0.2715% |

The horizons checked were 60, 120, 300, 600, 900 and 1,800 seconds. Observations
were deduplicated by pool and quote timestamp; each comparison uses the latest
observation at or before the target lookback, with at most 30 seconds additional
lookback. No measured rise reached 1%, even when allowing windows across gaps.
Only the 60- and 120-second horizons had fully continuous subsets. These are
observed price changes, not executable returns or reconstructed PnL.

A recorded HARMONIC quote at block **93247156, 06:34:30 UTC** valued a 0.002 ETH
allocation at **0.001952101984410064 ETH net liquidation value**: **2.3949%**
all-in friction. Its buy input was 0.0019 ETH, measured sale proceeds were
0.001861910841302064 ETH, and the mark also accounted for retained ETH and both
gas legs. This is one measured allocation and market state, not a constant fee.
The measured rises above do not cover that example's cost. Longer holding periods
alone have not been validated as a solution.

## Search for cheaper execution

At block **93426027, 11:45:03 UTC**, 28 distinct tokens with reported protected
Pons seed liquidity of at least 95% and pool TVL of at least $15,000 were checked
against canonical factories: V2 `getPair(token,WETH)` and V3
`getPool(token,WETH,fee)` for fees **100, 500 and 3000 pips**. All **112 queries**
returned no pool. This does not cover every token, fee tier or venue.

Live token-pool metadata for HARMONIC, THRONE and INVR, plus WOJAK, BORRO, IAF,
WIF and IGNITION, also revealed no cheaper direct ETH route that passed the
required executable-depth and sale checks. Examples:

- BORRO's V4 0.25% pool
  `0x8b1b1f139008991c1c24a045ea7972c122996eb5666453b86b71a8b4dbbd169f`
  had zero active liquidity; a 0.0019 ETH buy probe reverted with `no tokens`.
- IGNITION's V4 0.9% pool
  `0x4f56665568ec1d2537b7aad8f4bd6d3e29dd577d95ccbfe00b386e8e78af206f`
  also had zero active liquidity and the same buy failure. Both liquidity reads
  were pinned to block **93428002, 11:48:22 UTC**.
- WOJAK/USDG at 0.9% required unsupported two-hop funding, had about $11,700
  reported TVL, and offered only a small fee saving before additional gas.
  It was not qualified through exact multi-hop execution and safety checks.

### THRONE: a misleading successful roundtrip

At block **93425345, 11:43:51 UTC**, THRONE's hook-free V4 pool with fee 2500
pips, tick spacing 25, native ETH currency0 and THRONE currency1 had zero active
liquidity:

`0xada0d7f6daf5c792171278c655b5b0f3565420e4c5ecb1af5dbe55911369907a`

A single constructor `eth_call` buying and immediately selling recovered
**0.001889000672133519 ETH from 0.0019 ETH** before gas, apparently 99.4211%.
But an isolated sale of its exact **2829398575149348813175** raw purchased tokens
at the original block reverted with **`partial token sale`**. The fresh buy had
changed the simulated pool state before the first test's sale.

Selling that quantity through the protected primary THRONE pool returned only
**0.000715875028290286 ETH**, before **0.00000485155875 ETH** estimated sale gas:
about 62.3% capital loss before gas. A 0.0095 ETH test at block **93425375,
11:43:54 UTC** showed the same failure pattern. A protected fallback is therefore
insufficient without proving both full execution and economically acceptable
proceeds for the actual held quantity.

## LP income is a different strategy

The reviewed Pons primary V4 keys have **LP fee zero**. The verified
[PonsV2MemeHook source](https://sourcify.dev/server/v2/contract/4663/0xe5e702641ea86f4ae6cc3cdaed2b886f976be044?fields=sources,compilation)
(`contracts/src/v2/hooks/PonsV2MemeHook.sol`, `_afterSwap` and fee distribution)
credits hook charges to protocol, creator and buyback buckets. The approximately
1% hook charge per swap is **not fee income paid to an external LP**. Multiplying
volume by that charge would overstate LP yield.

The funded [PerchDegen contract](../contracts/PerchDegen.sol) enters V3 NFT
liquidity positions. The current guarded experiment buys and sells spot tokens.
Spot paper results do not validate that contract's LP execution or profitability.
A genuine LP experiment must separately measure collected fee growth, active
range, inventory value/impermanent loss, entry and exit swaps, rebalancing gas and
full held-position liquidation. APR rankings alone are insufficient.

## Decision and reproducibility

Prioritize **cost-first screening**: reject economically infeasible routes before
repeated expensive probes; retain fresh exact-quantity exit checks and token/LP
safety gates. Keep canonical price observation independent of current admission
so gaps can be diagnosed without weakening entry requirements. Evaluate either
a genuine fee-earning LP model or a different, demonstrably liquid and cheaper
executable universe. Do not lower the profitability requirement merely to force
pool hops. Neither path has yet demonstrated profitable trading or guarantees it.

Public reproduction uses RPC `https://rpc.mainnet.chain.robinhood.com`, canonical
addresses in [chain.ts](../src/lib/chain.ts), `eth_call` pinned to the blocks above,
and the same-call and isolated-sale probes in
[spot-market.mjs](../scripts/live-paper/spot-market.mjs). The isolated test uses a
proved token-balance override and requires full token consumption. Relevant IDs:

| Asset    | Token                                        | Protected primary pool                                               |
| -------- | -------------------------------------------- | -------------------------------------------------------------------- |
| HARMONIC | `0xdee52f2ab639b6942b0d0f0565400b93b7a0fbe5` | `0x77ea11bbfb8f1259c702cb0ebc2105b7c007db89cf30c2f1a8776886a4467c07` |
| THRONE   | `0x72dc556fff14115c077a540921e5f35499a4dca7` | `0x36ab7cfb4cf0a11e38e8c640494db163a3beeec1b23e7afcc48d8e1192e0601b` |
| INVR     | `0x9a7c661be578e50927268fb770146d701b3368e7` | `0x34d987bed1f9db8cb7bb467f46f509b4250d21bbb3d23d35df0cedd0eee48004` |

Research snapshots were also saved under `/workspace/onboarding/` as
`rotation-forensic-summary.json`, `route-throne-cross-exits.json`,
`route-anchor-cheap-factories.json`, `route-anchor-v4-state.json`,
`route-anchor-v4-probes.json` and `route-hook-source.json`. These workspace copies
are supplementary; the run/artifact, exact identities, blocks and method above
are the durable references. Historical reproduction needs archive RPC support;
live quotes, metadata and liquidity change, artifact retention is finite, and the
PROPHET metadata request was rate limited. Successful simulation does not prove
future execution, market safety or profit. No profitable fills were validated.
