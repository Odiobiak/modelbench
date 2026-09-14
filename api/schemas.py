"""
Pydantic request/response models for the API layer.

Field lists deliberately mirror bench.registry.ModelSpec's config-time fields
(everything above the "resolved at load time" / "enriched from the catalogue"
comment in bench/registry.py) -- those two groups are never accepted from the
client and never stored; they're recomputed per-request in registry_db.py.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


# ---- models -----------------------------------------------------------

class ModelIn(BaseModel):
    alias: str = Field(..., description="Unique short id, e.g. 'gpt-4.1-nano'")
    model: str = Field(..., description="Vendor/slug as sent to the API, e.g. 'openai/gpt-4.1-nano'")
    route: Literal["openrouter", "direct", "anthropic", "bedrock"] = "openrouter"
    enabled: bool = True
    tags: list[str] = Field(default_factory=list)
    base_url_env: str = ""
    api_key_env: str = ""
    region: str = ""
    deployment_type: str = ""
    aws_access_key_id_env: str = Field("", description="route=bedrock only, e.g. 'AWS_ACCESS_KEY_ID'")
    aws_secret_access_key_env: str = Field("", description="route=bedrock only, e.g. 'AWS_SECRET_ACCESS_KEY'")
    aws_session_token_env: str = Field("", description="route=bedrock only, optional -- blank if no session token")
    temperature: float = 0.2
    send_temperature: bool = Field(True, description="Off for a model that rejects the temperature parameter outright (some newer reasoning-tier models do)")
    top_p: float | None = None
    max_tokens: int = 1024
    seed: int | None = None
    timeout_s: int = 120
    notes: str | None = None


class ModelBulkIn(BaseModel):
    models: list[ModelIn] = Field(..., min_length=1)


class DiscoverRequest(BaseModel):
    route: Literal["openrouter", "direct", "anthropic", "bedrock"] = "direct"
    base_url_env: str = Field("", description="Required for route=direct, e.g. 'OPENAI_BASE'")
    api_key_env: str = Field("", description="Required for route=direct or route=anthropic, e.g. 'OPENAI_API_KEY'")
    region: str = Field("", description="Required for route=bedrock, e.g. 'us-east-1'")
    aws_access_key_id_env: str = Field("", description="Required for route=bedrock")
    aws_secret_access_key_env: str = Field("", description="Required for route=bedrock")


class DiscoverCandidate(BaseModel):
    model: str = Field(..., description="Raw model id/slug as the provider names it")
    likely_chat: bool = Field(..., description="Name-pattern guess -- always a candidate for review, never auto-added")


class DiscoverOut(BaseModel):
    route: str
    base_url: str
    candidates: list[DiscoverCandidate]


class ModelUpdate(BaseModel):
    """All fields optional -- PATCH-style partial update."""
    alias: str | None = None
    model: str | None = None
    route: Literal["openrouter", "direct", "anthropic", "bedrock"] | None = None
    enabled: bool | None = None
    tags: list[str] | None = None
    base_url_env: str | None = None
    api_key_env: str | None = None
    region: str | None = None
    deployment_type: str | None = None
    aws_access_key_id_env: str | None = None
    aws_secret_access_key_env: str | None = None
    aws_session_token_env: str | None = None
    temperature: float | None = None
    send_temperature: bool | None = None
    top_p: float | None = None
    max_tokens: int | None = None
    seed: int | None = None
    timeout_s: int | None = None
    notes: str | None = None


class ModelOut(ModelIn):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    created_at: datetime
    updated_at: datetime

    # live-resolved, not stored -- populated by the router, not the ORM row
    is_ready: bool | None = None
    vendor: str | None = None
    canonical_id: str | None = None
    context_window: int | None = None
    supports_tools: bool | None = None
    price_input_per_mtok: float | None = None
    price_output_per_mtok: float | None = None

    # stored, on-demand -- see bench.verify.verify_credentials
    verified_ok: bool | None = None
    verified_at: datetime | None = None
    verified_message: str | None = None


class VerifyOut(BaseModel):
    alias: str
    verified_ok: bool
    verified_at: datetime
    verified_message: str


# ---- settings -----------------------------------------------------------

class RunSettings(BaseModel):
    repeats: int = 3
    concurrency: int = 6
    retry_attempts: int = 2
    retry_backoff_s: float = 2.0
    max_spend_usd: float = 5.00


class JudgeSettings(BaseModel):
    enabled: bool = True
    model: str = "anthropic/claude-sonnet-4.6"
    route: str = "openrouter"
    temperature: float = 0.0
    max_tokens: int = 512
    calibration_sample_rate: float = 0.10


class ReportSettings(BaseModel):
    title: str = "Text Model Bench"
    percentiles: list[int] = Field(default_factory=lambda: [50, 90, 95, 99])


class SettingsPayload(BaseModel):
    """Mirrors config/settings.yaml exactly -- `thresholds` stays a free-form
    dict since it's an open-ended set of scorecard-coloring bands, not a
    fixed schema."""
    run: RunSettings = Field(default_factory=RunSettings)
    judge: JudgeSettings = Field(default_factory=JudgeSettings)
    thresholds: dict[str, float] = Field(default_factory=dict)
    report: ReportSettings = Field(default_factory=ReportSettings)


class SettingsOut(BaseModel):
    name: str
    payload: SettingsPayload
    updated_at: datetime


# ---- suites/packs ---------------------------------------------------------

class PackOut(BaseModel):
    name: str
    description: str = ""
    case_count: int
    tags: list[str]
    difficulties: list[str]


class PackCreate(BaseModel):
    name: str = Field(..., description="e.g. '10_billing_edge_cases'")
    description: str = Field("", description="What this pack contains and, if applicable, where it's sourced from")
    version: str = "1"
    system: str = ""
    tools: list[dict] = Field(default_factory=list)
    judge_defaults: dict = Field(default_factory=dict)


# The guided-builder check types the UI exposes -- a 1:1 subset of
# bench.scorers.deterministic.ASSERTIONS chosen to not require knowing the
# engine's assertion vocabulary. `metric` is never asked for here; the
# scorer already defaults it to `type` when absent (deterministic.py
# run_deterministic: `name = a.get("metric", kind)`).
CHECK_TYPES = {"contains", "not_contains_any", "regex", "max_words", "max_sentences", "is_json"}


class CaseCheck(BaseModel):
    type: Literal["contains", "not_contains_any", "regex", "max_words", "max_sentences", "is_json"]
    value: Any = None


class CaseTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class JudgeCriterion(BaseModel):
    name: str = Field(..., description="Short label, e.g. 'tone' or 'accuracy' -- becomes the score's column name")
    description: str = Field(..., description="Plain-English pass criteria for this one dimension")


class CaseIn(BaseModel):
    case_key: str | None = Field(None, description="Falls back to a slug of the first turn if omitted")
    turns: list[CaseTurn] = Field(..., min_length=1)
    system: str | None = None
    tags: list[str] = Field(default_factory=list)
    difficulty: Literal["easy", "medium", "hard"] = "medium"
    checks: list[CaseCheck] = Field(default_factory=list)
    judge_criteria: list[JudgeCriterion] = Field(
        default_factory=list,
        description="One or more named dimensions scored by the pinned judge model, each graded independently",
    )


class CaseOut(BaseModel):
    id: uuid.UUID
    pack: str
    case_key: str
    messages: list[dict[str, Any]]
    system: str | None
    tags: list[str]
    difficulty: str
    assertions: list[dict[str, Any]]
    judge: dict[str, Any]
    reference: dict[str, Any] = Field(default_factory=dict, description="Provenance/citation, e.g. {'source': 'Hugging Face -- cais/mmlu', 'note': '...'}")
    created_at: datetime


# ---- runs -----------------------------------------------------------------

class RunLaunchRequest(BaseModel):
    model_ids: list[str] = Field(..., min_length=1)
    pack_names: list[str] = Field(..., min_length=1)
    case_keys: list[str] | None = Field(
        None, description="Restrict to these case ids within pack_names. Omit/null to run every case in those packs."
    )
    repeats: int | None = None
    mock: bool = False
    no_judge: bool = False


class RunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    run_id: str
    status: str
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    model_ids: list[str]
    pack_names: list[str]
    case_keys: list[str] | None = None
    repeats: int | None
    mock: bool
    total_calls: int | None
    calls_done: int
    spend_usd: float
    max_spend_usd: float | None
    error_message: str | None
    result_path: str | None
    note: str | None = None
    excluded_from_baseline: bool = False


class RunAnnotationUpdate(BaseModel):
    """All fields optional -- PATCH-style partial update."""
    note: str | None = None
    excluded_from_baseline: bool | None = None


class RunResultsOut(BaseModel):
    run_id: str
    status: str
    summary: list[dict[str, Any]]


class RunCompareOut(BaseModel):
    """One run's identity + per-model summary, for the Runs page's
    multi-select "compare" view. `summary` is empty for a run that hasn't
    completed -- there's nothing to chart yet, not an error."""
    run_id: str
    status: str
    created_at: datetime
    model_ids: list[str]
    pack_names: list[str]
    note: str | None = None
    summary: list[dict[str, Any]] = Field(default_factory=list)


