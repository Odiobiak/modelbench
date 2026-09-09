"""
The trend dashboard.

The scorecard answers "which model is best today". This answers the question
that actually protects you: "what changed, and when".

Providers change models behind stable aliases and adjust prices without
announcement. A snapshot cannot see that. A trend can, which is why the drift
table sits at the top and the charts sit below it.

Self-contained: one HTML file, inline SVG built by vanilla JS, no CDN, no
build step. Opens from disk.
"""

from __future__ import annotations

import html
import json
import os
from datetime import datetime, timezone

import pandas as pd

# Validated categorical palette (see references/palette.md).
# Adjacent-pair CVD dE 9.1 light / 8.4 dark; normal-vision 19.6 / 19.3.
# Light mode carries a sub-3:1 contrast warning on three slots, so every
# series is DIRECT-LABELLED and a full table view ships below the charts.
SERIES_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100",
                "#e87ba4", "#008300", "#4a3aa7", "#e34948"]
SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500",
               "#d55181", "#008300", "#9085e9", "#e66767"]

MAX_SERIES = 8          # past this, fold into "Other" rather than inventing hues
DRIFT_THRESHOLD = 0.10  # 10% relative move between consecutive runs


# ── data prep ─────────────────────────────────────────────────────────
def _run_frame(df: pd.DataFrame) -> pd.DataFrame:
    """One row per (run, model): the series the charts are drawn from."""
    d = df.copy()
    d["ts"] = pd.to_datetime(d["ts_utc"], errors="coerce", utc=True)
    d["run_day"] = d["ts"].dt.strftime("%Y-%m-%d")

    rows = []
    for (run_id, alias), g in d.groupby(["run_id", "model_alias"]):
        ok = g[g["ok"] == True]  # noqa: E712
        n_pass = int((g["passed"] == True).sum())  # noqa: E712
        cost = ok["cost_total_usd"].dropna()
        ttft = ok["ttft_ms"].dropna()
        lat = ok["total_latency_ms"].dropna()
        cached = ok["cached_prompt_tokens"].dropna()
        prompt = ok["prompt_tokens"].dropna()

        rows.append({
            "run_id": run_id,
            "day": g["run_day"].iloc[0],
            "ts": g["ts"].min(),
            "model_alias": alias,
            "model_served": (g["model_served"].mode().iat[0]
                             if not g["model_served"].mode().empty else ""),
            "vendor": g["vendor"].mode().iat[0] if not g["vendor"].mode().empty else "",
            "calls": len(g),
            "pass_rate": n_pass / len(g) if len(g) else None,
            "error_rate": 1 - len(ok) / len(g) if len(g) else None,
            "ttft_p95": float(ttft.quantile(0.95)) if len(ttft) else None,
            "lat_p95": float(lat.quantile(0.95)) if len(lat) else None,
            "cost_per_success": float(cost.sum()) / n_pass if n_pass and len(cost) else None,
            "cache_ratio": (float(cached.sum()) / float(prompt.sum())
                            if len(prompt) and prompt.sum() else None),
            "price_in": (float(g["price_input_per_mtok"].dropna().iloc[0])
                         if len(g["price_input_per_mtok"].dropna()) else None),
            "authoritative_latency": bool(g.get("latency_authoritative", pd.Series([False])).any()),
        })
    out = pd.DataFrame(rows)
    return out.sort_values("ts").reset_index(drop=True) if not out.empty else out


def _series(rf: pd.DataFrame, metric: str, models: list[str]) -> dict:
    """Shape one metric into {labels, series} for the chart renderer."""
    days = sorted(rf["day"].unique())
    series = []
    for alias in models:
        g = rf[rf["model_alias"] == alias].groupby("day")[metric].mean()
        series.append({
            "name": alias,
            "values": [None if d not in g.index or pd.isna(g[d]) else round(float(g[d]), 6)
                       for d in days],
        })
    return {"labels": days, "series": series}


BASELINE_WINDOW = 4     # prior runs the latest is compared against


