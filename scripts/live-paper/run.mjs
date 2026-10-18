import { mkdir, appendFile, writeFile, rename, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { newLiveBook, stepLiveBook } from "../../src/lib/live-paper.ts";
import { candidateEconomics, POLICY } from "../../src/lib/degen-policy.ts";
import { CONTRACTS } from "../../src/lib/chain.ts";
import { discover, currentPool, chainSnapshot, samplePool, seedProvider } from "./market.mjs";

import { METADATA_MAX_AGE_MS } from "./provider.mjs";
import { selectProbePools } from "./universe.mjs";
import { createPublisher } from "./publish.mjs";
import { paperReportSchema } from "../../src/lib/paper-report.ts";
import { completeReport, reportFiles, resumeReport } from "./report.mjs";
const publish = createPublisher();
const segment = Number(process.env.PAPER_SEGMENT_INDEX ?? 1);
const segments = Number(process.env.PAPER_SEGMENT_COUNT ?? 1);
if (![1, 2].includes(segment) || ![1, 2].includes(segments) || segment > segments)
  throw new Error("Invalid overnight segment");
const universe = process.env.PAPER_UNIVERSE ?? "tokens";
if (!["tokens", "discovered"].includes(universe)) throw new Error("Invalid paper universe");

const duration = Number(process.env.PAPER_DURATION_MINUTES ?? 240);
if (!Number.isFinite(duration) || duration < 0.25 || duration > 300)
  throw new Error("Duration must be 0.25–300 minutes");
const strategy = process.env.PAPER_STRATEGY ?? "baseline";
if (!["baseline", "carry48"].includes(strategy)) throw new Error("Unknown paper strategy");
const capitals = (process.env.PAPER_CAPITALS ?? "0.00045,0.1").split(",").map(Number);
if (capitals.length < 1 || capitals.length > 3 || new Set(capitals).size !== capitals.length)
  throw new Error("Use 1–3 virtual balances");
const tokens = (process.env.PAPER_TOKEN_ADDRESSES ?? CONTRACTS.usdg)
  .split(",")
  .map((s) => s.trim().toLowerCase());
if (tokens.length > 4 || !tokens.length || tokens.some((t) => !/^0x[0-9a-f]{40}$/.test(t)))
  throw new Error("Use 1–4 paper token addresses");
const directory = resolve(process.env.PAPER_OUTPUT_DIR ?? "paper-results");
await mkdir(directory, { recursive: true });
let run = {
  segment,
  segments,
  universe,
  poolCoverage: [],
  version: 1,
  runId: process.env.GITHUB_RUN_ID ?? "0",
  operations: [],
  decisions: [],
  equity: [],
  startedAt: new Date().toISOString(),
  finishedAt: null,
  status: "running",
  samples: 0,
  validFeeds: 0,
  verifiedQuotes: 0,
  errors: 0,
  durationMinutes: duration * segments,
  intervalSeconds: 15,
  paperTokens: tokens,
  books: capitals.map((capital) => newLiveBook(capital, strategy)),
  actions: {},
  reasons: {},
  latest: null,
  assumptions: [
    "Carry48 is an experimental 48-hour fee horizon with a recent-price drawdown filter, net profit exit and maximum hold. It does not predict or guarantee profit. Baseline uses six hours.",
    "Real chain prices, gas price and provider TVL/24h volume; no static catalogue or invented market prices.",
    "Paper token selection substitutes the manual-review gate ONLY in this experiment. Tokens have NOT been security-audited or approved for live trading.",
    "Overnight segments restore positions and balances. Monitoring gaps accrue no fees and cannot confirm entries. Profitable closes can re-enter after cooldown, up to four entries per rolling day; risk stops remain latched.",
    "Discovered-universe runs inspect multiple WETH pools, max two fee tiers per token and six pools per sample. Selection is experimental and is not token security approval.",
    "Same decide() policy as the keeper; production configuration is untouched. No wallet key or transaction broadcast is used.",
    "LP value uses a full-range constant-product approximation in ETH, not an actual NFT position.",
    "Fees are modeled from capped, discounted 24h volume APR, not measured earnings. No fees accrue across monitoring gaps.",
    "Gas budget measures entry and exit execution separately, adds 51,000 gas per leg plus 50% margin, and excludes vault deployment and any additional network data fee. Round-trip trading loss is reserved on entry; each gas leg is charged once. Estimates are not transaction receipts.",
    "Discovery shares one request per 65 seconds with backoff across three V3 pages, network new/trending pools and a PONS search. This is a bounded, provider-indexed sample, not all launches or proof of migration. Unsupported DEX/quote tokens are observed but never executed. Four leaders and two rotating research slots cover eligible candidates without a fixed token list. Provider metadata expires for entry after ten minutes; held pools retain live exit monitoring. All age/liquidity/security/cost gates remain mandatory.",
    "The provider can lag despite a recent HTTP response. Missing/stale observations block entries; unknown valuations are null, never zero.",
    "A passing probe is state-specific and cannot guarantee future sellability. Results do not prove profitability or live safety.",
  ],
};
if (segment > 1) {
  const saved = JSON.parse(await readFile(join(directory, "report.json"), "utf8"));
  paperReportSchema.parse(saved);
  run = resumeReport(saved, { runId: run.runId, capitals, strategy, segment });
  if (run.universe !== universe) throw new Error("Overnight universe changed");
  seedProvider(run.latest?.feed?.pools ?? []);
  seedProvider(run.heldPoolMetadata ?? []);
}
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
const quotesAtSegmentStart = run.verifiedQuotes;
async function save(final = false) {
  const report = completeReport(run);
  await writeFile(join(directory, "report.json.tmp"), JSON.stringify(report, null, 2));
  await rename(join(directory, "report.json.tmp"), join(directory, "report.json"));
  const files = reportFiles(report);
  for (const [name, content] of Object.entries(files))
    await writeFile(join(directory, name), content);
  if (process.env.GITHUB_STEP_SUMMARY)
    await writeFile(process.env.GITHUB_STEP_SUMMARY, files["report.md"]);
  await publish(paperReportSchema.parse(report), final);
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
          if (feed.requested !== false) run.validFeeds++;
        } catch (e) {
          errors.push(e.shortMessage ?? e.message);
        }
      }
      record.feed = feed
        ? {
            fetchedAt: feed.fetchedAt,
            providerAgeSec: feed.providerAgeSec,
            requestStats: feed.requestStats,
            pools: feed.pools,
          }
        : null;
      const snapshot = await chainSnapshot();
      record.chain = { ...snapshot, gasPrice: String(snapshot.gasPrice) };
      const ranked = (feed?.pools ?? []).sort(
        (a, b) => b.volume24h / b.tvlUsd - a.volume24h / a.tvlUsd,
      );
      for (const p of ranked) {
        let coverage = run.poolCoverage.find((c) => c.id === p.id);
        if (!coverage) {
          coverage = {
            id: p.id,
            label: p.label,
            token: p.other,
            dex: p.dex,
            createdAt: p.createdAt,
            firstSeenAt: record.at,
            lastSeenAt: record.at,
            tvlUsd: p.tvlUsd,
            observations: 0,
            probes: 0,
            failures: 0,
            lastReason: "",
          };
          run.poolCoverage.push(coverage);
        }
        coverage.observations++;
        coverage.lastSeenAt = record.at;
        coverage.tvlUsd = p.tvlUsd;
        coverage.lastReason = p.executionBlock
          ? p.executionBlock
          : universe !== "discovered" && !tokens.includes(p.other)
            ? "Outside selected paper tokens"
            : p.tvlUsd < POLICY.minTvlUsd
              ? "Liquidity below minimum"
              : start - p.createdAt < POLICY.minPoolAgeMs
                ? "Pool younger than seven days"
                : start - p.fetchedAt > METADATA_MAX_AGE_MS
                  ? "Provider volume metadata expired for entries"
                  : "Eligible; outside this sample's probe budget";
      }
      let selected = selectProbePools(
        ranked.filter((p) => {
          if (
            p.executionBlock ||
            (universe !== "discovered" && !tokens.includes(p.other)) ||
            p.tvlUsd < POLICY.minTvlUsd ||
            start - p.createdAt < POLICY.minPoolAgeMs ||
            start - p.fetchedAt > METADATA_MAX_AGE_MS
          )
            return false;
          return true;
        }),
        start,
      ).map((p) => ({ ...p, fetchedAt: p.fetchedAt ?? feed.fetchedAt }));
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
      run.heldPoolMetadata = selected;
      for (let index = 0; index < run.books.length; index++) {
        const book = run.books[index],
          points = [];
        for (const pool of selected) {
          try {
            const p = await samplePool(
              pool,
              Math.min(0.5, Math.max(0.00000001, book.value ?? book.initial)),
              pool.fetchedAt,
              snapshot,
              universe === "discovered" ? [pool.other] : tokens,
            );
            const coverage = run.poolCoverage.find((c) => c.id === pool.id);
            if (coverage) {
              coverage.probes++;
              coverage.lastReason = p.metadataFresh
                ? "Live chain reserves and round-trip verified; metadata fresh enough for entries"
                : "Live exit monitoring only; provider metadata older than ten minutes";
            }
            points.push(p);
            run.verifiedQuotes++;
          } catch (e) {
            const coverage = run.poolCoverage.find((c) => c.id === pool.id);
            if (coverage) {
              coverage.failures++;
              coverage.lastReason = (e.shortMessage ?? e.message).slice(0, 250);
            }
            errors.push(`${book.initial} ETH ${pool.id}: ${e.shortMessage ?? e.message}`);
          }
        }
        for (const p of points) {
          const held = points.find((q) => q.id === book.state.current);
          const economics = candidateEconomics(
            { ...p, costEth: p.costEth + (held?.exitCostEth ?? 0) },
            book.value ?? book.initial,
            held?.apr ?? 0,
            strategy === "carry48" ? 48 : undefined,
          );
          p.economics = economics;
          const coverage = run.poolCoverage.find((c) => c.id === p.id);
          if (coverage && p.metadataFresh)
            coverage.lastReason = `${book.initial} ETH: expected incremental fees ${economics.expectedFeesEth.toFixed(8)} ETH; required ${economics.requiredFeesEth.toFixed(8)} ETH; ${economics.feasible ? "cost margin passed" : "cost margin failed"} (other gates still apply)`;
        }
        record.markets.push(...points.map((p) => ({ capital: book.initial, ...p })));
        const observedAt = Date.now();
        const result = stepLiveBook(book, points, observedAt);
        run.books[index] = result.book;
        record.decisions.push({
          observedAt,
          from: book.state.current,
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
    const decisions = record.decisions.map((d) => ({ ...d, at: record.at }));
    run.decisions = [...run.decisions, ...decisions].slice(-60);
    run.operations.push(...decisions.filter((d) => ["enter", "hop", "exit"].includes(d.action)));
    run.equity.push({ at: record.at, values: run.books.map((b) => b.value) });
    run.equity = run.equity.slice(-4000);
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
  run.status = stopped
    ? "stopped"
    : segment < segments
      ? "segment_complete"
      : run.errors
        ? "completed_with_data_errors"
        : "completed";
  if (!run.validFeeds || run.verifiedQuotes === quotesAtSegmentStart) {
    run.status = "failed_no_verified_market_data";
    process.exitCode = 1;
  }
} finally {
  run.finishedAt = run.status === "segment_complete" ? null : new Date().toISOString();
  await save(true);
}