class RunCaseOut(BaseModel):
    """One (case x model x repeat) row from the run's own parquet file --
    the raw data behind the aggregate summary, for the Run Detail page's
    case browser and output/diff view. `passed` is always the raw measured
    verdict -- never overwritten -- so a correction never silently changes
    what this field means; `passed_override`/`override_note` carry the
    correction alongside it (see api/overrides.py)."""
    record_id: str
    case_key: str
    pack: str
    model_alias: str
    repeat_index: int
    ok: bool
    passed: bool | None
    error_type: str
    response_text: str
    ttft_ms: float | None
    total_latency_ms: float | None
    ts_utc: str
    tags: str
    difficulty: str
    passed_override: bool | None = None
    override_note: str | None = None

    # Captured on every call but previously dropped at this boundary -- the
    # Run Detail page's per-row "Details" drawer is the first consumer.
    vendor: str = ""
    model_served: str = ""
    finish_reason: str = ""
    prompt_tokens: int | None = None
    cached_prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None
    cost_total_usd: float | None = None
    retry_count: int = 0
    rate_limited: bool = False
    error_message: str = ""
    judge_model: str = ""
    scores_json: str = "{}"
    failed_assertions: str = ""
    # The judge's own call is a separate measured, billable call -- see
    # bench/schema.py's judge_cost_usd for why it isn't folded into
    # cost_total_usd/total_latency_ms above (those describe the model
    # under test's call).
    judge_cost_usd: float | None = None
    judge_ttft_ms: float | None = None
    judge_total_latency_ms: float | None = None
    judge_prompt_tokens: int | None = None
    judge_completion_tokens: int | None = None


class CaseOverrideIn(BaseModel):
    passed_override: bool | None = None
    note: str = Field(..., min_length=1, description="Why this row is being corrected")
    edited_by: str | None = None


class CaseOverrideOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    run_id: str
    record_id: str
    passed_override: bool | None
    note: str
    edited_by: str | None
    edited_at: datetime


class EstimateRequest(BaseModel):
    model_ids: list[str] = Field(..., min_length=1)
    pack_names: list[str] = Field(..., min_length=1)
    case_keys: list[str] | None = None
    repeats: int | None = None


class EstimateOut(BaseModel):
    total_usd: float
    per_model: dict[str, float]
    ceiling_usd: float
    exceeds_ceiling: bool
