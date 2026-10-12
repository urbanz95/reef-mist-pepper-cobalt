import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyMessage, type Hex } from "viem";
import { env, isWorkspacePreview } from "./env.server";
import { getSql } from "./db";
import {
  VaultEmptyError,
  encodeDeployDegen,
  operatorRebalance,
  publicClient,
  readVault,
  verifyVault,
  waitArmReceipt,
} from "./degen-chain";
import { authFresh, degenAuthMessage, isAddress, type DegenAuth } from "./degen-auth";
import { planHunt, rankForHunt } from "./degen-logic";
import { huntApr, type DegenUniverse, type Pool } from "./pools";

export type VaultRow = {
  vault: string;
  owner: string;
  universe: DegenUniverse;
  hold_ms: number;
  active: boolean;
  eth: number;
  current_pool_id: string | null;
  challenger_id: string | null;
  challenger_since: number | null;
  last_tick: number | null;
  entered_at: number | null;
  hops_json: string;
};

const g = globalThis as typeof globalThis & {
  __perchKeeperTimer__?: ReturnType<typeof setInterval>;
  __perchKeeperBusy__?: boolean;
  __perchVaultLocks__?: Set<string>;
};

/** Emergency stop: KEEPER_PAUSED=1 halts all hops (owners can still exit on-chain). */
export function keeperPaused() {
  return env("KEEPER_PAUSED") === "1";
}

/** Closed beta: when ARM_ALLOWLIST is set (comma separated), only those wallets can arm. */
export function armAllowed(owner: string) {
  const list = env("ARM_ALLOWLIST");
  if (!list) return true;
  return list
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean)
    .includes(owner.toLowerCase());
}

export const MIN_HOLD_MS = 60_000;
export const MAX_HOLD_MS = 24 * 60 * 60_000;
const UNIVERSES: readonly DegenUniverse[] = ["meme", "all", "stock"];

async function ensure() {
  const sql = await getSql();
  await sql.query(`create table if not exists degen_keeper (
    id integer primary key,
    private_key text not null
  )`);
  await sql.query(`create table if not exists degen_heartbeat (
    id integer primary key,
    at bigint not null
  )`);
  await sql.query(`create table if not exists degen_vaults (
    vault text primary key,
    owner text not null,
    universe text not null default 'meme',
    hold_ms integer not null default 120000,
    active boolean not null default true,
    eth double precision not null default 0,
    current_pool_id text,
    challenger_id text,
    challenger_since bigint,
    last_tick bigint,
    entered_at bigint,
    hops_json text not null default '[]',
    updated_at bigint
  )`);
  return sql;
}

export async function getKeeperAccount() {
  const envPk = env("KEEPER_PRIVATE_KEY");
  if (envPk && /^0x[0-9a-fA-F]{64}$/.test(envPk)) {
    const pk = envPk as Hex;
    return { pk, account: privateKeyToAccount(pk) };
  }
  if (!isWorkspacePreview()) {
    // A key generated into the database would sit next to the app data in
    // plaintext and control every vault. Production must inject it.
    throw new Error("KEEPER_PRIVATE_KEY is required when the app is deployed.");
  }
  const sql = await ensure();
  const rows = await sql.query<{ private_key: string }>(
    "select private_key from degen_keeper where id = 1",
  );
  let pk = rows[0]?.private_key as Hex | undefined;
  if (!pk) {
    pk = generatePrivateKey();
    await sql.query("insert into degen_keeper (id, private_key) values (1, $1)", [pk]);
  }
  return { pk, account: privateKeyToAccount(pk) };
}

export async function getKeeperPublic() {
  const { account } = await getKeeperAccount();
  return { address: account.address };
}

export async function confirmFromTx(input: {
  hash: string;
  owner: string;
  universe: DegenUniverse;
  holdMs: number;
}) {
  if (!isAddress(input.owner)) throw new Error("Invalid owner address.");
  if (!armAllowed(input.owner)) throw new Error("This wallet is not on the beta allowlist.");
  const universe = UNIVERSES.includes(input.universe) ? input.universe : "meme";
  const holdMs = Math.min(MAX_HOLD_MS, Math.max(MIN_HOLD_MS, Math.round(Number(input.holdMs)) || 0));

  const { vault, from, input: deployData, to } = await waitArmReceipt(input.hash as Hex);
  if (to) throw new Error("This transaction is not a vault deployment.");
  if (from.toLowerCase() !== input.owner.toLowerCase()) {
    throw new Error("This transaction did not come from this wallet.");
  }
  const { account } = await getKeeperAccount();
  // The deployment must be byte-for-byte the Perch vault wired to THIS keeper.
  // Otherwise anyone could register a fake contract and make the keeper pay gas on it.
  if (deployData.toLowerCase() !== encodeDeployDegen(account.address).toLowerCase()) {
    throw new Error("This is not a Perch vault deployment.");
  }
  await verifyVault(vault, input.owner, account.address);

  // Already registered: never touch its state. Re-submitting a public tx hash
  // must not reset a running vault.
  const existing = await getVaultByAddress(vault);
  if (existing) return serialize(existing);

  const on = await readVault(vault);
  return registerVault({ vault, owner: input.owner, universe, holdMs, eth: on.eth });
}

