import assert from "node:assert/strict";
import { it } from "node:test";
import { recordPaperTrade } from "../src/lib/paper-ledger.ts";
import { completeReport, reportFiles, resumeReport } from "./live-paper/report.mjs";
const target = { id: "pool-a", label: "USDG/WETH", entryCostEth: 0.01 };
it("per-position PnL includes entry and exit costs, duration and marked/open uncertainty", () => {
  const first = recordPaperTrade([], 1, "enter", 100000, 0.99, 0, target, 1, 0, "enter");
  assert.ok(Math.abs(first[0].pnlEth + 0.01) < 1e-12);
  const unknown = recordPaperTrade(
    first,
    1,
    "blocked",
    115000,
    null,
    0,
    undefined,
    0,
    0,
    "missing",
  );
  assert.equal(unknown[0].pnlEth, null);
  assert.equal(unknown[0].exitAt, null);
  const closed = recordPaperTrade(
    unknown,
    1,
    "exit",
    160000,
    1.02,
    0.005,
    undefined,
    0,
    0.002,
    "profit",
  );
  assert.equal(closed[0].durationSec, 60);
  assert.equal(closed[0].costsEth, 0.012);
  assert.equal(closed[0].feesEth, 0.005);
  assert.ok(Math.abs(closed[0].pnlEth - 0.02) < 1e-12);
  assert.equal(first[0].exitAt, null, "history is immutable");
  const second = recordPaperTrade(
    closed,
    1,
    "enter",
    200000,
    1.01,
    0.005,
    target,
    1.02,
    0,
    "enter",
  );
  const end = recordPaperTrade(second, 1, "exit", 260000, 0.98, 0.006, undefined, 0, 0.002, "loss");
  assert.ok(Math.abs(end.reduce((n, t) => n + t.pnlEth, 0) - (0.98 - 1)) < 1e-12);
});
it("hop allocates old exit cost to the old position and new entry cost to the new position", () => {
  let trades = recordPaperTrade([], 1, "enter", 100000, 0.99, 0, target, 1, 0, "enter");
  trades = recordPaperTrade(
    trades,
    1,
    "hop",
    160000,
    1.03,
    0.005,
    { ...target, id: "pool-b" },
    0,
    0.002,
    "rotate",
  );
  assert.ok(Math.abs(trades[0].valueEth - 1.04) < 1e-12);
  assert.ok(Math.abs(trades[1].pnlEth + 0.01) < 1e-12);
  assert.equal(trades[0].costsEth, 0.012);
  assert.equal(trades[1].costsEth, 0.01);
  assert.ok(Math.abs(trades.reduce((n, t) => n + t.pnlEth, 0) - 0.03) < 1e-12);
});
it("checkpoint continuation preserves balances, positions, costs and rejects unrelated runs", () => {
  const saved = {
    runId: "123",
    segment: 1,
    segments: 2,
    status: "segment_complete",
    books: [
      {
        initial: 0.1,
        strategy: "carry48",
        lastAt: 123,
        position: { pool: "held" },
        value: 0.099,
        ledger: [{ id: "open" }],
      },
    ],
  };
  const expected = { runId: "123", capitals: [0.1], strategy: "carry48", segment: 2 };
  const next = resumeReport(saved, expected);
  assert.equal(next.books, saved.books);
  assert.equal(next.segment, 2);
  assert.equal(next.status, "running");
  assert.throws(() => resumeReport(saved, { ...expected, runId: "456" }));
  assert.throws(() => resumeReport(saved, { ...expected, capitals: [0.5] }));
  assert.throws(() => resumeReport({ ...saved, status: "completed" }, expected));
});
it("reports reconcile closed and open PnL and export auditable CSV including quoted pool names", () => {
  const ledger = recordPaperTrade(
    [],
    1,
    "enter",
    100000,
    0.99,
    0,
    { ...target, label: 'A,"B"' },
    1,
    0,
    "enter",
  );
  const r = completeReport({
    runId: "123",
    status: "running",
    segment: 1,
    segments: 2,
    startedAt: "start",
    samples: 1,
    verifiedQuotes: 2,
    errors: 0,
    books: [{ initial: 1, value: 0.99, fees: 0, costs: 0.01, ledger }],
    equity: [{ at: "time", values: [0.99] }],
    poolCoverage: [],
    reasons: { wait: 1 },
    assumptions: [],
  });
  assert.equal(r.books[0].realizedPnlEth, 0);
  assert.ok(Math.abs(r.books[0].openPnlEth + 0.01) < 1e-12);
  const files = reportFiles(r);
  assert.match(files["trades.csv"], /"A,""B"""/);
  assert.match(files["report.md"], /OPEN/);
  assert.match(files["report.html"], /Complete paper test report/);
});
