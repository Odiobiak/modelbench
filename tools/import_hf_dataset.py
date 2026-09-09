"""
Pull curated case packs from Hugging Face datasets via the datasets-server
REST API (https://datasets-server.huggingface.co) and write them out as
suites/*.yaml packs in this harness's native format (bench/suites.py).

No `datasets` library dependency -- the rows endpoint returns plain JSON,
and a well-spread sample of ~20-30 rows is all a benchmark pack needs.
Existing packs (00-09) are hand-curated adversarial probes around a
fictional persona; these imports are the opposite: broad, generic, sourced
straight from a public eval, one pack per dataset.

Usage:
    python tools/import_hf_dataset.py mmlu --limit 25
    python tools/import_hf_dataset.py truthfulqa --limit 20
    python tools/import_hf_dataset.py ifeval --limit 20
    python tools/import_hf_dataset.py all
"""
from __future__ import annotations

import argparse
import os
import random
import re
import time

import httpx
import yaml

API = "https://datasets-server.huggingface.co/rows"
SUITES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "suites")
_HEADERS = {"Authorization": f"Bearer {os.environ['HF_TOKEN']}"} if os.environ.get("HF_TOKEN") else {}


def _get(dataset: str, config: str, split: str, offset: int, length: int = 1) -> dict:
    # The free rows endpoint rate-limits fairly aggressively once a script
    # fires ~20-30 requests back to back; back off and retry rather than
    # failing an otherwise-fine import partway through.
    for attempt in range(6):
        r = httpx.get(
            API,
            params={"dataset": dataset, "config": config, "split": split, "offset": offset, "length": length},
            headers=_HEADERS,
            timeout=30,
        )
        if r.status_code == 429:
            time.sleep(2 ** attempt)
            continue
        r.raise_for_status()
        time.sleep(0.3)
        return r.json()
    r.raise_for_status()
    return r.json()


def _spread_offsets(total: int, n: int, seed: int = 7) -> list[int]:
    """n offsets spread evenly across the split, so a small sample still
    covers its full range (subjects/categories/instruction types) instead of
    just whatever happens to be on the first page."""
    n = min(n, total)
    step = total / n
    rng = random.Random(seed)
    return sorted({min(total - 1, int(i * step + rng.uniform(0, step * 0.8))) for i in range(n)})


def _yaml_dump(doc: dict, path: str) -> None:
    class _Dumper(yaml.SafeDumper):
        pass

    def _str_repr(dumper, data):
        style = "|" if "\n" in data else None
        return dumper.represent_scalar("tag:yaml.org,2002:str", data, style=style)

    _Dumper.add_representer(str, _str_repr)
    with open(path, "w") as fh:
        yaml.dump(doc, fh, Dumper=_Dumper, sort_keys=False, allow_unicode=True, width=100)
    print(f"wrote {path} ({len(doc['cases'])} cases)")


# ── MMLU ──────────────────────────────────────────────────────────────────
# cais/mmlu, config "all", split "test": {question, subject, choices[4], answer(0-3)}
# Multiple choice with a known letter answer -> pure deterministic scoring,
# the same shape as the enum-constrained-output case in 01_instruction_following.yaml.

def import_mmlu(limit: int, out: str) -> None:
    dataset, config, split = "cais/mmlu", "all", "test"
    total = _get(dataset, config, split, 0)["num_rows_total"]
    cases = []
    for off in _spread_offsets(total, limit):
        row = _get(dataset, config, split, off)["rows"][0]["row"]
        letters = "ABCD"
        choices_block = "\n".join(f"{letters[i]}. {c}" for i, c in enumerate(row["choices"]))
        correct = letters[row["answer"]]
        cases.append({
            "id": f"mmlu-{row['subject']}-{off}",
            "difficulty": "medium",
            "tags": ["knowledge", "mcq", row["subject"]],
            "input": f"{row['question']}\n\n{choices_block}\n\nReply with only the single correct letter, nothing else.",
            "assert": [{"type": "regex", "value": f"^\\s*{correct}\\b", "metric": "knowledge_correct"}],
        })
    doc = {
        "version": "1",
        "system": "Answer the multiple-choice question. Reply with only the letter of the correct option.",
        "cases": cases,
    }
    _yaml_dump(doc, out)


# ── TruthfulQA ───────────────────────────────────────────────────────────
# truthfulqa/truthful_qa, config "multiple_choice", split "validation":
# {question, mc1_targets:{choices,labels}}. mc1 has exactly one label==1 (the
# true answer); everything else is a documented common misconception. There's
# no single deterministic assert for "matches this fact and avoids that myth"
# in free text, so this pack is judge-graded -- same pattern as
# 04_hallucination.yaml.

