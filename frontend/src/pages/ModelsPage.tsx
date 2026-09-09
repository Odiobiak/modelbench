import { useEffect, useMemo, useState } from "react";
import Drawer from "../components/Drawer";
import DiscoverModelsDrawer from "../components/DiscoverModelsDrawer";
import StatTile from "../components/StatTile";
import { useCreateModel, useDeleteModel, useModels, useUpdateModel, useVerifyAllModels, useVerifyModel } from "../api/hooks";
import type { ModelIn, ModelOut } from "../api/types";
import { toast } from "../toast";
import { ApiError } from "../api/client";
import { fmtDate, modelReadiness, providerLabel } from "../format";

const SUGGESTED_TAGS = [
  "coding",
  "reasoning",
  "vision",
  "tool-calling",
  "long-context",
  "creative-writing",
  "multilingual",
  "fast",
  "cheap",
  "frontier",
  "open-weight",
];

const BLANK: ModelIn = {
  alias: "",
  model: "",
  route: "openrouter",
  enabled: true,
  tags: [],
  base_url_env: "",
  api_key_env: "",
  region: "",
  deployment_type: "",
  aws_access_key_id_env: "",
  aws_secret_access_key_env: "",
  aws_session_token_env: "",
  temperature: 0.2,
  top_p: null,
  max_tokens: 1024,
  seed: null,
  timeout_s: 120,
  notes: null,
};

type StatusFilter = "all" | "enabled" | "disabled" | "verified" | "invalid" | "unverified" | "no-key";
const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "Any status" },
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled" },
  { value: "verified", label: "Verified" },
  { value: "invalid", label: "Key invalid" },
  { value: "unverified", label: "Unverified" },
  { value: "no-key", label: "No key" },
];

function matchesStatus(m: ModelOut, status: StatusFilter): boolean {
  if (status === "all") return true;
  if (status === "enabled") return m.enabled;
  if (status === "disabled") return !m.enabled;
  const label = modelReadiness(m).label;
  if (status === "verified") return label === "verified";
  if (status === "invalid") return label === "key invalid";
  if (status === "unverified") return label === "unverified";
  return label === "no key";
}

