"""
In-process run execution: one run at a time, progress tracked in memory
(more frequently updated than the throttled DB row) plus a registry of live
Runner instances so /runs/{id}/cancel can reach the right one.
"""
from __future__ import annotations

from bench.runner import Runner

_current_run_id: str | None = None
_runners: dict[str, Runner] = {}
_progress: dict[str, dict] = {}


def is_busy() -> bool:
    return _current_run_id is not None


def start(run_id: str, runner: Runner) -> None:
    global _current_run_id
    _current_run_id = run_id
    _runners[run_id] = runner
    _progress[run_id] = {"calls_done": 0, "total_calls": 0, "spend_usd": 0.0}


def update_progress(run_id: str, done: int, total: int, spend: float) -> None:
    _progress[run_id] = {"calls_done": done, "total_calls": total, "spend_usd": spend}


def get_progress(run_id: str) -> dict | None:
    return _progress.get(run_id)


def get_runner(run_id: str) -> Runner | None:
    return _runners.get(run_id)


def finish(run_id: str) -> None:
    global _current_run_id
    _runners.pop(run_id, None)
    _progress.pop(run_id, None)
    if _current_run_id == run_id:
        _current_run_id = None
