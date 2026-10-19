import { paperTradeSchema } from "./paper-ledger.ts";
import { z } from "zod";

const amount = z.number().finite();
export const paperDecisionSchema = z.object({
  at: z.string(),
  capital: amount,
  action: z.string(),
  reason: z.string(),
  from: z.string().nullable().optional(),
  target: z.string().nullable().optional(),
  valueEth: amount.nullable(),
  chargedEth: amount.optional(),
});
export const paperReportSchema = z.object({
  version: z.literal(1),
  runId: z.string().regex(/^\d+$/),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  finishedAt: z.string().nullable(),
  status: z.string(),
  samples: z.number(),
  verifiedQuotes: z.number(),
  errors: z.number(),
  securityChecks: z.number().optional(),
  chainObservations: z.number().optional(),
  securityProviderError: z.string().nullable().optional(),
  monitor: z
    .object({
      healthy: z.boolean(),
      lastSuccessfulAt: z.number(),
      lastBlock: z.string().nullable(),
      error: z.string().nullable(),
      alerts: z.array(
        z.object({
          pool: z.string().optional(),
          token: z.string().optional(),
          reason: z.string(),
          block: z.string(),
          transactionHash: z.string().optional(),
        }),
      ),
    })
    .optional(),
  actions: z.record(z.string(), z.number()),
  reasons: z.record(z.string(), z.number()),
  books: z
    .array(
      z.object({
        strategy: z.enum(["baseline", "carry48", "launch", "guarded"]).optional(),
        initial: amount,
        cash: amount.optional(),
        positions: z
          .array(
            z.object({
              id: z.string(),
              pool: z.string(),
              token: z.string(),
              label: z.string(),
              quantityRaw: z.string(),
              allocationEth: amount,
              inputEth: amount,
              entryGasEth: amount,
              exitReserveEth: amount,
              entryAt: amount,
              entryBlock: z.string(),
              markedValueEth: amount.nullable(),
              exitRequested: z.string().optional(),
              lastQuoteAt: amount.optional(),
            }),
          )
          .max(2)
          .optional(),
        value: amount.nullable(),
        fees: amount,
        costs: amount,
        state: z.object({ current: z.string().nullable(), halted: z.boolean() }),
      }),
    )
    .min(1)
    .max(3),
  trades: z.array(paperTradeSchema).optional(),
  segment: z.number().optional(),
  segments: z.number().optional(),
  poolCoverage: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        token: z.string(),
        dex: z.string().optional(),
        createdAt: z.number().optional(),
        firstSeenAt: z.string().optional(),
        lastSeenAt: z.string().optional(),
        migrationStatus: z.literal("unconfirmed").optional(),
        creationEvidence: z.string().optional(),
        creationTransaction: z.string().optional(),
        tvlUsd: z.number(),
        observations: z.number(),
        probes: z.number(),
        failures: z.number(),
        lastReason: z.string(),
        securityStatus: z.enum(["approved", "rejected", "unknown"]).optional(),
        securityReasons: z.array(z.string()).optional(),
        securityCheckedAt: z.number().optional(),
        burnedLpFraction: amount.optional(),
      }),
    )
    .optional(),
  operations: z.array(paperDecisionSchema),
  decisions: z.array(paperDecisionSchema),
  equity: z.array(z.object({ at: z.string(), values: z.array(amount.nullable()) })),
});
export type PaperReport = z.infer<typeof paperReportSchema>;
export function newerPaperReport(current: PaperReport | null, next: PaperReport) {
  if (!current) return next;
  const order = Date.parse(next.startedAt) - Date.parse(current.startedAt);
  return order > 0 || (order === 0 && Date.parse(next.updatedAt) >= Date.parse(current.updatedAt))
    ? next
    : current;
}
export const PAPER_REPORT_URL =
  "https://raw.githubusercontent.com/urbanz95/reef-mist-pepper-cobalt/paper-reports/latest.json";
export function paperReportStale(report: PaperReport, now: number) {
  return (
    ["running", "segment_complete"].includes(report.status) &&
    now - Date.parse(report.updatedAt) > 180000
  );
}
