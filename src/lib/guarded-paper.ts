import type { LiveBook, MarketPoint } from "./live-paper.ts";
import {
  PAPER_RISK,
  positionBudget,
  type GuardedPosition,
  type GuardedContext,
  type ExitQuote,
} from "./paper-risk.ts";
import { LAUNCH_POLICY } from "./launch-paper.ts";
import { POLICY, type Decision } from "./degen-policy.ts";
const quoteFor = (q: ExitQuote[], p: GuardedPosition, now: number) =>
  q.find(
    (x) =>
      x.pool === p.pool &&
      x.quantityRaw === p.quantityRaw &&
      x.fetchedAt <= now &&
      now - x.fetchedAt <= 10000 &&
      /^\d+$/.test(x.block) &&
      BigInt(x.block) >= BigInt(p.entryBlock) &&
      Number.isFinite(x.receivedEth) &&
      x.receivedEth >= 0 &&
      Number.isFinite(x.gasEth) &&
      x.gasEth >= 0,
  );
const approved = (p: MarketPoint, now: number) =>
  p.security?.status === "approved" &&
  p.security.token === p.token &&
  p.security.liquidityBlock === p.block &&
  p.security.checkedAt <= now &&
  now - p.security.checkedAt <= PAPER_RISK.maxSecurityAgeMs;
