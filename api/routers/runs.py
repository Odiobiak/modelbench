from __future__ import annotations

import asyncio
import os

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from bench import store
from bench.runner import Runner, estimate_cost

from .. import background, config, orm, overrides, schemas
from ..adapters.registry_db import load_registry_from_db
from ..adapters.runner_bridge import _json_safe, build_judge_spec, execute_run
from ..adapters.suites_db import load_suites_from_db
from ..db import get_db
from ..deps import get_settings_dict

router = APIRouter(prefix="/runs", tags=["runs"])


def _capped_max_spend(settings: dict) -> float:
    """Mirrors bench.cli._load_settings' BENCH_MAX_SPEND_USD handling."""
    cap = float(settings.get("run", {}).get("max_spend_usd", 5.0))
    env_cap = os.getenv("BENCH_MAX_SPEND_USD")
    if env_cap:
        cap = min(cap, float(env_cap))
    return cap


def _filter_case_keys(cases: list, case_keys: list[str] | None) -> list:
    """Narrows a pack-level case list down to a specific selection, e.g. from
    the Test Cases page's "run N selected" flow. None/empty means unrestricted
    -- every case in the requested packs runs, same as before this existed."""
    if not case_keys:
        return cases
    wanted = set(case_keys)
    return [c for c in cases if c.id in wanted]


@router.post("/estimate", response_model=schemas.EstimateOut)
async def estimate(body: schemas.EstimateRequest, db: AsyncSession = Depends(get_db)):
    specs = await load_registry_from_db(db, only=body.model_ids)
    cases = _filter_case_keys(await load_suites_from_db(db, packs=body.pack_names), body.case_keys)
    if not specs:
        raise HTTPException(400, "None of the given model_ids matched an enabled model")
    if not cases:
        raise HTTPException(400, "None of the given pack_names/case_keys matched any cases")

    settings = await get_settings_dict(db)
    repeats = body.repeats or int(settings.get("run", {}).get("repeats", 3))
    total, per_model = estimate_cost(specs, cases, repeats)
    ceiling = _capped_max_spend(settings)
    return schemas.EstimateOut(
        total_usd=total,
        per_model=dict(per_model),
        ceiling_usd=ceiling,
        exceeds_ceiling=total > ceiling,
    )


@router.post("", response_model=schemas.RunOut, status_code=202)
async def launch_run(body: schemas.RunLaunchRequest, db: AsyncSession = Depends(get_db)):
    if background.is_busy():
        raise HTTPException(409, "A run is already in progress. Only one run at a time is supported.")

    specs = await load_registry_from_db(db, only=body.model_ids)
    cases = _filter_case_keys(await load_suites_from_db(db, packs=body.pack_names), body.case_keys)
    if not specs:
        raise HTTPException(400, "None of the given model_ids matched an enabled model")
    if not cases:
        raise HTTPException(400, "None of the given pack_names/case_keys matched any cases")
    if not body.mock:
        unready = [s.id for s in specs if not s.is_ready]
        if unready:
            raise HTTPException(400, f"No credentials for: {', '.join(unready)}. Set mock=true to dry-run.")

    settings = await get_settings_dict(db)
    settings = dict(settings)
    settings["run"] = {**settings.get("run", {}), "repeats": body.repeats or settings.get("run", {}).get("repeats", 3)}
    if body.no_judge:
        settings["judge"] = {**settings.get("judge", {}), "enabled": False}
    max_spend = _capped_max_spend(settings)
    settings["run"]["max_spend_usd"] = max_spend

    judge_spec = None if body.mock else build_judge_spec(settings)
    runner = Runner(settings=settings, judge_spec=judge_spec, mock=body.mock, verbose=True)

    row = orm.BenchRun(
        run_id=runner.run_id,
        status="pending",
        model_ids=body.model_ids,
        pack_names=body.pack_names,
        case_keys=body.case_keys,
        repeats=settings["run"]["repeats"],
        mock=body.mock,
        settings_snapshot=settings,
        total_calls=len(specs) * len(cases) * settings["run"]["repeats"],
        max_spend_usd=max_spend,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)

    asyncio.create_task(execute_run(runner, specs, cases, max_spend))

    return schemas.RunOut.model_validate(row)


