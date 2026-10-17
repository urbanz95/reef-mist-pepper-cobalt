import { z } from "zod";
export const paperTradeSchema = z.object({
  id: z.string(),
  capital: z.number(),
  pool: z.string(),
  label: z.string(),
  entryAt: z.string().datetime(),
  exitAt: z.string().datetime().nullable(),
  entryValueEth: z.number(),
  valueEth: z.number().nullable(),
  durationSec: z.number(),
  feesEth: z.number(),
  costsEth: z.number(),
  pnlEth: z.number().nullable(),
  exitReason: z.string().nullable(),
  feeBaseline: z.number(),
});
export type PaperTrade = z.infer<typeof paperTradeSchema>;

/** Immutable per-position accounting; entryValue is cash before its entry cost. */
export function recordPaperTrade(
  previous: PaperTrade[],
  capital: number,
  action: string,
  now: number,
  value: number | null,
  totalFees: number,
  target: { id: string; label: string; entryCostEth: number } | undefined,
  entryValue: number,
  exitCost: number,
  reason: string,
) {
  const trades = previous.map((t) => ({ ...t }));
  const open = [...trades].reverse().find((t) => !t.exitAt);
  if (open) {
    open.durationSec = Math.max(0, (now - Date.parse(open.entryAt)) / 1000);
    open.feesEth = totalFees - open.feeBaseline;
    open.valueEth =
      action === "hop" && value !== null ? value + (target?.entryCostEth ?? 0) : value;
    open.pnlEth = open.valueEth === null ? null : open.valueEth - open.entryValueEth;
    if (action === "exit" || action === "hop") {
      open.exitAt = new Date(now).toISOString();
      open.exitReason = reason;
      open.costsEth += exitCost;
    }
  }
  if ((action === "enter" || action === "hop") && target && value !== null) {
    const basis = action === "hop" ? value + target.entryCostEth : entryValue;
    trades.push({
      id: `${capital}:${now}:${target.id}`,
      capital,
      pool: target.id,
      label: target.label,
      entryAt: new Date(now).toISOString(),
      exitAt: null,
      entryValueEth: basis,
      valueEth: value,
      durationSec: 0,
      feesEth: 0,
      costsEth: target.entryCostEth,
      pnlEth: value - basis,
      exitReason: null,
      feeBaseline: totalFees,
    });
  }
  return trades;
}
