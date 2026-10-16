import {
  decide,
  initialPolicy,
  settled,
  conservativeApr,
  POLICY,
  type Candidate,
  type PolicyState,
} from "./degen-policy.ts";
export type MarketPoint = Candidate & {
  priceEth: number;
  fetchedAt: number;
  entryCostEth: number;
  exitCostEth: number;
  label: string;
};
export type LiveBook = {
  initial: number;
  cash: number;
  state: PolicyState;
  position: { pool: string; entryPrice: number; principal: number; fees: number } | null;
  lastAt: number;
  fees: number;
  costs: number;
  value: number | null;
};
export function newLiveBook(initial: number): LiveBook {
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
  };
}
/** Approximation for a full-range constant-product position, expressed in ETH.
 * No claim of measured fees or actual Uniswap NFT balances. */
export function fullRangeValue(principal: number, entryPrice: number, price: number) {
  if (![principal, entryPrice, price].every((n) => Number.isFinite(n) && n > 0))
    throw new Error("Invalid valuation input");
  return principal * Math.sqrt(price / entryPrice);
}
export function stepLiveBook(previous: LiveBook, points: MarketPoint[], now: number) {
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
      const fees = monitoring
        ? (((marked * conservativeApr(current.apr)) / 100) * elapsed) / (365 * 86400000)
        : 0;
      book.position.fees += fees;
      book.fees += fees;
      value = marked + book.position.fees;
    }
  }
  const decision = decide(book.state, {
    now,
    fetchedAt: fresh.length ? Math.min(...fresh.map((p) => p.fetchedAt)) : 0,
    schedulerHealthy: monitoring,
    pending: false,
    valueEth: value,
    currentApr: current?.apr ?? 0,
    currentTvlUsd: current?.tvlUsd ?? null,
    sellable: value !== null,
    candidates: fresh.map((p) => ({ ...p, costEth: p.costEth + (current?.exitCostEth ?? 0) })),
  });
  book.state = decision.state;
  let charged = 0;
  if (decision.action === "exit" && value !== null && current) {
    charged = Math.min(value, current.exitCostEth);
    book.cash = value - charged;
    book.position = null;
    book.state = settled(book.state, decision, now, book.cash);
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
    };
    book.cash = 0;
    value -= charged;
    book.state = settled(book.state, decision, now, value);
  }
  book.costs += charged;
  book.value = value;
  book.lastAt = now;
  return { book, decision, charged };
}