@router.get("", response_model=list[schemas.RunOut])
async def list_runs(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(orm.BenchRun).order_by(orm.BenchRun.created_at.desc()))).scalars().all()
    return [schemas.RunOut.model_validate(r) for r in rows]


@router.get("/compare", response_model=list[schemas.RunCompareOut])
async def compare_runs(ids: str, db: AsyncSession = Depends(get_db)):
    """Backs the Runs page's multi-select comparison view -- registered
    ahead of GET /{run_id} so "compare" is never swallowed as a run_id."""
    wanted = [i.strip() for i in ids.split(",") if i.strip()]
    if not wanted:
        raise HTTPException(400, "Pass at least one run id via ?ids=")
    rows = (await db.execute(select(orm.BenchRun).where(orm.BenchRun.run_id.in_(wanted)))).scalars().all()
    by_id = {r.run_id: r for r in rows}
    missing = [i for i in wanted if i not in by_id]
    if missing:
        raise HTTPException(404, f"Run(s) not found: {', '.join(missing)}")
    # Preserve the caller's ordering (selection order on the Runs page)
    # rather than whatever order the IN(...) query happened to return.
    return [
        schemas.RunCompareOut(
            run_id=r.run_id,
            status=r.status,
            created_at=r.created_at,
            model_ids=r.model_ids,
            pack_names=r.pack_names,
            note=r.note,
            summary=r.summary_json or [] if r.status == "completed" else [],
        )
        for r in (by_id[i] for i in wanted)
    ]


@router.get("/{run_id}", response_model=schemas.RunOut)
async def get_run(run_id: str, db: AsyncSession = Depends(get_db)):
    row = await db.get(orm.BenchRun, run_id)
    if row is None:
        raise HTTPException(404, "Run not found")
    out = schemas.RunOut.model_validate(row)
    live = background.get_progress(run_id)
    if live is not None:
        out.calls_done = live["calls_done"]
        out.total_calls = live["total_calls"] or out.total_calls
        out.spend_usd = live["spend_usd"]
    return out


