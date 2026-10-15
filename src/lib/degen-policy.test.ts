import assert from "node:assert/strict";
import { it } from "node:test";
import {
  decide,
  initialPolicy,
  settled,
  POLICY,
  type Observation,
  type PolicyState,
} from "./degen-policy.ts";
import { newPaperRun, paperStep, type Scenario } from "./degen-simulation.ts";
const now = 2_000_000_000_000;
function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    now,
    fetchedAt: now,
    schedulerHealthy: true,
    pending: false,
    valueEth: 1,
    currentApr: 0,
    currentTvlUsd: 500000,
    sellable: true,
    candidates: [
      {
        id: "a",
        apr: 100,
        tvlUsd: 500000,
        createdAt: now - 10 * 86400000,
        reviewed: true,
        factoryVerified: true,
        roundTripOk: true,
        costEth: 0.00001,
      },
    ],
    ...overrides,
  };
}
function holding(): PolicyState {
  return { ...initialPolicy(1), current: "old", entryTvlUsd: 500000, lastTradeAt: now - 1000 };
}
it("requires spaced persistent observations; duplicate requests cannot confirm", () => {
  let state = initialPolicy(1);
  for (let i = 0; i < 20; i++) {
    const d = decide(state, observation());
    assert.equal(d.action, "wait");
    state = d.state;
  }
  assert.equal(state.observations, 1);
  for (const offset of [30000, 60000, 90000])
    state = decide(state, observation({ now: now + offset, fetchedAt: now + offset })).state;
  const d = decide(state, observation({ now: now + 120000, fetchedAt: now + 120000 }));
  assert.equal(d.action, "enter");
  assert.equal(settled(d.state, d, now + 120000, 1).current, "a");
});
it("stale / missing feed or delayed scheduler blocks entries and resets confirmation", () => {
  for (const o of [
    observation({ fetchedAt: now - 61000 }),
    observation({ schedulerHealthy: false }),
    observation({ fetchedAt: now + 1 }),
  ]) {
    const d = decide({ ...initialPolicy(1), challenger: "a", observations: 9 }, o);
    assert.equal(d.action, "blocked");
    assert.equal(d.state.challenger, null);
  }
});
it("unknown exit value or unsellable token never becomes a trade", () => {
  for (const valueEth of [null, NaN, Infinity, 0])
    assert.equal(decide(holding(), observation({ valueEth })).action, "blocked");
  assert.equal(decide(holding(), observation({ sellable: false })).action, "blocked");
});
it("pending transaction prevents any new decision even under loss", () =>
  assert.equal(decide(holding(), observation({ pending: true, valueEth: 0.5 })).action, "blocked"));
it("costs block small deposits and annualized spikes are capped", () => {
  assert.equal(decide(initialPolicy(0.00045), observation({ valueEth: 0.00045 })).action, "wait");
  const o = observation();
  o.candidates[0].apr = 10000000;
  o.candidates[0].costEth = 0.001;
  assert.match(decide(initialPolicy(1), o).reason, /costs/);
});
it("unreviewed, wrong-factory, failed simulation, new and shallow pools are excluded", () => {
  for (const patch of [
    { reviewed: false },
    { factoryVerified: false },
    { roundTripOk: false },
    { createdAt: now },
    { tvlUsd: 99999 },
    { costEth: NaN },
  ]) {
    const o = observation();
    Object.assign(o.candidates[0], patch);
    assert.equal(decide(initialPolicy(1), o).target, undefined);
  }
});
it("loss exits bypass holding period, daily cap and scheduler outage", () => {
  const state = { ...holding(), trades: Array(4).fill(now - 1) };
  const d = decide(state, observation({ valueEth: 0.94, schedulerHealthy: false, fetchedAt: 0 }));
  assert.equal(d.action, "exit");
  assert.equal(d.state.halted, true);
});
it("trailing stop protects gains and remains latched after exit", () => {
  const d = decide({ ...holding(), highWaterEth: 1.2 }, observation({ valueEth: 1.13 }));
  assert.equal(d.action, "exit");
  const s = settled(d.state, d, now, 1.13);
  assert.equal(decide(s, observation()).action, "blocked");
});
it("liquidity shock exits; stale liquidity cannot trigger a fabricated shock", () => {
  assert.equal(decide(holding(), observation({ currentTvlUsd: 300000 })).action, "exit");
  assert.equal(
    decide(holding(), observation({ currentTvlUsd: 300000, fetchedAt: 0 })).action,
    "blocked",
  );
});
it("a failed risk exit stays latched and can retry safely after reconciliation", () => {
  const d = decide(holding(), observation({ valueEth: 0.9 }));
  assert.equal(decide(d.state, observation({ valueEth: 0.9 })).action, "exit");
  assert.equal(decide(d.state, observation({ valueEth: null, sellable: false })).action, "blocked");
});
it("cooldown and rolling daily limit prevent churn", () => {
  assert.match(decide(holding(), observation()).reason, /holding/);
  assert.match(
    decide(
      { ...holding(), lastTradeAt: now - POLICY.cooldownMs, trades: Array(4).fill(now - 5000) },
      observation(),
    ).reason,
    /Daily/,
  );
});
it("paper scenarios share real policy, account for costs, and never guarantee a stop price", () => {
  for (const scenario of ["loss", "liquidity", "honeypot", "outage", "expensive"] as Scenario[]) {
    let r = newPaperRun();
    for (let i = 0; i < 20; i++) r = paperStep(r, scenario);
    if (scenario === "loss" || scenario === "liquidity") {
      assert.equal(r.state.halted, true);
      assert.equal(r.state.current, null);
      assert.ok(r.costs > 0);
    }
    if (scenario === "loss") assert.ok(r.value < 0.95, "a 10% jump can overshoot the 5% stop");
    if (scenario === "honeypot") assert.equal(r.log[0].action, "blocked");
    if (scenario === "expensive") assert.equal(r.state.current, null);
  }
});
