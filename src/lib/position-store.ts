import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Pool, PoolVersion } from "./pools";
import { estimatedApr } from "./pools";

export type LpPosition = {
  id: string;
  poolId: string;
  pair: string;
  version: PoolVersion;
  feePct: number;
  tokenA: string;
  tokenB: string;
  amountA: number;
  amountB: number;
  usd: number;
  tickLower: number;
  tickUpper: number;
  pMin: number;
  pMax: number;
  inRange: boolean;
  createdAt: number;
  status: "pending" | "onchain";
  txHash?: string;
  aprAtOpen: number;
};

type PositionState = {
  positions: LpPosition[];
  add: (p: LpPosition) => void;
  remove: (id: string) => void;
  markOnchain: (id: string, txHash: string) => void;
};

export const usePositions = create<PositionState>()(
  persist(
    (set) => ({
      positions: [],
      add: (p) => set((s) => ({ positions: [p, ...s.positions] })),
      remove: (id) =>
        set((s) => ({ positions: s.positions.filter((x) => x.id !== id) })),
      markOnchain: (id, txHash) =>
        set((s) => ({
          positions: s.positions.map((x) =>
            x.id === id ? { ...x, status: "onchain", txHash } : x,
          ),
        })),
    }),
    { name: "perch.positions.v1" },
  ),
);

export function accruedFeesUsd(pos: LpPosition, now = Date.now()) {
  const hours = Math.max(0, (now - pos.createdAt) / 3_600_000);
  return pos.usd * (pos.aprAtOpen / 100) * (hours / (365 * 24));
}

export function buildPosition(
  pool: Pool,
  args: {
    amountA: number;
    amountB: number;
    usd: number;
    tickLower: number;
    tickUpper: number;
    pMin: number;
    pMax: number;
    status: LpPosition["status"];
    txHash?: string;
  },
): LpPosition {
  const price = pool.priceUsd || 1;
  const inRange =
    !Number.isFinite(args.pMin) ||
    (price >= args.pMin && price <= args.pMax);
  return {
    id: crypto.randomUUID(),
    poolId: pool.id,
    pair: `${pool.tokenA.symbol}/${pool.tokenB.symbol}`,
    version: pool.version,
    feePct: pool.feePct,
    tokenA: pool.tokenA.symbol,
    tokenB: pool.tokenB.symbol,
    amountA: args.amountA,
    amountB: args.amountB,
    usd: args.usd,
    tickLower: args.tickLower,
    tickUpper: args.tickUpper,
    pMin: args.pMin,
    pMax: args.pMax,
    inRange,
    createdAt: Date.now(),
    status: args.status,
    txHash: args.txHash,
    aprAtOpen: estimatedApr(pool),
  };
}
