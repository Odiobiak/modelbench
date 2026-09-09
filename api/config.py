"""
API-layer configuration.

Everything the bench/ engine already reads from env (OPENROUTER_API_KEY,
BENCH_MAX_SPEND_USD, per-model base_url_env/api_key_env) is untouched -- this
only adds what the FastAPI process itself needs: the DB connection and the
absolute paths bench/* modules should read/write, since their defaults are
relative to cwd.
"""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(REPO_ROOT / ".env")

DATABASE_URL = os.getenv("DATABASE_URL", "")
RESULTS_DIR = os.getenv("BENCH_RESULTS_DIR", str(REPO_ROOT / "results"))
SUITES_DIR = os.getenv("BENCH_SUITES_DIR", str(REPO_ROOT / "suites"))
MODELS_YAML = os.getenv("BENCH_MODELS_YAML", str(REPO_ROOT / "config" / "models.yaml"))
SETTINGS_YAML = os.getenv("BENCH_SETTINGS_YAML", str(REPO_ROOT / "config" / "settings.yaml"))

CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",") if o.strip()]
