import { mkdir, appendFile, writeFile, rename, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { newLiveBook, stepLiveBook } from "../../src/lib/live-paper.ts";
import { validateGuardedCheckpoint } from "../../src/lib/guarded-paper.ts";
import { PAPER_RISK, PAPER_ROTATION } from "../../src/lib/paper-risk.ts";
import { fillBudget } from "../../src/lib/paper-signals.ts";
import { CONTRACTS } from "../../src/lib/chain.ts";
import { paperReportSchema } from "../../src/lib/paper-report.ts";
import { client, discover, currentPool, chainSnapshot, seedProvider } from "./market.mjs";
import {
  resolveSpotMeta,
  sampleSpotPool,
  quoteHeldExit,
  spotDepth,
  isEntryRejection,
} from "./spot-market.mjs";
import { createAdmissionRetry } from "./admission.mjs";
import { createSecurityProvider, assessPoolSecurity } from "./security.mjs";
import { createRiskMonitor } from "./risk-monitor.mjs";
import {
  selectGuardedPools,
  selectPonsDiagnostics,
  guardedRouteBlock,
  guardedAssessmentDeferred,
  rankGuardedPools,
} from "./universe.mjs";
import { METADATA_MAX_AGE_MS } from "./provider.mjs";
import { completeReport, reportFiles, resumeReport } from "./report.mjs";
import { createPublisher } from "./publish.mjs";

const duration = Number(process.env.PAPER_DURATION_MINUTES ?? 240),
  segment = Number(process.env.PAPER_SEGMENT_INDEX ?? 1),
  segments = Number(process.env.PAPER_SEGMENT_COUNT ?? 1);
if (
  !Number.isFinite(duration) ||
  duration < 0.25 ||
  duration > 300 ||
  ![1, 2].includes(segment) ||
  ![1, 2].includes(segments) ||
  segment > segments
)
  throw new Error("Invalid guarded paper duration/segments");
const capitals = (process.env.PAPER_CAPITALS ?? ".1,.5").split(",").map(Number);
if (capitals.length < 1 || capitals.length > 3 || new Set(capitals).size !== capitals.length)
  throw new Error("Use 1–3 independent virtual balances");
const universe = process.env.PAPER_UNIVERSE ?? "discovered";
if (!["tokens", "discovered"].includes(universe)) throw new Error("Invalid paper universe");
const tokens = (process.env.PAPER_TOKEN_ADDRESSES ?? CONTRACTS.usdg)
  .split(",")
  .map((t) => t.trim().toLowerCase());
if (tokens.some((t) => !/^0x[0-9a-f]{40}$/.test(t)) || tokens.length > 4)
  throw new Error("Invalid paper token selection");
const directory = resolve(process.env.PAPER_OUTPUT_DIR ?? "paper-results");
await mkdir(directory, { recursive: true });
const publish = createPublisher(),
  security = createSecurityProvider(),
  admissionRetry = createAdmissionRetry();
let run = {
  version: 1,
  executionProfile: "pons-v2",
  securityProfile: "single-token-v1",
  strategyProfile: PAPER_ROTATION.version,
  runId: process.env.GITHUB_RUN_ID ?? "0",
  segment,
  segments,
  universe,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  status: "running",
  samples: 0,
  validFeeds: 0,
  verifiedQuotes: 0,
  entryAttempts: 0,
  executionQuotes: 0,
  costQualifiedQuotes: 0,
  entryRejections: 0,
  priceObservations: 0,
  diagnosticProbes: 0,
  securityChecks: 0,
  chainObservations: 0,
  errors: 0,
  durationMinutes: duration * segments,
  intervalSeconds: 5,
  books: capitals.map((c) => newLiveBook(c, "guarded")),
  actions: {},
  reasons: {},
  operations: [],
  decisions: [],
  equity: [],
  poolCoverage: [],
  latest: null,
  heldPoolMetadata: [],
  priceWatchMetadata: [],
  riskPolicy: PAPER_RISK,
  strategyPolicy: PAPER_ROTATION,
  assumptions: [
    "Virtual spot experiment only: no private key, signing or transaction broadcast. No guaranteed profit. Pool age has no minimum in this paper experiment.",
    "At most two independent positions per balance, each at most 2% of initial/current equity; at most 4% allocated, including reserved gas. At least 96% stays as unallocated ETH on initial entry. Later losses can change that percentage.",
    "A sale-only eth_call uses the EXACT quantity virtually held, with a proved ERC20 balance storage override. It does not buy first or alter pool reserves. Unsupported token accounting, stale quotes and reverts produce UNKNOWN value; no invented fills.",
    "Reported positions are hypothetical independent of the real pool: paper buys do not change future chain state. Sale quotes include pool fees/impact and an exit gas estimate, with 51,000 gas allowance and 50% margin. Additional data fees are excluded. These are not transaction receipts.",
    "Entry requires fresh GoPlus screening, no explicit risk flags, creator/owner <=1%, each non-protected holder <=5%, observed top holders <=20%, and holder coverage. For the exact reviewed Pons token runtime only, factory-bound immutable bytecode proves no administrative owner and unrestricted full-balance transfers; on-chain immutable issuer holdings replace the provider's deployment-helper identity. Other missing evidence blocks entry.",
    "Liquidity proof supports canonical V2 >=95% burned LP, and registered Pons V4 permanent seed positions with a pinned reviewed locker runtime, matching pool/range/owner, no NFT approval and >=95% of active liquidity. Curves, unreviewed earlier lockers and generic V3/V4 remain observation-only for entries.",
    "Pons curves and graduated V4 pools have separate identity, stage and read-only execution probes. Up to one curve and one graduated pool are diagnostically tested every 30 seconds even when entry gates fail. Passing an execution probe does not authorize a trade. Partial curve fills and closed graduation phases are rejected, not booked as full purchases.",
    "Issuer/owner/shared top-three-holder addresses prevent correlated simultaneous entries. This is limited address correlation, not a complete related-wallet or funding-graph investigation. Burning LP alone does not eliminate token/market risk.",
    "The block monitor polls every second and scans every intervening block in bounded ranges. Liquidity burns/removals, reserve falls, mints and ownership changes request exit. Normal valuation targets five seconds; slow RPC can delay it. A rug within one transaction may complete before detection or exit.",
    "Paper rotation uses a $20,000 liquidity floor AND a buy no larger than 0.25% of executable funding depth. Entry needs 60 seconds of continuous prices and 30 seconds of cost-covered trend confirmation, rise >=max(0.3%, 1.5 times measured costs/allocation), positive recent trend, no 1% drawdown or >15% spike. All-in round-trip costs over 1% of allocation block entry. A successful execution quote alone does not prove an affordable or profitable route.",
    "Canonical prices for up to eight pools with fresh liquidity-protection proof are observed independently of GoPlus approval and entry-probe success, after held-position handling. Their original block/time is retained; a recovered continuous suffix replaces evidence before a gap. Prices observed in this iteration are available to the next iteration; current full security and execution approval is still required to enter. Rejected new-entry probes use a per-pool/per-capital cooldown; held sales never use it.",
    "Per-position net profit target 1%, allocation loss trigger 3%, trailing trigger 2% from the measured liquidation high-water, depth drop 30%, maximum hold 15 minutes; a stalled non-profitable trend can close after five minutes. Entry swap/gas friction establishes the initial liquidation baseline rather than an immediate trailing loss. A stronger confirmed candidate can replace a position held for at least two minutes only when its observed advantage exceeds switching costs plus 0.3%. Momentum is an observed signal, not forecast profit. Stops do not guarantee execution.",
    "Security deterioration or unavailable block monitoring requests exit and latches entries. Missing exact-sale quotes keep positions open and value unknown. Exit gas must fit its reserve. Ordinary price stops cool only that token for 30 minutes; a 1% total portfolio loss latches entries. Other positions remain monitored.",
    "Up to six entries per rolling hour and 24 per rolling day; ten-minute per-token cooldown after other closes. Segments restore quantities, cash, gas reserves and ledgers; monitoring gaps reset confirmation and request held exits. No real keeper parameters or contracts are changed.",
    "Discovery uses provider-indexed new/trending pages with shared rate limits and backoff. Pool creation evidence does not prove migration from a launchpad. Unverified migration remains unconfirmed.",
  ],
};
if (segment > 1) {
  const saved = JSON.parse(await readFile(join(directory, "report.json"), "utf8"));
  paperReportSchema.parse(saved);
  run = resumeReport(saved, { runId: run.runId, capitals, strategy: "guarded", segment });
  if (
    run.universe !== universe ||
    run.strategyProfile !== PAPER_ROTATION.version ||
    run.books.some((b) => b.portfolioVersion !== 2 || !Array.isArray(b.positions))
  )
    throw new Error("Guarded checkpoint mismatch; refusing legacy all-in state");
  seedProvider(run.latest?.feed?.pools ?? []);
  seedProvider(run.heldPoolMetadata ?? []);
  for (const book of run.books) validateGuardedCheckpoint(book);
}
for (const key of [
  "entryAttempts",
  "executionQuotes",
  "costQualifiedQuotes",
  "entryRejections",
  "priceObservations",
])
  run[key] ??= 0;
run.priceWatchMetadata ??= [];
const monitor = createRiskMonitor(client, Date.now, run.monitorCheckpoint);
let stopped = false,
  feed = null,
  lastFeedAttempt = 0;
let lastDiagnostics = 0;
process.on("SIGTERM", () => {
  stopped = true;
});
process.on("SIGINT", () => {
  stopped = true;
});
const deadline = Date.now() + duration * 60000,
  initialObservations = run.chainObservations;
const metadata = new Map(
  [...run.priceWatchMetadata, ...run.heldPoolMetadata].map((p) => [p.id, p]),
);
let priceObservations = run.latest?.priceObservations ?? [];
async function heldForMonitor() {
  return run.books
    .flatMap((b) => b.positions ?? [])
    .map((p) => ({
      ...p,
      dex: metadata.get(p.pool)?.dex,
      funding0: metadata.get(p.pool)?.funding0,
      watchPool: metadata.get(p.pool)?.executionId,
      factory: metadata.get(p.pool)?.factory,
    }));
}
async function save(final = false) {
  run.monitorCheckpoint = monitor.checkpoint;
  run.monitor = monitor.snapshot;
  run.securityProviderError = security.lastError;
  run.securityProvider = security.snapshot;
  const report = completeReport(run);
  await writeFile(join(directory, "report.json.tmp"), JSON.stringify(report, null, 2));
  await rename(join(directory, "report.json.tmp"), join(directory, "report.json"));
  const files = reportFiles(report);
  for (const [name, content] of Object.entries(files))
    await writeFile(join(directory, name), content);
  if (process.env.GITHUB_STEP_SUMMARY)
    await writeFile(process.env.GITHUB_STEP_SUMMARY, files["report.md"]);
  // Publish a real observation first; an empty startup snapshot can otherwise
  // occupy the public CDN cache while healthy measurements are already running.
  if (run.samples > 0 || final) await publish(paperReportSchema.parse(report), final);
}
function addDecisions(record, result, book) {
  const events = result.events?.length
    ? result.events
    : [{ ...result.decision, chargedEth: result.charged }];
  for (const e of events)
    record.decisions.push({
      observedAt: Date.now(),
      capital: book.initial,
      from: e.action === "exit" || e.action === "blocked" ? (e.pool ?? null) : null,
      target: e.target?.id ?? null,
      action: e.action,
      reason: e.reason,
      valueEth: result.book.value,
      chargedEth: e.chargedEth ?? 0,
    });
}
async function observePrices(record, selected, assessments, assessmentSnapshot) {
  const watched = [
    ...new Map(
      [
        ...run.books.flatMap((b) => b.positions ?? []).map((p) => metadata.get(p.pool)),
        ...run.priceWatchMetadata.map((p) => metadata.get(p.id) ?? p),
        ...selected,
      ]
        .filter(Boolean)
        .map((p) => [p.id, p]),
    ).values(),
  ].slice(0, 8);
  // Price research runs after all held-position decisions. It cannot defer a
  // sale and never turns an unsupported token/security result into admission.
  for (let offset = 0; offset < watched.length; offset += 4)
    await Promise.all(
      watched.slice(offset, offset + 4).map(async (pool) => {
        try {
          let snap = assessmentSnapshot,
            assessment = assessments.get(pool.id);
          if (!assessment || Date.now() - snap.at > 60000) {
            snap = await chainSnapshot();
            assessment = await assessPoolSecurity(client, pool, snap, security);
            run.securityChecks++;
          }
          if (
            assessment.liquidityBlock !== snap.block ||
            !(assessment.protectedLiquidityFraction >= 0.95)
          ) {
            record.priceObservationSkips.push({
              pool: pool.id,
              reason: "Fresh canonical liquidity-protection proof unavailable",
            });
            return;
          }
          const depth = await spotDepth(client, pool, snap);
          if (!Number.isFinite(depth.priceEth) || depth.priceEth <= 0)
            throw new Error("Canonical pool price is invalid");
          record.priceObservations.push({
            id: pool.id,
            at: snap.at,
            price: depth.priceEth,
            block: snap.block,
          });
          metadata.set(pool.id, {
            ...pool,
            funding0: depth.m.funding0,
            executionId: depth.m.executionId,
            factory: depth.m.stack?.factory,
          });
        } catch (e) {
          record.errors.push(`Price ${pool.id}: ${e.shortMessage ?? e.message}`);
        }
      }),
    );
  // Keep previously approved identities available when discovery rotates away.
  // Retention is observation-only; fresh LP proof is repeated on every sample.
  const previous = new Set(run.priceWatchMetadata.map((p) => p.id));
  run.priceWatchMetadata = watched
    .filter(
      (p) =>
        previous.has(p.id) ||
        run.poolCoverage.some((c) => c.id === p.id && c.securityApprovedCount > 0),
    )
    .map((p) => metadata.get(p.id) ?? p);
  run.priceObservations += record.priceObservations.length;
  priceObservations = record.priceObservations;
}
await save();
monitor.setPositions(await heldForMonitor());
await monitor.poll();
monitor.start();
try {
  while (!stopped && Date.now() < deadline) {
    const start = Date.now(),
      record = {
        at: new Date(start).toISOString(),
        feed: null,
        chain: null,
        markets: [],
        exitQuotes: [],
        priceObservations: [],
        priceObservationsUsed: priceObservations,
        priceObservationSkips: [],
        decisions: [],
        errors: [],
        rejections: [],
      };
    try {
      // Once an alarm is pending, spend the iteration on held-position sales first.
      const alarm = monitor.snapshot.alerts.length > 0;
      if (!alarm && start - lastFeedAttempt >= 5000) {
        lastFeedAttempt = start;
        try {
          feed = await discover();
          if (feed.requested !== false) run.validFeeds++;
          for (const p of feed.pools) metadata.set(p.id, { ...metadata.get(p.id), ...p });
        } catch (e) {
          record.errors.push(`Discovery: ${e.shortMessage ?? e.message}`);
        }
      }
      record.feed = feed
        ? { fetchedAt: feed.fetchedAt, requestStats: feed.requestStats, pools: feed.pools }
        : null;
      const ranked = rankGuardedPools(feed?.pools ?? []);
      for (const p of ranked) {
        let c = run.poolCoverage.find((c) => c.id === p.id);
        if (!c) {
          c = {
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
          run.poolCoverage.push(c);
        }
        c.observations++;
        c.lastSeenAt = record.at;
        c.tvlUsd = p.tvlUsd;
        c.securityData = security.dataStatus(p.other, start);
        if (
          c.securityStatus === "approved" &&
          start - c.securityCheckedAt > PAPER_RISK.maxSecurityAgeMs
        ) {
          c.securityStatus = "unknown";
          c.securityReasons = [
            "Previous security approval expired; a fresh assessment is required",
          ];
        }
        c.entryBlockReason =
          p.executionBlock ??
          (p.tvlUsd < PAPER_ROTATION.minTvlUsd
            ? "Liquidity below paper spot minimum ($20,000)"
            : start - p.fetchedAt > METADATA_MAX_AGE_MS
              ? "Provider metadata expired"
              : (guardedRouteBlock(p, c) ?? guardedAssessmentDeferred(c, start)));
        c.lastReason = c.entryBlockReason ?? "Outside this sample security-check budget";
      }
      const eligible = ranked.filter(
        (p) =>
          !p.executionBlock &&
          p.tvlUsd >= PAPER_ROTATION.minTvlUsd &&
          start - p.fetchedAt <= METADATA_MAX_AGE_MS &&
          (universe === "discovered" || tokens.includes(p.other)),
      );
      const selection = selectGuardedPools(eligible, run.probeWindow, run.poolCoverage, start);
      const diagnostics =
        !alarm && start - lastDiagnostics >= 30000 ? selectPonsDiagnostics(ranked, start) : [];
      if (diagnostics.length) lastDiagnostics = start;
      run.probeWindow = selection.window;
      const held = run.books.flatMap((b) => b.positions ?? []);
      // Restore held metadata even if discovery rotates away from these pools.
      for (const id of new Set(held.map((p) => p.pool)))
        if (!metadata.has(id)) {
          const extra = await currentPool(id);
          for (const p of extra.pools) metadata.set(p.id, p);
        }
      const selected = [
        ...new Map(
          [
            ...held.map((p) => metadata.get(p.pool)).filter(Boolean),
            ...selection.selected,
            ...diagnostics,
          ].map((p) => [p.id, p]),
        ).values(),
      ];
      await security.refresh(
        selected.map((p) => p.other),
        { priorityTokens: held.map((p) => p.token) },
      );
      let snapshot = await chainSnapshot();
      run.chainObservations++;
      record.chain = { ...snapshot, gasPrice: String(snapshot.gasPrice) };
      const assessments = new Map(),
        assessmentSnapshot = snapshot;
      await Promise.all(
        selected.map(async (p) => {
          const assessment = await assessPoolSecurity(client, p, snapshot, security);
          assessments.set(p.id, assessment);
          run.securityChecks++;
          const c = run.poolCoverage.find((c) => c.id === p.id);
          if (c) {
            c.securityStatus = assessment.status;
            c.securityReasons = assessment.reasons;
            c.securityCheckedAt = assessment.checkedAt;
            c.securityData = assessment.providerData;
            c.tokenEvidence = assessment.tokenEvidence;
            if (assessment.status === "approved")
              c.securityApprovedCount = (c.securityApprovedCount ?? 0) + 1;
            c.burnedLpFraction = assessment.burnedLpFraction;
            c.liquidityKind = assessment.liquidityKind;
            c.protectedLiquidityFraction = assessment.protectedLiquidityFraction;
            c.lastReason =
              assessment.status === "approved"
                ? "Security gates passed; awaiting price/cost confirmation"
                : `${assessment.status}: ${assessment.reasons.join("; ")}`;
          }
        }),
      );
      const entryChecks = selection.selected.map((p) => assessments.get(p.id));
      run.entryScreening = {
        observed: ranked.length,
        liquidityEligible: eligible.filter(
          (p) =>
            !guardedRouteBlock(
              p,
              run.poolCoverage.find((c) => c.id === p.id),
            ),
        ).length,
        selected: entryChecks.length,
        approved: entryChecks.filter((a) => a?.status === "approved").length,
        rejected: entryChecks.filter((a) => a?.status === "rejected").length,
        unknown: entryChecks.filter((a) => a?.status === "unknown").length,
      };
      // Diagnostic calls are evidence only. They never become engine candidates.
      for (const pool of diagnostics) {
        const c = run.poolCoverage.find((c) => c.id === pool.id),
          input = run.books[0].initial * 0.02 * 0.95;
        run.diagnosticProbes = (run.diagnosticProbes ?? 0) + 1;
        try {
          const snap = await chainSnapshot();
          const m = await resolveSpotMeta(client, pool, snap);
          if (c) {
            c.stage = m.stage;
            c.migrationStatus = m.stage === "graduated" ? "confirmed" : "unconfirmed";
            c.creationEvidence = m.evidence.status;
          }
          const p = await sampleSpotPool(client, pool, input, pool.fetchedAt, snap, {
              diagnosticOnly: true,
            }),
            q = await quoteHeldExit(client, pool, p.quantityRaw, snap);
          run.verifiedQuotes += 2;
          record.markets.push({
            ...p,
            capital: run.books[0].initial,
            diagnosticOnly: true,
            security: assessments.get(pool.id),
          });
          record.exitQuotes.push({ ...q, diagnosticOnly: true });
          if (c) {
            c.probes++;
            c.stage = p.stage;
            c.migrationStatus = p.migrationStatus;
            c.creationEvidence = p.creationEvidence.status;
            c.lastSimulation = {
              status: "passed",
              at: new Date().toISOString(),
              block: snap.block,
              inputEth: input,
              quantityRaw: p.quantityRaw,
              receivedEth: q.receivedEth,
              gasEth: p.buyGasEth + q.gasEth,
              recovery: p.executionRecovery,
              costGatePassed: p.roundTripOk,
            };
          }
        } catch (e) {
          if (c) {
            c.failures++;
            c.lastSimulation = {
              status: "unavailable",
              at: new Date().toISOString(),
              inputEth: input,
              reason: (e.shortMessage ?? e.message).slice(0, 300),
            };
          }
        }
      }
      for (let i = 0; i < run.books.length; i++) {
        const book = run.books[i],
          points = [],
          exitQuotes = [],
          localAlerts = [];
        // Screen replacements even with both slots occupied. The engine still
        // checks the exact available allocation before settling a rotation.
        const budget =
          book.value === null
            ? 0
            : Math.min(book.initial, book.value) * PAPER_RISK.positionFraction;
        const canEnter = budget > 0 && !alarm && !book.state.halted && book.value !== null;
        if (canEnter) {
          const candidates = selection.selected.filter(
            (p) =>
              assessments.get(p.id)?.status === "approved" &&
              !book.positions.some((h) => h.token === p.other),
          );
          await Promise.all(
            candidates.map(async (pool) => {
              const c = run.poolCoverage.find((c) => c.id === pool.id),
                retryKey = `${pool.id}:${book.initial}`,
                cooling = admissionRetry.get(retryKey);
              if (cooling) {
                if (c)
                  c.lastReason = `Entry probe deferred until ${new Date(cooling.nextRetryAt).toISOString()}: ${cooling.reason}`;
                return;
              }
              try {
                const snap = await chainSnapshot();
                const admission = await assessPoolSecurity(client, pool, snap, security);
                if (admission.status !== "approved") {
                  if (c) {
                    c.securityStatus = admission.status;
                    c.securityReasons = admission.reasons;
                    c.lastReason = admission.reasons.join("; ");
                  }
                  return;
                }
                run.entryAttempts++;
                const point = await sampleSpotPool(
                  client,
                  pool,
                  budget * 0.95,
                  pool.fetchedAt,
                  snap,
                );
                point.entryExitQuote = await quoteHeldExit(client, pool, point.quantityRaw, snap);
                point.security = admission;
                const fill = fillBudget(point, budget, Date.now());
                if (fill && Date.now() - point.fetchedAt <= 10000) run.executionQuotes++;
                if (
                  fill &&
                  fill.costFraction <= PAPER_ROTATION.maxEntryCostFraction &&
                  Date.now() - point.fetchedAt <= 10000
                ) {
                  run.costQualifiedQuotes++;
                  admissionRetry.clear(retryKey);
                } else if (fill && fill.costFraction > PAPER_ROTATION.maxEntryCostFraction) {
                  const reason = `Measured all-in round-trip costs ${(100 * fill.costFraction).toFixed(2)}% exceed the ${(100 * PAPER_ROTATION.maxEntryCostFraction).toFixed(2)}% allocation limit`;
                  admissionRetry.reject(retryKey, reason);
                  record.rejections.push({ pool: pool.id, capital: book.initial, reason });
                } else if (!fill && Date.now() - point.entryExitQuote.fetchedAt <= 10000) {
                  const reason =
                    "Measured exact sale cannot fund the allocation, exit reserve or immediate loss gate";
                  admissionRetry.reject(retryKey, reason);
                  record.rejections.push({ pool: pool.id, capital: book.initial, reason });
                }
                const m = await resolveSpotMeta(client, pool, snap);
                metadata.set(pool.id, {
                  ...pool,
                  funding0: m.funding0,
                  executionId: m.executionId,
                  factory: m.stack?.factory,
                });
                points.push(point);
                run.verifiedQuotes += 2;
                if (c) {
                  c.probes++;
                  c.creationEvidence = point.creationEvidence.status;
                  c.creationTransaction = point.creationEvidence.transactionHash;
                  c.migrationStatus = point.migrationStatus ?? "unconfirmed";
                  c.stage = point.stage;
                  c.lastReason = `Security approved; 2% allocation ${budget.toFixed(8)} ETH, exact sale verified; awaiting momentum/cost confirmation`;
                }
              } catch (e) {
                const reason = e.shortMessage ?? e.message;
                if (c) {
                  c.failures++;
                  c.lastReason = `Entry unavailable: ${reason.slice(0, 220)}`;
                }
                if (isEntryRejection(e)) {
                  admissionRetry.reject(retryKey, reason);
                  record.rejections.push({ pool: pool.id, capital: book.initial, reason });
                } else record.errors.push(`Entry ${pool.id}: ${reason}`);
              }
            }),
          );
        }
        // Held quantities are quoted even when a new buy or security assessment fails.
        snapshot = await chainSnapshot();
        await Promise.all(
          book.positions.map(async (pos) => {
            const pool = metadata.get(pos.pool);
            if (!pool) {
              record.errors.push(`Held metadata unavailable: ${pos.pool}`);
              return;
            }
            const assessment = assessments.get(pool.id);
            if (!assessment || assessment.status !== "approved")
              localAlerts.push({
                pool: pos.pool,
                reason: `Held security ${assessment?.status ?? "unknown"}`,
                block: snapshot.block,
              });
            try {
              const q = await quoteHeldExit(client, pool, pos.quantityRaw, snapshot);
              exitQuotes.push(q);
              run.verifiedQuotes++;
            } catch (e) {
              record.errors.push(`Held sale ${pos.pool}: ${e.shortMessage ?? e.message}`);
            }
            try {
              const depth = await spotDepth(client, pool, snapshot);
              points.push({
                id: pool.id,
                label: pool.label,
                token: pos.token,
                apr: 0,
                priceEth: depth.priceEth,
                reserveEth: depth.reserveEth,
                tvlUsd: pool.tvlUsd,
                createdAt: pool.createdAt,
                reviewed: false,
                factoryVerified: true,
                roundTripOk: false,
                costEth: 0,
                entryCostEth: 0,
                exitCostEth: 0,
                fetchedAt: snapshot.at,
                security: assessment,
              });
              metadata.set(pool.id, {
                ...pool,
                funding0: depth.m.funding0,
                executionId: depth.m.executionId,
                factory: depth.m.stack?.factory,
              });
            } catch (e) {
              record.errors.push(`Held depth ${pos.pool}: ${e.shortMessage ?? e.message}`);
            }
          }),
        );
        const risk = monitor.snapshot;
        record.markets.push(...points.map((p) => ({ capital: book.initial, ...p })));
        record.exitQuotes.push(...exitQuotes.map((q) => ({ capital: book.initial, ...q })));
        const result = stepLiveBook(book, points, Date.now(), {
          exitQuotes,
          priceObservations: record.priceObservationsUsed,
          alerts: [...risk.alerts, ...localAlerts],
          monitorHealthy: risk.healthy,
        });
        record.entrySignals ??= [];
        record.entrySignals.push(...result.signals.map((s) => ({ ...s, capital: book.initial })));
        for (const signal of result.signals) {
          const c = run.poolCoverage.find((p) => p.id === signal.pool);
          if (c) c.lastReason = `${book.initial} ETH: ${signal.reason}`;
        }
        run.books[i] = result.book;
        addDecisions(record, result, book);
      }
      monitor.setPositions(await heldForMonitor());
      await observePrices(record, selection.selected, assessments, assessmentSnapshot);
      run.entrySignals = record.entrySignals ?? [];
      record.monitor = monitor.snapshot;
      run.monitor = record.monitor;
    } catch (e) {
      record.errors.push(e.shortMessage ?? e.message);
      for (let i = 0; i < run.books.length; i++) {
        const b = run.books[i],
          result = stepLiveBook(b, [], Date.now(), { monitorHealthy: false });
        run.books[i] = result.book;
        addDecisions(record, result, b);
      }
    }
    for (const d of record.decisions) {
      run.actions[d.action] = (run.actions[d.action] ?? 0) + 1;
      run.reasons[d.reason] = (run.reasons[d.reason] ?? 0) + 1;
    }
    run.samples++;
    run.errors += record.errors.length;
    run.entryRejections += record.rejections.length;
    run.latest = record;
    const decisions = record.decisions.map((d) => ({ ...d, at: record.at }));
    run.decisions = [...run.decisions, ...decisions].slice(-100);
    run.operations.push(...decisions.filter((d) => ["enter", "exit"].includes(d.action)));
    run.equity.push({ at: record.at, values: run.books.map((b) => b.value) });
    run.heldPoolMetadata = [...new Set(run.books.flatMap((b) => b.positions.map((p) => p.pool)))]
      .map((id) => metadata.get(id))
      .filter(Boolean);
    await appendFile(join(directory, "samples.ndjson"), JSON.stringify(record) + "\n");
    await save();
    console.log(
      JSON.stringify({
        at: record.at,
        sample: run.samples,
        decisions: record.decisions,
        securityChecks: run.securityChecks,
        quotes: run.verifiedQuotes,
        priceObservations: record.priceObservations.length,
        entryAttempts: run.entryAttempts,
        executionQuotes: run.executionQuotes,
        costQualifiedQuotes: run.costQualifiedQuotes,
        rejections: record.rejections,
        errors: record.errors,
      }),
    );
    while (!stopped && Date.now() < Math.min(start + 5000, deadline)) {
      if (monitor.snapshot.alerts.length) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  run.status = stopped
    ? "stopped"
    : segment < segments
      ? "segment_complete"
      : run.errors
        ? "completed_with_data_errors"
        : "completed";
  if (
    !run.validFeeds ||
    !run.poolCoverage.length ||
    run.chainObservations === initialObservations
  ) {
    run.status = "failed_no_verified_market_data";
    process.exitCode = 1;
  }
} finally {
  await monitor.stop();
  run.finishedAt = run.status === "segment_complete" ? null : new Date().toISOString();
  await save(true);
}
