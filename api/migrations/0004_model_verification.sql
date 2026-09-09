-- Real credential verification, distinct from is_ready (which only checks
-- that a base_url + api_key resolved to non-empty strings, not that the key
-- actually works). Populated on-demand by POST /models/{id}/verify and
-- POST /models/verify-all -- never automatically on every models list load,
-- so opening the Models page never itself spends a request against every
-- configured provider.
alter table bench_models add column if not exists verified_ok boolean;
alter table bench_models add column if not exists verified_at timestamptz;
alter table bench_models add column if not exists verified_message text;
