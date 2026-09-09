from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import orm
from .db import get_db  # re-exported for router imports

DEFAULT_SETTINGS_NAME = "default"


async def get_settings_dict(db: AsyncSession) -> dict:
    """Returns the plain {run, judge, thresholds, report} dict every bench/*
    consumer already expects -- callers don't need to know it came from a DB
    row instead of settings.yaml."""
    result = await db.execute(
        select(orm.BenchSettings).where(orm.BenchSettings.name == DEFAULT_SETTINGS_NAME)
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise LookupError(
            "No settings row found. Run the import script "
            "(python -m api.migrate.import_existing) to seed it from config/settings.yaml."
        )
    return row.payload


async def get_current_user() -> str | None:
    """Stub for the future-auth hook. Always None today -- every adapter
    call that accepts user_id treats None as 'no ownership filter'."""
    return None
