from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import orm, schemas
from ..db import get_db

router = APIRouter(prefix="/packs", tags=["suites"])


def _slugify(text: str) -> str:
    import re
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return "-".join(slug.split("-")[:4]) or "case"


def _build_judge(criteria: list[schemas.JudgeCriterion]) -> dict:
    """Maps the guided builder's named dimensions onto the shape
    bench.scorers.judge.Judge.score() reads: {"criteria": {name: description}}.
    Each dimension is graded independently and lands in scores_json as its
    own judge_<name> column -- names are slugified so that column stays
    clean, deduping on collision (e.g. two criteria both named "Tone")."""
    import re

    out: dict[str, str] = {}
    for c in criteria:
        key = re.sub(r"[^a-z0-9]+", "_", c.name.strip().lower()).strip("_") or "criterion"
        base, n = key, 2
        while key in out:
            key, n = f"{base}_{n}", n + 1
        out[key] = c.description
    return {"criteria": out} if out else {}


def _build_assertions(checks: list[schemas.CaseCheck]) -> list[dict]:
    out = []
    for c in checks:
        entry: dict = {"type": c.type}
        if c.type == "is_json":
            out.append(entry)
            continue
        if c.type in ("max_words", "max_sentences"):
            try:
                entry["value"] = int(c.value)
            except (TypeError, ValueError):
                raise HTTPException(400, f"'{c.type}' needs a numeric value")
        elif c.type == "not_contains_any":
            if isinstance(c.value, str):
                entry["value"] = [v.strip() for v in c.value.split(",") if v.strip()]
            elif isinstance(c.value, list):
                entry["value"] = c.value
            else:
                raise HTTPException(400, "'not_contains_any' needs a list of terms")
        else:  # contains, regex
            if not c.value:
                raise HTTPException(400, f"'{c.type}' needs a value")
            entry["value"] = str(c.value)
        out.append(entry)
    return out


@router.get("", response_model=list[schemas.PackOut])
async def list_packs(db: AsyncSession = Depends(get_db)):
    packs = (await db.execute(select(orm.BenchPack).order_by(orm.BenchPack.name))).scalars().all()
    out = []
    for p in packs:
        cases = (await db.execute(select(orm.BenchCase).where(orm.BenchCase.pack_id == p.id))).scalars().all()
        tags = sorted({t for c in cases for t in (c.tags or [])})
        difficulties = sorted({c.difficulty for c in cases})
        out.append(schemas.PackOut(name=p.name, case_count=len(cases), tags=tags, difficulties=difficulties))
    return out


@router.post("", response_model=schemas.PackOut, status_code=201)
async def create_pack(body: schemas.PackCreate, db: AsyncSession = Depends(get_db)):
    row = orm.BenchPack(**body.model_dump())
    db.add(row)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, f"Pack '{body.name}' already exists")
    return schemas.PackOut(name=row.name, case_count=0, tags=[], difficulties=[])


async def _get_pack(db: AsyncSession, name: str) -> orm.BenchPack:
    row = (await db.execute(select(orm.BenchPack).where(orm.BenchPack.name == name))).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, f"Pack '{name}' not found")
    return row


def _case_out(pack_name: str, row: orm.BenchCase) -> schemas.CaseOut:
    return schemas.CaseOut(
        id=row.id, pack=pack_name, case_key=row.case_key, messages=row.messages,
        system=row.system, tags=row.tags or [], difficulty=row.difficulty,
        assertions=row.assertions or [], judge=row.judge or {}, created_at=row.created_at,
    )


@router.get("/{name}/cases", response_model=list[schemas.CaseOut])
async def list_cases(name: str, db: AsyncSession = Depends(get_db)):
    pack = await _get_pack(db, name)
    rows = (
        await db.execute(select(orm.BenchCase).where(orm.BenchCase.pack_id == pack.id).order_by(orm.BenchCase.created_at))
    ).scalars().all()
    return [_case_out(name, r) for r in rows]


@router.post("/{name}/cases", response_model=schemas.CaseOut, status_code=201)
async def add_case(name: str, body: schemas.CaseIn, db: AsyncSession = Depends(get_db)):
    pack = (await db.execute(select(orm.BenchPack).where(orm.BenchPack.name == name))).scalar_one_or_none()
    if pack is None:
        # The UI's "add test case" drawer can create a pack inline -- convenience,
        # not a hidden side effect: the pack still needs a name the caller chose.
        pack = orm.BenchPack(name=name)
        db.add(pack)
        await db.flush()

    if body.turns[0].role != "user":
        raise HTTPException(400, "The first turn must be from the user")
    if not body.checks and not body.judge_criteria:
        raise HTTPException(400, "Add at least one check or an AI-judge criterion")

    case_key = body.case_key or _slugify(body.turns[0].content)
    judge = _build_judge(body.judge_criteria)

    row = orm.BenchCase(
        pack_id=pack.id, case_key=case_key,
        messages=[t.model_dump() for t in body.turns],
        system=body.system, tags=body.tags, difficulty=body.difficulty,
        assertions=_build_assertions(body.checks), judge=judge,
    )
    db.add(row)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, f"Case '{case_key}' already exists in pack '{name}'")
    await db.refresh(row)
    return _case_out(name, row)


@router.delete("/{name}/cases/{case_key}", status_code=204)
async def delete_case(name: str, case_key: str, db: AsyncSession = Depends(get_db)):
    pack = await _get_pack(db, name)
    row = (
        await db.execute(
            select(orm.BenchCase).where(orm.BenchCase.pack_id == pack.id, orm.BenchCase.case_key == case_key)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "Case not found")
    await db.delete(row)
    await db.commit()