/** Restored balances must reconcile. A damaged checkpoint must never reset risk. */
export function validateGuardedCheckpoint(book: LiveBook) {
  const positions = book.positions,
    ledger = book.ledger ?? [];
  const fail = () => {
    throw new Error("Guarded checkpoint accounting mismatch; review required");
  };
  if (
    book.portfolioVersion !== 2 ||
    !positions ||
    positions.length > 2 ||
    !Number.isFinite(book.cash) ||
    book.cash < 0 ||
    book.strategy !== "guarded"
  )
    fail();
  for (const p of positions!) {
    if (
      !/^\d+$/.test(p.quantityRaw) ||
      BigInt(p.quantityRaw) <= 0n ||
      !/^\d+$/.test(p.entryBlock) ||
      !Array.isArray(p.actors)
    )
      fail();
    if (
      ![
        p.allocationEth,
        p.inputEth,
        p.entryGasEth,
        p.exitReserveEth,
        p.highWaterEth,
        p.entryAt,
        p.entryDepthEth,
      ].every((n) => Number.isFinite(n) && n >= 0) ||
      p.allocationEth <= 0 ||
      p.allocationEth > book.initial * 0.02 + 1e-12 ||
      Math.abs(p.inputEth + p.entryGasEth + p.exitReserveEth - p.allocationEth) > 1e-12
    )
      fail();
    if (p.markedValueEth !== null && (!Number.isFinite(p.markedValueEth) || p.markedValueEth < 0))
      fail();
    const match = ledger.filter(
      (t) => t.id === p.id && !t.exitAt && t.pool === p.pool && t.quantityRaw === p.quantityRaw,
    );
    if (match.length !== 1) fail();
  }
  if (
    new Set(positions!.map((p) => p.token)).size !== positions!.length ||
    ledger.filter((t) => !t.exitAt).length !== positions!.length
  )
    fail();
  const realized = ledger.filter((t) => t.exitAt).reduce((n, t) => n + (t.pnlEth ?? NaN), 0);
  const expected = book.initial + realized - positions!.reduce((n, p) => n + p.allocationEth, 0);
  if (!Number.isFinite(expected) || Math.abs(expected - book.cash) > 1e-10) fail();
  const value = positions!.some((p) => p.markedValueEth === null)
    ? null
    : book.cash + positions!.reduce((n, p) => n + p.markedValueEth!, 0);
  if (
    value === null
      ? book.value !== null
      : book.value === null || Math.abs(value - book.value) > 1e-10
  )
    fail();
}
/** Two independently valued spot positions, cash reserve and exact-quantity exit quotes. */
export function stepGuardedBook(
  previous: LiveBook,
  points: MarketPoint[],
  now: number,
  context: GuardedContext = {},
) {
  if (previous.portfolioVersion !== 2 || !previous.positions)
    throw new Error(
      "Guarded portfolio checkpoint missing; refusing to reinterpret an all-in legacy book",
    );
  const b: LiveBook = {
    ...previous,
    positions: previous.positions.map((p) => ({ ...p, actors: [...p.actors] })),
    state: { ...previous.state, trades: previous.state.trades.filter((t) => now - t < 86400000) },
    ledger: (previous.ledger ?? []).map((t) => ({ ...t })),
    challenges: { ...previous.challenges },
    tokenCooldowns: { ...previous.tokenCooldowns },
  };
  const events: {
    action: Decision["action"];
    reason: string;
    target?: MarketPoint;
    pool?: string;
    chargedEth: number;
  }[] = [];
  const fresh = points.filter(
    (p) =>
      p.fetchedAt <= now &&
      now - p.fetchedAt <= 10000 &&
      Number.isFinite(p.priceEth) &&
      p.priceEth > 0,
  );
  const monitoring =
    previous.lastAt > 0 &&
    now - previous.lastAt > 0 &&
    now - previous.lastAt <= POLICY.maxSchedulerGapMs &&
    context.monitorHealthy === true;
  const history = monitoring
    ? (previous.prices ?? []).filter((h) => now - h.at <= LAUNCH_POLICY.historyMs)
    : [];
  b.prices = [...history, ...fresh.map((p) => ({ id: p.id, at: now, price: p.priceEth }))];
  const retained: GuardedPosition[] = [];
  for (const p of b.positions!) {
    const market = fresh.find((x) => x.id === p.pool),
      quote = quoteFor(context.exitQuotes ?? [], p, now);
    const alert = context.alerts?.find((a) => a.pool === p.pool || a.token === p.token);
    if (alert) p.exitRequested = `Risk event: ${alert.reason}`;
    if (market?.security?.status === "rejected")
      p.exitRequested = "Security assessment deteriorated";
    if (context.monitorHealthy !== true) p.exitRequested = "Block monitoring unavailable";
    if (!monitoring && now - previous.lastAt > POLICY.maxSchedulerGapMs)
      p.exitRequested = "Continuous monitoring gap";
    if (p.exitRequested) b.state.halted = true;
    const depthDrop = !!(
      market?.reserveEth &&
      p.entryDepthEth > 0 &&
      market.reserveEth <= p.entryDepthEth * (1 - POLICY.liquidityDrop)
    );
    if (depthDrop) p.exitRequested = "Executable liquidity dropped 30%";
    if (p.exitRequested) b.state.halted = true;
    if (!quote) {
      p.markedValueEth = null;
      retained.push(p);
      const trade = b.ledger!.find((t) => t.id === p.id)!;
      trade.valueEth = null;
      trade.pnlEth = null;
      trade.durationSec = Math.max(0, (now - p.entryAt) / 1000);
      events.push({
        action: "blocked",
        reason: p.exitRequested
          ? `Exit requested but exact-quantity sale unavailable: ${p.exitRequested}`
          : "Exact-quantity sale unavailable; position value unknown",
        pool: p.pool,
        chargedEth: 0,
      });
      continue;
    }
    const net = Math.max(0, quote.receivedEth + p.exitReserveEth - quote.gasEth);
    p.markedValueEth = net;
    p.lastQuoteAt = quote.fetchedAt;
    p.highWaterEth = Math.max(p.highWaterEth, net);
    const loss =
      net <= p.allocationEth * (1 - LAUNCH_POLICY.stopLoss) ||
      net <= p.highWaterEth * (1 - LAUNCH_POLICY.trailingLoss);
    const profit = net >= p.allocationEth * (1 + LAUNCH_POLICY.profit);
    const timed = now - p.entryAt >= LAUNCH_POLICY.maxHoldMs;
    const risk = !!p.exitRequested || loss;
    const reason =
      p.exitRequested ??
      (loss
        ? "Position loss / trailing stop"
        : profit
          ? "Position net profit target"
          : timed
            ? "30-minute exposure limit"
            : null);
    const trade = b.ledger!.find((t) => t.id === p.id)!;
    trade.valueEth = net;
    trade.pnlEth = net - p.allocationEth;
    trade.durationSec = Math.max(0, (now - p.entryAt) / 1000);
    if (reason) {
      if (risk) b.state.halted = true;
      // An exit is only settled when its gas fits the reserved ETH. Unknown funding
      // requirements must not silently spend the rest of the portfolio.
      if (quote.gasEth > p.exitReserveEth) {
        p.exitRequested = reason;
        retained.push(p);
        events.push({
          action: "blocked",
          reason: "Exit gas exceeds the position reserve; review required",
          pool: p.pool,
          chargedEth: 0,
        });
        continue;
      }
      b.cash += net;
      b.costs += quote.gasEth;
      trade.exitAt = new Date(now).toISOString();
      trade.exitReason = reason;
      trade.costsEth += quote.gasEth;
      b.tokenCooldowns![p.token] = now;
      if (risk) b.state.halted = true;
      events.push({ action: "exit", reason, pool: p.pool, chargedEth: quote.gasEth });
    } else retained.push(p);
  }
  b.positions = retained;
  const unknown = retained.some((p) => p.markedValueEth === null);
  let equity = unknown ? null : b.cash + retained.reduce((n, p) => n + p.markedValueEth!, 0);
  const budget = positionBudget(b.initial, equity, b.cash, retained);
  let waitReason = b.state.halted
    ? "Portfolio risk stop latched"
    : !monitoring
      ? "Continuous block monitoring unavailable"
      : unknown
        ? "Open position valuation unknown"
        : budget <= 0
          ? "No available position budget"
          : "No security-approved, cost-covered momentum signal";
  if (
    !b.state.halted &&
    monitoring &&
    !unknown &&
    retained.length < PAPER_RISK.maxPositions &&
    b.state.trades.length < POLICY.maxTradesPerDay
  ) {
    const candidates = fresh
      .flatMap((p) => {
        if (
          !approved(p, now) ||
          !p.token ||
          !p.factoryVerified ||
          !p.roundTripOk ||
          p.metadataFresh !== true ||
          p.tvlUsd < POLICY.minTvlUsd ||
          !Number.isFinite(p.tvlUsd)
        )
          return [];
        if (
          retained.some((h) => h.token === p.token) ||
          now - (b.tokenCooldowns![p.token] ?? -Infinity) < POLICY.cooldownMs
        )
          return [];
        if (retained.some((h) => h.actors.some((a) => p.security!.actors.includes(a)))) return [];
        const input = p.buyInputEth,
          gas = p.buyGasEth,
          q = p.entryExitQuote;
        if (
          input === undefined ||
          gas === undefined ||
          !p.quantityRaw ||
          !/^\d+$/.test(p.quantityRaw) ||
          BigInt(p.quantityRaw) <= 0n ||
          !q ||
          q.pool !== p.id ||
          q.quantityRaw !== p.quantityRaw ||
          !/^\d+$/.test(q.block) ||
          q.block !== p.block ||
          q.fetchedAt > now ||
          now - q.fetchedAt > 10000 ||
          !Number.isFinite(q.receivedEth) ||
          q.receivedEth < 0 ||
          !Number.isFinite(q.gasEth) ||
          q.gasEth < 0
        )
          return [];
        const reserve = budget - input - gas;
        if (
          !Number.isFinite(input) ||
          !Number.isFinite(gas) ||
          input <= 0 ||
          gas < 0 ||
          reserve < q.gasEth ||
          budget > b.cash
        )
          return [];
        const h = history.filter((x) => x.id === p.id);
        if (h.length < 3 || now - h[0].at < LAUNCH_POLICY.confirmMs) return [];
        const rise = p.priceEth / h[0].price - 1,
          totalCost = Math.max(0, input - q.receivedEth) + gas + q.gasEth;
        if (
          rise < Math.max(LAUNCH_POLICY.minRise, (2 * totalCost) / budget) ||
          p.priceEth < Math.max(...h.map((x) => x.price)) * (1 - LAUNCH_POLICY.maxDrawdown)
        )
          return [];
        return [{ p, score: rise - (2 * totalCost) / budget, reserve }];
      })
      .sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    for (const { p, reserve } of candidates) {
      seen.add(p.id);
      let c = b.challenges![p.id];
      if (!c || now - c.lastAt > POLICY.maxDataAgeMs)
        c = { since: now, lastAt: 0, observations: 0 };
      if (now - c.lastAt >= POLICY.riskIntervalMs)
        c = { ...c, lastAt: now, observations: c.observations + 1 };
      b.challenges![p.id] = c;
      waitReason = "Confirming independent position signals";
      if (c.observations < POLICY.minObservations || now - c.since < LAUNCH_POLICY.confirmMs)
        continue;
      if (
        b.positions.length >= PAPER_RISK.maxPositions ||
        b.state.trades.length >= POLICY.maxTradesPerDay
      )
        break;
      if (
        b.positions.some(
          (h) => h.token === p.token || h.actors.some((a) => p.security!.actors.includes(a)),
        )
      )
        continue;
      const committed = b.positions.reduce((n, h) => n + h.allocationEth, 0);
      if (
        committed + budget >
          Math.min(b.initial, equity!) * PAPER_RISK.maxCommittedFraction + 1e-12 ||
        budget > b.cash
      )
        continue;
      const id = `${b.initial}:${now}:${p.id}`,
        net = Math.max(0, p.entryExitQuote!.receivedEth + reserve - p.entryExitQuote!.gasEth);
      const position: GuardedPosition = {
        id,
        pool: p.id,
        token: p.token!,
        label: p.label,
        quantityRaw: p.quantityRaw!,
        allocationEth: budget,
        inputEth: p.buyInputEth!,
        entryGasEth: p.buyGasEth!,
        exitReserveEth: reserve,
        entryAt: now,
        entryBlock: p.entryExitQuote!.block,
        entryDepthEth: p.reserveEth ?? 0,
        highWaterEth: budget,
        markedValueEth: net,
        actors: [...p.security!.actors],
        lastQuoteAt: p.entryExitQuote!.fetchedAt,
      };
      b.positions.push(position);
      b.cash -= budget;
      b.costs += p.buyGasEth!;
      b.state.trades.push(now);
      delete b.challenges![p.id];
      b.ledger!.push({
        id,
        capital: b.initial,
        pool: p.id,
        label: p.label,
        entryAt: new Date(now).toISOString(),
        exitAt: null,
        entryValueEth: budget,
        valueEth: net,
        durationSec: 0,
        feesEth: 0,
        costsEth: p.buyGasEth!,
        pnlEth: net - budget,
        exitReason: null,
        feeBaseline: 0,
        quantityRaw: p.quantityRaw!,
      });
      events.push({
        action: "enter",
        reason: "Independent 2% position: security, exact sale and momentum confirmed",
        target: p,
        pool: p.id,
        chargedEth: p.buyGasEth!,
      });
    }
    for (const id of Object.keys(b.challenges!)) if (!seen.has(id)) delete b.challenges![id];
  } else b.challenges = {};
  if (!monitoring) b.challenges = {};
  b.value = b.positions.some((p) => p.markedValueEth === null)
    ? null
    : b.cash + b.positions.reduce((n, p) => n + p.markedValueEth!, 0);
  b.lastAt = now;
  b.position = null;
  b.state.current = b.positions[0]?.pool ?? null;
  const last = events.at(-1),
    decision: Decision = {
      action: last?.action ?? "wait",
      reason: last?.reason ?? waitReason,
      target: last?.target,
      state: b.state,
    };
  return { book: b, decision, events, charged: events.reduce((n, e) => n + e.chargedEth, 0) };
}
