import { setTimeout as delay } from "node:timers/promises";
import { PAPER_RISK } from "../../src/lib/paper-risk.ts";

// The public endpoint can return only the first address of a multi-token query.
// Each request must bind one result to one token. Keep <= 2 requests per refresh
// and >= 2.1 seconds between starts; a normal five-second loop uses <= 24/minute.
export function createSecurityProvider(fetcher = fetch, now = Date.now, { wait = delay } = {}) {
  const cache = new Map();
  let nextRequest = 0,
    backoff = 30000,
    lastError = null,
    busy = null;
  const counts = { requests: 0, responses: 0, missing: 0, failures: 0 };
  let wanted = [],
    priority = new Set();
  const state = (token, at = now()) => {
    const row = cache.get(token.toLowerCase());
    const status = row?.raw
      ? at - row.checkedAt <= PAPER_RISK.maxSecurityAgeMs && row.checkedAt <= at
        ? "available"
        : "stale"
      : row?.error
        ? "error"
        : row?.lastAttemptAt === undefined
          ? "pending"
          : "missing";
    return {
      status,
      checkedAt: row?.checkedAt ?? 0,
      requestedAt: row?.lastAttemptAt,
      detail:
        row?.error ??
        (status === "missing" ? "The provider returned no record for this token" : undefined),
    };
  };
  const needed = () =>
    wanted
      .filter((token) => {
        const row = cache.get(token);
        return (
          !row || (now() >= (row.retryAt ?? 0) && (!row.raw || now() - row.checkedAt >= 20000))
        );
      })
      .sort((a, b) => {
        const urgent = (t) =>
          priority.has(t) && (!cache.get(t)?.raw || now() - cache.get(t).checkedAt >= 40000);
        return (
          Number(urgent(b)) - Number(urgent(a)) ||
          (cache.get(a)?.lastAttemptAt ?? -Infinity) - (cache.get(b)?.lastAttemptAt ?? -Infinity) ||
          a.localeCompare(b)
        );
      });
  async function refresh() {
    if (now() < nextRequest) return;
    for (let i = 0; i < 2; i++) {
      const token = needed()[0];
      if (!token) break;
      if (now() < nextRequest) await wait(nextRequest - now());
      const attemptedAt = now(),
        old = cache.get(token) ?? { checkedAt: 0 };
      nextRequest = attemptedAt + 2100;
      cache.set(token, { ...old, lastAttemptAt: attemptedAt });
      counts.requests++;
      try {
        const res = await fetcher(
          `https://api.gopluslabs.io/api/v1/token_security/4663?contract_addresses=${token}`,
          { signal: AbortSignal.timeout(5000) },
        );
        if (!res.ok) {
          const e = new Error(`Security provider HTTP ${res.status}`),
            retry = res.headers.get("retry-after");
          e.retry =
            retry === null
              ? 0
              : /^\d+(\.\d+)?$/.test(retry)
                ? Number(retry) * 1000
                : Math.max(0, Date.parse(retry) - now());
          throw e;
        }
        const age = Number(res.headers.get("age") ?? 0);
        if (!Number.isFinite(age) || age < 0) throw new Error("Invalid security cache age");
        const data = await res.json();
        if (
          data.code !== 1 ||
          !data.result ||
          typeof data.result !== "object" ||
          Array.isArray(data.result)
        )
          throw new Error("Security provider returned no supported result");
        const raw = Object.entries(data.result).find(([a]) => a.toLowerCase() === token)?.[1];
        if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Object.keys(raw).length) {
          counts.missing++;
          // Preserve any earlier evidence and its original timestamp. An omitted
          // result must never acquire a fresh approval timestamp.
          cache.set(token, {
            ...old,
            error: undefined,
            lastAttemptAt: attemptedAt,
            retryAt: now() + 30000,
          });
        } else {
          cache.set(token, { raw, checkedAt: now() - age * 1000, lastAttemptAt: attemptedAt });
        }
        counts.responses++;
        lastError = null;
        backoff = 30000;
      } catch (e) {
        counts.failures++;
        lastError = e.message;
        const retry = Math.max(backoff, Number.isFinite(e.retry) ? e.retry : 0);
        nextRequest = now() + retry;
        cache.set(token, {
          ...old,
          lastAttemptAt: attemptedAt,
          error: e.message,
          retryAt: nextRequest,
        });
        backoff = Math.min(900000, backoff * 2);
        break;
      }
    }
    // Bound cached public records during long discovery runs.
    if (cache.size > 1024)
      for (const token of cache.keys()) {
        if (!wanted.includes(token)) cache.delete(token);
        if (cache.size <= 1024) break;
      }
  }
  return {
    get: (token) => cache.get(token.toLowerCase()),
    dataStatus: state,
    get lastError() {
      return lastError;
    },
    get snapshot() {
      const tracked = [...new Set([...cache.keys(), ...wanted])];
      const statuses = tracked.map((token) => state(token).status);
      return {
        ...counts,
        tracked: tracked.length,
        available: statuses.filter((s) => s === "available").length,
        pending: statuses.filter((s) => s === "pending").length,
        stale: statuses.filter((s) => s === "stale").length,
        missingTokens: statuses.filter((s) => s === "missing").length,
        failedTokens: statuses.filter((s) => s === "error").length,
      };
    },
    async refresh(tokens, { priorityTokens = [] } = {}) {
      wanted = [...new Set(tokens.map((t) => t.toLowerCase()))]
        .filter((t) => /^0x[0-9a-f]{40}$/.test(t))
        .slice(0, 32);
      priority = new Set(priorityTokens.map((t) => t.toLowerCase()));
      if (busy) return busy;
      busy = refresh().finally(() => {
        busy = null;
      });
      return busy;
    },
  };
}
