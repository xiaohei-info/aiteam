import { useMemo } from "react";
import { createOperationApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type {
  DraftCreateInput,
  DraftDetail,
  DraftList,
  DraftSummary,
  FindingResolution,
  GeneratedSolution,
  GenerationJob,
  SourceDocument,
} from "./types";

const BASE = "/api/operation/solution-authoring/drafts";

export interface SolutionAuthoringApi {
  list: () => Promise<DraftList>;
  create: (input: DraftCreateInput) => Promise<{ draft_id: string }>;
  get: (draftId: string) => Promise<DraftDetail>;
  archive: (draftId: string) => Promise<void>;
  cancelGeneration: (draftId: string) => Promise<DraftDetail>;
  uploadSource: (draftId: string, file: File) => Promise<SourceDocument>;
  deleteSource: (draftId: string, sourceId: string) => Promise<void>;
  generate: (draftId: string, idempotencyKey: string) => Promise<GenerationJob>;
  updatePackage: (draftId: string, version: number, body: GeneratedSolution) => Promise<DraftDetail>;
  resolveFinding: (draftId: string, findingId: string, resolution: FindingResolution) => Promise<DraftDetail>;
  submitReview: (draftId: string) => Promise<DraftDetail>;
  approve: (draftId: string, note: string) => Promise<DraftDetail>;
  reject: (draftId: string, note: string) => Promise<DraftDetail>;
  publish: (draftId: string) => Promise<DraftDetail>;
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error("服务端返回了空结果");
  return value;
}

export function useSolutionAuthoringApi(): SolutionAuthoringApi {
  const { token, onUnauthorized } = useSession();
  return useMemo<SolutionAuthoringApi>(() => {
    const client = createOperationApiClient({ getToken: () => token, onUnauthorized });
    const draft = (draftId: string) => `${BASE}/${draftId}`;
    return {
      async list() {
        const result = await client.listGet<DraftSummary>(BASE);
        return { drafts: result.items, workerAvailable: result.meta?.worker_available !== false };
      },
      async create(input) { return required(await client.post<{ draft_id: string }>(BASE, { body: input })); },
      async get(draftId) { return required(await client.get<DraftDetail>(draft(draftId))); },
      async archive(draftId) { await client.del<null>(draft(draftId)); },
      async cancelGeneration(draftId) { return required(await client.post<DraftDetail>(`${draft(draftId)}/generation/cancel`)); },
      async uploadSource(draftId, file) {
        const body = new FormData();
        body.append("file", file, file.name);
        return required(await client.post<SourceDocument>(`${draft(draftId)}/sources`, { body }));
      },
      async deleteSource(draftId, sourceId) { await client.del<null>(`${draft(draftId)}/sources/${sourceId}`); },
      async generate(draftId, idempotencyKey) {
        return required(await client.post<GenerationJob>(`${draft(draftId)}/generate`, { idempotencyKey }));
      },
      async updatePackage(draftId, version, body) {
        return required(await client.put<DraftDetail>(`${draft(draftId)}/package`, { body: { version, package: body } }));
      },
      async resolveFinding(draftId, findingId, resolution) {
        return required(await client.post<DraftDetail>(`${draft(draftId)}/findings/${findingId}/resolve`, { body: { resolution } }));
      },
      async submitReview(draftId) { return required(await client.post<DraftDetail>(`${draft(draftId)}/submit-review`)); },
      async approve(draftId, note) { return required(await client.post<DraftDetail>(`${draft(draftId)}/approve`, { body: { note } })); },
      async reject(draftId, note) { return required(await client.post<DraftDetail>(`${draft(draftId)}/reject`, { body: { note } })); },
      async publish(draftId) { return required(await client.post<DraftDetail>(`${draft(draftId)}/publish`)); },
    };
  }, [token, onUnauthorized]);
}
