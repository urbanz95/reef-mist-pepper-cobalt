import type { LiveBook, MarketPoint } from "./live-paper.ts";
import {
  PAPER_RISK,
  PAPER_ROTATION as R,
  positionBudget,
  type GuardedPosition,
  type GuardedContext,
  type ExitQuote,
} from "./paper-risk.ts";
import { entrySignal, fillBudget, observedMomentum, type EntrySignal } from "./paper-signals.ts";
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
    lossCooldowns: { ...previous.lossCooldowns },
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
    now > previous.lastAt &&
    now - previous.lastAt <= POLICY.maxSchedulerGapMs &&
    context.monitorHealthy === true;
  const history = monitoring
    ? (previous.prices ?? []).filter((h) => h.at <= now && now - h.at <= R.historyMs)
    : [];
  // Keep price research continuous when security or execution admission is
  // deferred. It cannot supply a fill or bypass the fresh entry gates below.
  const observed = (context.priceObservations ?? []).filter(
    (p) =>
      p.id.length > 0 &&
      Number.isFinite(p.at) &&
      p.at <= now &&
      now - p.at <= POLICY.maxDataAgeMs &&
      Number.isFinite(p.price) &&
      p.price > 0 &&
      /^\d+$/.test(p.block),
  );
  const merged = [
    ...history,
    ...observed,
    ...fresh.map((p) => ({ id: p.id, at: p.fetchedAt, price: p.priceEth, block: p.block })),
  ].sort((a, c) => a.at - c.at);
  b.prices = [...new Map(merged.map((p) => [JSON.stringify([p.id, p.at]), p])).values()].sort(
    (a, c) => a.at - c.at,
  );
  const settle = (p: GuardedPosition, net: number, gas: number, reason: string, loss = false) => {
    const trade = b.ledger!.find((t) => t.id === p.id)!;
    b.cash += net;
    b.costs += gas;
    trade.valueEth = net;
    trade.pnlEth = net - p.allocationEth;
    trade.durationSec = Math.max(0, (now - p.entryAt) / 1000);
    trade.exitAt = new Date(now).toISOString();
    trade.exitReason = reason;
    trade.costsEth += gas;
    b.tokenCooldowns![p.token] = now;
    if (loss) b.lossCooldowns![p.token] = now;
    events.push({ action: "exit", reason, pool: p.pool, chargedEth: gas });
  };
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
    if (
      market?.reserveEth &&
      p.entryDepthEth > 0 &&
      market.reserveEth <= p.entryDepthEth * (1 - POLICY.liquidityDrop)
    )
      p.exitRequested = "Executable liquidity dropped 30%";
    // Structural/security failures latch the portfolio. An ordinary price stop
    // closes its position and cools that token without killing the whole run.
    if (p.exitRequested) b.state.halted = true;
    const trade = b.ledger!.find((t) => t.id === p.id)!;
    trade.durationSec = Math.max(0, (now - p.entryAt) / 1000);
    if (!quote) {
      p.markedValueEth = null;
      trade.valueEth = null;
      trade.pnlEth = null;
      retained.push(p);
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
      net <= p.allocationEth * (1 - R.stopLoss) || net <= p.highWaterEth * (1 - R.trailingLoss);
    const profit = net >= p.allocationEth * (1 + R.profit),
      heldMs = now - p.entryAt;
    const momentum = observedMomentum(b.prices, p.pool, now);
    const stagnant =
      heldMs >= R.stagnantMs &&
      momentum &&
      momentum.recentRise <= 0 &&
      net < p.allocationEth * 1.002;
    const reason =
      p.exitRequested ??
      (loss
        ? "Position loss / trailing stop"
        : profit
          ? "Position net profit target"
          : heldMs >= R.maxHoldMs
            ? "15-minute exposure limit"
            : stagnant
              ? "Momentum stalled for five minutes; release allocation"
              : null);
    trade.valueEth = net;
    trade.pnlEth = net - p.allocationEth;
    if (reason && quote.gasEth <= p.exitReserveEth) settle(p, net, quote.gasEth, reason, loss);
    else {
      if (reason) {
        p.exitRequested = reason;
        b.state.halted = true;
        events.push({
          action: "blocked",
          reason: "Exit gas exceeds the position reserve; review required",
          pool: p.pool,
          chargedEth: 0,
        });
      }
      retained.push(p);
    }
  }
  b.positions = retained;
  const unknown = retained.some((p) => p.markedValueEth === null);
  const equity = unknown ? null : b.cash + retained.reduce((n, p) => n + p.markedValueEth!, 0);
  if (equity !== null && equity <= b.initial * (1 - R.portfolioLossFraction)) b.state.halted = true;
  const signals: EntrySignal[] = [];
  let waitReason = b.state.halted
    ? "Portfolio risk stop latched"
    : !monitoring
      ? "Continuous block monitoring unavailable"
      : unknown
        ? "Open position valuation unknown"
        : "No cost-covered trend; see per-pool entry signals";
  const limits =
    b.state.trades.length >= R.maxTradesPerDay ||
    b.state.trades.filter((t) => now - t < 3600000).length >= R.maxTradesPerHour;
  if (limits) waitReason = "Paper entry rate limit: six per hour or 24 per day";
  if (!b.state.halted && monitoring && !unknown && !limits) {
    const screenBudget = Math.min(b.initial, equity!) * PAPER_RISK.positionFraction;
    const ready: { p: MarketPoint; signal: EntrySignal }[] = [],
      seen = new Set<string>();
    for (const p of fresh) {
      if (retained.some((h) => h.token === p.token)) continue;
      let s = entrySignal(p, b.prices, screenBudget, now);
      if (retained.some((h) => h.actors.some((a) => p.security?.actors.includes(a))))
        s = {
          pool: p.id,
          status: "blocked",
          reason: "Token shares an issuer or major holder with an open position",
        };
      if (
        now - (b.tokenCooldowns![p.token!] ?? -Infinity) < R.cooldownMs ||
        now - (b.lossCooldowns![p.token!] ?? -Infinity) < R.lossCooldownMs
      )
        s = {
          pool: p.id,
          status: "blocked",
          reason: "Per-token cooldown after a close or price stop",
        };
      signals.push(s);
      if (s.status !== "confirming") continue;
      seen.add(p.id);
      let c = b.challenges![p.id];
      if (!c || now - c.lastAt > 30000) c = { since: now, lastAt: 0, observations: 0 };
      if (now - c.lastAt >= POLICY.riskIntervalMs)
        c = { ...c, lastAt: now, observations: c.observations + 1 };
      b.challenges![p.id] = c;
      if (c.observations >= R.minObservations && now - c.since >= R.confirmMs) {
        s.status = "ready";
        s.reason = "Security, exact sale and 90-second cost-covered trend confirmed";
        ready.push({ p, signal: s });
      }
    }
    for (const id of Object.keys(b.challenges!)) if (!seen.has(id)) delete b.challenges![id];
    ready.sort((a, c) => c.signal.score! - a.signal.score!);
    for (const { p, signal } of ready) {
      if (
        b.state.trades.length >= R.maxTradesPerDay ||
        b.state.trades.filter((t) => now - t < 3600000).length >= R.maxTradesPerHour
      )
        break;
      if (
        b.positions.some(
          (h) => h.token === p.token || h.actors.some((a) => p.security!.actors.includes(a)),
        )
      )
        continue;
      let rotating = false;
      if (b.positions.length >= PAPER_RISK.maxPositions) {
        const choices: { pos: GuardedPosition; q: ExitQuote; improvement: number }[] = b.positions
          .flatMap((pos) => {
            const q = quoteFor(context.exitQuotes ?? [], pos, now),
              m = observedMomentum(b.prices!, pos.pool, now);
            if (
              now - pos.entryAt < R.minHoldMs ||
              pos.exitRequested ||
              !q ||
              !m ||
              q.gasEth > pos.exitReserveEth ||
              pos.markedValueEth === null
            )
              return [];
            const improvement = signal.score! - Math.max(0, m.rise);
            const switching =
              R.rotationMargin +
              // The candidate score already subtracts its two-leg costs. Do
              // not charge the same target costs again during comparison.
              (R.costMargin * q.gasEth) / pos.allocationEth;
            const remaining = b.positions!.filter((x) => x.id !== pos.id);
            const nextBudget = positionBudget(
              b.initial,
              equity,
              b.cash + pos.markedValueEth,
              remaining,
            );
            if (improvement <= switching || !fillBudget(p, nextBudget, now)) return [];
            return [{ pos, q, improvement }];
          })
          .sort((a, c) => c.improvement - a.improvement);
        const replacement = choices[0];
        if (!replacement) {
          signal.reason =
            "Slots occupied; new trend does not exceed holding advantage plus switching costs";
          continue;
        }
        settle(
          replacement.pos,
          replacement.pos.markedValueEth!,
          replacement.q.gasEth,
          `Rotate to stronger cost-covered trend: ${p.label}`,
        );
        b.positions = b.positions.filter((x) => x.id !== replacement.pos.id);
        rotating = true;
      }
      const budget = positionBudget(b.initial, equity, b.cash, b.positions),
        fill = fillBudget(p, budget, now);
      if (!fill || budget > b.cash) {
        signal.reason =
          "Actual remaining allocation cannot fund this measured fill and exit reserve";
        continue;
      }
      const id = `${b.initial}:${now}:${p.id}`;
      const pos: GuardedPosition = {
        id,
        pool: p.id,
        token: p.token!,
        label: p.label,
        quantityRaw: p.quantityRaw!,
        allocationEth: budget,
        inputEth: p.buyInputEth!,
        entryGasEth: p.buyGasEth!,
        exitReserveEth: fill.reserve,
        entryAt: now,
        entryBlock: p.entryExitQuote!.block,
        entryDepthEth: p.reserveEth!,
        // The trailing baseline starts at executable liquidation value. Using
        // the allocation would mistake the purchase costs for a market fall.
        highWaterEth: fill.net,
        markedValueEth: fill.net,
        actors: [...p.security!.actors],
        lastQuoteAt: p.entryExitQuote!.fetchedAt,
      };
      b.positions.push(pos);
      b.cash -= budget;
      b.costs += p.buyGasEth!;
      b.state.trades.push(now);
      b.state.lastTradeAt = now;
      delete b.challenges![p.id];
      b.ledger!.push({
        id,
        capital: b.initial,
        pool: p.id,
        label: p.label,
        entryAt: new Date(now).toISOString(),
        exitAt: null,
        entryValueEth: budget,
        valueEth: fill.net,
        durationSec: 0,
        feesEth: 0,
        costsEth: p.buyGasEth!,
        pnlEth: fill.net - budget,
        exitReason: null,
        feeBaseline: 0,
        quantityRaw: p.quantityRaw!,
      });
      signal.reason = rotating
        ? "Opened after a measured, cost-covered rotation"
        : "Opened a confirmed independent 2% position";
      events.push({
        action: "enter",
        reason: signal.reason,
        target: p,
        pool: p.id,
        chargedEth: p.buyGasEth!,
      });
    }
    if (!events.length && signals.length)
      waitReason =
        signals.find((s) => s.status === "ready" || s.status === "confirming")?.reason ??
        signals[0].reason;
  } else b.challenges = {};
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
  return {
    book: b,
    decision,
    events,
    signals,
    charged: events.reduce((n, e) => n + e.chargedEth, 0),
  };
}
