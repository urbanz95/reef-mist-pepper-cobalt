CREATE TABLE IF NOT EXISTS degen_heartbeat (id integer PRIMARY KEY, at bigint NOT NULL);
CREATE TABLE IF NOT EXISTS degen_execution (
  vault text PRIMARY KEY REFERENCES degen_vaults(vault),
  policy_json text NOT NULL,
  reason text NOT NULL DEFAULT 'Awaiting observation',
  value_eth double precision,
  valued_at bigint,
  pending_hash text,
  pending_json text,
  last_error text,
  updated_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS degen_lease (
  id integer PRIMARY KEY,
  holder text NOT NULL,
  expires_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS degen_auth_used (
  signature text PRIMARY KEY,
  used_at bigint NOT NULL
);