async function getVaultByAddress(vault: string) {
  const sql = await ensure();
  const rows = await sql.query<VaultRow>("select * from degen_vaults where vault = $1", [
    vault.toLowerCase(),
  ]);
  return rows[0] ?? null;
}

async function registerVault(input: {
  vault: string;
  owner: string;
  universe: DegenUniverse;
  holdMs: number;
  eth: number;
}) {
  const sql = await ensure();
  const now = Date.now();
  await sql.query(
    `insert into degen_vaults
      (vault, owner, universe, hold_ms, active, eth, current_pool_id, hops_json, entered_at, last_tick, updated_at)
     values ($1,$2,$3,$4,true,$5,null,'[]',$6,$6,$6)
     on conflict (vault) do nothing`,
    [
      input.vault.toLowerCase(),
      input.owner.toLowerCase(),
      input.universe,
      input.holdMs,
      input.eth,
      now,
    ],
  );
  startKeeperLoop();
  try {
    await tickVault(input.vault.toLowerCase());
  } catch (err) {
    console.error("[degen-keeper] first hop", err);
  }
  return getVaultByOwner(input.owner);
}

/** Owner proof: a personal_sign (EIP-191, or EIP-1271 for contract wallets) over a fresh message. */
async function assertOwnerSigned(owner: string, action: "pause" | "resume", auth: DegenAuth) {
  if (!authFresh(auth.timestamp)) throw new Error("The signature expired. Sign again.");
  const params = {
    address: owner as `0x${string}`,
    message: degenAuthMessage(action, owner, auth.timestamp),
    signature: auth.signature,
  };
  // Plain wallets: verify locally. Smart-contract wallets: ask the chain (EIP-1271).
  let ok = await verifyMessage(params).catch(() => false);
  if (!ok) ok = await publicClient().verifyMessage(params).catch(() => false);
  if (!ok) throw new Error("The signature does not match this wallet.");
}

export async function setVaultActive(owner: string, active: boolean, auth: DegenAuth) {
  if (!isAddress(owner)) throw new Error("Invalid owner address.");
  await assertOwnerSigned(owner, active ? "resume" : "pause", auth);
  const sql = await ensure();
  await sql.query(
    "update degen_vaults set active = $1, challenger_id = null, challenger_since = null, updated_at = $2 where owner = $3",
    [active, Date.now(), owner.toLowerCase()],
  );
  return getVaultByOwner(owner);
}

async function deactivate(vault: string) {
  const sql = await ensure();
  await sql.query(
    "update degen_vaults set active = false, challenger_id = null, challenger_since = null, updated_at = $1 where vault = $2",
    [Date.now(), vault.toLowerCase()],
  );
}

export async function getVaultByOwner(owner: string) {
  const sql = await ensure();
  const rows = await sql.query<VaultRow>(
    "select * from degen_vaults where owner = $1 order by updated_at desc limit 1",
    [owner.toLowerCase()],
  );
  const row = rows[0];
  if (!row) return null;
  return serialize(row);
}

function serialize(row: VaultRow) {
  let hops: unknown[] = [];
  try {
    hops = JSON.parse(row.hops_json || "[]") as unknown[];
  } catch {
    hops = [];
  }
  return {
    vault: row.vault,
    owner: row.owner,
    universe: row.universe,
    holdMs: Number(row.hold_ms),
    active: Boolean(row.active),
    eth: Number(row.eth),
    currentPoolId: row.current_pool_id,
    challengerId: row.challenger_id,
    challengerSince: row.challenger_since ? Number(row.challenger_since) : null,
    lastTick: row.last_tick ? Number(row.last_tick) : 0,
    enteredAt: row.entered_at ? Number(row.entered_at) : 0,
    hops: Array.isArray(hops) ? hops : [],
  };
}

