import { useEffect, useMemo, useState } from "react";
import Drawer from "../components/Drawer";
import RunLauncherPanel from "../components/RunLauncherPanel";
import CollapsiblePanel from "../components/CollapsiblePanel";
import { useAddCase, useAllCases, useCases, useDeleteCase, usePacks } from "../api/hooks";
import type { AssertionOut, CaseCheck, CaseOut, CaseTurn, CheckType, JudgeCriterion } from "../api/types";
import { toast } from "../toast";
import { ApiError } from "../api/client";

const CHECK_TYPES: { key: CheckType; label: string; kind: "text" | "list" | "number" | "none"; ph?: string }[] = [
  { key: "contains", label: "Contains text", kind: "text", ph: "exact phrase to find" },
  { key: "not_contains_any", label: "Doesn't contain any of", kind: "list", ph: "comma, separated, phrases" },
  { key: "regex", label: "Matches pattern (regex)", kind: "text", ph: "^\\s*MOVE\\s*$" },
  { key: "max_words", label: "Max words", kind: "number", ph: "25" },
  { key: "max_sentences", label: "Max sentences", kind: "number", ph: "2" },
  { key: "is_json", label: "Must be valid JSON", kind: "none" },
];

// The full-sentence explanation shown in the "view case" drawer and the
// worked example panel -- the list row itself only shows a count (see
// gradedSummary below), so a case with several checks never forces the row
// wider than the prompt it's showing.
function explainCheck(c: { type: string; value?: unknown }): string {
  switch (c.type) {
    case "contains":
      return `The response must contain the exact text "${c.value}".`;
    case "not_contains_any":
      return `The response must not contain any of: ${(Array.isArray(c.value) ? c.value : [c.value]).map((v) => `"${v}"`).join(", ")}.`;
    case "regex":
      return `The response must match the pattern ${c.value}.`;
    case "max_words":
      return `The response must be ${c.value} words or fewer.`;
    case "max_sentences":
      return `The response must be ${c.value} sentences or fewer.`;
    case "is_json":
      return "The response must be valid, parseable JSON.";
    default:
      return `Runs the "${c.type}" check.`;
  }
}

function judgeCriteriaOf(c: CaseOut): Record<string, string> {
  return (c.judge?.criteria as Record<string, string>) ?? {};
}

// A one-line summary for the list row -- full detail (each check spelled
// out, each judge criterion's description) lives in the "view case" drawer,
// so the row itself never needs to grow wider than the prompt it's showing.
function gradedSummary(c: CaseOut): string {
  const nChecks = c.assertions.length;
  const nCriteria = Object.keys(judgeCriteriaOf(c)).length;
  const parts: string[] = [];
  if (nChecks) parts.push(`${nChecks} check${nChecks > 1 ? "s" : ""}`);
  if (nCriteria) parts.push(`${nCriteria} judge criteri${nCriteria > 1 ? "a" : "on"}`);
  return parts.length ? parts.join(" + ") : "ungraded";
}

// Turns a stored assertion back into the check-builder's editable shape --
// not_contains_any's value is an array on the wire but the builder edits it
// as a comma-separated string, same as when it was first typed in.
function assertionToCheck(a: AssertionOut): CaseCheck {
  if (a.type === "not_contains_any" && Array.isArray(a.value)) {
    return { type: a.type as CheckType, value: a.value.join(", ") };
  }
  return { type: a.type as CheckType, value: a.value as CaseCheck["value"] };
}

// Pseudo pack-id for "every pack at once" -- lets the sidebar reuse the same
// single-selection state instead of a separate view-mode flag.
const ALL_PACKS = "__all__";

// The taxonomy every pack in suites/ is organized around -- not a list of
// packs, a list of orthogonal ways a model can fail. A suite is
// "comprehensive" when every row here has real coverage, not when the case
// count is large; a model can clear a huge pile of cases that all test the
// same failure mode and still be unsafe in production the first time a
// different one shows up. This is shown to explain the categorization, not
// computed from it -- if a new pack is added, add its name to the right
// bucket here too.
interface PackCategory {
  key: string;
  title: string;
  why: string;
  standard?: string;
  packs: string[];
}

