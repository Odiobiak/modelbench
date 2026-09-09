"""
Tier 1 scorers: deterministic, free, instant.

Run these first and run them on everything. In practice they catch the
majority of real production failures, because most production failures are
not subtle reasoning errors, they are a model that returned prose where
your parser expected JSON, or called a tool that does not exist.
"""

from __future__ import annotations

import json
import re
from typing import Any

import jsonschema


def _get_tool_calls(record) -> list[dict]:
    if not record.tool_calls_json:
        return []
    try:
        return json.loads(record.tool_calls_json)
    except json.JSONDecodeError:
        return []


def _extract_json(text: str) -> Any | None:
    """Tolerate fenced code blocks, which models emit constantly."""
    text = (text or "").strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"[\{\[].*[\}\]]", text, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                return None
    return None


# ── individual assertions ─────────────────────────────────────────────
# Each returns (passed: bool, score: float, detail: str)

def a_contains(record, value, **_):
    ok = value.lower() in (record.response_text or "").lower()
    return ok, float(ok), f"contains '{value}'"


def a_not_contains(record, value, **_):
    ok = value.lower() not in (record.response_text or "").lower()
    return ok, float(ok), f"must not contain '{value}'"


def a_not_contains_any(record, value, **_):
    text = (record.response_text or "").lower()
    hits = [v for v in value if v.lower() in text]
    return not hits, float(not hits), f"forbidden terms present: {hits}" if hits else "clean"


def a_regex(record, value, **_):
    ok = bool(re.search(value, record.response_text or "", re.I | re.S))
    return ok, float(ok), f"regex {value}"


def a_max_sentences(record, value, **_):
    text = (record.response_text or "").strip()
    n = len([s for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()])
    ok = n <= int(value)
    return ok, float(ok), f"{n} sentences (max {value})"


def a_max_words(record, value, **_):
    n = len((record.response_text or "").split())
    ok = n <= int(value)
    return ok, float(ok), f"{n} words (max {value})"


def a_is_json(record, value=True, **_):
    ok = _extract_json(record.response_text) is not None
    return ok, float(ok), "parseable JSON"


def a_json_schema(record, value, **_):
    obj = _extract_json(record.response_text)
    if obj is None:
        return False, 0.0, "not parseable JSON"
    try:
        jsonschema.validate(obj, value)
        return True, 1.0, "schema valid"
    except jsonschema.ValidationError as exc:
        return False, 0.0, f"schema: {exc.message[:120]}"


def a_tool_called(record, value, **_):
    names = [tc.get("name") for tc in _get_tool_calls(record)]
    ok = value in names
    return ok, float(ok), f"expected tool '{value}', got {names or 'none'}"


def a_no_tool_called(record, value=True, **_):
    names = [tc.get("name") for tc in _get_tool_calls(record)]
    return not names, float(not names), f"unexpected tool calls: {names}" if names else "no tools"


def a_tool_args(record, value, **_):
    """Exact match on the argument values that matter. Catches fabricated args."""
    calls = _get_tool_calls(record)
    if not calls:
        return False, 0.0, "no tool call made"
    try:
        args = json.loads(calls[0].get("arguments") or "{}")
    except json.JSONDecodeError:
        return False, 0.0, "tool arguments not valid JSON"
    wrong = {k: (args.get(k), v) for k, v in value.items()
             if str(args.get(k, "")).strip().lower() != str(v).strip().lower()}
    ok = not wrong
    return ok, float(ok), "args match" if ok else f"arg mismatch {wrong}"


def a_tool_in_allowlist(record, value, **_):
    """Hallucinated tool detection: any call to a tool we never offered."""
    names = [tc.get("name") for tc in _get_tool_calls(record)]
    invented = [n for n in names if n not in value]
    ok = not invented
    return ok, float(ok), f"hallucinated tools: {invented}" if invented else "all tools valid"


def a_refuses(record, value=True, **_):
    """Correct-refusal detection for unanswerable / false-premise cases."""
    patterns = [
        r"\b(i (don'?t|do not) (have|know))\b", r"\bnot (in|available in|found in|covered)\b",
        r"\bno information\b", r"\bcannot (find|determine|confirm|verify)\b",
        r"\bunable to (find|determine|confirm)\b", r"\bisn'?t (any )?(information|data)\b",
        r"\bnot (mentioned|specified|stated|provided)\b", r"\bI'?m not able to\b",
        r"\bdoes not appear\b", r"\bno record\b",
    ]
    text = record.response_text or ""
    ok = any(re.search(p, text, re.I) for p in patterns)
    return ok, float(ok), "refused appropriately" if ok else "answered anyway (fabrication)"


def a_max_latency_ms(record, value, **_):
    v = record.total_latency_ms
    ok = v is not None and v <= float(value)
    return ok, float(ok), f"{v:.0f}ms (budget {value}ms)" if v else "no latency recorded"


def a_max_ttft_ms(record, value, **_):
    v = record.ttft_ms
    ok = v is not None and v <= float(value)
    return ok, float(ok), f"TTFT {v:.0f}ms (budget {value}ms)" if v else "no TTFT recorded"


ASSERTIONS = {
    "contains": a_contains,
    "not_contains": a_not_contains,
    "not_contains_any": a_not_contains_any,
    "regex": a_regex,
    "max_sentences": a_max_sentences,
    "max_words": a_max_words,
    "is_json": a_is_json,
    "json_schema": a_json_schema,
    "tool_called": a_tool_called,
    "no_tool_called": a_no_tool_called,
    "tool_args": a_tool_args,
    "tool_in_allowlist": a_tool_in_allowlist,
    "refuses": a_refuses,
    "max_latency_ms": a_max_latency_ms,
    "max_ttft_ms": a_max_ttft_ms,
}


def run_deterministic(record, assertions: list[dict]) -> tuple[dict[str, float], list[str]]:
    """Returns ({metric: score}, [failed assertion names])."""
    scores: dict[str, float] = {}
    failed: list[str] = []
    for a in assertions or []:
        kind = a.get("type")
        fn = ASSERTIONS.get(kind)
        if not fn:
            continue
        name = a.get("metric", kind)
        try:
            ok, score, detail = fn(record, a.get("value"))
        except Exception as exc:
            ok, score, detail = False, 0.0, f"scorer error: {exc}"
        scores[name] = score
        if not ok:
            failed.append(f"{name}({detail})")
    return scores, failed
