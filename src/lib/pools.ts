export type PoolKind = "stock" | "crypto" | "meme";
export type PoolVenue = "uniswap" | "launchpad";
export type PoolVersion = "v2" | "v3" | "v4";
export type MigrationStatus = "migrating" | "migrated";
export type DegenUniverse = "meme" | "all" | "stock";

export type TokenInfo = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
};

export type Pool = {
  id: string;
  version: PoolVersion;
  kind: PoolKind;
  feePct: number;
  tvlUsd: number;
  volume24h: number;
  volume1h?: number;
  priceUsd: number;
  quotePriceUsd: number;
  change24h: number;
  txns24h: number;
  tokenA: TokenInfo;
  tokenB: TokenInfo;
  imageA?: string | null;
  imageB?: string | null;
  createdAt?: string;
  fdvUsd?: number;
  dex?: string;
  venue?: PoolVenue;
};

export const USDG: TokenInfo = {
  symbol: "USDG",
  name: "Global Dollar",
  address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
  decimals: 6,
};

export const WETH: TokenInfo = {
  symbol: "WETH",
  name: "Wrapped Ether",
  address: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
  decimals: 18,
};

export const NATIVE_ETH = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export const STOCK_TICKERS = [
  "NVDA",
  "TSLA",
  "AAPL",
  "HOOD",
  "SPY",
  "QQQ",
  "GOOGL",
  "GME",
  "SPCX",
  "SGOV",
  "IBM",
  "AMZN",
  "META",
  "MSFT",
  "GLD",
  "SLV",
  "COIN",
  "MSTR",
  "PLTR",
  "AMD",
  "NFLX",
  "INTC",
  "BABA",
  "TSM",
  "ORCL",
  "CRM",
  "DIS",
  "BA",
  "NKE",
  "RDDT",
  "AMC",
  "RBLX",
  "TTWO",
  "USO",
  "IWM",
  "BRK.B",
  "V",
  "JPM",
  "UNH",
  "XOM",
] as const;

export const STOCK_SYMS = new Set<string>(STOCK_TICKERS);

export const CRYPTO_MAJORS = new Set([
  "WETH",
  "ETH",
  "USDG",
  "USDC",
  "USDT",
  "WBTC",
  "BTC",
  "TAO",
  "WETH.E",
  "USDE",
  "DAI",
]);

export const QUOTE_SYMS = new Set(["WETH", "ETH", "USDG", "USDC", "USDT", "USDE", "DAI", "WBTC"]);

/** Established memes already on Uniswap — not launchpad bonding curves. */
export const KNOWN_MEMES = new Set([
  "PONS",
  "MEME",
  "AI",
  "CASHCAT",
  "CHUMP",
  "PAIR",
  "HOODIE",
  "ROB",
]);

function t(
  symbol: string,
  name: string,
  address: string,
  decimals = 18,
): TokenInfo {
  return { symbol, name, address: address.toLowerCase(), decimals };
}

const NVDA = t("NVDA", "NVIDIA", "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec");
const TSLA = t("TSLA", "Tesla", "0x322f0929c4625ed5bad873c95208d54e1c003b2d");
const AAPL = t("AAPL", "Apple", "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9");
const HOOD = t("HOOD", "Robinhood Markets", "0x32ac8c1d7672667d5ebdea22935f7b06fc8d496f");
const SPY = t("SPY", "SPDR S&P 500", "0x117cc2133c37b721f49de2a7a74833232b3b4c0c");
const QQQ = t("QQQ", "Invesco QQQ", "0xd5f3879160bc7c32ebb4dc785f8a4f505888de68");
const GOOGL = t("GOOGL", "Alphabet", "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3");
const GME = t("GME", "GameStop", "0x1b0e319c6a659f002271b69db8a7df2f911c153e");
const SPCX = t("SPCX", "SpaceX", "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea");
const SGOV = t("SGOV", "iShares 0-3 Month Treasury", "0x92fd66527192e3e61d4ddd13322aa222de86f9b5");
const IBM = t("IBM", "IBM", "0x980dcf6766fa79f5cf0c4aadb3ab477ff15a9619");
const PONS = t("PONS", "Pons", "0x39dbed3a2bd333467115de45665cc57f813c4571");
const CASHCAT = t("CASHCAT", "Cash Cat", "0x020bfc650a365f8bb26819deaabf3e21291018b4");
const MEME = t("MEME", "A Meme Coin", "0x385f4f8ae47651ce5f58f5265395a669f8281e18");
const TAO = t("TAO", "Bittensor", "0xf3081494b87e8d5fb7960f066e931d1d0e6e3d67");
const CHUMP = t("CHUMP", "Chump Coin", "0x0e0d2c89a5a019fe1cf762e5e33187631dacc21b");
const AI = t("AI", "Artificial Inu", "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18");

