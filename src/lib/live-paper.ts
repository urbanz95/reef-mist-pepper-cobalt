import {
  decide,
  initialPolicy,
  settled,
  conservativeApr,
  POLICY,
  type Candidate,
  type PolicyState,
} from "./degen-policy.ts";
import { recordPaperTrade, type PaperTrade } from "./paper-ledger.ts";
import { stepLaunchBook } from "./launch-paper.ts";
import { stepGuardedBook } from "./guarded-paper.ts";
import type {
  SecurityAssessment,
  ExitQuote,
  GuardedPosition,
  GuardedContext,
} from "./paper-risk.ts";
export type MarketPoint = Candidate & {
  priceEth: number;
  fetchedAt: number;
  entryCostEth: number;
  exitCostEth: number;
  label: string;
  reserveEth?: number;
  metadataFresh?: boolean;
  executionRecovery?: number;
  token?: string;
  security?: SecurityAssessment;
  buyInputEth?: number;
  buyGasEth?: number;
  quantityRaw?: string;
  entryExitQuote?: ExitQuote;
  block?: string;
};
export type LiveBook = {
  initial: number;
  cash: number;
  state: PolicyState;
  position: {
    pool: string;
    entryPrice: number;
    principal: number;
    fees: number;
    reserveEthAtEntry?: number;
    recoveryAtEntry?: number;
  } | null;
  lastAt: number;
  fees: number;
  costs: number;
  value: number | null;
  strategy?: "baseline" | "carry48" | "launch" | "guarded";
  portfolioVersion?: 2;
  positions?: GuardedPosition[];
  challenges?: Record<string, { since: number; lastAt: number; observations: number }>;
  tokenCooldowns?: Record<string, number>;
  lossCooldowns?: Record<string, number>;
  prices?: { id: string; at: number; price: number }[];
  enteredAt?: number;
  entryAccountValue?: number;
  ledger?: PaperTrade[];
};
export function newLiveBook(
  initial: number,
  strategy: "baseline" | "carry48" | "launch" | "guarded" = "baseline",
): LiveBook {
  if (!Number.isFinite(initial) || initial <= 0 || initial > 0.5)
    throw new Error("Virtual capital must be > 0 and <= 0.5 ETH");
  return {
    initial,
    cash: initial,
    state: initialPolicy(initial),
    position: null,
    lastAt: 0,
    fees: 0,
    costs: 0,
    value: initial,
    strategy,
    prices: [],
    ...(strategy === "guarded"
      ? {
          portfolioVersion: 2 as const,
          positions: [],
          challenges: {},
          tokenCooldowns: {},
          lossCooldowns: {},
        }
      : {}),
  };
}
/** Approximation for a full-range constant-product position, expressed in ETH.
 * No claim of measured fees or actual Uniswap NFT balances. */
