"""
DB-backed equivalent of bench.registry.load_registry().

Reads bench_models rows instead of config/models.yaml, but resolves
credentials from process env and enriches from the live catalogue exactly
the way load_registry() does -- by calling straight into
bench.registry._fetch_openrouter_catalogue / _enrich, unmodified. Nothing
about model pricing/vendor/capability discovery is reimplemented here.

Never store or return a resolved api_key/base_url from the DB -- those columns
don't exist in bench_models on purpose; base_url_env/api_key_env only name
which env var to read, same contract as models.yaml today.
"""
from __future__ import annotations

import os

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from bench.registry import ANTHROPIC_BASE, OPENROUTER_BASE, ModelSpec, _enrich, _fetch_openrouter_catalogue

from .. import orm


async def load_registry_from_db(
    db: AsyncSession,
    only: list[str] | None = None,
    include_disabled: bool = False,
    user_id: str | None = None,
) -> list[ModelSpec]:
    stmt = select(orm.BenchModel)
    # `user_id` is unused today (every row is unowned); wired so scoping to a
    # caller later is a WHERE-clause addition, not an API-shape change.
    if user_id is not None:
        stmt = stmt.where(orm.BenchModel.user_id == user_id)
    rows = (await db.execute(stmt)).scalars().all()

    or_key = os.getenv("OPENROUTER_API_KEY", "")
    catalogue = _fetch_openrouter_catalogue(or_key)

    specs: list[ModelSpec] = []
    for row in rows:
        if only and row.alias not in only:
            continue
        if not row.enabled and not include_disabled and not (only and row.alias in only):
            continue

        spec = ModelSpec(
            id=row.alias,
            model=row.model,
            route=row.route,
            enabled=row.enabled,
            tags=list(row.tags or []),
            base_url_env=row.base_url_env,
            api_key_env=row.api_key_env,
            region=row.region,
            deployment_type=row.deployment_type,
            aws_access_key_id_env=row.aws_access_key_id_env,
            aws_secret_access_key_env=row.aws_secret_access_key_env,
            aws_session_token_env=row.aws_session_token_env,
            temperature=float(row.temperature),
            top_p=float(row.top_p) if row.top_p is not None else None,
            max_tokens=row.max_tokens,
            seed=row.seed,
            timeout_s=row.timeout_s,
        )

        if spec.route == "openrouter":
            spec.base_url = OPENROUTER_BASE
            spec.api_key = or_key
        elif spec.route == "anthropic":
            # No base_url_env required -- there's only one Anthropic API,
            # mirrors bench.registry.load_registry()'s anthropic branch.
            spec.base_url = (os.getenv(spec.base_url_env, "").rstrip("/") if spec.base_url_env else "") or ANTHROPIC_BASE
            spec.api_key = os.getenv(spec.api_key_env or "ANTHROPIC_API_KEY", "")
        elif spec.route == "bedrock":
            # Three credential parts, not a bearer token -- mirrors
            # bench.registry.load_registry()'s bedrock branch.
            spec.aws_access_key_id = os.getenv(spec.aws_access_key_id_env, "")
            spec.aws_secret_access_key = os.getenv(spec.aws_secret_access_key_env, "")
            spec.aws_session_token = os.getenv(spec.aws_session_token_env, "") if spec.aws_session_token_env else ""
        else:
            spec.base_url = os.getenv(spec.base_url_env, "").rstrip("/")
            spec.api_key = os.getenv(spec.api_key_env, "")

        specs.append(_enrich(spec, catalogue))

    return specs
