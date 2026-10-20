import type { LiveBook, MarketPoint } from "./live-paper.ts";
import { PAPER_RISK, PAPER_ROTATION as R } from "./paper-risk.ts";

export type EntrySignal = {
  pool: string;
  status: "blocked" | "warming" | "confirming" | "ready";
  reason: string;
  score?: number;
  rise?: number;
  requiredRise?: number;
  costFraction?: number;
};
export function observedMomentum(
  history: NonNullable<LiveBook["prices"]>,
  id: string,
  now: number,
) {
  const ordered = history
    .filter((x) => x.id === id && x.at <= now && now - x.at <= R.historyMs)
    .sort((a, b) => a.at - b.at);
  // A gap invalidates the evidence before it, not the subsequent healthy
  // observations. Requiring the entire retained window to be gap-free can
  // keep a recovered feed warming for two minutes after it already collected
  // the required minute of new prices.
  let since = 0;
  for (let i = 1; i < ordered.length; i++)
    if (ordered[i].at - ordered[i - 1].at > 30_000) since = i;
  const h = ordered.slice(since);
  if (h.length < 4 || now - h[0].at < R.lookbackMs || now - h.at(-1)!.at > 10_000) return null;
  const last = h.at(-1)!,
    recent = h.find((x) => x.at >= now - R.confirmMs) ?? h[0];
  return {
    rise: last.price / h[0].price - 1,
    recentRise: last.price / recent.price - 1,
    drawdown: 1 - last.price / Math.max(...h.map((x) => x.price)),
  };
}
/** Validate a measured fill for THIS allocation, including cash reserved for exit. */
export function fillBudget(p: MarketPoint, budget: number, now: number) {
  const q = p.entryExitQuote,
    input = p.buyInputEth,
    gas = p.buyGasEth;
  if (
    !p.quantityRaw ||
    !/^\d+$/.test(p.quantityRaw) ||
    BigInt(p.quantityRaw) <= 0n ||
    !q ||
    q.pool !== p.id ||
    q.quantityRaw !== p.quantityRaw ||
    !/^\d+$/.test(q.block) ||
    q.block !== p.block ||
    q.fetchedAt > now ||
    now - q.fetchedAt > 10_000 ||
    ![q.receivedEth, q.gasEth, input, gas, budget].every((n) => Number.isFinite(n) && n! >= 0) ||
    !input ||
    budget <= 0
  )
    return null;
  const reserve = budget - input - gas!;
  if (reserve < q.gasEth) return null;
  const net = q.receivedEth + reserve - q.gasEth;
  if (net < budget * (1 - R.stopLoss)) return null;
  const cost = Math.max(0, input - q.receivedEth) + gas! + q.gasEth;
  return { reserve, net, cost, costFraction: cost / budget };
}
export function entrySignal(
  p: MarketPoint,
  history: NonNullable<LiveBook["prices"]>,
  budget: number,
  now: number,
): EntrySignal {
  const blocked = (reason: string): EntrySignal => ({ pool: p.id, status: "blocked", reason });
  if (
    p.security?.status !== "approved" ||
    p.security.token !== p.token ||
    p.security.liquidityBlock !== p.block ||
    p.security.checkedAt > now ||
    now - p.security.checkedAt > PAPER_RISK.maxSecurityAgeMs
  )
    return blocked("Token security or pool liquidity proof is missing, expired or rejected");
  if (!p.token || !p.factoryVerified || !p.roundTripOk || p.metadataFresh !== true)
    return blocked("Fresh metadata, canonical identity and full buy/sell execution required");
  if (!Number.isFinite(p.tvlUsd) || p.tvlUsd < R.minTvlUsd)
    return blocked("Liquidity below the paper spot minimum of $20,000");
  if (
    !Number.isFinite(p.reserveEth) ||
    p.reserveEth! <= 0 ||
    !Number.isFinite(p.buyInputEth) ||
    p.buyInputEth! > (p.reserveEth! / 2) * R.maxInputDepthFraction
  )
    return blocked("Buy exceeds 0.25% of executable funding depth");
  const fill = fillBudget(p, budget, now);
  if (!fill) return blocked("Exact sale, gas reserve or immediate position loss gate failed");
  if (fill.costFraction > R.maxEntryCostFraction)
    return {
      ...blocked(
        `Measured round-trip costs exceed ${(R.maxEntryCostFraction * 100).toFixed(1)}% of the position allocation`,
      ),
      costFraction: fill.costFraction,
      requiredRise: Math.max(R.minRise, R.costMargin * fill.costFraction),
    };
  const momentum = observedMomentum(history, p.id, now);
  if (!momentum)
    return {
      pool: p.id,
      status: "warming",
      reason: "Collecting 60 seconds of continuous canonical prices",
    };
  const requiredRise = Math.max(R.minRise, R.costMargin * fill.costFraction);
  const signal = {
    pool: p.id,
    rise: momentum.rise,
    requiredRise,
    costFraction: fill.costFraction,
    score: momentum.rise - R.costMargin * fill.costFraction,
  };
  if (momentum.drawdown > R.maxDrawdown)
    return { ...signal, status: "blocked", reason: "Price is over 1% below its observed high" };
  if (momentum.rise > R.maxRise)
    return {
      ...signal,
      status: "blocked",
      reason: "Observed price spike exceeds 15%; avoiding a late chase",
    };
  if (momentum.rise < requiredRise || momentum.recentRise <= 0)
    return {
      ...signal,
      status: "blocked",
      reason: `Observed rise ${(100 * momentum.rise).toFixed(2)}%; needs ${(100 * requiredRise).toFixed(2)}% with a positive recent trend after costs`,
    };
  return {
    ...signal,
    status: "confirming",
    reason: "Confirming a cost-covered trend for 30 seconds",
  };
}