const PACK_CATEGORIES: PackCategory[] = [
  {
    key: "capability",
    title: "Capability",
    why: "The baseline question before anything else matters: can it actually perform the task, in the format asked, using the right tool.",
    standard: "10, 11, and 12 are direct ports of published academic benchmarks (MMLU, TruthfulQA, IFEval) -- the same evals cited in most model release cards, so a result here is comparable to numbers reported elsewhere, not just internally.",
    packs: ["01_instruction_following", "02_tool_calling", "10_knowledge_mmlu", "11_truthfulqa_myths", "12_ifeval_constraints"],
  },
  {
    key: "honesty",
    title: "Groundedness",
    why: "A model that's fluent but wrong is worse than one that admits it doesn't know. Each pack includes an answerable-control case so a model that refuses everything can't ace this by never committing to an answer.",
    packs: ["03_grounding_rag", "04_hallucination"],
  },
  {
    key: "robustness",
    title: "Robustness",
    why: "The same request said cleanly, with typos, through ASR noise, or buried in a long document. Production traffic never arrives as cleanly as a demo prompt.",
    packs: ["08_robustness", "09_long_context"],
  },
  {
    key: "attack",
    title: "Attack Resistance",
    why: "Hostile instructions arriving inside retrieved content -- a knowledge-base article, a CRM note -- that the user never typed. Not \"can I make it say something rude,\" but can someone else hijack it through your own data. Includes a benign-control case so over-refusal doesn't masquerade as safety.",
    packs: ["07_safety_injection"],
  },
  {
    key: "handoff",
    title: "Escalation",
    why: "Scored as precision and recall together, never just \"did it escalate.\" A model that hands off at the first sign of friction looks safe on this pack alone and is a containment-rate disaster in production.",
    packs: ["06_escalation"],
  },
  {
    key: "economics",
    title: "Cost & Reliability",
    why: "Latency, tokens, cost, and reliability (retries, rate-limits, errors) are captured on every call in every pack, not just this one -- a model that's more accurate but three times the cost or twice the latency isn't automatically the right call.",
    packs: ["00_latency_probe"],
  },
  {
    key: "vertical",
    title: "Vertical Fit",
    why: "Generic benchmarks show how a model performs in a lab. These test the specific failure modes of one real use case -- a Cognigy AI Agent's transfer-to-live-agent tool, a bank's auth-gating requirement, a retailer's discount policy.",
    packs: [
      "13_vertical_banking",
      "14_vertical_healthcare",
      "15_vertical_insurance",
      "16_vertical_telecom",
      "17_vertical_retail",
      "18_vertical_cognigy_agent",
    ],
  },
];

// Categories are stored as ordinary tags with a reserved prefix -- no schema
// change needed, since `tags` already round-trips through the YAML packs,
// the DB-backed packs, and every existing form on this page. A case can
// carry more than one (a case can legitimately test two things at once), and
// a case with none falls back to its pack's own category everywhere below.
const CATEGORY_TAG_PREFIX = "category:";
const categoryTag = (key: string) => `${CATEGORY_TAG_PREFIX}${key}`;
const categoryKeysOf = (tags: string[]) =>
  tags.filter((t) => t.startsWith(CATEGORY_TAG_PREFIX)).map((t) => t.slice(CATEGORY_TAG_PREFIX.length));
const plainTagsOf = (tags: string[]) => tags.filter((t) => !t.startsWith(CATEGORY_TAG_PREFIX));

// A case's real categories: whatever it's explicitly tagged with, or -- if
// it's never been tagged (every pre-existing case, an HF import, anything
// added before this existed) -- its pack's own category, so nothing in the
// list ever shows up uncategorized.
function categoriesOf(c: Pick<CaseOut, "tags" | "pack">): { categories: PackCategory[]; explicit: boolean } {
  const explicitKeys = categoryKeysOf(c.tags);
  if (explicitKeys.length > 0) {
    return { categories: PACK_CATEGORIES.filter((cat) => explicitKeys.includes(cat.key)), explicit: true };
  }
  return { categories: PACK_CATEGORIES.filter((cat) => cat.packs.includes(c.pack)), explicit: false };
}

