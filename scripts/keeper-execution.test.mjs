import { it } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { acquireLease, renewLease, releaseLease } from "../src/lib/keeper-execution.ts";
it("database lease serializes instances, fences an expired holder and survives stale release", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(readFileSync(new URL("../migrations/0002_degen.sql", import.meta.url), "utf8"));
    await pg.exec(
      readFileSync(new URL("../migrations/0003_degen_safety.sql", import.meta.url), "utf8"),
    );
    const sql = { query: async (q, p = []) => (await pg.query(q, p)).rows };
    const outcomes = await Promise.all(["one", "two", "three"].map((h) => acquireLease(sql, h)));
    assert.equal(outcomes.filter(Boolean).length, 1);
    const winner = ["one", "two", "three"][outcomes.indexOf(true)];
    await renewLease(sql, winner);
    await assert.rejects(renewLease(sql, "intruder"));
    await pg.exec("UPDATE degen_lease SET expires_at=0");
    assert.equal(await acquireLease(sql, "replacement"), true);
    await assert.rejects(renewLease(sql, winner));
    await releaseLease(sql, winner);
    assert.equal(await acquireLease(sql, "late"), false);
    await releaseLease(sql, "replacement");
    assert.equal(await acquireLease(sql, "late"), true);
  } finally {
    await pg.close();
  }
});
