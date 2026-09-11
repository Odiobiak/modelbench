from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import config
from .routers import dashboard, explorer, models, runs, settings, suites

app = FastAPI(title="modelbench API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(models.router)
app.include_router(settings.router)
app.include_router(suites.router)
app.include_router(runs.router)
app.include_router(dashboard.router)
app.include_router(explorer.router)


@app.get("/health")
async def health():
    return {"ok": True}
