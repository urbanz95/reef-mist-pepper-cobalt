# Perch launch checklist

Goal: ship fast without putting more at risk than a failure can cost. Launch as a
**capped, allowlisted beta**, widen only after the gates below pass.

## Hard gates (do not skip)

- [ ] **Fork test on the real chain.** The contract tests use mocks. Run the actual
      `PerchDegen` against the real WETH / NPM / SwapRouter02 / QuoterV2 on a fork
      (`anvil --fork-url https://rpc.mainnet.chain.robinhood.com`): arm, `rebalance`
      into a real WETH pool, `exit()`, and confirm native ETH arrives. This also
      checks that the chain accepts the Cancun bytecode we compile
      (`scripts/compile-degen.mjs` targets `cancun`).
- [ ] **Independent review of `contracts/PerchDegen.sol`** (it is not upgradeable, so
      every vault keeps whatever is deployed). Even a short paid review beats none.
- [ ] **Verify the contract on Blockscout** and publish the source.
- [ ] Re-run `npm run build`, `npm run typecheck`, `node --test scripts/perch-degen.test.mjs`,
      `node --experimental-strip-types --test src/lib/degen-auth.test.ts`.

## Environment

| Var | Why |
| --- | --- |
| `DATABASE_URL` | Neon Postgres. Without it the app falls back to PGLite and forgets every vault on restart. |
| `KEEPER_PRIVATE_KEY` | Operator hot key. Dedicated wallet, gas only (a few $). Never reuse a personal key. |
| `CRON_SECRET` | Protects `/api/degen/tick`. |
| `ARM_ALLOWLIST` | Comma separated wallets allowed to arm (closed beta). Unset = open. |
| `KEEPER_PAUSED` | `1` stops all hops immediately. Owners can still exit on-chain. |

Run the keeper as an always-on worker (Railway / Fly) or a cron hitting
`/api/degen/tick` with `Authorization: Bearer $CRON_SECRET`. The in-process
`setInterval` does not survive serverless.

## Launch phases

1. **Private beta**: 3-10 wallets you know, `ARM_ALLOWLIST` set. The contract itself
   caps a vault at 0.5 ETH (`MAX_DEPOSIT`); the UI mirrors it with `MAX_ARM_ETH`.
   Watch hops for a week: failed hops, keeper gas balance, real fees vs. slippage.
2. **Wider beta**: only after a clean week and the review. Raising the cap means
   changing `MAX_DEPOSIT` and redeploying; old vaults keep the old cap.
3. **Public**: pool-quality filters (honeypot / rug checks, trade size vs TVL),
   TWAP-checked slippage and a hop cooldown on-chain, ideally via a factory.

## Incident runbook

- Anything looks wrong: set `KEEPER_PAUSED=1` and redeploy/restart. No hop happens.
- Keeper key suspected leaked: pause, then tell owners to call `setOperator` to a
  dead address (or exit). Rotate `KEEPER_PRIVATE_KEY`; vaults armed with the old key
  must be exited and re-armed (the operator is fixed per deployment unless the owner
  calls `setOperator`).
- Owner escape hatches, all owner-only and independent of the keeper: `exit()`,
  `exitNoSwap()`, `rescueToken(token)`, `rescueNft()`.
