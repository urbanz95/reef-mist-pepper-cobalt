import { canMintOnchain, displayPair, huntApr, isWethPair, rankDegen, type DegenUniverse, type Pool } from "./pools.ts";

/** How often the keeper checks for a better pool. Must match degen-store.ts. */
export const CHECK_INTERVAL_MS = 10 * 60_000;

/** A new pool must beat the current one by a meaningful margin, not just noise. */
export function beats(next: number, current: number) {
  if (!Number.isFinite(next) || next <= 0) return false;
  if (!Number.isFinite(current) || current <= 0) return true;
  if (next <= current) return false;
  const abs = next - current;
  if (abs >= 20) return true;
  return abs / current >= 0.08;
}

export function rankForHunt(pools: Pool[], universe: DegenUniverse, onchain: boolean) {
  return rankDegen(pools, universe).filter((p) => !onchain || (canMintOnchain(p) && isWethPair(p)));
}

/**
 * One check: is there a pool meaningfully better than the current one? Hops
 * immediately when yes — there is no separate "confirming" stage any more.
 * Called at most once per CHECK_INTERVAL_MS per vault (the caller gates that).
 */
export function pickHop(args: {
  pools: Pool[];
  universe: DegenUniverse;
  onchain: boolean;
  currentPoolId: string | null;
}): Pool | null {
  const ranked = rankForHunt(args.pools, args.universe, args.onchain);
  const top = ranked[0] ?? null;
  if (!top) return null;
  if (!args.currentPoolId) return top; // no position yet: enter the best pool
  if (top.id === args.currentPoolId) return null;
  const current = args.pools.find((p) => p.id === args.currentPoolId);
  if (current && !beats(huntApr(top), huntApr(current))) return null;
  return top;
}

export function pairLabel(pool: Pool) {
  return displayPair(pool);
}
