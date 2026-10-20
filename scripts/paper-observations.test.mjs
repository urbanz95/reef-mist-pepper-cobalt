import assert from "node:assert/strict";
import { it } from "node:test";
import { newLiveBook, stepLiveBook } from "../src/lib/live-paper.ts";
import { PAPER_ROTATION } from "../src/lib/paper-risk.ts";

const start = 1000000,
  id = "pool",
  token = "0x" + "12".repeat(20);
const observation = (at, price = 1) => ({ id, at, price, block: String(at) });
function point(at, status = "approved", receivedEth = 0.001899) {
  return {
    id,
    token,
    label: "controlled pool",
    priceEth: 1 + (at - start) / 3000000,
    fetchedAt: at,
    apr: 0,
    tvlUsd: 25000,
    createdAt: start,
    reviewed: true,
    factoryVerified: true,
    roundTripOk: true,
    metadataFresh: true,
    reserveEth: 100,
    block: String(at),
    costEth: 0.000003,
    entryCostEth: 0.000002,
    exitCostEth: 0.000001,
    buyInputEth: 0.0019,
    buyGasEth: 0.000001,
    quantityRaw: "100",
    entryExitQuote: {
      pool: id,
      quantityRaw: "100",
      receivedEth,
      gasEth: 0.000001,
      fetchedAt: at,
      block: String(at),
    },
    security: {
      token,
      liquidityBlock: String(at),
      status,
      checkedAt: at,
      reasons: [],
      actors: [],
      source: "fixture",
    },
  };
}
function observeOnly() {
  let b = newLiveBook(0.1, "guarded");
  for (let ms = 0; ms <= 60000; ms += 15000) {
    b = stepLiveBook(b, [], start + ms, {
      monitorHealthy: true,
      priceObservations: [observation(start + ms, 1 + ms / 3000000)],
    }).book;
    assert.equal(b.positions.length, 0, "research observations cannot authorize a purchase");
  }
  return b;
}
it("canonical observations warm history independently of buy admission, then require a fresh confirmed executable entry", () => {
  let b = observeOnly();
  for (let ms = 75000; ms <= 105000; ms += 15000) {
    const now = start + ms;
    b = stepLiveBook(b, [point(now)], now, { monitorHealthy: true }).book;
  }
  assert.equal(b.positions.length, 1);
  assert.equal(b.ledger.length, 1);
});
it("price history cannot bypass missing security or the 1% measured cost ceiling", () => {
  for (const p of [point(start + 75000, "unknown"), point(start + 75000, "approved", 0.001855)]) {
    const r = stepLiveBook(observeOnly(), [p], start + 75000, { monitorHealthy: true });
    assert.equal(r.book.positions.length, 0);
    assert.equal(r.signals[0].status, "blocked");
    if (p.security.status === "approved") {
      assert.equal(PAPER_ROTATION.maxEntryCostFraction, 0.01);
      assert.ok(r.signals[0].costFraction > 0.02);
      assert.match(r.signals[0].reason, /1\.0%/);
    }
  }
});
it("research keeps original timestamps and rejects future, expired, invalid and duplicate samples", () => {
  const now = start + 100000;
  let b = newLiveBook(0.1, "guarded");
  b.lastAt = now - 5000;
  const old = observation(now - 40000, 1.1);
  b = stepLiveBook(b, [], now, {
    monitorHealthy: true,
    priceObservations: [
      old,
      old,
      observation(now + 1),
      observation(now - 60001),
      observation(now, NaN),
      { ...observation(now), block: "invalid" },
      observation(now, 0),
    ],
  }).book;
  assert.deepEqual(b.prices, [old]);
  assert.equal(b.positions.length, 0);
});
it("a monitoring gap resets confirmations even with earlier research prices", () => {
  const b = observeOnly();
  b.challenges[id] = { since: start, lastAt: b.lastAt, observations: 9 };
  const now = b.lastAt + 120000;
  const r = stepLiveBook(b, [point(now)], now, { monitorHealthy: true });
  assert.equal(r.book.positions.length, 0);
  assert.deepEqual(r.book.challenges, {});
  assert.equal(r.book.prices.length, 1);
});
