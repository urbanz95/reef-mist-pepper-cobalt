create table if not exists degen_keeper (
  id integer primary key check (id = 1),
  private_key text not null
);

create table if not exists degen_vaults (
  vault text primary key,
  owner text not null,
  universe text not null default 'meme',
  hold_ms integer not null default 120000,
  active boolean not null default true,
  eth double precision not null default 0,
  current_pool_id text,
  challenger_id text,
  challenger_since bigint,
  last_tick bigint,
  entered_at bigint,
  hops_json text not null default '[]',
  updated_at bigint
);

create index if not exists degen_vaults_owner on degen_vaults (owner);
