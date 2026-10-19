import assert from "node:assert/strict";
import { it } from "node:test";
import { newLiveBook, stepLiveBook } from "../src/lib/live-paper.ts";
import { decide, initialPolicy } from "../src/lib/degen-policy.ts";
import { normalizePools } from "./live-paper/market.mjs";
import { selectLaunchPools, LAUNCH_DISCOVERY_PATHS } from "./live-paper/universe.mjs";
import { poolCreationEvidence } from "./live-paper/pool-evidence.mjs";
import { CONTRACTS } from "../src/lib/chain.ts";
import { sampleSpotPool } from "./live-paper/spot-market.mjs";
import { reportFiles } from "./live-paper/report.mjs";
const t0 = 1000000;
const point = (now, price = 1, extra = {}) => ({
  id: "pool",
  label: "NEW / WETH",
  apr: 0,
  tvlUsd: 200000,
  createdAt: now - 1000,
  reviewed: true,
  factoryVerified: true,
  roundTripOk: true,
  costEth: 0.00015,
  entryCostEth: 0.0001,
  exitCostEth: 0.00005,
  priceEth: price,
  fetchedAt: now,
  metadataFresh: true,
  reserveEth: 100,
  ...extra,
});
function entered() {
  let book = newLiveBook(0.1, "launch");
  for (let i = 0; i < 40; i++) {
    const now = t0 + i * 15000;
    const r = stepLiveBook(book, [point(now, 1 + i * 0.003)], now);
    book = r.book;
    if (r.decision.action === "enter") return { book, now, price: 1 + i * 0.003 };
  }
  throw new Error("Expected confirmed entry");
}
it("launch enters a seconds-old pool after real momentum confirmation, without LP fee accrual", () => {
  const { book } = entered();
  assert.equal(book.state.current, "pool");
  assert.equal(book.fees, 0);
  assert.equal(book.value, 0.0999);
  assert.equal(book.ledger.length, 1);
  const o = {
    now: t0,
    fetchedAt: t0,
    schedulerHealthy: true,
    pending: false,
    valueEth: 0.1,
    currentApr: 0,
    currentTvlUsd: null,
    sellable: true,
    candidates: [{ ...point(t0), apr: 100, costEth: 0.0000001 }],
  };
  assert.equal(
    decide(initialPolicy(0.1), o).state.challenger,
    null,
    "live policy keeps its age rule",
  );
  assert.equal(
    decide(initialPolicy(0.1), { ...o, paperIgnorePoolAge: true }).state.challenger,
    "pool",
  );
});
it("launch requires momentum, cost coverage, fresh metadata and liquidity instead of forcing trades", () => {
  for (const extra of [
    {},
    { tvlUsd: 1 },
    { metadataFresh: false },
    { factoryVerified: false },
    { roundTripOk: false },
    { costEth: 1 },
  ]) {
    let b = newLiveBook(0.1, "launch");
    for (let i = 0; i < 30; i++)
      b = stepLiveBook(
        b,
        [point(t0 + i * 15000, Object.keys(extra).length ? 1 + i * 0.003 : 1, extra)],
        t0 + i * 15000,
      ).book;
    assert.equal(b.state.current, null);
  }
});
it("launch closes profit, time and protective exits with reconciling net PnL", () => {
  for (const type of ["profit", "time", "stop", "liquidity"]) {
    const e = entered(),
      now = e.now + (type === "time" ? 30 * 60000 : 15000);
    const r = stepLiveBook(
      e.book,
      [
        point(
          now,
          e.price * (type === "profit" ? 1.03 : type === "stop" ? 0.95 : 1),
          type === "liquidity" ? { reserveEth: 60 } : {},
        ),
      ],
      now,
    );
    assert.equal(r.decision.action, "exit", type);
    assert.equal(r.book.position, null);
    assert.equal(r.book.ledger[0].pnlEth, r.book.value - 0.1);
    assert.equal(r.book.state.halted, type === "stop" || type === "liquidity");
    assert.equal(r.book.fees, 0);
    assert.ok(r.book.ledger[0].exitAt);
    assert.equal(r.charged, 0.00005);
  }
});
it("missing exit quotes stay unknown and monitoring gaps reset confirmation", () => {
  const e = entered(),
    r = stepLiveBook(e.book, [], e.now + 15000);
  assert.equal(r.book.value, null);
  assert.equal(r.book.ledger[0].exitAt, null);
  assert.equal(r.decision.action, "blocked");
  let b = newLiveBook(0.1, "launch");
  for (let i = 0; i < 12; i++)
    b = stepLiveBook(b, [point(t0 + i * 15000, 1 + i * 0.003)], t0 + i * 15000).book;
  assert.ok(b.state.challenger);
  const now = t0 + 600000;
  const gap = stepLiveBook(b, [point(now, 1.1)], now);
  assert.equal(gap.decision.action, "blocked");
  assert.equal(gap.book.state.challenger, null);
});
it("a deterioration in simulated execution recovery reduces marked value instead of fabricating profit", () => {
  const e = entered();
  e.book.position.recoveryAtEntry = 0.995;
  const now = e.now + 15000,
    r = stepLiveBook(e.book, [point(now, e.price, { executionRecovery: 0.97 })], now);
  assert.ok(r.book.value < e.book.value * 0.98);
  assert.ok(r.book.ledger[0].pnlEth < 0);
});
it("launch selection retains candidates for confirmation, removes ineligible pools and prioritizes latest afterwards", () => {
  const pools = Array.from({ length: 8 }, (_, i) => ({ id: String(i), other: String(i) }));
  const first = selectLaunchPools(pools, null, t0),
    next = selectLaunchPools([...pools].reverse(), first.window, t0 + 120000);
  assert.deepEqual(next.selected, first.selected);
  assert.equal(
    selectLaunchPools(pools.slice(1), first.window, t0 + 150000).selected.some((p) => p.id === "0"),
    false,
  );
  assert.equal(
    selectLaunchPools([...pools].reverse(), first.window, t0 + 300000).selected[0].id,
    "7",
  );
  assert.ok(
    LAUNCH_DISCOVERY_PATHS.every((p) => p.includes("new_pools") || p.includes("trending_pools")),
  );
});
it("V4/native ETH and V2 are enabled only for the launch profile with actual token addresses", () => {
  const json = {
    included: [
      { type: "token", id: "a", attributes: { address: "0x" + "00".repeat(20) } },
      { type: "token", id: "b", attributes: { address: "0x" + "12".repeat(20) } },
    ],
    data: [
      {
        attributes: {
          address: "0x" + "34".repeat(32),
          reserve_in_usd: "200000",
          volume_usd: { h24: "10000" },
          pool_created_at: "2026-10-19",
        },
        relationships: {
          base_token: { data: { id: "a" } },
          quote_token: { data: { id: "b" } },
          dex: { data: { id: "uniswap-v4-robinhood" } },
        },
      },
    ],
  };
  assert.equal(normalizePools(json, true)[0].executionBlock, null);
  delete json.data[0].attributes.pool_created_at;
  assert.equal(
    normalizePools(json, true)[0].createdAt,
    0,
    "missing provider timestamp is not a hidden age gate",
  );
  assert.equal(normalizePools(json, true)[0].other, "0x" + "12".repeat(20));
  assert.ok(normalizePools(json)[0].executionBlock);
  json.included[0].attributes.address = CONTRACTS.weth;
  json.data[0].attributes.address = "0x" + "34".repeat(20);
  json.data[0].relationships.dex.data.id = "uniswap-v2-robinhood";
  assert.equal(normalizePools(json, true)[0].executionBlock, null);
});
it("canonical pool creation evidence cannot be mislabeled as launchpad migration", async () => {
  const pool = "0x" + "12".repeat(20),
    tx = "0x" + "34".repeat(32);
  const client = {
    getLogs: async () => [
      { address: CONTRACTS.v2Factory, args: { pair: pool }, transactionHash: tx, blockNumber: 1n },
    ],
  };
  const e = await poolCreationEvidence(
    client,
    pool,
    2,
    { currency0: CONTRACTS.weth, currency1: pool },
    { block: "10" },
  );
  assert.equal(e.status, "pool_creation_verified");
  assert.equal(e.transactionHash, tx);
  assert.equal(e.migrationStatus, "unconfirmed");
  assert.equal(
    (
      await poolCreationEvidence(
        {
          getLogs: async () => {
            throw new Error("RPC unavailable");
          },
        },
        pool,
        2,
        {},
        { block: "10" },
      )
    ).status,
    "creation_lookup_unavailable",
  );
});
it("spot adapters reject a counterfeit V2 factory before any buy/sell simulation", async () => {
  let probed = false;
  const client = {
    readContract: async ({ functionName }) =>
      functionName === "token0"
        ? CONTRACTS.weth
        : functionName === "token1"
          ? "0x" + "12".repeat(20)
          : "0x" + "00".repeat(20),
    call: async () => {
      probed = true;
    },
  };
  await assert.rejects(
    sampleSpotPool(
      client,
      { id: "0x" + "34".repeat(20), dex: "uniswap-v2-robinhood" },
      0.1,
      Date.now(),
      { block: "10" },
    ),
    /factory mismatch/,
  );
  assert.equal(probed, false);
});
it("CSV exports retain optional creation evidence even when the first pool is unsupported", () => {
  const r = {
    runId: "1",
    status: "completed",
    segment: 1,
    segments: 1,
    startedAt: "2026-10-19T00:00:00Z",
    updatedAt: "2026-10-19T01:00:00Z",
    samples: 1,
    verifiedQuotes: 1,
    errors: 0,
    books: [],
    trades: [],
    poolCoverage: [
      {
        label: "A",
        id: "a",
        tvlUsd: 1,
        observations: 1,
        probes: 0,
        failures: 0,
        lastReason: "unsupported",
      },
      {
        label: "B",
        id: "b",
        tvlUsd: 1,
        observations: 1,
        probes: 1,
        failures: 0,
        lastReason: "verified",
        creationTransaction: "0xabc",
        migrationStatus: "unconfirmed",
      },
    ],
    reasons: {},
    assumptions: [],
    equity: [],
  };
  const csv = reportFiles(r)["pools.csv"];
  assert.ok(csv.includes("creationTransaction"));
  assert.ok(csv.includes("0xabc"));
  assert.ok(csv.includes("unconfirmed"));
});
