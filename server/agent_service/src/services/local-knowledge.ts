import type { AuthenticatedCaller } from "../http/auth.js";
import type { AgentSqliteStore } from "../storage/sqlite.js";
import { LocalKnowledgeRepository, LocalKnowledgeError, type KnowledgeOwner } from "../storage/local-knowledge.js";
export { LocalKnowledgeError } from "../storage/local-knowledge.js";
export const LOCAL_KNOWLEDGE_FILE_LIMIT = 2 * 1024 * 1024;
export const LOCAL_KNOWLEDGE_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "json", "log"]);
const invalid = (message: string) => new LocalKnowledgeError(422, "local_knowledge_invalid", message);
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw invalid("字段为空或超出长度限制");
  return value.trim();
}
export class LocalKnowledgeService {
  private readonly repository: LocalKnowledgeRepository;
  constructor(private readonly store: AgentSqliteStore) { this.repository = new LocalKnowledgeRepository(store.db); }
  owner(caller: AuthenticatedCaller): KnowledgeOwner {
    const memberId = caller.userId ?? caller.callerId;
    if (!caller.tenantId || !memberId) throw new LocalKnowledgeError(401, "unauthenticated", "请先登录本机 Agent");
    return { tenantId: caller.tenantId, memberId };
  }
  list(caller: AuthenticatedCaller) {
    const owner = this.owner(caller);
    return this.repository.list(owner).map(base => ({ ...base,
      documents: this.repository.documents(owner, base.id),
      employee_ids: this.repository.bindings(owner, base.id),
    }));
  }
  create(caller: AuthenticatedCaller, body: Record<string, unknown>) {
    const name = text(body.name, 120);
    const description = body.description === undefined ? "" : typeof body.description === "string" && body.description.length <= 2000 ? body.description : undefined;
    if (description === undefined) throw invalid("说明最长 2000 字符");
    return this.repository.create(this.owner(caller), name, description);
  }
  import(caller: AuthenticatedCaller, id: string, body: Record<string, unknown>) {
    const owner = this.owner(caller);
    this.repository.base(owner, id);
    const name = text(body.name, 240);
    if (/[\\/\x00-\x1f]/.test(name) || name.startsWith(".")) throw invalid("只接受文件名，不能传入本机路径");
    if (!LOCAL_KNOWLEDGE_EXTENSIONS.has(name.split(".").at(-1)?.toLowerCase() ?? "")) throw new LocalKnowledgeError(415, "local_knowledge_format", "本机索引目前支持 UTF-8 TXT、Markdown、CSV、JSON、LOG；PDF/Office/图片暂不支持");
    const base64 = body.data_base64;
    if (typeof base64 !== "string" || !base64 || base64.length > Math.ceil(LOCAL_KNOWLEDGE_FILE_LIMIT / 3) * 4) throw new LocalKnowledgeError(413, "local_knowledge_size", "本机文档须非空且不超过 2 MiB");
    const bytes = Buffer.from(base64, "base64");
    if (bytes.toString("base64") !== base64) throw invalid("文件编码无效");
    if (!bytes.length || bytes.length > LOCAL_KNOWLEDGE_FILE_LIMIT) throw new LocalKnowledgeError(413, "local_knowledge_size", "本机文档须非空且不超过 2 MiB");
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw invalid("请将文档保存为 UTF-8 文本后重试"); }
    if (!content.trim() || content.includes("\0")) throw invalid("文档为空或包含二进制内容");
    return this.repository.import(owner, id, name, content, bytes.length);
  }
  employeeAllowed(caller: AuthenticatedCaller, employeeId: string, operation: "search" | "get" = "search"): boolean {
    const owner = this.owner(caller);
    const expert = this.store.listLoadedExperts(owner.tenantId, owner.memberId).find(row => row.employee_id === employeeId);
    const snapshot = this.store.listSnapshots(owner.tenantId, owner.memberId).find(row => row.employee_id === employeeId);
    if (!expert || expert.revoked || (expert.status && expert.status !== "active") || !snapshot || snapshot.version !== expert.version) return false;
    const toolPolicy = snapshot.tool_policy;
    const allowed = toolPolicy && typeof toolPolicy === "object" ? (toolPolicy as Record<string, unknown>).allowed_tools : undefined;
    const legacyTool = operation === "search" ? "knowledge_search" : "knowledge_get";
    const localTool = `local_${legacyTool}`;
    if (Array.isArray(allowed) && allowed.length && !allowed.includes(localTool) && !allowed.includes(legacyTool)) return false;
    const policy = snapshot.knowledge_policy;
    if (policy !== undefined && policy !== null) {
      if (typeof policy !== "object" || Array.isArray(policy)) return false;
      const value = policy as Record<string, unknown>;
      if (!["allow", "inherit"].includes(String(value.state)) || !Array.isArray(value.allowed_operations) || !value.allowed_operations.includes(legacyTool)) return false;
    }
    return true;
  }
  bind(caller: AuthenticatedCaller, id: string, employeeId: string, enabled: boolean) {
    const owner = this.owner(caller);
    this.repository.base(owner, id);
    if (enabled && !this.employeeAllowed(caller, employeeId)) throw new LocalKnowledgeError(403, "local_knowledge_employee_denied", "员工未获本机授权、快照不可用或知识检索策略不允许");
    this.repository.bind(owner, id, employeeId, enabled);
  }
  search(caller: AuthenticatedCaller, query: unknown, baseId?: string, employeeId?: string) {
    const q = text(query, 200);
    if (employeeId && !this.employeeAllowed(caller, employeeId)) throw new LocalKnowledgeError(403, "local_knowledge_employee_denied", "员工知识检索权限不可用");
    return this.repository.search(this.owner(caller), q, employeeId, baseId);
  }
  read(caller: AuthenticatedCaller, documentId: string, offset: number, employeeId?: string) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw invalid("读取偏移无效");
    if (employeeId && !this.employeeAllowed(caller, employeeId, "get")) throw new LocalKnowledgeError(403, "local_knowledge_employee_denied", "员工知识读取权限不可用");
    return this.repository.read(this.owner(caller), documentId, offset, employeeId);
  }
  remove(caller: AuthenticatedCaller, id: string, documentId?: string) { this.repository.remove(this.owner(caller), id, documentId); }
}
