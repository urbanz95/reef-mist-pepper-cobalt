import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Crosshair, Timer, Zap } from "lucide-react";
import { PairAvatar } from "@/components/token-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  confirmDegenArm,
  getDegenVault,
  getKeeperAddress,
  setDegenActive,
  type DegenVaultDTO,
} from "@/lib/degen-api";
import { degenChainOk, deployValueWei, encodeDeployDegen, encodeExit } from "@/lib/degen-chain";
import {
  HOLD_OPTIONS,
  degenPnlUsd,
  useDegen,
  type DegenHop,
} from "@/lib/degen-store";
import {
  formatApr,
  formatDuration,
  formatEth,
  formatUsd,
  formatUsdCompact,
} from "@/lib/format";
import {
  displayPair,
  ethPriceUsd,
  findPool,
  huntApr,
  rankDegen,
  type DegenUniverse,
  type Pool,
} from "@/lib/pools";
import { usePools } from "@/lib/use-pools";
import { isRobinhoodChain, useWallet } from "@/lib/wallet-store";
import { cn } from "@/lib/cn";

const UNIVERSE: { id: DegenUniverse; label: string }[] = [
  { id: "meme", label: "Memes" },
  { id: "all", label: "All" },
  { id: "stock", label: "Stocks" },
];

const ETH_PRESETS = ["0.25", "1", "2", "5"];

function hopsFrom(row: DegenVaultDTO): DegenHop[] {
  return row.hops.map((h) => ({
    id: h.id,
    at: h.at,
    kind: h.kind === "hunt" || h.kind === "pause" ? h.kind : "enter",
    fromPoolId: null,
    toPoolId: h.toPoolId,
    fromPair: h.fromPair,
    toPair: h.toPair,
    fromApr: h.fromApr,
    toApr: h.toApr,
    eth: h.eth,
  }));
}