function pool(
  partial: Omit<Pool, "quotePriceUsd" | "txns24h" | "imageA" | "imageB" | "venue" | "dex"> &
    Partial<Pick<Pool, "quotePriceUsd" | "txns24h" | "venue" | "dex" | "createdAt" | "fdvUsd" | "volume1h">>,
): Pool {
  return {
    quotePriceUsd: partial.quotePriceUsd ?? 1,
    txns24h: partial.txns24h ?? 0,
    venue: partial.venue ?? "uniswap",
    dex: partial.dex ?? (partial.version === "v4" ? "uniswap-v4-robinhood" : "uniswap-v3-robinhood"),
    ...partial,
  };
}

/** Snapshot fallbacks so the desk still renders if GeckoTerminal is down. */
export const CATALOG: Pool[] = [
  pool({
    id: "0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca",
    version: "v3",
    kind: "crypto",
    feePct: 0.01,
    tvlUsd: 31_888_673,
    volume24h: 549_476_329,
    priceUsd: 1,
    quotePriceUsd: 2487,
    change24h: 0.07,
    createdAt: "2026-07-02T20:51:08Z",
    tokenA: USDG,
    tokenB: WETH,
  }),
  pool({
    id: "0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3",
    version: "v3",
    kind: "stock",
    feePct: 0.05,
    tvlUsd: 6_855_111,
    volume24h: 20_671_644,
    priceUsd: 231.77,
    change24h: 0.09,
    createdAt: "2026-07-21T11:02:06Z",
    tokenA: NVDA,
    tokenB: USDG,
  }),
  pool({
    id: "0x69bfaf19c9f377bb306a89aed9f6b07e2c1a8d9a",
    version: "v3",
    kind: "crypto",
    feePct: 0.05,
    tvlUsd: 6_194_509,
    volume24h: 21_637_321,
    priceUsd: 1,
    quotePriceUsd: 2487,
    change24h: 0.06,
    createdAt: "2026-06-29T09:34:25Z",
    tokenA: USDG,
    tokenB: WETH,
  }),
  pool({
    id: "0xfab520051f96f4d2a32c22b6a3dd7fffdf231bfe",
    version: "v3",
    kind: "stock",
    feePct: 0.3,
    tvlUsd: 4_076_697,
    volume24h: 7_168_742,
    priceUsd: 101.71,
    change24h: 0.96,
    createdAt: "2026-07-21T14:48:51Z",
    tokenA: SGOV,
    tokenB: USDG,
  }),
  pool({
    id: "0xed50bdeea8adc232f159486192a4157281d722ff",
    version: "v3",
    kind: "meme",
    feePct: 0.3,
    tvlUsd: 3_992_246,
    volume24h: 40_004_567,
    priceUsd: 0.6868,
    change24h: -15.45,
    createdAt: "2026-07-16T15:39:37Z",
    tokenA: PONS,
    tokenB: WETH,
  }),
  pool({
    id: "0xd42a491087a15e5afd51feb3606066cc152d2b09",
    version: "v3",
    kind: "meme",
    feePct: 0.3,
    tvlUsd: 2_944_578,
    volume24h: 10_382_376,
    priceUsd: 0.1891,
    change24h: -13.9,
    createdAt: "2026-07-01T19:38:42Z",
    tokenA: CASHCAT,
    tokenB: WETH,
  }),
  pool({
    id: "0xc61284332117c3fb23a2a56cceffd07f7af60029",
    version: "v3",
    kind: "stock",
    feePct: 0.05,
    tvlUsd: 2_519_827,
    volume24h: 13_358_815,
    priceUsd: 150.4,
    change24h: -0.41,
    createdAt: "2026-07-23T11:56:34Z",
    tokenA: SPCX,
    tokenB: USDG,
  }),
  pool({
    id: "0xddcbba3666f578e3f09516f21ff85bfee859ab5e",
    version: "v3",
    kind: "stock",
    feePct: 0.05,
    tvlUsd: 1_781_574,
    volume24h: 9_892_490,
    priceUsd: 773.15,
    change24h: -0.11,
    createdAt: "2026-08-03T13:56:47Z",
    tokenA: SPY,
    tokenB: WETH,
  }),
  pool({
    id: "0xf4acdaeeb7022862a763c9b1b885e11191c889e3",
    version: "v3",
    kind: "stock",
    feePct: 0.3,
    tvlUsd: 1_391_304,
    volume24h: 2_050_670,
    priceUsd: 354.92,
    change24h: -0.66,
    createdAt: "2026-07-08T22:06:17Z",
    tokenA: TSLA,
    tokenB: USDG,
  }),
  pool({
    id: "0xd60a5d14db690b7afad71f76b108071d7175597d",
    version: "v3",
    kind: "stock",
    feePct: 0.05,
    tvlUsd: 1_363_669,
    volume24h: 4_576_152,
    priceUsd: 719.7,
    change24h: -0.08,
    createdAt: "2026-08-27T14:07:32Z",
    tokenA: QQQ,
    tokenB: USDG,
  }),
  pool({
    id: "0x62ab521f71431f78ac374cdbadc6cda3c8916b6c",
    version: "v3",
    kind: "stock",
    feePct: 0.05,
    tvlUsd: 1_086_788,
    volume24h: 5_581_752,
    priceUsd: 231.93,
    change24h: 0.26,
    createdAt: "2026-07-24T14:31:36Z",
    tokenA: NVDA,
    tokenB: WETH,
  }),
  pool({
    id: "0x714442e9a611f8561a7df108d6d925132937cfb8",
    version: "v3",
    kind: "meme",
    feePct: 1,
    tvlUsd: 1_106_987,
    volume24h: 4_655_228,
    priceUsd: 0.0355,
    change24h: -7.26,
    createdAt: "2026-07-31T01:44:31Z",
    fdvUsd: 35_497_996,
    tokenA: CHUMP,
    tokenB: WETH,
  }),
  pool({
    id: "0xe2b46c905e12ab8e2f864e4821a4325884c1b126",
    version: "v3",
    kind: "stock",
    feePct: 0.05,
    tvlUsd: 707_125,
    volume24h: 5_588_109,
    priceUsd: 19.23,
    change24h: -1.11,
    createdAt: "2026-07-23T20:27:17Z",
    tokenA: GME,
    tokenB: USDG,
  }),
  pool({
    id: "0x1c1f6e283a72a68c15c816324363c794151cf913",
    version: "v3",
    kind: "stock",
    feePct: 1,
    tvlUsd: 426_836,
    volume24h: 390_400,
    priceUsd: 123.79,
    change24h: -3.24,
    createdAt: "2026-07-10T22:04:49Z",
    tokenA: HOOD,
    tokenB: USDG,
  }),
  pool({
    id: "0x5d37b1d887b502594414a82d2cf7d4ef774a8027",
    version: "v3",
    kind: "meme",
    feePct: 0.3,
    tvlUsd: 395_191,
    volume24h: 10_307_685,
    priceUsd: 0.1391,
    change24h: 53.32,
    createdAt: "2026-09-04T06:16:22Z",
    fdvUsd: 121_728_942,
    tokenA: MEME,
    tokenB: USDG,
  }),
  pool({
    id: "0x34d0dc122cf9a8eb296fc5e0d3a233625d7d19b7",
    version: "v3",
    kind: "stock",
    feePct: 0.05,
    tvlUsd: 475_364,
    volume24h: 3_465_111,
    priceUsd: 340.2,
    change24h: 0.28,
    createdAt: "2026-07-10T22:04:49Z",
    tokenA: GOOGL,
    tokenB: USDG,
  }),
  pool({
    id: "0xaae0d815ee56e4092a5e5c2911e676fea50b2d6d",
    version: "v3",
    kind: "stock",
    feePct: 0.05,
    tvlUsd: 242_476,
    volume24h: 1_769_060,
    priceUsd: 320.85,
    change24h: -0.33,
    createdAt: "2026-07-27T16:51:58Z",
    tokenA: AAPL,
    tokenB: USDG,
  }),
  pool({
    id: "0x8cd848ce18b829c5c769aff27164078bb52e0e97",
    version: "v3",
    kind: "stock",
    feePct: 0.3,
    tvlUsd: 153_958,
    volume24h: 2_261_350,
    priceUsd: 246.84,
    change24h: 2.1,
    createdAt: "2026-09-06T02:44:17Z",
    tokenA: IBM,
    tokenB: USDG,
  }),
  pool({
    id: "0x3f048149f291f459a38fe1d937a361b153cba43e",
    version: "v3",
    kind: "crypto",
    feePct: 1,
    tvlUsd: 545_881,
    volume24h: 2_586_867,
    priceUsd: 259.28,
    change24h: 1.56,
    tokenA: TAO,
    tokenB: USDG,
  }),
  pool({
    id: "0xc4a21f9d6485fc5893dd4a491b320a83daf4da1d",
    version: "v3",
    kind: "meme",
    feePct: 1,
    tvlUsd: 2_782_481,
    volume24h: 6_442_169,
    priceUsd: 0.2292,
    change24h: 18.07,
    createdAt: "2026-07-22T16:37:33Z",
    fdvUsd: 226_716_398,
    tokenA: AI,
    tokenB: WETH,
  }),
  pool({
    id: "0xfe2a80bb5618fd14984b92ca6d45bf5ba67443ddb1435e28b2e48df2fc1526cd",
    version: "v4",
    kind: "stock",
    feePct: 0.3,
    tvlUsd: 10_100_000,
    volume24h: 2_700_000,
    priceUsd: 773,
    change24h: 0.4,
    tokenA: SPY,
    tokenB: USDG,
  }),
];

