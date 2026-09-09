"""
Storage.

Parquet on disk. No database, no container, no service. A run is one file;
the history is the directory. Point it at S3 or a shared drive later and
nothing else changes, because everything downstream reads a DataFrame.
"""

from __future__ import annotations

import glob
import json
import os

import pandas as pd

from .schema import RunRecord

RESULTS_DIR = "results"


def save(records: list[RunRecord], run_id: str,
         directory: str = RESULTS_DIR) -> str:
    os.makedirs(directory, exist_ok=True)
    df = pd.DataFrame([r.to_dict() for r in records])

    # Flatten the scores blob into real columns so the scorecard and any
    # ad-hoc analysis can group on them without parsing JSON.
    if not df.empty and "scores_json" in df:
        expanded = pd.json_normalize(
            df["scores_json"].apply(lambda s: json.loads(s or "{}")))
        expanded.columns = [f"score.{c}" for c in expanded.columns]
        df = pd.concat([df.reset_index(drop=True),
                        expanded.reset_index(drop=True)], axis=1)

    path = os.path.join(directory, f"run_{run_id}.parquet")
    df.to_parquet(path, index=False)

    # Rows the judge flagged for human spot-checking.
    if "flagged_for_calibration" in df.columns:
        flagged = df[df["flagged_for_calibration"] == True]  # noqa: E712
        if not flagged.empty:
            qpath = os.path.join(directory, "calibration_queue.jsonl")
            cols = ["run_id", "record_id", "model_alias", "suite_pack", "case_id",
                    "response_text", "judge_raw_json", "passed"]
            with open(qpath, "a") as fh:
                for row in flagged[[c for c in cols if c in flagged.columns]] \
                        .to_dict("records"):
                    fh.write(json.dumps(row, default=str) + "\n")

    return path


def load_all(directory: str = RESULTS_DIR, include_mock: bool = False) -> pd.DataFrame:
    """
    Concat every stored run.

    Mock rows (served_by_provider == "mock") are excluded by default. A
    --mock run is a pipeline smoke test with canned responses, not a model
    result; folding it into aggregate history corrupts $/success and reads
    to the drift detector as a real regression. Pass include_mock=True only
    to inspect a mock run itself.
    """
    files = sorted(glob.glob(os.path.join(directory, "run_*.parquet")))
    if not files:
        return pd.DataFrame()
    df = pd.concat([pd.read_parquet(f) for f in files], ignore_index=True)
    if not include_mock and "served_by_provider" in df.columns:
        df = df[df["served_by_provider"] != "mock"]
    return df


def load_run(run_id: str, directory: str = RESULTS_DIR) -> pd.DataFrame:
    path = os.path.join(directory, f"run_{run_id}.parquet")
    return pd.read_parquet(path) if os.path.exists(path) else pd.DataFrame()


def latest_run_id(directory: str = RESULTS_DIR) -> str | None:
    files = sorted(glob.glob(os.path.join(directory, "run_*.parquet")))
    if not files:
        return None
    return os.path.basename(files[-1])[4:-8]
