import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { AuthenticatedCaller } from "./http/auth.js";
import { employeeDisplay } from "./services/employee-display.js";
import type { FrozenSnapshot, LoadedExpertProjection, LoadedSolutionProjection } from "./storage/sqlite.js";
import type { UsageSummary } from "./usage.js";
import { normalizeSkillSigningKeyMetadata as parseSkillSigningKeyMetadata, skillRefsForSnapshot, type SignedSkillPackage, type SkillSigningKeyMetadata } from "./skills.js";
import type { RuntimeProviderConfig } from "./pi/model-runtime.js";

export const HINDSIGHT_CLIENT_PROTOCOL = "aiteam-memory-v1" as const;

export interface HindsightRuntimeConfig {
  /** Manager facade URL; never a direct Hindsight service URL. */
  base_url: string;
  /** Bank selected by Manager; never supplied by a Pi model/tool call. */
  bank_id: string;
  /** Current Manager responses always include this; optional only for legacy read-only responses. */
  allowed_operations?: ("recall" | "retain")[];
  /** Positive for a current write lease; legacy read-only responses may omit it. */
  policy_revision?: number;
  /** Current negotiated protocol; null/absent means read-only compatibility mode. */
  client_protocol?: typeof HINDSIGHT_CLIENT_PROTOCOL | null;
  /** Current Manager consent; absent/false never restores stale auto-retain permission. */
  explicit_auto_retain?: boolean;
  /** Fact-only finite/guarded mode versus unrestricted future policy. */
  retention_mode?: "unlimited" | "fact_only";
  /** Opaque short-lived Manager facade lease token. Keep in process memory only. */
  token: string;
  lease_id: string;
  version: number;
  issued_at: string;
  expires_at: string;
}

export interface AuthorizedConfig {
  experts: LoadedExpertProjection[];
  solutions: LoadedSolutionProjection[];
  snapshots?: FrozenSnapshot[];
  revoked_ids?: string[];
  skill_packages?: SignedSkillPackage[];
  skill_packages_authoritative?: boolean;
  skill_signing_keys?: SkillSigningKeyMetadata[];
}

export interface MarketplaceTemplate {
  template_id: string;
  description: string | null;
  platform_skill_refs: Array<{ skill_id: string; version: string; content_hash: string }> | null;
  display_name: string;
  category: string;
  model_name: string;
  skills_count: number;
  recruit_count: number | null;
  is_recruited: boolean;
  tags: string[];
  avatar_url: string | null;
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
  pullRuntimeConfig?(caller: AuthenticatedCaller, employeeId: string): Promise<RuntimeProviderConfig>;
  /** Member-scoped ASR config; intentionally does not require an employee id. */
  pullSpeechRuntimeConfig?(caller: AuthenticatedCaller, model?: string): Promise<RuntimeProviderConfig>;
  pullHindsightRuntimeConfig?(caller: AuthenticatedCaller, employeeId: string, rotate?: boolean): Promise<HindsightRuntimeConfig>;
  pullSnapshots?(caller: AuthenticatedCaller, experts: LoadedExpertProjection[]): Promise<FrozenSnapshot[]>;
  getOrgTree(caller: AuthenticatedCaller): Promise<unknown>;
  listMarketplaceTemplates?(caller: AuthenticatedCaller): Promise<MarketplaceTemplate[]>;
  memoryDelete?(caller: AuthenticatedCaller, employeeId: string, memoryId: string, idempotencyKey?: string): Promise<void>;
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

  async pullRuntimeConfig(caller: AuthenticatedCaller, employeeId: string): Promise<RuntimeProviderConfig> {
    const response = await this.request("/api/manager/provider-credentials/runtime-config", caller, { employee_id: employeeId });
    return normalizeRuntimeProviderConfigWithDns(this.unwrap(response));
  }

  async pullSpeechRuntimeConfig(caller: AuthenticatedCaller, model?: string): Promise<RuntimeProviderConfig> {
    const response = await this.request(
      "/api/manager/provider-credentials/speech/runtime-config",
      caller,
      model ? { model } : {},
    );
    return normalizeRuntimeProviderConfigWithDns(this.unwrap(response));
  }

