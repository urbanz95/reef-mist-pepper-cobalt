import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync } from "node:fs";
import { newLiveBook, stepLiveBook } from "../src/lib/live-paper.ts";
import { validateGuardedCheckpoint } from "../src/lib/guarded-paper.ts";
import { POLICY } from "../src/lib/degen-policy.ts";
import { PAPER_ROTATION as R } from "../src/lib/paper-risk.ts";
import {
  verifyPonsTokenRuntime,
  applyPonsTokenProof,
  PONS_TOKEN_TEMPLATE_HASH,
} from "./live-paper/pons-token.mjs";
import { rankGuardedPools, selectGuardedPools } from "./live-paper/universe.mjs";
import ganache from "ganache";
import {
  createPublicClient,
  custom,
  parseAbi,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  toHex,
} from "viem";

const t0 = 1_000_000,
  addr = (i) => "0x" + i.toString(16).padStart(40, "0");
const sale = (id, now, proceeds = 0.001899) => ({
  pool: id,
  quantityRaw: "1000000",
  receivedEth: proceeds,
  gasEth: 0.000001,
  fetchedAt: now,
  block: "100",
});
const point = (id, now, price, extra = {}) => ({
  id,
  token: addr(id.charCodeAt(0)),
  label: id,
  apr: 0,
  tvlUsd: 25000,
  createdAt: now,
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
  entryExitQuote: sale(id, now),
  security: {
    token: addr(id.charCodeAt(0)),
    liquidityBlock: "100",
    status: "approved",
    checkedAt: now,
    reasons: [],
    actors: [addr(id.charCodeAt(0) + 100)],
    source: "fixture",
  },
  ...extra,
});
function enter(ids = ["a"], transform = (p) => p) {
  let book = newLiveBook(0.1, "guarded"),
    result;
  for (let ms = 0; ms <= 90000; ms += 15000) {
    const now = t0 + ms;
    result = stepLiveBook(
      book,
      ids.map((id) => transform(point(id, now, 1 + ms / 5_000_000))),
      now,
      { monitorHealthy: true },
    );
    book = result.book;
    if (ms < 90000) assert.equal(book.positions.length, 0);
  }
  return { ...result, now: t0 + 90000 };
}
it("paper spot admits a $25k executable pool after 90 seconds while live keeper parameters remain unchanged", () => {
  const r = enter();
  assert.equal(r.book.positions.length, 1);
  assert.equal(r.signals[0].status, "ready");
  assert.equal(POLICY.minTvlUsd, 100000);
  validateGuardedCheckpoint(r.book);
});
it("a smaller TVL floor cannot bypass executable depth, taxes/costs or security gates", () => {
  for (const transform of [
    (p) => ({ ...p, tvlUsd: 19999 }),
    (p) => ({ ...p, reserveEth: 0.1 }),
    (p) => ({ ...p, security: { ...p.security, status: "unknown" } }),
    (p) => ({ ...p, entryExitQuote: { ...p.entryExitQuote, receivedEth: 0.00185 } }),
  ])
    assert.equal(enter(["a"], transform).book.positions.length, 0);
});
it("flat prices, a late spike, drawdown and a discontinuous history never create a trade", () => {
  for (const transform of [
    (p) => ({ ...p, priceEth: 1 }),
    (p) => ({ ...p, priceEth: 1 + (p.fetchedAt - t0) / 200000 }),
  ])
    assert.equal(enter(["a"], transform).book.positions.length, 0);
  const r = enter(["a"], (p) => ({ ...p, priceEth: p.fetchedAt === t0 + 75000 ? 2 : p.priceEth }));
  assert.equal(r.book.positions.length, 0);
  const now = t0 + 300000;
  const gap = stepLiveBook(r.book, [point("a", now, 1.1)], now, { monitorHealthy: true });
  assert.equal(gap.book.positions.length, 0);
  assert.deepEqual(gap.book.challenges, {});
});
it("an ordinary position stop closes with exact proceeds and cools that token without latching the portfolio", () => {
  const r = enter(),
    now = r.now + 5000;
  const closed = stepLiveBook(r.book, [], now, {
    monitorHealthy: true,
    exitQuotes: [sale("a", now, 0.00183)],
  });
  assert.equal(closed.book.positions.length, 0);
  assert.equal(closed.book.state.halted, false);
  assert.equal(closed.book.lossCooldowns[addr(97)], now);
  validateGuardedCheckpoint(closed.book);
  const other = stepLiveBook(closed.book, [point("b", now + 5000, 1)], now + 5000, {
    monitorHealthy: true,
  });
  assert.notEqual(other.decision.reason, "Portfolio risk stop latched");
});
function withChallenger(priceGain, omitQuote = false) {
  const r = enter(["a", "b"]);
  let book = r.book,
    result;
  for (let ms = 15000; ms <= 120000; ms += 15000) {
    const now = r.now + ms;
    result = stepLiveBook(
      book,
      [
        point("a", now, 1.018),
        point("b", now, 1.018),
        point("c", now, 1 + (ms / 120000) * priceGain),
      ],
      now,
      {
        monitorHealthy: true,
        exitQuotes: book.positions
          .filter((p) => !omitQuote || p.pool !== "a")
          .map((p) => sale(p.pool, now)),
      },
    );
    book = result.book;
  }
  return { ...result, now: r.now + 120000 };
}
it("full slots can rotate from a stagnant pool to a stronger confirmed pool, with separate reconciled exit and entry", () => {
  const r = withChallenger(0.05);
  assert.equal(r.book.positions.length, 2);
  assert.ok(r.book.positions.some((p) => p.pool === "c"));
  assert.equal(r.events.filter((e) => e.action === "exit").length, 1);
  assert.equal(r.events.filter((e) => e.action === "enter").length, 1);
  assert.match(r.book.ledger[0].exitReason, /Rotate/);
  assert.equal(r.book.ledger.length, 3);
  const realized = r.book.ledger.filter((t) => t.exitAt).reduce((n, t) => n + t.pnlEth, 0);
  const committed = r.book.positions.reduce((n, p) => n + p.allocationEth, 0);
  assert.ok(committed <= 0.004 + 1e-12);
  assert.ok(Math.abs(r.book.cash - (0.1 + realized - committed)) < 1e-12);
  validateGuardedCheckpoint(r.book);
});
it("a small improvement cannot pay switching costs; an unavailable held sale cannot be fabricated to rotate", () => {
  const small = withChallenger(0.006),
    missing = withChallenger(0.05, true);
  assert.ok(small.book.positions.every((p) => p.pool !== "c"));
  assert.ok(missing.book.positions.every((p) => p.pool !== "c"));
  assert.equal(missing.book.value, null);
});
it("a profit exit and a 15-minute timeout charge gas once and preserve accounting", () => {
  for (const timed of [false, true]) {
    const r = enter(),
      now = r.now + 5000;
    if (timed) r.book.positions[0].entryAt = now - R.maxHoldMs;
    const q = sale("a", now, timed ? 0.001899 : 0.00205);
    const closed = stepLiveBook(r.book, [], now, { monitorHealthy: true, exitQuotes: [q] });
    assert.equal(closed.book.positions.length, 0);
    assert.equal(closed.book.costs, 0.000002);
    assert.match(closed.book.ledger[0].exitReason, timed ? /15-minute/ : /profit/);
    assert.ok(Math.abs(closed.book.ledger[0].pnlEth - (closed.book.value - 0.1)) < 1e-12);
    validateGuardedCheckpoint(closed.book);
  }
});
it("hourly churn and portfolio loss caps block entries while preserving exit handling", () => {
  const r = enter(),
    now = r.now + 5000;
  r.book.state.trades = Array(6).fill(now - 10000);
  const closed = stepLiveBook(r.book, [point("b", now, 1)], now, {
    monitorHealthy: true,
    exitQuotes: [sale("a", now, 0.00205)],
  });
  assert.equal(closed.book.positions.length, 0);
  assert.match(closed.decision.reason, /profit/);
  const collapsed = stepLiveBook(r.book, [], now, {
    monitorHealthy: true,
    exitQuotes: [sale("a", now, 0)],
  });
  assert.equal(collapsed.book.state.halted, true);
});
it("activity ranking covers leaders and rotates research without letting new timestamps starve a stable signal", () => {
  const pools = Array.from({ length: 12 }, (_, i) => ({
    id: String(i).padStart(2, "0"),
    other: addr(i),
    dex: "pons-v2-dex",
    tvlUsd: 25000,
    volume24h: 10000 - i * 100,
    volume5m: 100 - i,
  }));
  assert.equal(rankGuardedPools(pools)[0].id, "00");
  const seen = new Set();
  let window;
  for (let i = 0; i < 5; i++) {
    const s = selectGuardedPools(pools, window, [], t0 + i * 180000);
    window = s.window;
    s.selected.forEach((p) => seen.add(p.id));
    assert.deepEqual(
      selectGuardedPools([...pools].reverse(), window, [], t0 + i * 180000 + 90000).selected,
      s.selected,
    );
  }
  assert.equal(seen.size, 12);
});
it("a diagnostically approved pool gains continuous observation instead of being starved by unresolved active slots", () => {
  const pools = Array.from({ length: 7 }, (_, i) => ({
    id: String(i),
    other: addr(i),
    dex: "pons-v2-dex",
    tvlUsd: 25000,
    volume24h: 10000 - i * 100,
  }));
  const first = selectGuardedPools(pools, null, [], t0);
  assert.ok(!first.selected.some((p) => p.id === "6"));
  const proved = [
    { id: "6", securityStatus: "approved", securityCheckedAt: t0 + 1000, securityApprovedCount: 1 },
  ];
  const next = selectGuardedPools(pools, first.window, proved, t0 + 5000);
  assert.equal(next.selected[0].id, "6");
  assert.equal(selectGuardedPools(pools, next.window, proved, t0 + 95000).selected[0].id, "6");
});
it("six old approvals cannot evict the two research candidates before they finish their observation window", () => {
  const pools = Array.from({ length: 8 }, (_, i) => ({
    id: String(i),
    other: addr(i),
    dex: "pons-v2-dex",
    tvlUsd: 25000,
    volume24h: 10000 - i * 100,
  }));
  const coverage = pools
    .slice(0, 6)
    .map((p) => ({
      id: p.id,
      securityStatus: "approved",
      securityCheckedAt: t0,
      securityApprovedCount: 1,
    }));
  const previous = { startedAt: t0, ids: ["0", "1", "2", "3", "6", "7"], cursor: 2 };
  assert.deepEqual(
    selectGuardedPools(pools, previous, coverage, t0 + 60000).selected.map((p) => p.id),
    previous.ids,
  );
});
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/pons-ownerless-runtime.json", import.meta.url)),
);
it("the pinned deployed runtime transfers a full balance on a local EVM, rejects unauthorized burns and has no owner/mint entry point", async () => {
  // Isolated Ganache state only: no real RPC, environment key or funds.
  const rpc = ganache.provider({
    logging: { quiet: true },
    chain: { hardfork: "shanghai" },
    wallet: { deterministic: true },
  });
  try {
    const [holder, recipient, attacker] = await rpc.request({ method: "eth_accounts", params: [] });
    const token = addr(500),
      client = createPublicClient({ transport: custom(rpc) });
    const abi = parseAbi([
      "function balanceOf(address) view returns(uint256)",
      "function transfer(address,uint256) returns(bool)",
      "function burnFrom(address,uint256)",
      "function owner() view returns(address)",
      "function mint(address,uint256)",
    ]);
    await rpc.request({ method: "evm_setAccountCode", params: [token, fixture.code] });
    const slot = keccak256(
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, 0n]),
    );
    await rpc.request({
      method: "evm_setAccountStorageAt",
      params: [token, slot, toHex(1000000n, { size: 32 })],
    });
    await rpc.request({
      method: "evm_setAccountStorageAt",
      params: [token, toHex(2n, { size: 32 }), toHex(1000000n, { size: 32 })],
    });
    await assert.rejects(
      client.simulateContract({
        address: token,
        abi,
        functionName: "burnFrom",
        args: [holder, 1n],
        account: attacker,
      }),
    );
    await assert.rejects(client.readContract({ address: token, abi, functionName: "owner" }));
    await assert.rejects(
      client.simulateContract({
        address: token,
        abi,
        functionName: "mint",
        args: [attacker, 1n],
        account: attacker,
      }),
    );
    const tx = await rpc.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: holder,
          to: token,
          gas: "0x186a0",
          data: encodeFunctionData({ abi, functionName: "transfer", args: [recipient, 1000000n] }),
        },
      ],
    });
    assert.equal((await client.getTransactionReceipt({ hash: tx })).status, "success");
    assert.equal(
      await client.readContract({ address: token, abi, functionName: "balanceOf", args: [holder] }),
      0n,
    );
    assert.equal(
      await client.readContract({
        address: token,
        abi,
        functionName: "balanceOf",
        args: [recipient],
      }),
      1000000n,
    );
  } finally {
    await rpc.disconnect();
  }
});
it("reviewed Pons proof pins every byte except correctly bound compiler immutables", () => {
  assert.equal(verifyPonsTokenRuntime(fixture.code, fixture), true);
  for (const offset of [0, 300, 1000, 1500, 3195]) {
    const at = 2 + offset * 2,
      byte = fixture.code.slice(at, at + 2);
    const changed =
      fixture.code.slice(0, at) + (byte === "00" ? "01" : "00") + fixture.code.slice(at + 2);
    assert.equal(verifyPonsTokenRuntime(changed, fixture), false);
  }
  assert.equal(verifyPonsTokenRuntime(fixture.code, { ...fixture, factory: addr(99) }), false);
  assert.equal(verifyPonsTokenRuntime(fixture.code, { ...fixture, deployer: addr(99) }), false);
  assert.equal(verifyPonsTokenRuntime(fixture.code + "00", fixture), false);
});
it("runtime evidence resolves only missing token fields and binds issuer, token and quote block; positives persist", () => {
  const proof = {
    kind: "pinned-pons-ownerless-erc20",
    templateHash: PONS_TOKEN_TEMPLATE_HASH,
    token: addr(1),
    block: "100",
    owner: addr(0),
    fullBalanceTransfers: true,
    issuer: addr(9),
    issuerFraction: 0.001,
  };
  const raw = { is_mintable: "1", creator_address: addr(8) };
  const patched = applyPonsTokenProof(raw, proof, addr(1), "100");
  assert.equal(patched.cannot_sell_all, "0");
  assert.equal(patched.owner_address, addr(0));
  assert.equal(patched.creator_address, addr(9));
  assert.equal(patched.is_mintable, "1");
  assert.equal(
    applyPonsTokenProof({ ...raw, cannot_sell_all: "1" }, proof, addr(1), "100").cannot_sell_all,
    "1",
  );
  assert.equal(applyPonsTokenProof(raw, proof, addr(2), "100"), raw);
  assert.equal(applyPonsTokenProof(raw, proof, addr(1), "99"), raw);
  assert.equal(applyPonsTokenProof(raw, null, addr(1), "100"), raw);
});
