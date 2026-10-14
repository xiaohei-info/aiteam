import { createConnection } from "node:net";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { LocalDirectoryError, type DirectoryOwner, type DirectoryResource } from "./storage/local-directories.js";

// Imported by the packaged launcher BEFORE env-file loading/scrubbing. Kept only
// in this module's closure, never forwarded to model tools or child environments.
const socketPath = process.env.AITEAM_LOCAL_HOST_SOCKET;
const hostToken = process.env.AITEAM_LOCAL_HOST_TOKEN;
delete process.env.AITEAM_LOCAL_HOST_SOCKET;
delete process.env.AITEAM_LOCAL_HOST_TOKEN;

export interface HostDirectory { canonical_path: string; display_name: string; root_identity: string }
export interface DirectoryHost {
  status(): Promise<void>;
  challenge(owner: DirectoryOwner): Promise<string>;
  consume(owner: DirectoryOwner, ticket: string): Promise<HostDirectory>;
  check(resource: DirectoryResource): Promise<string>;
  list(resource: DirectoryResource, relative: string): Promise<{ authority: string; entries: { name: string; directory: boolean }[]; partial: boolean }>;
  read(resource: DirectoryResource, relative: string): Promise<{ authority: string; text: string; content_version: string }>;
}
const stringField = (value: Record<string, unknown>, field: string) => {
  if (typeof value[field] !== "string") throw new LocalDirectoryError("authorization_unavailable");
  return value[field];
};

export class NativeDirectoryHost implements DirectoryHost {
  constructor(private readonly socket = socketPath, private readonly token = hostToken) {}

  async status(): Promise<void> {
    const data = await this.request("status");
    if (data.platform !== "darwin" || typeof data.epoch !== "string") throw new LocalDirectoryError("authorization_unavailable");
  }
  async challenge(owner: DirectoryOwner): Promise<string> {
    return stringField(await this.request("challenge", { tenant_id: owner.tenantId, member_id: owner.memberId }), "challenge");
  }
  async consume(owner: DirectoryOwner, ticket: string): Promise<HostDirectory> {
    const data = await this.request("consume", { tenant_id: owner.tenantId, member_id: owner.memberId, ticket });
    return { canonical_path: stringField(data, "canonical_path"), display_name: stringField(data, "display_name"), root_identity: stringField(data, "root_identity") };
  }
  async check(resource: DirectoryResource): Promise<string> {
    return stringField(await this.request("check", this.location(resource)), "authority");
  }
  async list(resource: DirectoryResource, relative: string) {
    const data = await this.request("list", { ...this.location(resource), relative_path: relative });
    if (!Array.isArray(data.entries) || data.entries.length > 2048 || typeof data.partial !== "boolean") throw new LocalDirectoryError("authorization_unavailable");
    const entries = data.entries.map((item: unknown) => {
      if (!item || typeof item !== "object" || !("name" in item) || typeof item.name !== "string" || !("directory" in item) || typeof item.directory !== "boolean" || /[\0/\\]/u.test(item.name) || item.name === ".." || item.name === ".") throw new LocalDirectoryError("authorization_unavailable");
      return { name: item.name, directory: item.directory };
    });
    return { authority: stringField(data, "authority"), entries, partial: data.partial };
  }
  async read(resource: DirectoryResource, relative: string) {
    const data = await this.request("read", { ...this.location(resource), relative_path: relative });
    return { authority: stringField(data, "authority"), text: stringField(data, "text"), content_version: stringField(data, "content_version") };
  }
  private location(resource: DirectoryResource) { return { canonical_path: resource.canonical_path, root_identity: resource.root_identity }; }

  private async request(operation: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (process.platform !== "darwin" || !this.socket || !isAbsolute(this.socket) || !this.token) throw new LocalDirectoryError("authorization_unavailable");
    try {
      const [socket, parent] = await Promise.all([lstat(this.socket), lstat(dirname(this.socket))]);
      if (!socket.isSocket() || !parent.isDirectory() || (socket.mode & 0o077) || (parent.mode & 0o077) || socket.uid !== process.getuid?.() || parent.uid !== process.getuid?.()) throw new Error("unsafe_socket");
    } catch { throw new LocalDirectoryError("authorization_unavailable"); }
    return new Promise((resolve, reject) => {
      const connection = createConnection(this.socket!);
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const finish = (error?: Error, data?: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        connection.destroy();
        if (error) reject(error); else resolve(data!);
      };
      const deadline = setTimeout(() => finish(new LocalDirectoryError("authorization_unavailable")), 5_000);
      connection.once("connect", () => connection.write(`${JSON.stringify({ token: this.token, operation, ...fields })}\n`));
      connection.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024 * 1024) { finish(new LocalDirectoryError("budget_exhausted")); return; }
        chunks.push(chunk);
      });
      connection.once("error", () => finish(new LocalDirectoryError("authorization_unavailable")));
      connection.once("end", () => {
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!value || typeof value !== "object") throw new Error("invalid_response");
          if ("error" in value && typeof value.error === "string") {
            const allowed = new Set(["unauthorized", "authorization_unavailable", "citation_expired", "source_changed", "file_unavailable", "unsupported_format", "unsupported_file", "budget_exhausted", "parse_failed", "source_overlaps_runtime", "cancelled"]);
            finish(new LocalDirectoryError(allowed.has(value.error) ? value.error : "authorization_unavailable")); return;
          }
          if (!("data" in value) || !value.data || typeof value.data !== "object" || Array.isArray(value.data)) throw new Error("invalid_response");
          finish(undefined, value.data as Record<string, unknown>);
        } catch { finish(new LocalDirectoryError("authorization_unavailable")); }
      });
    });
  }
}
