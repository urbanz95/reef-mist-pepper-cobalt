/** Shared by the real keeper and the paper simulator. All money is measured in ETH. */
export const POLICY = {
  riskIntervalMs: 15_000,
  maxDataAgeMs: 60_000,
  maxSchedulerGapMs: 45_000,
  confirmMs: 120_000,
  minObservations: 3,
  cooldownMs: 30 * 60_000,
  maxTradesPerDay: 4,
  minTvlUsd: 100_000,
  minPoolAgeMs: 7 * 86_400_000,
  stopLoss: 0.05,
  trailingLoss: 0.05,
  liquidityDrop: 0.3,
  horizonHours: 6,
  aprCap: 100,
  feeDiscount: 0.5,
  costMargin: 2,
} as const;

export type Candidate = {
  id: string;
  apr: number;
  tvlUsd: number;
  createdAt: number;
  reviewed: boolean;
  factoryVerified: boolean;
  roundTripOk: boolean;
  costEth: number;
};
export type PolicyState = {
  current: string | null;
  principalEth: number;
  highWaterEth: number;
  entryTvlUsd: number;
  lastTradeAt: number;
  trades: number[];
  challenger: string | null;
  challengerSince: number;
  observations: number;
  lastObservationAt: number;
  halted: boolean;
};
export type Observation = {
  now: number;
  fetchedAt: number;
  schedulerHealthy: boolean;
  pending: boolean;
  valueEth: number | null;
  currentApr: number;
  currentTvlUsd: number | null;
  sellable: boolean;
  candidates: Candidate[];
};
export type Decision = {
  action: "wait" | "enter" | "hop" | "exit" | "blocked";
  reason: string;
  target?: Candidate;
  state: PolicyState;
};
export function initialPolicy(principalEth: number): PolicyState {
  return {
    current: null,
    principalEth,
    highWaterEth: principalEth,
    entryTvlUsd: 0,
    lastTradeAt: 0,
    trades: [],
    challenger: null,
    challengerSince: 0,
    observations: 0,
    lastObservationAt: 0,
    halted: false,
  };
}
export function conservativeApr(apr: number) {
  return Number.isFinite(apr) ? Math.max(0, Math.min(POLICY.aprCap, apr)) * POLICY.feeDiscount : 0;
}
export function decide(previous: PolicyState, o: Observation): Decision {
  const s = { ...previous, trades: previous.trades.filter((t) => o.now - t < 86_400_000) };
  const result = (action: Decision["action"], reason: string, target?: Candidate): Decision => ({
    action,
    reason,
    target,
    state: s,
  });
  const reset = () => {
    s.challenger = null;
    s.observations = 0;
    s.challengerSince = 0;
  };
  if (o.pending) return result("blocked", "Transaction awaiting reconciliation");
  if (s.halted)
    return result(
      s.current &&
        o.sellable &&
        Number.isFinite(o.valueEth) &&
        o.valueEth !== null &&
        o.valueEth > 0
        ? "exit"
        : "blocked",
      "Risk stop latched; owner review required",
    );
  if (!Number.isFinite(o.valueEth) || o.valueEth === null || o.valueEth <= 0 || !o.sellable) {
    reset();
    return result("blocked", "Exit cannot be valued or simulated; no new exposure");
  }
  // Price risk is evaluated even if the pool feed or scheduler is unhealthy.
  if (
    s.current &&
    (o.valueEth <= s.principalEth * (1 - POLICY.stopLoss) ||
      o.valueEth <= s.highWaterEth * (1 - POLICY.trailingLoss))
  ) {
    s.halted = true;
    return result("exit", "ETH loss / trailing stop reached");
  }
  s.highWaterEth = Math.max(s.highWaterEth, o.valueEth);
  const fresh = o.fetchedAt <= o.now && o.now - o.fetchedAt <= POLICY.maxDataAgeMs;
  if (
    fresh &&
    s.current &&
    o.currentTvlUsd !== null &&
    s.entryTvlUsd > 0 &&
    o.currentTvlUsd <= s.entryTvlUsd * (1 - POLICY.liquidityDrop)
  ) {
    s.halted = true;
    return result("exit", "Pool liquidity dropped at least 30%");
  }
  if (!fresh || (s.current && o.currentTvlUsd === null)) {
    reset();
    return result("blocked", "Fresh pool data unavailable");
  }
  if (!o.schedulerHealthy) {
    reset();
    return result("blocked", "Continuous monitoring unavailable");
  }
  if (s.lastTradeAt && o.now - s.lastTradeAt < POLICY.cooldownMs) {
    reset();
    return result("wait", "Minimum holding period");
  }
  if (s.trades.length >= POLICY.maxTradesPerDay) {
    reset();
    return result("wait", "Daily trade limit");
  }
  const candidates = o.candidates.filter(
    (c) =>
      c.id !== s.current &&
      c.reviewed &&
      c.factoryVerified &&
      c.roundTripOk &&
      Number.isFinite(c.tvlUsd) &&
      c.tvlUsd >= POLICY.minTvlUsd &&
      c.createdAt > 0 &&
      o.now - c.createdAt >= POLICY.minPoolAgeMs &&
      Number.isFinite(c.costEth) &&
      c.costEth >= 0,
  );
  const edge = (c: Candidate) =>
    (((o.valueEth! * (conservativeApr(c.apr) - conservativeApr(s.current ? o.currentApr : 0))) /
      100) *
      POLICY.horizonHours) /
    (365 * 24);
  const best = candidates.sort((a, b) => edge(b) - b.costEth - (edge(a) - a.costEth))[0];
  if (!best || edge(best) <= best.costEth * POLICY.costMargin) {
    reset();
    return result("wait", "Estimated fees do not cover costs with a safety margin");
  }
  if (s.challenger !== best.id || o.now - s.lastObservationAt > POLICY.maxDataAgeMs) {
    s.challenger = best.id;
    s.challengerSince = o.now;
    s.observations = 0;
  }
  // Repeated HTTP requests in the same interval cannot manufacture confirmation.
  if (o.now - s.lastObservationAt >= POLICY.riskIntervalMs) s.observations++;
  s.lastObservationAt = o.now;
  if (s.observations < POLICY.minObservations || o.now - s.challengerSince < POLICY.confirmMs) {
    return result("wait", "Confirming persistent opportunity");
  }
  return result(s.current ? "hop" : "enter", "Conservative estimated fees exceed costs", best);
}
/** Applied only after a successful receipt, never merely after broadcasting. */
export function settled(s: PolicyState, d: Decision, at: number, valueEth: number): PolicyState {
  if (d.action === "exit") return { ...s, current: null, halted: true, challenger: null };
  if (!d.target) throw new Error("Missing confirmed target");
  return {
    ...s,
    current: d.target.id,
    entryTvlUsd: d.target.tvlUsd,
    lastTradeAt: at,
    trades: [...s.trades, at],
    challenger: null,
    observations: 0,
    highWaterEth: Math.max(s.highWaterEth, valueEth),
  };
}