export function isQuoteToken(symbol: string) {
  return QUOTE_SYMS.has(symbol.toUpperCase());
}

export function speculativeSymbol(pool: Pool) {
  if (!isQuoteToken(pool.tokenA.symbol)) return pool.tokenA.symbol;
  if (!isQuoteToken(pool.tokenB.symbol)) return pool.tokenB.symbol;
  return pool.tokenA.symbol;
}

export function kindOfSymbols(a: string, b: string): PoolKind {
  const A = a.toUpperCase();
  const B = b.toUpperCase();
  if (STOCK_SYMS.has(A) || STOCK_SYMS.has(B)) return "stock";
  if (CRYPTO_MAJORS.has(A) && CRYPTO_MAJORS.has(B)) return "crypto";
  if (KNOWN_MEMES.has(A) || KNOWN_MEMES.has(B)) return "meme";
  if (CRYPTO_MAJORS.has(A) || CRYPTO_MAJORS.has(B)) return "meme";
  return "meme";
}

export function venueOfDex(dex?: string | null): PoolVenue {
  const d = (dex || "").toLowerCase();
  if (!d) return "uniswap";
  if (d.includes("uniswap")) return "uniswap";
  return "launchpad";
}

export function versionOfDex(dex?: string | null, address?: string): PoolVersion {
  const d = (dex || "").toLowerCase();
  if (d.includes("v4") || (address && address.length > 42)) return "v4";
  if (d.includes("v2")) return "v2";
  return "v3";
}

