import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { PairAvatar } from "@/components/token-avatar";
import { Badge } from "@/components/ui/badge";
import { formatAge, formatApr, formatUsdCompact } from "@/lib/format";
import { displayPair, estimatedApr, speculativeSymbol, uniqueMigratedTokens, type Pool } from "@/lib/pools";

function useNow(intervalMs = 15_000) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function MigrationAge({ iso, className }: { iso?: string; className?: string }) {
  const now = useNow();
  if (!iso) return null;
  return <span className={className}>{now ? formatAge(iso, now) : "Migrated"}</span>;
}

export function MigrationBadge() {
  return (
    <Badge tone="up" className="gap-1.5">
      <span className="live-dot" />
      Migrated
    </Badge>
  );
}

export function MigrationRail({ pools }: { pools: Pool[] }) {
  const items = useMemo(() => uniqueMigratedTokens(pools), [pools]);
  if (!items.length) return null;

  return (
    <section className="shrink-0 overflow-hidden rounded-xl bg-surface px-4 py-4 shadow-[var(--shadow-border)] md:px-5">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium tracking-[0.16em] text-accent uppercase">Uniswap</p>
          <h2 className="font-display text-lg font-semibold tracking-tight">
            Tokens already migrated
          </h2>
          <p className="text-xs text-muted">
            Each token with a Uniswap pool, sorted by 24h APR. The best pool for each.
          </p>
        </div>
        <p className="hidden text-xs text-subtle sm:block">{items.length} tokens</p>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((pool) => (
          <MigrationCard key={pool.id} pool={pool} />
        ))}
      </div>
    </section>
  );
}

function MigrationCard({ pool }: { pool: Pool }) {
  const apr = estimatedApr(pool);
  return (
    <Link
      to="/pool/$poolId"
      params={{ poolId: pool.id }}
      className="overflow-hidden rounded-lg bg-surface-2 p-3 hover:bg-bg"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <PairAvatar
            a={pool.tokenA.symbol}
            b={pool.tokenB.symbol}
            addrA={pool.tokenA.address}
            addrB={pool.tokenB.address}
            imageA={pool.imageA}
            imageB={pool.imageB}
          />
          <div className="min-w-0">
            <p className="truncate font-medium">{speculativeSymbol(pool)}</p>
            <MigrationBadge />
          </div>
        </div>
      </div>
      <p className="mt-3 font-mono text-xl text-accent tabular">{formatApr(apr)}</p>
      <p className="mt-1 truncate text-[11px] text-subtle">{displayPair(pool)}</p>
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted">
        <MigrationAge iso={pool.createdAt} />
        <span className="font-mono tabular">TVL {formatUsdCompact(pool.tvlUsd)}</span>
      </div>
    </Link>
  );
}
