import { createFileRoute } from "@tanstack/react-router";
import { MarketsView } from "@/components/markets-view";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <MarketsView />;
}
