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
  actions: z.record(z.string(), z.number()),
  reasons: z.record(z.string(), z.number()),
  books: z
    .array(
      z.object({
        initial: amount,
        value: amount.nullable(),
        fees: amount,
        costs: amount,
        state: z.object({ current: z.string().nullable(), halted: z.boolean() }),
      }),
    )
    .min(1)
    .max(3),
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
  return report.status === "running" && now - Date.parse(report.updatedAt) > 180000;
}