export default function ModelsPage() {
  const { data: models, isLoading, error } = useModels();
  const createModel = useCreateModel();
  const updateModel = useUpdateModel();
  const deleteModel = useDeleteModel();
  const verifyModel = useVerifyModel();
  const verifyAll = useVerifyAllModels();

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ModelIn>(BLANK);
  const [tagsText, setTagsText] = useState("");
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  const [search, setSearch] = useState("");
  const [routeFilter, setRouteFilter] = useState<"all" | "openrouter" | "direct" | "anthropic" | "bedrock">("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  // Collapsed by default -- a growing registry (Discover adds many at once)
  // shouldn't mean a page-length scroll just to see what's registered. Seeded
  // once when models first load, not on every refetch (verify/enable
  // actions refetch constantly and would otherwise re-collapse an open group
  // out from under you).
  const allProviders = useMemo(() => Array.from(new Set((models ?? []).map(providerLabel))), [models]);
  const [collapsed, setCollapsed] = useState<Set<string> | null>(null);
  const seeded = collapsed !== null;
  useEffect(() => {
    if (!seeded && allProviders.length) setCollapsed(new Set(allProviders));
  }, [seeded, allProviders]);
  const collapsedSet = collapsed ?? new Set(allProviders);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (models ?? []).filter((m) => {
      if (routeFilter !== "all" && m.route !== routeFilter) return false;
      if (!matchesStatus(m, statusFilter)) return false;
      if (needle) {
        const haystack = `${m.alias} ${m.model} ${m.tags.join(" ")}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [models, search, routeFilter, statusFilter]);

  const groups = useMemo(() => {
    const map = new Map<string, ModelOut[]>();
    for (const m of filtered) {
      const key = providerLabel(m);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(m);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const stats = useMemo(() => {
    const all = models ?? [];
    const enabled = all.filter((m) => m.enabled);
    const verified = all.filter((m) => m.verified_ok === true);
    const needsAttention = enabled.filter((m) => !m.is_ready || m.verified_ok === false);
    return { total: all.length, enabled: enabled.length, verified: verified.length, needsAttention: needsAttention.length };
  }, [models]);

  function toggleCollapse(provider: string) {
    const next = new Set(collapsedSet);
    if (next.has(provider)) next.delete(provider);
    else next.add(provider);
    setCollapsed(next);
  }

  function openAddDrawer() {
    setEditingId(null);
    setForm(BLANK);
    setTagsText("");
    setOpen(true);
  }

  function openEditDrawer(m: ModelOut) {
    setEditingId(m.id);
    setForm({
      alias: m.alias,
      model: m.model,
      route: m.route,
      enabled: m.enabled,
      tags: m.tags,
      base_url_env: m.base_url_env,
      api_key_env: m.api_key_env,
      region: m.region,
      deployment_type: m.deployment_type,
      aws_access_key_id_env: m.aws_access_key_id_env,
      aws_secret_access_key_env: m.aws_secret_access_key_env,
      aws_session_token_env: m.aws_session_token_env,
      temperature: m.temperature,
      top_p: m.top_p,
      max_tokens: m.max_tokens,
      seed: m.seed,
      timeout_s: m.timeout_s,
      notes: m.notes,
    });
    setTagsText(m.tags.join(", "));
    setOpen(true);
  }

  async function save() {
    if (!form.alias.trim() || !form.model.trim()) {
      toast("Alias and model slug are required");
      return;
    }
    const body = { ...form, tags: tagsText.split(",").map((s) => s.trim()).filter(Boolean) };
    try {
      if (editingId) {
        await updateModel.mutateAsync({ id: editingId, body });
        toast(`Updated ${form.alias}`);
      } else {
        await createModel.mutateAsync(body);
        toast(`Added ${form.alias} — pricing resolves on first run`);
      }
      setOpen(false);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Failed to save model");
    }
  }

  async function toggle(id: string, enabled: boolean) {
    try {
      await updateModel.mutateAsync({ id, body: { enabled } });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Failed to update model");
    }
  }

  async function remove(id: string, alias: string) {
    if (!confirm(`Remove ${alias} from the registry?`)) return;
    try {
      await deleteModel.mutateAsync(id);
      toast(`Removed ${alias}`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Failed to remove model");
    }
  }

  async function verify(id: string, alias: string) {
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      const out = await verifyModel.mutateAsync(id);
      toast(out.verified_ok ? `${alias}: verified` : `${alias}: ${out.verified_message}`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Verification failed");
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function verifyAllModels() {
    try {
      const out = await verifyAll.mutateAsync();
      const ok = out.filter((o) => o.verified_ok).length;
      toast(`Verified ${ok} of ${out.length} enabled models`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Verify all failed");
    }
  }

  async function verifyGroup(rows: ModelOut[]) {
    const targets = rows.filter((m) => m.is_ready);
    if (!targets.length) return;
    setBusyIds(new Set(targets.map((m) => m.id)));
    try {
      const results = await Promise.all(targets.map((m) => verifyModel.mutateAsync(m.id).catch(() => null)));
      const ok = results.filter((r) => r?.verified_ok).length;
      toast(`Verified ${ok} of ${targets.length}`);
    } finally {
      setBusyIds(new Set());
    }
  }

  async function setGroupEnabled(rows: ModelOut[], enabled: boolean) {
    setBusyIds(new Set(rows.map((m) => m.id)));
    try {
      await Promise.all(rows.map((m) => updateModel.mutateAsync({ id: m.id, body: { enabled } }).catch(() => null)));
      toast(`${enabled ? "Enabled" : "Disabled"} ${rows.length} model(s)`);
    } finally {
      setBusyIds(new Set());
    }
  }

  const hasFilters = search.trim() !== "" || routeFilter !== "all" || statusFilter !== "all";

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Models</h1>
          <p>
            The registry benchmark runs draw from. Vendor, pricing and context window are discovered live from the
            catalogue at run time — you only maintain what's below.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn ghost" onClick={verifyAllModels} disabled={verifyAll.isPending}>
            {verifyAll.isPending ? "Verifying…" : "Verify all"}
          </button>
          <button className="btn ghost" onClick={() => setDiscoverOpen(true)}>
            Discover models
          </button>
          <button className="btn primary" onClick={openAddDrawer}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add model
          </button>
        </div>
      </div>
      <div className="content">
        <div className="tiles" style={{ marginBottom: 16 }}>
          <StatTile label="Registered" value={String(stats.total)} sub="total models" />
          <StatTile label="Enabled" value={String(stats.enabled)} sub="selectable to run" />
          <StatTile label="Verified" value={String(stats.verified)} sub="confirmed working" />
          <StatTile
            label="Needs attention"
            value={String(stats.needsAttention)}
            sub="enabled but not confirmed"
            alarm={stats.needsAttention > 0}
          />
        </div>

        <div className="panel" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 10, padding: "14px 18px", flexWrap: "wrap", alignItems: "center" }}>
            <input
              type="text"
              placeholder="Search alias, model, tag…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: 240 }}
            />
            <select value={routeFilter} onChange={(e) => setRouteFilter(e.target.value as typeof routeFilter)} style={{ width: "auto" }}>
              <option value="all">Any route</option>
              <option value="openrouter">openrouter</option>
              <option value="direct">direct</option>
              <option value="anthropic">anthropic</option>
              <option value="bedrock">bedrock</option>
            </select>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} style={{ width: "auto" }}>
              {STATUS_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            {hasFilters && (
              <button
                className="btn sm ghost"
                onClick={() => {
                  setSearch("");
                  setRouteFilter("all");
                  setStatusFilter("all");
                }}
              >
                Clear filters
              </button>
            )}
            <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "var(--muted)" }}>
              {filtered.length} of {models?.length ?? 0} models · {groups.length} provider(s)
              <a href="#" style={{ color: "var(--accent)" }} onClick={(e) => { e.preventDefault(); setCollapsed(new Set()); }}>
                expand all
              </a>
              <a href="#" style={{ color: "var(--accent)" }} onClick={(e) => { e.preventDefault(); setCollapsed(new Set(allProviders)); }}>
                collapse all
              </a>
            </span>
          </div>
        </div>

        {isLoading && <p className="empty-hint">Loading…</p>}
        {error && (
          <p className="empty-hint">
            Couldn't load models — is the API running at {import.meta.env.VITE_API_BASE || "http://localhost:8811"}?
          </p>
        )}
        {!isLoading && !error && groups.length === 0 && (
          <div className="panel">
            <p className="empty-hint">
              {models?.length ? "No models match this filter." : "No models registered yet — add one, or use Discover models."}
            </p>
          </div>
        )}

        {groups.map(([provider, rows]) => {
          const isCollapsed = !hasFilters && collapsedSet.has(provider);
          const attentionCount = rows.filter((m) => m.enabled && (!m.is_ready || m.verified_ok === false)).length;
          return (
            <div className="panel" key={provider} style={{ marginBottom: 12 }}>
              <div className="panel-head" style={{ cursor: "pointer" }} onClick={() => toggleCollapse(provider)}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    style={{ width: 12, height: 12, transform: isCollapsed ? "rotate(-90deg)" : undefined, transition: "transform 0.1s" }}
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                  <h2 style={{ textTransform: "capitalize" }}>{provider}</h2>
                  <span className="tag">{rows.length}</span>
                  {isCollapsed && attentionCount > 0 && (
                    <span className="pill bad" title={`${attentionCount} enabled model(s) not confirmed working`}>
                      <span className="d" />
                      {attentionCount} needs attention
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6 }} onClick={(e) => e.stopPropagation()}>
                  <button className="btn sm ghost" onClick={() => verifyGroup(rows)}>
                    Verify group
                  </button>
                  <button className="btn sm ghost" onClick={() => setGroupEnabled(rows, true)}>
                    Enable all
                  </button>
                  <button className="btn sm ghost" onClick={() => setGroupEnabled(rows, false)}>
                    Disable all
                  </button>
                </div>
              </div>
              {!isCollapsed && (
                <div className="tablewrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Alias</th>
                        <th>Model</th>
                        <th>Route</th>
                        <th className="num">$in/M</th>
                        <th className="num">$out/M</th>
                        <th>Connectivity</th>
                        <th>Enabled</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((m) => {
                        const readiness = modelReadiness(m);
                        return (
                          <tr key={m.id} style={{ opacity: m.enabled ? 1 : 0.6 }}>
                            <td className="mono" style={{ fontWeight: 600 }}>
                              {m.alias}
                            </td>
                            <td className="mono" style={{ color: "var(--ink-2)" }}>
                              {m.model}
                            </td>
                            <td>{m.route}</td>
                            <td className="num">{m.price_input_per_mtok?.toFixed(3) ?? "—"}</td>
                            <td className="num">{m.price_output_per_mtok?.toFixed(3) ?? "—"}</td>
                            <td>
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <span className={`pill ${readiness.cls}`} title={m.verified_message ?? undefined}>
                                  <span className="d" />
                                  {readiness.label}
                                </span>
                                {m.is_ready && (
                                  <button
                                    className="iconbtn"
                                    title="Verify connectivity"
                                    onClick={() => verify(m.id, m.alias)}
                                    disabled={busyIds.has(m.id)}
                                  >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                      <path d="M21 12a9 9 0 11-3-6.7M21 3v6h-6" />
                                    </svg>
                                  </button>
                                )}
                              </div>
                              {m.verified_at && (
                                <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 2 }}>
                                  checked {fmtDate(m.verified_at)}
                                </div>
                              )}
                            </td>
                            <td>
                              <label className="switch">
                                <input type="checkbox" checked={m.enabled} onChange={(e) => toggle(m.id, e.target.checked)} />
                                <span className="track" />
                                <span className="knob" />
                              </label>
                            </td>
                            <td style={{ display: "flex", gap: 2 }}>
                              <button className="iconbtn" title="Edit" onClick={() => openEditDrawer(m)}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
                                </svg>
                              </button>
                              <button className="iconbtn" title="Remove" onClick={() => remove(m.id, m.alias)}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m2 0l-1 13a1 1 0 01-1 1H8a1 1 0 01-1-1L6 7" />
                                </svg>
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <Drawer
        open={open}
        title={editingId ? `Edit ${form.alias}` : "Add model"}
        onClose={() => setOpen(false)}
        footer={
          <>
            <button className="btn ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn primary" onClick={save} disabled={createModel.isPending || updateModel.isPending}>
              {editingId ? "Save changes" : "Add model"}
            </button>
          </>
        }
      >
        <div className="field">
          <label>Alias</label>
          <input
            type="text"
            value={form.alias}
            placeholder="e.g. llama-4-scout"
            onChange={(e) => setForm({ ...form, alias: e.target.value })}
          />
        </div>
        <div className="field">
          <label>Model slug</label>
          <input
            type="text"
            value={form.model}
            placeholder="vendor/model-slug"
            onChange={(e) => setForm({ ...form, model: e.target.value })}
          />
          <span className="hint">Sent to the API as-is, e.g. meta-llama/llama-4-scout.</span>
        </div>
        <div className="field">
          <label>Route</label>
          <select value={form.route} onChange={(e) => setForm({ ...form, route: e.target.value as ModelIn["route"] })}>
            <option value="openrouter">openrouter (default)</option>
            <option value="direct">direct — vendor/region key</option>
            <option value="anthropic">anthropic — x-api-key</option>
            <option value="bedrock">bedrock — AWS SigV4</option>
          </select>
        </div>
        {form.route === "direct" && (
          <div className="grid2">
            <div className="field">
              <label>Base URL env var</label>
              <input type="text" value={form.base_url_env} onChange={(e) => setForm({ ...form, base_url_env: e.target.value })} />
            </div>
            <div className="field">
              <label>API key env var</label>
              <input type="text" value={form.api_key_env} onChange={(e) => setForm({ ...form, api_key_env: e.target.value })} />
            </div>
          </div>
        )}
        {form.route === "anthropic" && (
          <div className="field">
            <label>API key env var</label>
            <input
              type="text"
              value={form.api_key_env}
              placeholder="ANTHROPIC_API_KEY (default if left blank)"
              onChange={(e) => setForm({ ...form, api_key_env: e.target.value })}
            />
          </div>
        )}
        {form.route === "bedrock" && (
          <>
            <div className="field">
              <label>AWS region</label>
              <input type="text" value={form.region} placeholder="us-east-1" onChange={(e) => setForm({ ...form, region: e.target.value })} />
            </div>
            <div className="grid2">
              <div className="field">
                <label>Access key env var</label>
                <input
                  type="text"
                  value={form.aws_access_key_id_env}
                  placeholder="AWS_ACCESS_KEY_ID"
                  onChange={(e) => setForm({ ...form, aws_access_key_id_env: e.target.value })}
                />
              </div>
              <div className="field">
                <label>Secret key env var</label>
                <input
                  type="text"
                  value={form.aws_secret_access_key_env}
                  placeholder="AWS_SECRET_ACCESS_KEY"
                  onChange={(e) => setForm({ ...form, aws_secret_access_key_env: e.target.value })}
                />
              </div>
            </div>
            <div className="field">
              <label>Session token env var (optional)</label>
              <input
                type="text"
                value={form.aws_session_token_env}
                placeholder="Leave blank if using long-lived IAM user credentials"
                onChange={(e) => setForm({ ...form, aws_session_token_env: e.target.value })}
              />
            </div>
          </>
        )}
        <div className="field">
          <label>Tags</label>
          <input type="text" value={tagsText} placeholder="fast, cheap, open-weight" onChange={(e) => setTagsText(e.target.value)} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 6 }}>
            {SUGGESTED_TAGS.filter((t) => !tagsText.split(",").map((s) => s.trim()).includes(t)).map((t) => (
              <button
                key={t}
                className="tag"
                style={{ cursor: "pointer", border: "1px dashed var(--line-strong)" }}
                onClick={() => setTagsText((prev) => (prev.trim() ? `${prev}, ${t}` : t))}
              >
                + {t}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label>Known for</label>
          <textarea
            rows={3}
            value={form.notes ?? ""}
            placeholder="What's this model good at? What should people watch out for? Shows up on the Model guide page."
            onChange={(e) => setForm({ ...form, notes: e.target.value || null })}
          />
        </div>
        <div className="grid2">
          <div className="field">
            <label>Temperature</label>
            <input
              type="number"
              step={0.1}
              value={form.temperature}
              onChange={(e) => setForm({ ...form, temperature: Number(e.target.value) })}
            />
          </div>
          <div className="field">
            <label>Max tokens</label>
            <input
              type="number"
              value={form.max_tokens}
              onChange={(e) => setForm({ ...form, max_tokens: Number(e.target.value) })}
            />
          </div>
        </div>
      </Drawer>

      <DiscoverModelsDrawer open={discoverOpen} onClose={() => setDiscoverOpen(false)} />
    </>
  );
}
