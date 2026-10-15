import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";
import * as viem from "viem";
import * as accounts from "viem/accounts";
import * as crypto from "node:crypto";
import * as execution from "../src/lib/keeper-execution.ts";
import * as policy from "../src/lib/degen-policy.ts";
import * as auth from "../src/lib/degen-auth.ts";
const source = readFileSync(new URL("../src/lib/keeper.server.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText;
const vault = "0x" + "ab".repeat(20),
  owner = "0x" + "cd".repeat(20),
  hash = "0x" + "ef".repeat(32);
async function fixture({
  live = false,
  value = 1,
  failQuote = false,
  throwAfterJournal = false,
} = {}) {
  const pg = new PGlite();
  const sql = { query: async (q, p = []) => (await pg.query(q, p)).rows };
  let sends = 0,
    receipt = null;
  const env = {
    DEGEN_LIVE_ENABLED: live ? "true" : "false",
    KEEPER_PRIVATE_KEY: "0x" + "11".repeat(32),
    CRON_SECRET: "test",
  };
  const modules = {
    "node:crypto": crypto,
    viem: viem,
    "viem/accounts": accounts,
    "./env.server": { env: (k) => env[k], isDeployed: () => true },
    "./db": { getSql: async () => sql, dbSource: "neon" },
    "./degen-artifact": { DEGEN_BYTECODE: "0x00" },
    "../../migrations/0002_degen.sql?raw": readFileSync(
      new URL("../migrations/0002_degen.sql", import.meta.url),
      "utf8",
    ),
    "../../migrations/0003_degen_safety.sql?raw": readFileSync(
      new URL("../migrations/0003_degen_safety.sql", import.meta.url),
      "utf8",
    ),
    "./keeper-execution": execution,
    "./degen-policy": policy,
    "./degen-auth": auth,
    "./degen-logic": { rankForHunt: () => [] },
    "./chain": { CONTRACTS: { weth: "0x" + "01".repeat(20) } },
    "./fetch-pools": {
      loadTradingPools: async () => ({
        pools: [{ id: "old", tvlUsd: 500000, volume24h: 10000, feePct: 0.3 }],
        fetchedAt: Date.now(),
      }),
    },
    "./degen-chain": {
      readVault: async () => ({ tokenId: 1n, weth: 0n }),
      vaultVersion: async () => 2n,
      valueVault: async () => {
        if (failQuote) throw new Error("RPC quote unavailable");
        return { valueEth: value };
      },
      prepareExit: async () => ({ data: "0x1234", gas: 100000n }),
      broadcastPrepared: async (args) => {
        await args.beforeBroadcast(hash);
        sends++;
        if (throwAfterJournal) throw new Error("Connection lost after broadcast");
        return hash;
      },
      publicClient: () => ({
        getTransactionReceipt: async () => {
          if (!receipt) throw new Error("Not found");
          return receipt;
        },
        getBlockNumber: async () => 12n,
      }),
    },
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(
    (name) => {
      if (!(name in modules)) throw new Error(`Unexpected dependency ${name}`);
      return modules[name];
    },
    module,
    module.exports,
  );
  const keeper = module.exports;
  await keeper.keeperStats();
  await sql.query(
    `INSERT INTO degen_vaults(vault,owner,active,eth,current_pool_id) VALUES($1,$2,true,1,'old')`,
    [vault, owner],
  );
  const state = { ...policy.initialPolicy(1), current: "old", entryTvlUsd: 500000 };
  await sql.query("INSERT INTO degen_execution(vault,policy_json,updated_at) VALUES($1,$2,0)", [
    vault,
    JSON.stringify(state),
  ]);
  return {
    pg,
    sql,
    keeper,
    sends: () => sends,
    setReceipt: (r) => {
      receipt = r;
    },
  };
}
it("tick awaits work and does not swallow a per-vault error or advance a success heartbeat", async () => {
  const f = await fixture({ failQuote: true });
  try {
    const result = await f.keeper.tickAllVaults();
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /quote unavailable/);
    assert.equal((await f.keeper.keeperStats()).lastTickAt, null);
    assert.equal(f.sends(), 0);
  } finally {
    await f.pg.close();
  }
});
it("paper mode evaluates a risk exit without preparing or sending funds", async () => {
  const f = await fixture({ value: 0.9 });
  try {
    const result = await f.keeper.tickAllVaults();
    assert.equal(result.ok, true);
    assert.equal(result.processed, 1);
    assert.equal(f.sends(), 0);
    const row = await f.keeper.getVaultByOwner(owner);
    assert.equal(row.halted, true);
    assert.match(row.reason, /stop/);
    assert.equal(row.valueEth, 0.9);
  } finally {
    await f.pg.close();
  }
});
it("live risk exit writes ahead; unknown outcome cannot cause duplicate broadcasts", async () => {
  const f = await fixture({ live: true, value: 0.9, throwAfterJournal: true });
  try {
    const first = await f.keeper.tickAllVaults();
    assert.equal(first.ok, false);
    assert.equal(f.sends(), 1);
    assert.equal((await f.keeper.getVaultByOwner(owner)).pendingHash, hash);
    const second = await f.keeper.tickAllVaults();
    assert.equal(second.ok, false);
    assert.equal(f.sends(), 1);
    f.setReceipt({ status: "success", blockNumber: 10n });
    assert.equal((await f.keeper.tickAllVaults()).ok, true);
    assert.equal(f.sends(), 1);
    const row = await f.keeper.getVaultByOwner(owner);
    assert.equal(row.pendingHash, null);
    assert.equal(row.currentPoolId, null);
    assert.equal(row.active, false);
    assert.equal(row.halted, true);
  } finally {
    await f.pg.close();
  }
});
it("a reverted receipt latches the vault and cannot be mistaken for a completed trade", async () => {
  const f = await fixture({ live: true, value: 0.9 });
  try {
    await f.keeper.tickAllVaults();
    f.setReceipt({ status: "reverted", blockNumber: 10n });
    await f.keeper.tickAllVaults();
    const row = await f.keeper.getVaultByOwner(owner);
    assert.equal(row.active, false);
    assert.equal(row.currentPoolId, "old");
    assert.match(row.reason, /reverted/);
    assert.equal(f.sends(), 1);
  } finally {
    await f.pg.close();
  }
});
it("overlapping invocations return busy instead of a successful skipped tick", async () => {
  const f = await fixture();
  try {
    assert.equal(await execution.acquireLease(f.sql, "another-process"), true);
    const result = await f.keeper.tickAllVaults();
    assert.equal(result.ok, false);
    assert.equal(result.busy, true);
    assert.equal(f.sends(), 0);
  } finally {
    await f.pg.close();
  }
});
it("receipt reconciliation preserves an owner pause made while the trade was pending", async () => {
  const f = await fixture({ live: true });
  try {
    const state = { ...policy.initialPolicy(1), current: "old" };
    const decision = {
      action: "hop",
      reason: "test",
      state,
      target: { id: "new", tvlUsd: 500000 },
    };
    await f.sql.query("UPDATE degen_execution SET pending_hash=$1,pending_json=$2 WHERE vault=$3", [
      hash,
      JSON.stringify({ decision, valueEth: 1 }),
      vault,
    ]);
    await f.sql.query("UPDATE degen_vaults SET active=false WHERE vault=$1", [vault]);
    f.setReceipt({ status: "success", blockNumber: 10n });
    await f.keeper.tickAllVaults();
    const row = await f.keeper.getVaultByOwner(owner);
    assert.equal(row.currentPoolId, "new");
    assert.equal(row.active, false);
  } finally {
    await f.pg.close();
  }
});
