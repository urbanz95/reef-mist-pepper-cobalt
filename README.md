# Perch

Uniswap liquidity desk on Robinhood Chain, with a Degen hunter that hops to the highest-APR WETH pool.

- Markets: live Uniswap pools and APR
- Degen: one wallet, one vault. You sign once. A keeper hops while the browser is closed
- Withdraw: only the wallet that armed can call `exit()`

Not affiliated with Robinhood Markets, Inc. The contract is not audited.

## Running the keeper

- `KEEPER_PRIVATE_KEY` (required when deployed): the operator hot key. It can only call `rebalance` on vaults; it cannot withdraw to itself, but it picks the pool of each hop, so keep it funded with gas only and rotate it if leaked. Owners can revoke it any time with `setOperator`.
- `CRON_SECRET`: `/api/degen/tick` requires `Authorization: Bearer $CRON_SECRET` when deployed. Point a cron at it, because serverless functions do not keep the in-process loop alive while the browser is closed.
- Pause/resume asks the owner wallet for a free signature. Exit is always a direct on-chain call by the owner; `exit()` swaps back to ETH on a best-effort basis and never gets blocked by a token. `exitNoSwap()`, `rescueToken()` and `rescueNft()` are escape hatches.
- Vaults deployed before this fix keep the old contract. Exit them and re-arm to get the fixed one.
