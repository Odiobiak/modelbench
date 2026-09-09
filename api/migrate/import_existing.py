"""
One-time (idempotent) import of the existing config/*.yaml and results/*.parquet
into Supabase, so nothing already generated is lost when the DB becomes the
source of truth for models/settings.

Deliberately parses config/models.yaml with a raw yaml.safe_load rather than
calling bench.registry.load_registry() -- that would trigger a live OpenRouter
catalogue fetch during import, and the imported fields would go stale the
moment anyone calls load_registry_from_db() anyway (which re-enriches on every
call). Only the hand-authored config fields are imported.

Usage:
    python -m api.migrate.import_existing
"""
from __future__ import annotations

import asyncio
import glob
import os

import pandas as pd
import yaml
from sqlalchemy.dialects.postgresql import insert as pg_insert

from bench import report, store

from .. import config, orm
from ..adapters.runner_bridge import _json_safe
from ..db import async_session_maker


async def import_models(session) -> int:
    with open(config.MODELS_YAML) as fh:
        raw = yaml.safe_load(fh) or {}
    defaults = raw.get("defaults", {}) or {}

    count = 0
    for entry in raw.get("models", []) or []:
        merged = {**defaults, **entry}
        values = dict(
            alias=merged["id"],
            model=merged["model"],
            route=merged.get("route", "openrouter"),
            enabled=merged.get("enabled", True),
            tags=merged.get("tags", []) or [],
            base_url_env=merged.get("base_url_env", ""),
            api_key_env=merged.get("api_key_env", ""),
            region=merged.get("region", ""),
            deployment_type=merged.get("deployment_type", ""),
            temperature=merged.get("temperature", 0.2),
            top_p=merged.get("top_p"),
            max_tokens=merged.get("max_tokens", 1024),
            seed=merged.get("seed"),
            timeout_s=merged.get("timeout_s", 120),
        )
        stmt = pg_insert(orm.BenchModel).values(**values)
        stmt = stmt.on_conflict_do_update(index_elements=[orm.BenchModel.alias], set_=values)
        await session.execute(stmt)
        count += 1
    return count


async def import_suites(session) -> tuple[int, int]:
    """Mirrors bench.suites.load_suites()'s own YAML parsing (shared system/
    tools/judge_defaults per file, `input` shorthand expanded to a single
    user message) but writes bench_packs/bench_cases rows instead of
    building Case objects directly."""
    n_packs = n_cases = 0
    for path in sorted(glob.glob(os.path.join(config.SUITES_DIR, "*.yaml"))):
        pack_name = os.path.splitext(os.path.basename(path))[0]
        with open(path) as fh:
            doc = yaml.safe_load(fh) or {}

        pack_values = dict(
            name=pack_name,
            version=str(doc.get("version", "1")),
            system=doc.get("system", "") or "",
            tools=doc.get("tools", []) or [],
            judge_defaults=doc.get("judge_defaults", {}) or {},
        )
        stmt = pg_insert(orm.BenchPack).values(**pack_values)
        stmt = stmt.on_conflict_do_update(index_elements=[orm.BenchPack.name], set_=pack_values)
        stmt = stmt.returning(orm.BenchPack.id)
        pack_id = (await session.execute(stmt)).scalar_one()
        n_packs += 1

        for raw in doc.get("cases", []) or []:
            messages = raw["messages"] if "messages" in raw else [{"role": "user", "content": raw["input"]}]
            case_values = dict(
                pack_id=pack_id,
                case_key=raw["id"],
                messages=messages,
                system=raw.get("system"),
                tools=raw.get("tools"),
                response_format=raw.get("response_format"),
                max_tokens=raw.get("max_tokens"),
                assertions=raw.get("assert", []) or [],
                reference=raw.get("reference", {}) or {},
                judge=raw.get("judge", {}) or {},
                tags=raw.get("tags", []) or [],
                difficulty=raw.get("difficulty", "medium"),
            )
            stmt = pg_insert(orm.BenchCase).values(**case_values)
            stmt = stmt.on_conflict_do_update(
                index_elements=[orm.BenchCase.pack_id, orm.BenchCase.case_key], set_=case_values
            )
            await session.execute(stmt)
            n_cases += 1
    return n_packs, n_cases


async def import_settings(session) -> None:
    with open(config.SETTINGS_YAML) as fh:
        payload = yaml.safe_load(fh) or {}
    stmt = pg_insert(orm.BenchSettings).values(name="default", payload=payload)
    stmt = stmt.on_conflict_do_update(index_elements=[orm.BenchSettings.name], set_={"payload": payload})
    await session.execute(stmt)


async def import_runs(session) -> int:
    count = 0
    for path in sorted(glob.glob(os.path.join(config.RESULTS_DIR, "run_*.parquet"))):
        run_id = os.path.basename(path)[len("run_"):-len(".parquet")]
        df = store.load_run(run_id, directory=config.RESULTS_DIR)
        if df.empty:
            continue

        summary = report.summarize(df)
        ts = pd.to_datetime(df["ts_utc"])

        values = dict(
            run_id=run_id,
            status="completed",
            created_at=ts.min().to_pydatetime(),
            finished_at=ts.max().to_pydatetime(),
            model_ids=sorted(df["model_alias"].dropna().unique().tolist()),
            pack_names=sorted(df["suite_pack"].dropna().unique().tolist()),
            repeats=int(df["repeat_index"].max()) + 1 if "repeat_index" in df else None,
            mock=bool((df.get("cost_source") == "mock").any()),
            total_calls=len(df),
            calls_done=len(df),
            spend_usd=float(df["cost_total_usd"].fillna(0).sum()),
            result_path=path,
            summary_json=_json_safe(summary.to_dict("records")),
        )
        stmt = pg_insert(orm.BenchRun).values(**values)
        # Never clobber a row that already has live status/progress from an
        # in-flight run -- only insert if it's genuinely new.
        stmt = stmt.on_conflict_do_nothing(index_elements=[orm.BenchRun.run_id])
        await session.execute(stmt)
        count += 1
    return count


async def main() -> None:
    async with async_session_maker() as session:
        n_models = await import_models(session)
        n_packs, n_cases = await import_suites(session)
        await import_settings(session)
        n_runs = await import_runs(session)
        await session.commit()
    print(f"Imported {n_models} model(s), {n_packs} pack(s) with {n_cases} case(s), "
          f"settings, and {n_runs} run(s).")


if __name__ == "__main__":
    asyncio.run(main())