  async pullHindsightRuntimeConfig(caller: AuthenticatedCaller, employeeId: string, rotate = false): Promise<HindsightRuntimeConfig> {
    const response = await this.request(
      "/api/manager/hindsight/runtime-config",
      caller,
      { employee_id: employeeId, client_protocol: HINDSIGHT_CLIENT_PROTOCOL, ...(rotate ? { rotate: true } : {}) },
    );
    return normalizeHindsightRuntimeConfig(this.unwrap(response), this.baseUrl);
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

  async listMarketplaceTemplates(caller: AuthenticatedCaller): Promise<MarketplaceTemplate[]> {
    const response = await this.request("/api/manager/recruit/catalog/experts", caller);
    const value = this.unwrap(response);
    if (!Array.isArray(value)) throw new ManagerUnavailableError("Manager returned an invalid marketplace catalog");
    return value.map(normalizeMarketplaceTemplate);
  }

  async memoryDelete(caller: AuthenticatedCaller, employeeId: string, memoryId: string, idempotencyKey?: string): Promise<void> {
    await this.request(`/api/manager/memories/${encodeURIComponent(memoryId)}`, caller, undefined, { employee_id: employeeId }, "DELETE", idempotencyKey);
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
    const response = await this.requestResponse(path, caller, body, query, method, idempotencyKey);
    if (response.status === 204) return undefined;
    try {
      return await response.json();
    } catch (error) {
      throw new ManagerUnavailableError("Manager returned an invalid response", { cause: error });
    }
  }

  private async requestResponse(
    path: string,
    caller: AuthenticatedCaller,
    body?: unknown,
    query?: Record<string, string>,
    method?: "GET" | "POST" | "DELETE",
    idempotencyKey?: string,
  ): Promise<Response> {
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
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new ManagerAuthorizationError(response.status);
      throw new ManagerUnavailableError(`Manager returned HTTP ${response.status}`);
    }
    return response;
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

export class ManagerAuthorizationError extends ManagerUnavailableError {
  constructor(readonly status: 401 | 403) {
    super(status === 401 ? "Manager authentication is required" : "Manager authorization was denied");
    this.name = "ManagerAuthorizationError";
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
  if (body.skill_signing_keys !== undefined && !Array.isArray(body.skill_signing_keys)) throw new ManagerUnavailableError("Manager returned invalid skill signing key metadata");
  const skill_signing_keys = Array.isArray(body.skill_signing_keys) ? body.skill_signing_keys.map(normalizeSkillSigningKey) : undefined;
  return { experts, solutions, ...(snapshots ? { snapshots } : {}), revoked_ids, ...(hasSkillPackages && skill_packages ? { skill_packages } : {}), ...(skill_signing_keys ? { skill_signing_keys } : {}) };
}

function normalizeSkillSigningKey(value: unknown): SkillSigningKeyMetadata {
  try { return parseSkillSigningKeyMetadata(value); }
  catch { throw new ManagerUnavailableError("Manager returned invalid skill signing key metadata"); }
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
  const skills = normalizeSnapshotSkillRefs(raw);
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
    ...employeeDisplay(raw),
    tools: stringArray(raw.tools),
    skills,
    skill_refs: skills,
    knowledge_policy: normalizeKnowledgePolicy(raw.knowledge_policy),
  };
}

function normalizeMarketplaceTemplate(value: unknown): MarketplaceTemplate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManagerUnavailableError("Manager returned an invalid marketplace template");
  const raw = value as Record<string, unknown>;
  if (typeof raw.template_id !== "string" || raw.template_id.length === 0 || raw.template_id.length > 256) throw new ManagerUnavailableError("Manager returned an invalid marketplace template");
  const skills = Array.isArray(raw.platform_skill_refs)
    ? raw.platform_skill_refs.filter((ref) => ref && typeof ref === "object" && !Array.isArray(ref) && ["skill_id", "version", "content_hash"].every((key) => typeof ref[key] === "string" && ref[key].length > 0))
      .map((ref) => ({ skill_id: ref.skill_id as string, version: ref.version as string, content_hash: ref.content_hash as string }))
    : stringArray(raw.skill_ids);
  const tags = stringArray(raw.tags);
  return {
    template_id: raw.template_id,
    description: typeof raw.description === "string" ? raw.description : null,
    platform_skill_refs: Array.isArray(raw.platform_skill_refs) ? skills as NonNullable<MarketplaceTemplate["platform_skill_refs"]> : null,
    display_name: typeof raw.display_name === "string" ? raw.display_name : raw.template_id,
    category: typeof raw.category === "string" ? raw.category : "",
    model_name: typeof raw.platform_model_ref === "object" && raw.platform_model_ref !== null && typeof (raw.platform_model_ref as Record<string, unknown>).model_id === "string"
      ? (raw.platform_model_ref as Record<string, unknown>).model_id as string
      : typeof raw.default_model === "string" ? raw.default_model : "",
    skills_count: Array.isArray(raw.platform_skill_refs) ? skills.length : typeof raw.skills_count === "number" && Number.isInteger(raw.skills_count) && raw.skills_count >= 0 ? raw.skills_count : skills.length,
    recruit_count: typeof raw.recruit_count === "number" && Number.isInteger(raw.recruit_count) && raw.recruit_count >= 0 ? raw.recruit_count : null,
    is_recruited: raw.is_recruited === true,
    tags,
    avatar_url: typeof raw.avatar_url === "string" && raw.avatar_url.length > 0 ? raw.avatar_url : null,
  };
}

function normalizeSolution(value: unknown, tenantId?: string, memberId?: string): LoadedSolutionProjection {
  if (!value || typeof value !== "object") throw new ManagerUnavailableError("Manager returned an invalid solution projection");
  const raw = value as Record<string, unknown>;
  // Manager's solution projection uses `id` for the tenant solution_instance and
  // `solution_id` for the immutable Operator catalog source. Prefer the instance.
  const id = stringValue(raw.solution_instance_id ?? raw.id ?? raw.solution_id, "solution_instance_id");
  const version = String(raw.version ?? (raw.solution_version !== undefined && raw.config_version !== undefined ? `${raw.solution_version}:${raw.config_version}` : raw.solution_version ?? raw.config_version ?? ""));
  assertOwnership(raw, tenantId, memberId);
  return { ...raw, solution_instance_id: id, display_name: typeof raw.display_name === "string" ? raw.display_name : id, version, ...(tenantId ? { tenant_id: tenantId } : {}), ...(memberId ? { member_id: memberId } : (typeof raw.member_id === "string" ? { member_id: raw.member_id } : {})) };
}

export function normalizeHindsightRuntimeConfig(value: unknown, managerUrl?: string): HindsightRuntimeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManagerUnavailableError("Manager returned an invalid Hindsight runtime config");
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["base_url", "bank_id", "token", "lease_id", "version", "issued_at", "expires_at", "allowed_operations", "policy_revision", "retention_mode", "client_protocol", "explicit_auto_retain"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw new ManagerUnavailableError("Manager returned an invalid Hindsight runtime config");
  const baseUrlValue = raw.base_url;
  const bankId = raw.bank_id;
  const token = raw.token;
  const leaseId = raw.lease_id;
  const issuedAtValue = raw.issued_at;
  const expiresAtValue = raw.expires_at;
  if ([baseUrlValue, bankId, token, leaseId, issuedAtValue, expiresAtValue].some((item) => typeof item !== "string" || item.trim() === "")) throw new ManagerUnavailableError("Manager returned an incomplete Hindsight runtime config");
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) throw new ManagerUnavailableError("Manager returned an invalid Hindsight lease version");
  if (!/^aiteam-[0-9a-f]{32}$/u.test(bankId as string)) throw new ManagerUnavailableError("Manager returned an invalid Hindsight bank scope");
  if (/\s/u.test(token as string) || /[\\/]/u.test(leaseId as string)) throw new ManagerUnavailableError("Manager returned an invalid Hindsight lease");
  const issuedAt = Date.parse(issuedAtValue as string);
  const expiresAt = Date.parse(expiresAtValue as string);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt || expiresAt <= Date.now()) throw new ManagerUnavailableError("Manager returned an expired Hindsight lease");
  let baseUrl: string;
  try {
    const parsed = new URL(baseUrlValue as string, managerUrl);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname.replace(/\/$/u, "") !== "/api/manager/hindsight") throw new Error("invalid facade URL");
    if (managerUrl) {
      const manager = new URL(managerUrl);
      if (parsed.origin !== manager.origin) throw new Error("facade URL is not Manager-owned");
    }
    baseUrl = parsed.toString().replace(/\/$/u, "");
  } catch {
    throw new ManagerUnavailableError("Manager returned an invalid Hindsight facade URL");
  }
  if (raw.client_protocol !== undefined && raw.client_protocol !== null && raw.client_protocol !== HINDSIGHT_CLIENT_PROTOCOL) throw new ManagerUnavailableError("Manager returned an unsupported memory client protocol");
  if (raw.explicit_auto_retain !== undefined && typeof raw.explicit_auto_retain !== "boolean") throw new ManagerUnavailableError("Manager returned invalid automatic memory consent");
  const confirmedProtocol = raw.client_protocol === HINDSIGHT_CLIENT_PROTOCOL;
  if (confirmedProtocol && (!Array.isArray(raw.allowed_operations) || typeof raw.policy_revision !== "number" || !Number.isSafeInteger(raw.policy_revision) || raw.policy_revision < 1)) throw new ManagerUnavailableError("Manager returned an incomplete versioned memory lease");
  if (raw.retention_mode !== undefined && raw.retention_mode !== "unlimited" && raw.retention_mode !== "fact_only") throw new ManagerUnavailableError("Manager returned invalid memory retention mode");
  if (raw.allowed_operations !== undefined && (!Array.isArray(raw.allowed_operations) || raw.allowed_operations.some((op) => op !== "recall" && op !== "retain") || raw.allowed_operations.length > 2)) throw new ManagerUnavailableError("Manager returned invalid Hindsight operations");
  if (raw.policy_revision !== undefined && (typeof raw.policy_revision !== "number" || !Number.isSafeInteger(raw.policy_revision) || raw.policy_revision < 0)) throw new ManagerUnavailableError("Manager returned invalid memory revision");
  return { base_url: baseUrl, bank_id: bankId as string, token: token as string, lease_id: leaseId as string, version: raw.version, issued_at: issuedAtValue as string, expires_at: expiresAtValue as string,
    explicit_auto_retain: confirmedProtocol && raw.explicit_auto_retain === true,
    ...(raw.client_protocol !== undefined ? { client_protocol: raw.client_protocol as typeof HINDSIGHT_CLIENT_PROTOCOL | null } : {}),
    ...(raw.allowed_operations !== undefined ? { allowed_operations: (raw.allowed_operations as ("recall" | "retain")[]).filter((op) => confirmedProtocol || op === "recall") } : {}),
    ...(raw.policy_revision !== undefined ? { policy_revision: raw.policy_revision as number } : {}),
    ...(raw.retention_mode !== undefined ? { retention_mode: raw.retention_mode as "unlimited" | "fact_only" } : {}),
  };
}

