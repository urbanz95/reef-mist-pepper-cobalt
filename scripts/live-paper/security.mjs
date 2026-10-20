import { parseAbi } from "viem";
import { BURN_ADDRESSES, assessTokenSecurity } from "../../src/lib/paper-risk.ts";
import { isPons } from "../../src/lib/paper-venues.ts";
import { ponsLiquidityProtection } from "./pons-market.mjs";
const abi = parseAbi([
  "function totalSupply() view returns(uint256)",
  "function balanceOf(address) view returns(uint256)",
]);
export { createSecurityProvider } from "./security-provider.mjs";
export async function liquidityProtection(client, pool, block) {
  if (pool.dex !== "uniswap-v2-robinhood")
    return {
      status: "unknown",
      reason:
        "Pool-specific V3/V4 position ownership and withdrawal permissions not fully verified",
    };
  try {
    const call = (functionName, args = []) =>
      client.readContract({
        address: pool.id,
        abi,
        functionName,
        args,
        blockNumber: BigInt(block),
      });
    const [supply, ...burned] = await Promise.all([
      call("totalSupply"),
      ...BURN_ADDRESSES.map((a) => call("balanceOf", [a])),
    ]);
    if (supply <= 0n) return { status: "unknown", reason: "LP supply unavailable" };
    const amount = burned.reduce((a, b) => a + b, 0n);
    if (amount > supply) return { status: "unknown", reason: "Invalid LP burn accounting" };
    const fraction = Number(amount) / Number(supply);
    const protectedLp = amount * 100n >= supply * 95n;
    return {
      status: protectedLp ? "approved" : "rejected",
      fraction,
      reason: protectedLp
        ? "At least 95% of canonical V2 LP supply is at burn addresses"
        : "Less than 95% of canonical V2 LP supply is provably burned; locker contracts require a verified adapter",
    };
  } catch {
    return { status: "unknown", reason: "LP ownership proof unavailable" };
  }
}
export async function assessPoolSecurity(client, pool, snapshot, provider, now = Date.now()) {
  const row = provider.get(pool.other);
  const providerData = provider.dataStatus?.(pool.other, now);
  let lp;
  try {
    lp = isPons(pool.dex)
      ? await ponsLiquidityProtection(client, pool, snapshot)
      : await liquidityProtection(client, pool, snapshot.block);
  } catch (e) {
    lp = {
      status: "unknown",
      reason: `Pons identity/liquidity proof unavailable: ${(e.shortMessage ?? e.message).slice(0, 220)}`,
    };
  }
  const assessment = assessTokenSecurity(row?.raw, pool, row?.checkedAt ?? 0, now, {
    ...lp,
    fraction: isPons(pool.dex) ? undefined : lp.fraction,
    // The reviewed Pons locker has no outgoing token/NFT transfer path. Its
    // permanently held tokens cannot be sold by a whale; provider lock tags
    // alone never establish this exclusion.
    permanentHolders:
      isPons(pool.dex) && lp.status === "approved" && lp.evidence?.locker
        ? [lp.evidence.locker.toLowerCase()]
        : [],
  });
  if (providerData && providerData.status !== "available") {
    const reasons = {
      not_requested: "Token security not requested; outside the active screening budget",
      pending: "Token security request queued; no token-specific response received yet",
      missing: "Security provider returned no record for this token",
      error: `Token security request failed: ${providerData.detail}`,
      stale: "Token security response expired; awaiting a fresh token-specific response",
    };
    assessment.reasons = assessment.reasons.map((r) =>
      r === "Token security data missing or expired" ? reasons[providerData.status] : r,
    );
  }
  return {
    ...assessment,
    providerData,
    liquidityBlock: snapshot.block,
    liquidityKind: isPons(pool.dex) ? "pons-permanent-seed" : "burned-lp",
    protectedLiquidityFraction: lp.fraction,
    liquidityEvidence: lp.evidence,
  };
}
