# Degen v2: validation and operating limits

Real execution is **off by default**. `/degen` includes a browser paper simulator requiring no wallet, gas or credentials. It runs the same `decide()` function as the keeper, with explicitly synthetic prices, fees and execution. It is not a historical backtest, profitability proof or token audit.

## What changed

- A scheduler request awaits the work. Reads never start a background financial loop. Failures return 503; concurrent work returns 409, rather than a successful skipped response.
- A database lease serializes keeper use across instances. Signed transaction hashes and intents are saved **before** broadcast. Pending outcomes are reconciled with two confirmations before any other transaction can be sent. An unknown/dropped transaction blocks automation until an operator investigates it; the system does not blindly resend it.
- Discovery uses fresh GeckoTerminal v3 data, not the static UI catalogue. The data must be at most 60 seconds old. Discovery is restricted to its first page; lack of coverage blocks new exposure rather than fabricating data.
- Tokens must be manually reviewed and included in `DEGEN_APPROVED_TOKENS`. The official factory must match the pool. An `eth_call` probe executes the actual new vault's buy → mint → remove → sell sequence at the intended amount. A failed probe or round-trip loss over 3% rejects the candidate. This is state-specific: changing admin controls, discriminatory token behaviour and later honeypots remain possible.
- Entry requires pool age ≥7 days, TVL ≥$100,000, a persistent opportunity for ≥2 minutes and ≥3 spaced observations. One-hour volume spikes no longer determine the trading rank.
- Estimated incremental fees use 24-hour volume, a 100% APR cap, a 50% haircut and a six-hour horizon. They must exceed twice the estimated costs. Costs include the round-trip probe loss, estimated transaction gas and an additional 1% allowance when leaving an existing position. These are conservative heuristics, not forecasts. Many pools, especially with a €1-sized deposit, should never be entered under this policy.
- Position valuation uses simulated liquidity removal and a conservative sell quote, including already-owed fees. It can undercount newly accrued fees. It is in ETH, not EUR/USD, and excludes owner withdrawal gas.
- A 5% ETH loss or trailing drawdown, or a 30% pool TVL drop, requests an exit without waiting for the 30-minute holding period. Risk stops latch: there is no automatic re-entry. Losses can overshoot the threshold; quotes, tokens, liquidity, monitoring and transaction inclusion can fail.
- New vaults restrict tokens to the owner's list, enforce 30 minutes between entries and a maximum of four entries per on-chain day window. The server also applies a rolling 24-hour limit. The keeper remains a trusted hot key capable of making losing trades within these limits.

## Exits and existing vaults

New contracts have `VERSION = 2`. Existing deployments are immutable and are **not upgraded by a website deploy**. Their automatic trading is disabled by this keeper version; their `exitNoSwap`, owner token rescue and NFT recovery remain accessible.

- **Protected ETH exit:** a short-lived swap minimum and total WETH minimum must both hold. Failure reverts the whole operation; the UI does not claim withdrawal succeeded.
- **Raw withdrawal:** removes liquidity and returns ETH and pair tokens without a sale. This remains available without a pool being visible in the discovery feed, and for old vaults. A hostile token can still refuse transfer; token/NFT rescue controls are provided, not a guarantee that a hostile token can be recovered or sold.
- **Keeper risk exit:** closes the position into WETH retained in the owner's vault and revokes the operator. Only the owner can withdraw to their wallet.
- The pending deployment hash is stored per wallet for retrying registration. A vault address can also be loaded directly from chain to recover owner controls if registration never succeeded.

## Scheduling and production settings

Set these in **Vercel → project → Settings → Environment Variables → Production**, never in chat or a tracked file:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Persistent PostgreSQL/Neon state |
| `KEEPER_PRIVATE_KEY` | Dedicated keeper key; never an owner's wallet key |
| `CRON_SECRET` | Authentication for scheduler requests |
| `DEGEN_LIVE_ENABLED` | Must explicitly be `true` to send keeper transactions; omit/false for paper mode |
| `DEGEN_APPROVED_TOKENS` | Comma-separated, reviewed token contract addresses, at most 16 |
| `ARM_ALLOWLIST` | Optional closed-beta owner addresses |
| `KEEPER_PAUSED=1` | Stops all new keeper broadcasts, including risk exits; owner withdrawals still work |

A continuous worker is supplied as `npm run keeper:worker`. Its environment requires `KEEPER_URL` (the app's HTTPS origin) and `CRON_SECRET`; it does **not** receive a wallet private key. It awaits requests and aims for 15-second intervals. An existing always-on machine can run it without buying hosting, but this repository does not provide a free managed uptime guarantee.

The GitHub Actions five-minute schedule remains a fallback. Gaps over 45 seconds block new entries. Running the browser or a Vercel request does not create a permanent background worker. Readiness and execution errors are visible at `/api/degen/status` and on each vault. The worker must be running and the complete live prerequisites must pass before deposits are enabled. Do not enable live operation merely to remove a warning.

Before broadcasting, the keeper requires estimated gas for the intended transaction plus two equivalent exits. That is a reserve heuristic, not a guarantee against gas spikes. The UI no longer treats 0.003 ETH as a universal threshold.

An unresolved intent must be investigated using its transaction hash, chain receipt and account nonce. Never clear it just because a timeout occurred: the signed transaction may still be included later. Owner withdrawal/revocation can be used independently of the database.

## No-money verification

- `npm run test:degen`: local EVM contract tests, real PostgreSQL-engine lease tests, keeper fault/reconciliation tests, policy and paper-scenario tests. No external wallet is funded or used.
- `npm run typecheck` and `npm run build`: application gates.
- Local fork: run pinned Anvil 1.7.1 with `--fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 31337 --port 8545 --silent`, then `npm run test:degen:fork`. The test refuses non-loopback endpoints or a chain ID other than 31337, creates only synthetic balances and never submits a transaction to mainnet. Pin `--fork-block-number` to reproduce a specific observation.
- Verified at Robinhood fork block **89599047**, WETH/USDG pool `0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a`, fee tier 500. The actual router and position manager accepted deployment, entry, risk exit, revocation and owner withdrawal using the generated Cancun bytecode. A 0.00045 synthetic ETH probe recovered 0.000449774566975635 ETH before gas. This validates that flow at that state, not every token or future state.

The new additive schema is bundled and applied idempotently at runtime as well as through the standard migrations, covering prebuilt deployments without build-time DB credentials. No existing vault or historical row is deleted.

This release has automated tests and fork validation, **not an independent security audit**. It does not guarantee profit or eliminate loss.

The public RPC prunes historical state. If a long-lived local fork starts reporting unavailable historical state, start a fresh fork at the latest block (reproduction of an old block requires an archive RPC). No assertions are skipped for this failure.
