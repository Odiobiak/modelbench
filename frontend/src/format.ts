import type { ChartFmt, ModelOut } from "./api/types";

export function fmtVal(v: number | null | undefined, fmt: ChartFmt): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (fmt === "pct") return (v * 100).toFixed(1) + "%";
  if (fmt === "ms") return Math.round(v).toLocaleString() + " ms";
  return "$" + v.toFixed(5);
}

export function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return "$" + v.toFixed(v < 0.01 ? 5 : 2);
}

export function modelReadiness(m: Pick<ModelOut, "is_ready" | "verified_ok">): { cls: "on" | "off" | "warn" | "bad"; label: string } {
  if (!m.is_ready) return { cls: "off", label: "no key" };
  if (m.verified_ok === true) return { cls: "on", label: "verified" };
  if (m.verified_ok === false) return { cls: "bad", label: "key invalid" };
  return { cls: "warn", label: "unverified" };
}

/**
 * Groups models by provider for display. `vendor` (catalogue-enriched) is
 * the real signal when present, but a direct-route model with a bare model
 * string (no "vendor/" prefix) enriches to the literal string "unknown" --
 * so fall back to the api_key_env name, which always identifies the
 * provider (OPENAI_API_KEY -> openai, AZURE_OPENAI_API_KEY -> azure openai).
 */
export function providerLabel(m: Pick<ModelOut, "vendor" | "route" | "api_key_env">): string {
  if (m.vendor && m.vendor !== "unknown") return m.vendor;
  // Bedrock has no api_key_env (it's a 3-part AWS credential, not a bearer
  // token) -- registry.py's _enrich usually resolves a real vendor from the
  // dot-prefixed model id (anthropic.claude-3..., amazon.titan...) before
  // this is ever reached, but fall back cleanly if it couldn't.
  if (m.route === "bedrock") return "amazon bedrock";
  if (m.api_key_env) return m.api_key_env.replace(/_API_KEY$/i, "").replace(/_/g, " ").toLowerCase();
  return m.route === "openrouter" ? "openrouter" : "other";
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