export default function CasesPage() {
  const { data: packs } = usePacks();
  const [currentPack, setCurrentPack] = useState<string | null>(null);
  const isAllPacks = currentPack === ALL_PACKS;
  const { data: singlePackCases, isLoading: singleLoading } = useCases(isAllPacks ? null : currentPack);
  const { data: allPackCases, isLoading: allLoading } = useAllCases(isAllPacks);
  const cases = isAllPacks ? allPackCases : singlePackCases;
  const isLoading = isAllPacks ? allLoading : singleLoading;
  const addCase = useAddCase();
  const deleteCase = useDeleteCase();

  useEffect(() => {
    if (!currentPack && packs?.length) setCurrentPack(packs[0].name);
  }, [packs, currentPack]);

  // Row selection resets whenever the viewed pack changes -- a selection
  // only ever means something within the pack it was made in.
  const [selectedCases, setSelectedCases] = useState<Set<string>>(new Set());
  useEffect(() => setSelectedCases(new Set()), [currentPack]);
  // Which real packs the current selection actually spans -- always just
  // [currentPack] outside the "All packs" view, but the launcher needs the
  // real set once selection can span multiple packs at once.
  const selectedPackNames = useMemo(
    () => Array.from(new Set((cases ?? []).filter((c) => selectedCases.has(c.case_key)).map((c) => c.pack))),
    [cases, selectedCases]
  );

  const [runDrawerOpen, setRunDrawerOpen] = useState(false);
  const [viewingCase, setViewingCase] = useState<CaseOut | null>(null);
  const [packSearch, setPackSearch] = useState("");
  const filteredPacks = (packs ?? []).filter((p) => p.name.toLowerCase().includes(packSearch.trim().toLowerCase()));
  const currentPackInfo = isAllPacks ? null : packs?.find((p) => p.name === currentPack) ?? null;

  // Case list filter/sort -- independent of the pack filter above, and reset
  // whenever the viewed pack changes since a filter tuned for one pack's
  // tags/difficulty mix rarely means anything in another. The pack filter
  // and "Pack" sort only do anything in the "All packs" view -- within a
  // single pack every row already shares the same value.
  const [caseSearch, setCaseSearch] = useState("");
  const [difficultyFilter, setDifficultyFilter] = useState<"all" | "easy" | "medium" | "hard">("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [packFilter, setPackFilter] = useState("all");
  const [sortKey, setSortKey] = useState<"case_key" | "difficulty" | "created_at" | "pack">("case_key");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  useEffect(() => {
    setCaseSearch("");
    setDifficultyFilter("all");
    setTagFilter("all");
    setPackFilter("all");
    // categoryFilter deliberately NOT reset here -- it's a cross-pack concept
    // (a category can span several packs), and "Show only these cases" in
    // the Details section above switches to All packs *and* sets this filter
    // in the same action, which this effect would otherwise immediately undo.
  }, [currentPack]);

  // Category tags are a reserved namespace -- excluded from the plain "Any
  // tag" list (they get their own filter below) so that list never shows a
  // raw "category:capability" string.
  const availableTags = useMemo(
    () => Array.from(new Set((cases ?? []).flatMap((c) => plainTagsOf(c.tags)))).sort(),
    [cases]
  );
  const availablePacks = useMemo(() => Array.from(new Set((cases ?? []).map((c) => c.pack))).sort(), [cases]);

  const visibleCases = useMemo(() => {
    let rows = cases ?? [];
    const needle = caseSearch.trim().toLowerCase();
    if (needle) {
      rows = rows.filter(
        (c) =>
          c.case_key.toLowerCase().includes(needle) ||
          c.messages.some((m) => m.content.toLowerCase().includes(needle)) ||
          c.tags.some((t) => t.toLowerCase().includes(needle))
      );
    }
    if (difficultyFilter !== "all") rows = rows.filter((c) => c.difficulty === difficultyFilter);
    if (tagFilter !== "all") rows = rows.filter((c) => c.tags.includes(tagFilter));
    if (categoryFilter !== "all") {
      rows = rows.filter((c) => categoriesOf(c).categories.some((cat) => cat.key === categoryFilter));
    }
    if (isAllPacks && packFilter !== "all") rows = rows.filter((c) => c.pack === packFilter);
    const DIFFICULTY_RANK: Record<string, number> = { easy: 0, medium: 1, hard: 2 };
    const sorted = [...rows].sort((a, b) => {
      let av: string | number, bv: string | number;
      if (sortKey === "difficulty") {
        av = DIFFICULTY_RANK[a.difficulty] ?? 99;
        bv = DIFFICULTY_RANK[b.difficulty] ?? 99;
      } else if (sortKey === "created_at") {
        av = a.created_at;
        bv = b.created_at;
      } else if (sortKey === "pack") {
        av = `${a.pack} ${a.case_key}`;
        bv = `${b.pack} ${b.case_key}`;
      } else {
        av = a.case_key;
        bv = b.case_key;
      }
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
    if (sortDir === "desc") sorted.reverse();
    return sorted;
  }, [cases, caseSearch, difficultyFilter, tagFilter, categoryFilter, packFilter, isAllPacks, sortKey, sortDir]);

  function toggleSort(key: typeof sortKey) {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const [open, setOpen] = useState(false);
  const [pack, setPack] = useState("");
  const [newPack, setNewPack] = useState("");
  const [turns, setTurns] = useState<CaseTurn[]>([{ role: "user", content: "" }]);
  const [caseKey, setCaseKey] = useState("");
  const [tags, setTags] = useState("");
  const [difficulty, setDifficulty] = useState<"easy" | "medium" | "hard">("medium");
  const [system, setSystem] = useState("");
  const [checks, setChecks] = useState<CaseCheck[]>([]);
  const [judgeCriteria, setJudgeCriteria] = useState<JudgeCriterion[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());

  function toggleCategory(key: string) {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function openDrawer() {
    setPack((!isAllPacks && currentPack) || packs?.[0]?.name || "");
    setNewPack("");
    setTurns([{ role: "user", content: "" }]);
    setCaseKey("");
    setTags("");
    setDifficulty("medium");
    setSystem("");
    setChecks([]);
    setJudgeCriteria([]);
    setSelectedCategories(new Set());
    setOpen(true);
  }

  // "Use as template": prefill the Add form from a real, existing case so
  // someone can learn the shape by editing a working example instead of a
  // blank form. Case ID is left blank -- it's a new case, not an overwrite.
  function useAsTemplate(c: CaseOut) {
    setPack(c.pack);
    setNewPack("");
    setTurns(c.messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })));
    setCaseKey("");
    setTags(plainTagsOf(c.tags).join(", "));
    setSelectedCategories(new Set(categoryKeysOf(c.tags)));
    setDifficulty(c.difficulty as "easy" | "medium" | "hard");
    setSystem(c.system ?? "");
    setChecks(c.assertions.map(assertionToCheck));
    setJudgeCriteria(Object.entries(judgeCriteriaOf(c)).map(([name, description]) => ({ name, description })));
    setViewingCase(null);
    setOpen(true);
  }

  function addTurn() {
    const lastRole = turns[turns.length - 1]?.role || "assistant";
    setTurns([...turns, { role: lastRole === "user" ? "assistant" : "user", content: "" }]);
  }
  function updateTurn(i: number, patch: Partial<CaseTurn>) {
    setTurns(turns.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  }
  function removeTurn(i: number) {
    setTurns(turns.filter((_, idx) => idx !== i));
  }

  function addCheck() {
    setChecks([...checks, { type: "contains", value: "" }]);
  }
  function updateCheck(i: number, patch: Partial<CaseCheck>) {
    setChecks(checks.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }
  function removeCheck(i: number) {
    setChecks(checks.filter((_, idx) => idx !== i));
  }

  function addCriterion() {
    setJudgeCriteria([...judgeCriteria, { name: "", description: "" }]);
  }
  function updateCriterion(i: number, patch: Partial<JudgeCriterion>) {
    setJudgeCriteria(judgeCriteria.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }
  function removeCriterion(i: number) {
    setJudgeCriteria(judgeCriteria.filter((_, idx) => idx !== i));
  }

  async function save() {
    const targetPack = pack === "__new__" ? newPack.trim() : pack;
    if (!targetPack) {
      toast("Enter a name for the new pack");
      return;
    }
    if (!turns[0]?.content.trim()) {
      toast("The first turn needs some text");
      return;
    }
    const validCriteria = judgeCriteria.filter((c) => c.name.trim() && c.description.trim());
    if (!checks.length && !validCriteria.length) {
      toast("Add at least one check or an AI judge criterion");
      return;
    }
    try {
      await addCase.mutateAsync({
        pack: targetPack,
        body: {
          case_key: caseKey.trim() || undefined,
          turns,
          system: system.trim() || undefined,
          tags: [
            ...tags.split(",").map((s) => s.trim()).filter(Boolean),
            ...Array.from(selectedCategories).map(categoryTag),
          ],
          difficulty,
          checks,
          judge_criteria: validCriteria,
        },
      });
      setCurrentPack(targetPack);
      setOpen(false);
      toast(`Added test case to ${targetPack}`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Failed to add test case");
    }
  }

  function toggleCaseSelected(key: string) {
    const next = new Set(selectedCases);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelectedCases(next);
  }

  async function removeCase(pack: string, key: string) {
    if (!confirm(`Remove case "${key}"?`)) return;
    try {
      await deleteCase.mutateAsync({ pack, caseKey: key });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Failed to remove case");
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Test cases</h1>
          <p>
            Prompts and pass/fail rules, grouped into packs. Deterministic checks run free on every call; each AI-judge
            criterion costs one extra call to the pinned judge model, never a model under test.
          </p>
        </div>
        <button className="btn primary" onClick={openDrawer}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add test case
        </button>
      </div>

      <div className="content" style={{ paddingBottom: 0 }}>
        <CategoryDetails
          onJumpToPack={(p) => {
            setCategoryFilter("all");
            setCurrentPack(p);
          }}
          activePack={isAllPacks ? null : currentPack}
          onFilterCategory={(key) => {
            setCurrentPack(ALL_PACKS);
            setCategoryFilter(key);
          }}
          activeCategory={categoryFilter}
        />
      </div>

      <div className="content cases-layout">
        <div className="panel pack-sidebar">
          <div className="panel-head">
            <h2>Packs</h2>
            <span className="sub">{packs?.length ?? 0} total</span>
          </div>
          <div style={{ padding: "10px 12px" }}>
            <input
              type="text"
              placeholder="Filter packs…"
              value={packSearch}
              onChange={(e) => setPackSearch(e.target.value)}
            />
          </div>
          <div className="pack-list">
            <button
              className={`pack-list-item${isAllPacks ? " active" : ""}`}
              onClick={() => setCurrentPack(ALL_PACKS)}
              title="Every case across every pack"
            >
              <span style={{ fontWeight: 600, fontSize: 12.5 }}>All packs</span>
              <span className="n">{(packs ?? []).reduce((sum, p) => sum + p.case_count, 0)}</span>
            </button>
            {filteredPacks.map((p) => (
              <button
                key={p.name}
                className={`pack-list-item${p.name === currentPack ? " active" : ""}`}
                onClick={() => setCurrentPack(p.name)}
                title={p.tags.join(", ")}
              >
                <span className="mono" style={{ fontWeight: 600, fontSize: 12.5 }}>
                  {p.name}
                </span>
                <span className="n">{p.case_count}</span>
              </button>
            ))}
            {filteredPacks.length === 0 && <p className="empty-hint">No packs match "{packSearch}".</p>}
          </div>
        </div>

        <div>
          {currentPackInfo?.description && (
            <div className="panel" style={{ marginBottom: 16, padding: "14px 18px" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
                <span className="mono" style={{ fontWeight: 600, fontSize: 13.5 }}>
                  {currentPackInfo.name}
                </span>
                {currentPackInfo.description.startsWith("Source:") && (
                  <span className="tag" style={{ fontSize: 10.5 }}>
                    huggingface
                  </span>
                )}
              </div>
              <p style={{ margin: 0, fontSize: 13, color: "var(--ink-2)" }}>{currentPackInfo.description}</p>
            </div>
          )}

          <ExamplePanel example={cases?.[0] ?? null} pack={isAllPacks ? "all packs" : currentPack} />

          <div className="panel">
          {selectedCases.size > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 18px 0" }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{selectedCases.size} selected</span>
              <button className="btn sm primary" onClick={() => setRunDrawerOpen(true)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="M5 3l16 9-16 9V3z" />
                </svg>
                Run selected
              </button>
              <button className="btn sm ghost" onClick={() => setSelectedCases(new Set())}>
                Clear
              </button>
            </div>
          )}

          <div style={{ display: "flex", gap: 10, padding: "12px 18px 0", flexWrap: "wrap", alignItems: "center" }}>
            <input
              type="text"
              placeholder="Search case key, prompt, tag…"
              value={caseSearch}
              onChange={(e) => setCaseSearch(e.target.value)}
              style={{ width: 220 }}
            />
            <select value={difficultyFilter} onChange={(e) => setDifficultyFilter(e.target.value as typeof difficultyFilter)} style={{ width: "auto" }}>
              <option value="all">Any difficulty</option>
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </select>
            <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} style={{ width: "auto" }}>
              <option value="all">Any category</option>
              {PACK_CATEGORIES.map((cat) => (
                <option key={cat.key} value={cat.key}>
                  {cat.title}
                </option>
              ))}
            </select>
            {availableTags.length > 0 && (
              <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} style={{ width: "auto" }}>
                <option value="all">Any tag</option>
                {availableTags.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            )}
            {isAllPacks && availablePacks.length > 0 && (
              <select value={packFilter} onChange={(e) => setPackFilter(e.target.value)} style={{ width: "auto" }}>
                <option value="all">Any pack</option>
                {availablePacks.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            )}
            <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--muted)" }}>
              Sort:
              {isAllPacks && (
                <button className={`btn sm ghost${sortKey === "pack" ? " active" : ""}`} onClick={() => toggleSort("pack")}>
                  Pack{sortKey === "pack" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                </button>
              )}
              <button className={`btn sm ghost${sortKey === "case_key" ? " active" : ""}`} onClick={() => toggleSort("case_key")}>
                Case{sortKey === "case_key" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
              </button>
              <button className={`btn sm ghost${sortKey === "difficulty" ? " active" : ""}`} onClick={() => toggleSort("difficulty")}>
                Difficulty{sortKey === "difficulty" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
              </button>
              <button className={`btn sm ghost${sortKey === "created_at" ? " active" : ""}`} onClick={() => toggleSort("created_at")}>
                Newest{sortKey === "created_at" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
              </button>
            </span>
            <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--muted)" }}>
              {visibleCases.length} of {cases?.length ?? 0} cases
            </span>
          </div>

          {isLoading && <p className="empty-hint">Loading…</p>}
          {cases?.length === 0 && <p className="empty-hint">No test cases yet. Click "Add test case" above.</p>}
          {(cases?.length ?? 0) > 0 && visibleCases.length === 0 && <p className="empty-hint">No cases match this filter.</p>}

          <div className="caselist">
            {visibleCases.map((c) => {
              const preview = c.messages.map((m) => m.content).join("  ·  ");
              const { categories } = categoriesOf(c);
              return (
                <div className="caserow" key={c.id}>
                  <input
                    type="checkbox"
                    checked={selectedCases.has(c.case_key)}
                    onChange={() => toggleCaseSelected(c.case_key)}
                  />
                  <div className="caserow-main" onClick={() => setViewingCase(c)}>
                    <div className="caserow-id-line">
                      {isAllPacks && (
                        <span className="tag mono" title="Pack">
                          {c.pack}
                        </span>
                      )}
                      <span className="mono" style={{ fontWeight: 600, fontSize: 13 }}>
                        {c.case_key}
                      </span>
                      <span className="tag" style={{ textTransform: "capitalize" }}>
                        {c.difficulty}
                      </span>
                      {categories.map((cat) => (
                        <span
                          className="tag"
                          key={cat.key}
                          title={cat.why}
                          style={{ background: "var(--accent-wash)", color: "var(--accent)" }}
                        >
                          {cat.title}
                        </span>
                      ))}
                      {plainTagsOf(c.tags).map((t) => (
                        <span className="tag" key={t}>
                          {t}
                        </span>
                      ))}
                    </div>
                    <p className="caserow-prompt" title={preview}>
                      {preview}
                    </p>
                  </div>
                  <span className="gradedby-badge">{gradedSummary(c)}</span>
                  <div style={{ display: "flex", gap: 2, flex: "none" }}>
                    <button className="iconbtn" title="View full case" onClick={() => setViewingCase(c)}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    </button>
                    <button className="iconbtn" title="Remove" onClick={() => removeCase(c.pack, c.case_key)}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m2 0l-1 13a1 1 0 01-1 1H8a1 1 0 01-1-1L6 7" />
                      </svg>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          </div>
        </div>
      </div>

      <Drawer
        open={open}
        title="Add test case"
        width={460}
        onClose={() => setOpen(false)}
        footer={
          <>
            <button className="btn ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn primary" onClick={save} disabled={addCase.isPending}>
              Add test case
            </button>
          </>
        }
      >
        <div className="grid2">
          <div className="field">
            <label>Pack</label>
            <select value={pack} onChange={(e) => setPack(e.target.value)}>
              {packs?.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
              <option value="__new__">+ New pack…</option>
            </select>
          </div>
          {pack === "__new__" && (
            <div className="field">
              <label>New pack name</label>
              <input type="text" value={newPack} placeholder="e.g. 10_billing_edge_cases" onChange={(e) => setNewPack(e.target.value)} />
            </div>
          )}
          <div className="field">
            <label>Difficulty</label>
            <select value={difficulty} onChange={(e) => setDifficulty(e.target.value as "easy" | "medium" | "hard")}>
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </select>
          </div>
        </div>

        <div className="field">
          <label>Case ID</label>
          <input type="text" value={caseKey} placeholder="short-unique-id" onChange={(e) => setCaseKey(e.target.value)} />
          <span className="hint">Lowercase, hyphenated. Auto-suggested from the prompt if left blank.</span>
        </div>
        <div className="field">
          <label>Tags</label>
          <input type="text" value={tags} placeholder="format, voice, billing" onChange={(e) => setTags(e.target.value)} />
        </div>

        <div className="field">
          <span className="section-label">Category</span>
          <p className="hint" style={{ margin: "0 0 8px" }}>
            Which of the ways a model can fail does this case actually test? Pick as many as apply -- shown in this
            case's own Details later, and used to filter the list.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {PACK_CATEGORIES.map((cat) => {
              const active = selectedCategories.has(cat.key);
              return (
                <button
                  key={cat.key}
                  type="button"
                  className="tag"
                  style={{
                    cursor: "pointer",
                    border: "1px solid var(--line-strong)",
                    fontWeight: active ? 700 : 400,
                    background: active ? "var(--accent-wash)" : undefined,
                    color: active ? "var(--accent)" : undefined,
                  }}
                  title={cat.why}
                  onClick={() => toggleCategory(cat.key)}
                >
                  {cat.title}
                </button>
              );
            })}
          </div>
        </div>

        <div className="field">
          <span className="section-label">Conversation</span>
          {turns.map((t, i) => (
            <div className="turnrow" key={i}>
              <select value={t.role} onChange={(e) => updateTurn(i, { role: e.target.value as "user" | "assistant" })}>
                <option value="user">User</option>
                <option value="assistant">Assistant</option>
              </select>
              <textarea rows={2} value={t.content} placeholder="Say something…" onChange={(e) => updateTurn(i, { content: e.target.value })} />
              {turns.length > 1 && (
                <button className="iconbtn" onClick={() => removeTurn(i)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              )}
            </div>
          ))}
          <button className="btn sm ghost" style={{ alignSelf: "flex-start" }} onClick={addTurn}>
            + Add follow-up turn
          </button>
        </div>

        <details className="adv">
          <summary>System prompt override (optional)</summary>
          <textarea
            value={system}
            placeholder="Overrides the pack's shared system prompt for this case only"
            style={{ marginBottom: 10 }}
            onChange={(e) => setSystem(e.target.value)}
          />
        </details>

        <div className="field" style={{ marginTop: 4 }}>
          <span className="section-label">Simple checks</span>
          {checks.length === 0 && <p className="hint" style={{ margin: "0 0 8px" }}>None yet — rely on the AI judge below, or add one here.</p>}
          {checks.map((c, i) => {
            const t = CHECK_TYPES.find((x) => x.key === c.type)!;
            return (
              <div className="checkbuilder-row" key={i}>
                <select value={c.type} onChange={(e) => updateCheck(i, { type: e.target.value as CheckType, value: "" })}>
                  {CHECK_TYPES.map((ct) => (
                    <option key={ct.key} value={ct.key}>
                      {ct.label}
                    </option>
                  ))}
                </select>
                {t.kind !== "none" && (
                  <input
                    type={t.kind === "number" ? "number" : "text"}
                    value={(c.value as string | number) ?? ""}
                    placeholder={t.ph}
                    onChange={(e) => updateCheck(i, { value: e.target.value })}
                  />
                )}
                <button className="iconbtn" onClick={() => removeCheck(i)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
            );
          })}
          <button className="btn sm ghost" style={{ alignSelf: "flex-start" }} onClick={addCheck}>
            + Add check
          </button>
        </div>

        <div className="field">
          <span className="section-label">AI judge (optional, multiple allowed)</span>
          {judgeCriteria.length === 0 && (
            <p className="hint" style={{ margin: "0 0 8px" }}>
              Each criterion is graded independently by the pinned judge model — add one for tone, one for accuracy, etc.
            </p>
          )}
          {judgeCriteria.map((c, i) => (
            <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "flex-start" }}>
              <input
                type="text"
                value={c.name}
                placeholder="Name, e.g. Empathy"
                style={{ width: 140, flex: "none" }}
                onChange={(e) => updateCriterion(i, { name: e.target.value })}
              />
              <textarea
                rows={2}
                value={c.description}
                placeholder="What does passing this dimension look like?"
                onChange={(e) => updateCriterion(i, { description: e.target.value })}
              />
              <button className="iconbtn" onClick={() => removeCriterion(i)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
          ))}
          <button className="btn sm ghost" style={{ alignSelf: "flex-start" }} onClick={addCriterion}>
            + Add criterion
          </button>
        </div>
      </Drawer>

      <Drawer
        open={viewingCase != null}
        title={viewingCase ? `Case: ${viewingCase.case_key}` : "Case"}
        onClose={() => setViewingCase(null)}
        footer={
          <>
            <button className="btn ghost" onClick={() => setViewingCase(null)}>
              Close
            </button>
            {viewingCase && (
              <button className="btn primary" onClick={() => useAsTemplate(viewingCase)}>
                Use as template
              </button>
            )}
          </>
        }
      >
        {viewingCase && (
          <>
            <div className="field">
              <span className="section-label">Pack · difficulty</span>
              <p style={{ margin: 0, fontSize: 13.5 }}>
                <span className="mono">{viewingCase.pack}</span> · <span style={{ textTransform: "capitalize" }}>{viewingCase.difficulty}</span>
              </p>
            </div>

            <details className="adv" open>
              <summary>Details — what this case is categorically testing</summary>
              {(() => {
                const { categories, explicit } = categoriesOf(viewingCase);
                if (categories.length === 0) {
                  return <p className="hint">Not categorized, and its pack isn't mapped to a category either.</p>;
                }
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4, marginBottom: 10 }}>
                    {categories.map((cat) => (
                      <div key={cat.key}>
                        <div style={{ fontWeight: 650, fontSize: 13.5 }}>{cat.title}</div>
                        <p style={{ margin: "2px 0 0", fontSize: 12.5, color: "var(--ink-2)" }}>{cat.why}</p>
                      </div>
                    ))}
                    {!explicit && (
                      <p style={{ margin: 0, fontSize: 11.5, color: "var(--muted)", fontStyle: "italic" }}>
                        Inferred from the {viewingCase.pack} pack — this case isn't explicitly tagged with a category.
                        Use "Use as template" below to add one.
                      </p>
                    )}
                  </div>
                );
              })()}
            </details>

            {plainTagsOf(viewingCase.tags).length > 0 && (
              <div className="field">
                <span className="section-label">Tags</span>
                <div>
                  {plainTagsOf(viewingCase.tags).map((t) => (
                    <span className="tag" key={t}>
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {viewingCase.reference?.source && (
              <div className="field">
                <span className="section-label">Source</span>
                <p style={{ margin: 0, fontSize: 13 }}>
                  <strong>{viewingCase.reference.source}</strong>
                  {viewingCase.reference.note && (
                    <span style={{ display: "block", color: "var(--ink-2)", marginTop: 3 }}>{viewingCase.reference.note}</span>
                  )}
                </p>
              </div>
            )}
            {viewingCase.system && (
              <div className="field">
                <span className="section-label">System prompt override</span>
                <p style={{ margin: 0, fontSize: 13, color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>{viewingCase.system}</p>
              </div>
            )}
            <div className="field">
              <span className="section-label">What gets sent to the model</span>
              {viewingCase.messages.map((m, i) => (
                <div key={i} className="panel" style={{ padding: "10px 12px", marginBottom: 8, boxShadow: "none" }}>
                  <div className="section-label" style={{ marginBottom: 4 }}>
                    {m.role}
                  </div>
                  <p style={{ margin: 0, fontSize: 13.5, whiteSpace: "pre-wrap" }}>{m.content}</p>
                </div>
              ))}
            </div>
            <div className="field">
              <span className="section-label">What gets checked (free, runs on every call)</span>
              {viewingCase.assertions.length === 0 && <p className="hint">No deterministic checks on this case.</p>}
              {viewingCase.assertions.map((a, i) => (
                <p key={i} style={{ margin: "0 0 8px", fontSize: 13.5, display: "flex", gap: 8 }}>
                  <span style={{ color: "var(--good)" }}>✓</span>
                  <span>{explainCheck(a)}</span>
                </p>
              ))}
            </div>
            {Object.keys(judgeCriteriaOf(viewingCase)).length > 0 && (
              <div className="field">
                <span className="section-label">Graded by the AI judge (costs one extra call)</span>
                {Object.entries(judgeCriteriaOf(viewingCase)).map(([name, desc]) => (
                  <p key={name} style={{ margin: "0 0 8px", fontSize: 13.5 }}>
                    <span className="judgepill" style={{ marginRight: 6 }}>
                      {name}
                    </span>
                    {desc}
                  </p>
                ))}
              </div>
            )}
          </>
        )}
      </Drawer>

      <Drawer
        open={runDrawerOpen}
        title={`Run ${selectedCases.size} selected case(s)`}
        onClose={() => setRunDrawerOpen(false)}
        footer={
          <button className="btn ghost" onClick={() => setRunDrawerOpen(false)}>
            Close
          </button>
        }
      >
        {selectedPackNames.length > 0 && (
          <RunLauncherPanel
            packNames={selectedPackNames}
            caseKeys={Array.from(selectedCases)}
            caseCountLabel={
              isAllPacks
                ? `${selectedCases.size} case(s) from ${selectedPackNames.length} pack(s)`
                : `${selectedCases.size} case(s) from ${currentPack}`
            }
          />
        )}
      </Drawer>
    </>
  );
}

/**
 * Why these packs exist at all, and how they're categorized -- for someone
 * being handed this platform as a shared test ground, not just the person
 * who built it. Every pack in suites/ maps to exactly one row here; a new
 * pack should be added to PACK_CATEGORIES above at the same time it's
 * written, not left uncategorized.
 */
/**
 * The page-header-level explainer: what each category name means, and which
 * packs belong to it. Each category is its own <details> -- open one to see
 * its packs, same click also available as a filter for the case list below
 * via "Show only these cases".
 */
function CategoryDetails({
  onJumpToPack,
  activePack,
  onFilterCategory,
  activeCategory,
}: {
  onJumpToPack: (pack: string) => void;
  activePack: string | null;
  onFilterCategory: (key: string) => void;
  activeCategory: string;
}) {
  return (
    <CollapsiblePanel
      id="cases-details"
      title="Details"
      sub="What each category of test case actually checks for, and which packs belong to it"
      defaultCollapsed
    >
      <div style={{ padding: "4px 18px 16px" }}>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--ink-2)", maxWidth: "70ch" }}>
          Every pack in suites/ belongs to one of these. Open a category to see its packs, or use "Show only these
          cases" to filter the list below to it.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {PACK_CATEGORIES.map((cat) => (
            <details key={cat.key} className="adv" style={{ margin: 0 }}>
              <summary style={{ fontWeight: 650 }}>{cat.title}</summary>
              <p style={{ margin: "6px 0 8px", fontSize: 12.5, color: "var(--ink-2)", maxWidth: "70ch" }}>{cat.why}</p>
              {cat.standard && (
                <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--muted)", fontStyle: "italic", maxWidth: "70ch" }}>
                  {cat.standard}
                </p>
              )}
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                {cat.packs.map((p) => (
                  <button
                    key={p}
                    className="tag mono"
                    style={{
                      cursor: "pointer",
                      border: "none",
                      fontWeight: p === activePack ? 700 : 400,
                      background: p === activePack ? "var(--accent-wash)" : undefined,
                      color: p === activePack ? "var(--accent)" : undefined,
                    }}
                    onClick={() => onJumpToPack(p)}
                    title={`Jump to ${p}`}
                  >
                    {p}
                  </button>
                ))}
                <button
                  className="btn sm ghost"
                  style={{ marginLeft: "auto" }}
                  onClick={() => onFilterCategory(activeCategory === cat.key ? "all" : cat.key)}
                >
                  {activeCategory === cat.key ? "✓ Filtering to this category" : "Show only these cases ↓"}
                </button>
              </div>
            </details>
          ))}
        </div>
      </div>
    </CollapsiblePanel>
  );
}

/**
 * A worked example, live from whatever pack is currently open, so someone
 * new to the platform sees a real prompt → real checks → pass/fail before
 * they try to build their own -- not an abstract description of the
 * mechanism.
 */
function ExamplePanel({ example, pack }: { example: CaseOut | null; pack: string | null }) {
  if (!example) {
    return (
      <div className="panel">
        <div className="panel-head">
          <h2>How a test case works</h2>
        </div>
        <p className="note">
          Pick a pack with at least one case to see a worked example here, or click "Add test case" above to build the
          first one.
        </p>
      </div>
    );
  }

  const prompt = example.messages[0]?.content ?? "";
  const criteria = Object.entries(judgeCriteriaOf(example));

  return (
    <CollapsiblePanel
      id="cases-example"
      title="How a test case works"
      sub={
        <>
          A real example from <span className="mono">{pack}</span> — click "View full case" on any row below to see one in full
        </>
      }
      defaultCollapsed
    >
      <div className="grid2" style={{ padding: "16px 18px", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)", gap: 20 }}>
        <div>
          <span className="kicker">1 · This gets sent</span>
          <p style={{ margin: 0, fontSize: 13, color: "var(--ink-2)" }}>{prompt}</p>
        </div>
        <div>
          <span className="kicker">2 · This gets checked</span>
          {example.assertions.map((a, i) => (
            <p key={i} style={{ margin: "0 0 6px", fontSize: 12.5, color: "var(--ink-2)" }}>
              {explainCheck(a)}
            </p>
          ))}
          {criteria.map(([name, desc]) => (
            <p key={name} style={{ margin: "0 0 6px", fontSize: 12.5, color: "var(--ink-2)" }}>
              <span className="judgepill" style={{ marginRight: 6 }}>
                judge: {name}
              </span>
              {desc}
            </p>
          ))}
          {!example.assertions.length && !criteria.length && (
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--muted)" }}>No grading on this particular case.</p>
          )}
        </div>
        <div>
          <span className="kicker">3 · Pass or fail</span>
          <p style={{ margin: 0, fontSize: 13, color: "var(--ink-2)" }}>
            Every check above must pass{criteria.length ? ", and every judge score must clear its threshold," : ""} for
            the case to pass. That's it — same rule for every case in every pack.
          </p>
        </div>
      </div>
    </CollapsiblePanel>
  );
}
