import assert from "node:assert/strict";
import { it } from "node:test";
import { observedMomentum } from "../src/lib/paper-signals.ts";
import { PAPER_ROTATION } from "../src/lib/paper-risk.ts";

const now = 1_000_000;
const pool = "selected-pool";
const point = (ago, price) => ({ id: pool, at: now - ago, price });
const healthyMinute = () => [
  point(60000, 1),
  point(45000, 1.01),
  point(30000, 1.02),
  point(15000, 1.03),
  point(0, 1.04),
];

it("a recovered continuous minute is usable even when a prior 40-second gap remains inside retained history", () => {
  assert.ok(PAPER_ROTATION.historyMs >= 100000 && PAPER_ROTATION.lookbackMs <= 60000);
  const momentum = observedMomentum([point(100000, 0.5), ...healthyMinute()], pool, now);
  assert.notEqual(momentum, null);
  assert.ok(Math.abs(momentum.rise - 0.04) < 1e-12);
  assert.equal(momentum.drawdown, 0);
});

it("a fresh gap resets lookback; older pre-gap prices cannot fill in the missing observation time", () => {
  const insufficient = [
    point(100000, 0.8),
    point(45000, 1),
    point(30000, 1.01),
    point(15000, 1.02),
    point(0, 1.03),
  ];
  assert.equal(observedMomentum(insufficient, pool, now), null);
});

it("a pre-gap spike cannot contaminate a recovered window's drawdown or momentum", () => {
  const momentum = observedMomentum([point(100000, 100), ...healthyMinute()], pool, now);
  assert.notEqual(momentum, null);
  assert.equal(momentum.drawdown, 0);
  assert.ok(Math.abs(momentum.rise - 0.04) < 1e-12);
});

it("the latest gap determines the suffix and repeated gaps cannot fabricate continuity", () => {
  const twice = [
    point(120000, 1),
    point(80000, 1.01),
    point(65000, 1.02),
    point(30000, 1.03),
    point(15000, 1.04),
    point(0, 1.05),
  ];
  assert.equal(observedMomentum(twice, pool, now), null);
});

it("a 30-second interval is allowed, while a longer interval resets the evidence", () => {
  const exact = [point(60000, 1), point(30000, 1.01), point(15000, 1.02), point(0, 1.03)];
  assert.notEqual(observedMomentum(exact, pool, now), null);
  const long = [point(60001, 1), ...exact.slice(1)];
  assert.equal(observedMomentum(long, pool, now), null);
});

it("stale latest prices and future or different-pool rows cannot authorize a signal", () => {
  const stale = healthyMinute().map((p) => ({ ...p, at: p.at - 11000 }));
  assert.equal(observedMomentum(stale, pool, now), null);
  assert.equal(
    observedMomentum(
      [...stale, point(-5000, 1.5), { ...point(0, 1.5), id: "other-pool" }],
      pool,
      now,
    ),
    null,
  );
});

it("observations are considered chronologically without mutating the stored history", () => {
  const shuffled = [
    healthyMinute()[2],
    healthyMinute()[4],
    healthyMinute()[0],
    healthyMinute()[1],
    healthyMinute()[3],
  ];
  const before = structuredClone(shuffled);
  const result = observedMomentum(shuffled, pool, now);
  assert.notEqual(result, null);
  assert.ok(Math.abs(result.rise - 0.04) < 1e-12);
  assert.deepEqual(shuffled, before);
});