export function dexLabel(dex?: string | null): string {
  const d = (dex || "").toLowerCase();
  if (d.includes("uniswap-v4") || d.includes("v4")) return "Uniswap v4";
  if (d.includes("uniswap-v2") || d.includes("v2")) return "Uniswap v2";
  if (d.includes("uniswap-v3") || d.includes("v3")) return "Uniswap v3";
  if (d.includes("uniswap")) return "Uniswap";
  if (!d) return "Uniswap";
  return "Uniswap";
}

export function kindLabel(kind: PoolKind) {
  if (kind === "stock") return "Tokenized stock";
  if (kind === "meme") return "Meme";
  return "Crypto";
}

export function poolAgeMs(pool: Pool, now = Date.now()) {
  if (!pool.createdAt) return Number.POSITIVE_INFINITY;
  const t = Date.parse(pool.createdAt);
  return Number.isFinite(t) ? Math.max(0, now - t) : Number.POSITIVE_INFINITY;
}

export function isLaunchpad(pool: Pool) {
  return (pool.venue ?? "uniswap") === "launchpad";
}

export function isMigratedMeme(pool: Pool) {
  return pool.kind === "meme" && !isLaunchpad(pool);
}

export function migrationStatus(pool: Pool): MigrationStatus | null {
  if (!isMigratedMeme(pool)) return null;
  return "migrated";
}

