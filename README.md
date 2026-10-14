# Perch

Uniswap liquidity desk on Robinhood Chain, with a Degen hunter that hops to the highest-APR WETH pool.

- Markets: live Uniswap pools and APR
- Degen: one wallet, one vault. You sign once. A keeper hops while the browser is closed
- Withdraw: only the wallet that armed can call `exit()`

Not affiliated with Robinhood Markets, Inc. The contract is not audited.

## Free scheduler with GitHub Actions

The `Keeper` workflow calls the production keeper every five minutes and can also
be started manually from the repository's Actions tab. Add a repository Actions
secret named `CRON_SECRET` with the same value as Vercel's Production variable.
The workflow must be on the default branch for scheduled runs to start. No Vercel
redeploy is needed to activate this external scheduler.

GitHub schedules can be delayed, so execution every five minutes is not guaranteed.
The status endpoint allows 15 minutes without a call before reporting a stale
scheduler; it still reports a scheduler that has never called the keeper.
Public repositories use free standard runners; private repositories consume the
account's included Actions minutes. GitHub may disable scheduled workflows in
public repositories after 60 days without repository activity. A successful run
updates `/api/degen/status`; funding the keeper with gas remains a separate step.

## Running the keeper

- `KEEPER_PRIVATE_KEY` (required when deployed): the operator hot key. It can only call `rebalance` on vaults; it cannot withdraw to itself, but it picks the pool of each hop, so keep it funded with gas only and rotate it if leaked. Owners can revoke it any time with `setOperator`.
- `CRON_SECRET`: `/api/degen/tick` requires `Authorization: Bearer $CRON_SECRET` when deployed. Point a cron at it, because serverless functions do not keep the in-process loop alive while the browser is closed.
- Pause/resume asks the owner wallet for a free signature. Exit is always a direct on-chain call by the owner; `exit()` swaps back to ETH on a best-effort basis and never gets blocked by a token. `exitNoSwap()`, `rescueToken()` and `rescueNft()` are escape hatches.
- `ARM_ALLOWLIST` (closed beta) and `KEEPER_PAUSED=1` (emergency stop) are optional. Vaults are capped at 0.5 ETH on-chain. See `DEPLOY.md` for the launch checklist and incident runbook.
- Vaults deployed before this fix keep the old contract. Exit them and re-arm to get the fixed one.
