const RETRY_DELAYS_MS = [30000, 60000, 120000, 300000];

/** Keep expected entry rejections local to a pool and candidate capital size. */
export function createAdmissionRetry(clock = Date.now) {
  const rejected = new Map();
  const publicRow = ({ reason, nextRetryAt }) => ({ reason, nextRetryAt });
  return {
    get(key) {
      const row = rejected.get(key);
      return row && clock() < row.nextRetryAt ? publicRow(row) : null;
    },
    reject(key, reason) {
      // Retain the bounded attempt count after expiry. Only a successful probe
      // clears it; otherwise a persistently bad route returns every 30 seconds.
      const attempt = Math.min((rejected.get(key)?.attempt ?? 0) + 1, RETRY_DELAYS_MS.length);
      const row = {
        attempt,
        reason,
        nextRetryAt: clock() + RETRY_DELAYS_MS[attempt - 1],
      };
      rejected.set(key, row);
      return publicRow(row);
    },
    clear(key) {
      rejected.delete(key);
    },
  };
}
