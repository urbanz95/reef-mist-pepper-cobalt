// New experiments use bounded, independently valued positions. Legacy strategies
// remain available only for reproducing historical paper reports.
process.env.PAPER_STRATEGY ??= "guarded";
await import(process.env.PAPER_STRATEGY === "guarded" ? "./guarded-run.mjs" : "./legacy-run.mjs");