def import_truthfulqa(limit: int, out: str) -> None:
    dataset, config, split = "truthfulqa/truthful_qa", "multiple_choice", "validation"
    total = _get(dataset, config, split, 0)["num_rows_total"]
    cases = []
    for off in _spread_offsets(total, limit):
        row = _get(dataset, config, split, off)["rows"][0]["row"]
        choices, labels = row["mc1_targets"]["choices"], row["mc1_targets"]["labels"]
        correct = choices[labels.index(1)]
        myths = [c for c, l in zip(choices, labels) if l == 0]
        cases.append({
            "id": f"truthfulqa-{off}",
            "difficulty": "hard",
            "tags": ["hallucination", "common-misconception"],
            "input": row["question"],
            "judge": {
                "context": f"True answer: {correct}",
                "criteria": {
                    "truthful": (
                        "The answer matches the true fact and does not repeat any of these "
                        f"common misconceptions: {' | '.join(myths)}"
                    ),
                },
                "thresholds": {"truthful": 0.8},
            },
        })
    doc = {
        "version": "1",
        "system": "Answer truthfully and concisely. Do not repeat common misconceptions even if they sound plausible or are widely believed.",
        "judge_defaults": {"min_score": 0.8},
        "cases": cases,
    }
    _yaml_dump(doc, out)


# ── IFEval ───────────────────────────────────────────────────────────────
# google/IFEval, config "default", split "train": {key, prompt, instruction_id_list, kwargs}.
# ~25 distinct verifiable-instruction types; only a handful translate cleanly
# onto this harness's existing deterministic assertions (bench/scorers/
# deterministic.py has no min-length, keyword-frequency, or bullet-counting
# checks). Every case still gets a judge fallback against the raw prompt, so
# untranslated instruction kinds aren't scored blind -- they just lose the
# free deterministic signal the mapped ones get.

def _ifeval_asserts(iid: str, kw: dict) -> list[dict]:
    if iid == "keywords:existence" and kw.get("keywords"):
        return [{"type": "contains", "value": k, "metric": "instruction_keyword"} for k in kw["keywords"]]
    if iid == "keywords:forbidden_words" and kw.get("forbidden_words"):
        return [{"type": "not_contains_any", "value": kw["forbidden_words"], "metric": "instruction_forbidden"}]
    if iid == "length_constraints:number_words" and kw.get("num_words") and kw.get("relation") == "less than":
        return [{"type": "max_words", "value": kw["num_words"] - 1, "metric": "instruction_length"}]
    if iid == "length_constraints:number_sentences" and kw.get("num_sentences") and kw.get("relation") == "less than":
        return [{"type": "max_sentences", "value": kw["num_sentences"] - 1, "metric": "instruction_length"}]
    if iid == "detectable_format:json_format":
        return [{"type": "is_json", "metric": "instruction_format"}]
    if iid == "punctuation:no_comma":
        return [{"type": "not_contains", "value": ",", "metric": "instruction_punctuation"}]
    if iid == "startend:end_checker" and kw.get("end_phrase"):
        return [{"type": "regex", "value": re.escape(kw["end_phrase"].strip()) + r"\s*$", "metric": "instruction_end"}]
    if iid == "change_case:english_lowercase":
        return [{"type": "regex", "value": "^[^A-Z]*$", "metric": "instruction_case"}]
    if iid == "change_case:english_capital":
        return [{"type": "regex", "value": "^[^a-z]*$", "metric": "instruction_case"}]
    return []


def import_ifeval(limit: int, out: str) -> None:
    dataset, config, split = "google/IFEval", "default", "train"
    total = _get(dataset, config, split, 0)["num_rows_total"]
    cases = []
    for off in _spread_offsets(total, limit):
        row = _get(dataset, config, split, off)["rows"][0]["row"]
        asserts = []
        for iid, kw in zip(row["instruction_id_list"], row["kwargs"]):
            asserts.extend(_ifeval_asserts(iid, kw or {}))
        case = {
            "id": f"ifeval-{row['key']}",
            "difficulty": "medium",
            "tags": ["instruction-following"] + sorted({iid.split(":")[0] for iid in row["instruction_id_list"]}),
            "input": row["prompt"],
            "judge": {
                "criteria": {
                    "instruction_followed": "The response fully satisfies every constraint stated in the prompt, not just its content.",
                },
                "thresholds": {"instruction_followed": 0.8},
            },
        }
        if asserts:
            case["assert"] = asserts
        cases.append(case)
    doc = {
        "version": "1",
        "system": "Follow every instruction in the prompt exactly, including formatting and structural constraints.",
        "judge_defaults": {"min_score": 0.8},
        "cases": cases,
    }
    _yaml_dump(doc, out)


IMPORTERS = {
    "mmlu": (import_mmlu, "10_knowledge_mmlu.yaml"),
    "truthfulqa": (import_truthfulqa, "11_truthfulqa_myths.yaml"),
    "ifeval": (import_ifeval, "12_ifeval_constraints.yaml"),
}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dataset", choices=[*IMPORTERS, "all"])
    ap.add_argument("--limit", type=int, default=25, help="cases to sample, spread across the full split")
    args = ap.parse_args()

    targets = IMPORTERS.items() if args.dataset == "all" else [(args.dataset, IMPORTERS[args.dataset])]
    for name, (fn, filename) in targets:
        print(f"importing {name}...")
        fn(args.limit, os.path.join(SUITES_DIR, filename))


if __name__ == "__main__":
    main()
