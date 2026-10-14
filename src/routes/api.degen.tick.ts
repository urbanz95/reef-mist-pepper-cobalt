import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "node:crypto";

/**
 * Cron-style trigger for the keeper. Requires `Authorization: Bearer $CRON_SECRET`
 * (the header Vercel Cron sends). Without CRON_SECRET only the workspace preview
 * is allowed in; a deployed app answers 401 so nobody can poke the keeper.
 */
async function authorized(request: Request) {
  const { env, isDeployed } = await import("@/lib/env.server");
  const secret = env("CRON_SECRET");
  if (!secret) return !isDeployed();
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function run(request: Request) {
  if (!(await authorized(request))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const { startKeeperLoop, tickAllVaults } = await import("@/lib/keeper.server");
  startKeeperLoop();
  return Response.json(await tickAllVaults());
}

export const Route = createFileRoute("/api/degen/tick")({
  server: {
    handlers: {
      GET: async ({ request }) => run(request),
      POST: async ({ request }) => run(request),
    },
  },
});