export function DegenView() {
  const { data } = usePools();
  const pools = data ?? [];
  const px = ethPriceUsd(pools);
  const {
    active,
    live,
    vault,
    eth,
    principalEth,
    feesUsd,
    currentPoolId,
    enteredAt,
    universe,
    holdMs,
    challengerId,
    challengerSince,
    hops,
    depositInput,
    setUniverse,
    setHoldMs,
    setDepositInput,
    arm,
    setLive,
    applyServer,
    resume,
    stop,
    tick,
    commitPlanned,
  } = useDegen();
  const enableDemo = useWallet((s) => s.enableDemo);
  const address = useWallet((s) => s.address);
  const connect = useWallet((s) => s.connect);
  const sendTx = useWallet((s) => s.sendTx);
  const waitReceipt = useWallet((s) => s.waitReceipt);
  const demo = useWallet((s) => s.demo);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const onchain = live && !!vault;

  const ranked = useMemo(() => {
    const all = rankDegen(pools, universe);
    if (onchain || address) return all.filter(degenChainOk);
    return all;
  }, [pools, universe, onchain, address]);
  const current = currentPoolId ? findPool(pools, currentPoolId) : undefined;
  const challenger = challengerId ? findPool(pools, challengerId) : undefined;
  const currentApr = current ? huntApr(current) : 0;
  const usd = eth * px;
  const pnl = degenPnlUsd(eth, principalEth, feesUsd, px);
  const paused = !active && !!current;

  useEffect(() => {
    if (!address) return;
    void getDegenVault({ data: address }).then((row) => {
      if (row) applyServer({ ...row, hops: hopsFrom(row) });
    });
  }, [address, applyServer]);

  useEffect(() => {
    if (!onchain || !address) return;
    const id = window.setInterval(() => {
      setNow(Date.now());
      void getDegenVault({ data: address }).then((row) => {
        if (!row) return;
        const prev = useDegen.getState().currentPoolId;
        applyServer({ ...row, hops: hopsFrom(row) });
        if (row.currentPoolId && row.currentPoolId !== prev) {
          toast.success("The keeper hopped pools.");
        }
      });
    }, 8_000);
    return () => window.clearInterval(id);
  }, [onchain, address, applyServer]);

  useEffect(() => {
    if (!active || onchain) return;
    const id = window.setInterval(() => {
      const ts = Date.now();
      setNow(ts);
      const hop = tick(pools, ts);
      if (hop?.kind !== "hunt") return;
      commitPlanned();
      toast.success(`Degen hopped to ${hop.toPair} · APR ${formatApr(hop.toApr)}`);
    }, 1000);
    return () => window.clearInterval(id);
  }, [active, onchain, pools, tick, commitPlanned]);

  const holdLeft =
    challenger && challengerSince ? Math.max(0, holdMs - (now - challengerSince)) : holdMs;
  const holdPct = challenger && challengerSince ? Math.min(100, ((now - challengerSince) / holdMs) * 100) : 0;

  async function onArm() {
    if (paused) {
      if (address && onchain) {
        const row = await setDegenActive({ data: { owner: address, active: true } });
        if (row) applyServer({ ...row, hops: hopsFrom(row) });
      } else {
        resume();
      }
      toast.success("Hunter resumed. The keeper hops 24/7.");
      return;
    }
    const amount = Number(depositInput.replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter an ETH amount.");
      return;
    }
    if (!ranked.length) {
      toast.error("No eligible Uniswap pool in this universe.");
      return;
    }

    if (address) {
      if (amount < 0.05) {
        toast.error("Minimum 0.05 ETH on-chain (includes keeper gas).");
        return;
      }
      if (!isRobinhoodChain(useWallet.getState().chainId)) {
        await useWallet.getState().switchChain();
      }
      setBusy(true);
      try {
        const keeper = await getKeeperAddress();
        const value = deployValueWei(amount);
        toast.message("Confirm in your wallet. One signature. Then the keeper hops on-chain.");
        const hash = await sendTx({
          data: encodeDeployDegen(keeper.address),
          value: `0x${value.toString(16)}`,
        });
        toast.message("Confirming the vault on-chain…");
        const hop = arm(amount, ranked);
        const row = await confirmDegenArm({
          data: {
            hash,
            owner: address,
            universe,
            holdMs,
            eth: amount,
          },
        });
        if (row) applyServer({ ...row, hops: hopsFrom(row) });
        toast.success(
          hop
            ? `Armed on-chain. The keeper is entering ${hop.toPair}. You can close the browser.`
            : "Armed on-chain. The keeper handles the hops.",
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Arm rejected");
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!demo) enableDemo();
    const hop = arm(amount, pools);
    if (!hop) {
      toast.error("Could not arm Degen.");
      return;
    }
    toast.success(`Demo: first stop ${hop.toPair} · APR ${formatApr(hop.toApr)}`);
  }

  function onStop() {
    if (address && onchain) {
      void setDegenActive({ data: { owner: address, active: false } }).then((row) => {
        if (row) applyServer({ ...row, hops: hopsFrom(row) });
      });
    }
    stop(pools);
    toast.message("Hunter stopped. Liquidity stays in the last pool.");
  }

  async function onExit() {
    if (!address || !vault) {
      toast.error("Connect the wallet that armed this vault.");
      return;
    }
    if (!isRobinhoodChain(useWallet.getState().chainId)) {
      await useWallet.getState().switchChain();
    }
    setBusy(true);
    try {
      toast.message("Withdrawing to your wallet. Only you sign.");
      const hash = await sendTx({ to: vault, data: encodeExit() });
      await waitReceipt(hash);
      await setDegenActive({ data: { owner: address, active: false } });
      stop(pools);
      toast.success("ETH is on the way to your wallet.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Withdraw rejected");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="overflow-hidden rounded-xl bg-surface px-5 py-6 shadow-[var(--shadow-border)] md:px-8 md:py-8">
        <p className="text-xs font-medium tracking-[0.18em] text-accent uppercase">
          Degen Mode
        </p>
        <h1 className="mt-2 max-w-xl font-display text-3xl font-semibold tracking-tight md:text-4xl">
          One wallet, one vault. The keeper hops 24/7.
        </h1>
        <p className="mt-3 max-w-lg text-sm text-muted md:text-base">
          Connect with WalletConnect. You sign the deposit once. Each wallet has its
          own vault — funds never mix. The Perch keeper chases APR even with the
          browser closed.
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,380px)]">
        <NestCard
          active={active}
          paused={paused}
          live={onchain}
          current={current}
          currentApr={currentApr}
          eth={eth}
          usd={usd}
          feesUsd={feesUsd}
          pnl={pnl}
          enteredAt={enteredAt}
          now={now}
          challenger={challenger}
          holdLeft={holdLeft}
          holdPct={holdPct}
          holdMs={holdMs}
          rankedCount={ranked.length}
          onExit={onchain ? () => void onExit() : undefined}
          exiting={busy}
        />

        <section className="rounded-xl bg-surface p-4 shadow-[var(--shadow-border)] md:p-5">
          <h2 className="text-lg font-semibold tracking-tight">Arm the hunter</h2>
          <p className="mt-1 text-sm text-muted">
            {address
              ? "One signature. The keeper — not your wallet — does the hops. You can close the browser."
              : "Use WalletConnect to go on-chain. Without a wallet, the hunter runs as a demo."}
          </p>

          <label className="mt-4 mb-1 block text-xs font-medium text-muted">Amount (ETH)</label>
          <Input
            inputMode="decimal"
            value={depositInput}
            onChange={(e) => setDepositInput(e.target.value.replace(/[^\d.,]/g, ""))}
            aria-label="Amount in ETH"
            disabled={active || paused || busy}
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {ETH_PRESETS.map((n) => (
              <button
                key={n}
                type="button"
                disabled={active || paused || busy}
                onClick={() => setDepositInput(n)}
                className={cn(
                  "h-9 rounded-sm px-3 text-xs font-medium",
                  depositInput === n ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted hover:text-fg",
                )}
              >
                {n} ETH
              </button>
            ))}
          </div>
          <p className="mt-2 font-mono text-xs text-subtle tabular">
            ≈ {formatUsd(Number(depositInput.replace(",", ".")) * px || 0)}
            {address ? " · includes keeper gas" : ""}
          </p>

          <p className="mt-5 mb-2 text-xs font-medium text-muted">Universe</p>
          <div className="grid grid-cols-3 gap-1.5">
            {UNIVERSE.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => setUniverse(u.id)}
                className={cn(
                  "h-10 rounded-sm text-xs font-medium",
                  universe === u.id ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted hover:text-fg",
                )}
              >
                {u.label}
              </button>
            ))}
          </div>

          <p className="mt-5 mb-2 text-xs font-medium text-muted">Hold before hop</p>
          <div className="grid grid-cols-4 gap-1.5">
            {HOLD_OPTIONS.map((h) => (
              <button
                key={h.ms}
                type="button"
                onClick={() => setHoldMs(h.ms)}
                className={cn(
                  "h-10 rounded-sm text-xs font-medium",
                  holdMs === h.ms ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted hover:text-fg",
                )}
              >
                {h.label}
              </button>
            ))}
          </div>

          <div className="mt-5 flex flex-col gap-2">
            {active ? (
              <Button variant="danger" onClick={onStop}>
                Stop hunter
              </Button>
            ) : (
              <Button onClick={() => void onArm()} disabled={busy}>
                <Zap className="size-4" />
                {busy
                  ? "Arming…"
                  : paused
                    ? "Resume hunter"
                    : address
                      ? "Arm on-chain"
                      : "Arm in demo"}
              </Button>
            )}
            {!address && !active ? (
              <Button variant="secondary" onClick={() => void connect()} disabled={busy}>
                WalletConnect
              </Button>
            ) : null}
          </div>
          <p className="mt-3 text-xs text-subtle">
            On-chain only Uniswap v3 ETH pairs. One wallet = one vault. Impermanent
            loss applies.
          </p>
        </section>
      </div>

      <HuntBoard
        ranked={ranked}
        currentId={currentPoolId}
        challengerId={challengerId}
      />

      <HopLog hops={hops} />
    </div>
  );
}

