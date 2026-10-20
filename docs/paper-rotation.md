# Paper opportunity rotation

The 20 October overnight run 39344994071 opened no positions. Its spot engine
inherited the live LP keeper's $100,000 TVL floor, required two consecutive
two-minute confirmation periods, stopped all future entries after an ordinary
price loss, and could not evaluate replacements while both slots were occupied.
GoPlus also omitted owner and `cannot_sell_all` fields for a verifiable Pons token
template and attributed creation to a deployment helper rather than its issuer.

`rotation-v1` changes the **virtual guarded spot experiment**. Live keeper APR,
contract addresses, wallet permissions and funded execution are unchanged. No
real-money trading is authorized or enabled by this profile.

## Admission and selection

- The paper TVL floor is $20,000, with an additional measured buy limit of 0.25%
  of executable funding depth. Costs include both gas legs, pool fees and impact;
  costs above 2.5% of allocation or an immediate 3% liquidation loss block entry.
  The 2.5% ceiling accommodates observed Pons fees near 2% before gas; it does
  not make such trades economically attractive on its own.
- At least 60 seconds of continuous prices plus 30 seconds of persistent signal
  are required. The rise must exceed max(0.3%, 1.5 times measured costs/allocation),
  recent momentum must remain positive, and a 1% drawdown or >15% spike blocks it.
  A gap over 30 seconds in a candidate's prices resets its signal history.
- Rank supported routes by recent volume and turnover rather than newest creation
  time. Four leaders and two rotating research slots keep a three-minute window;
  one token occupies one entry slot. The six-source discovery budget now includes
  two pages of graduated Pons pools as well as new pools, curves, V2 and trending.
  No minimum pool age is added.
- Existing fresh security, tax, concentration, canonical identity, permanent LP,
  monitored-chain and isolated exact-quantity sale requirements remain mandatory.

These are observed trend signals, not calibrated probabilities or predictions.
No parameter ensures activity or profitability in a flat or unsafe market.

## Pons token evidence

The [Sourcify record](https://sourcify.dev/server/v2/contract/4663/0xdee52f2ab639b6942b0d0f0565400b93b7a0fbe5?fields=all)
contains `contracts/src/v2/PonsV2LauncherToken.sol` and its OpenZeppelin 5.x
dependencies, compiled with solc 0.8.35, viaIR, optimizer 200, Cancun. The reviewed
token inherits standard `ERC20` and `ERC20Burnable`; it mints only in its constructor.
Its other methods expose immutable deployment addresses and metadata. It has no
Ownable/admin entry point, proxy/delegatecall, post-construction mint, mutable tax,
blacklist or transfer override. `burnFrom` still requires a holder allowance.

The on-chain 3,248-byte runtime matches the verified executable code. Its template
hash is `0xfaa55f9f9b0db66181468400d0609ed9b9499520e5c0dbb04561042781ef391f`
after normalizing **only** compiler-declared 32-byte immutable offsets 379/529
(deployer), 1094 (curve) and 1357 (factory). The metadata bytes remain pinned.
The recompiled runtime has different CBOR metadata, so its metadata is not used
as an allowlist; the actual chain runtime and its executable correspondence are
retained in the public fixture. Every immutable must equal the independently
verified factory record. Every other byte, code length or changed immutable fails.
Verified HARMONIC, CROPZ and KOLSHI runtimes matched this template during development.

The adapter is used only with verified Pons registration/factory/hook and approved
permanent LP protection. At the quote block it reads the **actual immutable issuer's**
token balance and total supply; issuer holdings must still be <=1%. For this exact
template it can resolve an absent owner as no administrative owner and an absent
`cannot_sell_all` flag as standard full-balance transfers. Explicit positive GoPlus
flags, unknown holder data, excessive concentration and failed sales still block.
A failing owner getter or a Pons label alone never provides these proofs.

This is a narrow runtime adapter with reviewed source, not a general token audit
or a claim that issuer wallets and market manipulation have been fully traced.

## Exits, rotation and accounting

The 2% allocation per position and 4% combined allocation at entry remain. Both
slots stay monitored while new candidates are evaluated. Each position retains
its own exact quantity, ETH gas reserve, high water, entry time and ledger.

Net profit 1%, loss 3%, trailing loss 2%, depth fall 30% and structural alerts
request exits. Non-profitable stalled momentum can close after five minutes, and
exposure is limited to 15 minutes. An ordinary price stop applies a 30-minute
token cooldown. Other closes cool the token for ten minutes. Structural failures,
monitoring gaps, unpayable exit gas and a 1% portfolio loss latch new entries.

With two positions open, a confirmed candidate can replace the weakest observed
trend after at least two minutes held. Its advantage must exceed holding momentum,
measured target costs, held exit gas and a further 0.3% switching margin. Both
the held sale and the proposed buy must be freshly executable and fit the resulting
allocation **before** closing anything. The ledger records separate exit and entry,
each gas leg once; neither operation fabricates a transaction receipt. Unknown
sales preserve the open position and unknown valuation. Six entries per rolling
hour and 24 per day limit churn; exits remain available at the entry limit.

Reports identify `rotation-v1`, preserve the policy and per-balance signal reasons,
observed/required rise and measured costs. JSON, HTML and `signals.csv` expose these
alongside positions, timestamps, durations and net PnL. Checkpoint restoration
requires a matching strategy version and reconciled balances; previous run results
are never silently reinterpreted.

## Validation scope

Regression tests exercise 90-second entry, insufficient depth and costs, flat and
spiking markets, gaps, independent price stops, full-slot rotation, rejected
switching costs, unavailable sales, timeout/profit accounting, hourly entry limits,
portfolio loss and bytecode mutation/identity binding. Local EVM tests and live
read-only probes complement these deterministic scenarios. None establishes future
profitability. A subsequent forward test must record actual hypothetical portfolio
entries and exact-quantity exits before market performance can be assessed.
