"""
Bridges a launched run to the bench.runner.Runner engine and persists its
lifecycle into bench_runs. This is the only place that calls Runner.run() --
everything downstream of the API (store.save, report.summarize) is called
exactly as bench/cli.py already calls it, unmodified.
"""
from __future__ import annotations

import math
import os
from datetime import datetime, timezone

from sqlalchemy import update

from bench import report, store
from bench.registry import ModelSpec
from bench.runner import Runner
from bench.suites import Case

from .. import background, cache, config, orm
from ..db import async_session_maker

_PROGRESS_DB_FLUSH_EVERY = 10


def _json_safe(records: list[dict]) -> list[dict]:
    """NaN is valid to pandas (a model that never used reasoning/caching
    leaves avg_reasoning_tokens etc. as NaN) but not to Postgres's json/jsonb
    type -- json.dumps happily emits the literal token `NaN`, which asyncpg
    then rejects outright. DataFrame.where(cond, None) doesn't fix this: on a
    float column pandas casts the replacement `None` right back to NaN to
    keep the column's dtype, so the swap has to happen after to_dict(),
    on plain Python floats."""
    return [
        {k: (None if isinstance(v, float) and math.isnan(v) else v) for k, v in row.items()}
        for row in records
    ]


def build_judge_spec(settings: dict) -> ModelSpec | None:
    """Identical to bench.cli._judge_spec -- the judge is a synthetic
    ModelSpec built straight from settings, not one of the registry's
    entries, so it isn't affected by the models.yaml -> bench_models move."""
    cfg = settings.get("judge", {}) or {}
    if not cfg.get("enabled", True):
        return None
    spec = ModelSpec(
        id="__judge__",
        model=cfg.get("model", "anthropic/claude-sonnet-4.6"),
        route=cfg.get("route", "openrouter"),
        temperature=float(cfg.get("temperature", 0.0)),
        max_tokens=int(cfg.get("max_tokens", 512)),
    )
    spec.base_url = "https://openrouter.ai/api/v1"
    spec.api_key = os.getenv("OPENROUTER_API_KEY", "")
    spec.canonical_id = spec.model
    return spec


async def execute_run(
    runner: Runner,
    specs: list[ModelSpec],
    cases: list[Case],
    max_spend_usd: float,
) -> None:
    run_id = runner.run_id
    background.start(run_id, runner)

    async with async_session_maker() as session:
        await session.execute(
            update(orm.BenchRun)
            .where(orm.BenchRun.run_id == run_id)
            .values(status="running", started_at=datetime.now(timezone.utc))
        )
        await session.commit()

    def on_progress(done: int, total: int, spend: float) -> None:
        background.update_progress(run_id, done, total, spend)
        if done % _PROGRESS_DB_FLUSH_EVERY == 0:
            _flush_progress_sync(run_id, done, total, spend)

    try:
        records = await runner.run(specs, cases, on_progress=on_progress)

        if runner._cancelled:
            async with async_session_maker() as session:
                await session.execute(
                    update(orm.BenchRun)
                    .where(orm.BenchRun.run_id == run_id)
                    .values(status="cancelled", finished_at=datetime.now(timezone.utc),
                            calls_done=len(records), spend_usd=runner.spend)
                )
                await session.commit()
            return

        if runner._aborted:
            async with async_session_maker() as session:
                await session.execute(
                    update(orm.BenchRun)
                    .where(orm.BenchRun.run_id == run_id)
                    .values(status="failed", error_message="spend ceiling exceeded",
                            finished_at=datetime.now(timezone.utc),
                            calls_done=len(records), spend_usd=runner.spend)
                )
                await session.commit()
            return

        result_path = store.save(records, run_id, directory=config.RESULTS_DIR)
        cache.invalidate()  # a new run_*.parquet just landed; the dashboard's cached df is stale
        df = store.load_run(run_id, directory=config.RESULTS_DIR)
        summary = report.summarize(df)
        summary_json = _json_safe(summary.to_dict("records"))

        async with async_session_maker() as session:
            await session.execute(
                update(orm.BenchRun)
                .where(orm.BenchRun.run_id == run_id)
                .values(
                    status="completed",
                    finished_at=datetime.now(timezone.utc),
                    total_calls=len(records),
                    calls_done=len(records),
                    spend_usd=runner.spend,
                    result_path=result_path,
                    summary_json=summary_json,
                )
            )
            await session.commit()

    except Exception as exc:  # never let a background task die silently
        async with async_session_maker() as session:
            await session.execute(
                update(orm.BenchRun)
                .where(orm.BenchRun.run_id == run_id)
                .values(status="failed", error_message=f"{type(exc).__name__}: {exc}",
                        finished_at=datetime.now(timezone.utc))
            )
            await session.commit()
    finally:
        background.finish(run_id)


def _flush_progress_sync(run_id: str, done: int, total: int, spend: float) -> None:
    """on_progress is a plain sync callback invoked from inside Runner.run()'s
    gather loop; fire the DB write as a background task instead of awaiting
    it here so a slow write never adds latency to in-flight model calls. The
    in-memory background.update_progress() call (already done by the caller)
    is what /runs/{id} reads most of the time -- this is just the periodic
    durable checkpoint."""
    import asyncio

    async def _write():
        async with async_session_maker() as session:
            await session.execute(
                update(orm.BenchRun)
                .where(orm.BenchRun.run_id == run_id)
                .values(calls_done=done, total_calls=total, spend_usd=spend)
            )
            await session.commit()

    asyncio.create_task(_write())
