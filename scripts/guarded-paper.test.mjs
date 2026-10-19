import assert from "node:assert/strict";
import { it } from "node:test";
import { validateGuardedCheckpoint } from "../src/lib/guarded-paper.ts";
import { newLiveBook, stepLiveBook } from "../src/lib/live-paper.ts";
import { assessTokenSecurity, positionBudget } from "../src/lib/paper-risk.ts";
import { completeReport, resumeReport } from "./live-paper/report.mjs";
import { createSecurityProvider, liquidityProtection } from "./live-paper/security.mjs";
import { resolveSpotMeta } from "./live-paper/spot-market.mjs";
import { CONTRACTS } from "../src/lib/chain.ts";
import { createRiskMonitor, riskFromLog } from "./live-paper/risk-monitor.mjs";
import { encodeAbiParameters, encodeEventTopics, parseAbi, parseEther } from "viem";
const t0 = 1000000;
const addr = (n) => "0x" + n.toString(16).padStart(40, "0");
const quote = (pool, quantityRaw, now, receivedEth = 0.001899, extra = {}) => ({
  pool,
  quantityRaw,
  receivedEth,
  gasEth: 0.000001,
  fetchedAt: now,
  block: "100",
  ...extra,
});
const point = (id, now, price = 1, extra = {}) => ({
  id,
  token: addr(id === "a" ? 1 : 2),
  label: id,
  apr: 0,
  tvlUsd: 200000,
  createdAt: now - 1,
  reviewed: true,
  factoryVerified: true,
  roundTripOk: true,
  metadataFresh: true,
  costEth: 0.000003,
  entryCostEth: 0.000002,
  exitCostEth: 0.000001,
  priceEth: price,
  reserveEth: 100,
  fetchedAt: now,
  block: "100",
  buyInputEth: 0.0019,
  buyGasEth: 0.000001,
  quantityRaw: "1000000",
  entryExitQuote: quote(id, "1000000", now),
  security: {
    token: addr(id === "a" ? 1 : 2),
    liquidityBlock: "100",
    status: "approved",
    checkedAt: now,
    reasons: [],
    actors: [addr(id === "a" ? 11 : 12)],
    source: "fixture",
  },
  ...extra,
});
function entered(two = true, transform = (p) => p) {
  let book = newLiveBook(0.1, "guarded");
  for (let i = 0; i < 40; i++) {
    const now = t0 + i * 15000,
      points = (two ? ["a", "b"] : ["a"]).map((id) => transform(point(id, now, 1 + i * 0.003)));
    const result = stepLiveBook(book, points, now, { monitorHealthy: true });
    book = result.book;
    if (book.positions.length) return { ...result, now };
  }
  return { book, now: t0 + 39 * 15000 };
}
it("two independent positions allocate at most 2% each and retain 96% cash; entry age has no minimum", () => {
  const { book, events } = entered();
  assert.equal(book.positions.length, 2);
  assert.equal(events.length, 2);
  assert.ok(book.cash >= 0.096 - 1e-12);
  assert.ok(book.positions.every((p) => p.allocationEth <= 0.002));
  assert.equal(book.ledger.length, 2);
  assert.equal(book.positions[0].quantityRaw, "1000000");
  assert.equal(book.fees, 0);
  assert.equal(book.position, null);
});
it("unknown security, stale data, wrong quantity/block, high costs and unverified identity block entries", () => {
  const transforms = [
    (p) => ({ ...p, security: { ...p.security, token: addr(200) } }),
    (p) => ({ ...p, security: { ...p.security, liquidityBlock: "99" } }),
    (p) => ({ ...p, security: { ...p.security, status: "unknown" } }),
    (p) => ({ ...p, security: { ...p.security, checkedAt: p.fetchedAt - 60001 } }),
    (p) => ({ ...p, entryExitQuote: { ...p.entryExitQuote, quantityRaw: "1" } }),
    (p) => ({ ...p, entryExitQuote: { ...p.entryExitQuote, block: "99" } }),
    (p) => ({ ...p, buyGasEth: 0.0002 }),
    (p) => ({ ...p, factoryVerified: false }),
    (p) => ({ ...p, metadataFresh: undefined }),
  ];
  for (const transform of transforms)
    assert.equal(entered(false, transform).book.positions.length, 0);
});
it("same token in different fee pools or shared issuer/large holder cannot create correlated simultaneous positions", () => {
  for (const type of ["token", "actor"]) {
    const { book } = entered(true, (p) =>
      p.id === "b"
        ? {
            ...p,
            ...(type === "token"
              ? { token: addr(1), security: { ...p.security, token: addr(1) } }
              : { security: { ...p.security, actors: [addr(11)] } }),
          }
        : p,
    );
    assert.equal(book.positions.length, 1, type);
  }
});
it("two independent exits and PnL reconcile without dropping either operation", () => {
  const e = entered(),
    now = e.now + 5000;
  const quotes = e.book.positions.map((p) => quote(p.pool, p.quantityRaw, now, 0.0021));
  const r = stepLiveBook(e.book, [], now, { monitorHealthy: true, exitQuotes: quotes });
  assert.equal(r.events.filter((e) => e.action === "exit").length, 2);
  assert.equal(r.book.positions.length, 0);
  assert.equal(r.book.state.halted, false);
  const pnl = r.book.ledger.reduce((n, t) => n + t.pnlEth, 0);
  assert.ok(Math.abs(pnl - (r.book.value - 0.1)) < 1e-12);
  assert.ok(r.book.ledger.every((t) => t.exitAt && t.costsEth === 0.000002));
  assert.equal(r.book.cash, r.book.value);
});
it("a complete token collapse affects only the allocated slice, latches entries and keeps the second position monitored", () => {
  const e = entered(),
    now = e.now + 5000;
  const r = stepLiveBook(e.book, [], now, {
    monitorHealthy: true,
    exitQuotes: [quote("a", "1000000", now, 0), quote("b", "1000000", now)],
  });
  assert.equal(r.book.positions.length, 1);
  assert.equal(r.book.positions[0].pool, "b");
  assert.equal(r.book.state.halted, true);
  assert.ok(r.book.value > 0.0979);
  assert.ok(r.book.cash > 0.096);
  assert.ok(r.book.ledger[0].pnlEth >= -0.002);
});
it("failed, stale or mismatched held sales stay open with unknown value, never fictitious zero or an exit", () => {
  for (const bad of [
    [],
    [quote("a", "1", 0)],
    [quote("a", "1000000", 0)],
    [quote("a", "1000000", t0 + 600000, 1, { block: "99" })],
  ]) {
    const e = entered(false),
      now = e.now + 5000;
    const r = stepLiveBook(e.book, [], now, { monitorHealthy: true, exitQuotes: bad });
    assert.equal(r.book.value, null);
    assert.equal(r.book.cash, 0.098);
    assert.equal(r.book.ledger[0].exitAt, null);
    assert.equal(r.book.ledger[0].pnlEth, null);
  }
});
it("exit gas cannot spend the unallocated wallet balance; alarms persist across missing quotes", () => {
  const e = entered(false),
    now = e.now + 5000;
  let r = stepLiveBook(e.book, [], now, {
    monitorHealthy: true,
    alerts: [{ pool: "a", reason: "LP removed", block: "101" }],
  });
  assert.equal(r.book.state.halted, true);
  assert.match(r.book.positions[0].exitRequested, /LP removed/);
  r = stepLiveBook(r.book, [], now + 5000, {
    monitorHealthy: true,
    exitQuotes: [quote("a", "1000000", now + 5000, 0.001, { gasEth: 0.01 })],
  });
  assert.equal(r.book.cash, 0.098);
  assert.equal(r.book.positions.length, 1);
  assert.equal(r.book.ledger[0].exitAt, null);
});
it("monitoring failure requests a quoted exit, while a gap resets entry confirmation", () => {
  const e = entered(false),
    now = e.now + 5000;
  const r = stepLiveBook(e.book, [], now, {
    monitorHealthy: false,
    exitQuotes: [quote("a", "1000000", now)],
  });
  assert.equal(r.book.positions.length, 0);
  assert.match(r.book.ledger[0].exitReason, /monitoring/);
  assert.equal(r.book.state.halted, true);
  let b = newLiveBook(0.1, "guarded");
  for (let i = 0; i < 12; i++) {
    const at = t0 + i * 15000;
    b = stepLiveBook(b, [point("a", at, 1 + i * 0.003)], at, { monitorHealthy: true }).book;
  }
  const gap = stepLiveBook(b, [point("a", t0 + 600000, 1.2)], t0 + 600000, {
    monitorHealthy: true,
  });
  assert.deepEqual(gap.book.challenges, {});
});
it("open-position PnL sums both positions and stays unknown if either cannot be valued; resume never reinterprets legacy state", () => {
  const { book } = entered(),
    run = { books: [book] };
  const full = completeReport(run);
  assert.ok(Math.abs(full.books[0].openPnlEth - (book.value - 0.1)) < 1e-12);
  book.ledger[1].pnlEth = null;
  assert.equal(completeReport(run).books[0].openPnlEth, null);
  assert.throws(() => stepLiveBook({ ...book, portfolioVersion: undefined }, [], t0), /checkpoint/);
  assert.throws(
    () =>
      resumeReport(
        { ...run, runId: "1", status: "segment_complete", segment: 1 },
        { runId: "2", capitals: [0.1], strategy: "guarded", segment: 2 },
      ),
    /Checkpoint/,
  );
  assert.ok(positionBudget(0.1, 0.099999, 0.098, [book.positions[0]]) < 0.002);
});
const flags = [
  "is_proxy",
  "is_mintable",
  "hidden_owner",
  "owner_change_balance",
  "can_take_back_ownership",
  "selfdestruct",
  "external_call",
  "slippage_modifiable",
  "personal_slippage_modifiable",
  "transfer_pausable",
  "is_blacklisted",
  "is_whitelisted",
  "is_honeypot",
  "cannot_buy",
  "cannot_sell_all",
  "honeypot_with_same_creator",
];
const raw = () => ({
  ...Object.fromEntries(flags.map((k) => [k, "0"])),
  is_open_source: "1",
  buy_tax: "0",
  sell_tax: "0",
  transfer_tax: "0",
  creator_address: addr(20),
  owner_address: addr(0),
  creator_percent: "0",
  owner_percent: "0",
  holder_count: "100",
  holders: Array.from({ length: 10 }, (_, i) => ({ address: addr(30 + i), percent: "0.01" })),
});
const assess = (r, lp = { status: "approved", fraction: 0.99, reason: "burn proof" }) =>
  assessTokenSecurity(r, { id: addr(100), other: addr(1) }, t0, t0, lp);
