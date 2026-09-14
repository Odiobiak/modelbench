"""
Model registry.

Reads config/models.yaml, then enriches every entry from the gateway's live
model catalogue so that vendor, pricing, context window and capability flags
are discovered rather than hand-maintained.

That enrichment is the reason adding a model is two lines: everything the
scorecard needs about the model is fetched, not typed.
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from typing import Any

import httpx
import yaml

OPENROUTER_BASE = "https://openrouter.ai/api/v1"
# Anthropic's Messages API is not OpenAI-compatible (x-api-key auth, /messages
# not /chat/completions, a different SSE event shape) -- client.py branches
# on route == "anthropic" to speak it natively. No _BASE env var needed since,
# unlike Azure/self-hosted OpenAI-compatible endpoints, there's only one.
ANTHROPIC_BASE = "https://api.anthropic.com/v1"
ANTHROPIC_VERSION = "2023-06-01"
_CATALOGUE_CACHE: dict[str, Any] = {}
_CATALOGUE_FETCHED_AT: float = 0.0
_CATALOGUE_TTL_S = 3600

DIRECT_PRICING_YAML = "config/direct_pricing.yaml"
_DIRECT_PRICING_CACHE: dict[str, dict[str, float]] | None = None


def _load_direct_pricing(path: str = DIRECT_PRICING_YAML) -> dict[str, dict[str, float]]:
    """Fallback pricing for routes with no catalogue API (anthropic, direct,
    bedrock) -- see config/direct_pricing.yaml's header for why this exists.
    Flattened to {model_slug: {input, output}} regardless of the file's
    per-vendor grouping, since lookup is by the exact model slug only,
    same key OpenRouter's catalogue uses."""
    global _DIRECT_PRICING_CACHE
    if _DIRECT_PRICING_CACHE is not None:
        return _DIRECT_PRICING_CACHE
    try:
        with open(path) as fh:
            raw = yaml.safe_load(fh) or {}
        flat: dict[str, dict[str, float]] = {}
        for vendor_block in raw.values():
            if isinstance(vendor_block, dict):
                flat.update(vendor_block)
        _DIRECT_PRICING_CACHE = flat
    except FileNotFoundError:
        _DIRECT_PRICING_CACHE = {}
    return _DIRECT_PRICING_CACHE

# Modality words, not naming conventions: a raw provider catalogue mixes text
# chat models in with audio/image/video/embedding/moderation endpoints that
# don't speak this harness's chat-completions request shape at all. This is
# intentionally loose -- it only has to narrow a "discover models" list down
# to plausible candidates for a human to review and pick from, never to
# auto-enable anything, so a false positive (an oddly-named chat model
# excluded) is far cheaper than a false negative would be if this fed
# anything automatically.
_NON_CHAT_PATTERNS = re.compile(
    r"(transcribe|[-_]tts\b|\btts[-_]|audio|realtime|whisper|moderation|sora|"
    r"embedding|[-_]image|video|computer-use|rerank)",
    re.IGNORECASE,
)
_KNOWN_NON_CHAT = {"babbage-002", "davinci-002"}


def is_probably_chat_model(model_id: str) -> bool:
    """Name-pattern heuristic: is this catalogue entry plausibly callable
    via a standard chat-completions request? Used only to pre-filter
    `discover` candidates -- see module docstring above."""
    name = model_id.rsplit("/", 1)[-1].lower()
    if name in _KNOWN_NON_CHAT:
        return False
    return not _NON_CHAT_PATTERNS.search(name)


