import {
  decide,
  initialPolicy,
  settled,
  type Candidate,
  type Decision,
  type Observation,
  type PolicyState,
} from "./degen-policy.ts";
export type Scenario = "normal" | "loss" | "liquidity" | "honeypot" | "outage" | "expensive";
export type PaperRun = {
  state: PolicyState;
  step: number;
  value: number;
  initial: number;
  fees: number;
  costs: number;
  log: { step: number; action: Decision["action"]; reason: string; value: number }[];
};
export function newPaperRun(amount = 1): PaperRun {
  return {
    state: initialPolicy(amount),
    step: 0,
    value: amount,
    initial: amount,
    fees: 0,
    costs: 0,
    log: [],
  };
}
const START = Date.UTC(2026, 0, 15);
/** Synthetic scenarios, not a backtest. Same decide() as production; virtual
 * accounting includes assumed fees, trading costs and a loss shock. */
export function paperStep(run: PaperRun, scenario: Scenario): PaperRun {
  const step = run.step + 1,
    now = START + step * 30_000;
  let value = run.value;
  const earned = run.state.current ? (value * 0.5) / (365 * 24 * 120) : 0;
  value += earned;
  if (step === 8 && scenario === "loss" && run.state.current) value *= 0.9;
  const sellable = !(scenario === "honeypot" && step >= 8);
  const candidate: Candidate = {
    id: "paper-pool",
    apr: 100,
    tvlUsd: 500_000,
    createdAt: START - 30 * 86_400_000,
    reviewed: true,
    factoryVerified: true,
    roundTripOk: true,
    costEth: scenario === "expensive" ? 0.01 : 0.00001,
  };
  const observation: Observation = {
    now,
    fetchedAt: scenario === "outage" && step >= 8 ? START : now,
    schedulerHealthy: scenario !== "outage" || step < 8,
    pending: false,
    valueEth: sellable ? value : null,
    sellable,
    currentApr: 100,
    currentTvlUsd: scenario === "liquidity" && step >= 8 ? 200_000 : 500_000,
    candidates: [candidate],
  };
  const decision = decide(run.state, observation);
  let state = decision.state,
    cost = 0;
  if (decision.action === "enter" || decision.action === "hop" || decision.action === "exit") {
    cost = decision.action === "exit" ? 0.00001 : candidate.costEth;
    value = Math.max(0, value - cost);
    state = settled(state, decision, now, value);
  }
  return {
    ...run,
    state,
    step,
    value,
    fees: run.fees + earned,
    costs: run.costs + cost,
    log: [{ step, action: decision.action, reason: decision.reason, value }, ...run.log].slice(
      0,
      40,
    ),
  };
}
