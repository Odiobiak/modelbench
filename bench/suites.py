"""Suite loading. A pack is a YAML file; a case is one entry in it."""

from __future__ import annotations

import glob
import os
from dataclasses import dataclass, field
from typing import Any

import yaml


@dataclass
class Case:
    id: str
    pack: str
    pack_version: str
    messages: list[dict[str, Any]]
    system: str = ""
    tools: list[dict] = field(default_factory=list)
    response_format: dict | None = None
    max_tokens: int | None = None
    assertions: list[dict] = field(default_factory=list)
    reference: dict = field(default_factory=dict)
    judge: dict = field(default_factory=dict)
    tags: list[str] = field(default_factory=list)
    difficulty: str = "medium"

    def build_messages(self) -> list[dict[str, Any]]:
        msgs: list[dict[str, Any]] = []
        if self.system:
            msgs.append({"role": "system", "content": self.system})
        msgs.extend(self.messages)
        return msgs


def load_suites(directory: str = "suites",
                packs: list[str] | None = None) -> list[Case]:
    cases: list[Case] = []
    for path in sorted(glob.glob(os.path.join(directory, "*.yaml"))):
        pack_name = os.path.splitext(os.path.basename(path))[0]
        if packs and pack_name not in packs and pack_name.split("_", 1)[-1] not in packs:
            continue
        with open(path) as fh:
            doc = yaml.safe_load(fh) or {}

        pack_version = str(doc.get("version", "1"))
        shared_system = doc.get("system", "")
        shared_tools = doc.get("tools", []) or []
        judge_defaults = doc.get("judge_defaults", {}) or {}

        for raw in doc.get("cases", []) or []:
            # A case is either a single `input` string or an explicit `messages` list.
            if "messages" in raw:
                messages = raw["messages"]
            else:
                messages = [{"role": "user", "content": raw["input"]}]

            judge = dict(judge_defaults)
            judge.update(raw.get("judge", {}) or {})
            if judge:
                judge.setdefault(
                    "user_input",
                    " | ".join(str(m.get("content", "")) for m in messages
                               if m.get("role") == "user"))

            cases.append(Case(
                id=raw["id"],
                pack=pack_name,
                pack_version=pack_version,
                messages=messages,
                system=raw.get("system", shared_system),
                tools=raw.get("tools", shared_tools),
                response_format=raw.get("response_format"),
                max_tokens=raw.get("max_tokens"),
                assertions=raw.get("assert", []) or [],
                reference=raw.get("reference", {}) or {},
                judge=judge,
                tags=raw.get("tags", []) or [],
                difficulty=raw.get("difficulty", "medium"),
            ))
    return cases


def list_packs(directory: str = "suites") -> list[str]:
    return [os.path.splitext(os.path.basename(p))[0]
            for p in sorted(glob.glob(os.path.join(directory, "*.yaml")))]