def detect_drift(rf: pd.DataFrame) -> list[dict]:
    """
    Compare each model's latest run against a BASELINE, not against the single
    previous run.

    Comparing consecutive runs only catches a regression on the day it lands.
    A shift that arrived two runs ago and stayed looks like "no change" to a
    consecutive-run check, which is precisely the failure you least want: a
    model that has been quietly slower for a fortnight and nobody noticed.

    The baseline is the median of up to the previous four runs. A median rather
    than a mean so one bad afternoon on the provider's side does not move it.
    """
    alerts = []
    metrics = [
        ("pass_rate", "Pass rate", False, "pct"),
        ("ttft_p95", "TTFT p95", True, "ms"),
        ("lat_p95", "Latency p95", True, "ms"),
        ("cost_per_success", "Cost per success", True, "usd"),
        ("price_in", "Input price", True, "price"),
    ]
    for alias, g in rf.groupby("model_alias"):
        g = g.sort_values("ts")
        if len(g) < 2:
            continue
        curr = g.iloc[-1]
        prior = g.iloc[-(BASELINE_WINDOW + 1):-1]
        n_base = len(prior)

        # Identity change is always an alert, whatever the metrics did. Checked
        # against the immediately preceding run, since it is an event not a trend.
        prev_served = g.iloc[-2]["model_served"]
        if prev_served and curr["model_served"] and prev_served != curr["model_served"]:
            alerts.append({
                "model": alias, "metric": "Served model changed", "severity": "critical",
                "before": prev_served, "after": curr["model_served"],
                "delta": "identity change",
                "note": "The provider swapped the model behind a stable alias. "
                        "Re-baseline before trusting any comparison across this line.",
            })

        for key, label, lower_better, fmt in metrics:
            base_vals = prior[key].dropna()
            b = curr[key]
            if base_vals.empty or pd.isna(b):
                continue
            a = float(base_vals.median())
            if not a:
                continue
            rel = (b - a) / abs(a)
            if abs(rel) < DRIFT_THRESHOLD:
                continue
            worse = (rel > 0) if lower_better else (rel < 0)
            sustained = len(base_vals) >= 2 and (
                (prior[key].dropna().iloc[-1] - a) / abs(a) > DRIFT_THRESHOLD / 2
                if lower_better else
                (prior[key].dropna().iloc[-1] - a) / abs(a) < -DRIFT_THRESHOLD / 2)
            note = ("Provider price change. Every cost figure before this point "
                    "used the old rate." if key == "price_in"
                    else "Regression." if worse else "Improvement.")
            if worse and sustained:
                note += " Already present in the previous run, so this has been " \
                        "in place for a while."
            alerts.append({
                "model": alias, "metric": label,
                "severity": "serious" if worse else "good",
                "before": f"{_fmt(a, fmt)} (base n={n_base})", "after": _fmt(b, fmt),
                "delta": f"{rel:+.0%}", "note": note,
            })
    order = {"critical": 0, "serious": 1, "good": 2}
    return sorted(alerts, key=lambda a: order.get(a["severity"], 3))


def _fmt(v, kind: str) -> str:
    if v is None or pd.isna(v):
        return "-"
    if kind == "pct":
        return f"{v:.1%}"
    if kind == "ms":
        return f"{v:,.0f} ms"
    if kind == "usd":
        return f"${v:.5f}"
    if kind == "price":
        return f"${v:.3f}/M"
    return str(v)


def version_log(rf: pd.DataFrame) -> list[dict]:
    """Every point at which model_served changed while the alias stayed put."""
    log = []
    for alias, g in rf.groupby("model_alias"):
        g = g.sort_values("ts")
        prev = None
        for _, r in g.iterrows():
            served = r["model_served"]
            if served and prev and served != prev:
                log.append({"day": r["day"], "model": alias,
                            "from": prev, "to": served})
            if served:
                prev = served
    return sorted(log, key=lambda x: x["day"], reverse=True)


