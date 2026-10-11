import { createFileRoute } from "@tanstack/react-router";
import { PositionsView } from "@/components/positions-view";

export const Route = createFileRoute("/positions")({ component: PositionsPage });

function PositionsPage() {
  return <PositionsView />;
}