export function canMintOnchain(pool: Pool) {
  return (
    !isLaunchpad(pool) &&
    pool.version === "v3" &&
    pool.id.startsWith("0x") &&
    pool.id.length === 42
  );
}

/** 24h fee APR — the number shown on mercados. */
export function estimatedApr(pool: Pool) {
  if (!pool.tvlUsd || pool.tvlUsd < 500) return 0;
  return ((pool.volume24h * (pool.feePct / 100)) / pool.tvlUsd) * 365 * 100;
}

/**
 * Chase APR for Degen Mode. Prefers the last hour of volume annualised
 * so the hunter actually moves when flow rotates between meme pools.
 */
export function huntApr(pool: Pool) {
  if (!pool.tvlUsd || pool.tvlUsd < 500) return 0;
  const vol =
    pool.volume1h && pool.volume1h > 0 ? pool.volume1h * 24 : pool.volume24h;
  return ((vol * (pool.feePct / 100)) / pool.tvlUsd) * 365 * 100;
}

export function dailyFees(pool: Pool) {
  return pool.volume24h * (pool.feePct / 100);
}

export function parseFeePct(name: string) {
  const m = name.match(/(\d+(?:\.\d+)?)%/);
  return m ? Number(m[1]) : 0.3;
}

export function findPool(pools: Pool[], id: string) {
  const needle = id.toLowerCase();
  return pools.find((p) => p.id.toLowerCase() === needle);
}

export function displayPair(pool: Pool) {
  return `${pool.tokenA.symbol}/${pool.tokenB.symbol}`;
}

export const DEGEN_MIN_TVL = 15_000;
export const APR_TVL_FLOOR = 8_000;

export function uniqueMigratedTokens(pools: Pool[]) {
  const map = new Map<string, Pool>();
  for (const p of pools.filter(isMigratedMeme)) {
    if (p.tvlUsd < APR_TVL_FLOOR) continue;
    const key = speculativeSymbol(p).toUpperCase();
    const prev = map.get(key);
    if (!prev || estimatedApr(p) > estimatedApr(prev)) map.set(key, p);
  }
  return [...map.values()].sort((a, b) => estimatedApr(b) - estimatedApr(a));
}

export function isWethPair(pool: Pool) {
  const w = WETH.address.toLowerCase();
  return (
    pool.tokenA.address.toLowerCase() === w || pool.tokenB.address.toLowerCase() === w
  );
}

export function degenEligible(pool: Pool, universe: DegenUniverse, minTvl = DEGEN_MIN_TVL) {
  if ((pool.venue ?? "uniswap") !== "uniswap") return false;
  if (pool.tvlUsd < minTvl) return false;
  if (universe === "meme" && pool.kind !== "meme") return false;
  if (universe === "stock" && pool.kind !== "stock") return false;
  const apr = huntApr(pool);
  return Number.isFinite(apr) && apr > 0;
}

export function rankDegen(pools: Pool[], universe: DegenUniverse, minTvl = DEGEN_MIN_TVL) {
  return pools
    .filter((p) => degenEligible(p, universe, minTvl))
    .sort((a, b) => huntApr(b) - huntApr(a));
}

export function rankByApr(pools: Pool[]) {
  return [...pools].sort((a, b) => {
    const aOk = a.tvlUsd >= APR_TVL_FLOOR ? 1 : 0;
    const bOk = b.tvlUsd >= APR_TVL_FLOOR ? 1 : 0;
    if (aOk !== bOk) return bOk - aOk;
    return estimatedApr(b) - estimatedApr(a);
  });
}

export function ethPriceUsd(pools: Pool[]) {
  for (const p of pools) {
    if (p.tokenA.symbol === "WETH" && p.priceUsd > 100) return p.priceUsd;
    if (p.tokenB.symbol === "WETH" && p.quotePriceUsd > 100) return p.quotePriceUsd;
  }
  return 2487;
}
