-- Whether `temperature` should be sent at all for this model. Some models
-- (observed on Anthropic's direct API; OpenAI's reasoning-tier models do the
-- same) reject the parameter outright rather than ignoring it. Defaulting to
-- true preserves current behavior for every existing row; MeasuredClient
-- also learns this reactively per model id at runtime (see
-- MeasuredClient._omit_temperature in bench/client.py) for a model nobody
-- has flagged here yet.
alter table bench_models add column if not exists send_temperature boolean not null default true;
