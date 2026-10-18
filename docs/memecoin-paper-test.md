# Dynamic memecoin research in the paper test

The discovered universe no longer relies on a fixed MEME/CASHCAT research list.
The shared provider budget rotates six sources:

1. Three pages of Uniswap V3 Robinhood pools (includes AI and other tokens).
2. Robinhood network new pools.
3. Robinhood network trending pools.
4. Network-scoped PONS search, which can contain several tokens with the same name.

Pool and token addresses identify candidates. A ticker is not an identity or security
approval. All six requests share the existing 65-second minimum HTTP interval,
retry-after handling and exponential backoff. At normal 30-second polling, each
source refreshes in about nine minutes. Original timestamps never advance on cache
hits; ten-minute metadata expiry still blocks entries during delays/backoff.
This is bounded provider-indexed discovery, not every launch on the chain.
New-pool discovery does not establish a migration or cross-pool token identity.

All observed valid pool records, including V4 pool IDs and pairs on other DEXs or
with unsupported quote tokens, appear in coverage. Unsupported entries carry an
explicit reason and are excluded before execution probes; a second guard also
rejects them in samplePool. Canonical factory and token identity checks still apply
on chain to every supported candidate. The current executor only supports canonical
Uniswap V3 pools with actual WETH; native-ETH aliases and ticker names do not qualify.
V4 IDs are shown as pool names without invalid contract-address explorer links.

Among eligible candidates, four leaders remain continuously monitored and two
research slots rotate across the remaining pools in stable five-minute windows.
This avoids starving tokens outside a fixed top six while permitting two-minute
entry confirmation. The total remains six probes per sample, max two tiers per
token, plus held-pool exit monitoring. The token-control universe still screens
only its selected tokens for execution.

The $100k liquidity, seven-day age, canonical factory, round-trip execution,
confirmation, freshness and cost-margin rules are unchanged. Newly launched or
migrated pools can be observed immediately once indexed but cannot enter while
they fail those gates. This change does not add a V4/other-DEX execution adapter,
a launchpad migration detector, or early-pool trading strategy.

Coverage includes DEX, provider creation time and first/last observation times in
report.json/pools.csv; raw samples preserve the observed feeds and market economics.
The dashboard shows the DEX and latest screening/execution result. These fields
are provider observations, not verified token classifications or migration events.

Start the new revision in a separate overnight workflow run; existing running
processes retain their checked-out code. Fresh virtual 0.1/0.5 ETH books do not
rewrite previous results. No wallet key or transaction broadcast is used.
