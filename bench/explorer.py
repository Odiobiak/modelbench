"""
Cross-run, cross-model comparison table for the web app's Explorer tab.

report.summarize() and criteria.compute_criteria() both group by model_alias
only, which is exactly right for "how has this model done across everything
I've ever run" (the scorecard, the dashboard) but wrong for "compare run A's
gpt-4.1-nano against run B's gpt-4.1-nano" -- that needs one row per
(run, model), not one row folded across every run in the slice. This computes
both existing, already-tested aggregations once per run and stitches the run
identity back on, rather than reimplementing either.
"""

from __future__ import annotations

import pandas as pd

from . import criteria, report


def build_comparison_table(df: pd.DataFrame) -> pd.DataFrame:
    """One row per (run_id, model_alias): every report.summarize() column
    plus every criteria.compute_criteria() column, each computed within that
    run alone (so a run scoped to fewer packs doesn't dilute another run's
    numbers, and vice versa)."""
    if df.empty:
        return pd.DataFrame()

    parts = []
    for run_id, rg in df.groupby("run_id"):
        summary = report.summarize(rg)
        if summary.empty:
            continue
        crit = criteria.compute_criteria(rg)
        merged = summary.merge(crit, on="model_alias", how="left")
        merged.insert(0, "run_id", run_id)
        merged.insert(1, "run_started_at", rg["ts_utc"].min())
        parts.append(merged)
    return pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()
