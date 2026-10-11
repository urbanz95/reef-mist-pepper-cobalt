import { useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RangeVisual } from "@/components/range-visual";
import { TokenAvatar } from "@/components/token-avatar";
import { CONTRACTS, uniswapAddLiquidityUrl } from "@/lib/chain";
import { formatApr, formatNum, formatPct, formatUsd } from "@/lib/format";
import { canMintOnchain, dailyFees, estimatedApr, type Pool } from "@/lib/pools";
import { buildPosition, usePositions } from "@/lib/position-store";
import {
  encodeApprove,
  encodeMint,
  rangeFromPreset,
  splitDeposit,
  type RangePreset,
} from "@/lib/uniswap-lp";
import { useWallet } from "@/lib/wallet-store";

const PRESETS: { id: RangePreset; label: string }[] = [
  { id: 2, label: "±2%" },
  { id: 5, label: "±5%" },
  { id: 10, label: "±10%" },
  { id: 25, label: "±25%" },
  { id: 50, label: "±50%" },
  { id: "full", label: "Full" },
];

export function AddLiquidityPanel({ pool }: { pool: Pool }) {
  const [usd, setUsd] = useState("1000");
  const [preset, setPreset] = useState<RangePreset>(10);
  const [busy, setBusy] = useState(false);
  const add = usePositions((s) => s.add);
  const mark = usePositions((s) => s.markOnchain);
  const { address, demo, sendTx, connect, enableDemo } = useWallet();

  const usdNum = Number(usd) || 0;
  const range = useMemo(
    () => rangeFromPreset(pool.priceUsd || 1, preset, pool.feePct),
    [pool.priceUsd, pool.feePct, preset],
  );
  const split = useMemo(
    () => splitDeposit(usdNum, pool.priceUsd || 1, range.pMin, range.pMax),
    [usdNum, pool.priceUsd, range.pMin, range.pMax],
  );
  const apr = estimatedApr(pool);
  const share = pool.tvlUsd > 0 ? usdNum / (pool.tvlUsd + usdNum) : 0;
  const estDaily = dailyFees(pool) * share;

  function openPosition(status: "demo" | "pending", txHash?: string) {
    const pos = buildPosition(pool, {
      amountA: split.amountA,
      amountB: split.amountB,
      usd: usdNum,
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      pMin: range.pMin,
      pMax: range.pMax,
      status,
      txHash,
    });
    add(pos);
    return pos;
  }

  async function onDemo() {
    if (usdNum <= 0) {
      toast.error("Enter an amount.");
      return;
    }
    if (!demo && !address) enableDemo();
    openPosition("demo");
    toast.success(`Demo position opened in ${pool.tokenA.symbol}/${pool.tokenB.symbol}`);
  }

  async function onChainMint() {
    if (!address) {
      await connect();
      return;
    }
    if (usdNum <= 0) {
      toast.error("Enter an amount.");
      return;
    }
    if (!canMintOnchain(pool)) {
      toast.message("This pool opens on Uniswap for the deposit.");
      window.open(
        uniswapAddLiquidityUrl({
          tokenA: pool.tokenA.address,
          tokenB: pool.tokenB.address,
          fee: pool.feePct,
        }),
        "_blank",
        "noopener,noreferrer",
      );
      return;
    }
    setBusy(true);
    try {
      const minted = encodeMint({
        pool,
        tickLower: range.tickLower,
        tickUpper: range.tickUpper,
        amountA: split.amountA,
        amountB: split.amountB,
        recipient: address,
      });
      const pos = openPosition("pending");
      toast.message("Requesting approvals…");
      await sendTx({
        to: minted.token0.address,
        data: encodeApprove(CONTRACTS.npm, minted.amount0),
      });
      await sendTx({
        to: minted.token1.address,
        data: encodeApprove(CONTRACTS.npm, minted.amount1),
      });
      toast.message("Minting the Uniswap v3 position…");
      const hash = await sendTx({ to: minted.to, data: minted.data });
      mark(pos.id, hash);
      toast.success("Liquidity submitted.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Transaction rejected";
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl bg-surface p-4 shadow-[var(--shadow-border)] md:p-5">
      <div className="mb-4">
        <h2 className="text-lg font-semibold tracking-tight">Add liquidity</h2>
        <p className="text-sm text-muted">
          Uniswap {pool.version} · {pool.feePct}% fee · est. APR {formatApr(apr)}
        </p>
      </div>

      <label className="mb-1 block text-xs font-medium text-muted">Amount (USD)</label>
      <Input
        inputMode="decimal"
        value={usd}
        onChange={(e) => setUsd(e.target.value.replace(/[^\d.,]/g, "").replace(",", "."))}
        aria-label="Amount in dollars"
      />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {[250, 1000, 5000, 25000].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setUsd(String(n))}
            className="h-9 rounded-sm bg-surface-2 px-3 text-xs font-medium text-muted hover:text-fg"
          >
            {n >= 1000 ? `${n / 1000}k` : n}
          </button>
        ))}
      </div>

      <p className="mt-5 mb-2 text-xs font-medium text-muted">Price range</p>
      <div className="mb-4 grid grid-cols-3 gap-1.5 sm:grid-cols-6">
        {PRESETS.map((p) => (
          <button
            key={String(p.id)}
            type="button"
            onClick={() => setPreset(p.id)}
            className={`h-10 rounded-sm text-xs font-medium ${
              preset === p.id ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted hover:text-fg"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <RangeVisual
        pool={pool}
        pMin={range.pMin}
        pMax={range.pMax}
        full={preset === "full"}
      />

      <div className="mt-4 grid grid-cols-2 gap-2">
        <AmountCard
          symbol={pool.tokenA.symbol}
          address={pool.tokenA.address}
          image={pool.imageA}
          amount={split.amountA}
          usd={split.usdA}
        />
        <AmountCard
          symbol={pool.tokenB.symbol}
          address={pool.tokenB.address}
          image={pool.imageB}
          amount={split.amountB}
          usd={split.usdB}
        />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
        <div className="rounded-md bg-surface-2 px-3 py-2">
          <dt className="text-xs text-muted">Est. fees / day</dt>
          <dd className="font-mono tabular">{formatUsd(estDaily)}</dd>
        </div>
        <div className="rounded-md bg-surface-2 px-3 py-2">
          <dt className="text-xs text-muted">Pool share</dt>
          <dd className="font-mono tabular">{formatPct(share * 100, 3)}</dd>
        </div>
      </dl>

      <p className="mt-3 text-xs text-subtle">
        Outside the range the position stops earning fees (impermanent loss still applies).
        Uniswap protocol fees can reduce the effective APR.
      </p>

      <div className="mt-4 flex flex-col gap-2">
        <Button onClick={() => void onChainMint()} disabled={busy}>
          {busy ? "Confirming…" : address ? "Deposit on-chain" : "Connect and deposit"}
        </Button>
        <Button variant="secondary" onClick={() => void onDemo()} disabled={busy}>
          Simulate deposit (demo)
        </Button>
        <a
          href={uniswapAddLiquidityUrl({
            tokenA: pool.tokenA.address,
            tokenB: pool.tokenB.address,
            fee: pool.feePct,
          })}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-11 items-center justify-center gap-2 rounded-md text-sm text-muted hover:text-fg"
        >
          Open on Uniswap
          <ExternalLink className="size-3.5" />
        </a>
      </div>
    </section>
  );
}

function AmountCard({
  symbol,
  address,
  image,
  amount,
  usd,
}: {
  symbol: string;
  address: string;
  image?: string | null;
  amount: number;
  usd: number;
}) {
  return (
    <div className="rounded-md bg-surface-2 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted">
        <TokenAvatar symbol={symbol} address={address} image={image} size="sm" />
        {symbol}
      </div>
      <p className="font-mono text-lg tabular leading-tight">{formatNum(amount, 6)}</p>
      <p className="text-xs text-subtle tabular">{formatUsd(usd)}</p>
    </div>
  );
}
