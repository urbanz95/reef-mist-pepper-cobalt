const eth = (n) => (n === null ? "unknown" : n.toFixed(8));
const safe = (s) => String(s).replaceAll("|", "/").replaceAll("\n", " ");
export function completeReport(run) {
  const trades = run.books.flatMap((b) => b.ledger ?? []);
  const books = run.books.map((b) => {
    const closed = (b.ledger ?? []).filter((t) => t.exitAt);
    const open = (b.ledger ?? []).filter((t) => !t.exitAt);
    return {
      ...b,
      realizedPnlEth: closed.reduce((n, t) => n + t.pnlEth, 0),
      openPnlEth: open.some((t) => t.pnlEth === null)
        ? null
        : open.reduce((n, t) => n + t.pnlEth, 0),
      totalPnlEth: b.value === null ? null : b.value - b.initial,
    };
  });
  return {
    ...run,
    books,
    trades,
    updatedAt: new Date().toISOString(),
    netVsHoldingEth: books.map((b) => b.totalPnlEth),
  };
}
export function reportMarkdown(r) {
  return `# Overnight live-market paper report\n\n**Virtual money only; LP fees/values or launch spot values and execution costs are modeled.**\n\nRun ${r.runId} · ${r.status} · segment ${r.segment}/${r.segments}. Started ${r.startedAt}; last update ${r.updatedAt}.\n\n${r.samples} samples; ${r.verifiedQuotes} verified quotes; ${r.errors} data errors. See samples.ndjson for raw evidence and errors.\n\n## Per-balance result (ETH)\n\n| Initial | Value | Closed PnL | Open PnL | Total PnL | Modeled fees | Costs |\n|---|---|---|---|---|---|---|\n${r.books.map((b) => `| ${b.initial} | ${eth(b.value)} | ${eth(b.realizedPnlEth)} | ${eth(b.openPnlEth)} | ${eth(b.totalPnlEth)} | ${eth(b.fees)} | ${eth(b.costs)} |`).join("\n")}\n\n## Positions (ETH)\n\nTimes are UTC; open positions have no completed exit. Closed PnL is simulated, not on-chain realized money.\n\n| Balance | Pool | Address | Entry UTC | Exit UTC | Minutes held | Entry value | Current/exit value | Fees | Costs | Position PnL | Exit reason |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n${r.trades.map((t) => `| ${t.capital} | ${safe(t.label)} | ${t.pool} | ${t.entryAt} | ${t.exitAt ?? "OPEN"} | ${(t.durationSec / 60).toFixed(2)} | ${eth(t.entryValueEth)} | ${eth(t.valueEth)} | ${eth(t.feesEth)} | ${eth(t.costsEth)} | ${eth(t.pnlEth)} | ${safe(t.exitReason ?? "Still open")} |`).join("\n") || "| No positions opened yet |"}\n\n## Pool coverage\n\n| Pool | Address | TVL USD | Observations | Successful probes | Failed probes | Latest screening result |\n|---|---|---|---|---|---|---|\n${r.poolCoverage.map((p) => `| ${safe(p.label)} | ${p.id} | ${p.tvlUsd.toFixed(2)} | ${p.observations} | ${p.probes} | ${p.failures} | ${safe(p.lastReason)} |`).join("\n")}\n\n## Decision counts\n\n${Object.entries(
    r.reasons,
  )
    .map(([k, v]) => `- ${v} × ${k}`)
    .join("\n")}\n\n## Assumptions\n\n${r.assumptions.map((s) => "- " + s).join("\n")}\n`;
}
function csv(rows) {
  if (!rows.length) return "";
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const cell = (v) =>
    '"' +
    String(typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? "'" + v : (v ?? "")).replaceAll(
      '"',
      '""',
    ) +
    '"';
  return (
    [keys, ...rows.map((r) => keys.map((k) => r[k]))].map((r) => r.map(cell).join(",")).join("\n") +
    "\n"
  );
}
export function reportFiles(r) {
  const md = reportMarkdown(r);
  const escape = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  let table = false;
  const html =
    md
      .split("\n")
      .map((line) => {
        if (line.startsWith("|")) {
          if (/^\|[-|]+$/.test(line)) return "";
          const start = table ? "" : '<div class="scroll"><table>';
          table = true;
          return (
            start +
            "<tr>" +
            line
              .split("|")
              .slice(1, -1)
              .map((c) => "<td>" + escape(c.trim()) + "</td>")
              .join("") +
            "</tr>"
          );
        }
        const end = table ? "</table></div>" : "";
        table = false;
        return (
          end +
          (line.startsWith("#")
            ? "<h2>" + escape(line.replace(/^#+\s*/, "")) + "</h2>"
            : line
              ? "<p>" + escape(line) + "</p>"
              : "")
        );
      })
      .join("") + (table ? "</table></div>" : "");
  return {
    "report.md": md,
    "report.html": `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Overnight paper report</title><style>body{margin:2em;background:#101613;color:#edf4ee;font:14px system-ui}p{overflow-wrap:anywhere;line-height:1.6}table{border-collapse:collapse}td{padding:10px;border:1px solid #35443a;white-space:nowrap}tr:first-child{font-weight:bold;background:#1d2b22}.scroll{overflow-x:auto}</style><h1>Complete paper test report</h1>${html}</html>`,
    "trades.csv": csv(r.trades),
    "pools.csv": csv(r.poolCoverage),
    "equity.csv": csv(
      r.equity.flatMap((row) =>
        row.values.map((value, i) => ({
          at: row.at,
          capital: r.books[i].initial,
          valueEth: value,
          pnlEth: value === null ? null : value - r.books[i].initial,
        })),
      ),
    ),
  };
}
export function resumeReport(saved, { runId, capitals, strategy, segment }) {
  if (
    saved.runId !== runId ||
    saved.status !== "segment_complete" ||
    saved.segment !== segment - 1 ||
    saved.books.length !== capitals.length ||
    saved.books.some(
      (b, i) => b.initial !== capitals[i] || b.strategy !== strategy || !Number.isFinite(b.lastAt),
    )
  )
    throw new Error(
      "Checkpoint does not match this overnight run; refusing a silent balance reset",
    );
  return { ...saved, segment, status: "running", finishedAt: null };
}
