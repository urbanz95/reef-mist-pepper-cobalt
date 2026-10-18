import { DISCOVERY_PATHS } from "./universe.mjs";
export const METADATA_MAX_AGE_MS = 10 * 60000;
/** Shared low-rate discovery/held-pool budget. Cached timestamps never advance. */
export function createPoolProvider(fetchPage, now = Date.now) {
  const pages = new Map(),
    held = new Map(),
    known = new Map();
  let page = 1,
    nextRequest = 0,
    backoff = 65000;
  let requests = 0,
    successes = 0,
    failures = 0;
  function seed(pools) {
    for (const p of pools)
      if (!known.has(p.id) || p.fetchedAt > known.get(p.id).fetchedAt) known.set(p.id, p);
  }
  function snapshot() {
    const results = [...pages.values(), ...held.values()],
      pools = new Map();
    for (const p of results.flatMap((r) => r.pools))
      if (!pools.has(p.id) || p.fetchedAt > pools.get(p.id).fetchedAt) pools.set(p.id, p);
    return {
      pools: [...pools.values()],
      fetchedAt: results.length ? Math.min(...results.map((r) => r.fetchedAt)) : 0,
      providerAgeSec: results.length ? Math.max(...results.map((r) => r.providerAgeSec)) : 0,
      requested: false,
      requestStats: { requests, successes, failures },
    };
  }
  async function request(path) {
    requests++;
    nextRequest = now() + 65000;
    try {
      const result = await fetchPage(path);
      successes++;
      seed(result.pools);
      backoff = 65000;
      return result;
    } catch (e) {
      failures++;
      const hint = Number.isFinite(e.retryAfterMs) ? Math.max(0, e.retryAfterMs) : 0;
      nextRequest = now() + Math.max(backoff, hint);
      backoff = Math.min(15 * 60000, backoff * 2);
      throw e;
    }
  }
  return {
    seed,
    async discover() {
      if (now() < nextRequest) return snapshot();
      const result = await request(DISCOVERY_PATHS[page - 1]);
      pages.set(page, result);
      page = (page % DISCOVERY_PATHS.length) + 1;
      return { ...snapshot(), requested: true };
    },
    async currentPool(id) {
      const cached = snapshot().pools.find((p) => p.id === id) ?? known.get(id);
      if (cached) return { pools: [cached], fetchedAt: cached.fetchedAt, providerAgeSec: 0 };
      if (now() < nextRequest)
        throw new Error("Provider request budget unavailable for missing held pool");
      const result = await request(`/pools/${id}?include=base_token,quote_token`);
      held.set(id, result);
      return result;
    },
  };
}
