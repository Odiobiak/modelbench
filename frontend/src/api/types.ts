// Mirrors api/schemas.py field-for-field.

export interface ModelIn {
  alias: string;
  model: string;
  route: "openrouter" | "direct" | "anthropic" | "bedrock";
  enabled: boolean;
  tags: string[];
  base_url_env: string;
  api_key_env: string;
  region: string;
  deployment_type: string;
  aws_access_key_id_env: string;
  aws_secret_access_key_env: string;
  aws_session_token_env: string;
  temperature: number;
  top_p: number | null;
  max_tokens: number;
  seed: number | null;
  timeout_s: number;
  notes: string | null;
}

export interface ModelOut extends ModelIn {
  id: string;
  created_at: string;
  updated_at: string;
  is_ready: boolean | null;
  vendor: string | null;
  canonical_id: string | null;
  context_window: number | null;
  supports_tools: boolean | null;
  price_input_per_mtok: number | null;
  price_output_per_mtok: number | null;
  verified_ok: boolean | null;
  verified_at: string | null;
  verified_message: string | null;
}

export interface VerifyOut {
  alias: string;
  verified_ok: boolean;
  verified_at: string;
  verified_message: string;
}

export type ModelUpdate = Partial<ModelIn>;

export interface DiscoverRequest {
  route: "openrouter" | "direct" | "anthropic" | "bedrock";
  base_url_env?: string;
  api_key_env?: string;
  region?: string;
  aws_access_key_id_env?: string;
  aws_secret_access_key_env?: string;
}

export interface DiscoverCandidate {
  model: string;
  likely_chat: boolean;
}

export interface DiscoverOut {
  route: string;
  base_url: string;
  candidates: DiscoverCandidate[];
}

export interface PackOut {
  name: string;
  case_count: number;
  tags: string[];
  difficulties: string[];
}

export interface PackCreate {
  name: string;
  version?: string;
  system?: string;
  tools?: unknown[];
  judge_defaults?: Record<string, unknown>;
}

export type CheckType = "contains" | "not_contains_any" | "regex" | "max_words" | "max_sentences" | "is_json";

export interface CaseCheck {
  type: CheckType;
  value?: string | number | string[] | null;
}

export interface CaseTurn {
  role: "user" | "assistant";
  content: string;
}

export interface JudgeCriterion {
  name: string;
  description: string;
}

export interface CaseIn {
  case_key?: string | null;
  turns: CaseTurn[];
  system?: string | null;
  tags?: string[];
  difficulty?: "easy" | "medium" | "hard";
  checks?: CaseCheck[];
  judge_criteria?: JudgeCriterion[];
}

export interface AssertionOut {
  type: string;
  value?: unknown;
}

export interface CaseOut {
  id: string;
  pack: string;
  case_key: string;
  messages: { role: string; content: string }[];
  system: string | null;
  tags: string[];
  difficulty: string;
  assertions: AssertionOut[];
  judge: Record<string, unknown>;
  created_at: string;
}

export interface RunLaunchRequest {
  model_ids: string[];
  pack_names: string[];
  case_keys?: string[] | null;
  repeats?: number | null;
  mock: boolean;
  no_judge?: boolean;
}

export interface RunOut {
  run_id: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  model_ids: string[];
  pack_names: string[];
  case_keys: string[] | null;
  repeats: number | null;
  mock: boolean;
  total_calls: number | null;
  calls_done: number;
  spend_usd: number;
  max_spend_usd: number | null;
  error_message: string | null;
  result_path: string | null;
}

export interface RunResultsOut {
  run_id: string;
  status: string;
  summary: Record<string, unknown>[];
}

export interface RunCaseOut {
  case_key: string;
  pack: string;
  model_alias: string;
  repeat_index: number;
  ok: boolean;
  passed: boolean | null;
  error_type: string;
  response_text: string;
  ttft_ms: number | null;
  total_latency_ms: number | null;
  ts_utc: string;
  tags: string;
  difficulty: string;
}

export interface EstimateRequest {
  model_ids: string[];
  pack_names: string[];
  case_keys?: string[] | null;
  repeats?: number | null;
}

export interface EstimateOut {
  total_usd: number;
  per_model: Record<string, number>;
  ceiling_usd: number;
  exceeds_ceiling: boolean;
}

export interface RunSettings {
  repeats: number;
  concurrency: number;
  retry_attempts: number;
  retry_backoff_s: number;
  max_spend_usd: number;
}

export interface JudgeSettings {
  enabled: boolean;
  model: string;
  route: string;
  temperature: number;
  max_tokens: number;
  calibration_sample_rate: number;
}

export interface ReportSettings {
  title: string;
  percentiles: number[];
}

export interface SettingsPayload {
  run: RunSettings;
  judge: JudgeSettings;
  thresholds: Record<string, number>;
  report: ReportSettings;
}

export interface SettingsOut {
  name: string;
  payload: SettingsPayload;
  updated_at: string;
}

export interface DashboardTileValue {
  model: string;
  value: number;
}

export interface DriftAlert {
  model: string;
  metric: string;
  severity: "critical" | "serious" | "good";
  before: string;
  after: string;
  delta: string;
  note: string;
}

export interface VersionLogEntry {
  day: string;
  model: string;
  from: string;
  to: string;
}

export interface ChartSeries {
  name: string;
  values: (number | null)[];
}

export interface ChartData {
  labels: string[];
  series: ChartSeries[];
}

export type ChartFmt = "pct" | "ms" | "usd";

export interface ChartConfig {
  data: ChartData;
  fmt: ChartFmt;
  title: string;
  sub: string;
  threshold: number | null;
}

export interface MatrixRow {
  model: string;
  cells: (number | null)[];
}

export interface DashboardOut {
  meta: {
    calls: number;
    runs: number;
    days: number;
    models: number;
    available_models: string[];
    folded_models: string[];
  };
  tiles: {
    drift_alerts: number;
    version_changes: number;
    best_pass_rate: DashboardTileValue | null;
    cheapest_per_success: DashboardTileValue | null;
    latency_authoritative: boolean;
  };
  alerts: DriftAlert[];
  version_log: VersionLogEntry[];
  charts: { pass: ChartConfig; ttft: ChartConfig; cost: ChartConfig; cache: ChartConfig };
  packs: string[];
  matrix: MatrixRow[];
}
