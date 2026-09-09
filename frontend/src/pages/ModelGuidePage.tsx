import { useMemo, useState } from "react";
import { useModels, useUpdateModel } from "../api/hooks";
import type { ModelOut } from "../api/types";
import { toast } from "../toast";
import { ApiError } from "../api/client";
import { providerLabel } from "../format";

export default function ModelGuidePage() {
  const { data: models, isLoading } = useModels();
  const [search, setSearch] = useState("");
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());

  const allTags = useMemo(() => {
    const s = new Set<string>();
    (models ?? []).forEach((m) => m.tags.forEach((t) => s.add(t)));
    return Array.from(s).sort();
  }, [models]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (models ?? []).filter((m) => {
      if (activeTags.size > 0 && !Array.from(activeTags).every((t) => m.tags.includes(t))) return false;
      if (needle) {
        const haystack = `${m.alias} ${m.model} ${m.notes ?? ""} ${m.tags.join(" ")}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [models, search, activeTags]);

  const groups = useMemo(() => {
    const map = new Map<string, ModelOut[]>();
    for (const m of filtered) {
      const key = providerLabel(m);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(m);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  function toggleTag(t: string) {
    const next = new Set(activeTags);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    setActiveTags(next);
  }

  const annotated = (models ?? []).filter((m) => m.notes?.trim()).length;

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Model guide</h1>
          <p>
            What you and your team actually know about each model — not benchmark output, field notes: what it's good
            at, what to watch out for. Click any card's notes to add or edit them.
          </p>
        </div>
      </div>
      <div className="content">
        <div className="panel" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 10, padding: "14px 18px", flexWrap: "wrap", alignItems: "center" }}>
            <input
              type="text"
              placeholder="Search alias, model, notes…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: 240 }}
            />
            <span style={{ fontSize: 12, color: "var(--muted)" }}>
              {annotated} of {models?.length ?? 0} models have notes
            </span>
            {activeTags.size > 0 && (
              <button className="btn sm ghost" onClick={() => setActiveTags(new Set())}>
                Clear tag filter
              </button>
            )}
          </div>
          {allTags.length > 0 && (
            <div className="chiprow" style={{ paddingBottom: 14 }}>
              {allTags.map((t) => (
                <button key={t} className={`chip${activeTags.has(t) ? " active" : ""}`} onClick={() => toggleTag(t)}>
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>

        {isLoading && <p className="empty-hint">Loading…</p>}
        {!isLoading && filtered.length === 0 && (
          <div className="panel">
            <p className="empty-hint">
              {models?.length ? "No models match this filter." : "No models registered yet — add some on the Models page."}
            </p>
          </div>
        )}

        {groups.map(([provider, rows]) => (
          <div key={provider} style={{ marginBottom: 22 }}>
            <span className="section-label" style={{ textTransform: "capitalize", fontSize: 11.5, marginBottom: 8 }}>
              {provider}
            </span>
            <div className="guide-grid">
              {rows.map((m) => (
                <ModelGuideCard key={m.id} model={m} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function ModelGuideCard({ model }: { model: ModelOut }) {
  const updateModel = useUpdateModel();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(model.notes ?? "");

  function startEdit() {
    setDraft(model.notes ?? "");
    setEditing(true);
  }

  async function save() {
    try {
      await updateModel.mutateAsync({ id: model.id, body: { notes: draft.trim() || null } });
      setEditing(false);
      toast(`Updated notes for ${model.alias}`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Failed to save notes");
    }
  }

  return (
    <div className="guide-card">
      <div className="guide-card-head">
        <div style={{ minWidth: 0 }}>
          <div className="mono" style={{ fontWeight: 600, fontSize: 13.5 }}>
            {model.alias}
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {model.model} · {model.route}
            {model.price_input_per_mtok != null && ` · $${model.price_input_per_mtok.toFixed(3)}/M in`}
          </div>
        </div>
        <span className={`pill ${model.enabled ? "on" : "off"}`} style={{ flex: "none" }}>
          <span className="d" />
          {model.enabled ? "enabled" : "disabled"}
        </span>
      </div>

      {model.tags.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {model.tags.map((t) => (
            <span className="tag" key={t}>
              {t}
            </span>
          ))}
        </div>
      )}

      {editing ? (
        <div style={{ marginTop: 10 }}>
          <textarea
            autoFocus
            rows={3}
            value={draft}
            placeholder="What's this model good at? Where does it fall short? Anything a teammate should know before picking it?"
            onChange={(e) => setDraft(e.target.value)}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8, justifyContent: "flex-end" }}>
            <button className="btn sm ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="btn sm primary" onClick={save} disabled={updateModel.isPending}>
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="guide-card-notes" onClick={startEdit} title="Click to edit">
          {model.notes?.trim() ? (
            <p>{model.notes}</p>
          ) : (
            <p className="empty-hint" style={{ padding: 0 }}>
              No notes yet — click to add what you know about this model.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