async function tickVault(vault: string) {
  const locks = (g.__perchVaultLocks__ ??= new Set<string>());
  const key = vault.toLowerCase();
  if (keeperPaused()) return;
  if (locks.has(key)) return; // a hop for this vault is already in flight
  locks.add(key);
  try {
    await tickVaultLocked(key);
  } catch (err) {
    if (err instanceof VaultEmptyError) {
      await deactivate(key);
      return;
    }
    throw err;
  } finally {
    locks.delete(key);
  }
}

async function tickVaultLocked(vault: string) {
  const sql = await ensure();
  const rows = await sql.query<VaultRow>("select * from degen_vaults where vault = $1", [
    vault.toLowerCase(),
  ]);
  const row = rows[0];
  if (!row || !row.active) return;
  const { loadPoolsCached } = await import("./fetch-pools");
  const pools = await loadPoolsCached();
  const now = Date.now();

  if (!row.current_pool_id) {
    const top = rankForHunt(pools, row.universe, true)[0];
    if (top) await hopTo(row, top, pools, now, "enter");
    return;
  }

  const plan = planHunt({
    pools,
    universe: row.universe,
    onchain: true,
    currentPoolId: row.current_pool_id,
    challengerId: row.challenger_id,
    challengerSince: row.challenger_since ? Number(row.challenger_since) : null,
    holdMs: Number(row.hold_ms),
    now,
  });

  if (!plan.target) {
    await sql.query(
      `update degen_vaults set challenger_id = $1, challenger_since = $2, last_tick = $3, updated_at = $3 where vault = $4`,
      [plan.challengerId, plan.challengerSince, now, row.vault],
    );
    return;
  }

  await hopTo(row, plan.target, pools, now, "hunt");
}

async function hopTo(row: VaultRow, to: Pool, pools: Pool[], now: number, kind: "enter" | "hunt") {
  const { pk } = await getKeeperAccount();
  await operatorRebalance({ operatorPk: pk, vault: row.vault, pool: to });
  const from = row.current_pool_id
    ? pools.find((p) => p.id === row.current_pool_id)
    : undefined;
  let hops: unknown[] = [];
  try {
    hops = JSON.parse(row.hops_json || "[]") as unknown[];
  } catch {
    hops = [];
  }
  hops = [
    {
      id: `${now}`,
      at: now,
      kind,
      fromPair: from ? `${from.tokenA.symbol}/${from.tokenB.symbol}` : null,
      toPair: `${to.tokenA.symbol}/${to.tokenB.symbol}`,
      fromApr: from ? huntApr(from) : 0,
      toApr: huntApr(to),
      toPoolId: to.id,
      eth: Number(row.eth),
    },
    ...hops,
  ].slice(0, 40);
  const sql = await ensure();
  await sql.query(
    `update degen_vaults set
      current_pool_id = $1,
      challenger_id = null,
      challenger_since = null,
      entered_at = $2,
      last_tick = $2,
      hops_json = $3,
      updated_at = $2
     where vault = $4`,
    [to.id, now, JSON.stringify(hops), row.vault],
  );
}

export async function tickAllVaults() {
  if (g.__perchKeeperBusy__) return { skipped: true };
  g.__perchKeeperBusy__ = true;
  try {
    const sql = await ensure();
    // Proof that the scheduler is calling us, even with zero vaults (shown on /api/degen/status).
    await sql.query(
      "insert into degen_heartbeat (id, at) values (1, $1) on conflict (id) do update set at = excluded.at",
      [Date.now()],
    );
    const rows = await sql.query<VaultRow>("select * from degen_vaults where active = true");
    for (const row of rows) {
      try {
        await tickVault(row.vault);
      } catch (err) {
        console.error("[degen-keeper]", row.vault, err);
      }
    }
    return { ok: true, n: rows.length };
  } catch (err) {
    console.error("[degen-keeper] tickAll", err);
    return { ok: false };
  } finally {
    g.__perchKeeperBusy__ = false;
  }
}

export async function keeperStats() {
  const sql = await ensure();
  const vaults = await sql.query<{ active: number | string; total: number | string }>(
    "select count(*) filter (where active) as active, count(*) as total from degen_vaults",
  );
  const beat = await sql.query<{ at: number | string }>("select at from degen_heartbeat where id = 1");
  return {
    activeVaults: Number(vaults[0]?.active ?? 0),
    totalVaults: Number(vaults[0]?.total ?? 0),
    lastTickAt: beat[0] ? Number(beat[0].at) : null,
  };
}

export function startKeeperLoop() {
  if (g.__perchKeeperTimer__) return;
  g.__perchKeeperTimer__ = setInterval(() => {
    void tickAllVaults();
  }, 15_000);
  void tickAllVaults();
}
