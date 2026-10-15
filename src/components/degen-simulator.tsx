import { useState } from "react";
import { Button } from "./ui/button";
import { newPaperRun, paperStep, type Scenario } from "@/lib/degen-simulation";
const SCENARIOS: { id: Scenario; label: string }[] = [
  { id: "normal", label: "Stable opportunity" },
  { id: "loss", label: "10% price loss" },
  { id: "liquidity", label: "60% liquidity drop" },
  { id: "honeypot", label: "Token becomes unsellable" },
  { id: "outage", label: "Monitoring / data outage" },
  { id: "expensive", label: "Costs exceed fees" },
];
export function DegenSimulator() {
  const [scenario, setScenario] = useState<Scenario>("loss");
  const [amount, setAmount] = useState("1");
  const [run, setRun] = useState(() => newPaperRun());
  const reset = () => setRun(newPaperRun(Math.max(0.00001, Number(amount) || 1)));
  return (
    <section
      className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)] md:p-6"
      aria-label="Paper testing"
    >
      <p className="text-xs font-medium uppercase tracking-widest text-accent">No-money test lab</p>
      <h2 className="mt-2 text-2xl font-semibold">Test the decisions before funding a vault</h2>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        No wallet, signature or real funds. Synthetic scenarios use the same decision rules as the
        keeper. Prices, fees and execution are simulated; results are not a profit forecast or a
        historical backtest.
      </p>
      <div className="mt-5 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Scenario
          <select
            className="rounded-md bg-surface-2 p-2 text-sm text-fg"
            value={scenario}
            onChange={(e) => {
              setScenario(e.target.value as Scenario);
              reset();
            }}
          >
            {SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Virtual capital (ETH)
          <input
            aria-label="Virtual capital (ETH)"
            type="number"
            min="0.00001"
            step="0.00001"
            className="w-36 rounded-md bg-surface-2 p-2 text-sm text-fg"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <Button variant="secondary" onClick={reset}>
          Reset capital
        </Button>
        <Button onClick={() => setRun((r) => paperStep(r, scenario))}>Next 30 seconds</Button>
        <Button
          variant="secondary"
          onClick={() =>
            setRun((r) => {
              for (let i = 0; i < 20; i++) r = paperStep(r, scenario);
              return r;
            })
          }
        >
          Run 10 minutes
        </Button>
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ["Virtual value", `${run.value.toFixed(8)} ETH`],
          ["Net vs holding ETH", `${(run.value - run.initial).toFixed(8)} ETH`],
          ["Assumed fees / costs", `${run.fees.toFixed(8)} / ${run.costs.toFixed(8)}`],
          [
            "Position",
            run.state.current
              ? "In pool"
              : run.state.halted
                ? "Exited · stop latched"
                : "Holding ETH",
          ],
        ].map(([label, value]) => (
          <div key={label} className="rounded-md bg-surface-2 p-3">
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="mt-1 break-words font-mono text-sm">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-muted">
        Rules: 2-minute confirmation · 30-minute minimum hold · max. 4 entries/day · 5% ETH
        loss/trailing stop · 30% liquidity drop. Stops are attempted exits, not guaranteed loss
        limits.
      </p>
      <ol
        aria-live="polite"
        className="mt-4 max-h-64 overflow-y-auto divide-y divide-border text-sm"
      >
        {run.log.length ? (
          run.log.map((entry) => (
            <li key={entry.step} className="flex flex-wrap gap-x-3 gap-y-1 py-2">
              <span className="font-mono text-muted">{entry.step * 30}s</span>
              <strong className="uppercase text-accent">{entry.action}</strong>
              <span>{entry.reason}</span>
            </li>
          ))
        ) : (
          <li className="py-3 text-muted">
            Choose a scenario and run the test. Try 0.00045 ETH to see why costs can prevent an
            entry.
          </li>
        )}
      </ol>
    </section>
  );
}
