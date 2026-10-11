import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { MigrationBadge } from "@/components/migration-rail";
import { PairAvatar } from "@/components/token-avatar";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatApr, formatPct, formatUsdCompact } from "@/lib/format";
import {
  APR_TVL_FLOOR,
  displayPair,
  estimatedApr,
  migrationStatus,
  rankByApr,
  type Pool,
  type PoolKind,
} from "@/lib/pools";
import { usePools } from "@/lib/use-pools";
import { cn } from "@/lib/cn";

type Filter = "all" | PoolKind;
type SortKey = "apr" | "tvl" | "vol";

export function MarketsView() {
  const { data } = usePools();
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<SortKey>("apr");
  const [q, setQ] = useState("");
  const pools = data ?? [];

  const visible = useMemo(() => {
    const query = q.trim().toLowerCase();
    const rows = pools.filter((p) => {
      if (filter !== "all" && p.kind !== filter) return false;
      if (!query) return true;
      const hay = `${p.tokenA.symbol} ${p.tokenB.symbol} ${p.tokenA.name} ${p.tokenB.name}`.toLowerCase();
      return hay.includes(query);
    });
    if (sort === "tvl") return [...rows].sort((a, b) => b.tvlUsd - a.tvlUsd);
    if (sort === "vol") return [...rows].sort((a, b) => b.volume24h - a.volume24h);
    return rankByApr(rows);
  }, [pools, filter, q, sort]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex rounded-md bg-surface p-1 shadow-[var(--shadow-border)]">
          {(
            [
              ["all", "All"],
              ["meme", "Meme"],
              ["stock", "Stocks"],
              ["crypto", "Crypto"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              className={cn(
                "h-10 min-w-16 rounded-sm px-3 text-sm font-medium",
                filter === id ? "bg-surface-2 text-fg" : "text-muted hover:text-fg",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex rounded-md bg-surface p-1 shadow-[var(--shadow-border)]">
            {(
              [
                ["apr", "APR"],
                ["tvl", "TVL"],
                ["vol", "Vol"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setSort(id)}
                className={cn(
                  "h-10 min-w-14 rounded-sm px-3 text-sm font-medium",
                  sort === id ? "bg-surface-2 text-fg" : "text-muted hover:text-fg",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="relative sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search NVDA, PONS, AI…"
              className="pl-9"
            />
          </div>
        </div>
      </div>

      <div className="hidden rounded-xl bg-surface shadow-[var(--shadow-border)] md:block">
        <div className="grid grid-cols-[1.7fr_0.7fr_0.8fr_0.8fr_0.7fr_0.7fr] gap-2 px-5 py-3 text-[11px] tracking-wide text-subtle uppercase">
          <span>Pool</span>
          <span>Status</span>
          <span className="text-right">TVL</span>
          <span className="text-right">Volume 24h</span>
          <span className="text-right">APR</span>
          <span className="text-right">24h</span>
        </div>
        <ul>
          {visible.map((p) => (
            <li key={p.id} className="border-t border-border">
              <PoolRow pool={p} dense />
            </li>
          ))}
        </ul>
      </div>

      <ul className="flex flex-col gap-2 md:hidden">
        {visible.map((p) => (
          <li key={p.id}>
            <PoolRow pool={p} />
          </li>
        ))}
      </ul>
      {visible.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted">No pool matches your search.</p>
      ) : null}
    </div>
  );
}

function PoolRow({ pool, dense }: { pool: Pool; dense?: boolean }) {
  const apr = estimatedApr(pool);
  const aprLabel = pool.tvlUsd >= APR_TVL_FLOOR ? formatApr(apr) : "—";
  const pair = displayPair(pool);
  const changeTone = pool.change24h >= 0 ? "text-up" : "text-down";
  const status = migrationStatus(pool);

  if (dense) {
    return (
      <Link
        to="/pool/$poolId"
        params={{ poolId: pool.id }}
        className="grid grid-cols-[1.7fr_0.7fr_0.8fr_0.8fr_0.7fr_0.7fr] items-center gap-2 px-5 py-3.5 hover:bg-surface-2"
      >
        <span className="flex min-w-0 items-center gap-3">
          <PairAvatar
            a={pool.tokenA.symbol}
            b={pool.tokenB.symbol}
            addrA={pool.tokenA.address}
            addrB={pool.tokenB.address}
            imageA={pool.imageA}
            imageB={pool.imageB}
          />
          <span className="min-w-0">
            <span className="block truncate font-medium">{pair}</span>
            <span className="block text-xs text-subtle">
              {pool.version} · {pool.feePct}% fee
            </span>
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-1">
          {status ? <MigrationBadge /> : <Badge>{pool.kind === "meme" ? "Meme" : pool.version}</Badge>}
        </span>
        <span className="text-right font-mono text-sm tabular">{formatUsdCompact(pool.tvlUsd)}</span>
        <span className="text-right font-mono text-sm tabular">{formatUsdCompact(pool.volume24h)}</span>
        <span className="text-right font-mono text-sm text-accent tabular">{aprLabel}</span>
        <span className={cn("text-right font-mono text-sm tabular", changeTone)}>
          {formatPct(pool.change24h)}
        </span>
      </Link>
    );
  }

  return (
    <Link
      to="/pool/$poolId"
      params={{ poolId: pool.id }}
      className="block rounded-lg bg-surface p-4 shadow-[var(--shadow-border)]"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="flex items-center gap-3">
          <PairAvatar
            a={pool.tokenA.symbol}
            b={pool.tokenB.symbol}
            addrA={pool.tokenA.address}
            addrB={pool.tokenB.address}
            imageA={pool.imageA}
            imageB={pool.imageB}
          />
          <span>
            <span className="block font-medium">{pair}</span>
            <span className="text-xs text-subtle">
              {pool.version} · {pool.feePct}%
            </span>
          </span>
        </span>
        <span className="flex flex-col items-end gap-1">
          {status ? <MigrationBadge /> : null}
          <span className="font-mono text-sm text-accent tabular">{aprLabel}</span>
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-subtle">TVL</dt>
          <dd className="font-mono tabular">{formatUsdCompact(pool.tvlUsd)}</dd>
        </div>
        <div>
          <dt className="text-subtle">Vol 24h</dt>
          <dd className="font-mono tabular">{formatUsdCompact(pool.volume24h)}</dd>
        </div>
        <div>
          <dt className="text-subtle">24h</dt>
          <dd className={cn("font-mono tabular", changeTone)}>{formatPct(pool.change24h)}</dd>
        </div>
      </dl>
    </Link>
  );
}
