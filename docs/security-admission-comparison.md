# Why the older memecoin experiment entered and guarded did not

## Historical evidence

The archived [run 39231564620](https://github.com/urbanz95/reef-mist-pepper-cobalt/actions/runs/39231564620), revision `43a5c694`, used the `launch` profile. Its ledger records the following for the 0.1 ETH virtual book. Times below are Europe/Lisbon on 19 October 2026. These are the old model's estimates, not transaction receipts or a verified liquidation backtest.

| Token     | Entry    | Exit     | Modeled position PnL ETH |
| --------- | -------- | -------- | -----------------------: |
| METRIC    | 10:43:52 | 10:45:08 |            +0.0029727548 |
| godspeed  | 11:20:39 | 11:21:09 |            +0.0014939966 |
| SUPERCORE | 11:56:55 | 11:59:25 |            +0.0018122394 |
| Mimi      | 12:32:56 | 12:34:11 |            -0.1062789908 |

The first three modeled winners raised that book to 0.1062789908 ETH. The fourth wiped out the whole virtual book; the independent 0.5 ETH book also ended at zero. The previous model allocated the whole account, had no mandatory token-security/LP-withdrawal proof, and marked positions using price ratios/fresh round trips rather than an isolated sale of the quantity held. Three winning modeled trades do not validate the strategy's risk or net profitability. See [the confirmed Mimi liquidity removal](guarded-paper-test.md#mimi-regression-evidence).

The guarded profile instead requires full security evidence, protected liquidity and an isolated exit quote; it allocates at most 2% per position, at most 4% combined. The price/momentum signal still needs to cover costs. This changes which trades qualify. It does not imply the market has no executable pools.

Historical `eth_call` checks of the four original entry blocks returned `historical state ... is not available` from the public RPC during this investigation. No current owner/LP result is presented as proof of the state at those historical entries. The original raw samples and ledgers remain in the archived artifacts.

## Confirmed integration defects and changes

1. **Multi-token security queries only returned the first token.** A live request for WOJAK, HARMONIC and ZERO returned only WOJAK. Each individual query returned its corresponding token. The old client cached missing rows with a current timestamp; a generic missing/expired message hid the integration failure. The new provider requests exactly one address, matches only that address's result, and never refreshes evidence when the expected row is omitted or malformed.
2. **Fair refresh and pacing.** At most two individually paced requests run per refresh, at least 2.1 seconds between starts. Oldest attempts are serviced first, with near-expiry held tokens prioritized. Six entry candidates plus rotating diagnostics can retain genuinely fresh responses during the confirmation window. Missing records have a 30-second retry delay. HTTP retry-after/global backoff and provider cache age are preserved; failed refreshes cannot extend approval freshness. Concurrent callers share one worker.
3. **Entry-slot eligibility.** Generic V3/V4 venues without a verified liquidity-protection adapter and ungraduated Pons curves remain observable but do not occupy entry-confirmation slots. A recently rejected candidate, or a complete response with genuinely unresolved security checks, releases its slot for one minute before reconsideration. A missing token record releases it for 30 seconds; pending requests keep their place until serviced. Held positions remain monitored. Dedicated canonical V2 discovery joins the same six-source rate budget, replacing a duplicate new-pools page.
4. **Permanent holders.** Concentration excludes a Pons locker only when the pinned runtime and current pool/NFT/ownership/approval/range/liquidity proof have passed. That reviewed runtime has no outgoing token or NFT transfer path. Provider `is_locked` tags alone do not qualify. A different unprotected holder above 5% still rejects the token. This also prevents a permanently locked reserve from becoming a false shared-whale actor.
5. **Exit accounting.** A sale probe must leave zero token balance in the virtual wallet. A partial token sale cannot be reported as a full exit. Entry also requires the independent exact-quantity liquidation value, after both gas legs, to remain above the position's immediate 3% loss trigger. A successful fresh round trip cannot bypass this check.
6. **Observable admission.** Reports distinguish queued, received, omitted, expired and failed security responses; show the last sample's entry funnel and retain pool-specific admission blockers in the app, JSON and CSV. The first public snapshot contains an observation instead of an empty startup record.

## Unknown security remains unknown

Individual GoPlus replies can still omit `cannot_sell_all` or `owner_address`. The official [SDK response definitions](https://github.com/GoPlusSecurity/goplus-sdk-js/blob/main/src/gen/model/ResponseWrapperTokenSecurityResult.js) document a missing result as unknown. We do not substitute zero, treat a missing owner getter as proof of no owner, or infer that permanent LP ownership makes the token safe. A current successful sale is not proof that future selling or every wallet is unrestricted.

The provider bug is fixed without turning missing security evidence into approval. Other risk, source, concentration, liquidity, cost, signal and portfolio limits remain mandatory. Real keeper deposits/trades are not enabled by these changes; tests use virtual balances without signing or broadcasting.
