export const DISCOVERY_PATHS = [
  ...[1, 2, 3].map(
    (page) => `/dexes/uniswap-v3-robinhood/pools?page=${page}&include=base_token,quote_token`,
  ),
  "/new_pools?include=base_token,quote_token",
  "/trending_pools?include=base_token,quote_token",
  "/search/pools?query=PONS&network=robinhood&include=base_token,quote_token",
];
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
