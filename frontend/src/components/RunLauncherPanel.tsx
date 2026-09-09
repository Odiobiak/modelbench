import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  useCancelRun,
  useEstimateQuery,
  useLaunchRun,
  useModels,
  useRun,
  useUpdateModel,
  useVerifyModel,
} from "../api/hooks";
import { fmtMoney, modelReadiness } from "../format";
import { toast } from "../toast";
import { ApiError } from "../api/client";
import DiscoverModelsDrawer from "./DiscoverModelsDrawer";

/**
 * The "pick models, see the estimate, launch, watch progress" flow -- shared
 * between the full Launch page (packNames = every selected pack, no
 * caseKeys) and the Test Cases page's "run N selected" drawer (packNames =
 * [currentPack], caseKeys = the checked rows).
 *
 * Shows every registered model, not just enabled ones -- a disabled model
 * (e.g. freshly added via Discover, which defaults to disabled) can still be
 * picked for a one-off run here; the backend already allows naming a
 * disabled alias explicitly (registry_db.load_registry_from_db keeps a row
 * even when disabled if its alias is in the requested `only` list).
 */
export default function RunLauncherPanel({
  packNames,
  caseKeys,
  caseCountLabel,
}: {
  packNames: string[];
  caseKeys?: string[] | null;
  caseCountLabel: string;
}) {
  const { data: models } = useModels();
  const sortedModels = useMemo(
    () => [...(models ?? [])].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.alias.localeCompare(b.alias)),
    [models]
  );

  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [repeats, setRepeats] = useState(3);
  const [mock, setMock] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [verifyingIds, setVerifyingIds] = useState<Set<string>>(new Set());
  const [discoverOpen, setDiscoverOpen] = useState(false);

  const modelIds = Array.from(selectedModels);
  const canEstimate = modelIds.length > 0 && packNames.length > 0;

  const { data: estimate } = useEstimateQuery(
    { model_ids: modelIds, pack_names: packNames, case_keys: caseKeys ?? undefined, repeats },
    canEstimate
  );
  const launchRun = useLaunchRun();
  const activeRun = useRun(activeRunId);
  const cancelRun = useCancelRun();
  const updateModel = useUpdateModel();
  const verifyModel = useVerifyModel();

  const selectedRows = sortedModels.filter((m) => selectedModels.has(m.alias));
  const unverified = !mock && selectedRows.filter((m) => !m.is_ready || m.verified_ok === false);

  function toggleModel(alias: string) {
    const next = new Set(selectedModels);
    if (next.has(alias)) next.delete(alias);
    else next.add(alias);
    setSelectedModels(next);
  }

  async function toggleEnabled(id: string, enabled: boolean) {
    try {
      await updateModel.mutateAsync({ id, body: { enabled } });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Failed to update model");
    }
  }

  async function verifyOne(id: string, alias: string) {
    setVerifyingIds((prev) => new Set(prev).add(id));
    try {
      const out = await verifyModel.mutateAsync(id);
      toast(out.verified_ok ? `${alias}: verified` : `${alias}: ${out.verified_message}`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Verification failed");
    } finally {
      setVerifyingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function verifySelected() {
    const targets = selectedRows.filter((m) => m.is_ready);
    if (!targets.length) {
      toast("Nothing to verify — select a model with a key configured first");
      return;
    }
    setVerifyingIds(new Set(targets.map((m) => m.id)));
    try {
      const results = await Promise.all(
        targets.map((m) =>
          verifyModel.mutateAsync(m.id).catch(() => ({ alias: m.alias, verified_ok: false, verified_message: "request failed" }))
        )
      );
      const ok = results.filter((r) => r.verified_ok).length;
      toast(`Verified ${ok} of ${results.length} selected model(s)`);
    } finally {
      setVerifyingIds(new Set());
    }
  }

  async function launch() {
    if (!canEstimate) return;
    try {
      const run = await launchRun.mutateAsync({
        model_ids: modelIds,
        pack_names: packNames,
        case_keys: caseKeys ?? undefined,
        repeats,
        mock,
      });
      setActiveRunId(run.run_id);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Failed to launch run");
    }
  }

  const run = activeRun.data;
  const pct = run?.total_calls ? Math.min(100, (run.calls_done / run.total_calls) * 100) : 0;
  const busy = run != null && (run.status === "pending" || run.status === "running");

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>Models</h2>
          <span className="sub">
            {modelIds.length} of {sortedModels.length} selected
            {selectedRows.length > 0 && (
              <>
                {" · "}
                <a
                  href="#"
                  style={{ color: "var(--accent)" }}
                  onClick={(e) => {
                    e.preventDefault();
                    verifySelected();
                  }}
                >
                  verify selected
                </a>
              </>
            )}
            {" · "}
            <a
              href="#"
              style={{ color: "var(--accent)" }}
              onClick={(e) => {
                e.preventDefault();
                setDiscoverOpen(true);
              }}
            >
              discover more models
            </a>
          </span>
        </div>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 32 }}></th>
                <th>Model</th>
                <th>Route</th>
                <th className="num">$in/M</th>
                <th>Connectivity</th>
                <th>Enabled</th>
              </tr>
            </thead>
            <tbody>
              {sortedModels.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty-hint">
                    No models registered yet —{" "}
                    <a href="#" style={{ color: "var(--accent)" }} onClick={(e) => { e.preventDefault(); setDiscoverOpen(true); }}>
                      discover some
                    </a>{" "}
                    from a provider you have a key for, or add one on the Models page.
                  </td>
                </tr>
              )}
              {sortedModels.map((m) => {
                const readiness = modelReadiness(m);
                return (
                  <tr key={m.id} style={{ opacity: m.enabled ? 1 : 0.65 }}>
                    <td>
                      <input type="checkbox" checked={selectedModels.has(m.alias)} onChange={() => toggleModel(m.alias)} />
                    </td>
                    <td>
                      <div className="mono" style={{ fontWeight: 600 }}>
                        {m.alias}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--muted)" }}>{m.vendor ?? m.model}</div>
                    </td>
                    <td style={{ fontSize: 12.5 }}>{m.route}</td>
                    <td className="num">{m.price_input_per_mtok != null ? `$${m.price_input_per_mtok.toFixed(3)}` : "—"}</td>
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
                            onClick={() => verifyOne(m.id, m.alias)}
                            disabled={verifyingIds.has(m.id)}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M21 12a9 9 0 11-3-6.7M21 3v6h-6" />
                            </svg>
                          </button>
                        )}
                      </div>
                    </td>
                    <td>
                      <label className="switch">
                        <input type="checkbox" checked={m.enabled} onChange={(e) => toggleEnabled(m.id, e.target.checked)} />
                        <span className="track" />
                        <span className="knob" />
                      </label>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Run settings</h2>
          <span className="sub">{caseCountLabel}</span>
        </div>
        <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="field">
            <label>Repeats per case</label>
            <input type="number" min={1} max={20} value={repeats} onChange={(e) => setRepeats(Number(e.target.value) || 1)} />
          </div>
          <label className="checkrow" style={{ padding: 0 }}>
            <input type="checkbox" checked={mock} onChange={(e) => setMock(e.target.checked)} />
            <span className="name" style={{ fontSize: 13 }}>
              Mock run
            </span>
            <span className="desc">— zero keys, zero spend</span>
          </label>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Estimate</h2>
        </div>
        <div style={{ padding: "6px 18px 4px" }}>
          {estimate ? (
            <>
              {Object.entries(estimate.per_model).map(([alias, cost]) => (
                <div className="estimate-row" key={alias}>
                  <span className="mono">{alias}</span>
                  <span className="amt">{mock ? "mock" : fmtMoney(cost)}</span>
                </div>
              ))}
              <div className="estimate-total">
                <span>total</span>
                <span className="amt">{mock ? "$0.00 (mock)" : fmtMoney(estimate.total_usd)}</span>
              </div>
              {!mock && estimate.exceeds_ceiling && (
                <p className="note" style={{ padding: "10px 0 0", color: "var(--critical)" }}>
                  Exceeds the ${estimate.ceiling_usd.toFixed(2)} ceiling — the run will abort partway.
                </p>
              )}
            </>
          ) : (
            <p className="empty-hint">Select at least one model.</p>
          )}
          {unverified && unverified.length > 0 && (
            <p className="note" style={{ padding: "10px 0 0", color: "var(--warning)" }}>
              {unverified.length} selected model(s) {unverified.length === 1 ? "hasn't" : "haven't"} been verified as
              working: {unverified.map((m) => m.alias).join(", ")}. They'll likely error mid-run — verify first, or
              proceed anyway.
            </p>
          )}
        </div>
        <div style={{ padding: "0 18px 18px" }}>
          <button
            className="btn primary"
            style={{ width: "100%", justifyContent: "center", padding: 11 }}
            disabled={!canEstimate || launchRun.isPending || busy}
            onClick={launch}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M5 3l16 9-16 9V3z" />
            </svg>
            Launch run
          </button>
        </div>
      </div>

      {run && (
        <div className="panel">
          <div className="panel-head">
            <h2>{run.run_id}</h2>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className={`status ${run.status}`}>
                <span className="d" />
                {run.status}
              </span>
              <Link className="btn sm ghost" to={`/runs/${run.run_id}`}>
                View full run →
              </Link>
            </div>
          </div>
          <div style={{ padding: "16px 18px" }}>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="progress-meta">
              <span>
                {run.calls_done} / {run.total_calls ?? "?"} calls
              </span>
              <span>${run.spend_usd.toFixed(4)} spent</span>
            </div>
            {run.error_message && (
              <p className="note" style={{ padding: "10px 0 0", color: "var(--critical)" }}>
                {run.error_message}
              </p>
            )}
            {busy && (
              <button className="btn sm ghost" style={{ marginTop: 10 }} onClick={() => cancelRun.mutate(run.run_id)}>
                Cancel run
              </button>
            )}
          </div>
        </div>
      )}

      <DiscoverModelsDrawer open={discoverOpen} onClose={() => setDiscoverOpen(false)} />
    </>
  );
}
