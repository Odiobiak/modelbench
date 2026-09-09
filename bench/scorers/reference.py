"""
Tier 2 scorers: reference-based. Cheap, no model call.

Token-overlap F1 and entity recall. Deliberately dependency-light: no
embedding model, no extra service. If you later want semantic similarity,
add one embedding call here and nothing else in the harness changes.
"""

from __future__ import annotations

import re
from collections import Counter

_STOP = {
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "to", "of",
    "in", "on", "for", "and", "or", "it", "that", "this", "your", "you",
    "i", "we", "with", "at", "as", "by", "from", "will", "can",
}


def _tokens(text: str) -> list[str]:
    return [t for t in re.findall(r"[a-z0-9']+", (text or "").lower()) if t not in _STOP]


def token_f1(pred: str, ref: str) -> float:
    p, r = Counter(_tokens(pred)), Counter(_tokens(ref))
    if not p or not r:
        return 0.0
    overlap = sum((p & r).values())
    if overlap == 0:
        return 0.0
    precision = overlap / sum(p.values())
    recall = overlap / sum(r.values())
    return 2 * precision * recall / (precision + recall)


def entity_recall(pred: str, entities: list[str]) -> float:
    """
    Did the answer carry the facts that actually matter?

    More useful than overall similarity for contact-center work: an answer can
    be worded completely differently and still be correct, but if it dropped
    the case number it is wrong.
    """
    if not entities:
        return 1.0
    text = (pred or "").lower()
    hits = sum(1 for e in entities if str(e).lower() in text)
    return hits / len(entities)


def run_reference(record, spec: dict) -> tuple[dict[str, float], list[str]]:
    scores: dict[str, float] = {}
    failed: list[str] = []
    pred = record.response_text or ""

    if spec.get("expected_answer"):
        f1 = token_f1(pred, spec["expected_answer"])
        scores["answer_f1"] = round(f1, 4)
        if f1 < float(spec.get("min_answer_f1", 0.35)):
            failed.append(f"answer_f1({f1:.2f})")

    if spec.get("required_entities"):
        rec_score = entity_recall(pred, spec["required_entities"])
        scores["entity_recall"] = round(rec_score, 4)
        if rec_score < float(spec.get("min_entity_recall", 1.0)):
            missing = [e for e in spec["required_entities"]
                       if str(e).lower() not in pred.lower()]
            failed.append(f"entity_recall(missing {missing})")

    return scores, failed
