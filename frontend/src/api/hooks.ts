import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type {
  CaseIn,
  CaseOut,
  DashboardOut,
  DiscoverOut,
  DiscoverRequest,
  EstimateOut,
  EstimateRequest,
  ModelIn,
  ModelOut,
  ModelUpdate,
  PackCreate,
  PackOut,
  RunCaseOut,
  RunLaunchRequest,
  RunOut,
  RunResultsOut,
  SettingsOut,
  SettingsPayload,
  VerifyOut,
} from "./types";

// ── models ──────────────────────────────────────────────────────────────
export function useModels() {
  return useQuery({ queryKey: ["models"], queryFn: () => api.get<ModelOut[]>("/models") });
}
export function useCreateModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ModelIn) => api.post<ModelOut>("/models", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["models"] }),
  });
}
export function useUpdateModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ModelUpdate }) => api.patch<ModelOut>(`/models/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["models"] }),
  });
}
export function useDeleteModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/models/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["models"] }),
  });
}
export function useVerifyModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<VerifyOut>(`/models/${id}/verify`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["models"] }),
  });
}
export function useVerifyAllModels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<VerifyOut[]>("/models/verify-all"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["models"] }),
  });
}
export function useDiscoverModels() {
  return useMutation({ mutationFn: (body: DiscoverRequest) => api.post<DiscoverOut>("/models/discover", body) });
}
export function useBulkCreateModels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (models: ModelIn[]) => api.post<ModelOut[]>("/models/bulk", { models }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["models"] }),
  });
}

// ── test cases ──────────────────────────────────────────────────────────
export function usePacks() {
  return useQuery({ queryKey: ["packs"], queryFn: () => api.get<PackOut[]>("/packs") });
}
export function useCases(pack: string | null) {
  return useQuery({
    queryKey: ["cases", pack],
    queryFn: () => api.get<CaseOut[]>(`/packs/${pack}/cases`),
    enabled: !!pack,
  });
}
export function useCreatePack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PackCreate) => api.post<PackOut>("/packs", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["packs"] }),
  });
}
export function useAddCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pack, body }: { pack: string; body: CaseIn }) => api.post<CaseOut>(`/packs/${pack}/cases`, body),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["cases", vars.pack] });
      qc.invalidateQueries({ queryKey: ["packs"] });
    },
  });
}
export function useDeleteCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pack, caseKey }: { pack: string; caseKey: string }) =>
      api.del(`/packs/${pack}/cases/${caseKey}`),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["cases", vars.pack] });
      qc.invalidateQueries({ queryKey: ["packs"] });
    },
  });
}

// ── runs ────────────────────────────────────────────────────────────────
export function useRuns() {
  return useQuery({ queryKey: ["runs"], queryFn: () => api.get<RunOut[]>("/runs"), refetchInterval: 5000 });
}
export function useRun(runId: string | null) {
  return useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.get<RunOut>(`/runs/${runId}`),
    enabled: !!runId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "running" ? 700 : false;
    },
  });
}
export function useRunResults(runId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["run-results", runId],
    queryFn: () => api.get<RunResultsOut>(`/runs/${runId}/results`),
    enabled: !!runId && enabled,
  });
}
export function useRunCases(runId: string | null) {
  return useQuery({
    queryKey: ["run-cases", runId],
    queryFn: () => api.get<RunCaseOut[]>(`/runs/${runId}/cases`),
    enabled: !!runId,
  });
}
export function useLaunchRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RunLaunchRequest) => api.post<RunOut>("/runs", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runs"] }),
  });
}
export function useCancelRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.post(`/runs/${runId}/cancel`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runs"] }),
  });
}
export function useEstimate() {
  return useMutation({ mutationFn: (body: EstimateRequest) => api.post<EstimateOut>("/runs/estimate", body) });
}
export function useEstimateQuery(body: EstimateRequest, enabled: boolean) {
  return useQuery({
    queryKey: ["estimate", body],
    queryFn: () => api.post<EstimateOut>("/runs/estimate", body),
    enabled,
    retry: false,
  });
}

// ── dashboard ───────────────────────────────────────────────────────────
export function useDashboard(models?: string[]) {
  const qs = models && models.length ? `?models=${encodeURIComponent(models.join(","))}` : "";
  return useQuery({
    queryKey: ["dashboard", models ?? null],
    queryFn: () => api.get<DashboardOut>(`/dashboard${qs}`),
    retry: false,
  });
}

// ── settings ────────────────────────────────────────────────────────────
export function useSettings() {
  return useQuery({ queryKey: ["settings"], queryFn: () => api.get<SettingsOut>("/settings"), retry: false });
}
export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: SettingsPayload) => api.put<SettingsOut>("/settings", payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });
}
