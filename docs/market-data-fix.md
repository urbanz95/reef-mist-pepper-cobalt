# Correcting paper market selection and data freshness

## Selection bug

The policy ranked all pools by expected incremental fees minus costs, then tested
only the winner against the required two-times cost margin. A winner could fail
that margin while another candidate passed, incorrectly preventing a trade.
The policy now filters by the margin first, then ranks feasible candidates.
The cost margin, APR cap, fee discount, cooldown, confirmation and risk limits
are unchanged. This correction also applies to the shared live policy, although
real trading remains disabled.

On the saved October 17–18 overnight dataset, 641 of 1,591 fee-related waits had
at least one candidate meeting the financial margin. Replaying the chronological
record with the corrected selector produces one 0.5 ETH paper entry. The position
ends with unknown valuation because the original record has missing observations.
This is a regression check, not evidence of profitability or a reconstructed sale.

## Separate discovery metadata from executable state

The previous collector fetched three provider pages every 30 seconds and treated
the provider's TVL/24h-volume response timestamp as the executable price timestamp.
It incurred 706 HTTP 429 responses and blocked both entry and position monitoring.

Discovery and held-pool lookups now share at most one provider request per 65
seconds, rotate three pages, honor Retry-After and exponentially back off on
failures. Each successful page is retained independently; failures never advance
cached timestamps. Runner polling may make requests even less frequent. Request
counts are recorded separately from cache hits.

Every market observation obtains the current chain head, token price, both pool
token balances and the full read-only buy/LP/remove/sell probe at the same block.
A block-scoped snapshot cache avoids repeating capital-independent balance/price
reads for the second virtual balance. Chain data must still satisfy the original
60-second limit and successful round-trip requirement.

Reported USD TVL is now calculated from live reserves in ETH times the provider's
ETH/USD reference. Volume and the USD reference are slower metadata: they must be
at most ten minutes old to approve a new entry. They are NOT claimed to be live
oracle prices. Missing USD references reject sampling; expired references cannot
approve entries. Expired volume accrues no modeled fees.

Held positions keep receiving current chain price, reserves and sellability
checks when provider metadata expires. Reserve changes are compared in ETH units,
so an ETH/USD metadata conversion update cannot masquerade as a liquidity shock.
Known pool references are kept for pools disappearing from discovery pages and
saved/restored with the overnight checkpoint without refreshing their timestamps.

Per-pool report diagnostics show expected incremental fees, required fees including
the cost margin, and whether the financial gate passed. Additional policy gates
still apply. The raw evidence retains chain block, reserve value, metadata age,
provider request counters and simulations. No signing or broadcast method is added.
