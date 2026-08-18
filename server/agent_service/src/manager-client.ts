import type { AuthenticatedCaller } from "./http/auth.js";
import type { FrozenSnapshot, LoadedExpertProjection, LoadedSolutionProjection } from "./storage/sqlite.js";
import type { UsageSummary } from "./usage.js";
import type { SignedSkillPackage } from "./skills.js";

export interface AuthorizedConfig {
  experts: LoadedExpertProjection[];
  solutions: LoadedSolutionProjection[];
  snapshots?: FrozenSnapshot[];
  revoked_ids?: string[];
  skill_packages?: SignedSkillPackage[];
  skill_packages_authoritative?: boolean;
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
  resolveTenantByAccount?(account: string): Promise<unknown>;
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
  uploadUsage?(caller: AuthenticatedCaller, summary: UsageSummary): Promise<unknown>;
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

  async resolveTenantByAccount(account: string): Promise<unknown> {
    return this.authRequest("/api/auth/resolve-tenant-by-account", { account });
  }

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
    return normalizeAuthorizedConfig(this.unwrap(response), caller.tenantId, caller.userId ?? caller.callerId);
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
      const value = this.unwrap(response) as { snapshot?: unknown };
      if (!value?.snapshot) throw new ManagerUnavailableError("Manager returned an invalid snapshot response");
      snapshots.push(normalizeSnapshot(value.snapshot, caller.tenantId, caller.userId ?? caller.callerId));
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

  async uploadUsage(caller: AuthenticatedCaller, summary: UsageSummary): Promise<unknown> {
    return this.unwrap(await this.request("/api/manager/usage/upload", caller, { tenant_id: summary.tenant_id, usage: [summary], audits: [] }, undefined, "POST", summary.summary_id));
  }