it("explicit source, powers, zero taxes, holder coverage and on-chain LP proof are ALL required", () => {
  assert.equal(assess(raw()).status, "approved");
  for (const flag of flags) {
    assert.equal(assess({ ...raw(), [flag]: "1" }).status, "rejected", flag);
    const r = raw();
    delete r[flag];
    assert.equal(assess(r).status, "unknown", flag);
  }
  for (const r of [
    { ...raw(), sell_tax: ".01" },
    { ...raw(), creator_percent: ".02" },
    { ...raw(), holders: [{ address: addr(30), percent: ".50" }, ...raw().holders.slice(1)] },
  ])
    assert.equal(assess(r).status, "rejected");
  assert.equal(assess({ ...raw(), holders: undefined }).status, "unknown");
  assert.equal(assess(raw(), { status: "unknown", reason: "V4 rights unknown" }).status, "unknown");
  // Mimi passed a honeypot check but its LP was controlled by an unlocked contract.
  assert.equal(
    assess(raw(), { status: "rejected", fraction: 0, reason: "LP unprotected" }).status,
    "rejected",
  );
});
it("liquidity proof requires 95% burned canonical V2 LP, not a provider claim of a lock", async () => {
  const client = {
    readContract: async ({ functionName, args }) =>
      functionName === "totalSupply" ? 100000n : args[0] === addr(0) ? 1000n : 94000n,
  };
  assert.equal(
    (await liquidityProtection(client, { id: addr(100), dex: "uniswap-v2-robinhood" }, "1")).status,
    "approved",
  );
  assert.equal(
    (
      await liquidityProtection(
        {
          ...client,
          readContract: async ({ functionName }) =>
            functionName === "totalSupply" ? 100000n : 1000n,
        },
        { id: addr(100), dex: "uniswap-v2-robinhood" },
        "1",
      )
    ).status,
    "rejected",
  );
  assert.equal(
    (await liquidityProtection(client, { id: addr(100), dex: "uniswap-v4-robinhood" }, "1")).status,
    "unknown",
  );
});
it("security provider obeys retry-after and never makes a failed refresh or cached response look fresh", async () => {
  let now = t0,
    calls = 0;
  const provider = createSecurityProvider(
    async () => {
      calls++;
      return calls === 1
        ? Response.json({ code: 1, result: { [addr(1)]: raw() } }, { headers: { age: "5" } })
        : new Response("", { status: 429, headers: { "retry-after": "120" } });
    },
    () => now,
  );
  await provider.refresh([addr(1)]);
  assert.equal(provider.get(addr(1)).checkedAt, t0 - 5000);
  now += 30000;
  await provider.refresh([addr(1)]);
  assert.equal(calls, 2);
  assert.equal(provider.get(addr(1)).checkedAt, t0 - 5000);
  now += 60000;
  await provider.refresh([addr(1)]);
  assert.equal(calls, 2);
  assert.equal(
    assessTokenSecurity(
      provider.get(addr(1)).raw,
      { id: addr(100) },
      provider.get(addr(1)).checkedAt,
      now,
      { status: "approved" },
    ).status,
    "unknown",
  );
});
const sync = parseAbi(["event Sync(uint112 reserve0,uint112 reserve1)"]);
const log = (block, r0 = 1000000000000000000n) => ({
  address: addr(100),
  blockNumber: "0x" + BigInt(block).toString(16),
  logIndex: "0x0",
  transactionHash: "0x" + "11".repeat(32),
  topics: encodeEventTopics({ abi: sync, eventName: "Sync" }),
  data: encodeAbiParameters([{ type: "uint112" }, { type: "uint112" }], [r0, 1000000000000000000n]),
});
it("block monitor scans intervening ranges, retries a failed range and catches reserve collapse", async () => {
  let failed = true;
  const requests = [];
  const client = {
    getBlockNumber: async () => 5000n,
    request: async ({ params: [filter] }) => {
      requests.push(filter);
      if (failed) {
        failed = false;
        throw new Error("RPC");
      }
      return filter.address === addr(100) && filter.fromBlock === "0xbb8" ? [log(3001, 1n)] : [];
    },
  };
  const monitor = createRiskMonitor(client, () => t0);
  monitor.setPositions([
    {
      pool: addr(100),
      token: addr(1),
      entryBlock: "1000",
      entryDepthEth: 100,
      funding0: true,
      dex: "uniswap-v2-robinhood",
    },
  ]);
  await monitor.poll();
  assert.equal(monitor.snapshot.healthy, false);
  await monitor.poll();
  assert.equal(monitor.snapshot.healthy, true);
  assert.equal(
    requests.filter((f) => f.fromBlock === "0x3e8" && f.address === addr(100)).length,
    2,
  );
  assert.ok(requests.some((f) => f.fromBlock === "0xbb8" && f.toBlock === "0x1387"));
  assert.ok(requests.some((f) => f.fromBlock === "0x1388" && f.toBlock === "0x1388"));
  assert.match(monitor.snapshot.alerts[0].reason, /reserves/);
  monitor.setPositions([]);
  assert.deepEqual(monitor.snapshot.alerts, []);
  await monitor.stop();
});
it("Mimi-like near-zero ETH reserve changes are risk alarms even when fresh roundtrip honeypot probes pass", () => {
  const r = riskFromLog(
    log(101, 1230749489738n),
    { pool: addr(100), token: addr(1), funding0: true },
    52.880302998848,
  );
  assert.match(r.alert.reason, /10%/);
});

