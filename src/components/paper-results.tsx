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
            minute; publication can be delayed. Each run starts with a fresh virtual balance.
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
            Position: {pool(book.state.current)} ·{" "}
            {book.state.halted ? "Risk stop latched" : "No active risk stop"}
          </p>
          <p className="mt-2 text-xs text-muted">
            {report.samples} observations · {report.verifiedQuotes} buy/sell probes (not trades) ·{" "}
            {report.errors} data errors · {operations.length} simulated operations for this balance
          </p>
          <h3 className="mt-6 font-semibold">Simulated operations</h3>
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
          <p className="mt-4 text-xs text-muted">
            PnL includes modeled fees and charged costs, using an approximate LP valuation. It
            excludes uncharged future exit costs and is not a guaranteed cash-out value. Unknown
            valuations stay unknown. USDG/WETH is a paper-only selection; these results do not
            establish profitability or token safety.
          </p>
        </>
      )}
    </section>
  );
}
