from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from bench.registry import ANTHROPIC_BASE, ANTHROPIC_VERSION, OPENROUTER_BASE, _fetch_openrouter_catalogue, is_probably_chat_model
from bench.verify import verify_credentials

from .. import orm, schemas
from ..adapters.registry_db import load_registry_from_db
from ..db import get_db

router = APIRouter(prefix="/models", tags=["models"])
_VERIFY_CONCURRENCY = 5


def _spec_overlay(out: schemas.ModelOut, specs_by_id: dict) -> schemas.ModelOut:
    spec = specs_by_id.get(out.alias)
    if spec is not None:
        out.is_ready = spec.is_ready
        out.vendor = spec.vendor
        out.canonical_id = spec.canonical_id
        out.context_window = spec.context_window
        out.supports_tools = spec.supports_tools
        out.price_input_per_mtok = spec.price_input_per_mtok
        out.price_output_per_mtok = spec.price_output_per_mtok
    return out


@router.get("", response_model=list[schemas.ModelOut])
async def list_models(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(orm.BenchModel).order_by(orm.BenchModel.alias))).scalars().all()
    specs = await load_registry_from_db(db, include_disabled=True)
    specs_by_id = {s.id: s for s in specs}
    return [_spec_overlay(schemas.ModelOut.model_validate(r), specs_by_id) for r in rows]


@router.post("", response_model=schemas.ModelOut, status_code=201)
async def create_model(body: schemas.ModelIn, db: AsyncSession = Depends(get_db)):
    row = orm.BenchModel(**body.model_dump())
    db.add(row)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, f"A model with alias '{body.alias}' already exists")
    await db.refresh(row)
    return schemas.ModelOut.model_validate(row)


@router.post("/bulk", response_model=list[schemas.ModelOut], status_code=201)
async def create_models_bulk(body: schemas.ModelBulkIn, db: AsyncSession = Depends(get_db)):
    """Adds every model in one request -- what the Models page's
    'Discover models' checklist uses, so picking 20 candidates is one round
    trip instead of 20."""
    rows = [orm.BenchModel(**m.model_dump()) for m in body.models]
    db.add_all(rows)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, "One or more aliases already exist in the registry")
    for row in rows:
        await db.refresh(row)
    return [schemas.ModelOut.model_validate(r) for r in rows]


@router.post("/discover", response_model=schemas.DiscoverOut)
async def discover_models(body: schemas.DiscoverRequest):
    """Pulls the real, current model list from a provider you already have
    a key for -- so adding a model that dropped this morning doesn't mean
    typing its slug in by hand. Read-only: nothing here touches the
    registry. `likely_chat` is a name-pattern guess (bench.registry.
    is_probably_chat_model) meant to pre-sort a checklist, not to hide
    anything -- every candidate is returned either way."""
    if body.route == "openrouter":
        or_key = os.getenv("OPENROUTER_API_KEY", "")
        catalogue = await asyncio.to_thread(_fetch_openrouter_catalogue, or_key)
        if not catalogue:
            raise HTTPException(502, "OpenRouter catalogue unavailable (no key, or unreachable)")
        ids = sorted(catalogue.keys())
        return schemas.DiscoverOut(
            route="openrouter",
            base_url=OPENROUTER_BASE,
            candidates=[schemas.DiscoverCandidate(model=m, likely_chat=is_probably_chat_model(m)) for m in ids],
        )

    if body.route == "bedrock":
        if not body.region or not body.aws_access_key_id_env or not body.aws_secret_access_key_env:
            raise HTTPException(400, "route=bedrock requires region, aws_access_key_id_env and aws_secret_access_key_env")
        access_key = os.getenv(body.aws_access_key_id_env, "")
        secret_key = os.getenv(body.aws_secret_access_key_env, "")
        if not access_key:
            raise HTTPException(400, f"{body.aws_access_key_id_env} is not set in .env")
        if not secret_key:
            raise HTTPException(400, f"{body.aws_secret_access_key_env} is not set in .env")

        def _list_bedrock_models():
            import boto3
            client = boto3.client(
                "bedrock", region_name=body.region,
                aws_access_key_id=access_key, aws_secret_access_key=secret_key,
            )
            return client.list_foundation_models()

        try:
            resp = await asyncio.to_thread(_list_bedrock_models)
        except Exception as exc:
            raise HTTPException(502, f"Bedrock list_foundation_models failed: {type(exc).__name__}: {str(exc)[:200]}")

        ids = sorted(
            m["modelId"] for m in resp.get("modelSummaries", [])
            if "TEXT" in (m.get("outputModalities") or [])
            and "ON_DEMAND" in (m.get("inferenceTypesSupported") or [])
        )
        return schemas.DiscoverOut(
            route="bedrock",
            base_url=f"bedrock-runtime.{body.region}.amazonaws.com",
            candidates=[schemas.DiscoverCandidate(model=m, likely_chat=is_probably_chat_model(m)) for m in ids],
        )

    if body.route == "anthropic":
        # No base_url_env needed -- there's only one Anthropic API. api_key_env
        # defaults to ANTHROPIC_API_KEY so the drawer doesn't have to ask for it.
        api_key_env = body.api_key_env or "ANTHROPIC_API_KEY"
        api_key = os.getenv(api_key_env, "")
        if not api_key:
            raise HTTPException(400, f"{api_key_env} is not set in .env")
        base_url = os.getenv(body.base_url_env, "").rstrip("/") if body.base_url_env else ANTHROPIC_BASE
        headers = {"x-api-key": api_key, "anthropic-version": ANTHROPIC_VERSION}
    else:
        if not body.base_url_env or not body.api_key_env:
            raise HTTPException(400, "route=direct requires base_url_env and api_key_env")
        base_url = os.getenv(body.base_url_env, "").rstrip("/")
        api_key = os.getenv(body.api_key_env, "")
        if not base_url:
            raise HTTPException(400, f"{body.base_url_env} is not set in .env")
        if not api_key:
            raise HTTPException(400, f"{body.api_key_env} is not set in .env")
        headers = {"Authorization": f"Bearer {api_key}"}

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.get(f"{base_url}/models", headers=headers)
    except httpx.RequestError as exc:
        raise HTTPException(502, f"Could not reach {base_url}: {type(exc).__name__}")
    if r.status_code != 200:
        raise HTTPException(502, f"{base_url}/models returned HTTP {r.status_code}")

    ids = sorted(m["id"] for m in r.json().get("data", []) if "id" in m)
    return schemas.DiscoverOut(
        route=body.route,
        base_url=base_url,
        candidates=[schemas.DiscoverCandidate(model=m, likely_chat=is_probably_chat_model(m)) for m in ids],
    )


