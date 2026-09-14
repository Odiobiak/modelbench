"""
Aggregation and the scorecard.

Two design choices worth stating, because they are the difference between a
number someone can act on and a number someone will misquote:

1. Latency is reported as percentiles, never as a mean. A mean hides the tail
   and the tail is what callers and users actually experience.

2. The headline economic figure is COST PER SUCCESSFUL CASE, not cost per
   token. A model that is 60% cheaper per token but fails 15% more often is
   more expensive, and only this framing shows it.

Output is a decision matrix, not a leaderboard. There is rarely one winner:
the point is to see which model wins on which axis.
"""

from __future__ import annotations

import html
import json
import os
from datetime import datetime, timezone

import pandas as pd


# ── aggregation ───────────────────────────────────────────────────────
def summarize(df: pd.DataFrame, percentiles=(50, 90, 95, 99)) -> pd.DataFrame:
    if df.empty:
        return pd.DataFrame()

    rows = []
    for alias, g in df.groupby("model_alias"):
        ok = g[g["ok"] == True]  # noqa: E712
        n = len(g)
        n_ok = len(ok)
        n_pass = int((g["passed"] == True).sum())  # noqa: E712

        row: dict = {
            "model_alias": alias,
            "vendor": g["vendor"].mode().iat[0] if not g["vendor"].mode().empty else "",
            "model_served": (g["model_served"].mode().iat[0]
                             if not g["model_served"].mode().empty else ""),
            "served_by": (g["served_by_provider"].mode().iat[0]
                          if not g["served_by_provider"].mode().empty else ""),
            "calls": n,
            "error_rate": round(1 - n_ok / n, 4) if n else None,
            "rate_limited": int(g["rate_limited"].sum()),
            "pass_rate": round(n_pass / n, 4) if n else None,
        }

        for metric, col in (("ttft_ms", "ttft_ms"), ("latency_ms", "total_latency_ms")):
            series = ok[col].dropna()
            for p in percentiles:
                row[f"{metric}_p{p}"] = round(float(series.quantile(p / 100)), 1) if len(series) else None

        row["tokens_per_second"] = (round(float(ok["tokens_per_second"].median()), 1)
                                    if len(ok["tokens_per_second"].dropna()) else None)
        for col, name in (("prompt_tokens", "avg_prompt_tokens"),
                          ("completion_tokens", "avg_completion_tokens"),
                          ("reasoning_tokens", "avg_reasoning_tokens"),
                          ("cached_prompt_tokens", "avg_cached_tokens")):
            vals = ok[col].dropna()
            row[name] = round(float(vals.mean()), 1) if len(vals) else None

        cost = ok["cost_total_usd"].dropna()
        total_cost = float(cost.sum()) if len(cost) else 0.0
        row["avg_cost_usd"] = round(float(cost.mean()), 8) if len(cost) else None
        row["cost_per_1k_calls"] = round(float(cost.mean()) * 1000, 4) if len(cost) else None
        # The number that actually decides things.
        row["cost_per_success"] = round(total_cost / n_pass, 8) if n_pass else None

        # Judge overhead -- a real, billable call the scorecard's own cost
        # columns above never see (see bench/schema.py's judge_cost_usd).
        # judge_cost_usd/judge_total_latency_ms are newer columns -- a run
        # written before this existed has no such column at all (not just
        # nulls), so a plain g["..."] would KeyError on old parquet files.
        judge_cost = g["judge_cost_usd"].dropna() if "judge_cost_usd" in g.columns else pd.Series(dtype=float)
        row["judge_calls"] = int(g["judge_model"].fillna("").astype(bool).sum())
        row["judge_cost_usd"] = round(float(judge_cost.sum()), 6) if len(judge_cost) else None
        judge_lat = g["judge_total_latency_ms"].dropna() if "judge_total_latency_ms" in g.columns else pd.Series(dtype=float)
        row["avg_judge_latency_ms"] = round(float(judge_lat.mean()), 1) if len(judge_lat) else None

        # Per-pack pass rates become the scorecard columns.
        for pack, pg in g.groupby("suite_pack"):
            label = pack.split("_", 1)[-1]
            row[f"pack.{label}"] = round(float((pg["passed"] == True).mean()), 4)  # noqa: E712

        rows.append(row)

    out = pd.DataFrame(rows).sort_values("pass_rate", ascending=False)
    return out.reset_index(drop=True)


