import { createServerFn } from "@tanstack/react-start";
import type { DegenUniverse } from "./pools";
import { isAddress, isTxHash, type DegenAuth } from "./degen-auth";

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
    };
    if (!isTxHash(v?.hash)) throw new Error("A valid transaction hash is required.");
    if (!isAddress(v?.owner)) throw new Error("A valid owner address is required.");
    return {
      hash: v.hash,
      owner: v.owner,
      universe: (v.universe ?? "meme") as DegenUniverse,
      holdMs: Number(v.holdMs ?? 120_000),
    };
  })
  .handler(async ({ data }) => {
    const { confirmFromTx } = await import("./keeper.server");
    return asDto(await confirmFromTx(data));
  });

export const setDegenActive = createServerFn({ method: "POST" })
  .validator((raw: unknown) => {
    const v = raw as { owner?: string; active?: boolean; auth?: DegenAuth };
    if (!isAddress(v?.owner)) throw new Error("A valid owner address is required.");
    const sig = v.auth?.signature;
    if (typeof sig !== "string" || !/^0x[0-9a-fA-F]+$/.test(sig) || sig.length > 4096) {
      throw new Error("A wallet signature is required.");
    }
    if (!Number.isFinite(Number(v.auth?.timestamp))) throw new Error("A wallet signature is required.");
    return {
      owner: v.owner,
      active: Boolean(v.active),
      auth: { signature: sig as `0x${string}`, timestamp: Number(v.auth?.timestamp) },
    };
  })
  .handler(async ({ data }) => {
    const { setVaultActive } = await import("./keeper.server");
    return asDto(await setVaultActive(data.owner, data.active, data.auth));
  });

export const getDegenVault = createServerFn({ method: "POST" })
  .validator((raw: unknown) => {
    const owner = typeof raw === "string" ? raw : String((raw as { owner?: string })?.owner || "");
    return isAddress(owner) ? owner : "";
  })
  .handler(async ({ data: owner }) => {
    if (!owner) return null;
    const { getVaultByOwner, startKeeperLoop } = await import("./keeper.server");
    startKeeperLoop();
    return asDto(await getVaultByOwner(owner));
  });
