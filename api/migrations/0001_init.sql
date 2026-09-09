-- modelbench: initial schema
-- Run once against the Supabase Postgres connection (SQL editor, or `psql
-- "$DATABASE_URL" -f api/migrations/0001_init.sql`).
--
-- user_id/org_id columns are nullable and unenforced today (no RLS). They
-- exist so that turning on Supabase Auth later is a backfill + policy
-- addition, not a schema rewrite. Never add columns for resolved API keys or
-- base URLs here -- only env var *names* are stored; credentials are always
-- resolved from process env at request time.

create extension if not exists pgcrypto;  -- for gen_random_uuid()

create table if not exists bench_models (
    id              uuid primary key default gen_random_uuid(),
    alias           text not null,
    model           text not null,
    route           text not null default 'openrouter',
    enabled         boolean not null default true,
    tags            text[] not null default '{}',
    base_url_env    text not null default '',
    api_key_env     text not null default '',
    region          text not null default '',
    deployment_type text not null default '',
    temperature     numeric not null default 0.2,
    top_p           numeric,
    max_tokens      integer not null default 1024,
    seed            integer,
    timeout_s       integer not null default 120,
    notes           text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    user_id         uuid,
    org_id          uuid,
    unique (alias)
);

create table if not exists bench_settings (
    id          uuid primary key default gen_random_uuid(),
    name        text not null default 'default',
    payload     jsonb not null,
    updated_at  timestamptz not null default now(),
    user_id     uuid,
    org_id      uuid,
    unique (name)
);

create table if not exists bench_runs (
    run_id            text primary key,
    status            text not null default 'pending'
                      check (status in ('pending','running','completed','failed','cancelled')),
    created_at        timestamptz not null default now(),
    started_at        timestamptz,
    finished_at       timestamptz,
    model_ids         text[] not null default '{}',
    pack_names        text[] not null default '{}',
    repeats           integer,
    mock              boolean not null default false,
    settings_snapshot jsonb,
    total_calls       integer,
    calls_done        integer not null default 0,
    spend_usd         numeric not null default 0,
    max_spend_usd     numeric,
    error_message     text,
    result_path       text,
    summary_json      jsonb,
    user_id           uuid,
    org_id            uuid
);

create index if not exists bench_runs_created_at_idx on bench_runs (created_at desc);
