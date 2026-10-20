import { it } from "node:test";
import assert from "node:assert/strict";
import { paperReportSchema, paperReportStale, newerPaperReport } from "../src/lib/paper-report.ts";
import { createPublisher } from "./live-paper/publish.mjs";
import { completeReport, reportFiles } from "./live-paper/report.mjs";
const report = {
  version: 1,
  runId: "123",
  startedAt: "2026-10-16T00:00:00.000Z",
  updatedAt: "2026-10-16T00:01:00.000Z",
  finishedAt: null,
  status: "running",
  samples: 1,
  verifiedQuotes: 2,
  errors: 0,
  actions: { wait: 1 },
  reasons: { costs: 1 },
  books: [
    { initial: 0.1, value: null, fees: 0, costs: 0, state: { current: "pool", halted: false } },
  ],
  operations: [],
  decisions: [],
  equity: [],
};
it("Pons diagnostics survive public serialization and exports without turning rejection into a trade", () => {
  const parsed = paperReportSchema.parse({
    ...report,
    executionProfile: "pons-v2",
    securityProfile: "single-token-v1",
    securityProvider: {
      requests: 2,
      responses: 2,
      missing: 1,
      failures: 0,
      tracked: 2,
      available: 1,
      pending: 0,
      stale: 0,
      missingTokens: 1,
      failedTokens: 0,
    },
    entryScreening: {
      observed: 10,
      liquidityEligible: 2,
      selected: 2,
      approved: 0,
      rejected: 0,
      unknown: 2,
    },
    diagnosticProbes: 1,
    trades: [],
    poolCoverage: [
      {
        id: "0xpool",
        label: "TOKEN / ETH",
        token: "0xtoken",
        dex: "pons-v2-dex",
        stage: "graduated",
        tvlUsd: 100000,
        observations: 1,
        probes: 1,
        failures: 0,
        lastReason: "Token safety unknown",
        securityStatus: "unknown",
        entryBlockReason: "Entry requires graduation",
        securityData: {
          status: "missing",
          checkedAt: 0,
          requestedAt: 1000,
          detail: "Provider omitted this token",
          providerCode: 2021,
          raw: "must be stripped",
        },
        liquidityKind: "pons-permanent-seed",
        protectedLiquidityFraction: 1,
        lastSimulation: {
          status: "passed",
          at: report.updatedAt,
          block: "100",
          inputEth: 0.0019,
          quantityRaw: "12345678901234567890",
          receivedEth: 0.0018,
          gasEth: 0.00001,
          recovery: 0.95,
          costGatePassed: false,
        },
      },
    ],
  });
  assert.equal(parsed.poolCoverage[0].securityStatus, "unknown");
  assert.equal(parsed.poolCoverage[0].lastSimulation.costGatePassed, false);
  assert.equal(parsed.poolCoverage[0].securityData.status, "missing");
  assert.equal(parsed.poolCoverage[0].securityData.providerCode, 2021);
  assert.equal("raw" in parsed.poolCoverage[0].securityData, false);
  assert.equal(parsed.trades.length, 0);
  const files = reportFiles({
    ...parsed,
    assumptions: [],
    books: [{ ...parsed.books[0], realizedPnlEth: 0, openPnlEth: 0, totalPnlEth: null }],
  });
  for (const name of ["report.md", "report.html", "pools.csv"]) {
    assert.ok(files[name].includes("12345678901234567890"));
    assert.ok(files[name].includes("0.00190000") || files[name].includes("0.0019"));
  }
  assert.match(files["report.html"], /95.00%/);
  assert.match(files["pools.csv"], /simulationCostGatePassed/);
  assert.match(files["pools.csv"], /securityDataStatus/);
  assert.match(files["pools.csv"], /Provider omitted this token/);
  assert.match(files["pools.csv"], /securityProviderCode/);
  assert.match(files["pools.csv"], /2021/);
  assert.match(files["report.html"], /1 without a provider record/);
});
it("report preserves unknown PnL, strips private/unrelated fields and detects stalled running updates", () => {
  const parsed = paperReportSchema.parse({ ...report, secret: "never publish" });
  assert.equal(parsed.books[0].value, null);
  assert.equal("secret" in parsed, false);
  assert.equal(paperReportStale(parsed, Date.parse(parsed.updatedAt) + 180001), true);
  assert.equal(
    paperReportStale({ ...parsed, status: "completed" }, Date.parse(parsed.updatedAt) + 180001),
    false,
  );
  assert.throws(() => paperReportSchema.parse({ ...report, runId: "javascript:bad" }));
  assert.throws(() =>
    paperReportSchema.parse({ ...report, books: [{ ...report.books[0], value: NaN }] }),
  );
});
it("rotation policy and balance-specific cost/signal evidence survive public JSON and CSV without inventing trades", () => {
  const parsed = paperReportSchema.parse({
    ...report,
    strategyProfile: "rotation-v1",
    strategyPolicy: { version: "rotation-v1", minTvlUsd: 20000 },
    entrySignals: [
      {
        capital: 0.1,
        pool: "pool",
        status: "blocked",
        reason: "Costs exceed trend",
        rise: 0.01,
        requiredRise: 0.035,
        costFraction: 0.023,
      },
      { capital: 0.5, pool: "pool", status: "warming", reason: "Collecting history" },
    ],
    trades: [],
    poolCoverage: [],
  });
  assert.equal(parsed.entrySignals[0].capital, 0.1);
  assert.equal(parsed.entrySignals[1].capital, 0.5);
  assert.equal(parsed.strategyPolicy.minTvlUsd, 20000);
  assert.equal(parsed.trades.length, 0);
  const files = reportFiles({
    ...parsed,
    assumptions: [],
    books: [{ ...parsed.books[0], realizedPnlEth: 0, openPnlEth: null, totalPnlEth: null }],
  });
  assert.match(files["signals.csv"], /Costs exceed trend/);
  assert.match(files["signals.csv"], /Collecting history/);
  assert.match(files["report.html"], /rotation-v1/);
  assert.match(files["report.html"], /3.50%/);
});
const guardedRun = (extra = {}, book = {}) => ({
  ...report,
  strategyProfile: "rotation-v2",
  poolCoverage: [],
  assumptions: [],
  entryAttempts: 6,
  executionQuotes: 2,
  entryRejections: 4,
  priceObservations: 12,
  costQualifiedQuotes: 0,
  books: [
    {
      ...report.books[0],
      strategy: "guarded",
      value: 0.1,
      ledger: [],
      ...book,
    },
  ],
  ...extra,
});
const position = (extra = {}) => ({
  id: "position1",
  capital: 0.1,
  pool: "pool1",
  label: "POOL / ETH",
  entryAt: report.startedAt,
  exitAt: report.updatedAt,
  entryValueEth: 0.002,
  valueEth: 0.00199,
  durationSec: 60,
  feesEth: 0,
  costsEth: 0.00001,
  pnlEth: -0.00001,
  exitReason: "Timed exit",
  feeBaseline: 0,
  ...extra,
});
it("v2 publishes economic rejection counters and an honest zero-trade verdict", () => {
  const completed = completeReport(guardedRun());
  const parsed = paperReportSchema.parse(completed);
  assert.equal(parsed.verdict.status, "no_cost_qualified_routes");
  assert.equal(parsed.verdict.closedTrades, 0);
  assert.equal(parsed.entryRejections, 4);
  assert.equal(parsed.entryAttempts, 6);
  assert.equal(parsed.executionQuotes, 2);
  assert.equal(parsed.priceObservations, 12);
  assert.equal(parsed.costQualifiedQuotes, 0);
  assert.equal(parsed.trades.length, 0);
  assert.match(parsed.verdict.message, /profitability has not been validated/);
  const files = reportFiles(completed);
  assert.match(files["report.html"], /No observed entry quote met the cost budget/);
  assert.match(files["report.md"], /4 expected entry rejections \(not data errors\)/);
  assert.match(files["report.md"], /12 independent price observations/);
});
it("missing cost evidence or an open position cannot become a no-route or profitability conclusion", () => {
  const missing = completeReport(guardedRun({ costQualifiedQuotes: undefined }));
  assert.equal(missing.verdict.status, "no_completed_trades");
  for (const executionQuotes of [undefined, 0]) {
    const unmeasured = completeReport(guardedRun({ executionQuotes }));
    assert.equal(unmeasured.verdict.status, "no_completed_trades");
  }
  const open = completeReport(
    guardedRun({}, { ledger: [position({ exitAt: null })], value: 0.10001 }),
  );
  assert.equal(open.verdict.status, "no_completed_trades");
  assert.equal(open.verdict.closedTrades, 0);
  assert.match(open.verdict.message, /do not validate trading profitability/);
  const empty = completeReport(guardedRun({ samples: 0 }));
  assert.equal(empty.verdict.status, "no_completed_trades");
});
it("completed losses are identified and gains or unknown equity remain insufficient evidence", () => {
  const negative = completeReport(guardedRun({}, { ledger: [position()], value: 0.09999 }));
  assert.equal(negative.verdict.status, "negative_pnl");
  assert.equal(negative.verdict.closedTrades, 1);
  assert.match(negative.verdict.message, /below holding ETH/);
  const positive = completeReport(
    guardedRun({}, { ledger: [position({ pnlEth: 0.00001 })], value: 0.10001 }),
  );
  assert.equal(positive.verdict.status, "insufficient_evidence");
  const unknown = completeReport(guardedRun({}, { ledger: [position()], value: null }));
  assert.equal(unknown.verdict.status, "insufficient_evidence");
  paperReportSchema.parse(negative);
  paperReportSchema.parse(positive);
  paperReportSchema.parse(unknown);
});
it("legacy reports retain their original profile without a synthetic verdict", () => {
  const legacy = completeReport(guardedRun({ strategyProfile: "rotation-v1" }));
  assert.equal("verdict" in legacy, false);
  assert.equal(paperReportSchema.parse(legacy).strategyProfile, "rotation-v1");
  assert.equal(paperReportSchema.parse(report).strategyProfile, undefined);
});
it("publisher snapshots reports, throttles intermediate writes, and flushes final results on the data branch", async () => {
  const original = globalThis.fetch,
    env = { ...process.env };
  const writes = [];
  process.env.PAPER_REPORT_TOKEN = "test-only";
  process.env.GITHUB_REPOSITORY = "owner/repo";
  process.env.GITHUB_SHA = "abc";
  globalThis.fetch = async (url, options) => {
    if (options.method === "PUT") {
      writes.push(JSON.parse(options.body));
      return Response.json({});
    }
    if (url.includes("git/ref/heads/")) return Response.json({ ref: "exists" });
    return Response.json({ sha: "previous" });
  };
  try {
    const publish = createPublisher(),
      data = structuredClone(report);
    await publish(data);
    data.samples = 99;
    await publish(data);
    await publish({ ...data, status: "completed" }, true);
    assert.equal(writes.length, 2);
    assert.equal(JSON.parse(Buffer.from(writes[0].content, "base64")).samples, 1);
    assert.equal(JSON.parse(Buffer.from(writes[1].content, "base64")).status, "completed");
    assert.ok(writes.every((w) => w.branch === "paper-reports" && w.sha === "previous"));
  } finally {
    globalThis.fetch = original;
    process.env = env;
  }
});

it("cached responses cannot replace a newer run or move its snapshot backwards", () => {
  const later = { ...report, updatedAt: "2026-10-16T00:02:00.000Z" };
  assert.equal(newerPaperReport(later, report), later);
  const newRun = {
    ...report,
    runId: "124",
    startedAt: "2026-10-16T01:00:00.000Z",
    updatedAt: "2026-10-16T01:00:00.000Z",
  };
  assert.equal(newerPaperReport(newRun, later), newRun);
  assert.equal(newerPaperReport(later, newRun), newRun);
});
