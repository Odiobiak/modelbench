-- Run-level annotation + baseline exclusion, so a known-bad run (a buggy
-- prompt, a provider outage) can stop poisoning detect_drift's median-of-4
-- baseline without deleting or rewriting its Parquet file.
alter table bench_runs add column if not exists note text;
alter table bench_runs add column if not exists excluded_from_baseline boolean not null default false;

-- Case-level metric corrections (e.g. a mis-scored judge verdict). This is
-- an overlay, never a rewrite of results/run_*.parquet: `record_id` is the
-- existing per-row unique id already stamped on every RunRecord, and the
-- API merges a matching override's passed_override onto the read-side
-- DataFrame per request -- the Parquet file stays the untouched raw record.
create table if not exists bench_case_overrides (
  run_id text not null,
  record_id text not null,
  passed_override boolean,
  note text not null,
  edited_by text,
  edited_at timestamptz not null default now(),
  primary key (run_id, record_id)
);
create index if not exists bench_case_overrides_run_id_idx on bench_case_overrides (run_id);
