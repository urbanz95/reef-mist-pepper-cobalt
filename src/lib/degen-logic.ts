import {
  canMintOnchain,
  displayPair,
  isWethPair,
  rankDegen,
  type DegenUniverse,
  type Pool,
} from "./pools.ts";
import { POLICY } from "./degen-policy.ts";
export const CHECK_INTERVAL_MS = POLICY.riskIntervalMs;
/** Discovery only. No selection here authorizes a trade: decide() applies risk,
 * freshness, confirmations and cost gates after quotes and simulations. */
export function rankForHunt(pools: Pool[], universe: DegenUniverse, onchain: boolean) {
  return rankDegen(pools, universe)
    .filter((p) => !onchain || (canMintOnchain(p) && isWethPair(p)))
    .sort((a, b) => feeApr24h(b) - feeApr24h(a));
}
export function feeApr24h(p: Pool) {
  return p.tvlUsd > 0 ? (p.volume24h * p.feePct * 365) / p.tvlUsd : 0;
}
export function pairLabel(pool: Pool) {
  return displayPair(pool);
}
