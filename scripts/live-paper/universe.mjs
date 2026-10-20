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
/** Entry support is narrower than read-only quote support. */
export function guardedRouteBlock(pool, assessment) {
  if (pool.dex === "uniswap-v2-robinhood" || pool.dex === "pons-v2-dex") return null;
  if (pool.dex === "pons-v2")
    return assessment?.stage === "graduated"
      ? null
      : "Entry requires verified Pons graduation and a permanent liquidity proof";
  return "Entry liquidity-protection adapter unavailable for this venue";
}
export function guardedAssessmentDeferred(c, now) {
  if (c?.securityStatus === "rejected" && now - c.securityCheckedAt < 60000)
    return "Recent security rejection; recheck after the one-minute cooldown";
  if (
    c?.securityStatus === "unknown" &&
    c.securityData?.status === "available" &&
    now - c.securityCheckedAt < 60000
  )
    return "Provider responded but required security evidence is unresolved; recheck after one minute";
  if (
    c?.securityStatus === "unknown" &&
    c.securityData?.status === "missing" &&
    now - c.securityData.requestedAt < 30000
  )
    return "Provider has no token record; retry after 30 seconds";
  return null;
}
export function rankGuardedPools(pools) {
  const activity = (p) =>
    Math.log1p(Math.max(0, Number(p.volume5m ?? p.volume24h / 288) || 0)) +
    Math.min(5, Math.max(0, Number(p.volume24h) / Math.max(1, p.tvlUsd) || 0));
  return [...pools].sort((a, b) => activity(b) - activity(a) || a.id.localeCompare(b.id));
}
export function selectGuardedPools(eligible, previous, coverage, now) {
  const byId = new Map(coverage.map((p) => [p.id, p]));
  const feasible = eligible.filter((p) => {
    const c = byId.get(p.id);
    return !guardedRouteBlock(p, c) && !guardedAssessmentDeferred(c, now);
  });
  const distinct = new Map();
  for (const p of rankGuardedPools(feasible)) if (!distinct.has(p.other)) distinct.set(p.other, p);
  const previouslyProved = (p) => {
    const c = byId.get(p.id);
    return (
      c?.securityStatus === "approved" ||
      (c?.securityApprovedCount > 0 && c.securityStatus !== "rejected")
    );
  };
  const all = [...distinct.values()].sort(
      (a, b) => Number(previouslyProved(b)) - Number(previouslyProved(a)),
    ),
    byPool = new Map(all.map((p) => [p.id, p]));
  const continuing = previous && now - previous.startedAt < 180000;
  if (continuing) {
    const kept = previous.ids.map((id) => byPool.get(id)).filter(Boolean);
    // A newly proved diagnostic must gain an entry slot immediately. Keeping
    // six unresolved tokens until window expiry starves genuine price history.
    const selected = [
      ...new Map([...all.filter(previouslyProved), ...kept, ...all].map((p) => [p.id, p])).values(),
    ].slice(0, 6);
    return { selected, window: { ...previous, ids: selected.map((p) => p.id) } };
  }
  const leaders = all.slice(0, 4),
    research = all.slice(4);
  const cursor = previous ? (previous.cursor ?? 0) + 2 : 0;
  const selected = [
    ...leaders,
    ...Array.from(
      { length: Math.min(2, research.length) },
      (_, i) => research[(cursor + i) % research.length],
    ),
  ];
  return { selected, window: { startedAt: now, cursor, ids: selected.map((p) => p.id) } };
}
export const PONS_DISCOVERY_PATHS = [
  "/dexes/pons-v2-dex/pools?page=1&include=base_token,quote_token",
  "/new_pools?page=1&include=base_token,quote_token",
  "/dexes/pons-v2/pools?page=1&include=base_token,quote_token",
  "/dexes/pons-v2-dex/pools?page=2&include=base_token,quote_token",
  "/dexes/uniswap-v2-robinhood/pools?page=1&include=base_token,quote_token",
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
