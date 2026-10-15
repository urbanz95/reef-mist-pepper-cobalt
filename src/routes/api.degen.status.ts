import { createFileRoute } from "@tanstack/react-router";
import { POLICY } from "@/lib/degen-policy";
export const Route = createFileRoute("/api/degen/status")({
  server: {
    handlers: {
      GET: async () => {
        const { keeperStats, keeperPaused, liveEnabled, getKeeperPublic, liveReadiness } =
          await import("@/lib/keeper.server");
        const { dbSource } = await import("@/lib/db");
        const { env } = await import("@/lib/env.server");
        const problems: string[] = [];
        let keeper: { address: string; balanceEth: number } | null = null;
        let lastTickAgeSec: number | null = null;
        let vaults = { active: 0, total: 0 };
        let ready = false;
        try {
          const stats = await keeperStats();
          vaults = { active: stats.activeVaults, total: stats.totalVaults };
          lastTickAgeSec = stats.lastTickAt
            ? Math.floor((Date.now() - stats.lastTickAt) / 1000)
            : null;
          problems.push(...stats.problems.map((p) => `${p.vault}: ${p.last_error}`));
          const readiness = await liveReadiness();
          ready = readiness.ready;
          if (readiness.reason) problems.push(readiness.reason);
        } catch {
          problems.push("Database or execution state unavailable.");
        }
        if (liveEnabled()) {
          if (!env("CRON_SECRET")) problems.push("CRON_SECRET is required.");
          try {
            const { address } = await getKeeperPublic();
            const { publicClient } = await import("@/lib/degen-chain");
            const { formatEther } = await import("viem");
            keeper = {
              address,
              balanceEth: Number(formatEther(await publicClient().getBalance({ address }))),
            };
            if (keeper.balanceEth === 0)
              problems.push(
                "Keeper has no gas. Each transaction also checks an estimated reserve for two exits.",
              );
          } catch {
            problems.push("Keeper account or RPC unavailable.");
          }
        }
        return Response.json({
          ok: problems.length === 0 && !keeperPaused(),
          paused: keeperPaused(),
          problems,
          database: dbSource,
          keeper,
          vaults,
          lastTickAgeSec,
          mode: liveEnabled() ? "live" : "paper",
          liveReady: ready,
          requiredIntervalSec: POLICY.riskIntervalMs / 1000,
          staleAfterSec: POLICY.maxSchedulerGapMs / 1000,
          simulationAvailable: true,
          closedBeta: Boolean(env("ARM_ALLOWLIST")),
        });
      },
    },
  },
});
