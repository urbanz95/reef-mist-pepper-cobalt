import { useEffect, useState } from "react";
import {
  PAPER_REPORT_URL,
  newerPaperReport,
  paperReportSchema,
  paperReportStale,
  type PaperReport,
} from "@/lib/paper-report";
import { Button } from "./ui/button";

const eth = (n: number | null) => (n === null ? "Unknown" : `${n.toFixed(8)} ETH`);
const time = (s: string) => new Date(s).toLocaleString();
const pool = (s?: string | null) => (s ? `${s.slice(0, 8)}…${s.slice(-4)}` : "ETH");
export function PaperResults() {
  const [report, setReport] = useState<PaperReport | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setNow(Date.now());
      try {
        const response = await fetch(
          `${PAPER_REPORT_URL}?minute=${Math.floor(Date.now() / 60000)}`,
          { signal: controller.signal },
        );
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? "The first cloud report has not been published yet."
              : "Cloud report unavailable. Showing the last received snapshot, if any.",
          );
        const parsed = paperReportSchema.parse(await response.json());
        if (!controller.signal.aborted) {
          setReport((current) => newerPaperReport(current, parsed));
          setError("");
        }
      } catch (e) {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error && !e.message.startsWith("[")
              ? e.message
              : "Cloud report could not be validated.",
          );
      }
    }
    void load();
    const timer = setInterval(() => void load(), 60000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refresh]);
  const book = report?.books[Math.min(selected, report.books.length - 1)];
  const operations = report?.operations.filter((d) => d.capital === book?.initial) ?? [];
  const decisions = report?.decisions.filter((d) => d.capital === book?.initial) ?? [];
  const stale = report ? paperReportStale(report, now) : false;
  const trades = report?.trades?.filter((t) => t.capital === book?.initial) ?? [];
  const closedPnl = trades.filter((t) => t.exitAt).reduce((n, t) => n + (t.pnlEth ?? 0), 0);
  const openTrades = trades.filter((t) => !t.exitAt);
  const openPnl = openTrades.some((t) => t.pnlEth === null)
    ? null
    : openTrades.reduce((n, t) => n + t.pnlEth!, 0);
  const duration = (seconds: number) =>
    `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${Math.floor(seconds % 60)}s`;
  function downloadTrades() {
    const headers = [
      "pool",
      "address",
      "capitalETH",
      "entryUTC",
      "exitUTC",
      "durationSeconds",
      "entryValueETH",
      "exitOrMarkedValueETH",
      "feesETH",
      "costsETH",
      "positionPnlETH",
      "exitReason",
      "quantityRaw",
    ];
    const rows = trades.map((t) => [
      t.label,
      t.pool,
      t.capital,
      t.entryAt,
      t.exitAt ?? "OPEN",
      t.durationSec,
      t.entryValueEth,
      t.valueEth,
      t.feesEth,
      t.costsEth,
      t.pnlEth,
      t.exitReason ?? "Open",
      t.quantityRaw ?? "",
    ]);
    const cell = (value: unknown) =>
      '"' +
      String(
        typeof value === "string" && /^[=+\-@\t\r]/.test(value) ? "'" + value : (value ?? ""),
      ).replaceAll('"', '""') +
      '"';
    const blob = new Blob([[headers, ...rows].map((row) => row.map(cell).join(",")).join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob),
      anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `paper-${report?.runId}-${book?.initial}-positions.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section
      aria-label="Live market test results"
      className="min-w-0 rounded-xl bg-surface p-5 shadow-[var(--shadow-border)] md:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-accent">
            Live market · virtual capital
          </p>
          <h2 className="mt-2 text-2xl font-semibold">Cloud test results</h2>
        </div>
        <Button variant="secondary" onClick={() => setRefresh((n) => n + 1)}>
          Refresh results
        </Button>
      </div>
      <p className="mt-2 text-sm text-muted">
        Real pool observations; simulated operations and estimated PnL. No funds spent. This test
        continues with your computer off.
      </p>
      {error && (
        <p role="status" className="mt-4 rounded-md bg-surface-2 p-3 text-sm">
          {error}
        </p>
      )}
      {!report && !error && (
        <p role="status" className="mt-4 text-sm text-muted">
          Loading cloud results…
        </p>
      )}
      {report && book && (
        <>
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted">
            <span>
              Status:{" "}
              {stale
                ? "Updates delayed — run may have stopped"
                : report.status === "segment_complete"
                  ? "Overnight test continuing — preparing second half"
                  : report.status.replaceAll("_", " ")}
            </span>
            <span>Snapshot: {time(report.updatedAt)}</span>
            <a
              className="text-accent underline"
              href={`https://github.com/urbanz95/reef-mist-pepper-cobalt/actions/runs/${report.runId}`}
              target="_blank"
              rel="noreferrer"
            >
              Open this run
            </a>
          </div>
          <p className="mt-2 text-xs text-muted">
            Started {time(report.startedAt)}
            {report.finishedAt ? ` · Finished ${time(report.finishedAt)}` : ""}. Refreshes every
            minute; publication can be delayed. Overnight segments preserve the same balances and
            positions.
          </p>
          <div className="my-5 flex flex-wrap gap-2" aria-label="Virtual balances">
            {report.books.map((b, i) => (
              <Button
                key={b.initial}
                variant={b === book ? "primary" : "secondary"}
                aria-pressed={b === book}
                onClick={() => setSelected(i)}
              >
                {b.initial} ETH test
              </Button>
            ))}
          </div>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Estimated balance", eth(book.value)],
              [
                "Estimated PnL vs holding ETH",
                eth(book.value === null ? null : book.value - book.initial),
              ],
              ["Modeled fees", eth(book.fees)],
              ["Charged virtual costs", eth(book.costs)],
            ].map(([label, value]) => (
              <div key={label} className="min-w-0 rounded-lg bg-surface-2 p-4">
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="mt-2 break-words font-mono text-sm">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 break-all text-sm">
            Strategy: {book.strategy ?? "baseline"} ·{" "}
            {book.strategy === "guarded"
              ? `Open positions: ${book.positions?.length ?? 0} / 2`
              : `Position: ${pool(book.state.current)}`}{" "}
            · {book.state.halted ? "Risk stop latched" : "No active risk stop"}
          </p>
          {book.strategy === "guarded" && (
            <div className="mt-3 rounded-lg bg-surface-2 p-4 text-sm">
              <p>
                Unallocated ETH: <strong>{eth(book.cash ?? null)}</strong> · Maximum 2% per
                position, 4% combined at entry.
              </p>
              <p className="mt-2 text-xs text-muted">
                Liquidity and token security proof required. Unknown checks block entries. V3/V4
                withdrawal permissions and unsupported lockers are currently unverified and remain
                observation-only.
              </p>
              {report.monitor && (
                <p className="mt-2 text-xs">
                  Block monitor:{" "}
                  {report.monitor.healthy && !stale ? "Connected" : "Unavailable / stale"} · Last
                  scanned block: {report.monitor.lastBlock ?? "Unknown"} ·{" "}
                  {report.securityChecks ?? 0} security checks
                </p>
              )}
              {report.securityProviderError && (
                <p className="mt-2 text-xs">
                  Security provider: {report.securityProviderError}. Missing or expired checks block
                  new entries.
                </p>
              )}
              {book.positions?.map((p) => (
                <div key={p.id} className="mt-3 border-t border-white/10 pt-3">
                  <p className="break-words">
                    {p.label} · Allocated {eth(p.allocationEth)} · Net sale estimate{" "}
                    {eth(p.markedValueEth)}
                  </p>
                  <p className="mt-1 break-all font-mono text-xs">
                    Held quantity (raw units): {p.quantityRaw}
                  </p>
                  {p.exitRequested && (
                    <p className="mt-1 text-xs">
                      Exit requested: {p.exitRequested}. A successful exact-quantity sale is
                      required to close.
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-xs text-muted">
            {report.samples} observations · {report.verifiedQuotes} buy/sell probes (not trades) ·{" "}
            {report.errors} data errors · {operations.length} simulated operations for this balance
          </p>
          <h3 className="mt-6 font-semibold">Simulated operations</h3>
          {report.trades && (
            <>
              <div className="my-3 flex flex-wrap items-center justify-between gap-3 text-sm">
                <p>
                  Closed-position PnL: <strong>{eth(closedPnl)}</strong> · Open-position PnL:{" "}
                  <strong>{eth(openPnl)}</strong>
                </p>
                <Button variant="secondary" onClick={downloadTrades}>
                  Download positions CSV
                </Button>
              </div>
              {trades.length > 0 && (
                <div className="overflow-x-auto rounded-lg bg-surface-2">
                  <table className="w-full text-left text-xs">
                    <caption className="p-3 text-left text-muted">
                      Per-position ledger · estimated net ETH values. Guarded marks include
                      estimated exit gas. Times use your local timezone.
                    </caption>
                    <thead>
                      <tr>
                        {[
                          "Pool / location",
                          "Entry → exit",
                          "Time held",
                          "Entry → exit/mark ETH",
                          "Fees / costs ETH",
                          "Position PnL ETH",
                          "Exit reason",
                        ].map((h) => (
                          <th key={h} className="p-3 whitespace-nowrap">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {trades.map((t) => (
                        <tr key={t.id} className="border-t border-white/10">
                          <td className="p-3">
                            <a
                              href={
                                /^0x[0-9a-f]{40}$/i.test(t.pool)
                                  ? `https://robinhoodchain.blockscout.com/address/${t.pool}`
                                  : `https://www.geckoterminal.com/robinhood/pools/${t.pool}`
                              }
                              target="_blank"
                              rel="noreferrer"
                              className="text-accent underline"
                            >
                              {t.label}
                            </a>
                            <p className="mt-1 font-mono">{pool(t.pool)}</p>
                          </td>
                          <td className="p-3 whitespace-nowrap">
                            {time(t.entryAt)}
                            <br />
                            {t.exitAt ? time(t.exitAt) : "OPEN"}
                          </td>
                          <td className="p-3 whitespace-nowrap">{duration(t.durationSec)}</td>
                          <td className="p-3 whitespace-nowrap">
                            {t.entryValueEth.toFixed(8)} →{" "}
                            {t.valueEth === null ? "Unknown" : t.valueEth.toFixed(8)}
                          </td>
                          <td className="p-3 whitespace-nowrap">
                            {t.feesEth.toFixed(8)} / {t.costsEth.toFixed(8)}
                          </td>
                          <td className="p-3 whitespace-nowrap font-mono">
                            {t.pnlEth === null ? "Unknown" : t.pnlEth.toFixed(8)}
                          </td>
                          <td className="p-3 min-w-44">
                            {t.exitReason ?? "Position remains open"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          {operations.length === 0 ? (
            <div className="mt-2 rounded-lg bg-surface-2 p-4 text-sm">
              <p>No entries or exits in this run for this balance.</p>
              <p className="mt-1 text-muted">
                {decisions.at(-1)?.reason ?? "Waiting for the first observation."}
              </p>
              <p className="mt-2 text-xs text-muted">
                No trades means the exit logic has not been exercised by this market run.
              </p>
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              {operations
                .slice()
                .reverse()
                .map((d, i) => (
                  <article key={i} className="rounded-lg bg-surface-2 p-4 text-sm">
                    <div className="flex flex-wrap justify-between gap-2">
                      <strong className="uppercase">{d.action}</strong>
                      <time>{time(d.at)}</time>
                    </div>
                    <p className="mt-2 break-all">
                      {pool(d.from)} → {pool(d.target)}
                    </p>
                    <p className="mt-1 text-muted">{d.reason}</p>
                    <p className="mt-2">
                      Balance: {eth(d.valueEth)} · Cost: {eth(d.chargedEth ?? 0)} · PnL:{" "}
                      {eth(d.valueEth === null ? null : d.valueEth - d.capital)}
                    </p>
                  </article>
                ))}
            </div>
          )}
          <details className="mt-5 rounded-lg bg-surface-2 p-4">
            <summary className="cursor-pointer text-sm font-medium">
              Recent decisions ({decisions.length})
            </summary>
            <ol className="mt-3 space-y-3">
              {decisions
                .slice()
                .reverse()
                .map((d, i) => (
                  <li key={i} className="border-t border-white/10 pt-3 text-xs">
                    <p>
                      {time(d.at)} · <strong>{d.action}</strong> · PnL{" "}
                      {eth(d.valueEth === null ? null : d.valueEth - d.capital)}
                    </p>
                    <p className="mt-1 text-muted">{d.reason}</p>
                  </li>
                ))}
            </ol>
          </details>
          <details className="mt-3 rounded-lg bg-surface-2 p-4">
            <summary className="cursor-pointer text-sm font-medium">
              Decision counts across all balances
            </summary>
            <ul className="mt-3 space-y-2 text-xs">
              {Object.entries(report.reasons).map(([reason, count]) => (
                <li key={reason}>
                  {count} × {reason}
                </li>
              ))}
            </ul>
          </details>
          {report.poolCoverage && (
            <details className="mt-3 rounded-lg bg-surface-2 p-4">
              <summary className="cursor-pointer text-sm font-medium">
                Other pools screened ({report.poolCoverage.length})
              </summary>
              <p className="mt-3 text-xs text-muted">
                Up to six entry candidates are checked per sample, with two fee tiers per token.
                Held positions are also monitored. Eligibility is experimental, not a security
                approval.
              </p>
              <ul className="mt-3 space-y-3">
                {report.poolCoverage.map((p) => (
                  <li key={p.id} className="border-t border-white/10 pt-3 text-xs">
                    {/^0x[0-9a-f]{40}$/i.test(p.id) ? (
                      <a
                        className="text-accent underline"
                        href={`https://robinhoodchain.blockscout.com/address/${p.id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {p.label}
                      </a>
                    ) : (
                      <span>{p.label}</span>
                    )}
                    {p.dex && <p className="mt-1 text-muted">{p.dex}</p>}
                    {p.securityStatus && (
                      <p className="mt-1">
                        Security: {p.securityStatus}
                        {p.burnedLpFraction !== undefined
                          ? ` · Provably burned LP: ${(p.burnedLpFraction * 100).toFixed(2)}%`
                          : ""}
                      </p>
                    )}
                    {p.securityReasons?.length ? (
                      <ul className="mt-1 list-inside list-disc text-muted">
                        {p.securityReasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    ) : null}
                    {p.migrationStatus && (
                      <p className="mt-1 text-muted">
                        Migration unconfirmed · {p.creationEvidence?.replaceAll("_", " ")}
                      </p>
                    )}
                    {p.creationTransaction && (
                      <a
                        className="text-accent underline"
                        href={`https://robinhoodchain.blockscout.com/tx/${p.creationTransaction}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Pool creation evidence
                      </a>
                    )}
                    <p className="mt-1">
                      {p.probes} successful probes · {p.failures} failed · $
                      {p.tvlUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })} TVL
                    </p>
                    <p className="mt-1 text-muted">{p.lastReason}</p>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className="mt-4 text-xs text-muted">
            {book.strategy === "guarded"
              ? "Guarded spot PnL uses a sale-only simulation of the held token quantity, including pool fees/impact and estimated exit gas. Unknown or failed sales remain open with unknown value. Stops cannot guarantee a fill. "
              : book.strategy === "launch"
                ? "Launch uses an approximate spot valuation, charges execution costs and earns no LP fees. "
                : "PnL includes modeled fees and charged costs, using an approximate LP valuation. "}
            {book.strategy !== "guarded" && "It excludes uncharged future exit costs. "}This is not
            a guaranteed cash-out value. Unknown valuations stay unknown. All selected pools are
            paper-only experiments; these results do not establish profitability or token safety.
          </p>
        </>
      )}
    </section>
  );
}
