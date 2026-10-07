-- The voice platform calls our server once per caller turn, possibly from a
-- stateless function, so the in-call state lives in the database.
alter table calls add column if not exists session_state jsonb;

-- Every webhook delivery is stored once. Vaani retries failed deliveries up
-- to 8 times and says to de-duplicate on the envelope id (evt_...).
create table if not exists provider_events (
  id           text primary key,
  provider     text not null default 'vaani',
  type         text not null,
  payload      jsonb not null,
  received_at  timestamptz not null default now()
);
alter table provider_events enable row level security;
