"""
Case-metric corrections, layered on top of the raw Parquet data rather than
rewriting it.

results/run_*.parquet stays the untouched measured record (ARCHITECTURE.md
treats a RunRecord row as an immutable fact -- the drift algorithm depends on
history never silently changing). A correction instead lives in
bench_case_overrides, keyed by the RunRecord's own `record_id`, and is merged
onto a DataFrame fresh on every request by apply_overrides() -- so nothing
here needs to invalidate api/cache.py's cache of the raw file-derived
DataFrame; only the overlay changes.
"""
from __future__ import annotations

import pandas as pd
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import orm


async def load_overrides(
    db: AsyncSession, run_id: str | None = None
) -> dict[tuple[str, str], orm.BenchCaseOverride]:
    stmt = select(orm.BenchCaseOverride)
    if run_id:
        stmt = stmt.where(orm.BenchCaseOverride.run_id == run_id)
    rows = (await db.execute(stmt)).scalars().all()
    return {(r.run_id, r.record_id): r for r in rows}


def apply_overrides(
    df: pd.DataFrame, overrides: dict[tuple[str, str], orm.BenchCaseOverride]
) -> pd.DataFrame:
    """Overlay corrected `passed` values onto a copy of df for aggregation
    (dashboard charts, drift, the pack heatmap). Never mutates the cached
    raw DataFrame or the Parquet file it was read from."""
    if not overrides or df.empty:
        return df
    df = df.copy()

    def _effective(row: pd.Series) -> object:
        ov = overrides.get((row["run_id"], row["record_id"]))
        if ov is not None and ov.passed_override is not None:
            return ov.passed_override
        return row["passed"]

    df["passed"] = df.apply(_effective, axis=1)
    return df