function isLocalIpv4(host: string): boolean {
  const octets = host.split(".").map(Number);
  const [first, second] = octets;
  return first === 0 || first === 10 || first === 127 || (first === 100 && second >= 64 && second <= 127) || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && (second === 0 || second === 168)) || (first === 198 && (second === 18 || second === 19 || second === 51)) || (first === 203 && second === 0) || first >= 224;
}

function isLocalRelayHost(hostValue: string): boolean {
  const host = hostValue.replace(/^\[/u, "").replace(/\]$/u, "").replace(/\.$/u, "").toLowerCase();
  if ((host && !host.includes(".") && !host.includes(":")) || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".localdomain") || host.endsWith(".internal") || host.endsWith(".intranet")) return true;
  const version = isIP(host);
  if (version === 4) return isLocalIpv4(host);
  if (version === 6) {
    if (host === "::" || host === "::1") return true;
    if (host.startsWith("::ffff:")) {
      const mapped = host.slice("::ffff:".length);
      return isIP(mapped) === 4 ? isLocalIpv4(mapped) : true;
    }
    const [firstPart, secondPart] = host.split(":");
    const first = Number.parseInt(firstPart || "0", 16);
    const second = Number.parseInt(secondPart || "0", 16);
    // Reject non-global/special-purpose IPv6 ranges as well as private,
    // link-local, multicast and documentation space.  Relay destinations must
    // be globally routable, not merely syntactically valid IPv6.
    return first === 0 || first === 0x0100 || (first >= 0xfe00 && first <= 0xfeff) || (first >= 0xfc00 && first <= 0xfdff) || first >= 0xff00 || host.startsWith("2001:db8") || (first === 0x2001 && second <= 0x0020) || (first === 0x0064 && second === 0xff9b) || first === 0x2002 || first === 0x3ffe;
  }
  return false;
}