it("guarded checkpoints preserve both positions, exact quantities, cash and gas reserves; damaged accounting is rejected", () => {
  const { book } = entered();
  const restored = JSON.parse(JSON.stringify(book));
  validateGuardedCheckpoint(restored);
  assert.deepEqual(
    restored.positions.map((p) => [p.quantityRaw, p.exitReserveEth]),
    book.positions.map((p) => [p.quantityRaw, p.exitReserveEth]),
  );
  for (const mutate of [
    (b) => (b.cash += 0.001),
    (b) => (b.positions[0].quantityRaw = "0"),
    (b) => (b.positions[0].exitReserveEth = 0),
    (b) => b.ledger.pop(),
    (b) => (b.value = 0),
  ]) {
    const bad = structuredClone(restored);
    mutate(bad);
    assert.throws(() => validateGuardedCheckpoint(bad), /accounting/);
  }
});
it("block monitor checkpoints keep the exact cursor and retry only unscanned blocks after restoration", async () => {
  const filters = [],
    position = {
      pool: addr(100),
      token: addr(1),
      entryBlock: "100",
      entryDepthEth: 100,
      funding0: true,
      dex: "uniswap-v2-robinhood",
    };
  let head = 105n;
  const client = {
    getBlockNumber: async () => head,
    request: async ({ params: [f] }) => {
      filters.push(f);
      return [];
    },
  };
  const first = createRiskMonitor(client, () => t0);
  first.setPositions([position]);
  await first.poll();
  const saved = JSON.parse(JSON.stringify(first.checkpoint));
  await first.stop();
  head = 108n;
  const second = createRiskMonitor(client, () => t0, saved);
  second.setPositions([position]);
  await second.poll();
  assert.equal(filters[2].fromBlock, "0x6a");
  assert.equal(filters[2].toBlock, "0x6c");
  assert.equal(second.snapshot.healthy, true);
  await second.stop();
});
it("mint, ownership changes and V2/V3/V4 withdrawal logs request exits", () => {
  const position = { pool: addr(100), token: addr(1), funding0: true };
  const cases = [
    [
      "event Transfer(address indexed from,address indexed to,uint256 value)",
      "Transfer",
      { from: addr(0), to: addr(2) },
      [{ type: "uint256" }],
      [1n],
      addr(1),
    ],
    [
      "event OwnershipTransferred(address indexed previousOwner,address indexed newOwner)",
      "OwnershipTransferred",
      { previousOwner: addr(2), newOwner: addr(3) },
      [],
      [],
      addr(1),
    ],
    [
      "event Burn(address indexed sender,uint256 amount0,uint256 amount1,address indexed to)",
      "Burn",
      { sender: addr(2), to: addr(3) },
      [{ type: "uint256" }, { type: "uint256" }],
      [1n, 1n],
      addr(100),
    ],
    [
      "event Burn(address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)",
      "Burn",
      { owner: addr(2), tickLower: -60, tickUpper: 60 },
      [{ type: "uint128" }, { type: "uint256" }, { type: "uint256" }],
      [1n, 1n, 1n],
      addr(100),
    ],
    [
      "event ModifyLiquidity(bytes32 indexed id,address indexed sender,int24 tickLower,int24 tickUpper,int256 liquidityDelta,bytes32 salt)",
      "ModifyLiquidity",
      { id: "0x" + "11".repeat(32), sender: addr(2) },
      [{ type: "int24" }, { type: "int24" }, { type: "int256" }, { type: "bytes32" }],
      [-60, 60, -1n, "0x" + "00".repeat(32)],
      addr(100),
    ],
  ];
  for (const [signature, eventName, args, types, values, address] of cases) {
    const abi = parseAbi([signature]),
      topics = encodeEventTopics({ abi, eventName, args }),
      data = encodeAbiParameters(types, values);
    const r = riskFromLog(
      { ...log(101), address, topics, data },
      { ...position, ...(eventName === "ModifyLiquidity" ? { pool: "0x" + "11".repeat(32) } : {}) },
      100,
    );
    assert.ok(r.alert, eventName);
  }
});
it("HTTP-date retry-after is honored and malformed values cannot disable throttling", async () => {
  for (const retry of [new Date(t0 + 120000).toUTCString(), "invalid"]) {
    let now = t0,
      calls = 0;
    const provider = createSecurityProvider(
      async () => {
        calls++;
        return new Response("", { status: 429, headers: { "retry-after": retry } });
      },
      () => now,
    );
    await provider.refresh([addr(1)]);
    now += 1000;
    await provider.refresh([addr(1)]);
    assert.equal(calls, 1);
    if (retry !== "invalid") {
      now += 60000;
      await provider.refresh([addr(1)]);
      assert.equal(calls, 1);
    }
  }
});

it("cached execution metadata cannot bind security for a different token or protocol", async () => {
  const pool = { id: addr(201), other: addr(1), dex: "uniswap-v2-robinhood" };
  const client = {
    readContract: async ({ functionName }) =>
      functionName === "token0"
        ? CONTRACTS.weth
        : functionName === "token1"
          ? addr(1)
          : functionName === "getPair"
            ? addr(201)
            : 18,
    getLogs: async () => [],
  };
  await resolveSpotMeta(client, pool, { block: "100" });
  await assert.rejects(
    resolveSpotMeta(client, { ...pool, other: addr(2) }, { block: "101" }),
    /identity mismatch/,
  );
  await assert.rejects(
    resolveSpotMeta(client, { ...pool, dex: "uniswap-v3-robinhood" }, { block: "101" }),
    /identity mismatch/,
  );
});
