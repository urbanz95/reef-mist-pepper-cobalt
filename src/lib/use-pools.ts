import { useQuery } from "@tanstack/react-query";
import { getPoolById, getPools } from "@/lib/fetch-pools";
import { CATALOG, findPool, type Pool } from "@/lib/pools";

export function usePools() {
  return useQuery({
    queryKey: ["perch-pools"],
    queryFn: () => getPools(),
    initialData: CATALOG,
    initialDataUpdatedAt: 0,
    staleTime: 15_000,
    refetchInterval: 20_000,
  });
}

export function usePool(id: string | undefined): Pool | undefined {
  const { data } = usePools();
  const fromList = id ? findPool(data ?? CATALOG, id) ?? findPool(CATALOG, id) : undefined;
  const extra = useQuery({
    queryKey: ["perch-pool", id],
    queryFn: () => getPoolById({ data: id! }),
    enabled: Boolean(id) && !fromList,
    staleTime: 20_000,
  });
  return fromList ?? extra.data ?? undefined;
}
