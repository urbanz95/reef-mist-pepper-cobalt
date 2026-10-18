# Memecoin research in the paper test

The discovered universe now directly refreshes two Robinhood Chain research pools,
in addition to the existing three Uniswap V3 discovery pages:

| Token              | Token address                              | Pool address                               |
| ------------------ | ------------------------------------------ | ------------------------------------------ |
| MEME (A Meme Coin) | 0x385f4f8ae47651ce5f58f5265395a669f8281e18 | 0xe2c12a7379706a291cadaaec1d22458be2f7239d |
| CASHCAT (Cash Cat) | 0x020bfc650a365f8bb26819deaabf3e21291018b4 | 0xa70fc67c9f69da90b63a0e4c05d229954574e313 |

Identities came from the provider's token-address relationships, not symbol matching.
This is an explicit initial research watchlist, not an exhaustive meme catalogue or
a token security approval. New watchlist entries require explicit chain addresses.

All five requests share the existing 65-second minimum HTTP interval, retry-after
handling and exponential backoff. At the runner's 30-second discovery polling rate,
a normal complete cycle takes about 7.5 minutes. Original metadata timestamps stay
unchanged on cache hits; backoff may cause expiry and block entries.

All discovered WETH pools still appear in pool coverage with screening reasons.
Up to two of six execution-probe slots prioritize eligible watchlist pools, then the
remaining slots follow the existing volume/TVL ranking. Maximum two tiers per token
still applies. Held pools are additionally monitored regardless of entry eligibility.
The token-control universe still only probes its explicitly selected tokens.

The $100k liquidity, seven-day age, canonical factory, round-trip execution,
confirmation, freshness and cost-margin rules are unchanged. MEME had about $70k
liquidity when inspected on 2026-10-18 and was therefore ineligible at that time.
Rejected pools remain visible; there is no forced memecoin purchase.

Existing workflow processes keep their checked-out code. Dispatch a new run on the
merged revision to use this coverage; the concurrency group queues it until the
current run finishes. The new run has fresh virtual 0.1 and 0.5 ETH books; it does
not reset or rewrite the previous run. Production trading and contracts are unchanged.

Use the public Degen paper-results coverage and workflow artifacts (`report.html`,
`pools.csv`, `trades.csv`, `samples.ndjson`) to distinguish screening from verified
probes and simulated entries/exits. Fee APR and LP PnL remain modeled, not earnings
or probabilities of profit. No wallet key or transaction broadcast is used.
