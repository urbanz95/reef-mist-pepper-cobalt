import { mkdir, appendFile, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { newLiveBook, stepLiveBook } from "../../src/lib/live-paper.ts";
import { POLICY } from "../../src/lib/degen-policy.ts";
import { CONTRACTS } from "../../src/lib/chain.ts";
import { discover, currentPool, chainSnapshot, samplePool } from "./market.mjs";

const duration = Number(process.env.PAPER_DURATION_MINUTES ?? 240);
if (!Number.isFinite(duration) || duration < 0.25 || duration > 300)
  throw new Error("Duration must be 0.25–300 minutes");
const capitals = (process.env.PAPER_CAPITALS ?? "0.00045,0.1").split(",").map(Number);
if (capitals.length < 1 || capitals.length > 3) throw new Error("Use 1–3 virtual balances");
const tokens = (process.env.PAPER_TOKEN_ADDRESSES ?? CONTRACTS.usdg)
  .split(",")
  .map((s) => s.trim().toLowerCase());
if (tokens.length > 4 || !tokens.length || tokens.some((t) => !/^0x[0-9a-f]{40}$/.test(t)))
  throw new Error("Use 1–4 paper token addresses");
const directory = resolve(process.env.PAPER_OUTPUT_DIR ?? "paper-results");
await mkdir(directory, { recursive: true });
const run = {
  startedAt: new Date().toISOString(),
  finishedAt: null,
  status: "running",
  samples: 0,
  validFeeds: 0,
  verifiedQuotes: 0,
  errors: 0,
  durationMinutes: duration,
  intervalSeconds: 15,
  paperTokens: tokens,
  books: capitals.map(newLiveBook),
  actions: {},
  reasons: {},
  latest: null,
  assumptions: [
    "Real chain prices, gas price and provider TVL/24h volume; no static catalogue or invented market prices.",
    "Paper token selection substitutes the manual-review gate ONLY in this experiment. Tokens have NOT been security-audited or approved for live trading.",
    "Same decide() policy as the keeper; production configuration is untouched. No wallet key or transaction broadcast is used.",
    "LP value uses a full-range constant-product approximation in ETH, not an actual NFT position.",
    "Fees are modeled from capped, discounted 24h volume APR, not measured earnings. No fees accrue across monitoring gaps.",
    "Gas budget measures entry and exit execution separately, adds 51,000 gas per leg plus 50% margin, and excludes vault deployment and any additional network data fee. Round-trip trading loss is reserved on entry; each gas leg is charged once. Estimates are not transaction receipts.",
    "The provider can lag despite a recent HTTP response. Missing/stale observations block entries; unknown valuations are null, never zero.",
    "A passing probe is state-specific and cannot guarantee future sellability. Results do not prove profitability or live safety.",
  ],
};
let stopped = false;
process.on("SIGTERM", () => {
  stopped = true;
});
process.on("SIGINT", () => {
  stopped = true;
});
let feed = null,
  lastFeedAttempt = 0;
const deadline = Date.now() + duration * 60000;
async function save() {
  const report = {
    ...run,
    netVsHoldingEth: run.books.map((b) => (b.value === null ? null : b.value - b.initial)),
  };
  await writeFile(join(directory, "report.json.tmp"), JSON.stringify(report, null, 2));
  await rename(join(directory, "report.json.tmp"), join(directory, "report.json"));
  const rows = run.books
    .map(
      (b) =>
        `| ${b.initial} | ${b.value === null ? "unknown" : b.value.toFixed(8)} | ${b.value === null ? "unknown" : (b.value - b.initial).toFixed(8)} | ${b.fees.toFixed(8)} | ${b.costs.toFixed(8)} | ${b.state.current ?? "ETH"} |`,
    )
    .join("\n");
  const summary = `# Live-market paper test\n\nStatus: **${run.status}**. Started ${run.startedAt}. Samples: ${run.samples}; successful feed fetches: ${run.validFeeds}; verified quotes: ${run.verifiedQuotes}; errors: ${run.errors}.\n\n**No real funds or transactions.**\n\n| Initial ETH | Modeled value ETH | Net vs holding ETH | Modeled fees ETH | Budgeted costs ETH | Position |\n|---|---|---|---|---|---|\n${rows}\n\n## Decisions\n\n\`\`\`json\n${JSON.stringify({ actions: run.actions, reasons: run.reasons }, null, 2)}\n\`\`\`\n\n## Limits\n\n${run.assumptions.map((s) => "- " + s).join("\n")}\n\nSee samples.ndjson for timestamped source observations, blocks, quotes, errors and decisions. A completed run with no trades is a valid finding; never force an entry to make the test look active.\n`;
  await writeFile(join(directory, "report.md"), summary);
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, summary);
}
await save();
try {
  while (!stopped && Date.now() < deadline) {
    const start = Date.now(),
      errors = [],
      record = {
        at: new Date(start).toISOString(),
        feed: null,
        chain: null,
        markets: [],
        decisions: [],
        errors,
      };
    try {
      if (start - lastFeedAttempt >= 30000) {
        lastFeedAttempt = start;
        try {
          feed = await discover();
          run.validFeeds++;
        } catch (e) {
          errors.push(e.shortMessage ?? e.message);
        }
      }
      record.feed = feed
        ? { fetchedAt: feed.fetchedAt, providerAgeSec: feed.providerAgeSec, pools: feed.pools }
        : null;
      const snapshot = await chainSnapshot();
      record.chain = { ...snapshot, gasPrice: String(snapshot.gasPrice) };
      let selected = (feed?.pools ?? [])
        .filter(
          (p) =>
            tokens.includes(p.other) &&
            p.tvlUsd >= POLICY.minTvlUsd &&
            start - p.createdAt >= POLICY.minPoolAgeMs,
        )
        .sort((a, b) => b.volume24h / b.tvlUsd - a.volume24h / a.tvlUsd)
        .slice(0, 2)
        .map((p) => ({ ...p, fetchedAt: feed.fetchedAt }));
      // A held pool disappearing from the discovery top page is queried directly.
      for (const id of new Set(run.books.map((b) => b.state.current).filter(Boolean))) {
        if (!selected.some((p) => p.id === id))
          try {
            const extra = await currentPool(id);
            selected.push(...extra.pools.map((p) => ({ ...p, fetchedAt: extra.fetchedAt })));
          } catch (e) {
            errors.push(`Held pool ${id}: ${e.shortMessage ?? e.message}`);
          }
      }
      for (let index = 0; index < run.books.length; index++) {
        const book = run.books[index],
          points = [];
        for (const pool of selected) {
          if (Date.now() - pool.fetchedAt > POLICY.maxDataAgeMs) continue;
          try {
            const p = await samplePool(
              pool,
              Math.min(0.5, Math.max(0.00000001, book.value ?? book.initial)),
              pool.fetchedAt,
              snapshot,
              tokens,
            );
            points.push(p);
            record.markets.push({ capital: book.initial, ...p });
            run.verifiedQuotes++;
          } catch (e) {
            errors.push(`${book.initial} ETH ${pool.id}: ${e.shortMessage ?? e.message}`);
          }
        }
        const result = stepLiveBook(book, points, Date.now());
        run.books[index] = result.book;
        record.decisions.push({
          capital: book.initial,
          action: result.decision.action,
          reason: result.decision.reason,
          target: result.decision.target?.id ?? null,
          valueEth: result.book.value,
          chargedEth: result.charged,
        });
      }
    } catch (e) {
      errors.push(e.shortMessage ?? e.message);
      run.books = run.books.map((book) => {
        const result = stepLiveBook(book, [], Date.now());
        record.decisions.push({
          capital: book.initial,
          action: result.decision.action,
          reason: result.decision.reason,
          valueEth: result.book.value,
        });
        return result.book;
      });
    }
    for (const d of record.decisions) {
      run.actions[d.action] = (run.actions[d.action] ?? 0) + 1;
      run.reasons[d.reason] = (run.reasons[d.reason] ?? 0) + 1;
    }
    run.samples++;
    run.errors += errors.length;
    run.latest = record;
    await appendFile(join(directory, "samples.ndjson"), JSON.stringify(record) + "\n");
    await save();
    console.log(
      JSON.stringify({
        at: record.at,
        sample: run.samples,
        quotes: record.markets.length,
        decisions: record.decisions,
        errors,
      }),
    );
    const delay = Math.min(15000 - (Date.now() - start), deadline - Date.now());
    if (delay > 0 && !stopped) await new Promise((r) => setTimeout(r, delay));
  }
  run.status = stopped ? "stopped" : run.errors ? "completed_with_data_errors" : "completed";
  if (!run.validFeeds || !run.verifiedQuotes) {
    run.status = "failed_no_verified_market_data";
    process.exitCode = 1;
  }
} finally {
  run.finishedAt = new Date().toISOString();
  await save();
}
