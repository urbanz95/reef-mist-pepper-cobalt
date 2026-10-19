import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeAbiParameters, zeroAddress } from "viem";
import { resolvePonsMeta, ponsLiquidityProtection } from "./live-paper/pons-market.mjs";
import { poolKeyHash } from "./live-paper/pool-key.mjs";
import { normalizePools } from "./live-paper/market.mjs";
import { selectPonsDiagnostics, PONS_DISCOVERY_PATHS } from "./live-paper/universe.mjs";
import { CONTRACTS } from "../src/lib/chain.ts";
import { PONS_STACKS } from "../src/lib/pons-contracts.ts";
import { createRiskMonitor, riskFromLog } from "./live-paper/risk-monitor.mjs";
import { paperReportSchema } from "../src/lib/paper-report.ts";
import { sampleSpotPool } from "./live-paper/spot-market.mjs";
import { paperVersion } from "../src/lib/paper-venues.ts";
const runtime = JSON.parse(readFileSync(new URL("./fixtures/pons-runtime.json", import.meta.url)));
const token = "0x" + "12".repeat(20),
  curve = "0x" + "34".repeat(20),
  stack = PONS_STACKS[0],
  snap = { block: "100" };
const key = {
  currency0: zeroAddress,
  currency1: token,
  fee: 0,
  tickSpacing: 200,
  hooks: stack.hook,
};
const id = poolKeyHash(key),
  pool = { id, other: token, dex: "pons-v2-dex" },
  curvePool = { id: curve, other: token, dex: "pons-v2" };