function isLocalRelayDestination(url: URL): boolean {
  return isLocalRelayHost(url.hostname);
}

function isGlobalRelayAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return !isLocalIpv4(address);
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (isLocalRelayHost(normalized)) return false;
    const parts = normalized.split(":");
    const first = Number.parseInt(parts[0] || "0", 16);
    const second = Number.parseInt(parts[1] || "0", 16);
    return !(first === 0x2001 && second <= 0x0020) && !(first === 0x0064 && second === 0xff9b) && first !== 0x2002 && first !== 0x3ffe;
  }
  return false;
}

function normalizeRuntimePricing(value: unknown): RuntimeProviderConfig["pricing"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManagerUnavailableError("Manager returned invalid runtime pricing");
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["pricing_version", "pricing_status", "billing_mode", "input_usd_per_million", "output_usd_per_million", "cache_read_usd_per_million", "cache_write_usd_per_million", "request_usd", "currency", "effective_from"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw new ManagerUnavailableError("Manager returned invalid runtime pricing");
  if (typeof raw.pricing_version !== "number" || !Number.isInteger(raw.pricing_version) || raw.pricing_version < 1 || (raw.pricing_status !== "known" && raw.pricing_status !== "unknown") || (raw.billing_mode !== "token" && raw.billing_mode !== "request") || raw.currency !== "USD" || typeof raw.effective_from !== "string" || !Number.isFinite(Date.parse(raw.effective_from))) throw new ManagerUnavailableError("Manager returned incomplete runtime pricing");
  for (const key of ["input_usd_per_million", "output_usd_per_million", "cache_read_usd_per_million", "cache_write_usd_per_million", "request_usd"]) {
    const item = raw[key];
    if (item !== null && (typeof item !== "string" || item.trim() === "" || !Number.isFinite(Number(item)) || Number(item) < 0)) throw new ManagerUnavailableError("Manager returned invalid runtime pricing rate");
  }
  return raw as unknown as RuntimeProviderConfig["pricing"];
}

export async function normalizeRuntimeProviderConfigWithDns(value: unknown): Promise<RuntimeProviderConfig> {
  const config = normalizeRuntimeProviderConfig(value);
  if (process.env.AITEAM_ENV !== "production") return config;
  try {
    const url = new URL(config.base_url);
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((item) => !isGlobalRelayAddress(item.address))) throw new Error("non-global relay destination");
  } catch {
    throw new ManagerUnavailableError("Manager returned a relay URL with an invalid production destination");
  }
  return config;
}

