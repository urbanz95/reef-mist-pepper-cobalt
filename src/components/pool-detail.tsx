import { Link } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { AddLiquidityPanel } from "@/components/add-liquidity-panel";
import { MigrationAge, MigrationBadge } from "@/components/migration-rail";
import { PairAvatar } from "@/components/token-avatar";
import { Badge } from "@/components/ui/badge";
import { uniswapPoolUrl } from "@/lib/chain";
import { formatApr, formatNum, formatPct, formatUsd, formatUsdCompact } from "@/lib/format";
import {
  dailyFees,
  dexLabel,
  displayPair,
  estimatedApr,
  isMigratedMeme,
  kindLabel,
  type Pool,
} from "@/lib/pools";
import { cn } from "@/lib/cn";

export function PoolDetail({ pool }: { pool: Pool }) {
  const apr = estimatedApr(pool);
  const pair = displayPair(pool);
  const changeTone = pool.change24h >= 0 ? "text-up" : "text-down";
  const migrated = isMigratedMeme(pool);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          to="/"
          className="mb-2 inline-flex h-11 items-center gap-2 text-sm text-muted hover:text-fg"
        >
          <ArrowLeft className="size-4" />
          Voltar
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <PairAvatar
              a={pool.tokenA.symbol}
              b={pool.tokenB.symbol}
              addrA={pool.tokenA.address}
              addrB={pool.tokenB.address}
              imageA={pool.imageA}
              imageB={pool.imageB}
            />
            <div>
              <h1 className="font-display text-2xl font-semibold tracking-tight">{pair}</h1>
              <p className="text-sm text-muted">
                {pool.tokenA.name} · {pool.tokenB.name}
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="font-mono text-2xl tabular">{formatUsd(pool.priceUsd, pool.priceUsd < 2 ? 4 : 2)}</p>
            <p className={cn("font-mono text-sm tabular", changeTone)}>{formatPct(pool.change24h)}</p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge>{pool.version}</Badge>
          <Badge>{pool.feePct}% fee</Badge>
          <Badge tone={pool.kind === "meme" ? "up" : pool.kind === "stock" ? "accent" : "neutral"}>
            {kindLabel(pool.kind)}
          </Badge>
          <Badge>{dexLabel(pool.dex)}</Badge>
          {migrated ? <MigrationBadge /> : null}
          {pool.createdAt ? (
            <Badge>
              <MigrationAge iso={pool.createdAt} />
            </Badge>
          ) : null}
        </div>
      </div>

      {migrated ? (
        <p className="rounded-lg bg-surface px-4 py-3 text-sm text-muted shadow-[var(--shadow-border)]">
          Already migrated to Uniswap. Concentrated liquidity — depositors earn fees
          while the price stays inside the range.
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Metric label="TVL" value={formatUsdCompact(pool.tvlUsd)} />
        <Metric label="Volume 24h" value={formatUsdCompact(pool.volume24h)} />
        <Metric label="Fees 24h" value={formatUsdCompact(dailyFees(pool))} />
        <Metric label="Est. APR" value={formatApr(apr)} accent />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_minmax(280px,400px)]">
        <section className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
          <h2 className="text-lg font-semibold tracking-tight">About this pool</h2>
          <p className="mt-2 text-sm text-muted">
            Uniswap {pool.version} liquidity on Robinhood Chain. Depositors earn a
            share of the {pool.feePct}% fee on each swap while the {pool.tokenA.symbol}{" "}
            price stays inside the chosen range.
          </p>
          <dl className="mt-5 grid gap-3 text-sm">
            <Row label={`${pool.tokenA.symbol} price`} value={formatUsd(pool.priceUsd, 4)} />
            <Row
              label="Quote price"
              value={`${formatNum(pool.priceUsd / (pool.quotePriceUsd || 1), 4)} ${pool.tokenB.symbol}`}
            />
            <Row label="Transactions 24h" value={formatNum(pool.txns24h, 0)} />
            {pool.fdvUsd ? <Row label="FDV" value={formatUsdCompact(pool.fdvUsd)} /> : null}
          </dl>
          <a
            href={uniswapPoolUrl(pool.id)}
            target="_blank"
            rel="noreferrer"
            className="mt-5 inline-flex h-11 items-center gap-2 text-sm text-muted hover:text-fg"
          >
            View pool on Uniswap
            <ExternalLink className="size-3.5" />
          </a>
        </section>
        <AddLiquidityPanel pool={pool} />
      </div>
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-lg bg-surface px-4 py-3 shadow-[var(--shadow-border)]">
      <p className="text-[11px] tracking-wide text-subtle uppercase">{label}</p>
      <p className={cn("mt-1 font-mono text-lg tabular", accent && "text-accent")}>{value}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-0">
      <dt className="text-muted">{label}</dt>
      <dd className="font-mono text-sm tabular">{value}</dd>
    </div>
  );
}