# Two different model aliases that share a long prefix (e.g.
# "gem-gemini-3.1-flash-lite" and "gem-gemini-3.1-flash-lite-preview") must
# never render as the same fixed-width, silently-truncated string -- that
# reads as duplicate rows for one model instead of two distinct models.
_NAME_COL_MIN = 26
_NAME_COL_MAX = 40


def _name_col_width(aliases) -> int:
    longest = max((len(str(a)) for a in aliases), default=0)
    return max(_NAME_COL_MIN, min(_NAME_COL_MAX, longest + 1))


def _fit_name(name: str, width: int) -> str:
    name = str(name)
    if len(name) > width - 1:
        return name[:width - 2] + "…"
    return name


def latency_table(df: pd.DataFrame, authoritative: bool) -> str:
    """
    Latency broken out by prompt-size tier, because TTFT scales with input
    length and a single blended number hides the thing you need to know.
    """
    if df.empty:
        return "No results."
    ok = df[df["ok"] == True]  # noqa: E712
    if ok.empty:
        return "No successful calls."

    def tier_of(tags: str) -> str:
        for t in ("small", "medium", "large"):
            if f"tier-{t}" in str(tags):
                return t
        return "other"

    ok = ok.copy()
    ok["tier"] = ok["case_tags"].map(tier_of)

    name_w = _name_col_width(ok["model_alias"].unique())
    head = (f"{'MODEL':<{name_w}}{'TIER':>8}{'N':>6}"
            f"{'TTFT p50':>10}{'TTFT p95':>10}{'TTFT p99':>10}"
            f"{'TOT p95':>10}{'TOK/S':>8}")
    lines = [head, "-" * len(head)]
    for alias, g in ok.groupby("model_alias"):
        for tier in ("small", "medium", "large"):
            tg = g[g["tier"] == tier]
            if tg.empty:
                continue
            t = tg["ttft_ms"].dropna()
            tot = tg["total_latency_ms"].dropna()
            tps = tg["tokens_per_second"].dropna()
            lines.append(
                f"{_fit_name(alias, name_w):<{name_w}}{tier:>8}{len(tg):>6}"
                f"{(t.quantile(.50) if len(t) else 0):>10.0f}"
                f"{(t.quantile(.95) if len(t) else 0):>10.0f}"
                f"{(t.quantile(.99) if len(t) else 0):>10.0f}"
                f"{(tot.quantile(.95) if len(tot) else 0):>10.0f}"
                f"{(tps.median() if len(tps) else 0):>8.1f}")

    if authoritative:
        lines.append("\n  ABSOLUTE: direct vendor routes, no gateway hop. "
                     "Safe to quote, for this region and time of day.")
    else:
        lines.append("\n  RELATIVE ONLY: includes a gateway hop. Valid for ranking "
                     "models against each other,\n  since every model pays the same "
                     "tax. Do NOT quote these as absolute latency.")
    return "\n".join(lines)


def failure_digest(df: pd.DataFrame, limit: int = 40) -> pd.DataFrame:
    """Which assertions are failing most. This is your triage list."""
    if df.empty or "failed_assertions" not in df:
        return pd.DataFrame()
    rows = []
    for _, r in df[df["passed"] == False].iterrows():  # noqa: E712
        for item in str(r.get("failed_assertions") or "").split(","):
            if not item:
                continue
            rows.append({
                "model_alias": r["model_alias"],
                "pack": r["suite_pack"],
                "case_id": r["case_id"],
                "assertion": item.split("(")[0],
                "detail": item,
            })
    if not rows:
        return pd.DataFrame()
    fdf = pd.DataFrame(rows)
    agg = (fdf.groupby(["model_alias", "pack", "assertion"])
              .size().reset_index(name="failures")
              .sort_values("failures", ascending=False).head(limit))
    return agg


# ── console ───────────────────────────────────────────────────────────
def console_table(summary: pd.DataFrame) -> str:
    if summary.empty:
        return "No results."
    packs = [c for c in summary.columns if c.startswith("pack.")]
    name_w = _name_col_width(summary["model_alias"])
    head = f"{'MODEL':<{name_w}}{'PASS':>7}{'ERR':>7}"
    for p in packs:
        head += f"{p[5:][:9]:>10}"
    head += f"{'TTFTp95':>9}{'LATp95':>9}{'$/SUCCESS':>11}"
    lines = [head, "-" * len(head)]
    for _, r in summary.iterrows():
        line = f"{_fit_name(r['model_alias'], name_w):<{name_w}}"
        line += f"{(r['pass_rate'] or 0)*100:>6.1f}%"
        line += f"{(r['error_rate'] or 0)*100:>6.1f}%"
        for p in packs:
            v = r.get(p)
            line += f"{(v*100 if pd.notna(v) else 0):>9.0f}%"
        line += f"{(r.get('ttft_ms_p95') or 0):>9.0f}"
        line += f"{(r.get('latency_ms_p95') or 0):>9.0f}"
        cps = r.get("cost_per_success")
        line += f"{('$'+format(cps,'.5f')) if pd.notna(cps) else '-':>11}"
        lines.append(line)
    return "\n".join(lines)


