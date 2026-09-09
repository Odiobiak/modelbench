-- route: bedrock credential fields. AWS SigV4 needs an access key + secret
-- + region, not a single bearer token like every other direct provider
-- here -- `region` already exists (added for the Azure example) and is
-- reused as-is; these three name the env vars holding the rest.
alter table bench_models add column if not exists aws_access_key_id_env text not null default '';
alter table bench_models add column if not exists aws_secret_access_key_env text not null default '';
alter table bench_models add column if not exists aws_session_token_env text not null default '';
