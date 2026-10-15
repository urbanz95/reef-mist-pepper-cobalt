import type { Sql } from "./db";
// Database clock, atomic compare-and-set: shared by all serverless instances.
export async function acquireLease(sql: Sql, holder: string) {
  const rows = await sql.query(
    `INSERT INTO degen_lease (id,holder,expires_at)
    VALUES (1,$1,(extract(epoch from clock_timestamp())*1000)::bigint+120000)
    ON CONFLICT (id) DO UPDATE SET holder=excluded.holder, expires_at=excluded.expires_at
    WHERE degen_lease.expires_at < (extract(epoch from clock_timestamp())*1000)::bigint
    RETURNING holder`,
    [holder],
  );
  return rows.length === 1;
}
export async function renewLease(sql: Sql, holder: string) {
  const rows = await sql.query(
    `UPDATE degen_lease SET expires_at=(extract(epoch from clock_timestamp())*1000)::bigint+120000
    WHERE id=1 AND holder=$1 AND expires_at>(extract(epoch from clock_timestamp())*1000)::bigint RETURNING holder`,
    [holder],
  );
  if (!rows.length) throw new Error("Keeper lease expired; transaction not sent");
}
export async function releaseLease(sql: Sql, holder: string) {
  await sql.query("DELETE FROM degen_lease WHERE id=1 AND holder=$1", [holder]);
}
