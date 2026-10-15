// Continuous scheduler for an existing always-on machine. No wallet keys here.
// CRON_SECRET and KEEPER_URL must be supplied securely by the process environment.
const url = process.env.KEEPER_URL;
const secret = process.env.CRON_SECRET;
if (!url || !secret) throw new Error("Set KEEPER_URL and CRON_SECRET in the worker environment");
const endpoint = new URL("/api/degen/tick", url);
if (endpoint.protocol !== "https:" && endpoint.hostname !== "127.0.0.1")
  throw new Error("HTTPS is required");
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
while (!stopping) {
  const start = Date.now();
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(55_000),
      redirect: "error",
    });
    const result = await res.json();
    if (!res.ok || result.ok !== true) throw new Error(`Keeper check failed (HTTP ${res.status})`);
    console.log(new Date().toISOString(), "completed", result.processed, result.mode);
  } catch (e) {
    console.error(new Date().toISOString(), e.message);
  }
  if (!stopping)
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1000, 15_000 - (Date.now() - start))),
    );
}