@dataclass
class ModelSpec:
    """One benchmarkable target, fully resolved and ready to call."""
    id: str
    model: str
    route: str = "openrouter"
    enabled: bool = True
    tags: list[str] = field(default_factory=list)

    # direct-route only
    base_url_env: str = ""
    api_key_env: str = ""
    region: str = ""
    deployment_type: str = ""

    # route: bedrock only -- SigV4 needs an access key + secret + region, not
    # a single bearer token, so it gets its own env-var-name fields rather
    # than overloading api_key_env. `region` above is reused as-is.
    aws_access_key_id_env: str = ""
    aws_secret_access_key_env: str = ""
    aws_session_token_env: str = ""  # optional -- blank means no session token

    # request params
    temperature: float = 0.2
    # Newer models on some providers (observed on Anthropic's anthropic-route
    # API; OpenAI's reasoning-tier models do the same) reject `temperature`
    # outright rather than just ignoring it -- bench/client.py also learns
    # this reactively per model id on the first such 400 (see
    # MeasuredClient._omit_temperature), but this lets it be set up front for
    # a model you already know rejects it, instead of paying for one failed
    # call per run to find out.
    send_temperature: bool = True
    top_p: float | None = None
    max_tokens: int = 1024
    seed: int | None = None
    timeout_s: int = 120

    # resolved at load time
    base_url: str = ""
    api_key: str = ""
    aws_access_key_id: str = ""
    aws_secret_access_key: str = ""
    aws_session_token: str = ""

    # enriched from the catalogue
    vendor: str = ""
    canonical_id: str = ""
    model_family: str = ""
    context_window: int | None = None
    max_output_tokens: int | None = None
    supports_tools: bool | None = None
    supports_json_mode: bool | None = None
    supports_reasoning: bool | None = None
    supports_prompt_caching: bool | None = None
    input_modalities: list[str] = field(default_factory=list)
    tokenizer: str = ""
    is_open_weight: bool | None = None
    price_input_per_mtok: float | None = None
    price_cached_input_per_mtok: float | None = None
    price_output_per_mtok: float | None = None
    price_reasoning_per_mtok: float | None = None
    pricing_captured_at: str = ""

    @property
    def is_ready(self) -> bool:
        if self.route == "bedrock":
            return bool(self.region and self.aws_access_key_id and self.aws_secret_access_key)
        return bool(self.base_url and self.api_key)


def _fetch_openrouter_catalogue(api_key: str | None) -> dict[str, Any]:
    """
    Pull the live model catalogue once per hour.

    This is what makes pricing self-maintaining. Vendors change prices; the
    row you write today records the price that was true today.
    """
    global _CATALOGUE_CACHE, _CATALOGUE_FETCHED_AT
    if _CATALOGUE_CACHE and (time.time() - _CATALOGUE_FETCHED_AT) < _CATALOGUE_TTL_S:
        return _CATALOGUE_CACHE

    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        r = httpx.get(f"{OPENROUTER_BASE}/models", headers=headers, timeout=30.0)
        r.raise_for_status()
        data = r.json().get("data", [])
        _CATALOGUE_CACHE = {m["id"]: m for m in data if "id" in m}
        _CATALOGUE_FETCHED_AT = time.time()
    except Exception as exc:  # offline / no key / rate limited: degrade, do not crash
        print(f"  [registry] catalogue unavailable ({type(exc).__name__}); "
              f"pricing and capability metadata will be blank")
        _CATALOGUE_CACHE = {}
    return _CATALOGUE_CACHE


def _per_mtok(raw: str | float | None) -> float | None:
    """Catalogue prices are per-token strings. Normalise to per-million."""
    if raw in (None, "", "-1"):
        return None
    try:
        return float(raw) * 1_000_000
    except (TypeError, ValueError):
        return None


def _enrich(spec: ModelSpec, catalogue: dict[str, Any]) -> ModelSpec:
    entry = catalogue.get(spec.model)
    if not entry:
        # Direct-route or a model the gateway does not list. Infer what we can.
        # Bedrock IDs are dot-separated (anthropic.claude-3-sonnet-...,
        # amazon.titan-text-express-v1) rather than slash-separated.
        if spec.route == "bedrock" and "." in spec.model:
            spec.vendor = spec.vendor or spec.model.split(".", 1)[0]
        elif spec.route == "anthropic":
            spec.vendor = spec.vendor or "anthropic"
        else:
            spec.vendor = spec.vendor or (spec.model.split("/")[0] if "/" in spec.model else "unknown")
        spec.canonical_id = spec.model
        spec.model_family = spec.model.split("/")[-1].rsplit("-", 1)[0]

        priced = _load_direct_pricing().get(spec.model)
        if priced:
            spec.price_input_per_mtok = priced.get("input")
            spec.price_output_per_mtok = priced.get("output")
            spec.pricing_captured_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        return spec

    pricing = entry.get("pricing", {}) or {}
    arch = entry.get("architecture", {}) or {}
    top = entry.get("top_provider", {}) or {}
    supported = set(entry.get("supported_parameters", []) or [])

    spec.vendor = spec.model.split("/")[0]
    spec.canonical_id = entry.get("canonical_slug") or entry["id"]
    spec.model_family = (entry.get("name") or spec.model).split(":")[0].strip()
    spec.context_window = entry.get("context_length") or top.get("context_length")
    spec.max_output_tokens = top.get("max_completion_tokens")
    spec.supports_tools = "tools" in supported
    spec.supports_json_mode = "response_format" in supported or "structured_outputs" in supported
    spec.supports_reasoning = "reasoning" in supported or "include_reasoning" in supported
    spec.supports_prompt_caching = _per_mtok(pricing.get("input_cache_read")) is not None
    spec.input_modalities = arch.get("input_modalities") or []
    spec.tokenizer = arch.get("tokenizer", "")

    spec.price_input_per_mtok = _per_mtok(pricing.get("prompt"))
    spec.price_cached_input_per_mtok = _per_mtok(pricing.get("input_cache_read"))
    spec.price_output_per_mtok = _per_mtok(pricing.get("completion"))
    spec.price_reasoning_per_mtok = _per_mtok(pricing.get("internal_reasoning"))
    spec.pricing_captured_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return spec


