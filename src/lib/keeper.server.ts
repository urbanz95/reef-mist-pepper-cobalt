import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { env } from "./env.server";
import { getSql } from "./db";
import { operatorRebalance, verifyVault, waitArmReceipt } from "./degen-chain";
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
};

async function ensure() {
  const sql = await getSql();
  await sql.query(`create table if not exists degen_keeper (
    id integer primary key,
    private_key text not null
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
  eth: number;
}) {
  const { vault, from } = await waitArmReceipt(input.hash as Hex);
  if (from.toLowerCase() !== input.owner.toLowerCase()) {
    throw new Error("This transaction did not come from this wallet.");
  }
  const { account } = await getKeeperAccount();
  await verifyVault(vault, input.owner, account.address);
  return registerVault({
    vault,
    owner: input.owner,
    universe: input.universe,
    holdMs: input.holdMs,
    eth: input.eth,
  });
}

export async function registerVault(input: {
  vault: string;
  owner: string;
  universe: DegenUniverse;
  holdMs: number;
  eth: number;
  currentPoolId?: string | null;
}) {
  const sql = await ensure();
  const now = Date.now();
  await sql.query(
    `insert into degen_vaults
      (vault, owner, universe, hold_ms, active, eth, current_pool_id, hops_json, entered_at, last_tick, updated_at)
     values ($1,$2,$3,$4,true,$5,$6,'[]',$7,$7,$7)
     on conflict (vault) do update set
       owner = excluded.owner,
       universe = excluded.universe,
       hold_ms = excluded.hold_ms,
       active = true,
       eth = excluded.eth,
       current_pool_id = excluded.current_pool_id,
       updated_at = excluded.updated_at`,
    [
      input.vault.toLowerCase(),
      input.owner.toLowerCase(),
      input.universe,
      input.holdMs,
      input.eth,
      input.currentPoolId ?? null,
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

export async function setVaultActive(owner: string, active: boolean) {
  const sql = await ensure();
  await sql.query(
    "update degen_vaults set active = $1, challenger_id = null, challenger_since = null, updated_at = $2 where owner = $3",
    [active, Date.now(), owner.toLowerCase()],
  );
  return getVaultByOwner(owner);
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

export function startKeeperLoop() {
  if (g.__perchKeeperTimer__) return;
  g.__perchKeeperTimer__ = setInterval(() => {
    void tickAllVaults();
  }, 15_000);
  void tickAllVaults();
}
