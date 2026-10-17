import { it } from "node:test";
import assert from "node:assert/strict";
import { paperReportSchema, paperReportStale, newerPaperReport } from "../src/lib/paper-report.ts";
import { createPublisher } from "./live-paper/publish.mjs";
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