# ── HTML scorecard ────────────────────────────────────────────────────
def _cell(value, threshold=None, lower_is_better=False):
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return '<td class="na">-</td>'
    if threshold is None:
        return f"<td>{value}</td>"
    good = value <= threshold if lower_is_better else value >= threshold
    cls = "good" if good else "bad"
    return f'<td class="{cls}">{value:.0%}</td>'


def render_html(summary: pd.DataFrame, raw: pd.DataFrame, settings: dict,
                out_path: str) -> str:
    th = settings.get("thresholds", {}) or {}
    title = settings.get("report", {}).get("title", "Text Model Bench")
    packs = [c for c in summary.columns if c.startswith("pack.")]
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    total_cost = float(raw["cost_total_usd"].fillna(0).sum()) if not raw.empty else 0.0
    run_ids = ", ".join(sorted(raw["run_id"].dropna().unique())[-3:]) if not raw.empty else ""

    pack_head = "".join(f"<th>{html.escape(p[5:].replace('_',' '))}</th>" for p in packs)

    body_rows = []
    for _, r in summary.iterrows():
        cells = [
            f"<td class='model'><strong>{html.escape(str(r['model_alias']))}</strong>"
            f"<span class='sub'>{html.escape(str(r['vendor']))}"
            f"{' · via ' + html.escape(str(r['served_by'])) if r['served_by'] else ''}</span></td>",
            _cell(r["pass_rate"], 0.90),
            f"<td>{(r['error_rate'] or 0):.1%}</td>",
        ]
        for p in packs:
            cells.append(_cell(r.get(p), 0.90))
        cells += [
            f"<td>{(r.get('ttft_ms_p50') or 0):.0f}</td>",
            f"<td class='{'good' if (r.get('ttft_ms_p95') or 0) <= th.get('ttft_p95_ms', 800) else 'bad'}'>"
            f"{(r.get('ttft_ms_p95') or 0):.0f}</td>",
            f"<td class='{'good' if (r.get('latency_ms_p95') or 0) <= th.get('turn_latency_p95_ms', 1500) else 'bad'}'>"
            f"{(r.get('latency_ms_p95') or 0):.0f}</td>",
            f"<td>{(r.get('avg_prompt_tokens') or 0):.0f} / {(r.get('avg_completion_tokens') or 0):.0f}</td>",
            f"<td>${(r.get('cost_per_1k_calls') or 0):.3f}</td>",
            f"<td class='hero'>${(r.get('cost_per_success') or 0):.5f}</td>",
        ]
        body_rows.append("<tr>" + "".join(cells) + "</tr>")

    # Provenance block: exactly what was tested, so a result stays interpretable.
    prov_rows = []
    if not raw.empty:
        cols = ["model_alias", "model_requested", "model_served", "served_by_provider",
                "vendor", "context_window", "price_input_per_mtok",
                "price_output_per_mtok", "pricing_captured_at", "region",
                "deployment_type", "temperature"]
        prov = raw[[c for c in cols if c in raw.columns]].drop_duplicates("model_alias")
        for _, r in prov.iterrows():
            prov_rows.append(
                "<tr>" + "".join(
                    f"<td>{html.escape(str(r.get(c, '')))}</td>" for c in prov.columns
                ) + "</tr>")
        prov_head = "".join(f"<th>{c.replace('_',' ')}</th>" for c in prov.columns)
    else:
        prov_head = ""

    fails = failure_digest(raw)
    fail_rows = "".join(
        f"<tr><td>{html.escape(str(r['model_alias']))}</td>"
        f"<td>{html.escape(str(r['pack']))}</td>"
        f"<td><code>{html.escape(str(r['assertion']))}</code></td>"
        f"<td>{r['failures']}</td></tr>"
        for _, r in fails.iterrows()) or "<tr><td colspan=4 class='na'>No failures.</td></tr>"

    doc = f"""<title>{html.escape(title)}</title>
<style>
  :root {{
    --bg:#fbfbfa; --panel:#fff; --ink:#1d1c1a; --muted:#6b6862;
    --line:#e6e3dd; --good:#0f7b53; --goodbg:#e8f5ee;
    --bad:#b0341f; --badbg:#fceeeb; --accent:#3694FC;
  }}
  @media (prefers-color-scheme: dark) {{
    :root:not([data-theme="light"]) {{
      --bg:#17181a; --panel:#1e2023; --ink:#e9e7e3; --muted:#9a968e;
      --line:#31343a; --good:#4ade9f; --goodbg:#12312a;
      --bad:#ff8f78; --badbg:#3a1c17; --accent:#6aaefd;
    }}
  }}
  :root[data-theme="dark"] {{
    --bg:#17181a; --panel:#1e2023; --ink:#e9e7e3; --muted:#9a968e;
    --line:#31343a; --good:#4ade9f; --goodbg:#12312a;
    --bad:#ff8f78; --badbg:#3a1c17; --accent:#6aaefd;
  }}
  body {{ background:var(--bg); color:var(--ink); margin:0;
         font:14px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif; }}
  .wrap {{ max-width:1400px; margin:0 auto; padding:40px 24px 80px; }}
  h1 {{ font-size:26px; margin:0 0 4px; letter-spacing:-.02em; }}
  h2 {{ font-size:15px; text-transform:uppercase; letter-spacing:.08em;
        color:var(--muted); margin:44px 0 12px; font-weight:600; }}
  .meta {{ color:var(--muted); font-size:13px; margin-bottom:8px; }}
  .panel {{ background:var(--panel); border:1px solid var(--line);
            border-radius:10px; overflow-x:auto; }}
  table {{ border-collapse:collapse; width:100%; font-size:13px; }}
  th {{ text-align:right; padding:11px 12px; font-weight:600; font-size:11px;
        text-transform:uppercase; letter-spacing:.05em; color:var(--muted);
        border-bottom:1px solid var(--line); white-space:nowrap; }}
  td {{ text-align:right; padding:11px 12px;
        border-bottom:1px solid var(--line); white-space:nowrap; }}
  tr:last-child td {{ border-bottom:none; }}
  th:first-child, td:first-child {{ text-align:left; }}
  td.model {{ line-height:1.3; }}
  .sub {{ display:block; color:var(--muted); font-size:11px; }}
  .good {{ color:var(--good); background:var(--goodbg); font-weight:600; }}
  .bad  {{ color:var(--bad);  background:var(--badbg);  font-weight:600; }}
  .hero {{ font-weight:700; color:var(--accent); }}
  .na {{ color:var(--muted); }}
  code {{ font-size:12px; background:var(--bg); padding:1px 5px; border-radius:4px; }}
  .note {{ color:var(--muted); font-size:12.5px; margin:10px 2px 0; max-width:70ch; }}
</style>
<div class="wrap">
  <h1>{html.escape(title)}</h1>
  <div class="meta">{generated} &nbsp;·&nbsp; {len(raw):,} calls &nbsp;·&nbsp;
      {summary.shape[0]} models &nbsp;·&nbsp; ${total_cost:.4f} spent
      &nbsp;·&nbsp; runs: {html.escape(run_ids)}</div>

  <h2>Decision matrix</h2>
  <div class="panel"><table>
    <thead><tr>
      <th>Model</th><th>Pass</th><th>Err</th>{pack_head}
      <th>TTFT p50</th><th>TTFT p95</th><th>Lat p95</th>
      <th>Tok in/out</th><th>$/1k calls</th><th>$/success</th>
    </tr></thead>
    <tbody>{''.join(body_rows)}</tbody>
  </table></div>
  <p class="note">There is usually no single winner. Read this by column:
  the model you put on a regulated workload is the one that wins grounding and
  hallucination, not the one with the best average. <strong>$/success</strong> is
  the headline economic figure: total spend divided by cases actually passed.
  A cheaper model that fails more often lands higher here, which is correct.</p>

  <h2>Top failing assertions</h2>
  <div class="panel"><table>
    <thead><tr><th>Model</th><th>Pack</th><th>Assertion</th><th>Failures</th></tr></thead>
    <tbody>{fail_rows}</tbody>
  </table></div>

  <h2>Provenance</h2>
  <div class="panel"><table>
    <thead><tr>{prov_head}</tr></thead>
    <tbody>{''.join(prov_rows)}</tbody>
  </table></div>
  <p class="note">Prices are snapshotted at run time, not looked up later.
  <code>model served</code> and <code>served by</code> are what actually ran the
  request, which is not always what you asked for. Keep these columns whenever
  you quote a result: without them a number is not reproducible.</p>
</div>"""

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w") as fh:
        fh.write(doc)
    return out_path