def load_registry(
    path: str = "config/models.yaml",
    only: list[str] | None = None,
    include_disabled: bool = False,
) -> list[ModelSpec]:
    with open(path) as fh:
        raw = yaml.safe_load(fh)

    defaults = raw.get("defaults", {}) or {}
    or_key = os.getenv("OPENROUTER_API_KEY", "")
    catalogue = _fetch_openrouter_catalogue(or_key)

    specs: list[ModelSpec] = []
    for entry in raw.get("models", []) or []:
        merged = {**defaults, **entry}
        spec = ModelSpec(
            id=merged["id"],
            model=merged["model"],
            route=merged.get("route", "openrouter"),
            enabled=merged.get("enabled", True),
            tags=merged.get("tags", []) or [],
            base_url_env=merged.get("base_url_env", ""),
            api_key_env=merged.get("api_key_env", ""),
            region=merged.get("region", ""),
            deployment_type=merged.get("deployment_type", ""),
            aws_access_key_id_env=merged.get("aws_access_key_id_env", ""),
            aws_secret_access_key_env=merged.get("aws_secret_access_key_env", ""),
            aws_session_token_env=merged.get("aws_session_token_env", ""),
            temperature=merged.get("temperature", 0.2),
            send_temperature=merged.get("send_temperature", True),
            top_p=merged.get("top_p"),
            max_tokens=merged.get("max_tokens", 1024),
            seed=merged.get("seed"),
            timeout_s=merged.get("timeout_s", 120),
        )

        if only and spec.id not in only:
            continue
        if not spec.enabled and not include_disabled and not (only and spec.id in only):
            continue

        # Resolve endpoint + credential
        if spec.route == "openrouter":
            spec.base_url = OPENROUTER_BASE
            spec.api_key = or_key
        elif spec.route == "bedrock":
            spec.aws_access_key_id = os.getenv(spec.aws_access_key_id_env, "")
            spec.aws_secret_access_key = os.getenv(spec.aws_secret_access_key_env, "")
            spec.aws_session_token = os.getenv(spec.aws_session_token_env, "") if spec.aws_session_token_env else ""
        elif spec.route == "anthropic":
            # No base_url_env required -- there's only one Anthropic API,
            # unlike OpenAI-compatible endpoints that can be Azure/self-hosted.
            spec.base_url = (os.getenv(spec.base_url_env, "").rstrip("/") if spec.base_url_env else "") or ANTHROPIC_BASE
            spec.api_key = os.getenv(spec.api_key_env or "ANTHROPIC_API_KEY", "")
        else:
            spec.base_url = os.getenv(spec.base_url_env, "").rstrip("/")
            spec.api_key = os.getenv(spec.api_key_env, "")

        specs.append(_enrich(spec, catalogue))

    return specs


def describe(specs: list[ModelSpec]) -> str:
    lines = [
        f"{'MODEL':<34} {'VENDOR':<12} {'CTX':>9} {'TOOLS':>6} "
        f"{'$IN/M':>8} {'$OUT/M':>8}  READY"
    ]
    for s in specs:
        lines.append(
            f"{s.id:<34} {s.vendor:<12} "
            f"{(s.context_window or 0):>9,} "
            f"{('yes' if s.supports_tools else '-'):>6} "
            f"{(f'{s.price_input_per_mtok:.3f}' if s.price_input_per_mtok is not None else '-'):>8} "
            f"{(f'{s.price_output_per_mtok:.3f}' if s.price_output_per_mtok is not None else '-'):>8}  "
            f"{'yes' if s.is_ready else 'NO KEY'}"
        )
    return "\n".join(lines)
