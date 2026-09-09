-- Records which specific cases a run was scoped to, when launched via the
-- "run N selected cases" flow instead of whole packs. Null/empty means the
-- run covered every case in pack_names, same as every run before this column
-- existed.
alter table bench_runs add column if not exists case_keys text[];
