import type { LiveBook, MarketPoint } from "./live-paper.ts";
import { POLICY, type Decision } from "./degen-policy.ts";
import { recordPaperTrade } from "./paper-ledger.ts";
export const LAUNCH_POLICY = {
  confirmMs: 120000,
  historyMs: 180000,
  minRise: 0.005,
  maxDrawdown: 0.01,
  stopLoss: 0.03,
  trailingLoss: 0.02,
  profit: 0.01,
  maxHoldMs: 30 * 60000,
} as const;
/** Experimental spot trading. Past momentum is an admission signal, not expected profit. */
export function stepLaunchBook(previous: LiveBook, points: MarketPoint[], now: number) {
  const book: LiveBook = {
    ...previous,
    state: { ...previous.state, trades: previous.state.trades.filter((t) => now - t < 86400000) },
    position: previous.position ? { ...previous.position } : null,
  };
  const fresh = points.filter(
    (p) =>
      p.fetchedAt <= now &&
      now - p.fetchedAt <= POLICY.maxDataAgeMs &&
      Number.isFinite(p.priceEth) &&
      p.priceEth > 0,
  );
  const current = book.position ? fresh.find((p) => p.id === book.position!.pool) : null;
  const monitoring =
    previous.lastAt > 0 &&
    now - previous.lastAt > 0 &&
    now - previous.lastAt <= POLICY.maxSchedulerGapMs;
  const history = monitoring
    ? (previous.prices ?? []).filter((p) => now - p.at <= LAUNCH_POLICY.historyMs)
    : [];
  book.prices = [...history, ...fresh.map((p) => ({ id: p.id, at: now, price: p.priceEth }))];
  let value: number | null = book.position
    ? current?.roundTripOk
      ? ((book.position.principal * current.priceEth) / book.position.entryPrice) *
        Math.min(1, (current.executionRecovery ?? 1) / (book.position.recoveryAtEntry ?? 1))
      : null
    : book.cash;
  let action: Decision["action"] = "wait",
    reason = "Launch: awaiting observed momentum above execution costs",
    target: MarketPoint | undefined;
  let risk = false;
  if (book.position) {
    if (value === null || !current) {
      action = "blocked";
      reason = "Launch: exit unavailable; valuation unknown";
    } else {
      book.state.highWaterEth = Math.max(book.state.highWaterEth, value);
      const basis = book.entryAccountValue ?? book.initial;
      const depthDrop = !!(
        book.position.reserveEthAtEntry &&
        current.reserveEth &&
        current.reserveEth <= book.position.reserveEthAtEntry * (1 - POLICY.liquidityDrop)
      );
      if (
        value <= basis * (1 - LAUNCH_POLICY.stopLoss) ||
        value <= book.state.highWaterEth * (1 - LAUNCH_POLICY.trailingLoss) ||
        depthDrop
      ) {
        action = "exit";
        reason = depthDrop
          ? "Launch: executable depth dropped 30%"
          : "Launch: loss / trailing stop";
        risk = true;
      } else if (
        value - current.exitCostEth >=
        basis + Math.max(basis * LAUNCH_POLICY.profit, current.costEth * 2)
      ) {
        action = "exit";
        reason = "Launch: net profit target";
      } else if (now - (book.enteredAt ?? now) >= LAUNCH_POLICY.maxHoldMs) {
        action = "exit";
        reason = "Launch: 30-minute exposure limit";
      } else reason = "Launch: monitoring open spot position";
    }
  } else if (book.state.halted) {
    action = "blocked";
    reason = "Launch: risk stop latched; review required";
  } else if (!monitoring) {
    action = "blocked";
    reason = "Continuous monitoring unavailable";
  } else if (book.state.lastTradeAt && now - book.state.lastTradeAt < POLICY.cooldownMs)
    reason = "Launch: cooldown";
  else if (book.state.trades.length >= POLICY.maxTradesPerDay) reason = "Daily trade limit";
  else {
    const eligible = fresh
      .flatMap((p) => {
        if (
          !p.reviewed ||
          !p.factoryVerified ||
          !p.roundTripOk ||
          p.metadataFresh === false ||
          !Number.isFinite(p.tvlUsd) ||
          p.tvlUsd < POLICY.minTvlUsd ||
          !Number.isFinite(p.costEth) ||
          p.costEth < 0 ||
          !Number.isFinite(p.entryCostEth) ||
          !Number.isFinite(p.exitCostEth) ||
          p.entryCostEth < 0 ||
          p.exitCostEth < 0 ||
          p.entryCostEth + p.exitCostEth >= book.cash
        )
          return [];
        const h = history.filter((h) => h.id === p.id);
        if (h.length < 3 || now - h[0].at < LAUNCH_POLICY.confirmMs) return [];
        const rise = p.priceEth / h[0].price - 1;
        if (
          rise < Math.max(LAUNCH_POLICY.minRise, (2 * p.costEth) / book.cash) ||
          p.priceEth < Math.max(...h.map((h) => h.price)) * (1 - LAUNCH_POLICY.maxDrawdown)
        )
          return [];
        return [{ p, score: rise - (2 * p.costEth) / book.cash }];
      })
      .sort((a, b) => b.score - a.score);
    const best = eligible[0]?.p;
    if (best) {
      if (
        book.state.challenger !== best.id ||
        now - book.state.lastObservationAt > POLICY.maxDataAgeMs
      ) {
        book.state.challenger = best.id;
        book.state.challengerSince = now;
        book.state.observations = 0;
      }
      if (now - book.state.lastObservationAt >= POLICY.riskIntervalMs) book.state.observations++;
      book.state.lastObservationAt = now;
      reason = "Launch: confirming persistent momentum";
      if (
        book.state.observations >= POLICY.minObservations &&
        now - book.state.challengerSince >= LAUNCH_POLICY.confirmMs
      ) {
        action = "enter";
        target = best;
        reason = "Launch: observed momentum and executable round trip confirmed";
      }
    } else book.state = { ...book.state, challenger: null, observations: 0, challengerSince: 0 };
  }
  if (!monitoring || action === "blocked") {
    book.state.challenger = null;
    book.state.observations = 0;
    book.state.challengerSince = 0;
  }
  let charged = 0;
  if (action === "exit" && value !== null && current) {
    charged = Math.min(value, current.exitCostEth);
    value -= charged;
    book.cash = value;
    book.position = null;
    book.state = {
      ...book.state,
      current: null,
      halted: risk,
      lastTradeAt: now,
      challenger: null,
      observations: 0,
    };
  } else if (action === "enter" && target && value !== null) {
    const basis = value;
    charged = Math.min(value, target.entryCostEth);
    value -= charged;
    book.position = {
      pool: target.id,
      entryPrice: target.priceEth,
      principal: value,
      fees: 0,
      reserveEthAtEntry: target.reserveEth,
      recoveryAtEntry: target.executionRecovery,
    };
    book.cash = 0;
    book.enteredAt = now;
    book.entryAccountValue = basis;
    book.state = {
      ...book.state,
      current: target.id,
      principalEth: basis,
      highWaterEth: basis,
      entryTvlUsd: target.tvlUsd,
      lastTradeAt: now,
      trades: [...book.state.trades, now],
      challenger: null,
      observations: 0,
    };
  }
  const decision: Decision = { action, reason, target, state: book.state };
  book.costs += charged;
  book.value = value;
  book.lastAt = now;
  book.ledger = recordPaperTrade(
    previous.ledger ?? [],
    book.initial,
    action,
    now,
    value,
    book.fees,
    target,
    previous.value ?? previous.initial,
    current?.exitCostEth ?? 0,
    reason,
  );
  return { book, decision, charged };
}
