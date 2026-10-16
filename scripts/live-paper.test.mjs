import assert from "node:assert/strict";
import { it } from "node:test";
import { newLiveBook, stepLiveBook, fullRangeValue } from "../src/lib/live-paper.ts";
import { readOnlyProvider, normalizePools } from "./live-paper/market.mjs";
import { CONTRACTS } from "../src/lib/chain.ts";
const start = 2_000_000_000_000;
function point(now, patch = {}) {
  return {
    id: "pool",
    label: "Pool",
    priceEth: 1,
    fetchedAt: now,
    apr: 100,
    tvlUsd: 500000,
    createdAt: start - 86400000 * 10,
    reviewed: true,
    factoryVerified: true,
    roundTripOk: true,
    costEth: 0.000002,
    entryCostEth: 0.000001,
    exitCostEth: 0.000001,
    ...patch,
  };
}
function enter() {
  let book = newLiveBook(0.1);
  for (let i = 0; i <= 10; i++)
    book = stepLiveBook(book, [point(start + i * 15000)], start + i * 15000).book;
  assert.equal(book.state.current, "pool");
  return book;
}
it("RPC wrapper refuses every signing, write and wallet method before transport", async () => {
  const calls = [];
  const rpc = readOnlyProvider({
    request: async (a) => {
      calls.push(a.method);
      return "ok";
    },
  });
  for (const method of [
    "eth_sendTransaction",
    "eth_sendRawTransaction",
    "eth_sign",
    "personal_sign",
    "wallet_addEthereumChain",
    "anvil_setBalance",
  ])
    await assert.rejects(rpc.request({ method, params: [] }));
  assert.deepEqual(calls, []);
  assert.equal(await rpc.request({ method: "eth_call", params: [] }), "ok");
});
it("live paper starts with real spaced confirmations, then accounts for costs and a price stop", () => {
  const b = enter();
  assert.ok(b.costs > 0);
  assert.ok(b.value < 0.1);
  const now = start + 165000;
  const { book, decision } = stepLiveBook(b, [point(now, { priceEth: 0.81 })], now);
  assert.equal(decision.action, "exit");
  assert.equal(book.position, null);
  assert.equal(book.state.halted, true);
  assert.ok(book.value < 0.095);
  assert.ok(book.costs > b.costs);
  assert.equal(book.cash, book.value);
});
it("missing or stale prices produce unknown valuation and never fictitious realized proceeds", () => {
  const b = enter();
  const now = start + 165000;
  for (const points of [[], [point(now - 61000)], [point(now, { roundTripOk: false })]]) {
    const r = stepLiveBook(b, points, now);
    assert.equal(r.book.value, null);
    assert.equal(r.book.cash, 0);
    assert.equal(r.decision.action, "blocked");
    assert.equal(r.book.fees, b.fees);
  }
});
it("monitoring gaps earn no modeled fees and reset entry confirmations", () => {
  const b = enter(),
    now = b.lastAt + 120000;
  const r = stepLiveBook(b, [point(now)], now);
  assert.equal(r.book.fees, b.fees);
  assert.equal(r.decision.action, "blocked");
  let empty = newLiveBook(0.1);
  empty = stepLiveBook(empty, [point(start)], start).book;
  empty = stepLiveBook(empty, [point(start + 15000)], start + 15000).book;
  const gap = stepLiveBook(empty, [point(start + 180000)], start + 180000);
  assert.equal(gap.book.state.challenger, null);
});
it("liquidity shock exits without waiting for the cooldown; stop stays latched", () => {
  const b = enter(),
    now = b.lastAt + 15000;
  const r = stepLiveBook(b, [point(now, { tvlUsd: 100000 })], now);
  assert.equal(r.decision.action, "exit");
  assert.equal(stepLiveBook(r.book, [point(now + 15000)], now + 15000).decision.action, "blocked");
});
it("full-range approximation is denominated in ETH and includes impermanent-loss shape", () => {
  assert.equal(fullRangeValue(1, 1, 4), 2);
  assert.equal(fullRangeValue(1, 1, 0.25), 0.5);
  assert.throws(() => fullRangeValue(1, 0, 1));
  assert.throws(() => newLiveBook(NaN));
  assert.throws(() => newLiveBook(1));
});
it("provider parsing rejects malformed / non-WETH data and has no catalog fallback", () => {
  assert.deepEqual(normalizePools({}), []);
  const token = "0x" + "12".repeat(20),
    pool = "0x" + "34".repeat(20);
  const json = {
    included: [
      { type: "token", id: "a", attributes: { address: CONTRACTS.weth } },
      { type: "token", id: "b", attributes: { address: token } },
    ],
    data: [
      {
        attributes: {
          address: pool,
          reserve_in_usd: "200000",
          volume_usd: { h24: "100000" },
          pool_created_at: "2025-01-01",
        },
        relationships: { base_token: { data: { id: "a" } }, quote_token: { data: { id: "b" } } },
      },
    ],
  };
  assert.equal(normalizePools(json)[0].other, token);
  json.data[0].attributes.reserve_in_usd = "not-a-number";
  assert.deepEqual(normalizePools(json), []);
});