# ── render ────────────────────────────────────────────────────────────
def render_dashboard(df: pd.DataFrame, settings: dict,
                     out_path: str = "results/dashboard.html") -> str:
    rf = _run_frame(df)
    if rf.empty:
        raise ValueError("no runs to chart")

    th = settings.get("thresholds", {}) or {}
    models = (rf.groupby("model_alias")["calls"].sum()
                .sort_values(ascending=False).index.tolist())
    folded = models[MAX_SERIES:]
    models = models[:MAX_SERIES]

    n_runs = rf["run_id"].nunique()
    n_days = rf["day"].nunique()
    alerts = detect_drift(rf)
    vlog = version_log(rf)
    crit = sum(1 for a in alerts if a["severity"] in ("critical", "serious"))
    latest_day = rf["day"].max()
    latest = rf[rf["day"] == latest_day]
    authoritative = bool(rf["authoritative_latency"].any())

    charts = {
        "pass": {"data": _series(rf, "pass_rate", models), "fmt": "pct",
                 "title": "Pass rate over time",
                 "sub": "Every pack combined. A step down is a regression or a silent model change.",
                 "threshold": 0.90},
        "ttft": {"data": _series(rf, "ttft_p95", models), "fmt": "ms",
                 "title": "TTFT p95 over time",
                 "sub": ("Absolute: direct vendor routes." if authoritative else
                         "Relative only: includes a gateway hop. Valid for ranking, not for quoting."),
                 "threshold": th.get("ttft_p95_ms", 800)},
        "cost": {"data": _series(rf, "cost_per_success", models), "fmt": "usd",
                 "title": "Cost per successful case over time",
                 "sub": "Total spend divided by cases passed. Rises when quality drops, not just when prices do.",
                 "threshold": None},
        "cache": {"data": _series(rf, "cache_ratio", models), "fmt": "pct",
                  "title": "Prompt cache hit ratio",
                  "sub": "Explains cost movements that otherwise look mysterious. A model that looks cheap because your prompt caches well will not stay cheap when the prompt changes.",
                  "threshold": None},
    }

    # Per-pack matrix for the most recent day.
    packs = sorted(df["suite_pack"].dropna().unique())
    matrix = []
    for alias in models:
        sub = df[(df["model_alias"] == alias)]
        row = {"model": alias, "cells": []}
        for pack in packs:
            pg = sub[sub["suite_pack"] == pack]
            row["cells"].append(None if pg.empty
                                else round(float((pg["passed"] == True).mean()), 4))  # noqa: E712
        matrix.append(row)

    payload = {
        "charts": charts,
        "seriesLight": SERIES_LIGHT,
        "seriesDark": SERIES_DARK,
    }

    alert_rows = "".join(
        f'<tr class="sev-{a["severity"]}">'
        f'<td><span class="dot"></span>{html.escape(a["model"])}</td>'
        f'<td>{html.escape(a["metric"])}</td>'
        f'<td class="mono">{html.escape(str(a["before"]))}</td>'
        f'<td class="mono">{html.escape(str(a["after"]))}</td>'
        f'<td class="mono strong">{html.escape(a["delta"])}</td>'
        f'<td class="note">{html.escape(a["note"])}</td></tr>'
        for a in alerts
    ) or ('<tr><td colspan="6" class="na">No metric moved more than '
          f'{DRIFT_THRESHOLD:.0%} between the last two runs.</td></tr>')

    vlog_rows = "".join(
        f'<tr><td class="mono">{html.escape(v["day"])}</td>'
        f'<td>{html.escape(v["model"])}</td>'
        f'<td class="mono">{html.escape(v["from"])}</td>'
        f'<td class="mono">{html.escape(v["to"])}</td></tr>'
        for v in vlog
    ) or '<tr><td colspan="4" class="na">No served-model changes recorded.</td></tr>'

    pack_head = "".join(
        f'<th>{html.escape(p.split("_", 1)[-1].replace("_", " "))}</th>' for p in packs)
    pack_rows = ""
    for row in matrix:
        cells = ""
        for v in row["cells"]:
            if v is None:
                cells += '<td class="na">-</td>'
            else:
                cls = "good" if v >= 0.9 else ("warn" if v >= 0.7 else "bad")
                cells += f'<td class="{cls}">{v:.0%}</td>'
        pack_rows += f'<tr><td class="model">{html.escape(row["model"])}</td>{cells}</tr>'

    # Relief for the light-mode contrast warning: the full table, always present.
    table_rows = "".join(
        f'<tr><td class="mono">{html.escape(str(r["day"]))}</td>'
        f'<td>{html.escape(str(r["model_alias"]))}</td>'
        f'<td class="mono">{html.escape(str(r["model_served"]))}</td>'
        f'<td>{r["calls"]}</td>'
        f'<td>{_fmt(r["pass_rate"], "pct")}</td>'
        f'<td>{_fmt(r["ttft_p95"], "ms")}</td>'
        f'<td>{_fmt(r["lat_p95"], "ms")}</td>'
        f'<td>{_fmt(r["cost_per_success"], "usd")}</td></tr>'
        for _, r in rf.sort_values(["day", "model_alias"], ascending=[False, True]).iterrows()
    )

    folded_note = (f'<p class="note">Showing the {MAX_SERIES} models with the most '
                   f'calls. Not charted: {html.escape(", ".join(folded))}. '
                   f'They are in the table below.</p>' if folded else "")

    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    doc = f"""<title>Model Bench Dashboard</title>
<style>
  :root {{
    color-scheme: light;
    --bg:#fbfbfa; --surface:#ffffff; --surface-2:#f5f4f1;
    --ink:#0b0b0b; --ink-2:#52514e; --muted:#8a8880;
    --line:#e6e3dd; --grid:#eeece7;
    --good:#0f7b53; --goodbg:#e8f5ee;
    --warn:#8a6100; --warnbg:#fdf3e0;
    --bad:#b0341f;  --badbg:#fceeeb;
    --crit:#7a1d0d; --critbg:#f8e3de;
    --accent:#2a78d6;
  }}
  @media (prefers-color-scheme: dark) {{
    :root:not([data-theme="light"]) {{
      color-scheme: dark;
      --bg:#141516; --surface:#1a1a19; --surface-2:#212223;
      --ink:#ffffff; --ink-2:#c3c2b7; --muted:#8d8b83;
      --line:#2e3033; --grid:#26282a;
      --good:#4ade9f; --goodbg:#12312a;
      --warn:#e0a94a; --warnbg:#33280f;
      --bad:#ff8f78;  --badbg:#3a1c17;
      --crit:#ff6a4d; --critbg:#4a1c12;
      --accent:#3987e5;
    }}
  }}
  :root[data-theme="dark"] {{
    color-scheme: dark;
    --bg:#141516; --surface:#1a1a19; --surface-2:#212223;
    --ink:#ffffff; --ink-2:#c3c2b7; --muted:#8d8b83;
    --line:#2e3033; --grid:#26282a;
    --good:#4ade9f; --goodbg:#12312a;
    --warn:#e0a94a; --warnbg:#33280f;
    --bad:#ff8f78;  --badbg:#3a1c17;
    --crit:#ff6a4d; --critbg:#4a1c12;
    --accent:#3987e5;
  }}

  body {{ margin:0; background:var(--bg); color:var(--ink);
         font:14px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif; }}
  .wrap {{ max-width:1360px; margin:0 auto; padding:40px 24px 90px; }}
  h1 {{ font-size:26px; margin:0 0 4px; letter-spacing:-.02em; }}
  h2 {{ font-size:12px; text-transform:uppercase; letter-spacing:.09em;
        color:var(--muted); margin:46px 0 14px; font-weight:650; }}
  .meta {{ color:var(--ink-2); font-size:13px; }}

  .tiles {{ display:grid; gap:12px; margin-top:24px;
            grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); }}
  .tile {{ background:var(--surface); border:1px solid var(--line);
           border-radius:10px; padding:16px 18px; }}
  .tile .k {{ font-size:11px; text-transform:uppercase; letter-spacing:.07em;
              color:var(--muted); font-weight:600; }}
  .tile .v {{ font-size:27px; font-weight:680; letter-spacing:-.02em;
              margin-top:6px; font-variant-numeric:tabular-nums; }}
  .tile .s {{ font-size:12px; color:var(--ink-2); margin-top:3px; }}
  .tile.alarm .v {{ color:var(--bad); }}

  .panel {{ background:var(--surface); border:1px solid var(--line);
            border-radius:10px; overflow-x:auto; }}
  table {{ border-collapse:collapse; width:100%; font-size:13px; }}
  th {{ text-align:right; padding:10px 12px; font-size:11px; font-weight:620;
        text-transform:uppercase; letter-spacing:.05em; color:var(--muted);
        border-bottom:1px solid var(--line); white-space:nowrap; }}
  td {{ text-align:right; padding:10px 12px; border-bottom:1px solid var(--line);
        white-space:nowrap; }}
  tr:last-child td {{ border-bottom:none; }}
  th:first-child, td:first-child {{ text-align:left; }}
  td.note {{ text-align:left; white-space:normal; color:var(--ink-2);
             font-size:12.5px; min-width:260px; }}
  .mono {{ font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }}
  .strong {{ font-weight:680; }}
  .na {{ color:var(--muted); text-align:center; }}
  .good {{ color:var(--good); background:var(--goodbg); font-weight:620; }}
  .warn {{ color:var(--warn); background:var(--warnbg); font-weight:620; }}
  .bad  {{ color:var(--bad);  background:var(--badbg);  font-weight:620; }}

  .dot {{ display:inline-block; width:8px; height:8px; border-radius:50%;
          margin-right:8px; vertical-align:middle; background:var(--muted); }}
  .sev-critical .dot {{ background:var(--crit); }}
  .sev-serious  .dot {{ background:var(--bad); }}
  .sev-good     .dot {{ background:var(--good); }}
  .sev-critical td:first-child {{ font-weight:650; }}

  .charts {{ display:grid; gap:18px; grid-template-columns:repeat(auto-fit,minmax(560px,1fr)); }}
  .card {{ background:var(--surface); border:1px solid var(--line);
           border-radius:10px; padding:18px 18px 10px; position:relative; }}
  .card h3 {{ font-size:14px; margin:0 0 3px; font-weight:640; }}
  .card p.cs {{ margin:0 0 6px; font-size:12.5px; color:var(--ink-2); max-width:62ch; }}
  .legend {{ display:flex; flex-wrap:wrap; gap:12px; margin:8px 0 2px; }}
  .legend span {{ font-size:12px; color:var(--ink-2); display:flex;
                  align-items:center; gap:6px; }}
  .legend i {{ width:10px; height:10px; border-radius:3px; display:inline-block; }}
  .tip {{ position:absolute; pointer-events:none; opacity:0; transition:opacity .1s;
          background:var(--surface); border:1px solid var(--line); border-radius:8px;
          padding:8px 10px; font-size:12px; box-shadow:0 6px 20px rgba(0,0,0,.14);
          z-index:5; min-width:140px; }}
  .tip .th {{ font-weight:650; margin-bottom:5px; font-size:11.5px; color:var(--ink-2); }}
  .tip .r {{ display:flex; justify-content:space-between; gap:14px; line-height:1.7; }}
  .tip .r i {{ width:8px; height:8px; border-radius:2px; display:inline-block;
               margin-right:6px; }}
  .note {{ color:var(--ink-2); font-size:12.5px; max-width:78ch; margin:10px 2px 0; }}
  details {{ margin-top:14px; }}
  summary {{ cursor:pointer; color:var(--ink-2); font-size:12.5px; padding:4px 0; }}
</style>

<div class="wrap">
  <h1>Model Bench Dashboard</h1>
  <div class="meta">{generated} &nbsp;·&nbsp; {len(df):,} calls &nbsp;·&nbsp;
    {n_runs} runs over {n_days} day(s) &nbsp;·&nbsp; {rf['model_alias'].nunique()} models</div>

  <div class="tiles">
    <div class="tile{' alarm' if crit else ''}">
      <div class="k">Drift alerts</div><div class="v">{crit}</div>
      <div class="s">needing attention</div></div>
    <div class="tile">
      <div class="k">Version changes</div><div class="v">{len(vlog)}</div>
      <div class="s">alias pointed elsewhere</div></div>
    <div class="tile">
      <div class="k">Best pass rate</div>
      <div class="v">{_fmt(latest['pass_rate'].max(), 'pct')}</div>
      <div class="s">{html.escape(str(latest.loc[latest['pass_rate'].idxmax(), 'model_alias']) if latest['pass_rate'].notna().any() else '-')}</div></div>
    <div class="tile">
      <div class="k">Cheapest per success</div>
      <div class="v">{_fmt(latest['cost_per_success'].min(), 'usd')}</div>
      <div class="s">{html.escape(str(latest.loc[latest['cost_per_success'].idxmin(), 'model_alias']) if latest['cost_per_success'].notna().any() else '-')}</div></div>
    <div class="tile">
      <div class="k">Latency basis</div>
      <div class="v" style="font-size:19px">{'Absolute' if authoritative else 'Relative'}</div>
      <div class="s">{'direct vendor routes' if authoritative else 'gateway hop included'}</div></div>
  </div>

  <h2>Drift vs baseline</h2>
  <div class="panel"><table>
    <thead><tr><th>Model</th><th>Metric</th><th>Before</th><th>After</th>
      <th>Change</th><th>What it means</th></tr></thead>
    <tbody>{alert_rows}</tbody>
  </table></div>
  <p class="note">This table is the reason to run the bench on a schedule. A
  provider can repoint a stable alias at a new build, or change a price, without
  telling you. Anything marked <strong>Served model changed</strong> invalidates
  comparisons across that line until you re-baseline.</p>

  <h2>Trends</h2>
  <div class="charts">
    <div class="card"><h3>Pass rate over time</h3>
      <p class="cs">{html.escape(charts['pass']['sub'])}</p>
      <div id="c-pass"></div></div>
    <div class="card"><h3>TTFT p95 over time</h3>
      <p class="cs">{html.escape(charts['ttft']['sub'])}</p>
      <div id="c-ttft"></div></div>
    <div class="card"><h3>Cost per successful case</h3>
      <p class="cs">{html.escape(charts['cost']['sub'])}</p>
      <div id="c-cost"></div></div>
    <div class="card"><h3>Prompt cache hit ratio</h3>
      <p class="cs">{html.escape(charts['cache']['sub'])}</p>
      <div id="c-cache"></div></div>
  </div>
  {folded_note}

  <h2>Pass rate by pack, all history</h2>
  <div class="panel"><table>
    <thead><tr><th>Model</th>{pack_head}</tr></thead>
    <tbody>{pack_rows}</tbody>
  </table></div>
  <p class="note">Read this by column, not by row average. The model for a
  regulated workload is the one that wins grounding and hallucination.</p>

  <h2>Served-model change log</h2>
  <div class="panel"><table>
    <thead><tr><th>Date</th><th>Alias</th><th>From</th><th>To</th></tr></thead>
    <tbody>{vlog_rows}</tbody>
  </table></div>

  <h2>All runs</h2>
  <div class="panel"><table>
    <thead><tr><th>Day</th><th>Model</th><th>Served</th><th>Calls</th>
      <th>Pass</th><th>TTFT p95</th><th>Lat p95</th><th>$/success</th></tr></thead>
    <tbody>{table_rows}</tbody>
  </table></div>
</div>

<script>
const DATA = {json.dumps(payload)};

function palette() {{
  const dark = document.documentElement.dataset.theme === 'dark' ||
    (document.documentElement.dataset.theme !== 'light' &&
     matchMedia('(prefers-color-scheme: dark)').matches);
  return dark ? DATA.seriesDark : DATA.seriesLight;
}}

function fmt(v, kind) {{
  if (v === null || v === undefined) return '-';
  if (kind === 'pct') return (v * 100).toFixed(1) + '%';
  if (kind === 'ms')  return Math.round(v).toLocaleString() + ' ms';
  if (kind === 'usd') return '$' + v.toFixed(5);
  return String(v);
}}

function draw(elId, cfg) {{
  const host = document.getElementById(elId);
  if (!host) return;
  host.innerHTML = '';
  const {{ labels, series }} = cfg.data;
  const colors = palette();

  // Legend: always present for >=2 series (identity is never colour-alone).
  const leg = document.createElement('div');
  leg.className = 'legend';
  series.forEach((s, i) => {{
    const el = document.createElement('span');
    el.innerHTML = `<i style="background:${{colors[i % colors.length]}}"></i>${{s.name}}`;
    leg.appendChild(el);
  }});
  if (series.length >= 2) host.appendChild(leg);

  const W = host.clientWidth || 620, H = 260;
  const M = {{ t: 14, r: 128, b: 30, l: 58 }};  // right margin holds direct labels
  const iw = W - M.l - M.r, ih = H - M.t - M.b;

  const all = series.flatMap(s => s.values).filter(v => v !== null);
  if (!all.length) {{ host.innerHTML += '<p class="note">No data yet.</p>'; return; }}
  let lo = Math.min(...all), hi = Math.max(...all);
  if (cfg.threshold !== null && cfg.threshold !== undefined) {{
    lo = Math.min(lo, cfg.threshold); hi = Math.max(hi, cfg.threshold);
  }}
  const pad = (hi - lo) * 0.12 || (hi * 0.12) || 1;
  if (cfg.fmt === 'pct') {{
    // A rate cannot exceed 100%. Never draw an axis that implies it can.
    lo = Math.max(0, lo - pad);
    hi = Math.min(1, hi + pad);
    if (hi - lo < 0.05) {{ hi = Math.min(1, lo + 0.05); }}
  }} else {{
    lo = Math.max(0, lo - pad);
    hi = hi + pad;
  }}

  const n = labels.length;
  const X = i => M.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const Y = v => M.t + ih - ((v - lo) / (hi - lo || 1)) * ih;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${{W}} ${{H}}`);
  svg.setAttribute('width', '100%'); svg.setAttribute('height', H);
  svg.style.overflow = 'visible';

  const css = getComputedStyle(document.body);
  const grid = css.getPropertyValue('--grid').trim() || '#eee';
  const muted = css.getPropertyValue('--muted').trim() || '#999';
  const surface = css.getPropertyValue('--surface').trim() || '#fff';

  const add = (tag, attrs, parent) => {{
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    (parent || svg).appendChild(e); return e;
  }};

  // Recessive grid + y labels
  for (let i = 0; i <= 4; i++) {{
    const v = lo + (hi - lo) * (i / 4), y = Y(v);
    add('line', {{ x1: M.l, x2: M.l + iw, y1: y, y2: y, stroke: grid, 'stroke-width': 1 }});
    const t = add('text', {{ x: M.l - 9, y: y + 4, 'text-anchor': 'end',
                            fill: muted, 'font-size': 10.5 }});
    t.textContent = fmt(v, cfg.fmt);
  }}

  // Threshold reference line, dashed so it never reads as a series.
  // Labelled on the LEFT so it cannot collide with the direct labels on the right.
  if (cfg.threshold !== null && cfg.threshold !== undefined) {{
    const y = Y(cfg.threshold);
    add('line', {{ x1: M.l, x2: M.l + iw, y1: y, y2: y, stroke: muted,
                  'stroke-width': 1.5, 'stroke-dasharray': '5 4', opacity: .6 }});
    const t = add('text', {{ x: M.l + 6, y: y - 6, 'text-anchor': 'start',
                            fill: muted, 'font-size': 10.5 }});
    t.textContent = 'target ' + fmt(cfg.threshold, cfg.fmt);
  }}

  // X labels, thinned so they never collide
  const step = Math.max(1, Math.ceil(n / 7));
  labels.forEach((lab, i) => {{
    if (i % step && i !== n - 1) return;
    const t = add('text', {{ x: X(i), y: H - 9, 'text-anchor': 'middle',
                            fill: muted, 'font-size': 10.5 }});
    t.textContent = lab.slice(5);
  }});

  // Series: 2px lines, >=8px markers with a 2px surface ring where they overlap
  const endpoints = [];
  series.forEach((s, si) => {{
    const c = colors[si % colors.length];
    const pts = s.values.map((v, i) => v === null ? null : [X(i), Y(v)]);
    const segs = []; let cur = [];
    pts.forEach(p => {{ if (p) cur.push(p); else {{ if (cur.length) segs.push(cur); cur = []; }} }});
    if (cur.length) segs.push(cur);
    segs.forEach(seg => {{
      if (seg.length === 1) return;
      add('polyline', {{ points: seg.map(p => p.join(',')).join(' '), fill: 'none',
                        stroke: c, 'stroke-width': 2, 'stroke-linejoin': 'round',
                        'stroke-linecap': 'round' }});
    }});
    pts.forEach(p => {{ if (p) add('circle', {{ cx: p[0], cy: p[1], r: 4.5, fill: c,
                                              stroke: surface, 'stroke-width': 2 }}); }});
    for (let i = pts.length - 1; i >= 0; i--) {{
      if (pts[i]) {{
        endpoints.push({{ name: s.name, color: c,
                         x: pts[i][0], y: pts[i][1], y0: pts[i][1] }});
        break;
      }}
    }}
  }});

  // Direct labels at the line ends. This is the relief that lets the light-mode
  // palette ship despite its sub-3:1 contrast warning, so the labels must stay
  // readable: when series converge, push them apart vertically and draw a
  // leader line back to the true endpoint rather than letting them overprint.
  endpoints.sort((a, b) => a.y - b.y);
  const GAP = 14;
  for (let i = 1; i < endpoints.length; i++) {{
    if (endpoints[i].y - endpoints[i - 1].y < GAP) {{
      endpoints[i].y = endpoints[i - 1].y + GAP;
    }}
  }}
  // If pushing overflowed the plot, shift the whole stack back up.
  const overflow = endpoints.length
    ? endpoints[endpoints.length - 1].y - (M.t + ih) : 0;
  if (overflow > 0) endpoints.forEach(e => {{ e.y -= overflow; }});

  endpoints.forEach(e => {{
    // Leader line from the true data point across to the nudged label slot.
    add('path', {{
      d: `M ${{e.x + 6}} ${{e.y0}} L ${{M.l + iw + 4}} ${{e.y0}} `
       + `L ${{M.l + iw + 8}} ${{e.y}}`,
      stroke: e.color, 'stroke-width': 1, opacity: .4, fill: 'none' }});
    const t = add('text', {{ x: M.l + iw + 12, y: e.y + 4, fill: e.color,
                            'font-size': 11.5, 'font-weight': 600 }});
    t.textContent = e.name.length > 18 ? e.name.slice(0, 17) + '…' : e.name;
  }});

  // Crosshair + tooltip
  const cross = add('line', {{ x1: 0, x2: 0, y1: M.t, y2: M.t + ih, stroke: muted,
                              'stroke-width': 1, opacity: 0 }});
  const tip = document.createElement('div'); tip.className = 'tip';
  host.parentElement.appendChild(tip);
  const hit = add('rect', {{ x: M.l, y: M.t, width: iw, height: ih,
                            fill: 'transparent' }});
  hit.style.cursor = 'crosshair';
  hit.addEventListener('mousemove', ev => {{
    const box = svg.getBoundingClientRect();
    const px = (ev.clientX - box.left) * (W / box.width);
    let i = n === 1 ? 0 : Math.round(((px - M.l) / iw) * (n - 1));
    i = Math.max(0, Math.min(n - 1, i));
    cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i));
    cross.setAttribute('opacity', .35);
    tip.innerHTML = `<div class="th">${{labels[i]}}</div>` + series.map((s, si) =>
      `<div class="r"><span><i style="background:${{colors[si % colors.length]}}"></i>${{s.name}}</span>` +
      `<span>${{fmt(s.values[i], cfg.fmt)}}</span></div>`).join('');
    const hb = host.parentElement.getBoundingClientRect();
    tip.style.left = Math.min(ev.clientX - hb.left + 14, hb.width - 190) + 'px';
    tip.style.top = (ev.clientY - hb.top - 10) + 'px';
    tip.style.opacity = 1;
  }});
  hit.addEventListener('mouseleave', () => {{
    tip.style.opacity = 0; cross.setAttribute('opacity', 0);
  }});

  host.appendChild(svg);
}}

function drawAll() {{
  draw('c-pass',  DATA.charts.pass);
  draw('c-ttft',  DATA.charts.ttft);
  draw('c-cost',  DATA.charts.cost);
  draw('c-cache', DATA.charts.cache);
}}
drawAll();
addEventListener('resize', drawAll);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawAll);
</script>"""

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w") as fh:
        fh.write(doc)
    return out_path
