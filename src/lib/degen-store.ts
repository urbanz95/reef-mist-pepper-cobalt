import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DegenUniverse } from "./pools";
import { MIN_ARM_ETH } from "./degen-amounts";

export type { DegenUniverse };

export type DegenHop = {
  id: string;
  at: number;
  fromPoolId: string | null;
  toPoolId: string;
  fromPair: string | null;
  toPair: string;
  fromApr: number;
  toApr: number;
  eth: number;
  kind: "enter" | "hunt" | "pause";
};

/** How often the keeper checks for a better pool. Must match keeper.server.ts. */
export const CHECK_INTERVAL_MS = 10 * 60_000;

type DegenState = {
  active: boolean;
  live: boolean;
  vault: string | null;
  eth: number;
  currentPoolId: string | null;
  enteredAt: number;
  universe: DegenUniverse;
  lastTick: number;
  hops: DegenHop[];
  depositInput: string;
  setUniverse: (u: DegenUniverse) => void;
  setDepositInput: (v: string) => void;
  applyServer: (row: {
    vault: string;
    active: boolean;
    eth: number;
    currentPoolId: string | null;
    enteredAt: number;
    lastTick: number;
    hops: DegenHop[];
  }) => void;
  /** Optimistic local reset right after a successful on-chain exit. */
  localClear: () => void;
};

export const useDegen = create<DegenState>()(
  persist(
    (set) => ({
      active: false,
      live: false,
      vault: null,
      eth: 0,
      currentPoolId: null,
      enteredAt: 0,
      universe: "meme",
      lastTick: 0,
      hops: [],
      depositInput: String(MIN_ARM_ETH),

      setUniverse: (universe) => set({ universe }),
      setDepositInput: (depositInput) => set({ depositInput }),

      applyServer: (row) =>
        set({
          live: true,
          vault: row.vault,
          active: row.active,
          eth: row.eth,
          currentPoolId: row.currentPoolId,
          enteredAt: row.enteredAt,
          lastTick: row.lastTick,
          hops: Array.isArray(row.hops) ? row.hops : [],
        }),

      localClear: () =>
        set({
          active: false,
          live: false,
          vault: null,
          eth: 0,
          currentPoolId: null,
        }),
    }),
    { name: "perch.degen.v3" },
  ),
);
