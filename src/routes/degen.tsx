import { createFileRoute } from "@tanstack/react-router";
import { DegenView } from "@/components/degen-view";

export const Route = createFileRoute("/degen")({ component: DegenPage });

function DegenPage() {
  return <DegenView />;
}