function fake(options = {}) {
  const record = {
    token,
    curve,
    deployer: "0x" + "56".repeat(20),
    pairToken: zeroAddress,
    exists: true,
    phase: 2,
    poolFee: 0,
    tickSpacing: 200,
    ...options.record,
  };
  const info = (BigInt(887200) << 32n) | (BigInt(16777216 - 887200) << 8n);
  const response = {
    factory: stack.factory,
    token,
    pairToken: zeroAddress,
    graduated: record.phase !== 0,
    readyToGraduate: record.phase !== 0,
    decimals: 18,
    locker: stack.locker,
    positionManager: CONTRACTS.v4PositionManager,
    memeHook: stack.hook,
    getLaunchedToken: record,
    poolKeys: Object.values(key),
    isLocked: true,
    lockedPositions: 1n,
    ownerOf: stack.locker,
    getApproved: zeroAddress,
    getPoolAndPositionInfo: [key, info],
    getPositionLiquidity: 100n,
    getLiquidity: 100n,
    ...options.read,
  };
  return {
    readContract: async ({ functionName, args }) => {
      if (!(functionName in response)) throw new Error("Unexpected " + functionName);
      return typeof response[functionName] === "function"
        ? response[functionName](args)
        : response[functionName];
    },
    getBytecode: async ({ address }) =>
      options.changedCode ? "0x6000" : runtime.code[address.toLowerCase()],
  };
}
it("Pons curve and graduated identifiers permit native ETH only in the paper profile", () => {
  assert.equal(paperVersion("__proto__"), 0);
  const json = {
    included: [
      { id: "a", type: "token", attributes: { address: zeroAddress } },
      { id: "b", type: "token", attributes: { address: token } },
    ],
    data: [
      {
        attributes: {
          address: curve,
          name: "TOKEN / ETH",
          reserve_in_usd: "200000",
          volume_usd: { h24: "10000" },
        },
        relationships: {
          base_token: { data: { id: "a" } },
          quote_token: { data: { id: "b" } },
          dex: { data: { id: "pons-v2" } },
        },
      },
    ],
  };
  assert.equal(normalizePools(json, true)[0].executionBlock, null);
  assert.ok(normalizePools(json)[0].executionBlock);
  json.data[0].attributes.address = id;
  json.data[0].relationships.dex.data.id = "pons-v2-dex";
  assert.equal(normalizePools(json, true)[0].executionBlock, null);
  json.data[0].attributes.address = curve;
  assert.match(normalizePools(json, true)[0].executionBlock, /identifier/);
  json.data[0].relationships.dex.data.id = "counterfeit";
  assert.match(normalizePools(json, true)[0].executionBlock, /Unsupported DEX/);
});
it("high-cost Pons execution is observable diagnostically but cannot pass the entry probe", async () => {
  const client = fake({ read: { getSlot0: [2n ** 96n, 0, 0, 0] } });
  client.call = async () => ({
    data: encodeAbiParameters(
      Array.from({ length: 4 }, () => ({ type: "uint256" })),
      [950000000000000n, 1000000000000000000n, 100000n, 100000n],
    ),
  });
  const market = { ...pool, wethUsd: 2400, fetchedAt: Date.now() },
    snapshot = { ...snap, at: Date.now(), gasPrice: 100000000n };
  await assert.rejects(
    sampleSpotPool(client, market, 0.001, market.fetchedAt, snapshot),
    /over 3%/,
  );
  const measured = await sampleSpotPool(client, market, 0.001, market.fetchedAt, snapshot, {
    diagnosticOnly: true,
  });
  assert.equal(measured.roundTripOk, false);
  assert.equal(measured.executionRecovery, 0.95);
  assert.equal(measured.quantityRaw, "1000000000000000000");
});
it("registered Pons V4 identity requires matching generation, code, currencies, curve and phase", async () => {
  const m = await resolvePonsMeta(fake(), pool, snap);
  assert.equal(m.version, 4);
  assert.equal(m.executionId, id);
  assert.equal(m.stack.factory, stack.factory);
  for (const options of [
    { changedCode: true },
    { record: { exists: false } },
    { record: { token: curve } },
    { read: { factory: token } },
    { read: { memeHook: token } },
    { read: { positionManager: token } },
    { read: { poolKeys: [zeroAddress, token, 0, 200, token] } },
  ])
    await assert.rejects(resolvePonsMeta(fake(options), pool, snap));
});
it("closed sell side, swept and rescued phases refuse curve entries; state is never cached across blocks", async () => {
  const client = fake({ record: { phase: 0 }, read: { graduated: false, readyToGraduate: false } });
  assert.equal((await resolvePonsMeta(client, curvePool, snap)).version, 5);
  for (const options of [
    { record: { phase: 0 }, read: { graduated: false, readyToGraduate: true } },
    { record: { phase: 1 } },
    { record: { phase: 3 } },
  ])
    await assert.rejects(
      resolvePonsMeta(fake(options), curvePool, snap),
      /closed|progress|rescued/,
    );
  let phase = 0;
  const dynamic = fake();
  const original = dynamic.readContract;
  dynamic.readContract = async (args) =>
    args.functionName === "getLaunchedToken"
      ? { ...(await original(args)), phase }
      : args.functionName === "graduated" || args.functionName === "readyToGraduate"
        ? phase === 2
        : original(args);
  const before = await resolvePonsMeta(dynamic, curvePool, snap);
  phase = 2;
  const after = await resolvePonsMeta(dynamic, curvePool, { block: "101" });
  assert.equal(before.executor.toLowerCase(), curve);
  assert.equal(after.executor, CONTRACTS.v4PoolManager);
  assert.equal(after.executionId, id);
  assert.equal(after.version, 4);
});
it("Pons permanent-lock proof checks owner, approval, full range, pool and 95% active-liquidity coverage", async () => {
  const ok = await ponsLiquidityProtection(fake(), pool, snap);
  assert.equal(ok.status, "approved");
  assert.equal(ok.fraction, 1);
  assert.equal(ok.evidence.positionId, "1");
  for (const read of [
    { ownerOf: token },
    { getApproved: token },
    { isLocked: false },
    { getPositionLiquidity: 94n },
    { getPositionLiquidity: 101n },
    { getPoolAndPositionInfo: [{ ...key, fee: 3000 }, 0n] },
    { getPoolAndPositionInfo: [key, 0n] },
  ])
    assert.equal((await ponsLiquidityProtection(fake({ read }), pool, snap)).status, "rejected");
  assert.equal(
    (
      await ponsLiquidityProtection(
        fake({ record: { phase: 0 }, read: { graduated: false, readyToGraduate: false } }),
        curvePool,
        snap,
      )
    ).status,
    "unknown",
  );
});
it("diagnostic sampling covers both stages without a liquidity/age bypass for admission", () => {
  const now = 1000000,
    pools = [
      { ...curvePool, fetchedAt: now, executionBlock: null, tvlUsd: 1 },
      { ...pool, fetchedAt: now, executionBlock: null, tvlUsd: 200000 },
    ];
  assert.equal(selectPonsDiagnostics(pools, now).length, 2);
  assert.equal(selectPonsDiagnostics(pools, now + 600001).length, 0);
  assert.ok(PONS_DISCOVERY_PATHS.some((p) => p.includes("pons-v2-dex")));
});
it("a migrated held curve is watched at its V4 pool ID; factory state changes request an exit", async () => {
  const requests = [],
    monitor = createRiskMonitor(
      {
        getBlockNumber: async () => 101n,
        request: async ({ params: [f] }) => {
          requests.push(f);
          return [];
        },
      },
      () => 1000,
    );
  monitor.setPositions([
    {
      pool: curve,
      watchPool: id,
      token,
      factory: stack.factory,
      entryBlock: "100",
      entryDepthEth: 10,
      dex: "pons-v2",
    },
  ]);
  await monitor.poll();
  assert.ok(requests.some((f) => f.address === CONTRACTS.v4PoolManager && f.topics[1] === id));
  assert.ok(requests.some((f) => f.address === stack.factory));
  const result = riskFromLog(
    { address: stack.factory, blockNumber: "0x65", transactionHash: "0x" + "11".repeat(32) },
    { pool: curve, token, factory: stack.factory },
  );
  assert.equal(result.alert.pool, curve);
  assert.match(result.alert.reason, /state changed/);
  await monitor.stop();
});
