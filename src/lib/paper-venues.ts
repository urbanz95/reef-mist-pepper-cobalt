/** Venue names are provider identifiers, not a proof of contract identity. */
export const isPons = (dex: string) => dex === "pons-v2" || dex === "pons-v2-dex";
const versions = new Map<string, number>(
  Object.entries({
    "uniswap-v2-robinhood": 2,
    "uniswap-v3-robinhood": 3,
    "uniswap-v4-robinhood": 4,
    "pons-v2": 5,
    "pons-v2-dex": 4,
  }),
);
export const paperVersion = (dex: string) => versions.get(dex) ?? 0;
export const nativeFunding = (dex: string) =>
  ["uniswap-v4-robinhood", "pons-v2", "pons-v2-dex"].includes(dex);
export const hashPoolId = (dex: string) => ["uniswap-v4-robinhood", "pons-v2-dex"].includes(dex);
