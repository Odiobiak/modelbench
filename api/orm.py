"""
SQLAlchemy models mirroring api/migrations/0001_init.sql.

Kept intentionally close to the raw column list in that file -- this module
is the ORM mapping, not a place to add business logic.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import ARRAY, Boolean, DateTime, Integer, Numeric, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


class BenchModel(Base):
    __tablename__ = "bench_models"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    alias: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    model: Mapped[str] = mapped_column(String, nullable=False)
    route: Mapped[str] = mapped_column(String, nullable=False, default="openrouter")
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    tags: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False, default=list)
    base_url_env: Mapped[str] = mapped_column(String, nullable=False, default="")
    api_key_env: Mapped[str] = mapped_column(String, nullable=False, default="")
    region: Mapped[str] = mapped_column(String, nullable=False, default="")
    deployment_type: Mapped[str] = mapped_column(String, nullable=False, default="")
    temperature: Mapped[float] = mapped_column(Numeric, nullable=False, default=0.2)
    top_p: Mapped[float | None] = mapped_column(Numeric, nullable=True)
    max_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=1024)
    seed: Mapped[int | None] = mapped_column(Integer, nullable=True)
    timeout_s: Mapped[int] = mapped_column(Integer, nullable=False, default=120)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    # route: bedrock only -- SigV4 needs an access key + secret + region
    # (region reuses the column above), not a single bearer token.
    aws_access_key_id_env: Mapped[str] = mapped_column(String, nullable=False, default="")
    aws_secret_access_key_env: Mapped[str] = mapped_column(String, nullable=False, default="")
    aws_session_token_env: Mapped[str] = mapped_column(String, nullable=False, default="")
    # Real credential verification -- distinct from is_ready (a resolved
    # ModelSpec property, never stored: bool(base_url and api_key), which is
    # a non-empty-string check, not proof the key works). These three are
    # populated on-demand by POST /models/{id}/verify, never automatically.
    verified_ok: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    verified_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    org_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)


class BenchSettings(Base):
    __tablename__ = "bench_settings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String, unique=True, nullable=False, default="default")
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    org_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)


class BenchPack(Base):
    __tablename__ = "bench_packs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    version: Mapped[str] = mapped_column(String, nullable=False, default="1")
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    system: Mapped[str] = mapped_column(Text, nullable=False, default="")
    tools: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    judge_defaults: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    org_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)


class BenchCase(Base):
    __tablename__ = "bench_cases"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    pack_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    case_key: Mapped[str] = mapped_column(String, nullable=False)
    messages: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    system: Mapped[str | None] = mapped_column(Text, nullable=True)
    tools: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    response_format: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    max_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    assertions: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    reference: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    judge: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    tags: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False, default=list)
    difficulty: Mapped[str] = mapped_column(String, nullable=False, default="medium")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    org_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)


class BenchRun(Base):
    __tablename__ = "bench_runs"

    run_id: Mapped[str] = mapped_column(String, primary_key=True)
    status: Mapped[str] = mapped_column(String, nullable=False, default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    model_ids: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False, default=list)
    pack_names: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False, default=list)
    case_keys: Mapped[list[str] | None] = mapped_column(ARRAY(String), nullable=True)
    repeats: Mapped[int | None] = mapped_column(Integer, nullable=True)
    mock: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    settings_snapshot: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    total_calls: Mapped[int | None] = mapped_column(Integer, nullable=True)
    calls_done: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    spend_usd: Mapped[float] = mapped_column(Numeric, nullable=False, default=0)
    max_spend_usd: Mapped[float | None] = mapped_column(Numeric, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    result_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    summary_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    excluded_from_baseline: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    org_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)


class BenchCaseOverride(Base):
    """A correction to one case-level metric row, addressed by the RunRecord's
    own `record_id` (bench/schema.py). Never mutates results/run_*.parquet --
    the API layer merges this onto the read-side DataFrame per request, so
    the Parquet file stays the untouched raw measurement (see api/overrides.py)."""
    __tablename__ = "bench_case_overrides"

    run_id: Mapped[str] = mapped_column(String, primary_key=True)
    record_id: Mapped[str] = mapped_column(String, primary_key=True)
    passed_override: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    note: Mapped[str] = mapped_column(Text, nullable=False)
    edited_by: Mapped[str | None] = mapped_column(String, nullable=True)
    edited_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
