-- A human-readable summary of what a pack actually contains, shown
-- prominently on the Test Cases page -- distinct from the per-case
-- `reference` field (bench_cases), which cites the specific source of one
-- case. This is pack-level: "what is this pack and where did it come from."
alter table bench_packs add column if not exists description text not null default '';
