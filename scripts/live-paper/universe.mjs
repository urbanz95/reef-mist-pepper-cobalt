// Explicit research watchlist, identified by chain addresses, not ticker matching.
// This is not a security approval or a complete catalogue of memecoins.
export const MEME_WATCHLIST = [
  {
    token: "0x385f4f8ae47651ce5f58f5265395a669f8281e18",
    pool: "0xe2c12a7379706a291cadaaec1d22458be2f7239d",
    label: "MEME",
  },
  {
    token: "0x020bfc650a365f8bb26819deaabf3e21291018b4",
    pool: "0xa70fc67c9f69da90b63a0e4c05d229954574e313",
    label: "CASHCAT",
  },
];
export const DISCOVERY_PATHS = [
  ...[1, 2, 3].map(
    (page) => `/dexes/uniswap-v3-robinhood/pools?page=${page}&include=base_token,quote_token`,
  ),
  ...MEME_WATCHLIST.map(({ pool }) => `/pools/${pool}?include=base_token,quote_token`),
];
export function selectProbePools(eligible) {
  const counts = new Map();
  const diverse = eligible.filter((p) => {
    const count = counts.get(p.other) ?? 0;
    counts.set(p.other, count + 1);
    return count < 2;
  });
  const watched = diverse
    .filter((p) => MEME_WATCHLIST.some((m) => m.token === p.other))
    .slice(0, 2);
  return [...watched, ...diverse.filter((p) => !watched.includes(p))].slice(0, 6);
}
