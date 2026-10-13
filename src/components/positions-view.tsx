import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Layers } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { explorerTx } from "@/lib/chain";
import { formatApr, formatNum, formatUsd } from "@/lib/format";
import { accruedFeesUsd, usePositions } from "@/lib/position-store";

export function PositionsView() {
  const positions = usePositions((s) => s.positions);
  const remove = usePositions((s) => s.remove);
  const total = positions.reduce((s, p) => s + p.usd, 0);
  const fees = positions.reduce((s, p) => s + accruedFeesUsd(p), 0);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Positions</h1>
        <p className="mt-1 text-sm text-muted">
          Active liquidity on Robinhood Chain.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        <div className="rounded-lg bg-surface px-4 py-3 shadow-[var(--shadow-border)]">
          <p className="text-[11px] tracking-wide text-subtle uppercase">Value</p>
          <p className="mt-1 font-mono text-xl tabular">{formatUsd(total)}</p>
        </div>
        <div className="rounded-lg bg-surface px-4 py-3 shadow-[var(--shadow-border)]">
          <p className="text-[11px] tracking-wide text-subtle uppercase">Accrued fees</p>
          <p className="mt-1 font-mono text-xl text-accent tabular">{formatUsd(fees)}</p>
        </div>
        <div className="col-span-2 rounded-lg bg-surface px-4 py-3 shadow-[var(--shadow-border)] md:col-span-1">
          <p className="text-[11px] tracking-wide text-subtle uppercase">Positions</p>
          <p className="mt-1 font-mono text-xl tabular">{positions.length}</p>
        </div>
      </div>

      {positions.length === 0 ? (
        <div className="flex flex-col items-center rounded-xl bg-surface px-6 py-16 text-center shadow-[var(--shadow-border)]">
          <Layers className="size-8 text-subtle" />
          <h2 className="mt-4 text-lg font-semibold">No liquidity yet</h2>
          <p className="mt-1 max-w-sm text-sm text-muted">
            Open a pool, pick a range, and deposit on-chain.
          </p>
          <Button asChild className="mt-6">
            <Link to="/">View markets</Link>
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {positions.map((p) => {
            const feesNow = accruedFeesUsd(p);
            return (
              <li
                key={p.id}
                className="rounded-xl bg-surface p-4 shadow-[var(--shadow-border)] md:p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-lg font-semibold">{p.pair}</p>
                    <p className="text-xs text-subtle">
                      {p.version} · {p.feePct}% · APR at open {formatApr(p.aprAtOpen)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={p.inRange ? "up" : "down"}>
                      {p.inRange ? "In range" : "Out of range"}
                    </Badge>
                    <Badge tone={p.status === "onchain" ? "accent" : "neutral"}>
                      {p.status === "pending" ? "Pending" : "On-chain"}
                    </Badge>
                  </div>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                  <div>
                    <dt className="text-xs text-subtle">Value</dt>
                    <dd className="font-mono tabular">{formatUsd(p.usd)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-subtle">{p.tokenA}</dt>
                    <dd className="font-mono tabular">{formatNum(p.amountA, 5)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-subtle">{p.tokenB}</dt>
                    <dd className="font-mono tabular">{formatNum(p.amountB, 5)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-subtle">Fees</dt>
                    <dd className="font-mono text-accent tabular">{formatUsd(feesNow)}</dd>
                  </div>
                </dl>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button asChild variant="secondary" size="sm">
                    <Link to="/pool/$poolId" params={{ poolId: p.poolId }}>
                      Manage pool
                    </Link>
                  </Button>
                  {p.txHash ? (
                    <Button asChild variant="outline" size="sm">
                      <a href={explorerTx(p.txHash)} target="_blank" rel="noreferrer">
                        View tx
                      </a>
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    onClick={() => {
                      remove(p.id);
                      toast.message("Position removed.");
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
