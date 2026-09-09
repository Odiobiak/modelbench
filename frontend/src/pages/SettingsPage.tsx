import { useEffect, useState } from "react";
import { useSaveSettings, useSettings } from "../api/hooks";
import type { SettingsPayload } from "../api/types";
import { toast } from "../toast";
import { ApiError } from "../api/client";

export default function SettingsPage() {
  const { data, isLoading, error } = useSettings();
  const saveSettings = useSaveSettings();
  const [form, setForm] = useState<SettingsPayload | null>(null);

  useEffect(() => {
    if (data && !form) setForm(data.payload);
  }, [data, form]);

  async function save() {
    if (!form) return;
    try {
      await saveSettings.mutateAsync(form);
      toast("Settings saved");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Failed to save settings");
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Settings</h1>
          <p>Run-wide defaults and the judge configuration. Stored once, applied to every launch.</p>
        </div>
        <button className="btn primary" onClick={save} disabled={!form || saveSettings.isPending}>
          Save changes
        </button>
      </div>
      <div className="content">
        {isLoading && <p className="empty-hint">Loading…</p>}
        {error && !form && (
          <p className="empty-hint">
            No settings saved yet. Run the import script (<span className="mono">python -m api.migrate.import_existing</span>)
            to seed it from config/settings.yaml.
          </p>
        )}
        {form && (
          <>
            <div className="panel">
              <div className="panel-head">
                <h2>Run</h2>
              </div>
              <div style={{ padding: "16px 18px" }} className="grid2">
                <div className="field">
                  <label>Default repeats</label>
                  <input
                    type="number"
                    value={form.run.repeats}
                    onChange={(e) => setForm({ ...form, run: { ...form.run, repeats: Number(e.target.value) } })}
                  />
                </div>
                <div className="field">
                  <label>Concurrency</label>
                  <input
                    type="number"
                    value={form.run.concurrency}
                    onChange={(e) => setForm({ ...form, run: { ...form.run, concurrency: Number(e.target.value) } })}
                  />
                </div>
                <div className="field">
                  <label>Retry attempts</label>
                  <input
                    type="number"
                    value={form.run.retry_attempts}
                    onChange={(e) => setForm({ ...form, run: { ...form.run, retry_attempts: Number(e.target.value) } })}
                  />
                </div>
                <div className="field">
                  <label>Spend ceiling (USD)</label>
                  <input
                    type="number"
                    step={0.5}
                    value={form.run.max_spend_usd}
                    onChange={(e) => setForm({ ...form, run: { ...form.run, max_spend_usd: Number(e.target.value) } })}
                  />
                </div>
              </div>
            </div>

            <div className="panel">
              <div className="panel-head">
                <h2>Judge</h2>
                <span className="sub">Pinned outside the models under test — self-preference bias is large</span>
              </div>
              <div style={{ padding: "16px 18px" }} className="grid2">
                <div className="field">
                  <label>Judge model</label>
                  <input
                    type="text"
                    value={form.judge.model}
                    onChange={(e) => setForm({ ...form, judge: { ...form.judge, model: e.target.value } })}
                  />
                </div>
                <div className="field">
                  <label>Temperature</label>
                  <input
                    type="number"
                    step={0.1}
                    value={form.judge.temperature}
                    onChange={(e) => setForm({ ...form, judge: { ...form.judge, temperature: Number(e.target.value) } })}
                  />
                </div>
                <div className="field">
                  <label>Calibration sample rate</label>
                  <input
                    type="number"
                    step={0.05}
                    value={form.judge.calibration_sample_rate}
                    onChange={(e) =>
                      setForm({ ...form, judge: { ...form.judge, calibration_sample_rate: Number(e.target.value) } })
                    }
                  />
                </div>
                <div className="field">
                  <label>Max tokens</label>
                  <input
                    type="number"
                    value={form.judge.max_tokens}
                    onChange={(e) => setForm({ ...form, judge: { ...form.judge, max_tokens: Number(e.target.value) } })}
                  />
                </div>
                <label className="checkrow" style={{ padding: 0 }}>
                  <input
                    type="checkbox"
                    checked={form.judge.enabled}
                    onChange={(e) => setForm({ ...form, judge: { ...form.judge, enabled: e.target.checked } })}
                  />
                  <span className="name" style={{ fontSize: 13 }}>
                    Judge enabled
                  </span>
                </label>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
