import { randomUUID } from "node:crypto";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { decodeAbiParameters, parseEther, verifyMessage, type Hex } from "viem";
import { env, isDeployed } from "./env.server";
import { getSql, dbSource } from "./db";
import baseSchema from "../../migrations/0002_degen.sql?raw";
import safetySchema from "../../migrations/0003_degen_safety.sql?raw";
import { DEGEN_BYTECODE } from "./degen-artifact";
import {
  broadcastPrepared,
  encodeDeployDegen,
  prepareExit,
  prepareRebalance,
  probeRoundTrip,
  publicClient,
  readVault,
  valueVault,
  vaultVersion,
  verifyVault,
  waitArmReceipt,
} from "./degen-chain";
import { authFresh, degenAuthMessage, isAddress, type DegenAuth } from "./degen-auth";
import { acquireLease, releaseLease, renewLease } from "./keeper-execution";
import {
  decide,
  initialPolicy,
  POLICY,
  settled,
  type Candidate,
  type Decision,
  type PolicyState,
} from "./degen-policy";
import { rankForHunt } from "./degen-logic";
import { CONTRACTS } from "./chain";
import { type DegenUniverse } from "./pools";

type VaultRow = {
  vault: string;
  owner: string;
  universe: DegenUniverse;
  active: boolean;
  eth: number;
  current_pool_id: string | null;
  last_tick: number | null;
  entered_at: number | null;
  hops_json: string;
};
type Execution = {
  vault: string;
  policy_json: string;
  reason: string;
  value_eth: number | null;
  valued_at: number | null;
  pending_hash: Hex | null;
  pending_json: string | null;
  last_error: string | null;
};
let schema: Promise<void> | undefined;
async function ensure() {
  const sql = await getSql();
  schema ??= (async () => {
    // Bundled SQL also covers prebuilt deployments where build-time DB credentials are absent.
    for (const statement of `${baseSchema}\n${safetySchema}`.split(";").filter((s) => s.trim()))
      await sql.query(statement);
  })().catch((e) => {
    schema = undefined;
    throw e;
  });
  await schema;
  return sql;
}
export function keeperPaused() {
  return env("KEEPER_PAUSED") === "1";
}
export function liveEnabled() {
  return env("DEGEN_LIVE_ENABLED") === "true";
}
export function approvedTokens(): string[] {
  return [
    ...new Set(
      (env("DEGEN_APPROVED_TOKENS") ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(isAddress),
    ),
  ].slice(0, 16);
}
export function armAllowed(owner: string) {
  const list = env("ARM_ALLOWLIST");
  return (
    !list ||
    list
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .includes(owner.toLowerCase())
  );
}
let previewKey: Hex | undefined;
export async function getKeeperAccount() {
  const key = env("KEEPER_PRIVATE_KEY");
  if (key && /^0x[0-9a-fA-F]{64}$/.test(key))
    return { pk: key as Hex, account: privateKeyToAccount(key as Hex) };
  if (isDeployed()) throw new Error("KEEPER_PRIVATE_KEY is required when the app is deployed.");
  previewKey ??= generatePrivateKey();
  return { pk: previewKey, account: privateKeyToAccount(previewKey) };
}
export async function getKeeperPublic() {
  return { address: (await getKeeperAccount()).account.address };
}
export async function liveReadiness() {
  const stats = await keeperStats();
  const fresh =
    stats.lastTickAt !== null && Date.now() - stats.lastTickAt <= POLICY.maxSchedulerGapMs;
  const reason = !liveEnabled()
    ? "Paper testing enabled. Real deposits are disabled."
    : keeperPaused()
      ? "Keeper paused."
      : dbSource !== "neon"
        ? "Persistent database required."
        : !env("CRON_SECRET")
          ? "Scheduler authentication is missing."
          : !/^0x[0-9a-fA-F]{64}$/.test(env("KEEPER_PRIVATE_KEY") ?? "")
            ? "Keeper key is missing or invalid."
            : !approvedTokens().length
              ? "No reviewed tokens configured."
              : !fresh
                ? "A continuous 15-second worker is required before deposits."
                : null;
  return { ready: reason === null, reason, tokens: approvedTokens() };
}
export async function confirmFromTx(input: {
  hash: string;
  owner: string;
  universe: DegenUniverse;
}) {
  if (!isAddress(input.owner)) throw new Error("Invalid owner address.");
  const tx = await waitArmReceipt(input.hash as Hex);
  if (tx.to || tx.from.toLowerCase() !== input.owner.toLowerCase())
    throw new Error("Deployment does not belong to this wallet.");
  if (!tx.input.toLowerCase().startsWith(DEGEN_BYTECODE.toLowerCase()))
    throw new Error("Unrecognized vault bytecode.");
  const args = decodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "address[]" },
    ],
    `0x${tx.input.slice(DEGEN_BYTECODE.length)}`,
  );
  const { account } = await getKeeperAccount();
  if (tx.input.toLowerCase() !== encodeDeployDegen(account.address, [...args[4]]).toLowerCase())
    throw new Error("Unexpected vault configuration.");
  const on = await verifyVault(tx.vault, input.owner, account.address);
  const sql = await ensure();
  const enabled =
    (await liveReadiness()).ready &&
    armAllowed(input.owner) &&
    args[4].every((t) => approvedTokens().includes(t.toLowerCase()));
  await sql.query(
    `INSERT INTO degen_vaults (vault,owner,universe,active,eth,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (vault) DO NOTHING`,
    [
      tx.vault.toLowerCase(),
      input.owner.toLowerCase(),
      ["meme", "all", "stock"].includes(input.universe) ? input.universe : "meme",
      enabled,
      on.eth,
      Date.now(),
    ],
  );
  // Register even when live is unavailable: the owner must retain recovery access.
  return getVaultByOwner(input.owner);
}
async function assertOwnerSigned(owner: string, action: "pause" | "resume", auth: DegenAuth) {
  if (!authFresh(auth.timestamp)) throw new Error("The signature expired. Sign again.");
  const params = {
    address: owner as Hex,
    message: degenAuthMessage(action, owner, auth.timestamp),
    signature: auth.signature,
  };
  let ok = await verifyMessage(params).catch(() => false);
  if (!ok)
    ok = await publicClient()
      .verifyMessage(params)
      .catch(() => false);
  if (!ok) throw new Error("The signature does not match this wallet.");
  const sql = await ensure();
  const used = await sql.query(
    "INSERT INTO degen_auth_used(signature,used_at) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING signature",
    [auth.signature.toLowerCase(), Date.now()],
  );
  if (!used.length) throw new Error("Signature already used. Sign again.");
}
export async function setVaultActive(owner: string, active: boolean, auth: DegenAuth) {
  if (!isAddress(owner)) throw new Error("Invalid owner.");
  if (active) {
    const readiness = await liveReadiness();
    if (!readiness.ready) throw new Error(readiness.reason!);
  }
  await assertOwnerSigned(owner, active ? "resume" : "pause", auth);
  const sql = await ensure();
  const row = await getVaultByOwner(owner);
  if (!row) throw new Error("No vault found.");
  if (active && row.halted)
    throw new Error("Risk stop is latched. Withdraw and review before creating another vault.");
  await sql.query("UPDATE degen_vaults SET active=$1,updated_at=$2 WHERE vault=$3", [
    active,
    Date.now(),
    row.vault,
  ]);
  return getVaultByOwner(owner);
}
export async function getVaultByOwner(owner: string) {
  const sql = await ensure();
  const rows = await sql.query<VaultRow>(
    "SELECT * FROM degen_vaults WHERE owner=$1 ORDER BY updated_at DESC LIMIT 1",
    [owner.toLowerCase()],
  );
  const row = rows[0];
  if (!row) return null;
  const e = (
    await sql.query<Execution>("SELECT * FROM degen_execution WHERE vault=$1", [row.vault])
  )[0];
  return {
    vault: row.vault,
    owner: row.owner,
    universe: row.universe,
    active: row.active,
    eth: Number(row.eth),
    currentPoolId: row.current_pool_id,
    lastTick: Number(row.last_tick ?? 0),
    enteredAt: Number(row.entered_at ?? 0),
    hops: JSON.parse(row.hops_json || "[]") as unknown[],
    reason: e?.last_error ?? e?.reason ?? "Awaiting observation",
    valueEth: e?.value_eth === null || !e ? null : Number(e.value_eth),
    valuedAt: Number(e?.valued_at ?? 0),
    pendingHash: e?.pending_hash ?? null,
    halted: e ? Boolean(JSON.parse(e.policy_json).halted) : false,
  };
}
async function execution(row: VaultRow) {
  const sql = await ensure();
  const state = { ...initialPolicy(Number(row.eth)), current: row.current_pool_id };
  await sql.query(
    "INSERT INTO degen_execution(vault,policy_json,updated_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
    [row.vault, JSON.stringify(state), Date.now()],
  );
  return (
    await sql.query<Execution>("SELECT * FROM degen_execution WHERE vault=$1", [row.vault])
  )[0];
}
async function reconcile(e: Execution) {
  if (!e.pending_hash) return false;
  const sql = await ensure();
  const receipt = await publicClient()
    .getTransactionReceipt({ hash: e.pending_hash })
    .catch(() => null);
  if (!receipt) throw new Error("Pending transaction outcome unknown; automatic resend disabled.");
  if ((await publicClient().getBlockNumber()) < receipt.blockNumber + 1n)
    throw new Error("Waiting for two confirmations.");
  const intent = JSON.parse(e.pending_json!) as { decision: Decision; valueEth: number };
  const prior = JSON.parse(e.policy_json) as PolicyState;
  const state =
    receipt.status === "success"
      ? settled(prior, intent.decision, Date.now(), intent.valueEth)
      : { ...prior, halted: true };
  // Two writes are replay-safe: pending is cleared LAST, so a crash replays the same receipt.
  await sql.query(
    "UPDATE degen_vaults SET current_pool_id=$1, active=CASE WHEN $2 THEN active ELSE false END, last_tick=$3, entered_at=$3, updated_at=$3 WHERE vault=$4",
    [state.current, !state.halted, Date.now(), e.vault],
  );
  await sql.query(
    "UPDATE degen_execution SET policy_json=$1,pending_hash=NULL,pending_json=NULL,reason=$2,last_error=NULL,updated_at=$3 WHERE vault=$4",
    [
      JSON.stringify(state),
      receipt.status === "success"
        ? `Confirmed ${intent.decision.action}`
        : "Transaction reverted; manual review required",
      Date.now(),
      e.vault,
    ],
  );
  return true;
}
async function tickVault(row: VaultRow, holder: string, monitoring: boolean) {
  const sql = await ensure();
  const e = await execution(row);
  if (e.pending_hash) {
    await reconcile(e);
    return;
  }
  if (!row.active) return;
  const on = await readVault(row.vault);
  if (on.tokenId === 0n && on.weth === 0n) {
    await sql.query("UPDATE degen_vaults SET active=false,current_pool_id=NULL WHERE vault=$1", [
      row.vault,
    ]);
    return;
  }
  if ((await vaultVersion(row.vault)) !== 2n)
    throw new Error(
      "Legacy contract: automatic trades disabled; raw withdrawal remains available.",
    );
  let state = JSON.parse(e.policy_json) as PolicyState;
  if (on.tokenId > 0n && !state.current)
    throw new Error("On-chain position differs from recorded state. Owner review required.");
  if (on.tokenId === 0n && state.current)
    throw new Error("Recorded position no longer exists. Owner review required.");
  const quote = await valueVault(row.vault); // failure cannot become zero value or a new trade
  const { loadTradingPools } = await import("./fetch-pools");
  const feed = await loadTradingPools().catch(() => ({ pools: [], fetchedAt: 0 }));
  const current = feed.pools.find((p) => p.id === state.current);
  const annual = (p: { volume24h: number; feePct: number; tvlUsd: number }) =>
    p.tvlUsd > 0 ? ((((p.volume24h * p.feePct) / 100) * 365) / p.tvlUsd) * 100 : 0;
  const observations = {
    now: Date.now(),
    fetchedAt: feed.fetchedAt,
    schedulerHealthy: monitoring,
    pending: false,
    valueEth: quote.valueEth,
    currentApr: current ? annual(current) : 0,
    currentTvlUsd: current?.tvlUsd ?? null,
    sellable: true,
    candidates: [] as Candidate[],
  };
  // Risk exits run before expensive discovery and never wait for a profitable replacement.
  let d = decide(state, observations);
  let prepared: { data: Hex; gas: bigint } | undefined;
  if (
    d.action !== "exit" &&
    !state.halted &&
    monitoring &&
    feed.fetchedAt &&
    (!state.lastTradeAt || Date.now() - state.lastTradeAt >= POLICY.cooldownMs) &&
    state.trades.filter((t) => Date.now() - t < 86_400_000).length < POLICY.maxTradesPerDay
  ) {
    const reviewed = approvedTokens();
    const top = rankForHunt(feed.pools, row.universe, true)
      .filter(
        (p) =>
          p.id !== state.current &&
          p.tvlUsd >= POLICY.minTvlUsd &&
          Date.now() - Date.parse(p.createdAt ?? "") >= POLICY.minPoolAgeMs &&
          reviewed.includes(
            (p.tokenA.address.toLowerCase() === CONTRACTS.weth.toLowerCase()
              ? p.tokenB.address
              : p.tokenA.address
            ).toLowerCase(),
          ),
      )
      .sort((a, b) => annual(b) - annual(a))[0];
    if (top) {
      const amount = parseEther(quote.valueEth.toFixed(18));
      const roundTrip = await probeRoundTrip(top, amount);
      const operator = (await getKeeperPublic()).address;
      prepared = await prepareRebalance({ operator, vault: row.vault, pool: top });
      const gasCost = (prepared as Awaited<ReturnType<typeof prepareRebalance>>).gasCostEth;
      const exitCost = state.current ? quote.valueEth * 0.01 : 0;
      observations.candidates.push({
        id: top.id,
        apr: annual(top),
        tvlUsd: top.tvlUsd,
        createdAt: Date.parse(top.createdAt!),
        reviewed: true,
        factoryVerified: true,
        roundTripOk: true,
        costEth: roundTrip.lossEth + gasCost + exitCost,
      });
      d = decide(state, observations);
    }
  }
  state = d.state;
  await sql.query(
    "UPDATE degen_execution SET policy_json=$1,reason=$2,value_eth=$3,valued_at=$4,last_error=NULL,updated_at=$4 WHERE vault=$5",
    [JSON.stringify(state), d.reason, quote.valueEth, Date.now(), row.vault],
  );
  await sql.query("UPDATE degen_vaults SET last_tick=$1 WHERE vault=$2", [Date.now(), row.vault]);
  if (!liveEnabled() || keeperPaused()) return;
  if (d.action === "exit") prepared = await prepareExit(row.vault, true);
  if (!["enter", "hop", "exit"].includes(d.action) || !prepared) return;
  // Global pending intent also fences nonce reuse if a previous process died.
  const pending = await sql.query(
    "SELECT vault FROM degen_execution WHERE pending_hash IS NOT NULL",
  );
  if (pending.length) throw new Error("Another transaction is awaiting reconciliation.");
  const { pk } = await getKeeperAccount();
  await broadcastPrepared({
    pk,
    vault: row.vault,
    ...prepared,
    beforeBroadcast: async (hash) => {
      await renewLease(sql, holder);
      const journal = await sql.query(
        `UPDATE degen_execution SET pending_hash=$1,pending_json=$2,reason=$3
      WHERE vault=$4 AND pending_hash IS NULL AND EXISTS (SELECT 1 FROM degen_vaults WHERE vault=$4 AND active=true) AND EXISTS
      (SELECT 1 FROM degen_lease WHERE id=1 AND holder=$5 AND expires_at>(extract(epoch from clock_timestamp())*1000)::bigint)
      RETURNING vault`,
        [
          hash,
          JSON.stringify({ decision: d, valueEth: quote.valueEth }),
          `Pending ${d.action}`,
          row.vault,
          holder,
        ],
      );
      if (!journal.length) throw new Error("Intent could not be fenced; transaction not sent");
    },
  });
}
export async function tickAllVaults() {
  const sql = await ensure();
  const holder = randomUUID();
  if (!(await acquireLease(sql, holder)))
    return { ok: false, busy: true, errors: ["Another tick is still running"] };
  const errors: string[] = [];
  let processed = 0;
  try {
    const beat = (await sql.query<{ at: number }>("SELECT at FROM degen_heartbeat WHERE id=1"))[0];
    const monitoring = !!beat && Date.now() - Number(beat.at) <= POLICY.maxSchedulerGapMs;
    const deadline = Date.now() + 40_000;
    const rows =
      await sql.query<VaultRow>(`SELECT v.* FROM degen_vaults v LEFT JOIN degen_execution e ON e.vault=v.vault
      WHERE v.active=true OR e.pending_hash IS NOT NULL ORDER BY v.last_tick ASC NULLS FIRST`);
    for (const row of rows) {
      if (Date.now() > deadline) {
        errors.push("Tick budget exceeded; monitoring capacity insufficient");
        break;
      }
      try {
        await renewLease(sql, holder);
        await tickVault(row, holder, monitoring);
        processed++;
      } catch (err) {
        const message = (err instanceof Error ? err.message : "Execution failed")
          .split("\n")[0]
          .slice(0, 180);
        errors.push(`${row.vault}: ${message}`);
        await sql.query("UPDATE degen_execution SET last_error=$1,updated_at=$2 WHERE vault=$3", [
          message,
          Date.now(),
          row.vault,
        ]);
      }
    }
    // Only completed checks count as monitoring. Failure must not paint a green heartbeat.
    if (!errors.length)
      await sql.query(
        "INSERT INTO degen_heartbeat(id,at) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET at=excluded.at",
        [Date.now()],
      );
    return {
      ok: errors.length === 0,
      processed,
      errors,
      mode: liveEnabled() ? "live" : "paper",
      monitoring,
    };
  } finally {
    await releaseLease(sql, holder);
  }
}
export async function keeperStats() {
  const sql = await ensure();
  const counts = (
    await sql.query<{ active: number; total: number }>(
      "SELECT count(*) FILTER(WHERE active) AS active,count(*) AS total FROM degen_vaults",
    )
  )[0];
  const beat = (await sql.query<{ at: number }>("SELECT at FROM degen_heartbeat WHERE id=1"))[0];
  const problems = await sql.query<{ vault: string; last_error: string }>(
    "SELECT vault,last_error FROM degen_execution WHERE last_error IS NOT NULL",
  );
  return {
    activeVaults: Number(counts.active),
    totalVaults: Number(counts.total),
    lastTickAt: beat ? Number(beat.at) : null,
    problems,
  };
}
