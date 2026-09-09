"""
In-process cache for the raw results DataFrame the dashboard reads.

store.load_all() re-reads and concatenates every results/run_*.parquet file
on disk -- fine at a handful of runs, wasteful once history grows, and
pointless to repeat on every dashboard view between runs. Cached here,
keyed by the exact file listing so it can never serve stale data: any new,
removed, or renamed run_*.parquet file changes the key and forces a real
reload. Invalidated explicitly (not just relying on the key check) right
after a run finishes writing its Parquet file, so the very next dashboard
request after a run always sees it without needing a second request to
notice the file listing changed.
"""
from __future__ import annotations

import glob
import os

import pandas as pd

from bench import store

_cache: dict = {"files": None, "df": None}


def get_all_results(directory: str) -> pd.DataFrame:
    files = tuple(sorted(glob.glob(os.path.join(directory, "run_*.parquet"))))
    if files != _cache["files"]:
        _cache["files"] = files
        _cache["df"] = store.load_all(directory)
    return _cache["df"]


def invalidate() -> None:
    _cache["files"] = None
    _cache["df"] = None
