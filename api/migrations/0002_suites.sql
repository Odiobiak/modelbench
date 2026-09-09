-- modelbench: test-case authoring (packs + cases), replacing hand-edited
-- suites/*.yaml as the editable source for the UI.
--
-- assertions/judge/tools/reference are stored as jsonb in the exact shapes
-- bench.suites.Case and bench.scorers already consume, so the DB-backed
-- loader in api/adapters/suites_db.py builds Case objects with zero
-- translation beyond reading columns into fields.

create table if not exists bench_packs (
    id            uuid primary key default gen_random_uuid(),
    name          text not null,
    version       text not null default '1',
    system        text not null default '',
    tools         jsonb not null default '[]',
    judge_defaults jsonb not null default '{}',
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    user_id       uuid,
    org_id        uuid,
    unique (name)
);

create table if not exists bench_cases (
    id              uuid primary key default gen_random_uuid(),
    pack_id         uuid not null references bench_packs(id) on delete cascade,
    case_key        text not null,
    messages        jsonb not null default '[]',
    system          text,
    tools           jsonb,
    response_format jsonb,
    max_tokens      integer,
    assertions      jsonb not null default '[]',
    reference       jsonb not null default '{}',
    judge           jsonb not null default '{}',
    tags            text[] not null default '{}',
    difficulty      text not null default 'medium',
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    user_id         uuid,
    org_id          uuid,
    unique (pack_id, case_key)
);

create index if not exists bench_cases_pack_id_idx on bench_cases (pack_id);
