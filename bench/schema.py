"""
The result record.

One RunRecord per (model x case x repeat). This schema is deliberately
wide: the whole point is that a row written today is still interpretable
and comparable in eighteen months, after vendors have silently changed
models behind stable aliases and rewritten their price lists twice.

Rule of thumb applied here: if a fact could change without you noticing,
it gets stamped onto every row rather than looked up later.
"""

from __future__ import annotations

import platform
import sys
from dataclasses import dataclass, field, asdict, fields
from datetime import datetime, timezone
from typing import Any

HARNESS_VERSION = "1.0.0"


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class RunRecord:
    # ── identity of this row ──────────────────────────────────────────
    run_id: str = ""                    # groups every row from one `bench run`
    record_id: str = ""                 # unique per row
    ts_utc: str = field(default_factory=_utcnow)

    # ── VENDOR + MODEL PROVENANCE ─────────────────────────────────────
    # This block is the answer to "which model actually served this?"
    # Never trust the alias you asked for.
    model_alias: str = ""               # your name for it, from models.yaml
    model_requested: str = ""           # exactly what you sent, e.g. openai/gpt-4.1-nano
    model_served: str = ""              # what the API said it used
    model_canonical_id: str = ""        # gateway catalogue id
    vendor: str = ""                    # openai, anthropic, google, deepseek...
    served_by_provider: str = ""        # which upstream actually ran it (OpenRouter routes!)
    model_family: str = ""              # gpt-4.1, claude-4.5, gemini-3
    model_version_string: str = ""      # provider-reported version, if any
    is_open_weight: bool | None = None

    # ── MODEL CAPABILITY METADATA (from catalogue, snapshotted) ───────
    context_window: int | None = None
    max_output_tokens: int | None = None
    supports_tools: bool | None = None
    supports_json_mode: bool | None = None
    supports_reasoning: bool | None = None
    supports_prompt_caching: bool | None = None
    input_modalities: str = ""          # comma-joined
    tokenizer: str = ""
    knowledge_cutoff: str = ""

    # ── PRICING SNAPSHOT (as of this run, not as of when you read it) ─
    price_input_per_mtok: float | None = None
    price_cached_input_per_mtok: float | None = None
    price_output_per_mtok: float | None = None
    price_reasoning_per_mtok: float | None = None
    pricing_captured_at: str = ""

    # ── ROUTING / DEPLOYMENT ──────────────────────────────────────────
    route: str = ""                     # openrouter | direct
    endpoint_base_url: str = ""
    region: str = ""
    deployment_type: str = ""           # standard | data-zone | global | n/a
    tags: str = ""                      # comma-joined from models.yaml

    # ── REQUEST PARAMETERS (so a result is reproducible) ──────────────
    temperature: float | None = None
    top_p: float | None = None
    max_tokens_requested: int | None = None
    seed: int | None = None
    system_prompt_sha: str = ""         # hash, not the text, keeps rows small
    tools_offered: int = 0
    stream: bool = True

    # ── TEST CASE PROVENANCE ──────────────────────────────────────────
    suite_pack: str = ""                # e.g. 02_tool_calling
    suite_version: str = ""             # bump when you edit a pack
    case_id: str = ""
    case_tags: str = ""
    difficulty: str = ""                # easy | medium | hard
    repeat_index: int = 0
    turn_count: int = 1                 # >1 for multi-turn cases

    # ── LATENCY (milliseconds) ────────────────────────────────────────
    ttft_ms: float | None = None        # time to first token; the one that matters
    total_latency_ms: float | None = None
    tpot_ms: float | None = None        # mean time per output token after the first
    tokens_per_second: float | None = None
    queue_or_retry_ms: float | None = None
    # True only when the call went straight to the vendor (route: direct), so the
    # number carries no gateway hop and may be quoted as absolute. Gateway-routed
    # latency is valid for RANKING models against each other and nothing else.
    latency_authoritative: bool = False
    latency_probe: bool = False         # marks rows from `bench latency`

    # ── TOKENS ────────────────────────────────────────────────────────
    prompt_tokens: int | None = None
    cached_prompt_tokens: int | None = None      # cache skews cost, track separately
    completion_tokens: int | None = None
    reasoning_tokens: int | None = None          # priced differently on many models
    total_tokens: int | None = None
    cache_hit_ratio: float | None = None

    # ── COST (USD, computed from the snapshotted prices above) ────────
    cost_input_usd: float | None = None
    cost_cached_usd: float | None = None
    cost_output_usd: float | None = None
    cost_total_usd: float | None = None
    cost_source: str = ""               # "gateway_reported" | "computed_from_catalogue"

    # ── RELIABILITY ───────────────────────────────────────────────────
    http_status: int | None = None
    ok: bool = False
    error_type: str = ""
    error_message: str = ""
    retry_count: int = 0
    rate_limited: bool = False          # a throttled model looks slow; flag it

    # ── OUTPUT ────────────────────────────────────────────────────────
    response_text: str = ""
    tool_calls_json: str = ""
    finish_reason: str = ""

    # ── SCORES (populated by scorers) ─────────────────────────────────
    passed: bool | None = None          # the case-level verdict
    scores_json: str = "{}"             # {metric_name: value}
    failed_assertions: str = ""         # comma-joined names, for fast triage
    judge_model: str = ""
    judge_model_version: str = ""
    judge_raw_json: str = ""
    flagged_for_calibration: bool = False

    # ── RUNTIME ENVIRONMENT ───────────────────────────────────────────
    harness_version: str = HARNESS_VERSION
    python_version: str = field(default_factory=lambda: sys.version.split()[0])
    runner_host: str = field(default_factory=platform.node)
    runner_os: str = field(default_factory=lambda: f"{platform.system()} {platform.release()}")
    ci: bool = False                    # True when running in GitHub Actions
    git_sha: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def column_names(cls) -> list[str]:
        return [f.name for f in fields(cls)]


# Columns that are safe to show in a terse console table.
CONSOLE_COLUMNS = [
    "model_alias", "suite_pack", "case_id", "repeat_index",
    "ok", "passed", "ttft_ms", "total_latency_ms",
    "total_tokens", "cost_total_usd",
]
