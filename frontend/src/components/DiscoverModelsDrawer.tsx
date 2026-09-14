import { useMemo, useState } from "react";
import Drawer from "./Drawer";
import { useBulkCreateModels, useDiscoverModels } from "../api/hooks";
import type { DiscoverCandidate, ModelIn } from "../api/types";
import { toast } from "../toast";
import { ApiError } from "../api/client";

/**
 * Known env-var pairs already used by the direct-route examples in
 * config/models.yaml / .env.example. "Custom" covers anything else --
 * base_url_env/api_key_env are free text there, same as the "Add model"
 * form already allows for a one-off direct entry.
 */
const PROVIDER_PRESETS: {
  key: string;
  label: string;
  route: "openrouter" | "direct" | "anthropic" | "bedrock";
  base_url_env?: string;
  api_key_env?: string;
  aliasPrefix: string;
}[] = [
  { key: "openrouter", label: "OpenRouter (full catalogue)", route: "openrouter", aliasPrefix: "" },
  { key: "openai", label: "OpenAI", route: "direct", base_url_env: "OPENAI_BASE", api_key_env: "OPENAI_API_KEY", aliasPrefix: "oai" },
  {
    key: "anthropic",
    label: "Anthropic",
    route: "anthropic",
    api_key_env: "ANTHROPIC_API_KEY",
    aliasPrefix: "an",
  },
  { key: "gemini", label: "Gemini", route: "direct", base_url_env: "GEMINI_BASE", api_key_env: "GEMINI_API_KEY", aliasPrefix: "gem" },
  { key: "deepseek", label: "DeepSeek", route: "direct", base_url_env: "DEEPSEEK_BASE", api_key_env: "DEEPSEEK_API_KEY", aliasPrefix: "ds" },
  { key: "azure", label: "Azure OpenAI", route: "direct", base_url_env: "AZURE_OPENAI_BASE", api_key_env: "AZURE_OPENAI_API_KEY", aliasPrefix: "az" },
  // No base_url_env/api_key_env -- Bedrock is SigV4-signed (region + access
  // key + secret key), not a bearer token, so it collects its own fields
  // below rather than reusing the base-url/api-key inputs every other
  // preset shares.
  { key: "bedrock", label: "Amazon Bedrock", route: "bedrock", aliasPrefix: "br" },
  { key: "custom", label: "Custom endpoint…", route: "direct", aliasPrefix: "custom" },
];