@router.patch("/{run_id}", response_model=schemas.RunOut)
async def update_run_annotation(run_id: str, body: schemas.RunAnnotationUpdate, db: AsyncSession = Depends(get_db)):
    """Note/exclude-from-baseline are metadata about a run, not a measured
    fact -- this never touches the run's parquet file, only bench_runs."""
    row = await db.get(orm.BenchRun, run_id)
    if row is None:
        raise HTTPException(404, "Run not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    await db.commit()
    await db.refresh(row)
    return schemas.RunOut.model_validate(row)


@router.get("/{run_id}/results", response_model=schemas.RunResultsOut)
async def get_run_results(run_id: str, db: AsyncSession = Depends(get_db)):
    row = await db.get(orm.BenchRun, run_id)
    if row is None:
        raise HTTPException(404, "Run not found")
    if row.status != "completed":
        raise HTTPException(409, f"Run is '{row.status}', not completed yet")
    return schemas.RunResultsOut(run_id=run_id, status=row.status, summary=row.summary_json or [])


@router.get("/{run_id}/cases", response_model=list[schemas.RunCaseOut])
async def get_run_cases(run_id: str, db: AsyncSession = Depends(get_db)):
    """Raw (case x model x repeat) rows behind the run's summary -- what the
    Run Detail page's case browser and output/diff view render from. Reads
    the run's own parquet file directly; a single run is never a mix of
    mock and real rows, so unlike report --all/dashboard there's nothing to
    filter out here."""
    row = await db.get(orm.BenchRun, run_id)
    if row is None:
        raise HTTPException(404, "Run not found")

    df = store.load_run(run_id, directory=config.RESULTS_DIR)
    if df.empty:
        return []

    ov = await overrides.load_overrides(db, run_id=run_id)

    # DataFrame.where(pd.notna(df), None) looks like it sanitizes NaN -> None
    # but doesn't on numeric columns: pandas casts the replacement `None`
    # right back to NaN to preserve the column's float/int dtype. A raw NaN
    # then fails RunCaseOut's `int | None` fields (cached_prompt_tokens etc.)
    # with pydantic's finite_number error. Sanitize after to_dict() instead,
    # on plain Python values, same fix as api/adapters/runner_bridge.py.
    out = []
    for r in _json_safe(df.to_dict("records")):
        override = ov.get((run_id, r["record_id"]))
        out.append(schemas.RunCaseOut(
            record_id=r["record_id"],
            case_key=r["case_id"],
            pack=r["suite_pack"],
            model_alias=r["model_alias"],
            repeat_index=int(r["repeat_index"]),
            ok=bool(r["ok"]),
            passed=r["passed"],
            error_type=r["error_type"] or "",
            response_text=r["response_text"] or "",
            ttft_ms=r["ttft_ms"],
            total_latency_ms=r["total_latency_ms"],
            ts_utc=r["ts_utc"] or "",
            tags=r["case_tags"] or "",
            difficulty=r["difficulty"] or "",
            passed_override=override.passed_override if override else None,
            override_note=override.note if override else None,
            vendor=r["vendor"] or "",
            model_served=r["model_served"] or "",
            finish_reason=r["finish_reason"] or "",
            prompt_tokens=r["prompt_tokens"],
            cached_prompt_tokens=r["cached_prompt_tokens"],
            completion_tokens=r["completion_tokens"],
            total_tokens=r["total_tokens"],
            cost_total_usd=r["cost_total_usd"],
            retry_count=int(r["retry_count"] or 0),
            rate_limited=bool(r["rate_limited"]),
            error_message=r["error_message"] or "",
            judge_model=r["judge_model"] or "",
            scores_json=r["scores_json"] or "{}",
            failed_assertions=r["failed_assertions"] or "",
        ))
    return out


@router.put("/{run_id}/cases/{record_id}/override", response_model=schemas.CaseOverrideOut)
async def set_case_override(
    run_id: str, record_id: str, body: schemas.CaseOverrideIn, db: AsyncSession = Depends(get_db)
):
    """Corrects one case-level row's verdict (e.g. a mis-scored judge call)
    without rewriting results/run_{run_id}.parquet -- see api/overrides.py."""
    run = await db.get(orm.BenchRun, run_id)
    if run is None:
        raise HTTPException(404, "Run not found")

    stmt = pg_insert(orm.BenchCaseOverride).values(
        run_id=run_id,
        record_id=record_id,
        passed_override=body.passed_override,
        note=body.note,
        edited_by=body.edited_by,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["run_id", "record_id"],
        set_={
            "passed_override": stmt.excluded.passed_override,
            "note": stmt.excluded.note,
            "edited_by": stmt.excluded.edited_by,
            "edited_at": func.now(),
        },
    )
    await db.execute(stmt)
    await db.commit()

    row = await db.get(orm.BenchCaseOverride, {"run_id": run_id, "record_id": record_id})
    return schemas.CaseOverrideOut.model_validate(row)


@router.delete("/{run_id}/cases/{record_id}/override", status_code=204)
async def clear_case_override(run_id: str, record_id: str, db: AsyncSession = Depends(get_db)):
    row = await db.get(orm.BenchCaseOverride, {"run_id": run_id, "record_id": record_id})
    if row is not None:
        await db.delete(row)
        await db.commit()


@router.post("/{run_id}/cancel", status_code=202)
async def cancel_run(run_id: str, db: AsyncSession = Depends(get_db)):
    row = await db.get(orm.BenchRun, run_id)
    if row is None:
        raise HTTPException(404, "Run not found")
    if row.status not in ("pending", "running"):
        raise HTTPException(409, f"Run is '{row.status}', nothing to cancel")
    runner = background.get_runner(run_id)
    if runner is None:
        raise HTTPException(409, "Run is not currently executing in this process")
    runner.request_cancel()
    return {"run_id": run_id, "cancel_requested": True}