export function fullRangeValue(principal: number, entryPrice: number, price: number) {
  if (![principal, entryPrice, price].every((n) => Number.isFinite(n) && n > 0))
    throw new Error("Invalid valuation input");
  return principal * Math.sqrt(price / entryPrice);
}
export function stepLiveBook(
  previous: LiveBook,
  points: MarketPoint[],
  now: number,
  context?: GuardedContext,
) {
  if (previous.strategy === "guarded") return stepGuardedBook(previous, points, now, context);
  if (previous.strategy === "launch") return stepLaunchBook(previous, points, now);
  const book: LiveBook = {
    ...previous,
    state: { ...previous.state },
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
  const carry = book.strategy === "carry48";
  const history = (previous.prices ?? []).filter((p) => now - p.at <= 15 * 60000);
  const acceptable = fresh.filter((p) => {
    if (p.metadataFresh === false) return false;
    if (!carry) return true;
    const observations = history.filter((h) => h.id === p.id);
    // No entry into a one-percent drawdown from the observed 15-minute high.
    return (
      observations.length >= 3 &&
      now - observations[0].at >= 120000 &&
      p.priceEth >= Math.max(...observations.map((h) => h.price)) * 0.99
    );
  });
  book.prices = [...history, ...fresh.map((p) => ({ id: p.id, at: now, price: p.priceEth }))];
  const elapsed = previous.lastAt ? now - previous.lastAt : 0;
  const monitoring = elapsed > 0 && elapsed <= POLICY.maxSchedulerGapMs;
  let value: number | null = book.cash;
  if (book.position) {
    if (!current || !current.roundTripOk) value = null;
    else {
      const marked = fullRangeValue(
        book.position.principal,
        book.position.entryPrice,
        current.priceEth,
      );
      // Do not fabricate fees across an observation gap or unverified exit.
      const fees =
        monitoring && current.metadataFresh !== false
          ? (((marked * conservativeApr(current.apr)) / 100) * elapsed) / (365 * 86400000)
          : 0;
      book.position.fees += fees;
      book.fees += fees;
      value = marked + book.position.fees;
    }
  }
  let decision = decide(book.state, {
    now,
    fetchedAt: fresh.length ? Math.min(...fresh.map((p) => p.fetchedAt)) : 0,
    schedulerHealthy: monitoring,
    pending: false,
    valueEth: value,
    currentApr: current?.apr ?? 0,
    // Compare fresh reserves in the same ETH unit, without treating a cached
    // ETH/USD conversion change as a liquidity withdrawal.
    currentTvlUsd:
      current && book.position?.reserveEthAtEntry && current.reserveEth
        ? (book.state.entryTvlUsd * current.reserveEth) / book.position.reserveEthAtEntry
        : (current?.tvlUsd ?? null),
    sellable: value !== null,
    candidates: acceptable.map((p) => ({ ...p, costEth: p.costEth + (current?.exitCostEth ?? 0) })),
    paperHorizonHours: carry ? 48 : undefined,
    paperIgnorePoolAge: true,
  });
  if (
    carry &&
    fresh.length &&
    !acceptable.length &&
    decision.action === "wait" &&
    decision.reason === "Estimated fees do not cover costs with a safety margin"
  ) {
    decision.reason =
      "Paper carry: awaiting stable price history or rejecting a recent 1% drawdown";
  }
  if (
    fresh.length &&
    fresh.every((p) => p.metadataFresh === false) &&
    decision.action === "wait" &&
    !book.position
  ) {
    decision.reason =
      "Provider volume/reference metadata expired; live quotes available but no new entry";
  }
  // Preserve only recent confirmation evidence through one missing feed sample.
  // No observation is counted and no entry is permitted until fresh quotes return.
  if (
    carry &&
    monitoring &&
    decision.reason === "Fresh pool data unavailable" &&
    previous.state.challenger &&
    now - previous.state.lastObservationAt <= POLICY.maxSchedulerGapMs
  ) {
    decision.state = {
      ...decision.state,
      challenger: previous.state.challenger,
      challengerSince: previous.state.challengerSince,
      observations: previous.state.observations,
      lastObservationAt: previous.state.lastObservationAt,
    };
  }
  if (
    carry &&
    book.position &&
    current &&
    current.roundTripOk &&
    value !== null &&
    decision.action !== "exit"
  ) {
    const netExit = value - current.exitCostEth;
    const profitTarget = Math.max(book.initial * 0.001, current.costEth * 2);
    if (netExit >= Math.max(book.initial, book.entryAccountValue ?? book.initial) + profitTarget) {
      decision = {
        ...decision,
        action: "exit",
        reason: "Paper carry: net profit target reached",
        target: undefined,
      };
    } else if (now - (book.enteredAt ?? now) >= 48 * 3600000) {
      decision = {
        ...decision,
        action: "exit",
        reason: "Paper carry: 48-hour exposure limit reached",
        target: undefined,
      };
    }
  }
  book.state = decision.state;
  let charged = 0;
  if (decision.action === "exit" && value !== null && current) {
    charged = Math.min(value, current.exitCostEth);
    book.cash = value - charged;
    book.position = null;
    book.state = settled(book.state, decision, now, book.cash);
    // A profitable close may re-enter after the cooldown. Risk stops remain latched.
    if (
      carry &&
      !previous.state.halted &&
      decision.reason === "Paper carry: net profit target reached"
    ) {
      book.state = { ...book.state, halted: false, lastTradeAt: now };
    }
    value = book.cash;
  } else if (
    (decision.action === "enter" || decision.action === "hop") &&
    value !== null &&
    decision.target
  ) {
    const target = fresh.find((p) => p.id === decision.target!.id)!;
    // Reserve round-trip trading loss on entry; charge each gas leg once.
    charged = Math.min(value, target.entryCostEth + (current?.exitCostEth ?? 0));
    book.position = {
      pool: target.id,
      entryPrice: target.priceEth,
      principal: value - charged,
      fees: 0,
      reserveEthAtEntry: target.reserveEth,
    };
    book.enteredAt = now;
    book.entryAccountValue = value;
    book.cash = 0;
    value -= charged;
    book.state = settled(book.state, decision, now, value);
  }
  book.costs += charged;
  book.value = value;
  book.lastAt = now;
  book.ledger = recordPaperTrade(
    previous.ledger ?? [],
    book.initial,
    decision.action,
    now,
    value,
    book.fees,
    fresh.find((p) => p.id === decision.target?.id),
    previous.value ?? previous.initial,
    current?.exitCostEth ?? 0,
    decision.reason,
  );
  return { book, decision, charged };
}
