import { useMemo, useState } from "react";
import { usePacks } from "../api/hooks";
import RunLauncherPanel from "../components/RunLauncherPanel";

export default function LaunchPage() {
  const { data: packs } = usePacks();
  const [selectedPacks, setSelectedPacks] = useState<Set<string>>(new Set());

  const availablePacks = useMemo(() => (packs ?? []).filter((p) => !selectedPacks.has(p.name)), [packs, selectedPacks]);
  const chosenPacks = useMemo(() => (packs ?? []).filter((p) => selectedPacks.has(p.name)), [packs, selectedPacks]);
  const packNames = useMemo(() => Array.from(selectedPacks), [selectedPacks]);
  const totalCases = chosenPacks.reduce((sum, p) => sum + p.case_count, 0);

  function addPack(name: string) {
    setSelectedPacks(new Set([...selectedPacks, name]));
  }
  function removePack(name: string) {
    const next = new Set(selectedPacks);
    next.delete(name);
    setSelectedPacks(next);
  }
  function selectAllPacks() {
    setSelectedPacks(new Set((packs ?? []).map((p) => p.name)));
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Launch a run</h1>
          <p>Pick packs and models, verify connectivity, see the projected spend before anything is spent, then run it.</p>
        </div>
      </div>
      <div className="content">
        <div className="launch-grid">
          <div>
            <div className="panel">
              <div className="panel-head">
                <h2>Suite packs</h2>
                <span className="sub">
                  {packNames.length} of {packs?.length ?? 0} selected
                  {packs?.length ? (
                    <>
                      {" · "}
                      <a href="#" style={{ color: "var(--accent)" }} onClick={(e) => { e.preventDefault(); selectAllPacks(); }}>
                        select all
                      </a>
                      {selectedPacks.size > 0 && (
                        <>
                          {" · "}
                          <a href="#" style={{ color: "var(--accent)" }} onClick={(e) => { e.preventDefault(); setSelectedPacks(new Set()); }}>
                            clear
                          </a>
                        </>
                      )}
                    </>
                  ) : null}
                </span>
              </div>
              <div className="chiprow" style={{ paddingBottom: 14 }}>
                {chosenPacks.map((p) => (
                  <span className="chip active" key={p.name} title={p.tags.join(", ")}>
                    {p.name}
                    <span style={{ color: "var(--muted)", fontWeight: 500 }}>{p.case_count}</span>
                    <span
                      role="button"
                      aria-label={`Remove ${p.name}`}
                      style={{ marginLeft: 2, opacity: 0.6 }}
                      onClick={() => removePack(p.name)}
                    >
                      ×
                    </span>
                  </span>
                ))}
                {availablePacks.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) addPack(e.target.value);
                    }}
                    style={{ width: "auto", fontSize: 12, padding: "5px 8px" }}
                  >
                    <option value="">+ Add pack…</option>
                    {availablePacks.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name} ({p.case_count} cases)
                      </option>
                    ))}
                  </select>
                )}
                {packs?.length === 0 && <p className="empty-hint">No packs found — check suites/.</p>}
              </div>

              {chosenPacks.length > 0 && (
                <div className="tablewrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Pack</th>
                        <th>Difficulty mix</th>
                        <th>Tags</th>
                        <th className="num">Cases</th>
                      </tr>
                    </thead>
                    <tbody>
                      {chosenPacks.map((p) => (
                        <tr key={p.name}>
                          <td className="mono" style={{ fontWeight: 600 }}>
                            {p.name}
                          </td>
                          <td style={{ textTransform: "capitalize", fontSize: 12.5, color: "var(--ink-2)" }}>
                            {p.difficulties.join(", ") || "—"}
                          </td>
                          <td>
                            {p.tags.map((t) => (
                              <span className="tag" key={t}>
                                {t}
                              </span>
                            ))}
                          </td>
                          <td className="num">{p.case_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div>
            <RunLauncherPanel packNames={packNames} caseCountLabel={`${totalCases} total cases across ${packNames.length} pack(s)`} />
          </div>
        </div>
      </div>
    </>
  );
}
