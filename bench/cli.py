"""
CLI.

    bench models                      # what is registered, and is it reachable
    bench packs                       # what suites exist
    bench estimate                    # projected spend, before you spend it
    bench run --models a,b --packs x  # the actual run
    bench run --mock                  # full pipeline, zero keys, zero spend
    bench report                      # rebuild the scorecard from history
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

import yaml
from dotenv import load_dotenv

from . import store
from .registry import ModelSpec, describe, load_registry
from .report import console_table, latency_table, render_html, summarize
from .runner import Runner, estimate_cost
from .suites import list_packs, load_suites


def _load_settings(path: str = "config/settings.yaml") -> dict:
    with open(path) as fh:
        settings = yaml.safe_load(fh) or {}
    env_cap = os.getenv("BENCH_MAX_SPEND_USD")
    if env_cap:
        run = settings.setdefault("run", {})
        run["max_spend_usd"] = min(float(run.get("max_spend_usd", 5.0)), float(env_cap))
    return settings


def _judge_spec(settings: dict) -> ModelSpec | None:
    cfg = settings.get("judge", {}) or {}
    if not cfg.get("enabled", True):
        return None
    spec = ModelSpec(
        id="__judge__",
        model=cfg.get("model", "anthropic/claude-sonnet-4.6"),
        route=cfg.get("route", "openrouter"),
        temperature=float(cfg.get("temperature", 0.0)),
        max_tokens=int(cfg.get("max_tokens", 512)),
    )
    spec.base_url = "https://openrouter.ai/api/v1"
    spec.api_key = os.getenv("OPENROUTER_API_KEY", "")
    spec.canonical_id = spec.model
    return spec


def _csv(value: str | None) -> list[str] | None:
    if not value or value.strip().lower() == "all":
        return None
    return [v.strip() for v in value.split(",") if v.strip()]


def main(argv=None) -> int:
    load_dotenv()
    p = argparse.ArgumentParser(prog="bench", description="Text model benchmark harness")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("models", help="list registered models and readiness")
    sub.add_parser("packs", help="list suite packs")

    for name in ("estimate", "run"):
        sp = sub.add_parser(name)
        sp.add_argument("--models", default="all")
        sp.add_argument("--packs", default="all")
        sp.add_argument("--repeats", type=int, default=None)
        if name == "run":
            sp.add_argument("--mock", action="store_true",
                            help="offline dry run, no keys and no spend")
            sp.add_argument("--no-judge", action="store_true")
            sp.add_argument("--quiet", action="store_true")

    lp = sub.add_parser(
        "latency",
        help="absolute latency probe. Forces route:direct so numbers carry no "
             "gateway hop and may be quoted to a customer.")
    lp.add_argument("--models", default="all")
    lp.add_argument("--repeats", type=int, default=20,
                    help="high by default; latency needs samples for a stable p95")
    lp.add_argument("--allow-gateway", action="store_true",
                    help="permit gateway-routed models. Results are then RELATIVE "
                         "ONLY and are marked as such.")
    lp.add_argument("--mock", action="store_true")
    lp.add_argument("--quiet", action="store_true")

    rp = sub.add_parser("report", help="rebuild scorecard from stored results")
    rp.add_argument("--all", action="store_true",
                    help="use full history instead of the latest run")
    rp.add_argument("--include-mock", action="store_true",
                    help="fold --mock dry-run rows into the result set (excluded by default)")

    dp = sub.add_parser("dashboard", help="build the trend dashboard from all history")
    dp.add_argument("--out", default="results/dashboard.html")
    dp.add_argument("--include-mock", action="store_true",
                    help="fold --mock dry-run rows into history (excluded by default)")

    args = p.parse_args(argv)
    settings = _load_settings()

    if args.cmd == "models":
        specs = load_registry(only=None, include_disabled=True)
        print(describe(specs))
        return 0

    if args.cmd == "packs":
        for pack in list_packs():
            print(" ", pack)
        return 0

    if args.cmd == "report":
        if args.all:
            df = store.load_all(include_mock=args.include_mock)
            if df.empty:
                print("No non-mock results found. Run `bench run` for real, or pass "
                      "--include-mock to report on dry-run data.")
                return 1
        else:
            df = store.load_run(store.latest_run_id() or "")
            if df.empty:
                print("No results found. Run `bench run --mock` first.")
                return 1
            if not args.include_mock and "served_by_provider" in df.columns \
                    and (df["served_by_provider"] == "mock").all():
                print("Note: the latest run is a --mock dry run; these are canned "
                      "responses, not model results.\n")
        summary = summarize(df, tuple(settings.get("report", {}).get("percentiles", [50, 90, 95, 99])))
        print(console_table(summary))
        out = render_html(summary, df, settings, "results/scorecard.html")
        print(f"\nScorecard: {out}")
        return 0

    if args.cmd == "dashboard":
        from .dashboard import render_dashboard
        df = store.load_all(include_mock=args.include_mock)
        if df.empty:
            print("No non-mock results found. Run `bench run` for real, or pass "
                  "--include-mock to build a dashboard from dry-run data.")
            return 1
        out = render_dashboard(df, settings, args.out)
        runs = df["run_id"].nunique()
        print(f"{len(df):,} calls across {runs} run(s) -> {out}")
        if runs < 2:
            print("Note: trends need at least 2 runs on different days to be meaningful.")
        return 0

    if args.cmd == "latency":
        only = _csv(args.models)
        specs = load_registry(only=only, include_disabled=bool(only))
        gateway = [s.id for s in specs if s.route != "direct"]

        if gateway and not args.allow_gateway and not args.mock:
            print("These models route through the gateway, so their latency includes "
                  "an extra network hop:\n")
            for name in gateway:
                print(f"    {name}")
            print("\nAbsolute latency requires route: direct with a vendor key.")
            print("See the azure-gpt-4.1-nano-swedencentral entry in config/models.yaml "
                  "for the shape.")
            print("\nTo measure relative ranking anyway (valid, but never quote it as "
                  "absolute):\n    bench latency --allow-gateway")
            return 1

        cases = load_suites(packs=["00_latency_probe"])
        if not specs or not cases:
            print("Nothing to probe.")
            return 1

        authoritative = all(s.route == "direct" for s in specs)
        settings.setdefault("run", {})["repeats"] = args.repeats
        settings.setdefault("judge", {})["enabled"] = False

        print(f"Latency probe: {len(specs)} models x {len(cases)} cases x "
              f"{args.repeats} repeats = {len(specs)*len(cases)*args.repeats:,} calls")
        print(f"Mode: {'ABSOLUTE (direct routes)' if authoritative else 'RELATIVE ONLY (gateway hop included)'}\n")

        runner = Runner(settings=settings, judge_spec=None,
                        mock=args.mock, verbose=not args.quiet)
        records = asyncio.run(runner.run(specs, cases))
        for rec in records:
            rec.latency_probe = True

        store.save(records, runner.run_id)
        df = store.load_run(runner.run_id)
        print("\n" + latency_table(df, authoritative))
        print(f"\nSpend: ${runner.spend:.4f}")
        return 0

    only = _csv(args.models)
    packs = _csv(args.packs)
    specs = load_registry(only=only, include_disabled=bool(only))
    cases = load_suites(packs=packs)
    repeats = args.repeats or int(settings.get("run", {}).get("repeats", 3))

    if not specs:
        print("No models selected. Check config/models.yaml or --models.")
        return 1
    if not cases:
        print("No cases selected. Check suites/ or --packs.")
        return 1

    if args.cmd == "estimate":
        total, per_model = estimate_cost(specs, cases, repeats)
        print(f"{len(specs)} models x {len(cases)} cases x {repeats} repeats "
              f"= {len(specs)*len(cases)*repeats:,} calls\n")
        for name, cost in sorted(per_model, key=lambda x: -x[1]):
            print(f"  {name:<34} ${cost:.4f}")
        print(f"\n  {'PROJECTED TOTAL':<34} ${total:.4f}")
        print(f"  {'ceiling':<34} ${settings['run']['max_spend_usd']:.2f}")
        if total > settings["run"]["max_spend_usd"]:
            print("\n  WARNING: projection exceeds the ceiling. The run will abort partway.")
        return 0

    # ── run ───────────────────────────────────────────────────────────
    unready = [s.id for s in specs if not s.is_ready]
    if unready and not args.mock:
        print(f"No credentials for: {', '.join(unready)}")
        print("Add keys to .env, or use --mock to exercise the pipeline offline.")
        return 1

    settings.setdefault("run", {})["repeats"] = repeats
    if args.no_judge:
        settings.setdefault("judge", {})["enabled"] = False

    print(f"Running {len(specs)} models x {len(cases)} cases x {repeats} repeats "
          f"= {len(specs)*len(cases)*repeats:,} calls"
          f"{'  [MOCK]' if args.mock else ''}")

    runner = Runner(
        settings=settings,
        judge_spec=None if args.mock else _judge_spec(settings),
        mock=args.mock,
        verbose=not args.quiet,
    )
    records = asyncio.run(runner.run(specs, cases))

    path = store.save(records, runner.run_id)
    df = store.load_run(runner.run_id)
    summary = summarize(df, tuple(settings.get("report", {}).get("percentiles", [50, 90, 95, 99])))

    print(f"\n{console_table(summary)}")
    print(f"\nSpend: ${runner.spend:.4f}")
    print(f"Data:  {path}")
    out = render_html(summary, df, settings, "results/scorecard.html")
    print(f"Card:  {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
