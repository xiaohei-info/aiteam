import type { AuthenticatedCaller } from "./http/auth.js";
import type { FrozenSnapshot, LoadedExpertProjection, LoadedSolutionProjection } from "./storage/sqlite.js";

export interface AuthorizedConfig {
  experts: LoadedExpertProjection[];
  solutions: LoadedSolutionProjection[];
  snapshots?: FrozenSnapshot[];
  revoked_ids?: string[];
}

export interface ManagerAuthInput {
  tenant_id: string;
  account: string;
  password: string;
}

export interface ManagerOwnerResetInput {
  tenant_id: string;
  account: string;
  old_password: string;
  new_password: string;
}

export interface ManagerClient {
  login?(input: ManagerAuthInput): Promise<unknown>;
  ownerReset?(input: ManagerOwnerResetInput): Promise<unknown>;
  pullAuthorizedConfig(caller: AuthenticatedCaller, knownVersions: Record<string, string>): Promise<AuthorizedConfig>;
  pullSnapshots?(caller: AuthenticatedCaller, experts: LoadedExpertProjection[]): Promise<FrozenSnapshot[]>;
  getOrgTree(caller: AuthenticatedCaller): Promise<unknown>;
  memoryRecall?(caller: AuthenticatedCaller, employeeId: string, query: string, limit: number): Promise<unknown>;
  memoryRetain?(caller: AuthenticatedCaller, employeeId: string, content: string, metadata: Record<string, unknown>): Promise<unknown>;
  memoryDelete?(caller: AuthenticatedCaller, memoryId: string): Promise<void>;
  knowledgeSearch?(caller: AuthenticatedCaller, employeeId: string, knowledgeRefs: readonly string[], query: string, limit: number): Promise<unknown>;
  knowledgeGet?(caller: AuthenticatedCaller, employeeId: string, knowledgeRefs: readonly string[], citationId: string): Promise<unknown>;
}

export class ManagerAuthError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`Manager authentication returned HTTP ${status}`);
    this.name = "ManagerAuthError";
  }
}

/** Thin Agent→Manager seam. It never turns transport failure into authorization. */
export class HttpManagerClient implements ManagerClient {
  constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async login(input: ManagerAuthInput): Promise<unknown> {
    return this.authRequest("/api/auth/login", input);
  }

  async ownerReset(input: ManagerOwnerResetInput): Promise<unknown> {
    return this.authRequest("/api/auth/owner-reset", input);
  }

  private async authRequest(path: string, body: unknown): Promise<unknown> {
    const response = await this.fetchImpl(new URL(path, this.baseUrl).toString(), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) throw new ManagerAuthError(response.status, payload);
    return payload;
  }

  async pullAuthorizedConfig(caller: AuthenticatedCaller, knownVersions: Record<string, string>): Promise<AuthorizedConfig> {
    const response = await this.request("/api/manager/grants/authorized-config", caller, {
      tenant_id: caller.tenantId,
      member_id: caller.userId ?? caller.callerId,
      known_versions: knownVersions,
    });
    return this.unwrap(response) as AuthorizedConfig;
  }

  async pullSnapshots(caller: AuthenticatedCaller, experts: LoadedExpertProjection[]): Promise<FrozenSnapshot[]> {
    const snapshots: FrozenSnapshot[] = [];
    for (const expert of experts) {
      const response = await this.request("/api/manager/snapshots", caller, {
        tenant_id: caller.tenantId,
        member_id: caller.userId ?? caller.callerId,
        employee_id: expert.employee_id,
        employee_version: expert.version,
      });
      const value = this.unwrap(response) as { snapshot?: FrozenSnapshot };
      if (!value?.snapshot) throw new ManagerUnavailableError("Manager returned an invalid snapshot response");
      snapshots.push(value.snapshot);
    }
    return snapshots;
  }

  async getOrgTree(caller: AuthenticatedCaller): Promise<unknown> {
    const response = await this.request("/api/manager/org/tree", caller);
    return this.unwrap(response);
  }

  async memoryRecall(caller: AuthenticatedCaller, employeeId: string, query: string, limit: number): Promise<unknown> {
    const response = await this.request("/api/manager/memories/recall", caller, undefined, {
      employee_id: employeeId,
      query,
      limit: String(limit),
    });
    return this.unwrap(response);
  }

  async memoryRetain(caller: AuthenticatedCaller, employeeId: string, content: string, metadata: Record<string, unknown>): Promise<unknown> {
    const response = await this.request("/api/manager/memories/retain", caller, {
      employee_id: employeeId,
      content,
      metadata,
    });
    return this.unwrap(response);
  }

  async memoryDelete(caller: AuthenticatedCaller, memoryId: string): Promise<void> {
    await this.request(`/api/manager/memories/${encodeURIComponent(memoryId)}`, caller, undefined, undefined, "DELETE");
  }

  async knowledgeSearch(caller: AuthenticatedCaller, employeeId: string, knowledgeRefs: readonly string[], query: string, limit: number): Promise<unknown> {
    const response = await this.request("/api/manager/knowledge/artifacts/search", caller, {
      employee_id: employeeId,
      knowledge_refs: [...knowledgeRefs],
      query,
      limit,
    });
    return this.unwrap(response);
  }

  async knowledgeGet(caller: AuthenticatedCaller, employeeId: string, knowledgeRefs: readonly string[], citationId: string): Promise<unknown> {
    const response = await this.request("/api/manager/knowledge/artifacts/get", caller, {
      employee_id: employeeId,
      knowledge_refs: [...knowledgeRefs],
      citation_id: citationId,
    });
    return this.unwrap(response);
  }

  private async request(
    path: string,
    caller: AuthenticatedCaller,
    body?: unknown,
    query?: Record<string, string>,
    method?: "GET" | "POST" | "DELETE",
  ): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const requestMethod = method ?? (body === undefined ? "GET" : "POST");
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: requestMethod,
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(caller.accessToken ? { Authorization: `Bearer ${caller.accessToken}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new ManagerUnavailableError("Manager request failed", { cause: error });
    }
    if (!response.ok) throw new ManagerUnavailableError(`Manager returned HTTP ${response.status}`);
    if (response.status === 204) return undefined;
    try {
      return await response.json();
    } catch (error) {
      throw new ManagerUnavailableError("Manager returned an invalid response", { cause: error });
    }
  }

  private unwrap(value: unknown): unknown {
    if (!value || typeof value !== "object") throw new ManagerUnavailableError("Manager returned an invalid response");
    const body = value as { data?: unknown };
    return body.data ?? value;
  }
}

export class ManagerUnavailableError extends Error {
  constructor(message = "Manager is unavailable", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ManagerUnavailableError";
  }
}