export function normalizeRuntimeProviderConfig(value: unknown): RuntimeProviderConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManagerUnavailableError("Manager returned an invalid runtime provider config");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["base_url", "api_protocol", "api_key", "model", "provider_ref", "provider_version", "model_version", "pricing", "version", "model_capabilities"].includes(key))) throw new ManagerUnavailableError("Manager returned an invalid runtime provider config");
  if (["base_url", "api_key", "model", "provider_ref"].some((key) => typeof raw[key] !== "string" || raw[key] === "")) throw new ManagerUnavailableError("Manager returned an incomplete runtime provider config");
  let relayUrl: URL;
  try {
    relayUrl = new URL(raw.base_url as string);
    if ((relayUrl.protocol !== "http:" && relayUrl.protocol !== "https:") || relayUrl.username || relayUrl.password || relayUrl.search || relayUrl.hash || /\s/u.test(raw.base_url as string) || !relayUrl.pathname.replace(/\/$/u, "").endsWith("/v1") || (process.env.AITEAM_ENV === "production" && (relayUrl.protocol !== "https:" || isLocalRelayDestination(relayUrl)))) throw new Error("invalid relay URL");
  } catch {
    throw new ManagerUnavailableError("Manager returned an invalid runtime relay URL");
  }
  if (raw.api_protocol !== "openai-completions" && raw.api_protocol !== "openai-responses" && raw.api_protocol !== "anthropic-messages") throw new ManagerUnavailableError("Manager returned an invalid runtime provider protocol");
  for (const key of ["version", "provider_version", "model_version"]) if (typeof raw[key] !== "number" || !Number.isInteger(raw[key]) || Number(raw[key]) < 1) throw new ManagerUnavailableError("Manager returned an invalid runtime provider version");
  const capabilities = normalizeRuntimeModelCapabilities(raw.model_capabilities);
  return { ...raw, base_url: relayUrl.toString().replace(/\/$/u, ""), pricing: normalizeRuntimePricing(raw.pricing), ...(capabilities ? { model_capabilities: capabilities } : {}) } as unknown as RuntimeProviderConfig;
}

