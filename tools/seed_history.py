"""
Generate synthetic run history so the dashboard can be exercised before you
have weeks of real data.

Deliberately plants three things the dashboard must catch:
  1. a latency regression on one model in the final week
  2. a served-model change behind a stable alias (the critical alert)
  3. a provider input-price increase

Delete results/ and re-run `bench run` once you have real data.
"""
from __future__ import annotations

import os
import random
import sys
import uuid
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bench import store                                    # noqa: E402
from bench.schema import RunRecord                          # noqa: E402
from bench.suites import load_suites                        # noqa: E402

MODELS = [
    # alias, vendor, served, price_in, price_out, base_ttft, base_pass
    ("gpt-4.1-nano",     "openai",    "openai/gpt-4.1-nano",     0.10, 0.40, 190, 0.86),
    ("gemini-3-flash",   "google",    "google/gemini-3-flash",   0.075, 0.30, 160, 0.83),
    ("claude-haiku-4.5", "anthropic", "anthropic/claude-haiku-4.5", 0.80, 4.00, 250, 0.93),
    ("deepseek-v3",      "deepseek",  "deepseek/deepseek-chat",  0.14, 0.28, 410, 0.88),
]

WEEKS = 6


def main() -> None:
    cases = load_suites()
    random.seed(7)
    base_day = datetime.now(timezone.utc) - timedelta(weeks=WEEKS)

    for w in range(WEEKS):
        day = base_day + timedelta(weeks=w)
        run_id = f"{day:%Y%m%dT%H%M%S}-seed{w:02d}"
        records: list[RunRecord] = []

        for alias, vendor, served, p_in, p_out, ttft0, pass0 in MODELS:
            # planted event 1: deepseek latency regression in the last two weeks
            ttft_base = ttft0 * (1.45 if alias == "deepseek-v3" and w >= WEEKS - 2 else 1.0)
            # planted event 2: gemini alias repointed in the final week
            served_now = ("google/gemini-3.7-flash"
                          if alias == "gemini-3-flash" and w == WEEKS - 1 else served)
            # planted event 3: anthropic input price rise in the final week
            price_in = p_in * (1.25 if alias == "claude-haiku-4.5" and w == WEEKS - 1 else 1.0)
            # a repointed model also shifts quality slightly
            pass_base = pass0 + (0.05 if served_now != served else 0.0)

            for case in cases:
                for rep in range(2):
                    ttft = max(40, random.gauss(ttft_base, ttft_base * 0.22))
                    gen = random.gauss(430, 130)
                    ptok = random.randint(120, 900)
                    ctok = random.randint(20, 160)
                    cached = int(ptok * random.uniform(0.0, 0.55))
                    passed = random.random() < min(0.99, max(0.3, random.gauss(pass_base, 0.06)))

                    r = RunRecord(
                        run_id=run_id, record_id=str(uuid.uuid4()),
                        ts_utc=(day + timedelta(minutes=random.randint(0, 50))).isoformat(),
                        model_alias=alias, model_requested=served,
                        model_served=served_now, model_canonical_id=served,
                        vendor=vendor, served_by_provider=vendor,
                        model_family=alias, context_window=128000,
                        supports_tools=True, supports_prompt_caching=True,
                        price_input_per_mtok=price_in,
                        price_cached_input_per_mtok=price_in * 0.25,
                        price_output_per_mtok=p_out,
                        pricing_captured_at=day.isoformat(),
                        route="openrouter", region="", deployment_type="",
                        temperature=0.2, max_tokens_requested=1024,
                        suite_pack=case.pack, suite_version=case.pack_version,
                        case_id=case.id, case_tags=",".join(case.tags),
                        difficulty=case.difficulty, repeat_index=rep,
                        ttft_ms=ttft, total_latency_ms=ttft + max(60, gen),
                        tokens_per_second=ctok / max((ttft + gen) / 1000, .1),
                        prompt_tokens=ptok, cached_prompt_tokens=cached,
                        completion_tokens=ctok, total_tokens=ptok + ctok,
                        cache_hit_ratio=cached / ptok,
                        http_status=200, ok=True, finish_reason="stop",
                        response_text="(seeded)", passed=passed,
                        scores_json='{"request_ok": 1.0}',
                        failed_assertions="" if passed else "seeded_failure",
                        cost_source="computed_from_catalogue",
                    )
                    fresh = ptok - cached
                    r.cost_input_usd = fresh * price_in / 1e6
                    r.cost_cached_usd = cached * price_in * 0.25 / 1e6
                    r.cost_output_usd = ctok * p_out / 1e6
                    r.cost_total_usd = (r.cost_input_usd + r.cost_cached_usd
                                        + r.cost_output_usd)
                    records.append(r)

        store.save(records, run_id)
        print(f"  week {w + 1}/{WEEKS}  {day:%Y-%m-%d}  {len(records):,} records")

    print("\nPlanted events the dashboard should surface:")
    print("  · deepseek-v3      TTFT regression, last two weeks")
    print("  · gemini-3-flash   served model repointed in the final week (CRITICAL)")
    print("  · claude-haiku-4.5 input price +25% in the final week")


if __name__ == "__main__":
    main()
