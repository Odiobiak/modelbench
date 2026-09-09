"""
DB-backed equivalent of bench.suites.load_suites() / list_packs().

Builds the same bench.suites.Case objects the file-based loader does, so
Runner.run() and the scorers never know whether a case came from a YAML file
or a bench_packs/bench_cases row. Mirrors the shared-system/shared-tools/
judge_defaults merge and the judge user_input auto-fill line for line.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from bench.suites import Case

from .. import orm


async def list_packs_from_db(db: AsyncSession) -> list[str]:
    rows = (await db.execute(select(orm.BenchPack.name).order_by(orm.BenchPack.name))).scalars().all()
    return list(rows)


async def load_suites_from_db(db: AsyncSession, packs: list[str] | None = None) -> list[Case]:
    stmt = select(orm.BenchPack).order_by(orm.BenchPack.name)
    pack_rows = (await db.execute(stmt)).scalars().all()

    cases: list[Case] = []
    for pack in pack_rows:
        if packs and pack.name not in packs and pack.name.split("_", 1)[-1] not in packs:
            continue

        case_rows = (
            await db.execute(
                select(orm.BenchCase).where(orm.BenchCase.pack_id == pack.id).order_by(orm.BenchCase.created_at)
            )
        ).scalars().all()

        for row in case_rows:
            judge = dict(pack.judge_defaults or {})
            judge.update(row.judge or {})
            if judge:
                judge.setdefault(
                    "user_input",
                    " | ".join(str(m.get("content", "")) for m in row.messages if m.get("role") == "user"),
                )

            cases.append(Case(
                id=row.case_key,
                pack=pack.name,
                pack_version=pack.version,
                messages=row.messages,
                system=row.system if row.system is not None else pack.system,
                tools=row.tools if row.tools is not None else pack.tools,
                response_format=row.response_format,
                max_tokens=row.max_tokens,
                assertions=row.assertions or [],
                reference=row.reference or {},
                judge=judge,
                tags=row.tags or [],
                difficulty=row.difficulty,
            ))
    return cases
