import { createFileRoute } from "@tanstack/react-router";

const short = (err: unknown) =>
  (err instanceof Error ? err.message : "unknown error").split("\n")[0].slice(0, 160);

/**
 * Plain-language readiness check for the operator. Public on purpose and free of
 * secrets: it only says WHETHER things are configured, plus the keeper's public
 * address and gas balance (both visible on-chain anyway).
 */
export const Route = createFileRoute("/api/degen/status")({
  server: {
    handlers: {
      GET: async () => {
        const { env, isDeployed } = await import("@/lib/env.server");
        const { dbSource } = await import("@/lib/db");
        const problems: string[] = [];
        const deployed = isDeployed();

        if (dbSource !== "neon") {
          problems.push("DATABASE_URL is missing: vaults are lost every restart.");
        }
        if (!env("KEEPER_PRIVATE_KEY")) problems.push("KEEPER_PRIVATE_KEY is missing.");
        if (!env("CRON_SECRET")) problems.push("CRON_SECRET is missing: the scheduler cannot call the keeper.");

        let keeper: { address: string; balanceEth: number } | null = null;
        try {
          const { getKeeperPublic } = await import("@/lib/keeper.server");
          const { publicClient } = await import("@/lib/degen-chain");
          const { formatEther } = await import("viem");
          const { address } = await getKeeperPublic();
          const wei = await publicClient().getBalance({ address });
          keeper = { address, balanceEth: Number(formatEther(wei)) };
          if (keeper.balanceEth < 0.003) {
            problems.push("The keeper wallet is low on gas (under 0.003 ETH). Send it some ETH.");
          }
        } catch (err) {
          if (env("KEEPER_PRIVATE_KEY")) problems.push(`Keeper wallet or chain not reachable: ${short(err)}`);
        }

        let vaults = { active: 0, total: 0 };
        let lastTickAgeSec: number | null = null;
        try {
          const { keeperStats } = await import("@/lib/keeper.server");
          const stats = await keeperStats();
          vaults = { active: stats.activeVaults, total: stats.totalVaults };
          lastTickAgeSec = stats.lastTickAt ? Math.round((Date.now() - stats.lastTickAt) / 1000) : null;
          if (deployed && (lastTickAgeSec === null || lastTickAgeSec > 300)) {
            problems.push(
              lastTickAgeSec === null
                ? "The scheduler has never called /api/degen/tick."
                : `The scheduler last called the keeper ${Math.round(lastTickAgeSec / 60)} min ago (should be every minute).`,
            );
          }
        } catch (err) {
          if (dbSource === "neon") problems.push(`Database not reachable: ${short(err)}`);
        }

        const paused = env("KEEPER_PAUSED") === "1";
        return Response.json({
          ok: problems.length === 0 && !paused,
          paused,
          problems,
          database: dbSource,
          keeper,
          vaults,
          lastTickAgeSec,
          closedBeta: Boolean(env("ARM_ALLOWLIST")),
          mode: deployed ? "deployed" : "preview",
        });
      },
    },
  },
});
