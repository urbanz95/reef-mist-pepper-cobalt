import { createServerFn } from "@tanstack/react-start";
import {
  CATALOG,
  NATIVE_ETH,
  WETH,
  kindOfSymbols,
  parseFeePct,
  venueOfDex,
  versionOfDex,
  type Pool,
  type TokenInfo,
} from "./pools";

const GECKO = "https://api.geckoterminal.com/api/v2";

type GeckoToken = {
  id: string;
  type: string;
  attributes: {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    image_url?: string | null;
  };
};

type GeckoPool = {
  id: string;
  attributes: {
    address: string;
    name: string;
    reserve_in_usd?: string;
    base_token_price_usd?: string;
    quote_token_price_usd?: string;
    fdv_usd?: string;
    pool_created_at?: string;
    volume_usd?: { h24?: string; h1?: string; h6?: string; m5?: string };
    price_change_percentage?: { h24?: string };
    transactions?: { h24?: { buys?: number; sells?: number } };
  };
  relationships?: {
    base_token?: { data?: { id: string } };
    quote_token?: { data?: { id: string } };
    dex?: { data?: { id: string } };
  };
};

function num(v: string | number | undefined | null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normAddress(address: string) {
  const a = (address || "").toLowerCase();
  if (!a || a === NATIVE_ETH || a === "0x0000000000000000000000000000000000000000") {
    return WETH.address;
  }
  return a;
}

function tokenFrom(attr: GeckoToken["attributes"]): TokenInfo {
  const symbol = (attr.symbol || "?").toUpperCase();
  const address = normAddress(attr.address);
  if (address === WETH.address && (symbol === "WETH" || symbol === "ETH")) return WETH;
  return {
    symbol,
    name: attr.name || attr.symbol || "Token",
    address,
    decimals: attr.decimals || 18,
  };
}

function mapGecko(p: GeckoPool, tokens: Record<string, GeckoToken>): Pool | null {
  const a = p.attributes;
  const bt = tokens[p.relationships?.base_token?.data?.id ?? ""];
  const qt = tokens[p.relationships?.quote_token?.data?.id ?? ""];
  if (!bt || !qt) return null;
  const dex = p.relationships?.dex?.data?.id ?? undefined;
  const venue = venueOfDex(dex);
  const tokenA = tokenFrom(bt.attributes);
  const tokenB = tokenFrom(qt.attributes);
  if (tokenA.address === tokenB.address) return null;
  const tx = a.transactions?.h24;
  return {
    id: a.address.toLowerCase(),
    version: versionOfDex(dex, a.address),
    kind: venue === "uniswap" ? kindOfSymbols(tokenA.symbol, tokenB.symbol) : "crypto",
    feePct: parseFeePct(a.name),
    tvlUsd: num(a.reserve_in_usd),
    volume24h: num(a.volume_usd?.h24),
    volume1h: num(a.volume_usd?.h1),
    priceUsd: num(a.base_token_price_usd),
    quotePriceUsd: num(a.quote_token_price_usd) || 1,
    change24h: num(a.price_change_percentage?.h24),
    txns24h: (tx?.buys ?? 0) + (tx?.sells ?? 0),
    tokenA,
    tokenB,
    imageA: bt.attributes.image_url,
    imageB: qt.attributes.image_url,
    createdAt: a.pool_created_at,
    fdvUsd: a.fdv_usd ? num(a.fdv_usd) : undefined,
    dex,
    venue,
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function geckoJson(path: string) {
  let lastErr: Error | null = null;
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`${GECKO}${path}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "PerchLiquidityDesk/1.0",
      },
    });
    if (res.status === 429) {
      lastErr = new Error("gecko 429");
      await sleep(450 * (i + 1));
      continue;
    }
    if (!res.ok) throw new Error(`gecko ${res.status}`);
    return (await res.json()) as {
      data?: GeckoPool[] | GeckoPool;
      included?: GeckoToken[];
    };
  }
  throw lastErr ?? new Error("gecko failed");
}

function mapResponse(json: {
  data?: GeckoPool[] | GeckoPool;
  included?: GeckoToken[];
}): Pool[] {
  const tokens: Record<string, GeckoToken> = {};
  for (const t of json.included ?? []) tokens[t.id] = t;
  const rows = Array.isArray(json.data) ? json.data : json.data ? [json.data] : [];
  return rows.map((p) => mapGecko(p, tokens)).filter((p): p is Pool => !!p);
}

async function fetchPath(path: string): Promise<Pool[]> {
  return mapResponse(await geckoJson(path));
}

function mergePools(live: Pool[], catalog: Pool[]) {
  const byId = new Map<string, Pool>();
  for (const p of catalog) byId.set(p.id.toLowerCase(), p);
  for (const p of live) {
    const prev = byId.get(p.id.toLowerCase());
    byId.set(p.id.toLowerCase(), prev ? { ...prev, ...p } : p);
  }
  return [...byId.values()].sort((a, b) => b.tvlUsd - a.tvlUsd);
}

const INCLUDE = "include=base_token,quote_token,dex";

const DEX_PAGES: { dex: string; pages: number }[] = [
  { dex: "uniswap-v3-robinhood", pages: 3 },
  { dex: "uniswap-v4-robinhood", pages: 1 },
  { dex: "uniswap-v2-robinhood", pages: 1 },
];

let cache: { at: number; pools: Pool[] } | null = null;
const CACHE_MS = 30_000;

function onlyUniswap(pools: Pool[]) {
  return pools.filter((p) => (p.venue ?? "uniswap") === "uniswap");
}

async function gatherLive(): Promise<Pool[]> {
  const live: Pool[] = [];
  for (const { dex, pages } of DEX_PAGES) {
    for (let page = 1; page <= pages; page++) {
      let rows: Pool[] | null = null;
      for (let attempt = 0; attempt < 3 && !rows; attempt++) {
        try {
          rows = onlyUniswap(
            await fetchPath(
              `/networks/robinhood/dexes/${dex}/pools?page=${page}&order=h24_volume_usd_desc&${INCLUDE}`,
            ),
          );
        } catch {
          await sleep(600 * (attempt + 1));
        }
      }
      if (!rows) break;
      live.push(...rows);
      if (rows.length < 20) break;
      await sleep(280);
    }
  }
  return live;
}

export async function loadPoolsCached() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.pools;
  try {
    const live = await gatherLive();
    const pools = live.length ? onlyUniswap(mergePools(live, CATALOG)) : CATALOG;
    cache = { at: Date.now(), pools };
    return pools;
  } catch {
    return CATALOG;
  }
}

export const getPools = createServerFn({ method: "GET" }).handler(async () => {
  return loadPoolsCached();
});

export const getPoolById = createServerFn({ method: "GET" })
  .validator((id: unknown) => String(id || ""))
  .handler(async ({ data: id }) => {
    const needle = id.toLowerCase();
    if (!needle) return null;
    const local = CATALOG.find((p) => p.id.toLowerCase() === needle);
    try {
      const json = await geckoJson(`/networks/robinhood/pools/${needle}?${INCLUDE}`);
      const mapped = mapResponse(json)[0];
      return mapped ?? local ?? null;
    } catch {
      return local ?? null;
    }
  });
