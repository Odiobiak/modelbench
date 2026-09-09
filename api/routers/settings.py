from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import orm, schemas
from ..db import get_db
from ..deps import DEFAULT_SETTINGS_NAME

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("", response_model=schemas.SettingsOut)
async def get_settings(db: AsyncSession = Depends(get_db)):
    row = (
        await db.execute(select(orm.BenchSettings).where(orm.BenchSettings.name == DEFAULT_SETTINGS_NAME))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(
            404,
            "No settings saved yet. Run `python -m api.migrate.import_existing` "
            "to seed it from config/settings.yaml, or PUT /settings to create one.",
        )
    return schemas.SettingsOut(name=row.name, payload=row.payload, updated_at=row.updated_at)


@router.put("", response_model=schemas.SettingsOut)
async def put_settings(body: schemas.SettingsPayload, db: AsyncSession = Depends(get_db)):
    row = (
        await db.execute(select(orm.BenchSettings).where(orm.BenchSettings.name == DEFAULT_SETTINGS_NAME))
    ).scalar_one_or_none()
    payload = body.model_dump()
    if row is None:
        row = orm.BenchSettings(name=DEFAULT_SETTINGS_NAME, payload=payload)
        db.add(row)
    else:
        row.payload = payload
    await db.commit()
    await db.refresh(row)
    return schemas.SettingsOut(name=row.name, payload=row.payload, updated_at=row.updated_at)