function NestCard({
  active,
  paused,
  live,
  current,
  currentApr,
  eth,
  usd,
  feesUsd,
  pnl,
  enteredAt,
  now,
  challenger,
  holdLeft,
  holdPct,
  holdMs,
  rankedCount,
  onExit,
  exiting,
}: {
  active: boolean;
  paused: boolean;
  live: boolean;
  current?: Pool;
  currentApr: number;
  eth: number;
  usd: number;
  feesUsd: number;
  pnl: number;
  enteredAt: number;
  now: number;
  challenger?: Pool;
  holdLeft: number;
  holdPct: number;
  holdMs: number;
  rankedCount: number;
  onExit?: () => void;
  exiting?: boolean;
}) {
  if (!current) {
    return (
      <section className="flex flex-col items-center justify-center rounded-xl bg-surface px-6 py-16 text-center shadow-[var(--shadow-border)]">
        <Crosshair className="size-8 text-subtle" />
        <h2 className="mt-4 text-lg font-semibold">No nest yet</h2>
        <p className="mt-1 max-w-sm text-sm text-muted">
          Arm Degen. It picks the highest-APR pool among {rankedCount}{" "}
          candidates and hops on its own from there.
        </p>
      </section>
    );
  }

  const inNest = now - enteredAt;
  const challApr = challenger ? huntApr(challenger) : 0;

  return (
    <section className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)] md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <PairAvatar
            a={current.tokenA.symbol}
            b={current.tokenB.symbol}
            addrA={current.tokenA.address}
            addrB={current.tokenB.address}
            imageA={current.imageA}
            imageB={current.imageB}
          />
          <div>
            <p className="text-xs tracking-wide text-subtle uppercase">Current nest</p>
            <h2 className="font-display text-2xl font-semibold tracking-tight">
              {displayPair(current)}
            </h2>
          </div>
        </div>
        {active ? (
          <Badge tone="up" className="gap-1.5">
            <span className="live-dot" />
            {live ? "On-chain" : "Demo"}
          </Badge>
        ) : (
          <Badge>Stopped in this pool</Badge>
        )}
      </div>

      <p className="mt-5 font-mono text-4xl font-medium tracking-tight text-accent tabular">
        {formatApr(currentApr)}
      </p>
      <p className="text-xs text-muted">Chase APR · 1h volume annualized</p>

      <dl className="mt-5 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
        <Stat label="ETH" value={formatEth(eth, 4)} />
        <Stat label="Value" value={formatUsd(usd)} />
        <Stat label="Fees" value={formatUsd(feesUsd)} accent />
        <Stat
          label="PnL"
          value={formatUsd(pnl)}
          tone={pnl >= 0 ? "text-up" : "text-down"}
        />
      </dl>
      <p className="mt-3 flex items-center gap-2 text-xs text-muted">
        <Timer className="size-3.5" />
        In this pool for {formatDuration(inNest)}
      </p>

      {paused ? (
        <p className="mt-5 rounded-md bg-surface-2 px-3 py-2 text-sm text-muted">
          Hunter stopped. Liquidity stays here. Resume to hop again.
        </p>
      ) : challenger ? (
        <div className="mt-5 rounded-md bg-surface-2 p-3">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="text-muted">Confirming {displayPair(challenger)}</span>
            <span className="font-mono text-accent tabular">{formatApr(challApr)}</span>
          </div>
          <div className="degen-bar mt-2">
            <span style={{ width: `${holdPct}%` }} />
          </div>
          <p className="mt-1.5 text-xs text-subtle">
            Hops in {formatDuration(holdLeft)} if it stays ahead
            {holdMs ? ` (window ${formatDuration(holdMs)})` : ""}.
          </p>
        </div>
      ) : (
        <p className="mt-5 rounded-md bg-surface-2 px-3 py-2 text-sm text-muted">
          You're #1. No challenger in sight.
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button asChild variant="secondary" size="sm">
          <Link to="/pool/$poolId" params={{ poolId: current.id }}>
            View pool
          </Link>
        </Button>
        {onExit ? (
          <Button variant="danger" size="sm" onClick={onExit} disabled={exiting}>
            {exiting ? "Withdrawing…" : "Withdraw to wallet"}
          </Button>
        ) : null}
      </div>
      {onExit ? (
        <p className="mt-2 text-xs text-subtle">Only the wallet that armed can withdraw. One signature.</p>
      ) : null}
    </section>
  );
}

