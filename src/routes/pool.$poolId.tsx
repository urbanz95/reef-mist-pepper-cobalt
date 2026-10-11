import { createFileRoute } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { PoolDetail } from "@/components/pool-detail";
import { Button } from "@/components/ui/button";
import { usePool } from "@/lib/use-pools";

export const Route = createFileRoute("/pool/$poolId")({
  component: PoolPage,
});

function PoolPage() {
  const { poolId } = Route.useParams();
  const pool = usePool(poolId);

  if (!pool) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-xl font-semibold">Pool not found</h1>
        <p className="mt-2 text-sm text-muted">
          This id is not in the Perch catalog. Go back to markets and pick another.
        </p>
        <Button asChild className="mt-6">
          <Link to="/">Markets</Link>
        </Button>
      </div>
    );
  }

  return <PoolDetail pool={pool} />;
}