  private async request(
    path: string,
    caller: AuthenticatedCaller,
    body?: unknown,
    query?: Record<string, string>,
    method?: "GET" | "POST" | "DELETE",
    idempotencyKey?: string,
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
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
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

export function normalizeAuthorizedConfig(value: unknown, tenantId?: string, memberId?: string): AuthorizedConfig {
  if (!value || typeof value !== "object") throw new ManagerUnavailableError("Manager returned an invalid authorized config");
  const body = value as Record<string, unknown>;
  const experts = Array.isArray(body.experts) ? body.experts.map((item) => normalizeExpert(item, tenantId, memberId)) : [];
  const solutions = Array.isArray(body.solutions) ? body.solutions.map((item) => normalizeSolution(item, tenantId, memberId)) : [];
  const snapshots = Array.isArray(body.snapshots) ? body.snapshots.map((item) => normalizeSnapshot(item, tenantId, memberId)) : undefined;
  const revoked_ids = Array.isArray(body.revoked_ids) ? body.revoked_ids.filter((id): id is string => typeof id === "string") : [];
  const hasSkillPackages = Object.prototype.hasOwnProperty.call(body, "skill_packages");
  const skillPackagesAuthoritative = body.skill_packages_authoritative !== false;
  const skill_packages = skillPackagesAuthoritative && Array.isArray(body.skill_packages) ? body.skill_packages.map(normalizeSignedSkillPackage) : undefined;
  return { experts, solutions, ...(snapshots ? { snapshots } : {}), revoked_ids, ...(hasSkillPackages && skill_packages ? { skill_packages } : {}) };
}

function normalizeSignedSkillPackage(value: unknown): SignedSkillPackage {
  if (!value || typeof value !== "object") throw new ManagerUnavailableError("Manager returned an invalid signed skill package");
  const raw = value as Record<string, unknown>;
  if (raw.algorithm !== "Ed25519" || typeof raw.key_id !== "string" || typeof raw.signature !== "string" || typeof raw.tenant_id !== "string" || typeof raw.member_id !== "string" || !raw.package || typeof raw.package !== "object") throw new ManagerUnavailableError("Manager returned an unsigned or invalid skill package");
  if (raw.tenant_id.length === 0 || raw.member_id.length === 0) throw new ManagerUnavailableError("Manager returned an unscoped skill package");
  return { package: raw.package as SignedSkillPackage["package"], tenant_id: raw.tenant_id, member_id: raw.member_id, key_id: raw.key_id, algorithm: "Ed25519", signature: raw.signature };
}

function normalizeExpert(value: unknown, tenantId?: string, memberId?: string): LoadedExpertProjection {
  if (!value || typeof value !== "object") throw new ManagerUnavailableError("Manager returned an invalid employee projection");
  const raw = value as Record<string, unknown>;
  const employeeId = stringValue(raw.employee_id, "employee_id");
  const version = String(raw.version ?? "");
  if (!version) throw new ManagerUnavailableError("Manager employee projection is missing version");
  const modelPolicy = objectValue(raw.model_policy) ?? {
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
    ...(typeof raw.provider_ref === "string" ? { provider_ref: raw.provider_ref } : {}),
    ...(typeof raw.thinking_level === "string" ? { thinking_level: raw.thinking_level } : {}),
  };
  assertOwnership(raw, tenantId, memberId);
  return {
    ...raw,
    employee_id: employeeId,
    tenant_id: tenantId ?? (typeof raw.tenant_id === "string" ? raw.tenant_id : ""),
    ...(memberId ? { member_id: memberId } : (typeof raw.member_id === "string" ? { member_id: raw.member_id } : {})),
    version,
    handle: typeof raw.employee_slug === "string" ? raw.employee_slug : typeof raw.handle === "string" ? raw.handle : employeeId,
    display_name: typeof raw.display_name === "string" ? raw.display_name : employeeId,
    revoked: raw.revoked === true,
    synced_at: typeof raw.synced_at === "string" ? raw.synced_at : new Date().toISOString(),
    model_policy: modelPolicy,
    tools: stringArray(raw.tools),
    skills: stringArray(raw.skills ?? raw.skill_refs),
  };
}

function normalizeSolution(value: unknown, tenantId?: string, memberId?: string): LoadedSolutionProjection {
  if (!value || typeof value !== "object") throw new ManagerUnavailableError("Manager returned an invalid solution projection");
  const raw = value as Record<string, unknown>;
  const id = stringValue(raw.solution_instance_id ?? raw.solution_id ?? raw.id, "solution_instance_id");
  const version = String(raw.version ?? (raw.solution_version !== undefined && raw.config_version !== undefined ? `${raw.solution_version}:${raw.config_version}` : raw.solution_version ?? raw.config_version ?? ""));
  assertOwnership(raw, tenantId, memberId);
  return { ...raw, solution_instance_id: id, display_name: typeof raw.display_name === "string" ? raw.display_name : id, version, ...(tenantId ? { tenant_id: tenantId } : {}), ...(memberId ? { member_id: memberId } : (typeof raw.member_id === "string" ? { member_id: raw.member_id } : {})) };
}

function normalizeSnapshot(value: unknown, tenantId?: string, memberId?: string): FrozenSnapshot {
  if (!value || typeof value !== "object") throw new ManagerUnavailableError("Manager returned an invalid employee snapshot");
  const raw = value as Record<string, unknown>;
  const employeeId = stringValue(raw.employee_id, "employee_id");
  const version = String(raw.version ?? "");
  const snapshotVersion = stringValue(raw.snapshot_version, "snapshot_version");
  if (!version) throw new ManagerUnavailableError("Manager snapshot is missing version");
  assertOwnership(raw, tenantId, memberId);
  return {
    ...raw,
    employee_id: employeeId,
    version,
    snapshot_version: snapshotVersion,
    display_name: typeof raw.display_name === "string" ? raw.display_name : employeeId,
    model_policy: objectValue(raw.model_policy) ?? {},
    tools: stringArray(raw.tools),
    skill_refs: stringArray(raw.skill_refs ?? raw.skills),
    tool_policy: objectValue(raw.tool_policy) ?? { allowed_tools: stringArray(raw.tools) },
    ...(tenantId ? { tenant_id: tenantId } : (typeof raw.tenant_id === "string" ? { tenant_id: raw.tenant_id } : {})),
    ...(memberId ? { member_id: memberId } : (typeof raw.member_id === "string" ? { member_id: raw.member_id } : {})),
  };
}

function assertOwnership(raw: Record<string, unknown>, tenantId?: string, memberId?: string): void {
  if (tenantId && raw.tenant_id !== undefined && raw.tenant_id !== tenantId) throw new ManagerUnavailableError("Manager returned a projection for a different tenant");
  if (memberId && raw.member_id !== undefined && raw.member_id !== memberId) throw new ManagerUnavailableError("Manager returned a projection for a different member");
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) throw new ManagerUnavailableError(`Manager projection is missing ${name}`);
  return value;
}
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function objectValue(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
