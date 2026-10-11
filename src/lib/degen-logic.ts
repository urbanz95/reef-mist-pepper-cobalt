import {
  canMintOnchain,
  displayPair,
  huntApr,
  isWethPair,
  rankDegen,
  type DegenUniverse,
  type Pool,
} from "./pools";

export const FRICTION = 0.0008;

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

export function planHunt(args: {
  pools: Pool[];
  universe: DegenUniverse;
  onchain: boolean;
  currentPoolId: string | null;
  challengerId: string | null;
  challengerSince: number | null;
  holdMs: number;
  now: number;
}): { challengerId: string | null; challengerSince: number | null; target: Pool | null } {
  const ranked = rankForHunt(args.pools, args.universe, args.onchain);
  const top = ranked[0] ?? null;
  const current = args.currentPoolId
    ? args.pools.find((p) => p.id === args.currentPoolId)
    : undefined;
  const currentApr = current ? huntApr(current) : 0;
  const shouldHunt =
    !!top &&
    top.id !== args.currentPoolId &&
    (!current || beats(huntApr(top), currentApr));

  if (!top || !shouldHunt) {
    return { challengerId: null, challengerSince: null, target: null };
  }
  if (args.challengerId !== top.id) {
    return { challengerId: top.id, challengerSince: args.now, target: null };
  }
  if (args.challengerSince != null && args.now - args.challengerSince >= args.holdMs) {
    return { challengerId: null, challengerSince: null, target: top };
  }
  return {
    challengerId: args.challengerId,
    challengerSince: args.challengerSince,
    target: null,
  };
}

export function pairLabel(pool: Pool) {
  return displayPair(pool);
}