function normalizeRuntimeModelCapabilities(value: unknown): RuntimeProviderConfig["model_capabilities"] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManagerUnavailableError("Manager returned invalid model capabilities");
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["context_window", "max_tokens", "reasoning", "input", "thinking_level_map"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw new ManagerUnavailableError("Manager returned invalid model capabilities");
  const output: NonNullable<RuntimeProviderConfig["model_capabilities"]> = {};
  for (const key of ["context_window", "max_tokens"] as const) {
    const item = raw[key];
    if (item !== undefined && (typeof item !== "number" || !Number.isInteger(item) || item < 1 || item > 10_000_000)) throw new ManagerUnavailableError("Manager returned invalid model capabilities");
    if (item !== undefined) output[key] = item;
  }
  if (raw.reasoning !== undefined) {
    if (typeof raw.reasoning !== "boolean") throw new ManagerUnavailableError("Manager returned invalid model capabilities");
    output.reasoning = raw.reasoning;
  }
  if (raw.input !== undefined) {
    if (!Array.isArray(raw.input) || raw.input.some((item) => item !== "text" && item !== "image")) throw new ManagerUnavailableError("Manager returned invalid model capabilities");
    output.input = [...new Set(raw.input)] as Array<"text" | "image">;
  }
  if (raw.thinking_level_map !== undefined) {
    if (!raw.thinking_level_map || typeof raw.thinking_level_map !== "object" || Array.isArray(raw.thinking_level_map)) throw new ManagerUnavailableError("Manager returned invalid model capabilities");
    const map = raw.thinking_level_map as Record<string, unknown>;
    const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    if (Object.keys(map).some((key) => !levels.has(key) || (map[key] !== null && typeof map[key] !== "string"))) throw new ManagerUnavailableError("Manager returned invalid model capabilities");
    output.thinking_level_map = map as unknown as NonNullable<typeof output.thinking_level_map>;
  }
  return output;
}

function normalizeKnowledgePolicy(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  const policy = objectValue(value);
  if (!policy || !["inherit", "allow", "deny"].includes(String(policy.state))
      || !Array.isArray(policy.allowed_operations) || policy.allowed_operations.length > 2
      || policy.allowed_operations.some((name) => name !== "knowledge_search" && name !== "knowledge_get")
      || new Set(policy.allowed_operations).size !== policy.allowed_operations.length
      || (policy.state === "deny" && policy.allowed_operations.length !== 0)) {
    throw new ManagerUnavailableError("Manager returned an invalid knowledge policy");
  }
  return { state: policy.state, allowed_operations: [...policy.allowed_operations], revision: stringValue(policy.revision, "knowledge policy revision") };
}

function normalizeSnapshotSkillRefs(raw: Record<string, unknown>): string[] {
  try {
    return skillRefsForSnapshot(raw);
  } catch {
    throw new ManagerUnavailableError("Manager returned invalid employee skills");
  }
}

function normalizeSnapshot(value: unknown, tenantId?: string, memberId?: string): FrozenSnapshot {
  if (!value || typeof value !== "object") throw new ManagerUnavailableError("Manager returned an invalid employee snapshot");
  const raw = value as Record<string, unknown>;
  const employeeId = stringValue(raw.employee_id, "employee_id");
  const version = String(raw.version ?? "");
  const snapshotVersion = stringValue(raw.snapshot_version, "snapshot_version");
  if (!version) throw new ManagerUnavailableError("Manager snapshot is missing version");
  assertOwnership(raw, tenantId, memberId);
  let skillSigningKeys: SkillSigningKeyMetadata[] | undefined;
  if (Object.prototype.hasOwnProperty.call(raw, "skill_signing_keys")) {
    if (!Array.isArray(raw.skill_signing_keys)) throw new ManagerUnavailableError("Manager returned invalid snapshot skill signing key metadata");
    skillSigningKeys = raw.skill_signing_keys.map(normalizeSkillSigningKey);
  }
  let canonicalSkills: string[];
  try {
    canonicalSkills = skillRefsForSnapshot(raw);
  } catch {
    throw new ManagerUnavailableError("Manager returned invalid snapshot skills");
  }
  return {
    ...raw,
    employee_id: employeeId,
    version,
    snapshot_version: snapshotVersion,
    display_name: typeof raw.display_name === "string" ? raw.display_name : employeeId,
    model_policy: objectValue(raw.model_policy) ?? {},
    tools: stringArray(raw.tools),
    // Keep the canonical and compatibility fields equivalent in local
    // projections so consumers cannot advertise stale legacy refs.
    skills: canonicalSkills,
    skill_refs: canonicalSkills,
    ...(skillSigningKeys === undefined ? {} : { skill_signing_keys: skillSigningKeys }),
    tool_policy: objectValue(raw.tool_policy) ?? { allowed_tools: stringArray(raw.tools) },
    knowledge_policy: normalizeKnowledgePolicy(raw.knowledge_policy),
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
