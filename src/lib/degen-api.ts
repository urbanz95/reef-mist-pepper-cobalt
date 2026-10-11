import { createServerFn } from "@tanstack/react-start";
import type { DegenUniverse } from "./pools";

export type DegenVaultDTO = {
  vault: string;
  owner: string;
  universe: DegenUniverse;
  holdMs: number;
  active: boolean;
  eth: number;
  currentPoolId: string | null;
  challengerId: string | null;
  challengerSince: number | null;
  lastTick: number;
  enteredAt: number;
  hops: {
    id: string;
    at: number;
    kind: string;
    fromPair: string | null;
    toPair: string;
    fromApr: number;
    toApr: number;
    toPoolId: string;
    eth: number;
  }[];
};

function asDto(
  row: {
    vault: string;
    owner: string;
    universe: DegenUniverse;
    holdMs: number;
    active: boolean;
    eth: number;
    currentPoolId: string | null;
    challengerId: string | null;
    challengerSince: number | null;
    lastTick: number;
    enteredAt: number;
    hops: unknown[];
  } | null,
): DegenVaultDTO | null {
  if (!row) return null;
  return {
    ...row,
    hops: (row.hops as DegenVaultDTO["hops"]) ?? [],
  };
}

export const getKeeperAddress = createServerFn({ method: "GET" }).handler(async () => {
  const { getKeeperPublic, startKeeperLoop } = await import("./keeper.server");
  startKeeperLoop();
  return getKeeperPublic();
});

export const confirmDegenArm = createServerFn({ method: "POST" })
  .validator((raw: unknown) => {
    const v = raw as {
      hash?: string;
      owner?: string;
      universe?: DegenUniverse;
      holdMs?: number;
      eth?: number;
    };
    if (!v?.hash || !v?.owner) throw new Error("hash and owner are required");
    return {
      hash: String(v.hash),
      owner: String(v.owner),
      universe: (v.universe ?? "meme") as DegenUniverse,
      holdMs: Number(v.holdMs ?? 120_000),
      eth: Number(v.eth ?? 0),
    };
  })
  .handler(async ({ data }) => {
    const { confirmFromTx } = await import("./keeper.server");
    return asDto(await confirmFromTx(data));
  });

export const setDegenActive = createServerFn({ method: "POST" })
  .validator((raw: unknown) => {
    const v = raw as { owner?: string; active?: boolean };
    if (!v?.owner) throw new Error("owner is required");
    return { owner: String(v.owner), active: Boolean(v.active) };
  })
  .handler(async ({ data }) => {
    const { setVaultActive } = await import("./keeper.server");
    return asDto(await setVaultActive(data.owner, data.active));
  });

export const getDegenVault = createServerFn({ method: "POST" })
  .validator((raw: unknown) => {
    if (typeof raw === "string") return raw;
    return String((raw as { owner?: string })?.owner || "");
  })
  .handler(async ({ data: owner }) => {
    if (!owner) return null;
    const { getVaultByOwner, startKeeperLoop } = await import("./keeper.server");
    startKeeperLoop();
    return asDto(await getVaultByOwner(owner));
  });
