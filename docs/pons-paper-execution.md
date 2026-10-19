# Pons paper execution integration

This adapter extends the guarded **virtual** experiment. It never signs or sends
transactions, uses no wallet key and does not enable real deposits or keeper trades.
It does not promise profit or declare tokens safe because a swap succeeds.

## Identity and execution

GeckoTerminal's `pons-v2` identifies a bonding-curve contract (20-byte address),
while `pons-v2-dex` identifies a graduated Uniswap V4 pool (32-byte ID). They are
separate execution routes. Native ETH and canonical WETH funding are supported;
other quote assets remain observation-only. The live V1/legacy keeper is unchanged.

Addresses originate from the official [Pons V2 documentation](https://docs.ponsfamily.com/v2)
and the public app's factory-to-hook registry, observed on 2026-10-19 at
`https://www.ponsfamily.com/_next/static/immutable/chunks/0aliq4xz-d2-8.js`.
Four generations are explicitly enumerated in `src/lib/pons-contracts.ts`.
Factory/hook runtime hashes, factory registration, token/curve/pair identity,
canonical position manager, matching V4 key and phase are checked on chain.
An arbitrary provider label, hook or factory never becomes trusted automatically.

Curves execute `buy(input, minimum, recipient)` / `sell(quantity, minimum, recipient)`.
The probe measures fees and gas through actual `eth_call`, not an invented constant
fee or quote formula. Phantom reserves determine the marginal display price but
are excluded from executable funding depth. A clamped buy/refund is explicitly
rejected as `partial curve fill`; it cannot be booked as a full purchase.
Sells that have closed at `readyToGraduate`, the swept phase and rescued launches
are unavailable. No minimum pool age is imposed; the existing momentum confirmation still applies.

Graduated pools use the canonical V4 manager and the registered Pons hook. Their
fees/taxes are reflected in measured output. Held quantities are sold in isolation
using proved token-balance overrides; no fresh buy refills the pool before valuing
them. A held curve record is re-read at each block: once phase 2 is verified its
exit resolves to that token's matching V4 pool without changing the token quantity.
The monitor follows that pool ID and watches factory state-change logs. It cannot
trade during a closed graduation gap, invent an exit, or guarantee a future fill.

## Permanent seed liquidity proof

The supported current/recent locker runtime hash is
`0x58455f80b3773871d601a025e56ec27c71ab3bbb8e2ca6b17828954450742025`.
Its deployed runtime is 1,969 bytes including Solidity metadata. A bounded runtime
review found one external `CALL`, at PC `0x6bf`, for ERC20 `transferFrom`; its calldata
at `0x69d..0x6b5` sets `from=CALLER` and `to=ADDRESS`, so it pulls assets **into**
the locker. Its one `STATICCALL` reads position ownership. There is no delegatecall,
selfdestruct, outward NFT transfer or approval path. `setFactory` at `0x33f` requires
owner and reverts if the factory slot is already nonzero (`0x36d..0x372`); it has
no reset path. Owner changes do not give an NFT withdrawal path. This is a scoped
runtime review of that exact hash, **not an independent contract audit**.

The adapter also requires initialized factory/manager getters to match, `isLocked`
and `lockedPositions` for the actual token, canonical NFT ownership by the pinned
locker, no per-NFT approval, a matching pool key, a full-range seed and seed
liquidity covering **at least 95% of currently active liquidity**. This is not a
claim about aggregate TVL, every NFT in the ecosystem or every price range.
Evidence includes the position ID, live quantities, runtime hash and block.
A changed runtime, ownership, approval, key or range fails closed. Earlier locker
hash `0xe00b...609` has not been reviewed and remains unapproved.

Pre-graduation curve reserves are not permanently locked LP. They have execution
diagnostics but remain blocked for portfolio entry under this liquidity policy.
GoPlus source/capability/tax/concentration gates remain mandatory and independent.
A passing lock proof cannot override missing token safety data or holder coverage.
Generic V3/V4 pools remain subject to their existing unverified-lock restrictions.

## Observable diagnostics and automation

Discovery now includes dedicated Pons curve and graduated-pool pages within the
existing shared rate budget/backoff. Up to one curve and one graduated market are
probed every 30 seconds, rotating candidates. These diagnostics may include pools
below the entry liquidity threshold; they are **never passed to the entry engine**.
The allocation/entry gates still apply separately and are not relaxed to force
trades. Diagnostic notional is 95% of a 2% slice of the first virtual balance.

Coverage records separately show security admission, Pons stage and last read-only
execution status, quantity, proceeds, estimated gas, recovery, entry-loss gate, block and timestamp. Diagnostics retain measured high-cost outcomes; the normal entry probe still rejects immediate round-trip losses above 3%. JSON,
HTML and pool CSV preserve this evidence. Simulation failures are not fictitious
transactions. A closed curve may be unavailable while another graduated pool is
successfully probed. Market observations, diagnostic quotes and booked portfolio
entries/exits are different counters.

The shared workflow concurrency group serializes old and new runs to prevent
competing report publishers. Completed reports remain available as run artifacts;
a fresh run starts new virtual balances. The optional `executionProfile: pons-v2`
report field identifies the integration without breaking older reports. Two virtual positions and 2%/4%
allocation limits remain unchanged. Standard runners and public APIs are used;
rate limits, delays and data gaps remain possible.

## Validation evidence

Read-only live calls on 2026-10-19 verified JACK curve
`0xece07852cbf4cd4191e4918e4636e51382701cb2` and HARMONIC V4 pool
`0x77ea11bbfb8f1259c702cb0ebc2105b7c007db89cf30c2f1a8776886a4467c07`.
Both measured approximately 98.01% immediate buy/sell recovery before gas, consistent
with two 1% trading legs. HARMONIC's exact-sale quote and the permanent seed proof
were read at block 92909125: position 1101805 owned by the pinned locker, with
29277002188455996998335 units of locked and active liquidity (100% active coverage).
These are state-specific observations, not executed trades or a profit backtest.

Tests cover fake identities/code, stage transitions and closed phases, real-ID
normalization, key/range/owner/approval/coverage mismatches, diagnostic isolation,
factory/pool monitoring, exact held quantities, curve fees, partial refunds and
closed sells on a local EVM. Runtime fixtures are public read-only bytecode data,
not contracts deployed to mainnet by the tests.
