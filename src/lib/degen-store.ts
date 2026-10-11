import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  displayPair,
  ethPriceUsd,
  findPool,
  huntApr,
  isWethPair,
  canMintOnchain,
  rankDegen,
  type DegenUniverse,
  type Pool,
} from "./pools";

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

const FRICTION = 0.0008;
const MAX_HOPS = 40;

export const HOLD_OPTIONS = [
  { ms: 30_000, label: "30s" },
  { ms: 120_000, label: "2 min" },
  { ms: 900_000, label: "15 min" },
  { ms: 3_600_000, label: "1 h" },
] as const;

function beats(next: number, current: number) {
  if (!Number.isFinite(next) || next <= 0) return false;
  if (!Number.isFinite(current) || current <= 0) return true;
  if (next <= current) return false;
  const abs = next - current;
  if (abs >= 20) return true;
  return abs / current >= 0.08;
}

function hopOf(
  kind: DegenHop["kind"],
  args: {
    from: Pool | null;
    to: Pool;
    eth: number;
    fromApr: number;
    toApr: number;
  },
): DegenHop {
  return {
    id: crypto.randomUUID(),
    at: Date.now(),
    fromPoolId: args.from?.id ?? null,
    toPoolId: args.to.id,
    fromPair: args.from ? displayPair(args.from) : null,
    toPair: displayPair(args.to),
    fromApr: args.fromApr,
    toApr: args.toApr,
    eth: args.eth,
    kind,
  };
}

type DegenState = {
  active: boolean;
  live: boolean;
  vault: string | null;
  eth: number;
  principalEth: number;
  feesUsd: number;
  currentPoolId: string | null;
  enteredAt: number;
  universe: DegenUniverse;
  holdMs: number;
  challengerId: string | null;
  challengerSince: number | null;
  lastTickAt: number;
  planned: DegenHop | null;
  hops: DegenHop[];
  depositInput: string;
  setUniverse: (u: DegenUniverse) => void;
  setHoldMs: (ms: number) => void;
  setDepositInput: (v: string) => void;
  arm: (eth: number, pools: Pool[]) => DegenHop | null;
  setLive: (args: { vault: string }) => void;
  applyServer: (row: {
    vault: string;
    active: boolean;
    eth: number;
    currentPoolId: string | null;
    challengerId: string | null;
    challengerSince: number | null;
    enteredAt: number;
    hops: DegenHop[];
  }) => void;
  resume: () => boolean;
  stop: (pools: Pool[]) => DegenHop | null;
  tick: (pools: Pool[], now?: number) => DegenHop | null;
  commitPlanned: () => DegenHop | null;
};

