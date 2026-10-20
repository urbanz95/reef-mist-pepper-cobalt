export const PAPER_RISK = {
  positionFraction: 0.02,
  maxPositions: 2,
  maxCommittedFraction: 0.04,
  maxSecurityAgeMs: 60000,
  minBurnedLp: 0.95,
  maxHolder: 0.05,
  maxTopHolders: 0.2,
  maxIssuer: 0.01,
} as const;
/** Paper spot parameters are independent of the live LP keeper's APR policy. */
export const PAPER_ROTATION = {
  version: "rotation-v2",
  minTvlUsd: 20_000,
  historyMs: 120_000,
  lookbackMs: 60_000,
  confirmMs: 30_000,
  minObservations: 3,
  minRise: 0.003,
  costMargin: 1.5,
  maxEntryCostFraction: 0.01,
  maxInputDepthFraction: 0.0025,
  maxDrawdown: 0.01,
  maxRise: 0.15,
  stopLoss: 0.03,
  trailingLoss: 0.02,
  profit: 0.01,
  minHoldMs: 120_000,
  stagnantMs: 5 * 60_000,
  maxHoldMs: 15 * 60_000,
  rotationMargin: 0.003,
  cooldownMs: 10 * 60_000,
  lossCooldownMs: 30 * 60_000,
  maxTradesPerDay: 24,
  maxTradesPerHour: 6,
  portfolioLossFraction: 0.01,
} as const;
export type SecurityAssessment = {
  token: string;
  liquidityBlock?: string;
  status: "approved" | "rejected" | "unknown";
  checkedAt: number;
  reasons: string[];
  actors: string[];
  source: string;
  burnedLpFraction?: number;
  liquidityKind?: string;
  protectedLiquidityFraction?: number;
};
export type ExitQuote = {
  pool: string;
  quantityRaw: string;
  receivedEth: number;
  gasEth: number;
  fetchedAt: number;
  block: string;
};
export type GuardedPosition = {
  id: string;
  pool: string;
  token: string;
  label: string;
  quantityRaw: string;
  allocationEth: number;
  inputEth: number;
  entryGasEth: number;
  exitReserveEth: number;
  entryAt: number;
  entryBlock: string;
  entryDepthEth: number;
  highWaterEth: number;
  markedValueEth: number | null;
  actors: string[];
  exitRequested?: string;
  lastQuoteAt?: number;
};
export type RiskAlert = {
  pool?: string;
  token?: string;
  reason: string;
  block: string;
  transactionHash?: string;
};
export type GuardedContext = {
  /** Canonical on-chain observations are research data, never entry approval. */
  priceObservations?: { id: string; at: number; price: number; block: string }[];
  exitQuotes?: ExitQuote[];
  alerts?: RiskAlert[];
  monitorHealthy?: boolean;
};
const ZERO = "0x" + "00".repeat(20),
  DEAD = "0x" + "0".repeat(36) + "dead";
export const BURN_ADDRESSES = [ZERO, DEAD];
export function positionBudget(
  initial: number,
  equity: number | null,
  cash: number,
  positions: GuardedPosition[],
) {
  if (equity === null || !Number.isFinite(equity)) return 0;
  const base = Math.min(initial, equity),
    committed = positions.reduce((n, p) => n + p.allocationEth, 0);
  return Math.max(
    0,
    Math.min(
      base * PAPER_RISK.positionFraction,
      base * PAPER_RISK.maxCommittedFraction - committed,
      cash,
    ),
  );
}
const address = (x: unknown) =>
  typeof x === "string" && /^0x[0-9a-f]{40}$/i.test(x) ? x.toLowerCase() : null;