@router.patch("/{model_id}", response_model=schemas.ModelOut)
async def update_model(model_id: uuid.UUID, body: schemas.ModelUpdate, db: AsyncSession = Depends(get_db)):
    row = await db.get(orm.BenchModel, model_id)
    if row is None:
        raise HTTPException(404, "Model not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, f"A model with alias '{body.alias}' already exists")
    await db.refresh(row)
    return schemas.ModelOut.model_validate(row)


@router.delete("/{model_id}", status_code=204)
async def delete_model(model_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    row = await db.get(orm.BenchModel, model_id)
    if row is None:
        raise HTTPException(404, "Model not found")
    await db.delete(row)
    await db.commit()


def _stamp(row: orm.BenchModel, ok: bool, message: str, when: datetime) -> schemas.VerifyOut:
    row.verified_ok = ok
    row.verified_at = when
    row.verified_message = message
    return schemas.VerifyOut(alias=row.alias, verified_ok=ok, verified_at=when, verified_message=message)


@router.post("/{model_id}/verify", response_model=schemas.VerifyOut)
async def verify_model(model_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    """One cheap, zero-completion-token reachability check against the
    provider -- see bench.verify. On-demand only; never runs on a plain
    GET /models so opening the Models page never itself spends a request."""
    row = await db.get(orm.BenchModel, model_id)
    if row is None:
        raise HTTPException(404, "Model not found")

    specs = await load_registry_from_db(db, only=[row.alias], include_disabled=True)
    ok, message = ((False, "model not found in resolved registry") if not specs
                   else await verify_credentials(specs[0]))
    out = _stamp(row, ok, message, datetime.now(timezone.utc))
    await db.commit()
    return out


@router.post("/verify-all", response_model=list[schemas.VerifyOut])
async def verify_all_models(db: AsyncSession = Depends(get_db)):
    """Verifies every *enabled* model, bounded concurrency on the network
    calls only -- a deliberate bulk action, not something that runs on its
    own. A single AsyncSession isn't safe for concurrent statements, so the
    registry is loaded once up front and every row write happens
    sequentially after all the (concurrent, DB-free) provider checks finish,
    rather than interleaving DB access across the gathered coroutines."""
    rows = (await db.execute(select(orm.BenchModel).where(orm.BenchModel.enabled))).scalars().all()
    specs_by_alias = {s.id: s for s in await load_registry_from_db(db, only=[r.alias for r in rows], include_disabled=True)}

    sem = asyncio.Semaphore(_VERIFY_CONCURRENCY)

    async def check(row: orm.BenchModel) -> tuple[bool, str]:
        spec = specs_by_alias.get(row.alias)
        if spec is None:
            return False, "model not found in resolved registry"
        async with sem:
            return await verify_credentials(spec)

    checked = await asyncio.gather(*(check(r) for r in rows))
    now = datetime.now(timezone.utc)
    results = [_stamp(row, ok, message, now) for row, (ok, message) in zip(rows, checked)]
    await db.commit()
    return results
