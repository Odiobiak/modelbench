"""
Orchestration.

Fans out (model x case x repeat) across a bounded pool, scores each result
through the three tiers, and enforces a hard spend ceiling so a mistyped
repeat count cannot quietly cost a hundred dollars.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Callable

from .client import MeasuredClient
from .registry import ModelSpec
from .schema import RunRecord
from .scorers import Judge, run_deterministic, run_reference
from .suites import Case


class SpendCeilingExceeded(RuntimeError):
    pass


class Runner:
    def __init__(self, *, settings: dict, judge_spec: ModelSpec | None = None,
                 mock: bool = False, verbose: bool = True):
        self.settings = settings
        self.judge_spec = judge_spec
        self.mock = mock
        self.verbose = verbose
        self.run_id = f"{datetime.now(timezone.utc):%Y%m%dT%H%M%S}-{uuid.uuid4().hex[:6]}"
        self.spend = 0.0
        self._spend_lock = asyncio.Lock()
        self._aborted = False       # spend ceiling hit
        self._cancelled = False     # user-requested cancellation

    def request_cancel(self) -> None:
        """Cooperative cancel: in-flight calls finish, no new ones start.
        Same mechanism the spend ceiling already uses, exposed for callers
        (e.g. an API layer) that need to stop a run early."""
        self._cancelled = True

    async def run(self, specs: list[ModelSpec], cases: list[Case],
                  on_progress: Callable[[int, int, float], None] | None = None) -> list[RunRecord]:
        run_cfg = self.settings.get("run", {})
        judge_cfg = self.settings.get("judge", {})
        repeats = int(run_cfg.get("repeats", 3))
        concurrency = int(run_cfg.get("concurrency", 6))
        self.max_spend = float(run_cfg.get("max_spend_usd", 5.0))

        sem = asyncio.Semaphore(concurrency)
        records: list[RunRecord] = []
        total = len(specs) * len(cases) * repeats
        done = 0

        async with MeasuredClient(
            retry_attempts=int(run_cfg.get("retry_attempts", 2)),
            retry_backoff_s=float(run_cfg.get("retry_backoff_s", 2.0)),
            mock=self.mock,
        ) as client:

            judge = None
            if self.judge_spec and judge_cfg.get("enabled", True) and not self.mock:
                judge = Judge(
                    client, self.judge_spec,
                    enabled=True,
                    calibration_sample_rate=float(
                        judge_cfg.get("calibration_sample_rate", 0.10)),
                )

            async def one(spec: ModelSpec, case: Case, rep: int) -> RunRecord | None:
                nonlocal done
                if self._aborted or self._cancelled:
                    return None
                async with sem:
                    rec = await client.complete(
                        spec,
                        case.build_messages(),
                        tools=case.tools or None,
                        response_format=case.response_format,
                        max_tokens=case.max_tokens,
                    )
                    self._stamp_case(rec, case, rep)
                    self._score(rec, case)

                    if judge and rec.ok and case.judge:
                        await judge.score(rec, case.judge)
                        rec.passed = not rec.failed_assertions

                    await self._account(rec)
                    done += 1
                    if self.verbose and done % 10 == 0:
                        print(f"  {done}/{total} calls  ·  ${self.spend:.4f} spent")
                    if on_progress:
                        on_progress(done, total, self.spend)
                    return rec

            tasks = [
                one(spec, case, rep)
                for spec in specs
                for case in cases
                for rep in range(repeats)
            ]
            for result in await asyncio.gather(*tasks, return_exceptions=True):
                if isinstance(result, RunRecord):
                    result.run_id = self.run_id
                    records.append(result)
                elif isinstance(result, Exception) and self.verbose:
                    print(f"  [runner] task error: {type(result).__name__}: {result}")

        return records

    # ── helpers ───────────────────────────────────────────────────────
    @staticmethod
    def _stamp_case(rec: RunRecord, case: Case, rep: int) -> None:
        rec.suite_pack = case.pack
        rec.suite_version = case.pack_version
        rec.case_id = case.id
        rec.case_tags = ",".join(case.tags)
        rec.difficulty = case.difficulty
        rec.repeat_index = rep

    @staticmethod
    def _score(rec: RunRecord, case: Case) -> None:
        scores: dict[str, float] = {}
        failed: list[str] = []

        if not rec.ok:
            rec.passed = False
            rec.failed_assertions = f"request_failed({rec.error_type})"
            rec.scores_json = json.dumps({"request_ok": 0.0})
            return

        d_scores, d_failed = run_deterministic(rec, case.assertions)
        scores.update(d_scores)
        failed.extend(d_failed)

        if case.reference:
            r_scores, r_failed = run_reference(rec, case.reference)
            scores.update(r_scores)
            failed.extend(r_failed)

        scores["request_ok"] = 1.0
        rec.scores_json = json.dumps(scores)
        rec.failed_assertions = ",".join(failed)
        rec.passed = not failed

    async def _account(self, rec: RunRecord) -> None:
        async with self._spend_lock:
            self.spend += rec.cost_total_usd or 0.0
            if self.spend > self.max_spend and not self._aborted:
                self._aborted = True
                print(f"\n  !! SPEND CEILING HIT: ${self.spend:.4f} > "
                      f"${self.max_spend:.2f}. Aborting remaining calls.")


def estimate_cost(specs: list[ModelSpec], cases: list[Case], repeats: int,
                  *, avg_prompt_tokens: int = 600,
                  avg_completion_tokens: int = 220) -> tuple[float, list[tuple[str, float]]]:
    """
    Dry-run projection. Rough by design, but it reliably catches the
    'I meant 3 repeats not 30' class of mistake before it costs anything.
    """
    per_model: list[tuple[str, float]] = []
    total = 0.0
    n_calls = len(cases) * repeats
    for spec in specs:
        p_in = spec.price_input_per_mtok or 0.0
        p_out = spec.price_output_per_mtok or 0.0
        cost = n_calls * (
            avg_prompt_tokens * p_in / 1_000_000
            + avg_completion_tokens * p_out / 1_000_000
        )
        per_model.append((spec.id, cost))
        total += cost
    return total, per_model
