import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/degen/tick")({
  server: {
    handlers: {
      GET: async () => {
        const { startKeeperLoop, tickAllVaults } = await import("@/lib/keeper.server");
        startKeeperLoop();
        const result = await tickAllVaults();
        return Response.json(result);
      },
      POST: async () => {
        const { startKeeperLoop, tickAllVaults } = await import("@/lib/keeper.server");
        startKeeperLoop();
        const result = await tickAllVaults();
        return Response.json(result);
      },
    },
  },
});
