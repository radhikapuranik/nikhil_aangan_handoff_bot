-- Aangan phone agent: call log and cost ledger.
-- Run in the Supabase SQL editor (or `supabase db push`).

create extension if not exists pgcrypto;

create table if not exists calls (
  id                 uuid primary key default gen_random_uuid(),
  provider_call_id   text unique,                 -- Vaani's call id; makes webhook retries idempotent
  channel            text not null default 'phone' check (channel in ('phone')),
  started_at         timestamptz not null,
  ended_at           timestamptz,
  duration_sec       integer,
  answer_latency_ms  integer,                     -- ring to answer; the core metric
  after_hours        boolean not null default false,  -- outside 10:00-19:00 IST
  caller_phone       text,
  caller_name        text,
  transcript         jsonb not null default '[]',  -- [{speaker, text, at}]
  facts              jsonb,                        -- extracted CallFacts
  checks             jsonb,                        -- {c1..c5: pass|fail|unclear}
  verdict            text not null default 'in_progress'
    check (verdict in ('in_progress','qualified','declined','deferred','escalated','abandoned')),
  reasons            text[] not null default '{}',
  flags              text[] not null default '{}', -- uncertainty passed to the designer
  pricing_asked      boolean not null default false,
  handoff_status     text not null default 'not_applicable'
    check (handoff_status in ('not_applicable','pending','sent','failed','escalation_pending','escalation_done')),
  handoff_sent_at    timestamptz,
  booking_status     text not null default 'not_applicable'
    check (booking_status in ('not_applicable','offered','booked','declined_by_caller','failed')),
  booking_time       timestamptz,
  booking_ref        text,                         -- Cal.com booking uid
  crm_status         text not null default 'not_applicable'
    check (crm_status in ('not_applicable','pending','created','failed')),
  crm_deal_id        text,                         -- HubSpot deal id
  created_at         timestamptz not null default now()
);

create index if not exists calls_started_at_idx on calls (started_at desc);
create index if not exists calls_verdict_idx on calls (verdict);

-- One row per billable event, so any call's cost can be itemised.
create table if not exists call_costs (
  id           uuid primary key default gen_random_uuid(),
  call_id      uuid not null references calls(id) on delete cascade,
  service      text not null,                      -- vaani | gemini | calcom | telegram | hubspot
  units        numeric not null,
  unit         text not null,                      -- minute | input_token | output_token | request
  cost_inr     numeric,                            -- null = rate unknown, never silently zero
  rate_note    text,
  created_at   timestamptz not null default now()
);

create index if not exists call_costs_call_idx on call_costs (call_id);

-- Monthly charges not tied to a single call (phone number rental, plan fees).
create table if not exists fixed_costs (
  id           uuid primary key default gen_random_uuid(),
  service      text not null,
  description  text,
  monthly_inr  numeric,                            -- null = unknown
  active_from  date not null,
  active_to    date
);

-- Only the server (service-role key) touches these. No public policies.
alter table calls       enable row level security;
alter table call_costs  enable row level security;
alter table fixed_costs enable row level security;
