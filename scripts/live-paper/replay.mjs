// Chronological development replay, not independent evidence of profitability.
import { readFileSync } from "node:fs";
import { newLiveBook, stepLiveBook } from "../../src/lib/live-paper.ts";
const path = process.argv[2];
if (!path) throw new Error("Provide a samples.ndjson file");
const records = readFileSync(path, "utf8")
  .trim()
  .split("\n")
  .map((s) => JSON.parse(s));
for (const capital of [...new Set(records.flatMap((r) => r.decisions.map((d) => d.capital)))]) {
  for (const strategy of ["baseline", "carry48"]) {
    let book = newLiveBook(capital, strategy);
    const actions = {},
      operations = [];
    for (const [index, row] of records.entries()) {
      const points = row.markets.filter((m) => m.capital === capital);
      const recorded = row.decisions.find((d) => d.capital === capital)?.observedAt;
      // Older logs lack decision timestamps: conservatively use end of sample interval.
      const now =
        recorded ??
        (records[index + 1] ? Date.parse(records[index + 1].at) : Date.parse(row.at) + 15000);
      const result = stepLiveBook(book, points, now);
      book = result.book;
      actions[result.decision.action] = (actions[result.decision.action] ?? 0) + 1;
      if (["enter", "exit", "hop"].includes(result.decision.action))
        operations.push({
          at: row.at,
          action: result.decision.action,
          reason: result.decision.reason,
          value: book.value,
          cost: result.charged,
        });
    }
    console.log(
      JSON.stringify({
        strategy,
        capital,
        actions,
        operations,
        value: book.value,
        pnl: book.value === null ? null : book.value - capital,
        position: book.state.current,
        fees: book.fees,
        costs: book.costs,
        closed: book.position === null,
      }),
    );
  }
}
