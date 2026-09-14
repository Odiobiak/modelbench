"""
The Explorer tab's backend: a pivotable results table across any selection of
runs/models/packs, combining report.py's raw metrics with criteria.py's
agentic-capability grades and the underlying per-case rows. Read-only,
computed fresh from the same cached DataFrame api/routers/dashboard.py uses
-- no new storage, no new write path.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from bench import criteria
from bench import explorer as bench_explorer

from .. import cache, config, overrides
from ..adapters.runner_bridge import _json_safe
from ..db import get_db

router = APIRouter(prefix="/explorer", tags=["explorer"])


def _parse_csv(value: str | None) -> list[str] | None:
    if not value:
        return None
    return [v.strip() for v in value.split(",") if v.strip()]


def _filtered(df, run_ids, model_ids, packs):
    if run_ids:
        df = df[df["run_id"].isin(run_ids)]
    if model_ids:
        df = df[df["model_alias"].isin(model_ids)]
    if packs:
        df = df[df["suite_pack"].isin(packs)]
    return df


async def _scoped_results(db: AsyncSession, run_ids, model_ids, packs):
    df = cache.get_all_results(config.RESULTS_DIR)
    if df.empty:
        raise HTTPException(404, "No results found yet. Run a benchmark first.")
    ov = await overrides.load_overrides(db)
    df = overrides.apply_overrides(df, ov)
    return _filtered(df, run_ids, model_ids, packs)


@router.get("/criteria")
async def list_criteria():
    """The fixed criteria definitions (key/label/description/packs), so the
    frontend never hardcodes this list -- add a criterion here and it shows
    up in the table with no frontend change."""
    return criteria.CRITERIA


@router.get("/summary")
async def get_summary(
    run_ids: str | None = Query(None, description="Comma-separated run ids. Omit for every run."),
    model_ids: str | None = Query(None, description="Comma-separated model aliases. Omit for every model."),
    packs: str | None = Query(None, description="Comma-separated suite pack names. Omit for every pack."),
    db: AsyncSession = Depends(get_db),
):
    df = await _scoped_results(db, _parse_csv(run_ids), _parse_csv(model_ids), _parse_csv(packs))
    if df.empty:
        raise HTTPException(404, "No results match that selection.")

    table = bench_explorer.build_comparison_table(df)
    return {
        "rows": _json_safe(table.to_dict("records")),
        "criteria": criteria.CRITERIA,
        "available": {
            "run_ids": sorted(df["run_id"].dropna().unique().tolist()),
            "model_ids": sorted(df["model_alias"].dropna().unique().tolist()),
            "packs": sorted(df["suite_pack"].dropna().unique().tolist()),
        },
    }


# Raw per-(model x case x repeat) columns worth putting in front of someone
# comparing models -- every metric group from bench/schema.py's docstring
# except the ones that only matter for reproducing/debugging a single call
# (request params, runtime environment).
CASE_COLUMNS = [
    "run_id", "record_id", "case_id", "suite_pack", "model_alias", "repeat_index",
    "ok", "passed", "error_type", "response_text", "finish_reason",
    "ttft_ms", "total_latency_ms", "tpot_ms", "tokens_per_second",
    "ts_utc", "case_tags", "difficulty",
    "vendor", "model_served",
    "prompt_tokens", "cached_prompt_tokens", "completion_tokens", "reasoning_tokens",
    "total_tokens", "cache_hit_ratio",
    "cost_input_usd", "cost_cached_usd", "cost_output_usd", "cost_total_usd", "cost_source",
    "retry_count", "rate_limited", "error_message",
    "judge_model", "scores_json", "failed_assertions",
    "judge_cost_usd", "judge_ttft_ms", "judge_total_latency_ms",
    "judge_prompt_tokens", "judge_completion_tokens",
]


@router.get("/rows")
async def get_rows(
    run_ids: str | None = Query(None),
    model_ids: str | None = Query(None),
    packs: str | None = Query(None),
    limit: int = Query(5000, le=20000, description="Most recent N rows in the selection, by call time."),
    db: AsyncSession = Depends(get_db),
):
    df = await _scoped_results(db, _parse_csv(run_ids), _parse_csv(model_ids), _parse_csv(packs))
    if df.empty:
        return []

    df = df.sort_values("ts_utc", ascending=False).head(limit)
    cols = [c for c in CASE_COLUMNS if c in df.columns]
    renamed = df[cols].rename(
        columns={"case_id": "case_key", "suite_pack": "pack", "case_tags": "tags"}
    )
    return _json_safe(renamed.to_dict("records"))
