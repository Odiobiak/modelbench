"""
JSON equivalent of bench.dashboard.render_dashboard() -- reuses its pure,
DataFrame-in/dict-out functions unchanged and skips only the two
side-effecting, file-writing steps (the HTML template and the SVG-drawing
JS). Every number here is computed by the same code the static
results/dashboard.html uses.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from bench.dashboard import MAX_SERIES, _run_frame, _series, detect_drift, version_log

from .. import cache, config, orm, overrides
from ..db import get_db
from ..deps import get_settings_dict

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("")
async def get_dashboard(
    models: str | None = Query(None, description="Comma-separated model aliases to chart. Defaults to the top 8 by call volume."),
    db: AsyncSession = Depends(get_db),
):
    df = cache.get_all_results(config.RESULTS_DIR)
    if df.empty:
        raise HTTPException(404, "No results found yet. Run a benchmark first.")

    # Corrections merge onto a copy of the cached raw DataFrame per request --
    # results/run_*.parquet and the cache itself are never touched, only what
    # this endpoint computes from them (see api/overrides.py).
    ov = await overrides.load_overrides(db)
    df = overrides.apply_overrides(df, ov)

    rf = _run_frame(df)
    if rf.empty:
        raise HTTPException(404, "No runs to chart yet.")

    settings = await get_settings_dict(db)
    th = settings.get("thresholds", {}) or {}

    models_by_volume = (
        rf.groupby("model_alias")["calls"].sum().sort_values(ascending=False).index.tolist()
    )

    excluded_run_ids = frozenset(
        (await db.execute(
            select(orm.BenchRun.run_id).where(orm.BenchRun.excluded_from_baseline == True)  # noqa: E712
        )).scalars().all()
    )

    # Drift/version-change detection always covers every model regardless of
    # what's charted -- a regression shouldn't go unnoticed just because that
    # model isn't in the current chart selection.
    alerts = detect_drift(rf, excluded_run_ids=excluded_run_ids)
    vlog = version_log(rf)
    crit = sum(1 for a in alerts if a["severity"] in ("critical", "serious"))
    latest_day = rf["day"].max()
    latest = rf[rf["day"] == latest_day]
    authoritative = bool(rf["authoritative_latency"].any())

    if models:
        requested = [m.strip() for m in models.split(",") if m.strip()]
        chosen = [m for m in requested if m in models_by_volume]
        folded = [m for m in models_by_volume if m not in chosen]
    else:
        chosen = models_by_volume[:MAX_SERIES]
        folded = models_by_volume[MAX_SERIES:]

    charts = {
        "pass": {"data": _series(rf, "pass_rate", chosen), "fmt": "pct",
                 "title": "Pass rate over time",
                 "sub": "Every pack combined. A step down is a regression or a silent model change.",
                 "threshold": 0.90},
        "ttft": {"data": _series(rf, "ttft_p95", chosen), "fmt": "ms",
                 "title": "TTFT p95 over time",
                 "sub": ("Absolute: direct vendor routes." if authoritative else
                         "Relative only: includes a gateway hop. Valid for ranking, not for quoting."),
                 "threshold": th.get("ttft_p95_ms", 800)},
        "cost": {"data": _series(rf, "cost_per_success", chosen), "fmt": "usd",
                 "title": "Cost per successful case over time",
                 "sub": "Total spend divided by cases passed. Rises when quality drops, not just when prices do.",
                 "threshold": None},
        "cache": {"data": _series(rf, "cache_ratio", chosen), "fmt": "pct",
                  "title": "Prompt cache hit ratio",
                  "sub": "A model that looks cheap because your prompt caches well will not stay cheap when the prompt changes.",
                  "threshold": None},
    }

    packs = sorted(df["suite_pack"].dropna().unique())
    matrix = []
    for alias in chosen:
        sub = df[df["model_alias"] == alias]
        row = {"model": alias, "cells": []}
        for pack in packs:
            pg = sub[sub["suite_pack"] == pack]
            row["cells"].append(None if pg.empty else round(float((pg["passed"] == True).mean()), 4))  # noqa: E712
        matrix.append(row)

    best_pass = latest.loc[latest["pass_rate"].idxmax()] if latest["pass_rate"].notna().any() else None
    cheapest = latest.loc[latest["cost_per_success"].idxmin()] if latest["cost_per_success"].notna().any() else None

    return {
        "meta": {
            "calls": int(len(df)),
            "runs": int(rf["run_id"].nunique()),
            "days": int(rf["day"].nunique()),
            "models": int(rf["model_alias"].nunique()),
            "available_models": models_by_volume,
            "folded_models": folded,
        },
        "tiles": {
            "drift_alerts": crit,
            "version_changes": len(vlog),
            "best_pass_rate": None if best_pass is None else
                {"model": best_pass["model_alias"], "value": float(best_pass["pass_rate"])},
            "cheapest_per_success": None if cheapest is None else
                {"model": cheapest["model_alias"], "value": float(cheapest["cost_per_success"])},
            "latency_authoritative": authoritative,
        },
        "alerts": alerts,
        "version_log": vlog,
        "charts": charts,
        "packs": packs,
        "matrix": matrix,
    }