export const useDegen = create<DegenState>()(
  persist(
    (set, get) => ({
      active: false,
      live: false,
      vault: null,
      eth: 0,
      principalEth: 0,
      feesUsd: 0,
      currentPoolId: null,
      enteredAt: 0,
      universe: "meme",
      holdMs: 30_000,
      challengerId: null,
      challengerSince: null,
      lastTickAt: 0,
      planned: null,
      hops: [],
      depositInput: "1",

      setUniverse: (universe) => set({ universe }),
      setHoldMs: (holdMs) => set({ holdMs, challengerId: null, challengerSince: null }),
      setDepositInput: (depositInput) => set({ depositInput }),

      arm: (eth, pools) => {
        if (eth <= 0) return null;
        const { universe, hops, currentPoolId, active } = get();
        if (currentPoolId && !active) {
          set({ active: true, lastTickAt: Date.now(), challengerId: null, challengerSince: null });
          return null;
        }
        const ranked = rankDegen(pools, universe);
        const to = ranked[0];
        if (!to) return null;
        const hop = hopOf("enter", {
          from: null,
          to,
          eth,
          fromApr: 0,
          toApr: huntApr(to),
        });
        const now = Date.now();
        set({
          active: true,
          eth,
          principalEth: eth,
          feesUsd: 0,
          currentPoolId: to.id,
          enteredAt: now,
          lastTickAt: now,
          challengerId: null,
          challengerSince: null,
          planned: null,
          hops: [hop, ...hops].slice(0, MAX_HOPS),
        });
        return hop;
      },

      setLive: ({ vault }) => set({ live: true, vault }),

      applyServer: (row) =>
        set({
          live: true,
          vault: row.vault,
          active: row.active,
          eth: row.eth,
          currentPoolId: row.currentPoolId,
          challengerId: row.challengerId,
          challengerSince: row.challengerSince,
          enteredAt: row.enteredAt,
          hops: Array.isArray(row.hops) ? (row.hops as DegenHop[]) : get().hops,
        }),

      resume: () => {
        const s = get();
        if (!s.currentPoolId || s.active) return false;
        set({
          active: true,
          lastTickAt: Date.now(),
          challengerId: null,
          challengerSince: null,
        });
        return true;
      },

      stop: (pools) => {
        const s = get();
        if (!s.active) return null;
        const current = s.currentPoolId ? findPool(pools, s.currentPoolId) : null;
        const hop = current
          ? hopOf("pause", {
              from: current,
              to: current,
              eth: s.eth,
              fromApr: huntApr(current),
              toApr: huntApr(current),
            })
          : null;
        set({
          active: false,
          planned: null,
          challengerId: null,
          challengerSince: null,
          lastTickAt: Date.now(),
          hops: hop ? [hop, ...s.hops].slice(0, MAX_HOPS) : s.hops,
        });
        return hop;
      },

      tick: (pools, now = Date.now()) => {
        const s = get();
        if (!s.active || !s.currentPoolId) return null;

        const dt = Math.max(0, now - (s.lastTickAt || now));
        const px = ethPriceUsd(pools);
        const current = findPool(pools, s.currentPoolId);
        const currentApr = current ? huntApr(current) : 0;
        const usd = s.eth * px;
        const extraFees = usd * (currentApr / 100) * (dt / (365 * 24 * 3_600_000));
        const feesUsd = s.feesUsd + extraFees;

        if (s.planned) {
          set({ feesUsd, lastTickAt: now });
          return s.planned;
        }

        const ranked = rankDegen(pools, s.universe).filter(
          (p) => !s.live || (canMintOnchain(p) && isWethPair(p)),
        );
        const top = ranked[0];

        let challengerId = s.challengerId;
        let challengerSince = s.challengerSince;
        let hop: DegenHop | null = null;

        const shouldHunt =
          !!top &&
          top.id !== s.currentPoolId &&
          (!current || beats(huntApr(top), currentApr));

        if (!top || !shouldHunt) {
          challengerId = null;
          challengerSince = null;
        } else if (challengerId !== top.id) {
          challengerId = top.id;
          challengerSince = now;
        } else if (
          !current ||
          (challengerSince != null && now - challengerSince >= s.holdMs)
        ) {
          const compounded = s.eth + (px > 0 ? feesUsd / px : 0);
          const eth = compounded * (1 - FRICTION);
          hop = hopOf("hunt", {
            from: current ?? null,
            to: top,
            eth,
            fromApr: currentApr,
            toApr: huntApr(top),
          });
        }

        set({
          feesUsd,
          lastTickAt: now,
          challengerId,
          challengerSince,
          planned: hop,
        });
        return hop;
      },

      commitPlanned: () => {
        const s = get();
        const hop = s.planned;
        if (!hop || hop.kind !== "hunt") return null;
        set({
          planned: null,
          eth: hop.eth,
          feesUsd: 0,
          currentPoolId: hop.toPoolId,
          enteredAt: Date.now(),
          challengerId: null,
          challengerSince: null,
          hops: [hop, ...s.hops].slice(0, MAX_HOPS),
        });
        return hop;
      },
    }),
    { name: "perch.degen.v2" },
  ),
);

export function degenPnlUsd(eth: number, principalEth: number, feesUsd: number, px: number) {
  return (eth - principalEth) * px + feesUsd;
}