function Stat({
  label,
  value,
  accent,
  tone,
}: {
  label: string;
  value: string;
  accent?: boolean;
  tone?: string;
}) {
  return (
    <div className="rounded-md bg-surface-2 px-3 py-2">
      <dt className="text-[11px] text-subtle">{label}</dt>
      <dd className={cn("font-mono tabular", accent && "text-accent", tone)}>{value}</dd>
    </div>
  );
}

function HuntBoard({
  ranked,
  currentId,
  challengerId,
}: {
  ranked: Pool[];
  currentId: string | null;
  challengerId: string | null;
}) {
  const rows = ranked.slice(0, 16);
  return (
    <section className="rounded-xl bg-surface shadow-[var(--shadow-border)]">
      <div className="flex items-end justify-between gap-3 px-5 py-4">
        <div>
          <h2 className="font-display text-lg font-semibold tracking-tight">APR hunt</h2>
          <p className="text-xs text-muted">
            Live ranking. Degen only hops if #1 holds for the full window.
          </p>
        </div>
        <p className="text-xs text-subtle">{ranked.length} pools</p>
      </div>

      <div className="hidden md:block">
        <div className="grid grid-cols-[2.2rem_1.6fr_0.8fr_0.8fr_0.7fr] gap-2 px-5 pb-2 text-[11px] tracking-wide text-subtle uppercase">
          <span>#</span>
          <span>Pool</span>
          <span className="text-right">APR chase</span>
          <span className="text-right">TVL</span>
          <span className="text-right">Vol 24h</span>
        </div>
        <ul>
          {rows.map((p, i) => {
            const mine = p.id === currentId;
            const chall = p.id === challengerId;
            return (
              <li key={p.id} className="border-t border-border">
                <Link
                  to="/pool/$poolId"
                  params={{ poolId: p.id }}
                  className={cn(
                    "grid grid-cols-[2.2rem_1.6fr_0.8fr_0.8fr_0.7fr] items-center gap-2 px-5 py-3 hover:bg-surface-2",
                    mine && "bg-accent/10",
                    chall && !mine && "bg-surface-2",
                  )}
                >
                  <span className="font-mono text-xs text-subtle tabular">{i + 1}</span>
                  <span className="flex min-w-0 items-center gap-3">
                    <PairAvatar
                      a={p.tokenA.symbol}
                      b={p.tokenB.symbol}
                      addrA={p.tokenA.address}
                      addrB={p.tokenB.address}
                      imageA={p.imageA}
                      imageB={p.imageB}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{displayPair(p)}</span>
                      <span className="block text-xs text-subtle">
                        {p.version} · {p.feePct}%
                        {mine ? " · nest" : chall ? " · confirming" : ""}
                      </span>
                    </span>
                  </span>
                  <span className="text-right font-mono text-sm text-accent tabular">
                    {formatApr(huntApr(p))}
                  </span>
                  <span className="text-right font-mono text-sm tabular">
                    {formatUsdCompact(p.tvlUsd)}
                  </span>
                  <span className="text-right font-mono text-sm tabular">
                    {formatUsdCompact(p.volume24h)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>

      <ul className="flex flex-col gap-0 md:hidden">
        {rows.map((p, i) => {
          const mine = p.id === currentId;
          return (
            <li key={p.id} className="border-t border-border">
              <Link
                to="/pool/$poolId"
                params={{ poolId: p.id }}
                className={cn("flex items-center justify-between gap-3 px-4 py-3", mine && "bg-accent/10")}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="w-5 font-mono text-xs text-subtle tabular">{i + 1}</span>
                  <PairAvatar
                    a={p.tokenA.symbol}
                    b={p.tokenB.symbol}
                    addrA={p.tokenA.address}
                    addrB={p.tokenB.address}
                    imageA={p.imageA}
                    imageB={p.imageB}
                  />
                  <span className="truncate font-medium">{displayPair(p)}</span>
                </span>
                <span className="font-mono text-sm text-accent tabular">{formatApr(huntApr(p))}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      {rows.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-muted">
          No Uniswap pool matches this universe.
        </p>
      ) : null}
    </section>
  );
}

function HopLog({ hops }: { hops: DegenHop[] }) {
  if (!hops.length) return null;
  return (
    <section className="rounded-xl bg-surface px-5 py-4 shadow-[var(--shadow-border)]">
      <h2 className="font-display text-lg font-semibold tracking-tight">Hop log</h2>
      <ol className="mt-3 flex flex-col">
        {hops.map((h) => (
          <li
            key={h.id}
            className="flex flex-wrap items-baseline justify-between gap-2 border-t border-border py-3 text-sm"
          >
            <span>
              <span className="text-muted">
                {h.kind === "enter" ? "Entered" : h.kind === "hunt" ? "Hopped to" : "Stopped in"}{" "}
              </span>
              <span className="font-medium">{h.toPair}</span>
              {h.kind === "hunt" && h.fromPair ? (
                <span className="text-subtle"> ← {h.fromPair}</span>
              ) : null}
            </span>
            <span className="font-mono text-xs text-muted tabular">
              {h.kind === "hunt" ? (
                <>
                  {formatApr(h.fromApr)} → {formatApr(h.toApr)}
                </>
              ) : (
                formatApr(h.toApr)
              )}
              {" · "}
              {formatEth(h.eth, 4)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