/** Explicit provider negatives are required; missing fields never mean safe. */
export function assessTokenSecurity(
  raw: any,
  pool: { id: string; other: string },
  checkedAt: number,
  now: number,
  liquidity: { status: string; fraction?: number; reason: string; permanentHolders?: string[] },
): SecurityAssessment {
  const rejected: string[] = [],
    unknown: string[] = [],
    actors: string[] = [];
  if (
    !raw ||
    !Number.isFinite(checkedAt) ||
    checkedAt > now ||
    now - checkedAt > PAPER_RISK.maxSecurityAgeMs
  )
    return {
      status: liquidity.status === "rejected" ? "rejected" : "unknown",
      token: pool.other,
      checkedAt,
      reasons: [
        "Token security data missing or expired",
        ...(liquidity.status !== "approved" ? [liquidity.reason] : []),
      ],
      burnedLpFraction: liquidity.fraction,
      actors,
      source: "GoPlus + on-chain LP",
    };
  if (raw.is_open_source !== "1")
    (raw.is_open_source === "0" ? rejected : unknown).push("Verified contract source unavailable");
  for (const flag of [
    "is_proxy",
    "is_mintable",
    "hidden_owner",
    "owner_change_balance",
    "can_take_back_ownership",
    "selfdestruct",
    "external_call",
    "slippage_modifiable",
    "personal_slippage_modifiable",
    "transfer_pausable",
    "is_blacklisted",
    "is_whitelisted",
    "is_honeypot",
    "cannot_buy",
    "cannot_sell_all",
    "honeypot_with_same_creator",
  ]) {
    if (raw[flag] === "1") rejected.push(`Contract risk: ${flag}`);
    else if (raw[flag] !== "0") unknown.push(`Unknown contract capability: ${flag}`);
  }
  for (const tax of ["buy_tax", "sell_tax", "transfer_tax"]) {
    const n = typeof raw[tax] === "string" && raw[tax].trim() !== "" ? Number(raw[tax]) : NaN;
    if (!Number.isFinite(n) || n < 0) unknown.push(`Unknown ${tax}`);
    else if (n > 0) rejected.push(`Transfer/trading tax: ${tax}`);
  }
  const creator = address(raw.creator_address),
    owner = address(raw.owner_address);
  if (!creator) unknown.push("Creator identity unknown");
  if (!owner) unknown.push("Owner identity unknown");
  for (const a of [creator, owner]) if (a && !BURN_ADDRESSES.includes(a)) actors.push(a);
  const issuerShares = [raw.creator_percent, raw.owner_percent].map((x) =>
    typeof x === "string" && x.trim() !== "" ? Number(x) : NaN,
  );
  if (issuerShares.some((n) => !Number.isFinite(n) || n < 0 || n > 1))
    unknown.push("Issuer concentration unknown");
  else if (
    (creator === owner ? Math.max(...issuerShares) : issuerShares.reduce((a, b) => a + b, 0)) >
    PAPER_RISK.maxIssuer
  )
    rejected.push("Issuer holdings exceed 1%");
  const count = Number(raw.holder_count),
    holders = raw.holders;
  if (
    !Number.isInteger(count) ||
    count < 20 ||
    !Array.isArray(holders) ||
    holders.length < Math.min(10, count)
  )
    unknown.push("Top-holder coverage incomplete");
  else {
    const excluded = new Set([
        ...BURN_ADDRESSES,
        pool.id.toLowerCase(),
        "0x8366a39cc670b4001a1121b8f6a443a643e40951",
        ...(liquidity.status === "approved" ? (liquidity.permanentHolders ?? []) : []),
      ]),
      totals = new Map<string, number>();
    for (const h of holders) {
      const a = address(h.address),
        p = typeof h.percent === "string" && h.percent.trim() !== "" ? Number(h.percent) : NaN;
      if (!a || !Number.isFinite(p) || p < 0 || p > 1) {
        unknown.push("Malformed holder distribution");
        continue;
      }
      if (!excluded.has(a)) totals.set(a, (totals.get(a) ?? 0) + p);
    }
    const sorted = [...totals].sort((a, b) => b[1] - a[1]);
    if (sorted.some(([, p]) => p > PAPER_RISK.maxHolder))
      rejected.push("A non-pool holder exceeds 5%");
    if (sorted.reduce((n, [, p]) => n + p, 0) > PAPER_RISK.maxTopHolders)
      rejected.push("Observed top holders exceed 20%");
    actors.push(...sorted.slice(0, 3).map(([a]) => a));
  }
  if (liquidity.status !== "approved")
    (liquidity.status === "rejected" ? rejected : unknown).push(liquidity.reason);
  return {
    token: pool.other,
    status: rejected.length ? "rejected" : unknown.length ? "unknown" : "approved",
    checkedAt,
    reasons: [...new Set([...rejected, ...unknown])],
    actors: [...new Set(actors)],
    source: "GoPlus + on-chain LP",
    burnedLpFraction: liquidity.fraction,
  };
}
