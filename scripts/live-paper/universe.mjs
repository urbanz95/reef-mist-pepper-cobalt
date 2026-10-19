export const DISCOVERY_PATHS = [
  ...[1, 2, 3].map(
    (page) => `/dexes/uniswap-v3-robinhood/pools?page=${page}&include=base_token,quote_token`,
  ),
  "/new_pools?include=base_token,quote_token",
  "/trending_pools?include=base_token,quote_token",
  "/search/pools?query=PONS&network=robinhood&include=base_token,quote_token",
];
export const LAUNCH_DISCOVERY_PATHS = [
  "/new_pools?page=1&include=base_token,quote_token",
  "/new_pools?page=2&include=base_token,quote_token",
  "/new_pools?page=1&include=base_token,quote_token",
  "/trending_pools?include=base_token,quote_token",
];
export const PONS_DISCOVERY_PATHS = [
  "/dexes/pons-v2-dex/pools?page=1&include=base_token,quote_token",
  "/new_pools?page=1&include=base_token,quote_token",
  "/dexes/pons-v2/pools?page=1&include=base_token,quote_token",
  "/new_pools?page=2&include=base_token,quote_token",
  "/new_pools?page=1&include=base_token,quote_token",
  "/trending_pools?include=base_token,quote_token",
];
/** One curve and one graduated market, isolated from security admission. */
export function selectPonsDiagnostics(pools, now) {
  return ["pons-v2", "pons-v2-dex"].flatMap((dex) => {
    const list = pools.filter(
      (p) =>
        p.dex === dex && !p.executionBlock && p.fetchedAt <= now && now - p.fetchedAt <= 600000,
    );
    if (!list.length) return [];
    const offset = Math.floor(now / 30000) % list.length;
    return [list[offset]];
  });
}
export function selectLaunchPools(eligible, previous, now) {
  const byId = new Map(eligible.map((p) => [p.id, p]));
  const continuing = previous && now - previous.startedAt < 300000;
  const retained = continuing ? previous.ids.map((id) => byId.get(id)).filter(Boolean) : [];
  const candidates = [...retained, ...eligible.filter((p) => !retained.includes(p))];
  const counts = new Map(),
    selected = [];
  for (const p of candidates) {
    const n = counts.get(p.other) ?? 0;
    if (n >= 2) continue;
    counts.set(p.other, n + 1);
    selected.push(p);
    if (selected.length === 6) break;
  }
  return {
    selected,
    window: { startedAt: continuing ? previous.startedAt : now, ids: selected.map((p) => p.id) },
  };
}
export function selectProbePools(eligible, now = Date.now()) {
  const counts = new Map();
  const diverse = eligible.filter((p) => {
    const count = counts.get(p.other) ?? 0;
    counts.set(p.other, count + 1);
    return count < 2;
  });
  // Keep the leaders under continuous observation. Rotate two research slots,
  // stable for five minutes so unknown tokens can accumulate entry confirmation.
  const leaders = diverse.slice(0, 4);
  const research = diverse.slice(4).sort((a, b) => a.id.localeCompare(b.id));
  if (!research.length) return leaders;
  const offset = (Math.floor(now / 300000) * 2) % research.length;
  return [
    ...leaders,
    ...Array.from(
      { length: Math.min(2, research.length) },
      (_, i) => research[(offset + i) % research.length],
    ),
  ];
}