function suggestAlias(preset: (typeof PROVIDER_PRESETS)[number], rawModel: string): string {
  let slug = rawModel.replace(/^models\//, "").replace(/\//g, "-").toLowerCase();
  // Bedrock ids use "." and ":" as real separators (anthropic.claude-3-
  // sonnet-20240229-v1:0) -- unlike, say, "gpt-4.1-mini" elsewhere, where
  // "." is part of a version number and must be left alone.
  if (preset.key === "bedrock") slug = slug.replace(/[.:]/g, "-");
  return preset.route === "openrouter" ? slug : `${preset.aliasPrefix}-${slug}`;
}

export default function DiscoverModelsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [presetKey, setPresetKey] = useState(PROVIDER_PRESETS[0].key);
  const [customBaseEnv, setCustomBaseEnv] = useState("");
  const [customKeyEnv, setCustomKeyEnv] = useState("");
  const [bedrockRegion, setBedrockRegion] = useState("us-east-1");
  const [bedrockAccessKeyEnv, setBedrockAccessKeyEnv] = useState("AWS_ACCESS_KEY_ID");
  const [bedrockSecretKeyEnv, setBedrockSecretKeyEnv] = useState("AWS_SECRET_ACCESS_KEY");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const preset = PROVIDER_PRESETS.find((p) => p.key === presetKey)!;
  const discover = useDiscoverModels();
  const bulkCreate = useBulkCreateModels();

  const candidates = discover.data?.candidates ?? [];
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle ? candidates.filter((c) => c.model.toLowerCase().includes(needle)) : candidates;
  }, [candidates, search]);

  async function fetchCandidates() {
    setSelected(new Set());
    try {
      const out = await discover.mutateAsync(
        preset.key === "bedrock"
          ? {
              route: "bedrock",
              region: bedrockRegion,
              aws_access_key_id_env: bedrockAccessKeyEnv,
              aws_secret_access_key_env: bedrockSecretKeyEnv,
            }
          : {
              route: preset.route,
              base_url_env: preset.key === "custom" ? customBaseEnv : preset.base_url_env,
              api_key_env: preset.key === "custom" ? customKeyEnv : preset.api_key_env,
            }
      );
      // Pre-select only the ones that look like plain chat models -- the
      // rest (audio/image/embedding/etc, or anything unfamiliar) still show
      // up, just unchecked, so nothing costly gets added by default.
      setSelected(new Set(out.candidates.filter((c) => c.likely_chat).map((c) => c.model)));
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Discovery failed");
    }
  }

  function toggle(model: string) {
    const next = new Set(selected);
    if (next.has(model)) next.delete(model);
    else next.add(model);
    setSelected(next);
  }

  async function addSelected() {
    const models: ModelIn[] = Array.from(selected).map((m) => ({
      alias: suggestAlias(preset, m),
      model: preset.route === "openrouter" ? m : m,
      route: preset.route,
      enabled: false,
      tags: ["discovered", preset.key],
      base_url_env: preset.key === "custom" ? customBaseEnv : preset.base_url_env ?? "",
      api_key_env: preset.key === "custom" ? customKeyEnv : preset.api_key_env ?? "",
      region: preset.key === "bedrock" ? bedrockRegion : "",
      deployment_type: "",
      aws_access_key_id_env: preset.key === "bedrock" ? bedrockAccessKeyEnv : "",
      aws_secret_access_key_env: preset.key === "bedrock" ? bedrockSecretKeyEnv : "",
      aws_session_token_env: "",
      temperature: 0.2,
      send_temperature: true,
      top_p: null,
      max_tokens: 1024,
      seed: null,
      timeout_s: 120,
      notes: null,
    }));
    try {
      const created = await bulkCreate.mutateAsync(models);
      toast(`Added ${created.length} model(s), disabled by default — enable the ones you want to run`);
      onClose();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Failed to add selected models");
    }
  }

  return (
    <Drawer
      open={open}
      title="Discover models"
      width={480}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={addSelected} disabled={selected.size === 0 || bulkCreate.isPending}>
            Add selected ({selected.size})
          </button>
        </>
      }
    >
      <p className="hint" style={{ margin: "0 0 12px" }}>
        Pulls the real, current model list from the provider's own API — nothing is added to the registry until you
        pick candidates below and confirm. New models are added disabled by default, since some are frontier/flagship
        tier and cost more per call.
      </p>
      <div className="field">
        <label>Provider</label>
        <select value={presetKey} onChange={(e) => setPresetKey(e.target.value)}>
          {PROVIDER_PRESETS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      {preset.key === "custom" && (
        <div className="grid2">
          <div className="field">
            <label>Base URL env var</label>
            <input type="text" value={customBaseEnv} placeholder="MY_PROVIDER_BASE" onChange={(e) => setCustomBaseEnv(e.target.value)} />
          </div>
          <div className="field">
            <label>API key env var</label>
            <input type="text" value={customKeyEnv} placeholder="MY_PROVIDER_API_KEY" onChange={(e) => setCustomKeyEnv(e.target.value)} />
          </div>
        </div>
      )}
      {preset.key === "bedrock" && (
        <>
          <div className="field">
            <label>AWS region</label>
            <input type="text" value={bedrockRegion} placeholder="us-east-1" onChange={(e) => setBedrockRegion(e.target.value)} />
          </div>
          <div className="grid2">
            <div className="field">
              <label>Access key env var</label>
              <input
                type="text"
                value={bedrockAccessKeyEnv}
                placeholder="AWS_ACCESS_KEY_ID"
                onChange={(e) => setBedrockAccessKeyEnv(e.target.value)}
              />
            </div>
            <div className="field">
              <label>Secret key env var</label>
              <input
                type="text"
                value={bedrockSecretKeyEnv}
                placeholder="AWS_SECRET_ACCESS_KEY"
                onChange={(e) => setBedrockSecretKeyEnv(e.target.value)}
              />
            </div>
          </div>
        </>
      )}
      <button className="btn sm ghost" style={{ marginBottom: 14 }} onClick={fetchCandidates} disabled={discover.isPending}>
        {discover.isPending ? "Fetching…" : "Fetch models"}
      </button>

      {candidates.length > 0 && (
        <>
          <div className="field">
            <input type="text" placeholder="Filter…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="checklist" style={{ maxHeight: 360, overflowY: "auto" }}>
            {filtered.map((c: DiscoverCandidate) => (
              <label className="checkrow" key={c.model}>
                <input type="checkbox" checked={selected.has(c.model)} onChange={() => toggle(c.model)} />
                <span className="name mono" style={{ color: c.likely_chat ? undefined : "var(--muted)" }}>
                  {c.model}
                </span>
                {!c.likely_chat && (
                  <span className="n" style={{ fontSize: 10 }}>
                    unfamiliar
                  </span>
                )}
              </label>
            ))}
            {filtered.length === 0 && <p className="empty-hint">No candidates match "{search}".</p>}
          </div>
          <p className="hint" style={{ marginTop: 8 }}>
            {candidates.filter((c) => c.likely_chat).length} of {candidates.length} look like plain chat models and
            are pre-selected — audio/image/embedding/realtime endpoints are excluded from that guess but still listed
            in case the pattern got it wrong.
          </p>
        </>
      )}
    </Drawer>
  );
}
